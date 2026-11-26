import { createHash, randomBytes, verify } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { freshEvidenceBudgetMs, hash } from './simulation.mjs';
import {LEGACY_MODE} from './r1/legacy-memory.mjs';

const scope = 'ACM_V1_ISOLATED_ENGINE_ONCE_V1';
const workers = new WeakSet();
const hex = (value, size = 64) => typeof value === 'string' && value.length === size && /^[a-f0-9]+$/.test(value);
const id = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const key = value => value?.type === 'public' && value.asymmetricKeyType === 'ed25519';
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const same = isDeepStrictEqual;
const reject = () => Object.assign(Error('已隔離工作來源未通過資格核對。'), { code: 'WORKER_NOT_QUALIFIED', status: 503 });
const require = passes => { if (!passes) throw reject(); };

export const qualificationMessage = (kind, value) => Buffer.from(JSON.stringify([scope, kind, value]));
export const workerKeyPin = publicKey => createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
export const isQualifiedWorker = worker => workers.has(worker);

function signed(kind, wire, publicKey) {
  require(exact(wire, ['value', 'signature']) && hex(wire.signature, 128));
  const bytes = qualificationMessage(kind, wire.value);
  require(bytes.length <= 131072 && verify(null, bytes, publicKey, Buffer.from(wire.signature, 'hex')));
  return wire.value;
}

function approval(wire, publicKey, workerPublicKey, expectedMemoryMode) {
  const value = signed('ADMISSION', wire, publicKey);
  const legacy=expectedMemoryMode===LEGACY_MODE;
  require(expectedMemoryMode===undefined||legacy);
  require(exact(value, ['id', 'scope', 'source', 'store', 'node', 'model', 'epoch', 'workerKey',
    'transport', 'runtime', 'evidence', 'notBefore', 'expiresAt',...(legacy?['memoryMode']:[])]) && value.scope === scope &&
    (!legacy||(value.memoryMode===LEGACY_MODE&&value.source==='ISOLATED_REAL_ENGINE'))&&
    ['QUALIFICATION_FIXTURE', 'ISOLATED_REAL_ENGINE'].includes(value.source) &&
    uuid(value.id) && uuid(value.epoch) && hex(value.store) && hex(value.transport) &&
    hex(value.runtime) && hex(value.evidence) && value.workerKey === workerKeyPin(workerPublicKey) &&
    count(value.notBefore) && count(value.expiresAt) && value.expiresAt > value.notBefore &&
    value.expiresAt - value.notBefore <= 30 * 60000);
  const { node, model } = value;
  require(exact(node, ['id', 'resource', 'aliases', 'platform']) && id(node.id) && hex(node.resource) &&
    id(node.platform) && Array.isArray(node.aliases) && node.aliases.length <= 16 &&
    node.aliases.every(id) && new Set(node.aliases).size === node.aliases.length);
  require(exact(model, ['id', 'digest', 'device', 'context', 'maxTokens']) &&
    typeof model.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model.id) &&
    hex(model.digest) && model.device === 'cpu' && count(model.context) && model.context <= 32768 &&
    count(model.maxTokens) && model.maxTokens > 0 && model.maxTokens <= 256 && model.maxTokens <= model.context);
  require(!legacy||(model.context===512&&model.maxTokens===16));
  const copy = structuredClone(value);
  Object.freeze(copy.node.aliases);
  Object.freeze(copy.node);
  Object.freeze(copy.model);
  return Object.freeze(copy);
}

function outputValid(result, model, maxTokens) {
  const successful = result?.outcome === 'SUCCEEDED';
  if (!exact(result, ['outcome', 'output', 'usage', 'code', ...(successful ? ['finishReason'] : [])])) return false;
  if (!successful) return ['FAILED', 'CANCELLED'].includes(result.outcome) && result.output === null &&
    result.usage === null && /^[A-Z0-9_]{1,64}$/.test(result.code ?? '');
  const usage = result.usage;
  return typeof result.output === 'string' && result.output.isWellFormed() &&
    Buffer.byteLength(result.output) <= 65536 && ['stop', 'length'].includes(result.finishReason) &&
    result.code === null && exact(usage, ['prompt_tokens', 'completion_tokens', 'total_tokens']) &&
    Object.values(usage).every(count) && usage.completion_tokens <= maxTokens && usage.completion_tokens > 0 &&
    usage.total_tokens === usage.prompt_tokens + usage.completion_tokens && usage.total_tokens <= model.context;
}

// 只供研究隔離啟動器交付已釘選通道，路由和產品設定不會建立這個執行能力。
export function createQualifiedWorker({ admission, authorityPublicKey, workerPublicKey, exchange, expectedMemoryMode,
  restorationAuthorityPublicKey = authorityPublicKey }) {
  require(key(authorityPublicKey) && key(workerPublicKey) && key(restorationAuthorityPublicKey) &&
    !authorityPublicKey.equals(workerPublicKey) && !restorationAuthorityPublicKey.equals(workerPublicKey) &&
    typeof exchange === 'function');
  // 新記憶體契約須由可信啟動端明確選用，舊精確模式不能自動接受 null 峰值資格。
  const claim = approval(admission, authorityPublicKey, workerPublicKey, expectedMemoryMode);
  const pin = hash(claim), challenge = () => randomBytes(32).toString('hex');
  let terminal, active = false, launched = false;
  const readyForLaunch = (now = Date.now()) => !launched && now >= claim.notBefore && now < claim.expiresAt;
  const pinned = value => value?.pin === pin && value.epoch === claim.epoch;
  function validBinding(binding) {
    return binding?.workerPin === pin && binding.admissionId === claim.id && binding.resource === claim.node.resource &&
      binding.nodeId === claim.node.id && binding.model === claim.model.id && binding.digest === claim.model.digest &&
      uuid(binding.jobId) && uuid(binding.attemptId) && count(binding.intentAt) && binding.intentAt >= claim.notBefore &&
      binding.intentAt < claim.expiresAt && count(binding.maxTokens) && binding.maxTokens > 0 &&
      binding.maxTokens <= claim.model.maxTokens && hex(binding.inputHash);
  }
  function terminalValue(binding, wire, now) {
    const value = signed('TERMINAL', wire, workerPublicKey);
    require(exact(value, ['pin', 'epoch', 'binding', 'at', 'result', 'engine']) && pinned(value) &&
      uuid(value.engine) && same(value.binding, binding) && count(value.at) && value.at >= binding.intentAt &&
      value.at <= now && value.at < claim.expiresAt && outputValid(value.result, claim.model, binding.maxTokens));
    return value;
  }
  async function execute({ binding, kind, input, maxTokens, signal, publish }) {
    require(validBinding(binding) && readyForLaunch() && maxTokens === binding.maxTokens &&
      hash([kind, input, maxTokens]) === binding.inputHash);
    launched = true;
    signal.throwIfAborted();
    const live = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, claim.expiresAt - Date.now()))]);
    const nonce = challenge();
    const sentAt = Date.now();
    const health = signed('READY', await exchange({ operation: 'ready', pin, nonce }, { signal: live }), workerPublicKey);
    const now = Date.now();
    require(exact(health, ['pin', 'epoch', 'nonce', 'at', 'healthy', 'active', 'resident']) &&
      pinned(health) && health.nonce === nonce && count(health.at) && health.at >= sentAt &&
      health.at <= now && now - health.at <= freshEvidenceBudgetMs && health.healthy === true &&
      health.active === 0 && health.resident === 0 && now < claim.expiresAt);
    live.throwIfAborted();
    active = true;
    let sequence = 0, preview = '', accepting = true;
    try {
      const wire = await exchange({ operation: 'execute', pin, binding, kind, input, maxTokens }, {
        signal: live,
        onDelta(frame) {
          live.throwIfAborted();
          const delta = signed('DELTA', frame, workerPublicKey);
          require(accepting && exact(delta, ['pin', 'epoch', 'binding', 'sequence', 'content']) &&
            pinned(delta) && same(delta.binding, binding) && delta.sequence === sequence + 1 &&
            typeof delta.content === 'string' && delta.content.length > 0 && delta.content.isWellFormed() &&
            Buffer.byteLength(preview) + Buffer.byteLength(delta.content) <= 65536);
          sequence++;
          preview += delta.content;
          publish?.(delta.content);
        },
      });
      live.throwIfAborted();
      const { result } = terminalValue(binding, wire, Date.now());
      require(result.outcome !== 'SUCCEEDED' || result.output.startsWith(preview));
      terminal = structuredClone(wire);
      return structuredClone(result);
    } finally {
      accepting = false;
      active = false;
    }
  }
  async function queryEvidence(binding, nonce, signal) {
    require(validBinding(binding) && terminal && !active && hex(nonce));
    const sample = await exchange({ operation: 'sample', pin, binding, nonce, terminalSha256: hash(terminal) }, { signal });
    return { terminal: structuredClone(terminal), sample: structuredClone(sample) };
  }
  function restored(binding, sample, at) {
    const proof=signed('RESTORED',sample.restore,restorationAuthorityPublicKey);
    return exact(proof,['pin','epoch','binding','engine','verifiedAt','committedAt','r1JobId','r1AttemptId',
      'r1ReleaseSha256','topologySha256','evidenceSha256','terminalSha256','nonce']) &&
      pinned(proof) && same(proof.binding,binding) && proof.terminalSha256===sample.terminalSha256 && proof.nonce===sample.nonce &&
      proof.engine===sample.engine && uuid(proof.r1JobId) && uuid(proof.r1AttemptId) &&
      hex(proof.r1ReleaseSha256) && hex(proof.topologySha256) && hex(proof.evidenceSha256) &&
      count(proof.verifiedAt) && count(proof.committedAt) && proof.verifiedAt>=binding.intentAt &&
      proof.committedAt>=proof.verifiedAt && proof.committedAt<=sample.at && at-proof.committedAt<=freshEvidenceBudgetMs;
  }
  function verifies(binding, result, evidence, nonce, at) {
    try {
      if (!validBinding(binding) || !hex(nonce) || !count(at)) return false;
      const final = terminalValue(binding, evidence.terminal, at);
      const sample = signed('CLEARED', evidence.sample, workerPublicKey);
      const restoreFields=claim.source==='ISOLATED_REAL_ENGINE'?['restore']:[];
      return same(final.result, result) &&
        exact(sample, ['pin', 'epoch', 'binding', 'nonce', 'at', 'terminalSha256', 'engine', 'healthy', 'active', 'resident', 'gpuResidentBytes', 'reclaimed', ...restoreFields]) &&
        pinned(sample) && same(sample.binding, binding) && sample.nonce === nonce &&
        sample.terminalSha256 === hash(evidence.terminal) && sample.engine === final.engine &&
        count(sample.at) && sample.at >= final.at && sample.at <= at && at - sample.at <= freshEvidenceBudgetMs &&
        sample.healthy === true && sample.active === 0 && sample.resident === 0 &&
        sample.gpuResidentBytes === 0 && sample.reclaimed === true &&
        (!restoreFields.length || restored(binding,sample,at));
    } catch { return false; }
  }
  const worker = Object.freeze({ claim, pin, challenge, readyForLaunch, execute, queryEvidence, verifies,
    resident: resource => active && resource === claim.node.resource ? claim.model.id : null });
  workers.add(worker);
  return worker;
}
