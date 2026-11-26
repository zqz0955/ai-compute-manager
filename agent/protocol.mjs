import { createPublicKey, sign, verify } from 'node:crypto';

export const agentMaxAgeMs = 30_000;
export const agentModelLimit = 128;
const maxClockSkewMs = 1_000;
const domain = Buffer.from('ACM_READ_ONLY_AGENT_SNAPSHOT_V1\0');
export const agentNodeId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const modelName = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u;
const digest = /^[a-f0-9]{64}$/u;
const numberOfBytes = Number.isSafeInteger;
const metricBounds = Object.freeze({
  cpuPercent: [0, 100],
  ramUsedBytes: [0, Number.MAX_SAFE_INTEGER],
  ramBytes: [1, Number.MAX_SAFE_INTEGER],
  swapUsedBytes: [0, Number.MAX_SAFE_INTEGER],
  swapBytes: [0, Number.MAX_SAFE_INTEGER],
  diskUsedBytes: [0, Number.MAX_SAFE_INTEGER],
  diskBytes: [1, Number.MAX_SAFE_INTEGER],
  gpuPercent: [0, 100],
  gpuUsedBytes: [0, Number.MAX_SAFE_INTEGER],
  temperatureC: [-50, 200],
});

function check(valid) {
  if (!valid) throw new Error('AGENT_SNAPSHOT_INVALID');
}

export function hasFields(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function canonicalBytes(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length !== Math.ceil(length * 4 / 3)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === length && bytes.toString('base64url') === value ? bytes : null;
}

export function readAgentPublicKey(value) {
  const der = canonicalBytes(value, 44);
  check(der !== null);
  try {
    const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
    check(key.asymmetricKeyType === 'ed25519' && key.export({ type: 'spki', format: 'der' }).equals(der));
    return key;
  } catch {
    throw new Error('AGENT_SNAPSHOT_INVALID');
  }
}

function modelRows(list) {
  if (list === null) return null;
  check(Array.isArray(list) && list.length <= agentModelLimit);
  const names = new Set();
  const rows = [];
  for (const model of list) {
    check(hasFields(model, ['name', 'digest', 'sizeBytes']));
    const { name, digest: hash, sizeBytes } = model;
    check(typeof name === 'string' && modelName.test(name) && !names.has(name)
      && typeof hash === 'string' && digest.test(hash) && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0);
    names.add(name);
    rows.push(Object.freeze({ name, digest: hash, sizeBytes }));
  }
  return Object.freeze(rows);
}

function canonicalSample(payload) {
  check(hasFields(payload, ['version', 'nodeId', 'sequence', 'challenge', 'sampledAt', 'metrics', 'models', 'resident']));
  const { version, nodeId, sequence, challenge, sampledAt, metrics, models, resident } = payload;
  check(version === 1 && typeof nodeId === 'string' && agentNodeId.test(nodeId) && Number.isSafeInteger(sequence)
    && sequence > 0 && canonicalBytes(challenge, 32) !== null && Number.isSafeInteger(sampledAt) && sampledAt > 0);
  check(hasFields(metrics, Object.keys(metricBounds)));
  const values = {};
  for (const [key, [min, max]] of Object.entries(metricBounds)) {
    const value = metrics[key];
    check(value === null || (Number.isFinite(value) && min <= value && value <= max
      && (!key.endsWith('Bytes') || numberOfBytes(value))));
    values[key] = value;
  }
  for (const key of ['ram', 'swap', 'disk']) {
    const used = values[key + 'UsedBytes'];
    const total = values[key + 'Bytes'];
    check(used === null || total === null || used <= total);
  }
  return Object.freeze({
    version, nodeId, sequence, challenge, sampledAt, metrics: Object.freeze(values),
    models: modelRows(models), resident: modelRows(resident),
  });
}

const signedBytes = payload => Buffer.concat([domain, Buffer.from(JSON.stringify(payload), 'utf8')]);

export function signAgentSnapshot(payload, privateKey) {
  check(privateKey?.type === 'private' && privateKey.asymmetricKeyType === 'ed25519');
  const record = canonicalSample(payload);
  return Object.freeze({ payload: record, signature: sign(null, signedBytes(record), privateKey).toString('base64url') });
}

export function verifyAgentSnapshot(envelope, { nodeId, publicKey, challenge, lastSequence = 0,
  now = Date.now(), maxAgeMs = agentMaxAgeMs } = {}) {
  check(hasFields(envelope, ['payload', 'signature']));
  const record = canonicalSample(envelope.payload);
  const signature = canonicalBytes(envelope.signature, 64);
  check(signature !== null && record.nodeId === nodeId && record.challenge === challenge
    && Number.isSafeInteger(lastSequence) && lastSequence >= 0 && record.sequence > lastSequence
    && Number.isSafeInteger(now) && Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= agentMaxAgeMs
    && record.sampledAt >= now - maxAgeMs && record.sampledAt <= now + maxClockSkewMs);
  check(verify(null, signedBytes(record), readAgentPublicKey(publicKey), signature));
  return record;
}
