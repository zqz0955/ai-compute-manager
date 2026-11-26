import { createHash, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { exact, requireH3 } from './wire.mjs';

export const PROBE_COMMAND = 'acm-h3-ready-v1';
export const PROBE_PORT = 38322;
export const MAX_PROBE_BYTES = 4096;
export const PROBE_TRANSPORT_MS = 5000;
const DOMAIN = 'ACM_H3_ZERO_GENERATION_V1';
const hex = /^[a-f\d]{64}$/u;
const keyHex = /^[a-f\d]{88}$/u;
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u;
const uint = value => Number.isSafeInteger(value) && value >= 0;
const matches = (value, re) => typeof value === 'string' && re.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
export const probePublicKey = value => {
  requireH3(matches(value, keyHex), 'H3_PROBE_KEY');
  const key = createPublicKey({ key: Buffer.from(value, 'hex'), format: 'der', type: 'spki' });
  requireH3(key.asymmetricKeyType === 'ed25519', 'H3_PROBE_KEY');
  return key;
};

export function probePlan(value) {
  requireH3(exact(value, ['version','scope','operation','deviceSha256','boot','sshHostSha256','nodeSha256',
    'controllerKey','probeKey','notBefore','expiresAt','uid','gid']) && value.version === 1 && value.scope === DOMAIN &&
    matches(value.operation, uuid) && matches(value.boot, uuid) &&
    ['deviceSha256','sshHostSha256','nodeSha256'].every(field => matches(value[field], hex)) &&
    uint(value.notBefore) && uint(value.expiresAt) && value.expiresAt > value.notBefore &&
    value.expiresAt - value.notBefore <= 30 * 60 * 1000 &&
    [value.uid,value.gid].every(id => uint(id) && id > 0 && id <= 65534) &&
    value.controllerKey !== value.probeKey, 'H3_PROBE_PLAN');
  probePublicKey(value.controllerKey);
  probePublicKey(value.probeKey);
  return value;
}

const binding = plan => hash(JSON.stringify([
  plan.version, plan.scope, plan.operation, plan.deviceSha256, plan.boot, plan.sshHostSha256, plan.nodeSha256,
  plan.controllerKey, plan.probeKey, plan.notBefore, plan.expiresAt, plan.uid, plan.gid,
]));
const windowOK = (plan, now) => uint(now) && now >= plan.notBefore && now < plan.expiresAt;
const signedBytes = (kind, value) => Buffer.from(JSON.stringify([DOMAIN,kind,value]));
function seal(kind, value, key, expected) {
  requireH3(key?.type === 'private' && createPublicKey(key).equals(probePublicKey(expected)), 'H3_PROBE_ROLE');
  return { value, signature: sign(null, signedBytes(kind, value), key).toString('hex') };
}
function open(kind, wire, key) {
  requireH3(exact(wire,['value','signature']) && matches(wire.signature,/^[a-f\d]{128}$/u) &&
    verify(null,signedBytes(kind,wire.value),probePublicKey(key),Buffer.from(wire.signature,'hex')), 'H3_PROBE_SIGNATURE');
  return wire.value;
}

function challengeValue(wire, plan) {
  const value = open('CHALLENGE', wire, plan.controllerKey);
  requireH3(exact(value,['operation','binding','nonce']) && value.operation === 'ready-only' &&
    value.binding === binding(plan) && matches(value.nonce,hex), 'H3_PROBE_REQUEST');
  return value;
}

export function requestProbe(plan, key, now) {
  probePlan(plan);
  requireH3(windowOK(plan, now), 'H3_PROBE_WINDOW');
  return seal('CHALLENGE', { operation:'ready-only', binding:binding(plan), nonce:randomBytes(32).toString('hex') },
    key, plan.controllerKey);
}

export function respondProbe({ plan, wire, key, claimOnce, clock = Date.now, monotonic = performance.now.bind(performance) }) {
  const receivedAt = clock(), start = monotonic();
  probePlan(plan);
  const value = challengeValue(wire, plan);
  requireH3(windowOK(plan,receivedAt), 'H3_PROBE_WINDOW');
  // 遠端先排他封存此操作資格。成功送出或中途斷線都不重用。
  claimOnce(plan.operation, value.nonce);
  const finishedAt = clock(), localElapsedMs = Math.ceil(monotonic() - start);
  requireH3(windowOK(plan, finishedAt) && finishedAt >= receivedAt && uint(localElapsedMs) && localElapsedMs <= 700,
    'H3_PROBE_LOCAL_DEADLINE');
  return seal('READY_ONLY', {
    binding:value.binding, nonce:value.nonce, deviceSha256:plan.deviceSha256, boot:plan.boot,
    sshHostSha256:plan.sshHostSha256, uid:plan.uid, gid:plan.gid, receivedAt, finishedAt, localElapsedMs,
    generationRequests:0,
  },key,plan.probeKey);
}

export function verifyProbe({ plan, request, response, sentAt, receivedAt, roundTripMs }) {
  probePlan(plan);
  const challenge = challengeValue(request, plan);
  const value = open('READY_ONLY', response, plan.probeKey);
  requireH3(exact(value,['binding','nonce','deviceSha256','boot','sshHostSha256','uid','gid','receivedAt','finishedAt',
    'localElapsedMs','generationRequests']) && value.nonce === challenge.nonce && value.binding === challenge.binding &&
    ['deviceSha256','boot','sshHostSha256','uid','gid'].every(field=>value[field]===plan[field]) &&
    windowOK(plan,sentAt) && windowOK(plan,receivedAt) && receivedAt >= sentAt &&
    windowOK(plan,value.receivedAt) && windowOK(plan,value.finishedAt) && value.finishedAt >= value.receivedAt &&
    uint(roundTripMs) && roundTripMs <= PROBE_TRANSPORT_MS && uint(value.localElapsedMs) &&
    value.localElapsedMs <= 700 && value.generationRequests === 0, 'H3_PROBE_RESPONSE');
  const offsetLowMs = value.finishedAt - receivedAt;
  const offsetHighMs = value.receivedAt - sentAt;
  const localWallMs = receivedAt - sentAt;
  requireH3(offsetLowMs <= offsetHighMs && Math.abs(roundTripMs-localWallMs) <= 20 &&
    Math.abs(value.finishedAt-value.receivedAt-value.localElapsedMs) <= 20, 'H3_PROBE_CLOCK_STEP');
  return { status:'PASS_AUTHENTICATED_ZERO_GENERATION', generationRequests:0, offsetLowMs, offsetHighMs, roundTripMs,
    remoteLocalMs:value.localElapsedMs, compatibleWith700msAtProbe:roundTripMs<=700 && offsetLowMs<=0 && offsetHighMs>=0 };
}

export async function readProbeFrame(stream) {
  let raw = Buffer.alloc(0);
  for await (const chunk of stream) {
    requireH3(raw.length+chunk.length <= MAX_PROBE_BYTES, 'H3_PROBE_FRAME_SIZE');
    raw = Buffer.concat([raw,chunk]);
  }
  const text = new TextDecoder('utf8',{fatal:true}).decode(raw);
  requireH3(text.endsWith('\n') && text.indexOf('\n') === text.length-1, 'H3_PROBE_SINGLE_FRAME');
  const value = JSON.parse(text);
  requireH3(JSON.stringify(value)+'\n' === text, 'H3_PROBE_FRAME_CANONICAL');
  return value;
}
