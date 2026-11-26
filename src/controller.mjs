import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isQualifiedWorker } from './worker/admission.mjs';
import { realInferenceDisabled } from './worker/real-one-shot.mjs';
import { createSimulationWorker, freshEvidenceBudgetMs, hash, resultFor, tokenCount } from './worker/simulation.mjs';

const applicationId = 0x41434d31;
const qualificationId = 0x41434d32;
const qualificationControllers = new WeakSet();
export const isQualificationController = controller => qualificationControllers.has(controller);
const storeName = 'controller.sqlite';
const activeStates = ['QUEUED', 'RUNNING', 'STOPPING'];
const finished = job => !activeStates.includes(job.state);
const order = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (code, status, message) => Object.assign(new Error(message), { code, status });
const invalid = () => error('INVALID_CONFIGURATION', 400, '節點或控制器設定無效。');
const stateError = () => error('DURABLE_STATE_INVALID', 503, '持久狀態未通過核對。');
const GiB = 1024 ** 3;
const demoModel = { id: 'fixture:demo', digest: 'a'.repeat(64), context: 2048, maxTokens: 256, device: 'cpu' };
const gpuModel = { id: 'fixture:gpu', digest: 'b'.repeat(64), context: 2048, maxTokens: 256, device: 'gpu', gpuBytes: GiB };

function defaultNodes() {
  return [
    { id: 'sim-jetson-a', name: '模擬 Orin Nano', platform: 'jetson', cpuCores: 6, ramBytes: 8 * GiB, diskBytes: 64 * GiB,
      gpuBytes: 4 * GiB, gpu: { state: 'SUPPORTED', backend: 'CUDA', sharedMemory: true }, models: [demoModel, gpuModel] },
    { id: 'sim-jetson-b', name: '模擬 Orin NX', platform: 'jetson', cpuCores: 8, ramBytes: 16 * GiB, diskBytes: 128 * GiB,
      gpuBytes: 8 * GiB, gpu: { state: 'SUPPORTED', backend: 'CUDA', sharedMemory: true }, models: [demoModel, gpuModel] },
    { id: 'sim-windows', name: '模擬 Windows', platform: 'windows', cpuCores: 12, ramBytes: 32 * GiB, diskBytes: 256 * GiB,
      gpuBytes: 0, gpu: { state: 'UNSUPPORTED', backend: null, sharedMemory: null }, models: [demoModel] },
  ].map((node, index) => ({ ...node, swapBytes: 0, metrics: { cpuPercent: 6 + index * 4, gpuPercent: node.gpuBytes ? 0 : null,
    ramUsedBytes: (index + 1) * GiB, swapUsedBytes: 0, gpuUsedBytes: 0, diskUsedBytes: (index + 1) * 12 * GiB, temperatureC: 39 + index * 3 } }));
}

function modelFor(value) {
  if (!value || !modelId(value.id) || !digest(value.digest) || !count(value.context) ||
      !count(value.maxTokens) || value.maxTokens < 1 || value.context < value.maxTokens ||
      !['cpu', 'gpu'].includes(value.device)) throw invalid();
  const requirements = Object.fromEntries(['ramBytes', 'diskBytes', 'gpuBytes'].map(key => {
    if (value[key] != null && !count(value[key])) throw invalid();
    return [key, value[key] ?? 0];
  }));
  return { id: value.id, digest: value.digest, context: value.context, maxTokens: value.maxTokens, device: value.device, ...requirements };
}

function nodeInventory(configured, mode) {
  if (!Array.isArray(configured) || configured.length > 64) throw invalid();
  const simulate = mode === 'simulation';
  const catalog = new Map(), ids = new Set();
  const source = simulate && !configured.length ? defaultNodes() : configured;
  const profiles = source.map(value => {
    if (!object(value) || !token(value.id) || ids.has(value.id.toLowerCase())) throw invalid();
    ids.add(value.id.toLowerCase());
    const declaredResource = value.resource ?? value.resourceId ?? value.id;
    const aliases = value.aliases ?? [];
    const modelRows = value.models ?? (simulate ? [demoModel] : []);
    const resident = value.resident ?? [];
    if (!token(declaredResource) || !Array.isArray(aliases) || aliases.length > 32 || !aliases.every(token) ||
        !Array.isArray(modelRows) || modelRows.length > 128 || !Array.isArray(resident) || resident.length > 128 || !resident.every(modelId) ||
        (value.gpu != null && !object(value.gpu)) || (value.metrics != null && !object(value.metrics)) ||
        (value.name != null && (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 128))) throw invalid();
    const models = modelRows.map(modelFor);
    if (new Set(models.map(model => model.id)).size !== models.length || resident.some(id => !models.some(model => model.id === id))) throw invalid();
    for (const model of models) {
      if (catalog.has(model.id) && hash(catalog.get(model.id)) !== hash(model)) throw invalid();
      catalog.set(model.id, model);
    }
    const limits = Object.fromEntries(['cpuCores', 'gpuBytes', 'ramBytes', 'swapBytes', 'diskBytes'].map(key => {
      if (value[key] != null && !count(value[key])) throw invalid();
      return [key, value[key] ?? null];
    }));
    const gpu = { state: value.gpu?.state ?? 'UNKNOWN', backend: value.gpu?.backend ?? null, sharedMemory: value.gpu?.sharedMemory ?? null };
    if (!['SUPPORTED', 'UNSUPPORTED', 'UNKNOWN'].includes(gpu.state) ||
        (gpu.backend != null && !token(gpu.backend)) ||
        (gpu.sharedMemory != null && typeof gpu.sharedMemory !== 'boolean')) throw invalid();
    const metrics = value.metrics == null ? null : Object.fromEntries(
      ['cpuPercent', 'gpuPercent', 'ramUsedBytes', 'swapUsedBytes', 'gpuUsedBytes', 'diskUsedBytes', 'temperatureC', 'sampledAt'].map(key => {
        const reading = value.metrics[key] ?? null;
        if (reading !== null && !Number.isFinite(reading)) throw invalid();
        if (['cpuPercent', 'gpuPercent'].includes(key) && reading !== null && (reading < 0 || reading > 100)) throw invalid();
        if ((key.includes('Bytes') || key === 'sampledAt') && reading !== null && !count(reading)) throw invalid();
        return [key, reading];
      }));
    if (metrics) metrics.source = simulate ? 'SIMULATION' : 'DECLARED';
    const platform = value.platform ?? 'unknown';
    if (!token(platform)) throw invalid();
    if (value.status != null && !token(value.status)) throw invalid();
    const reportedStatus = value.status ?? (simulate ? 'SIMULATED' : 'UNKNOWN');
    const status = simulate ? ['ONLINE', 'READY', 'SIMULATED'].includes(reportedStatus) ? 'SIMULATED' : reportedStatus : 'LOCKED';
    const resource = declaredResource.toLowerCase();
    return { id: value.id, name: value.name ?? value.id, platform, status, reportedStatus, resource,
      aliases: [...new Set([...aliases.map(alias => alias.toLowerCase()), value.id.toLowerCase(), `node:${value.id.toLowerCase()}`])].sort(order),
      ...limits, gpu, metrics, models, resident: [...new Set(resident)], simulated: simulate, inferenceLocked: !simulate };
  }).sort((a, b) => order(a.id, b.id));

  // 共享任何實體身分或別名的節點必須使用同一組排他鎖。
  const groups = [];
  for (const node of profiles) {
    const claims = new Set([node.resource, ...node.aliases]);
    const group = { members: [node], claims };
    for (const other of groups.filter(item => [...claims].some(claim => item.claims.has(claim)))) {
      groups.splice(groups.indexOf(other), 1);
      group.members.push(...other.members);
      for (const claim of other.claims) claims.add(claim);
    }
    groups.push(group);
  }
  for (const { members, claims } of groups) {
    const canonical = members.map(node => node.resource).sort(order)[0];
    for (const node of members) {
      node.resource = canonical;
      node.aliases = [...claims].filter(claim => claim !== canonical).sort(order);
    }
  }
  return { profiles, catalog };
}

const schema = appId => `
  CREATE TABLE jobs (
    seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, request_id TEXT NOT NULL,
    signature TEXT NOT NULL, input TEXT, data TEXT NOT NULL CHECK(json_valid(data)),
    state TEXT GENERATED ALWAYS AS (json_extract(data,'$.state')) STORED NOT NULL,
    priority INTEGER GENERATED ALWAYS AS (json_extract(data,'$.priority')) STORED NOT NULL,
    UNIQUE(client_id,request_id)
  ) STRICT;
  CREATE INDEX queue_order ON jobs(state,priority DESC,seq);
  CREATE TABLE reservations (
    resource TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), attempt_id TEXT NOT NULL UNIQUE,
    node_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('INTENT','HOLD')), binding TEXT NOT NULL CHECK(json_valid(binding))
  ) STRICT;
  CREATE TABLE reservation_aliases (
    alias TEXT PRIMARY KEY, resource TEXT NOT NULL REFERENCES reservations(resource) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), attempt_id TEXT, node_id TEXT,
    event TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT NOT NULL CHECK(json_valid(detail))
  ) STRICT;
  CREATE INDEX event_job ON events(job_id,seq);
  CREATE TABLE worker_identity (resource TEXT PRIMARY KEY, epoch TEXT NOT NULL, private_key TEXT NOT NULL, public_key TEXT NOT NULL) STRICT;
  CREATE TABLE worker_events (
    seq INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL, state TEXT NOT NULL,
    document TEXT NOT NULL CHECK(json_valid(document)), signature TEXT NOT NULL, UNIQUE(attempt_id,state)
  ) STRICT;
  PRAGMA application_id=${appId};
  PRAGMA user_version=1;
`;

function openStorage(dataDir, { appId = applicationId, createOnly = false, existingOnly = false } = {}) {
  const unsafe = () => error('STORAGE_UNSAFE', 503, '工作資料路徑未通過核對。');
  const stat = path => lstatSync(path, { bigint: true });
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;
  const canonical = path => realpathSync(path) === path;
  function regular(path) {
    const id = stat(path);
    if (!id.isFile() || id.nlink !== 1n || id.ino === 0n || !canonical(path)) throw unsafe();
    return id;
  }
  let db;
  try {
    if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || resolve(dataDir) !== dataDir ||
        parse(dataDir).root === dataDir || !canonical(dataDir)) throw unsafe();
    const before = stat(dataDir);
    if (!before.isDirectory() || before.ino === 0n) throw unsafe();
    const path = join(dataDir, storeName);
    function sidecars() {
      let present = false;
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try { regular(path + suffix); present = true; } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      }
      return present;
    }
    const hadSidecars = sidecars();
    let file, created = false;
    try {
      file = regular(path);
      if (createOnly) throw unsafe();
    }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      if (existingOnly || hadSidecars) throw unsafe();
      closeSync(openSync(path, 'wx', 0o600));
      created = true;
      file = regular(path);
    }
    const check = () => {
      if (!canonical(dataDir) || !same(before, stat(dataDir)) || !same(file, regular(path))) throw unsafe();
      sidecars();
    };
    check();
    db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA locking_mode=EXCLUSIVE;');
    function version() {
      const app = db.prepare('PRAGMA application_id').get().application_id;
      const v = db.prepare('PRAGMA user_version').get().user_version;
      if (app === appId && v === 1) return 1;
      if (created && app === 0 && v === 0 && !db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) return 0;
      throw error('STORAGE_FORMAT_UNSUPPORTED', 503, '工作資料庫版本無法辨識。');
    }
    version();
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    function transaction(fn) {
      check();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        check();
        db.exec('COMMIT');
        return result;
      } catch (cause) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw cause;
      }
    }
    transaction(() => {
      if (version() === 0) db.exec(schema(appId));
      if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal' ||
          db.prepare('PRAGMA synchronous').get().synchronous !== 2 ||
          db.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok') ||
          db.prepare('PRAGMA foreign_key_check').get()) throw stateError();
    });
    const pin = hash([before.dev, before.ino, file.dev, file.ino].map(String));
    return { db, transaction, pin };
  } catch (cause) {
    db?.close();
    if (cause.status) throw cause;
    if ([5, 6].includes(cause.errcode) || cause.code === 'EEXIST') throw error('CONTROLLER_BUSY', 409, '工作資料庫由另一個控制程序持有。');
    throw error('STORAGE_UNAVAILABLE', 503, '無法開啟工作資料庫。');
  }
}

export function provisionQualificationStore(dataDir) {
  const {db,pin}=openStorage(dataDir,{appId:qualificationId,createOnly:true});
  db.close();
  return pin;
}

function available(node, model) {
  if (node.status !== 'SIMULATED' || !node.models.some(candidate => candidate.id === model.id)) return false;
  const observedAt = node.metrics?.sampledAt, now = Date.now();
  if (observedAt != null && (now - observedAt > 15_000 || observedAt - now > 1000)) return false;
  if (model.device === 'gpu' && (node.gpu.state !== 'SUPPORTED' || !count(node.gpuBytes) ||
      !count(node.metrics?.gpuUsedBytes) || node.metrics.gpuUsedBytes >= node.gpuBytes)) return false;
  return ['ram', 'disk', 'gpu'].every(kind => {
    const bytes = model[`${kind}Bytes`], total = node[`${kind}Bytes`], used = node.metrics?.[`${kind}UsedBytes`];
    return !bytes || (count(total) && count(used) && total - used >= bytes);
  });
}

function errorDetail(code) {
  const message = {
    CANCELLED: '工作已取消。', TIMEOUT: '工作執行超時。', OUT_OF_MEMORY: '模擬引擎回報記憶體不足。',
    CONTROLLER_STOPPED: '控制程序已關閉。', CONTROLLER_RESTARTED: '控制程序重新啟動，前次工作未重送。',
    WORKER_DISCONNECTED: '與模擬引擎失聯，資源狀態仍待核對。',
    WORKER_NOT_QUALIFIED: '執行通道的身分、資格或證據不符，保留資源鎖。',
    EVIDENCE_UNAVAILABLE: '尚無同次工作的新鮮終態及清空證據，保留資源鎖。',
    SIMULATION_FAILURE: '模擬引擎回報失敗。',
  }[code] ?? '工作終態需要核對。';
  return { code, message };
}

function qualifiedRoster(mode, configured, worker, workers) {
  if (mode !== 'engine-qualification') {
    if (worker !== undefined || workers !== undefined) throw realInferenceDisabled();
    return [];
  }
  if (!Array.isArray(configured) || configured.length !== 0 ||
      (workers !== undefined && (worker !== undefined || !Array.isArray(workers) || workers.length < 1 || workers.length > 16)))
    throw realInferenceDisabled();
  const roster = workers === undefined ? [worker] : [...workers];
  if (!roster.every(isQualifiedWorker)) throw realInferenceDisabled();
  const admissions = new Set(), keys = new Set(), aliases = new Set(), epochs = new Set();
  for (const {claim} of roster) {
    const {node} = claim;
    const claims = new Set([node.resource, node.id, `node:${node.id}`, ...node.aliases]);
    if (claim.source !== roster[0].claim.source || admissions.has(claim.id) || keys.has(claim.workerKey) ||
        epochs.has(claim.epoch) || [...claims].some(alias => aliases.has(alias))) throw realInferenceDisabled();
    admissions.add(claim.id);
    keys.add(claim.workerKey);
    epochs.add(claim.epoch);
    for (const alias of claims) aliases.add(alias);
  }
  return roster;
}

export function openController({ dataDir, mode = 'read-only', nodes: configured = [], maxConcurrent = 2,
  timeoutMs = 30_000, simulation = {}, qualifiedWorker, qualifiedWorkers } = {}) {
  const qualification = mode === 'engine-qualification';
  if (!['simulation', 'read-only', 'engine-qualification'].includes(mode) || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !object(simulation)) throw invalid();
  const roster = qualifiedRoster(mode, configured, qualifiedWorker, qualifiedWorkers);
  const inventory = qualification ? roster.map(({claim}) => ({ ...claim.node, models: [claim.model] })) : configured;
  const { profiles, catalog } = nodeInventory(inventory, mode);
  const { db, transaction, pin } = openStorage(dataDir, qualification ? {appId:qualificationId,existingOnly:true} : undefined);
  try {
    if (roster.some(worker => worker.claim.store !== pin)) throw realInferenceDisabled();
    const controller = createController({ db, transaction, profiles, catalog, mode, maxConcurrent, timeoutMs, simulation, roster });
    if (qualification) qualificationControllers.add(controller);
    return controller;
  } catch (cause) {
    db.close();
    throw cause.status ? cause : stateError();
  }
}

function createController({ db, transaction, profiles, catalog, mode, maxConcurrent, timeoutMs, simulation, roster }) {
  const owner = randomUUID();
  const running = new Map(), waiters = new Map();
  let closed = false, closing = null, fatal = null, pumpPending = false;
  const qualified = roster.length > 0;
  const workerByPin = new Map(roster.map(worker => [worker.pin, worker]));
  const workerByNode = new Map(roster.map(worker => [worker.claim.node.id, worker]));
  const profileById = new Map(profiles.map(profile => [profile.id, profile]));
  const simulator = qualified ? null : createSimulationWorker({ db, transaction, options: simulation });
  const source = roster[0]?.claim.source ?? 'SIMULATION';
  // 即使尚未派送，已提交的工作也消耗該次資格。重啟時以持久工作紀錄重建。
  const used = new Set();
  const allUsed = () => qualified && used.size === roster.length;
  const eligible = (node, model) => {
    if (!qualified) return available(node, model);
    const worker = workerByNode.get(node.id);
    return worker.claim.model.id === model.id && !used.has(worker.pin) && worker.readyForLaunch();
  };
  const read = db.prepare('SELECT id,client_id,input,data FROM jobs WHERE id=?');
  const save = db.prepare('UPDATE jobs SET data=?,input=? WHERE id=?');
  const findRequest = db.prepare('SELECT id,signature FROM jobs WHERE client_id=? AND request_id=?');
  const queue = db.prepare("SELECT id,input,data FROM jobs WHERE state='QUEUED' ORDER BY priority DESC,seq");
  const reservations = db.prepare('SELECT * FROM reservations ORDER BY resource');
  const reservedAliases = db.prepare('SELECT alias FROM reservation_aliases WHERE resource=? ORDER BY alias');
  const insertJob = db.prepare('INSERT INTO jobs(id,client_id,request_id,signature,input,data) VALUES (?,?,?,?,?,?)');
  const record = db.prepare('INSERT INTO events(job_id,attempt_id,node_id,event,at,detail) VALUES (?,?,?,?,?,?)');
  const intents = db.prepare("SELECT detail FROM events WHERE job_id=? AND event='INTENT'");
  const releases = db.prepare("SELECT at,detail FROM events WHERE job_id=? AND event='RELEASE'");
  const write = (job, input = null) => save.run(JSON.stringify(job), input, job.id);
  const event = (job, type, detail = {}, at = Date.now()) =>
    record.run(job.id, job.attemptId, job.nodeId, type, at, JSON.stringify(detail));
  const aliases = resource => reservedAliases.all(resource).map(row => row.alias);
  const claimsFor = node => [node.resource, ...node.aliases].sort(order);
  const readJob = id => {
    const row = typeof id === 'string' ? read.get(id) : null;
    if (!row) throw error('JOB_NOT_FOUND', 404, '找不到工作。');
    const job = JSON.parse(row.data);
    if (job.id !== row.id || job.clientId !== row.client_id) throw stateError();
    return job;
  };
  const stopBeforeRun = (job, code) => {
    const next = { ...job, state: code === 'CANCELLED' ? 'CANCELLED' : 'INTERRUPTED', error: errorDetail(code),
      finishedAt: Date.now(), cleanup: { confirmed: true, reason: 'NOT_DISPATCHED' } };
    write(next);
    event(next, next.state, { reason: code });
    return next;
  };

  transaction(() => {
    const held = new Map(reservations.all().map(row => [row.job_id, row]));
    for (const row of db.prepare('SELECT id,client_id,input,data FROM jobs ORDER BY seq').iterate()) {
      const job = JSON.parse(row.data), lock = held.get(row.id);
      const history = intents.all(row.id), completed = releases.all(row.id);
      if (job.id !== row.id || job.clientId !== row.client_id || job.source !== source ||
          !token(job.clientId) || typeof job.cleanup?.confirmed !== 'boolean' ||
          (job.state === 'SUCCEEDED' ? typeof job.output !== 'string' || !job.usage : 'output' in job || job.usage !== null)) {
        throw stateError();
      }
      const worker = qualified ? workerByPin.get(job.workerPin) : simulator;
      if (qualified) {
        if (!worker || used.has(worker.pin) || job.admissionId !== worker.claim.id ||
            job.model !== worker.claim.model.id || job.digest !== worker.claim.model.digest ||
            job.device !== worker.claim.model.device || !count(job.maxTokens) || job.maxTokens < 1 ||
            job.maxTokens > worker.claim.model.maxTokens) throw stateError();
        used.add(worker.pin);
      }
      if (job.attemptId != null) {
        if (history.length !== 1) throw stateError();
        const intent = JSON.parse(history[0].detail), { binding } = intent;
        if (binding?.jobId !== job.id || binding.attemptId !== job.attemptId || binding.nodeId !== job.nodeId ||
            binding.resource !== job.resource || binding.model !== job.model || binding.digest !== job.digest ||
            binding.intentAt !== job.startedAt || (qualified &&
            (binding.admissionId !== job.admissionId || binding.workerPin !== job.workerPin ||
             binding.maxTokens !== job.maxTokens || job.nodeId !== worker.claim.node.id ||
             job.resource !== worker.claim.node.resource ||
             hash(intent.aliases) !== hash(claimsFor(profileById.get(job.nodeId)))))) throw stateError();
        if (lock) {
          if (completed.length || job.cleanup.confirmed || lock.attempt_id !== job.attemptId ||
              lock.node_id !== job.nodeId || lock.resource !== job.resource || hash(JSON.parse(lock.binding)) !== hash(binding) ||
              hash(aliases(lock.resource)) !== hash(intent.aliases) ||
              (lock.phase === 'INTENT' ? !['RUNNING', 'STOPPING'].includes(job.state) : job.state !== 'INTERRUPTED')) throw stateError();
        } else {
          if (completed.length !== 1 || !job.cleanup.confirmed || job.finishedAt !== completed[0].at) throw stateError();
          const { evidence, nonce } = JSON.parse(completed[0].detail);
          if (!worker.verifies(binding, resultFor(job), evidence, nonce, completed[0].at)) throw stateError();
        }
      } else {
        const queued = job.state === 'QUEUED';
        if (lock || history.length || completed.length || job.nodeId !== null || job.resource !== null ||
            job.startedAt !== null || (queued ? typeof row.input !== 'string' || job.cleanup.confirmed ||
              job.cleanup.reason !== 'PENDING' || job.finishedAt !== null :
              !['CANCELLED', 'INTERRUPTED'].includes(job.state) || !job.cleanup.confirmed ||
              job.cleanup.reason !== 'NOT_DISPATCHED' || !count(job.finishedAt) || row.input !== null)) throw stateError();
      }
      if (job.state === 'QUEUED') stopBeforeRun(job, 'CONTROLLER_RESTARTED');
      else if (lock?.phase === 'INTENT') {
        const next = { ...job, state: 'INTERRUPTED', finishedAt: Date.now(), error: errorDetail('CONTROLLER_RESTARTED'),
          cleanup: { confirmed: false, reason: 'CRASH_HOLD' } };
        write(next);
        db.prepare("UPDATE reservations SET phase='HOLD' WHERE job_id=?").run(job.id);
        event(next, 'CRASH_HOLD', { reason: 'CONTROLLER_RESTARTED' });
      }
    }
  });

  function requireOpen() {
    if (fatal) throw fatal;
    if (closed || closing) throw error('CONTROLLER_CLOSED', 503, '控制程序已停止接收工作。');
  }

  function notify(job) {
    const pending = waiters.get(job.id);
    waiters.delete(job.id);
    for (const waiter of pending ?? []) waiter.finish(job);
  }

  function fault(cause) {
    fatal ??= cause.status ? cause : stateError();
    for (const pending of waiters.values()) for (const waiter of pending) waiter.reject(fatal);
    waiters.clear();
    for (const entry of running.values()) entry.abort.abort(errorDetail('CONTROLLER_STOPPED'));
  }

  function stage(row, node) {
    const job = JSON.parse(row.data), attemptId = randomUUID(), startedAt = Date.now();
    const binding = Object.freeze({ jobId: job.id, attemptId, owner, resource: node.resource, nodeId: node.id,
      model: job.model, digest: job.digest, intentAt: startedAt, inputHash: hash([job.kind, row.input, job.maxTokens]),
      ...(qualified ? {admissionId:job.admissionId,workerPin:job.workerPin,maxTokens:job.maxTokens} : {}) });
    const next = { ...job, state: 'RUNNING', startedAt, attemptId, nodeId: node.id, resource: node.resource,
      decision: { code: 'RESERVED', nodeId: node.id, resource: node.resource, device: job.device, priority: job.priority } };
    const claims = claimsFor(node);
    transaction(() => {
      db.prepare("INSERT INTO reservations VALUES (?,?,?,?,'INTENT',?)")
        .run(node.resource, job.id, attemptId, node.id, JSON.stringify(binding));
      const insertAlias = db.prepare('INSERT INTO reservation_aliases VALUES (?,?)');
      for (const alias of claims) insertAlias.run(alias, node.resource);
      write(next, row.input);
      event(next, 'INTENT', { binding, aliases: claims });
    });
    return { binding, node, kind:job.kind, input: row.input, maxTokens: job.maxTokens };
  }

  async function executeAttempt(context, abort, worker) {
    const { binding } = context;
    let result, evidence, nonce, stopTimer, failure;
    const deadline = setTimeout(() => abort.abort(errorDetail('TIMEOUT')), timeoutMs);
    let onAbort;
    const stopping = new Promise((_, reject) => {
      onAbort = () => { stopTimer = setTimeout(() => reject(abort.signal.reason), freshEvidenceBudgetMs); };
      abort.signal.addEventListener('abort', onAbort, { once: true });
      if (abort.signal.aborted) onAbort();
    });
    try {
      result = await Promise.race([worker.execute({ ...context, signal: abort.signal }), stopping]);
      clearTimeout(deadline);
      nonce = worker.challenge();
      const sampleDeadline = AbortSignal.timeout(freshEvidenceBudgetMs);
      const sampleStart = performance.now();
      let sampleTimer;
      try {
        const expired = new Promise(resolve => { sampleTimer = setTimeout(resolve, freshEvidenceBudgetMs); });
        evidence = await Promise.race([worker.queryEvidence(binding, nonce, sampleDeadline), expired]);
      } finally { clearTimeout(sampleTimer); }
      if (performance.now() - sampleStart > freshEvidenceBudgetMs) evidence = null;
    } catch (cause) {
      evidence = null;
      if (['WORKER_DISCONNECTED','WORKER_NOT_QUALIFIED'].includes(cause?.code)) failure = cause.code;
    } finally {
      clearTimeout(deadline);
      clearTimeout(stopTimer);
      abort.signal.removeEventListener('abort', onAbort);
    }
    if (fatal) return;
    const job = readJob(binding.jobId);
    const done = transaction(() => {
      const at = Date.now();
      const confirmed = !!evidence && worker.verifies(binding, result, evidence, nonce, at);
      const state = confirmed ? result.outcome : 'INTERRUPTED';
      const reason = confirmed ? result.code : abort.signal.reason?.code ?? failure ?? 'EVIDENCE_UNAVAILABLE';
      const next = { ...job, state, finishedAt: at, durationMs: Math.max(0, at - job.startedAt),
        ...(confirmed && state === 'SUCCEEDED' ? { output: result.output, usage: result.usage, finishReason: result.finishReason } : {}),
        error: reason ? errorDetail(reason) : null,
        cleanup: { confirmed, reason: confirmed ? (qualified ? 'SIGNED_ISOLATED_EVIDENCE' : 'SIGNED_SIMULATION_EVIDENCE') : 'EVIDENCE_HOLD' } };
      write(next);
      if (confirmed) {
        // 終態、同次新鮮資源取樣與釋放鎖必須一起提交。
        const removed = db.prepare("DELETE FROM reservations WHERE job_id=? AND attempt_id=? AND phase='INTENT'")
          .run(job.id, binding.attemptId);
        if (removed.changes !== 1) throw stateError();
        event(next, 'RELEASE', { nonce, evidence, reason }, at);
      } else {
        const held = db.prepare("UPDATE reservations SET phase='HOLD' WHERE job_id=? AND attempt_id=? AND phase='INTENT'")
          .run(job.id, binding.attemptId);
        if (held.changes !== 1) throw stateError();
        event(next, 'EVIDENCE_HOLD', { reason }, at);
      }
      return next;
    });
    notify(done);
  }

  function pump() {
    if (closing || closed || fatal || mode === 'read-only') return;
    const locks = reservations.all(), occupied = new Set(locks.flatMap(lock => [lock.resource, ...aliases(lock.resource)]));
    let slots = maxConcurrent - locks.length;
    if (!qualified && slots < 1) return;
    for (const row of queue.all()) {
      const job = JSON.parse(row.data);
      const worker = qualified ? workerByPin.get(job.workerPin) : simulator;
      let node;
      if (qualified) {
        if (!worker || job.admissionId !== worker.claim.id) throw stateError();
        if (!worker.readyForLaunch()) {
          notify(transaction(() => stopBeforeRun(job, 'WORKER_NOT_QUALIFIED')));
          continue;
        }
        if (slots < 1) continue;
        node = profileById.get(worker.claim.node.id);
        if (claimsFor(node).some(key => occupied.has(key))) continue;
      } else {
        if (slots < 1) break;
        const model = catalog.get(job.model);
        const candidates = profiles.filter(node => model && eligible(node, model) &&
          !claimsFor(node).some(key => occupied.has(key)));
        candidates.sort((left, right) => Number(right.resident.includes(job.model)) - Number(left.resident.includes(job.model)) ||
          order(left.id, right.id));
        [node] = candidates;
      }
      if (!node) continue;
      const context = stage(row, node);
      for (const claim of claimsFor(node)) occupied.add(claim);
      const abort = new AbortController();
      const active = { abort, preview: '' };
      context.publish = fragment => {
        if (abort.signal.aborted) return;
        if (typeof fragment !== 'string' || !fragment.isWellFormed() ||
            Buffer.byteLength(active.preview) + Buffer.byteLength(fragment) > 65536) {
          throw error('WORKER_OUTPUT_INVALID', 503, '工作輸出超出已核對限制。');
        }
        active.preview += fragment;
        for (const waiter of waiters.get(job.id) ?? []) waiter.delta(fragment);
      };
      active.task = Promise.resolve().then(() => executeAttempt(context, abort, worker)).catch(fault).finally(() => {
        running.delete(job.id);
        schedule();
      });
      running.set(job.id, active);
      slots--;
    }
  }

  function schedule() {
    if (pumpPending || closing || closed || fatal) return;
    pumpPending = true;
    queueMicrotask(() => {
      pumpPending = false;
      try { pump(); } catch (cause) { fault(cause); }
    });
  }

  function submit(request) {
    requireOpen();
    if (mode === 'read-only') throw realInferenceDisabled();
    const { clientId, requestId = randomUUID(), model, kind, input, maxTokens, priority = 0 } = request ?? {};
    if (!token(clientId) || !token(requestId) || !modelId(model) || !['chat', 'completion'].includes(kind) ||
        typeof input !== 'string' || !input.trim() || Buffer.byteLength(input) > 32768 ||
        !Number.isInteger(priority) || priority < -10 || priority > 10)
      throw error('INVALID_REQUEST', 400, '工作輸入、識別碼或優先順序無效。');
    const requested = maxTokens ?? null;
    if (requested !== null && (!Number.isInteger(requested) || requested < 1))
      throw error('INVALID_REQUEST', 400, '最大生成長度無效。');
    const existing = findRequest.get(clientId, requestId);
    if (existing) {
      const previous = readJob(existing.id);
      if (existing.signature !== hash([model, kind, input, requested ?? previous.maxTokens, priority]))
        throw error('IDEMPOTENCY_CONFLICT', 409, '同一請求識別碼已對應另一個工作內容。');
      return previous;
    }
    if (allUsed()) throw realInferenceDisabled();
    const entry = catalog.get(model);
    if (!entry) throw error('MODEL_NOT_FOUND', 404, '找不到指定模型。');
    const limit = requested ?? Math.min(64, entry.maxTokens);
    if (limit > entry.maxTokens || tokenCount(input) + limit > entry.context)
      throw error('MODEL_LIMIT_EXCEEDED', 400, '請求超過模型的輸出或上下文限制。');
    const candidate = profiles.find(node => eligible(node, entry));
    if (!candidate)
      throw error('MODEL_UNAVAILABLE', 503, '沒有符合指定模型與資源需求的節點。');
    // 預先固定其中一份簽署資格。等候或失聯時，排程器不可把這個工作轉給另一端。
    const worker = workerByNode.get(candidate.id);
    const holdBudget = reservations.all().filter(lock => lock.phase === 'HOLD').length;
    const decisionCode = holdBudget >= maxConcurrent ? 'WAITING_FOR_HOLD' : 'QUEUED';
    const job = { id: randomUUID(), clientId, model, kind, source, state: 'QUEUED', nodeId: null, resource: null,
      ...(worker ? {admissionId:worker.claim.id,workerPin:worker.pin} : {}),
      digest: entry.digest, device: entry.device, priority, maxTokens: limit, createdAt: Date.now(),
      startedAt: null, finishedAt: null, attemptId: null, durationMs: null, usage: null,
      decision: { code: decisionCode, priority, device: entry.device }, error: null, cleanup: { confirmed: false, reason: 'PENDING' } };
    transaction(() => {
      if (db.prepare("SELECT count(*) AS count FROM jobs WHERE state='QUEUED'").get().count >= 128)
        throw error('QUEUE_FULL', 429, '工作佇列已滿。');
      insertJob.run(job.id, clientId, requestId, hash([model, kind, input, limit, priority]), input, JSON.stringify(job));
      event(job, 'QUEUED', { model, priority });
    });
    if (worker) used.add(worker.pin);
    schedule();
    return structuredClone(job);
  }

  function cancel(id) {
    requireOpen();
    const job = readJob(id);
    if (finished(job) || job.state === 'STOPPING') return job;
    if (mode === 'read-only') throw realInferenceDisabled();
    const next = transaction(() => {
      if (job.state === 'QUEUED') return stopBeforeRun(job, 'CANCELLED');
      const stopping = { ...job, state: 'STOPPING' };
      write(stopping, read.get(id).input);
      event(stopping, 'CANCEL_REQUESTED', { reason: 'CANCELLED' });
      return stopping;
    });
    if (finished(next)) notify(next);
    else running.get(id)?.abort.abort(errorDetail('CANCELLED'));
    return next;
  }

  function wait(id, { signal, onDelta } = {}) {
    requireOpen();
    if (signal?.aborted) return Promise.reject(signal.reason);
    const job = readJob(id);
    if (finished(job)) return Promise.resolve(job);
    return new Promise((resolveJob, rejectJob) => {
      const pending = waiters.get(id) ?? new Set();
      function remove() {
        signal?.removeEventListener('abort', onAbort);
        pending.delete(waiter);
        if (!pending.size) waiters.delete(id);
      }
      const waiter = {
        finish(next) { remove(); resolveJob(structuredClone(next)); },
        reject(cause) { remove(); rejectJob(cause); },
        delta(fragment) {
          try { onDelta?.(fragment); }
          catch (cause) { waiter.reject(cause); }
        },
      };
      function onAbort() { waiter.reject(signal.reason); }
      pending.add(waiter);
      waiters.set(id, pending);
      signal?.addEventListener('abort', onAbort, { once: true });
      const preview = running.get(id)?.preview;
      if (preview) waiter.delta(preview);
    });
  }

  function nodes() {
    requireOpen();
    const locks = reservations.all();
    return profiles.map(node => {
      const claims = new Set([node.resource, ...node.aliases]);
      const lock = locks.find(row => claims.has(row.resource) || aliases(row.resource).some(alias => claims.has(alias)));
      const worker = qualified ? workerByNode.get(node.id) : simulator;
      const activeModel = lock?.phase === 'INTENT' ? catalog.get(worker.resident(node.resource)) : null;
      const metrics = node.metrics && lock?.phase !== 'HOLD' ? { ...node.metrics } : null;
      if (metrics?.source === 'SIMULATION' && activeModel?.device === 'gpu') {
        metrics.gpuPercent = 45;
        metrics.gpuUsedBytes += activeModel.gpuBytes;
      }
      return structuredClone({ ...node, metrics, resident: [...new Set([...node.resident, activeModel?.id].filter(Boolean))],
        availability: lock?.phase === 'HOLD' ? 'HOLD' : lock ? 'BUSY' : node.status === 'SIMULATED' ? 'READY' : node.status });
    });
  }

  function snapshot() {
    requireOpen();
    return {
      nodes: nodes(),
      jobs: db.prepare("SELECT data FROM jobs ORDER BY (state IN ('QUEUED','RUNNING','STOPPING')) DESC,seq DESC LIMIT 200")
        .all().map(row => JSON.parse(row.data)),
      locks: reservations.all().map(row => ({ resource: row.resource, jobId: row.job_id, attemptId: row.attempt_id,
        nodeId: row.node_id, phase: row.phase, aliases: aliases(row.resource) })),
      events: db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT 200').all().reverse().map(row =>
        ({ seq: row.seq, jobId: row.job_id, attemptId: row.attempt_id, nodeId: row.node_id, event: row.event,
          at: row.at, detail: JSON.parse(row.detail) })),
    };
  }

  function close() {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      try {
        if (!fatal) {
          const interrupted = transaction(() => queue.all().map(row => stopBeforeRun(JSON.parse(row.data), 'CONTROLLER_STOPPED')));
          for (const job of interrupted) notify(job);
        }
      } catch (cause) {
        fault(cause);
        throw fatal;
      } finally {
        const entries = [...running.values()];
        for (const entry of entries) entry.abort.abort(errorDetail('CONTROLLER_STOPPED'));
        await Promise.all(entries.map(entry => entry.task));
        closed = true;
        db.close();
      }
    });
    return closing;
  }

  return Object.freeze({ submit, cancel, wait, nodes, snapshot, close,
    get(id) { requireOpen(); return readJob(id); },
    models({ eligibleOnly = false } = {}) {
      requireOpen();
      return [...catalog.values()]
        .filter(model => !eligibleOnly || profiles.some(node => eligible(node, model)))
        .sort((a, b) => order(a.id, b.id)).map(model => structuredClone(model));
    },
  });
}
