import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const freshEvidenceBudgetMs = 700;
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const words = text => text.match(/[\p{Letter}\p{Number}]+|[^\s]/gu) ?? [];
export const tokenCount = text => words(text).length;
const domain = 'ACM_V1_SIMULATION_WORKER';
const terminalStates = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
const failureCodes = new Set(['OUT_OF_MEMORY', 'TIMEOUT', 'CONTROLLER_STOPPED', 'SIMULATION_FAILURE']);
const bytes = (type, record) => Buffer.from(JSON.stringify([domain, type, record]));
const fail = code => Object.assign(new Error(code), { code });
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function signed(type, record, key) {
  return { record, signature: sign(null, bytes(type, record), key).toString('hex') };
}

function authentic(type, wire, key) {
  return wire?.record && typeof wire.signature === 'string' && /^[a-f0-9]{128}$/.test(wire.signature) &&
    verify(null, bytes(type, wire.record), key, Buffer.from(wire.signature, 'hex'));
}

function loadedIdentity(row) {
  if (!row) throw fail('WORKER_IDENTITY_MISSING');
  const privateKey = createPrivateKey({ key: Buffer.from(row.private_key, 'hex'), type: 'pkcs8', format: 'der' });
  const publicKey = createPublicKey({ key: Buffer.from(row.public_key, 'hex'), type: 'spki', format: 'der' });
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519' ||
      !createPublicKey(privateKey).equals(publicKey)) throw fail('WORKER_IDENTITY_INVALID');
  return { epoch: row.epoch, privateKey, publicKey };
}

export function resultFor(job) {
  return { outcome: job.state, output: job.output ?? null, usage: job.usage ?? null,
    ...(Object.hasOwn(job, 'finishReason') ? { finishReason: job.finishReason } : {}), code: job.error?.code ?? null };
}

export function createSimulationWorker({ db, transaction, options = {} }) {
  const active = new Map();
  const getIdentity = db.prepare('SELECT * FROM worker_identity WHERE resource=?');
  const addIdentity = db.prepare('INSERT INTO worker_identity(resource,epoch,private_key,public_key) VALUES (?,?,?,?)');
  const getEvents = db.prepare('SELECT document,signature FROM worker_events WHERE attempt_id=? ORDER BY seq');
  const addEvent = db.prepare('INSERT INTO worker_events(attempt_id,state,document,signature) VALUES (?,?,?,?)');

  function identityFor(resource) {
    const existing = getIdentity.get(resource);
    if (existing) return loadedIdentity(existing);
    if (!db.isTransaction) throw fail('WORKER_IDENTITY_MISSING');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const epoch = randomUUID();
    addIdentity.run(resource, epoch, privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
      publicKey.export({ type: 'spki', format: 'der' }).toString('hex'));
    return { epoch, privateKey, publicKey };
  }

  function append(identity, binding, state, engine, previous, result = null) {
    const record = {
      epoch: identity.epoch, binding, state, engine, previous, at: Date.now(),
      outcome: result?.outcome ?? null, resultHash: result ? hash(result) : null,
    };
    const wire = signed('EVENT', record, identity.privateKey);
    addEvent.run(binding.attemptId, state, JSON.stringify(record), wire.signature);
    return wire;
  }

  function readLedger(binding, identity) {
    const entries = getEvents.all(binding.attemptId).map(row => ({ record: JSON.parse(row.document), signature: row.signature }));
    const expected = ['ACCEPTED', 'RUNNING', 'TERMINAL'];
    if (entries.length !== expected.length || entries.some((entry, index) => {
      const { state, epoch, engine, previous, at } = entry.record;
      return !authentic('EVENT', entry, identity.publicKey) || epoch !== identity.epoch ||
        hash(entry.record.binding) !== hash(binding) || state !== expected[index] || at < binding.intentAt ||
        (index === 0 ? engine !== null || previous !== null
          : previous !== hash(entries[index - 1]) || at < entries[index - 1].record.at ||
            typeof engine !== 'string' || (index === 2 && engine !== entries[1].record.engine));
    })) return null;
    return entries[2];
  }

  async function execute({ binding, node, input, maxTokens, signal, publish }) {
    let identity, last;
    const engine = randomUUID();
    const { resource, attemptId } = binding;
    if (active.has(resource)) throw fail('WORKER_RESOURCE_HELD');
    active.set(resource, { attemptId, model: binding.model });
    // 先持久化 ACCEPTED/RUNNING；若之後失聯，控制器保留資源而不重送。
    transaction(() => {
      identity = identityFor(resource);
      if (getEvents.get(attemptId)) throw fail('WORKER_ATTEMPT_REPLAY');
      last = append(identity, binding, 'ACCEPTED', null, null);
    });
    transaction(() => { last = append(identity, binding, 'RUNNING', engine, hash(last)); });
    const generated = words(`模擬回應 ${input}`);
    const outputTokens = generated.slice(0, maxTokens);
    let code = null;
    try {
      signal.throwIfAborted();
      const fault = await options.beforeRun?.({ binding, node: structuredClone(node), signal });
      if (fault === 'WORKER_DISCONNECTED') throw fail(fault);
      if (fault !== undefined && !failureCodes.has(fault)) throw fail('SIMULATION_FAILURE');
      code = fault ?? null;
      const duration = options.delayMs ?? 80;
      if (code || !publish || !outputTokens.length) {
        await delay(duration, undefined, { signal });
      } else {
        const step = Math.ceil(outputTokens.length / 8);
        for (let offset = 0; offset < outputTokens.length; offset += step) {
          const end = Math.min(offset + step, outputTokens.length);
          const elapsed = index => Math.floor(duration * index / outputTokens.length);
          await delay(elapsed(end) - elapsed(offset), undefined, { signal });
          publish((offset ? ' ' : '') + outputTokens.slice(offset, end).join(' '));
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error;
      code = signal.reason.code;
    }
    const output = code ? null : outputTokens.join(' ');
    const prompt = tokenCount(input), completion = output ? tokenCount(output) : 0;
    const result = {
      outcome: code === 'CANCELLED' ? 'CANCELLED' : code ? 'FAILED' : 'SUCCEEDED', output,
      usage: code ? null : { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
      ...(code ? {} : { finishReason: generated.length > maxTokens ? 'length' : 'stop' }),
      code,
    };
    transaction(() => append(identity, binding, 'TERMINAL', engine, hash(last), result));
    active.delete(resource);
    return result;
  }

  async function queryEvidence(binding, nonce, signal) {
    signal.throwIfAborted();
    const identity = identityFor(binding.resource);
    const terminal = readLedger(binding, identity);
    if (!terminal || active.has(binding.resource)) return null;
    const observations = await options.sample?.(binding, signal) ?? {};
    signal.throwIfAborted();
    if (active.has(binding.resource)) return null;
    const sample = signed('SAMPLE', {
      binding, nonce, epoch: identity.epoch, engine: terminal.record.engine, terminalHash: hash(terminal),
      observedAt: Date.now(), healthy: observations.healthy ?? true, active: observations.active ?? 0,
      resident: observations.resident ?? 0, gpuActive: observations.gpuActive ?? 0,
      gpuResidentBytes: observations.gpuResidentBytes ?? 0,
    }, identity.privateKey);
    const evidence = { terminal, sample };
    return options.exchange ? options.exchange(structuredClone(evidence), signal) : evidence;
  }

  function verifies(binding, result, evidence, nonce, at) {
    try {
      if (!isHash(nonce) || !terminalStates.includes(result.outcome)) return false;
      const identity = identityFor(binding.resource);
      const terminal = readLedger(binding, identity);
      if (!terminal || hash(terminal) !== hash(evidence.terminal) || terminal.record.outcome !== result.outcome ||
          terminal.record.resultHash !== hash(result) || !authentic('SAMPLE', evidence.sample, identity.publicKey)) return false;
      const sample = evidence.sample.record;
      return sample.nonce === nonce && sample.epoch === identity.epoch && sample.engine === terminal.record.engine &&
        sample.terminalHash === hash(terminal) && hash(sample.binding) === hash(binding) &&
        Number.isSafeInteger(at) && Number.isSafeInteger(sample.observedAt) && sample.observedAt >= terminal.record.at &&
        sample.observedAt <= at && at - sample.observedAt <= freshEvidenceBudgetMs &&
        sample.healthy === true && sample.active === 0 && sample.resident === 0 &&
        sample.gpuActive === 0 && sample.gpuResidentBytes === 0;
    } catch { return false; }
  }

  return {
    execute, queryEvidence, verifies,
    challenge: () => randomBytes(32).toString('hex'),
    resident: resource => active.get(resource)?.model,
  };
}
