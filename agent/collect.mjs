import { readdir, readFile, statfs } from 'node:fs/promises';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { agentModelLimit } from './protocol.mjs';

const maxModelBytes = 262_144;
const gpuPaths = [
  '/sys/devices/platform/17000000.gpu/load',
  '/sys/devices/17000000.ga10b/load',
];
const thermalDirectory = '/sys/class/thermal';

const unsigned = text => /^\d+$/u.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;

async function textFile(path) {
  return readFile(path, 'utf8').catch(() => '');
}

function cpuTicks(text) {
  if (!text.startsWith('cpu ')) return null;
  const ticks = text.split('\n', 1)[0].trim().split(/\s+/u).slice(1, 9).map(unsigned);
  return ticks.length === 8 && ticks.every(value => value !== null) ? ticks : null;
}

async function cpuUsage(signal) {
  const before = cpuTicks(await textFile('/proc/stat'));
  await delay(200, undefined, { signal });
  const after = cpuTicks(await textFile('/proc/stat'));
  if (before === null || after === null) return null;
  const delta = after.map((value, index) => value - before[index]);
  const total = delta.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || delta.some(value => value < 0)) return null;
  return 100 * (total - delta[3] - delta[4]) / total;
}

function usage(total, free) {
  return total !== null && free !== null && free <= total ? total - free : null;
}

async function memory() {
  const text = await textFile('/proc/meminfo');
  const bytes = key => {
    const amount = new RegExp('^' + key + ':\\s+(\\d+)\\s+kB$', 'mu').exec(text)?.[1];
    const value = amount === undefined ? null : unsigned(amount);
    return value !== null && Number.isSafeInteger(value * 1024) ? value * 1024 : null;
  };
  const total = bytes('MemTotal');
  const ramBytes = total === 0 ? null : total;
  const swapBytes = bytes('SwapTotal');
  return { ramUsedBytes: usage(ramBytes, bytes('MemAvailable')), ramBytes,
    swapUsedBytes: usage(swapBytes, bytes('SwapFree')), swapBytes };
}

async function disk() {
  const fs = await statfs('/', { bigint: true }).catch(() => null);
  if (fs === null) return { diskBytes: null, diskUsedBytes: null };
  const positiveBytes = fs.blocks * fs.bsize;
  const used = (fs.blocks - fs.bfree) * fs.bsize;
  const diskBytes = positiveBytes > 0n && positiveBytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(positiveBytes) : null;
  const diskUsedBytes = diskBytes !== null && used >= 0n && used <= positiveBytes ? Number(used) : null;
  return { diskBytes, diskUsedBytes };
}

async function gpuLoad() {
  for (const path of gpuPaths) {
    const load = unsigned((await textFile(path)).trim());
    if (load !== null && load <= 1_000) return load / 10;
  }
  return null;
}

async function temperature() {
  const names = (await readdir(thermalDirectory).catch(() => [])).filter(name => /^thermal_zone\d+$/u.test(name));
  if (names.length > 128) return null;
  const values = await Promise.all(names.map(async name => {
    const value = (await textFile(thermalDirectory + '/' + name + '/temp')).trim();
    const milliDegrees = /^-?\d+$/u.test(value) ? Number(value) : NaN;
    return milliDegrees >= -50_000 && milliDegrees <= 200_000 ? milliDegrees / 1_000 : null;
  }));
  const present = values.filter(value => value !== null);
  return present.length ? Math.max(...present) : null;
}

function readLocalModels(path, signal) {
  const bounded = AbortSignal.any([AbortSignal.timeout(1_500), ...(signal ? [signal] : [])]);
  return new Promise((resolve, reject) => {
    const client = request({ hostname:'127.0.0.1', family:4, port:11434, path, method:'GET',
      headers:{ Accept:'application/json' }, agent:false, signal:bounded }, async response => {
      try {
        if (response.statusCode !== 200 || !/^application\/json(?:;|$)/iu.test(response.headers['content-type'] ?? '')
          || response.headers['content-encoding'] !== undefined) throw new Error('AGENT_MODEL_RESPONSE');
        const chunks = [];
        let bytes = 0;
        for await (const chunk of response) {
          bytes += chunk.length;
          if (bytes > maxModelBytes) throw new Error('AGENT_MODEL_RESPONSE');
          chunks.push(chunk);
        }
        const document = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks, bytes)));
        if (!Array.isArray(document?.models) || document.models.length > agentModelLimit) throw new Error('AGENT_MODEL_RESPONSE');
        const names = new Set();
        const rows = [];
        for (const row of document.models) {
          const name = row?.name ?? row?.model;
          const digest = typeof row?.digest === 'string' ? row.digest.replace(/^sha256:/u, '') : '';
          if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u.test(name) || names.has(name)
            || !/^[a-f0-9]{64}$/u.test(digest) || !Number.isSafeInteger(row.size) || row.size < 0) {
            throw new Error('AGENT_MODEL_RESPONSE');
          }
          names.add(name);
          rows.push({ name, digest, sizeBytes:row.size });
        }
        resolve(rows);
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    client.once('error', reject);
    client.end();
  }).catch(() => null);
}

export async function collectAgentSample({ ollama, signal } = {}) {
  if (process.platform !== 'linux') throw new Error('AGENT_REQUIRE_LINUX');
  signal?.throwIfAborted();
  const [cpuPercent, ram, storage, gpuPercent, temperatureC, models, resident] = await Promise.all([
    cpuUsage(signal), memory(), disk(), gpuLoad(), temperature(),
    ollama ? readLocalModels('/api/tags', signal) : null,
    ollama ? readLocalModels('/api/ps', signal) : null,
  ]);
  signal?.throwIfAborted();
  return { sampledAt:Date.now(),
    metrics:{ cpuPercent, ...ram, ...storage, gpuPercent, gpuUsedBytes:null, temperatureC }, models, resident };
}
