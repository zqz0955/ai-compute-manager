import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, readdirSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const nxPath=/^(\/opt\/acm-nx-(?:legacy-cpu|h3-json|h3-sse)-v1)\/engine\/readiness\.mjs$/u.exec(fileURLToPath(import.meta.url));
const nx=Boolean(nxPath);
const root=nx?nxPath[1]+'/engine':'/opt/acm-rc2-engine-readiness';
const service = '/system.slice/acm-rc2-engine-readiness.service';
const group = '/sys/fs/cgroup' + service;
const binary = root + '/assets/ollama/bin/ollama';
const guard = root + '/stdio-guard.py';
const models = root + '/assets/models';
const model = 'qwen2.5:0.5b-instruct-q4_K_M';
const digest = 'a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67';
const metadataRoutes = new Set(['/api/version', '/api/tags', '/api/ps']);
const identity = 65202;
const limits = { 'cpu.max': '100000 100000', 'memory.max': '2147483648', 'memory.swap.max': '0', 'pids.max': '64' };
const peakLimit = 1879048192;
const metadataTimeoutMs = 5000;
const gatePrefix = 'ACM_RC2_ACTOR_GATE=';
const fdKinds = { '0': 'ANONYMOUS_UNIX_STREAM', '1': 'DEV_NULL', '2': 'ANONYMOUS_UNIX_STREAM' };
const gateCodes = new Set(['STDIO_FD_UNVERIFIED','STDIO_FD_SET','STDIO_NULL','STDIO_OBJECT','STDIO_SOCKET_KIND',
  'STDIO_PEER_IDENTITY','STDIO_PEER_UNVERIFIED','STDIO_PARENT_IDENTITY','STDIO_PARENT_UNVERIFIED','STDIO_FD_CHANGED',
  'ACTOR_ARGUMENTS','ACTOR_UID','ACTOR_CGROUP','ACTOR_SCOPE','ACTOR_GATE_REFUSED','ACTOR_EXEC','ACTOR_IO_UNVERIFIED']);
const codes = new Set([...gateCodes, 'BOUNDARY', 'PIN_MISMATCH', 'RESOURCE_LIMIT', 'DEVICE_VISIBLE', 'ACTOR_IDENTITY',
  'ACTOR_EXITED', 'ACTOR_RECEIPT_INVALID', 'READY_TIMEOUT', 'LISTENER_IDENTITY', 'METADATA_ROUTE', 'METADATA_HTTP',
  'METADATA_SIZE', 'METADATA_JSON', 'METADATA_TIMEOUT', 'VERSION_MISMATCH', 'MODEL_DIGEST_MISMATCH', 'UNEXPECTED_RESIDENT',
  'CLEANUP_NOT_CONFIRMED', 'ECONNREFUSED', 'ECONNRESET', 'EACCES', 'ENOENT', 'ABORT_ERR', 'ETIMEDOUT']);
const classifications = {
  READ_ONLY_FILESYSTEM: /read-only file system/i,
  ACCESS_DENIED: /permission denied|operation not permitted/i,
  SHARED_LIBRARY: /error while loading shared libraries/i,
  EXEC_FORMAT: /exec format error|wrong elf/i,
  ADDRESS_IN_USE: /address already in use/i,
  MODEL_PRUNE: /error.*prun|prun.*error/i,
};
const fault = code => Object.assign(new Error(code), { code });
const need = (condition, code) => { if (!condition) throw fault(code); };
const codeOf = error => codes.has(error?.code) ? error.code : 'UNCLASSIFIED';
const text = path => readFileSync(path, 'utf8').trim();
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const counters = path => Object.fromEntries(text(path).split('\n').map(line => line.split(/\s+/)).map(([key, value]) => [key, Number(value)]));
const emit = row => console.log('ACM_RC2_ENGINE_STAGE=' + JSON.stringify(row));

function readOnlyEngineEnvironment() {
  const work = root + '/engine-work';
  return {
    PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: work, TMPDIR: work,
    OLLAMA_MODELS: models, OLLAMA_HOST: '127.0.0.1:11438', CUDA_VISIBLE_DEVICES: '-1', ROCR_VISIBLE_DEVICES: '-1',
    OLLAMA_NO_CLOUD: '1', OLLAMA_NOPRUNE: '1', OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1',
    OLLAMA_MAX_QUEUE: '1', OMP_NUM_THREADS: '1', GOMAXPROCS: '1', LD_LIBRARY_PATH: root + '/assets/ollama/lib/ollama',
  };
}

export async function metadataGet(path, signal) {
  need(metadataRoutes.has(path), 'METADATA_ROUTE');
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: 11438, method: 'GET', path, agent: false, signal,
      headers: { connection: 'close', accept: 'application/json' } }, res => {
      if (res.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] ?? '')) {
        res.destroy(); reject(fault('METADATA_HTTP')); return;
      }
      const blocks = [];
      let bytes = 0;
      res.on('error', reject);
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 262144) res.destroy(fault('METADATA_SIZE'));
        else blocks.push(chunk);
      });
      res.on('end', () => {
        try {
          const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(blocks)));
          need(res.complete && value && typeof value === 'object' && !Array.isArray(value), 'METADATA_JSON');
          resolve(value);
        } catch { reject(fault('METADATA_JSON')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function verifyBoundary({legacy=false}={}) {
  const service=legacy?'/acmlegacycpu.slice/acm-rc2-engine-readiness.service':'/system.slice/acm-rc2-engine-readiness.service';
  const group='/sys/fs/cgroup'+service;
  const here = root + '/readiness.mjs';
  need(process.platform === 'linux' && process.arch === 'arm64' && process.versions.node === '24.22.3' &&
    process.getuid() === 0 && process.getgid() === 0 && fileURLToPath(import.meta.url) === here &&
    process.env.ACM_RC2_METADATA_PROBE === 'offline-metadata-v1', 'BOUNDARY');
  const platformOK = nx
    ? legacy && process.env.ACM_NX_RELEASE === 'LEGACY_KERNEL_BOUNDED_CPU_V1' &&
      /Orin NX/.test(text('/proc/device-tree/model')) && process.execPath === nxPath[1]+'/code/runtime/node'
    : /QEMU/.test(text('/sys/class/dmi/id/product_name'));
  need(platformOK && text('/proc/1/comm') === 'systemd' &&
    text('/proc/self/cgroup') === '0::' + service && statfsSync(group).type === 0x63677270 &&
    ['mnt','net','ipc'].every(type => {
      const host = process.env['ACM_RC2_HOST_' + type.toUpperCase() + '_NS'];
      return new RegExp('^' + type + ':\\[\\d+\\]$').test(host ?? '') && readlinkSync('/proc/self/ns/' + type) !== host;
    }) && text('/proc/self/net/dev').split('\n').slice(2).map(line => line.split(':')[0].trim()).join() === 'lo', 'BOUNDARY');
  const runMount = text('/proc/self/mountinfo').split('\n').map(line => line.split(' - '))
    .find(([left]) => left.split(' ')[4] === '/run');
  need(/^\d+$/.test(process.env.ACM_RC2_HOST_RUN_DEV ?? '') && statSync('/run').dev !== Number(process.env.ACM_RC2_HOST_RUN_DEV) &&
    runMount?.[1].startsWith('tmpfs ') && ['ro','noexec','nodev','nosuid'].every(flag => runMount[0].split(' ')[5].split(',').includes(flag)), 'BOUNDARY');
  need(readdirSync('/dev').every(entry => !/^(dri|nvidia|nvgpu|nvhost|nvmap|tegra|video|media|v4l)/.test(entry)), 'DEVICE_VISIBLE');
  for (const [path, expected] of [
    [here, process.env.ACM_RC2_METADATA_SHA], [guard, process.env.ACM_RC2_STDIO_SHA],
    [process.execPath, '8f9c2a55879e9705cb285b6cdd649d95df642c6720f052cb30f300d2677da99f'],
    [binary, '645f7c676bac5d81332c43e5ef9d3acd792bc4391404582301c3f29eaf06c3ee'],
    [models + '/manifests/registry.ollama.ai/library/qwen2.5/0.5b-instruct-q4_K_M', digest],
  ]) {
    const entry = lstatSync(path);
    need(/^[a-f0-9]{64}$/.test(expected ?? '') && realpathSync(path) === path && entry.isFile() &&
      entry.uid === 0 && entry.gid === 0 && entry.nlink === 1 && (entry.mode & 0o222) === 0 && sha(path) === expected, 'PIN_MISMATCH');
  }
  const work = statSync(root + '/engine-work');
  need(work.isDirectory() && work.uid === identity && work.gid === identity &&
    (work.mode & 0o777) === 0o700 && statfsSync(root + '/engine-work').type === 0x01021994, 'BOUNDARY');
}

const startTickOf = pid => text('/proc/' + pid + '/stat').split(') ').at(-1).split(' ')[19];

export function createEngineLifecycle({memoryMode=null,legacySampler=null}={}) {
  need(memoryMode===null || memoryMode==='LEGACY_KERNEL_BOUNDED_CPU_V1' && typeof legacySampler==='function','BOUNDARY');
  verifyBoundary({legacy:!!memoryMode});
  const service=memoryMode?'/acmlegacycpu.slice/acm-rc2-engine-readiness.service':'/system.slice/acm-rc2-engine-readiness.service';
  const group='/sys/fs/cgroup'+service;
  const activeLimits=memoryMode?{'cpu.max':'max 100000','memory.max':'max','memory.high':'max','memory.swap.max':'max','pids.max':'max'}:limits;
  const control = group + '/controller', leaf = group + '/engine';
  mkdirSync(control);
  writeFileSync(control + '/cgroup.procs', String(process.pid));
  need(text(group + '/cgroup.procs') === '', 'RESOURCE_LIMIT');
  writeFileSync(group + '/cgroup.subtree_control', '+cpu +memory +pids');
  mkdirSync(leaf);
  for (const [file, wanted] of Object.entries(activeLimits)) {
    need(text(group + '/' + file) === wanted, 'RESOURCE_LIMIT');
    writeFileSync(leaf + '/' + file, wanted);
  }
  const leafId = lstatSync(leaf, { bigint: true });
  const legacy=memoryMode?legacySampler({group:'/sys/fs/cgroup/acmlegacycpu.slice',service:group,leaf,controller:control,memberIdentity:identity}):null;
  const port = (11438).toString(16).padStart(4, '0').toUpperCase();
  const listener = () => ['/proc/self/net/tcp', '/proc/self/net/tcp6'].filter(path => path.endsWith('/tcp') || existsSync(path))
    .flatMap(path => text(path).split('\n').slice(1).map(line => line.trim().split(/\s+/))
      .filter(row => row[3] === '0A' && row[1]?.endsWith(':' + port)));
  const member = pid => text('/proc/' + pid + '/cgroup') === '0::' + service + '/engine';
  let child, closed, stopped, bound = null, diagnostic = '', partial = '', gate = null, gateFailure = null, sampledPeak = 0;

  function metrics() {
    if(legacy) return {...legacy.sample(),empty:counters(leaf+'/cgroup.events').populated===0&&!listener().length};
    const current = lstatSync(leaf, { bigint: true });
    need(current.ino === leafId.ino && current.dev === leafId.dev &&
      Object.entries(activeLimits).every(([file, wanted]) => text(group + '/' + file) === wanted && text(leaf + '/' + file) === wanted) &&
      [group, leaf].every(path => text(path + '/memory.swap.current') === '0'), 'RESOURCE_LIMIT');
    sampledPeak = Math.max(sampledPeak, Number(text(group + '/memory.current')));
    const memory = counters(group + '/memory.events');
    const peak = Number(text(group + '/memory.peak'));
    const pidsMaxHits = counters(group + '/pids.events').max + counters(leaf + '/pids.events').max;
    need([sampledPeak, peak, memory.oom, memory.oom_kill, memory.max, pidsMaxHits]
      .every(value => Number.isSafeInteger(value) && value >= 0) && peak >= sampledPeak, 'RESOURCE_LIMIT');
    return { healthy: true, empty: counters(leaf + '/cgroup.events').populated === 0 && !listener().length,
      sampledPeak, peak, oom: memory.oom, oomKill: memory.oom_kill, max: memory.max, pidsMaxHits };
  }

  function stderr(chunk) {
    const part = chunk.toString('utf8');
    diagnostic = (diagnostic + part).slice(-8192);
    const rows = (partial + part).split('\n');
    partial = rows.pop().slice(-512);
    for (const row of rows) {
      if (!row.startsWith(gatePrefix)) continue;
      try {
        const message = JSON.parse(row.slice(gatePrefix.length));
        if (message.verdict === 'PASS' && !gate && !gateFailure && Object.keys(message).length === 2 &&
            JSON.stringify(message.fds) === JSON.stringify(fdKinds)) gate = message.fds;
        else if (message.verdict === 'HOLD' && gateCodes.has(message.code) && Object.keys(message).length === 2)
          gateFailure = message.code;
        else gateFailure = 'ACTOR_RECEIPT_INVALID';
      } catch { gateFailure = 'ACTOR_RECEIPT_INVALID'; }
    }
  }

  async function start(record = () => {}, signal) {
    const before = metrics();
    need(!child && before.empty && (memoryMode?before.peak===null:before.peak>0&&before.peak<=peakLimit),'RESOURCE_LIMIT');
    const checkRunning = async () => {
      signal?.throwIfAborted();
      if (gateFailure) throw fault(gateFailure);
      if (child.exitCode === null && child.signalCode === null) return;
      await Promise.race([closed, delay(300)]);
      throw fault(gateFailure ?? 'ACTOR_EXITED');
    };
    child = spawn('/usr/bin/python3', ['-I', '-B', guard, service + '/engine', String(process.pid), startTickOf(process.pid),
      String(process.getuid()), String(process.getgid())], { env: readOnlyEngineEnvironment(), stdio: ['pipe','ignore','pipe'] });
    closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    closed.catch(() => {});
    child.stdin.on('error', () => {});
    child.stderr.on('data', stderr);
    need(Number.isSafeInteger(child.pid) && child.pid > 1, 'ACTOR_IDENTITY');
    const pid = child.pid, startTick = startTickOf(pid);
    // 引擎子程序仍在等待管道，移至限定群組後才有機會啟動執行檔。
    writeFileSync(leaf + '/cgroup.procs', String(pid));
    bound = { pid, startTick };
    const started = performance.now();
    const processText = async file => {
      try { return text('/proc/' + pid + '/' + file); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await Promise.race([closed, delay(300)]);
        throw fault(gateFailure ?? 'ACTOR_EXITED');
      }
    };
    for (;;) {
      await checkRunning();
      const status = await processText('status');
      need(startTickOf(pid) === startTick && member(pid), 'ACTOR_IDENTITY');
      const ids = new RegExp('^(?:Uid|Gid):\\s+' + Array(4).fill(identity).join('\\s+') + '$', 'gm');
      if (status.match(ids)?.length === 2 && /^CapEff:\s+0+$/m.test(status) &&
          /^NoNewPrivs:\s+1$/m.test(status) && /^Seccomp:\s+2$/m.test(status)) break;
      need(performance.now() - started < 10000, 'READY_TIMEOUT');
      await delay(25, undefined, { signal });
    }
    record('ACTOR_IDENTITY', 'PASS');
    child.stdin.end('R');
    for (;;) {
      await checkRunning();
      const active = listener();
      need(active.length <= 1 && active.every(row => row[1] === '0100007F:' + port && row[7] === String(identity)), 'LISTENER_IDENTITY');
      const command = (await processText('cmdline')).split('\0').filter(Boolean);
      if (gate && active.length === 1 && startTickOf(pid) === startTick && member(pid) &&
          command.length === 2 && command[0] === binary && command[1] === 'serve') break;
      need(performance.now() - started < 10000, 'READY_TIMEOUT');
      await delay(40, undefined, { signal });
    }
    record('ACTOR_STDIO', 'PASS', undefined, { fds: gate });
    record('LISTENER', 'PASS');
    return bound;
  }

  function stop() {
    return stopped ??= (async () => {
      child?.stdin.destroy();
      if (child && child.exitCode === null && child.signalCode === null && bound &&
          startTickOf(bound.pid) === bound.startTick && member(bound.pid)) {
        need(child.kill('SIGTERM'), 'CLEANUP_NOT_CONFIRMED');
      }
      need(closed, 'CLEANUP_NOT_CONFIRMED');
      const exit = await Promise.race([closed, delay(6000, null, { ref: false })]);
      const deadline = performance.now() + 1500;
      const empty=()=>legacy?counters(leaf+'/cgroup.events').populated===0&&!listener().length:metrics().empty;
      while (!empty() && performance.now() < deadline) await delay(30);
      need(exit && empty(), 'CLEANUP_NOT_CONFIRMED');
      legacy?.complete();
      return exit;
    })();
  }

  return { start, stop, metrics, member, stopMonitor:()=>legacy?.stop(),monitorSignal:legacy?.signal,memoryTranscript:()=>legacy?.transcript(), hints: () => Object.entries(classifications)
    .filter(([, pattern]) => pattern.test(diagnostic)).map(([label]) => label) };
}

export async function inspectReadiness({ start, get, stop, metrics, hints, emit }) {
  const began = performance.now();
  const record = (stage, verdict, code, evidence = {}) =>
    emit({ stage, verdict, ...(code && { code }), ...evidence, elapsedMs: Math.ceil(performance.now() - began) });
  async function query(path) {
    const signal = AbortSignal.timeout(metadataTimeoutMs);
    try { return await get(path, signal); }
    catch (error) {
      if (signal.aborted) throw fault('METADATA_TIMEOUT');
      throw error;
    }
  }
  let stage = 'START', failedStage = null, code = null, cleanup = 'HOLD', cleanupCode = null;
  try {
    await start(record);
    record(stage, 'PASS');
    stage = 'VERSION';
    need((await query('/api/version')).version === '0.40.16', 'VERSION_MISMATCH');
    record(stage, 'PASS');
    stage = 'MODEL_INDEX';
    const { models: rows } = await query('/api/tags');
    need(Array.isArray(rows) && rows.length === 1 && rows[0]?.name === model &&
      [digest, 'sha256:' + digest].includes(rows[0]?.digest), 'MODEL_DIGEST_MISMATCH');
    record(stage, 'PASS');
    stage = 'RESIDENT';
    const resident = await query('/api/ps');
    need(Array.isArray(resident.models) && resident.models.length === 0, 'UNEXPECTED_RESIDENT');
    record(stage, 'PASS');
  } catch (error) {
    failedStage = stage; code = codeOf(error); record(stage, 'HOLD', code);
  }
  try {
    const exit = await stop();
    const m = metrics();
    need((exit?.code === 0 || exit?.signal === 'SIGTERM') && m.empty && m.peak > 0 && m.peak <= peakLimit &&
      ['oom','oomKill','max','pidsMaxHits'].every(key => m[key] === 0), 'CLEANUP_NOT_CONFIRMED');
    cleanup = 'VERIFIED';
    record('STOP', 'PASS', undefined, { cgroupEmpty: m.empty, peakBytes: m.peak });
  } catch (error) {
    cleanupCode = codeOf(error);
    if (!failedStage) { failedStage = 'STOP'; code = cleanupCode; }
    record('STOP', 'HOLD', cleanupCode);
  }
  return { verdict: failedStage ? 'HOLD' : 'PASS_METADATA_ONLY', failedStage, code, cleanup, cleanupCode,
    generationRequests: 0, hints: hints() };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const lifecycle = createEngineLifecycle();
    const result = await inspectReadiness({ ...lifecycle, get: metadataGet, emit });
    console.log('ACM_RC2_ENGINE_READINESS=' + JSON.stringify(result));
    process.exitCode = result.verdict === 'PASS_METADATA_ONLY' ? 0 : 42;
  } catch (error) {
    console.log('ACM_RC2_ENGINE_READINESS=' + JSON.stringify({ verdict: 'HOLD', code: codeOf(error), generationRequests: 0 }));
    process.exitCode = 42;
  }
}
