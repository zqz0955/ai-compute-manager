import { randomBytes, sign, verify } from 'node:crypto';
import { once } from 'node:events';
import { Buffer } from 'node:buffer';
import { isDeepStrictEqual as same } from 'node:util';

const DOMAIN = 'ACM_H3_SIGNED_STDIO_V1';
const MAX_FRAME = 196608;
const HEX = /^[a-f0-9]{64}$/u;
const SIGNATURE = /^[a-f0-9]{128}$/u;
const KEYS = ['pin', 'sequence', 'nonce', 'type', 'payload'];
const bytes = frame => Buffer.from(JSON.stringify([DOMAIN, frame]));
export const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const requireH3 = (ok, code) => {
  if (!ok) throw Object.assign(Error(code), { code });
};
export const nonce = () => randomBytes(32).toString('hex');

export function sealH3Frame(frame, privateKey) {
  requireH3(privateKey?.type === 'private' && privateKey.asymmetricKeyType === 'ed25519', 'H3_CHANNEL_KEY');
  return { frame, signature: sign(null, bytes(frame), privateKey).toString('hex') };
}

export function openH3Frame(value, key) {
  requireH3(exact(value, ['frame', 'signature']) && SIGNATURE.test(value.signature) &&
    exact(value.frame, KEYS) && HEX.test(value.frame.pin) && HEX.test(value.frame.nonce) &&
    Number.isSafeInteger(value.frame.sequence) && value.frame.sequence > 0 && value.frame.sequence <= 3 &&
    ['request', 'delta', 'result'].includes(value.frame.type) &&
    key?.type === 'public' && key.asymmetricKeyType === 'ed25519' &&
    verify(null, bytes(value.frame), key, Buffer.from(value.signature, 'hex')), 'H3_CHANNEL_SIGNATURE');
  return value.frame;
}

export async function* h3Frames(stream) {
  let pending = Buffer.alloc(0);
  const decode = new TextDecoder('utf8', { fatal: true });
  for await (const chunk of stream) {
    for (let cursor = 0; cursor < chunk.length;) {
      const newline = chunk.indexOf(10, cursor);
      const until = newline < 0 ? chunk.length : newline;
      requireH3(pending.length + until - cursor <= MAX_FRAME, 'H3_FRAME_SIZE');
      pending = Buffer.concat([pending, chunk.subarray(cursor, until)]);
      if (newline >= 0) {
        const raw = decode.decode(pending);
        const parsed = JSON.parse(raw);
        requireH3(JSON.stringify(parsed) === raw, 'H3_FRAME_CANONICAL');
        pending = Buffer.alloc(0);
        yield parsed;
      }
      cursor = newline < 0 ? until : until + 1;
    }
  }
  requireH3(pending.length === 0, 'H3_FRAME_TRUNCATED');
}

export async function writeH3Frame(stream, value, signal) {
  signal.throwIfAborted();
  const raw = JSON.stringify(value);
  requireH3(Buffer.byteLength(raw) <= MAX_FRAME, 'H3_FRAME_SIZE');
  if (!stream.write(raw + '\n')) await once(stream, 'drain', { signal });
}

const operations = ['ready', 'execute', 'sample'];

// 一個通道只容許 READY → EXECUTE → SAMPLE，各次序不得重播或重新連線。
export function createH3Exchange({ input, output, pin, controllerPrivateKey, workerPublicKey, shutdown }) {
  const stream = h3Frames(input);
  let sequence = 0, active = false, closed = false;
  function close() {
    if (closed) return;
    closed = true;
    shutdown();
  }
  return {
    close,
    async exchange(request, { signal, onDelta } = {}) {
      requireH3(!active && !closed && request.operation === operations[sequence] && request.pin === pin, 'H3_EXCHANGE_ORDER');
      active = true;
      const current = ++sequence;
      const challenge = nonce();
      const timeout = AbortSignal.timeout(current === 2 ? 115000 : 5000);
      const boundary = signal ? AbortSignal.any([signal, timeout]) : timeout;
      boundary.addEventListener('abort', close, { once: true });
      try {
        boundary.throwIfAborted();
        await writeH3Frame(output, sealH3Frame({ pin, sequence: current, nonce: challenge, type: 'request', payload: request },
          controllerPrivateKey), boundary);
        let deltas = 0;
        while (true) {
          const next = await stream.next();
          boundary.throwIfAborted();
          requireH3(!next.done, 'H3_CHANNEL_LOST');
          const reply = openH3Frame(next.value, workerPublicKey);
          requireH3(reply.pin === pin && reply.sequence === current && reply.nonce === challenge, 'H3_CHANNEL_REPLAY');
          if (reply.type === 'result') return reply.payload;
          requireH3(reply.type === 'delta' && current === 2 && ++deltas <= 16 && typeof onDelta === 'function',
            'H3_DELTA_PROTOCOL');
          onDelta(reply.payload);
        }
      } catch (error) {
        close();
        throw error;
      } finally {
        boundary.removeEventListener('abort', close);
        active = false;
      }
    }
  };
}

export async function runH3Peer({ input, output, pin, controllerPublicKey, workerPrivateKey, workerPublicKey,
  dispatch, signal, observeRequest, sealReply }) {
  requireH3(sealReply===undefined || (typeof sealReply==='function'&&typeof observeRequest==='function'&&workerPublicKey),
    'H3_ROLE_TRANSPORT');
  let sequence = 0;
  for await (const value of h3Frames(input)) {
    signal.throwIfAborted();
    const frame = openH3Frame(value, controllerPublicKey);
    requireH3(frame.type === 'request' && frame.pin === pin && frame.sequence === sequence + 1 &&
      frame.payload?.pin === pin && frame.payload?.operation === operations[sequence], 'H3_CHANNEL_REPLAY');
    sequence++;
    await observeRequest?.(value);
    const reply = async (type, payload) => {
      const response={pin,sequence,nonce:frame.nonce,type,payload};
      const envelope=sealReply?await sealReply(response):sealH3Frame(response,workerPrivateKey);
      if(sealReply) requireH3(same(openH3Frame(envelope,workerPublicKey),response),'H3_ROLE_TRANSPORT');
      await writeH3Frame(output,envelope,signal);
    };
    let returned = false, deltas = 0;
    let pending = Promise.resolve();
    const result = await dispatch(frame.payload, {
      signal,
      onDelta(delta) {
        requireH3(!returned && sequence === 2 && ++deltas <= 16, 'H3_DELTA_PROTOCOL');
        pending = pending.then(() => reply('delta', delta));
        pending.catch(() => {});
        return pending;
      },
    });
    returned = true;
    await pending;
    await reply('result', result);
    if (sequence === 3) return;
  }
  requireH3(false, 'H3_CHANNEL_LOST');
}
