import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertPinned, assertPrivateInstallation, pinPath } from './lock.mjs';
import { digest, jsonBytes, readJson, snapshotFile, writeNewJson } from './files.mjs';

export const FILE_LIMIT = 8 * 1024 ** 3;
const databases = ['controller.sqlite', 'telemetry.sqlite'];
export const storageSealName = 'storage-seal.json';
const storageSeal = Object.freeze({version:1,kind:'ACM_INITIALIZED_STORES'});
const sqliteNames = databases.flatMap(file => [file, file + '-wal', file + '-shm', file + '-journal']);
const dataFiles = [...sqliteNames, 'legacy-history.json'];
const assetName = /^[a-f0-9]{64}\.asset$/u;
const controllerTables = {
  jobs: 'seq,id,client_id,request_id,signature,input,data,state,priority',
  reservations: 'resource,job_id,attempt_id,node_id,phase,binding',
  reservation_aliases: 'alias,resource',
  events: 'seq,job_id,attempt_id,node_id,event,at,detail',
  worker_identity: 'resource,epoch,private_key,public_key',
  worker_events: 'seq,attempt_id,state,document,signature',
};
const telemetryTables = { telemetry_samples: 'node,sampled,observed,data' };
const observationHead = ['telemetry_heads', 'node,fingerprint,sequence,sampled'];

export function writeStorageSeal(root) {
  return writeNewJson(join(root,storageSealName),storageSeal);
}

export function inventoryData(root) {
  const dataPath = join(root, 'data');
  const names = readdirSync(pinPath(dataPath, 'directory').path);
  const hasAssets = names.includes('assets');
  const sealed = readdirSync(root).includes(storageSealName);
  if (sealed && !databases.every(name=>names.includes(name))) throw Error('INITIALIZED_STORE_MISSING');
  if (names.some(name => name !== 'assets' && !dataFiles.includes(name))) throw new Error('UNKNOWN_DATA_ENTRY');
  for (const db of databases) {
    if (!names.includes(db) && names.some(name => name.startsWith(db + '-'))) throw new Error('ORPHANED_SQLITE_SIDECAR');
  }
  if (names.includes('telemetry.sqlite') && !names.includes('controller.sqlite')) throw new Error('CONTROLLER_DATABASE_MISSING');
  const files = names.filter(name => name !== 'assets').map(name => 'data/' + name);
  if (sealed) {
    const {value}=readJson(join(root,storageSealName));
    if (value?.version!==storageSeal.version||value.kind!==storageSeal.kind||Object.keys(value).length!==2)
      throw Error('STORAGE_SEAL_INVALID');
    files.push(storageSealName);
  }
  const directories = ['data'];
  if (hasAssets) {
    const assets = pinPath(join(dataPath, 'assets'), 'directory');
    const entries = readdirSync(assets.path);
    if (entries.length > 64 || entries.some(name => !assetName.test(name))) throw new Error('UNKNOWN_ASSET_ENTRY');
    files.push(...entries.map(name => 'data/assets/' + name));
    directories.push('data/assets');
  }
  const all = [...directories, ...files].map(name => join(root, name));
  for (const name of files) pinPath(join(root, name), 'file');
  assertPrivateInstallation(root, process.platform === 'win32' ? all : [...directories,...(sealed?[storageSealName]:[])].map(name => join(root, name)));
  return { files: files.sort(), directories };
}

function inspectDatabase(path, controller) {
  const db = new DatabaseSync(path, { allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    const appId = db.prepare('PRAGMA application_id').get().application_id;
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const integrity = db.prepare('PRAGMA quick_check').all();
    if (version !== 1 || appId !== (controller ? 0x41434d31 : 0x41434d54) ||
        integrity.length !== 1 || integrity[0].quick_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').get()) throw new Error('UNSUPPORTED_OR_INVALID_DATABASE');
    const tables = db.prepare('PRAGMA table_list').all().filter(row => row.schema === 'main' && row.name !== 'sqlite_schema');
    // RC1 沒有觀測序號表。只認列出的兩份結構，並在獨立副本開啟驗證。
    const required = controller ? controllerTables : tables.some(row => row.name === observationHead[0])
      ? { ...telemetryTables, [observationHead[0]]: observationHead[1] } : telemetryTables;
    const columns = db.prepare('SELECT name FROM pragma_table_xinfo(?) ORDER BY cid');
    if (tables.length !== Object.keys(required).length || tables.some(row => row.type !== 'table' ||
        row.strict !== 1 || !Object.hasOwn(required, row.name) ||
        columns.all(row.name).map(column => column.name).join(',') !== required[row.name])) {
      throw new Error('UNSUPPORTED_DATABASE_SCHEMA');
    }
    if (!controller) return { version, integrity: 'ok' };
    const reservations = db.prepare(
      'SELECT resource,job_id,attempt_id,node_id,phase FROM reservations ORDER BY resource'
    ).all();
    const aliases = db.prepare('SELECT alias,resource FROM reservation_aliases ORDER BY alias').all();
    if (reservations.some(row => !['HOLD', 'INTENT'].includes(row.phase)) ||
        aliases.some(row => !reservations.some(entry => entry.resource === row.resource))) {
      throw new Error('INVALID_RESERVATION_STATE');
    }
    return {
      version, integrity: 'ok', reservations: reservations.length,
      holds: reservations.filter(row => row.phase === 'HOLD').length,
      reservationSha256: digest(jsonBytes({ reservations, aliases })),
    };
  } finally {
    db.close();
  }
}

async function checkProductReopen(scratch, result) {
  if (result.controller) {
    const { openController } = await import('../src/controller.mjs');
    const controller = openController({ dataDir: scratch, mode: 'read-only' });
    try {
      const locks = controller.snapshot().locks;
      if (locks.length !== result.controller.reservations || locks.some(lock => lock.phase !== 'HOLD')) {
        throw new Error('SQLITE_RECOVERY_LOST_RESERVATION');
      }
    } finally {
      await controller.close();
    }
  }
  if (result.telemetry) {
    const { openTelemetry } = await import('../src/telemetry.mjs');
    const telemetry = openTelemetry(scratch);
    try { telemetry.history({ limit: 1 }); }
    finally { telemetry.close(); }
  }
}

export async function inspectDatabases(root, files) {
  const selected = files.filter(file => sqliteNames.includes(file.slice('data/'.length)));
  const result = { controller: null, telemetry: null };
  if (selected.length === 0) return result;
  const scratch = pinPath(mkdtempSync(join(root, '.sqlite-check-')), 'directory');
  try {
    // SQLite 只可復原或 checkpoint 工作副本，原始 WAL 和 SHM 保持逐位元不變。
    for (const entry of selected) snapshotFile(join(root, entry), FILE_LIMIT, join(scratch.path, entry.slice('data/'.length)));
    for (const [index, name] of databases.entries()) {
      if (selected.includes('data/' + name)) {
        result[index === 0 ? 'controller' : 'telemetry'] = inspectDatabase(join(scratch.path, name), index === 0);
      }
    }
    await checkProductReopen(scratch.path, result);
    return result;
  } finally {
    assertPinned(scratch);
    const entries = readdirSync(scratch.path);
    if (entries.some(name => !sqliteNames.includes(name))) throw new Error('UNKNOWN_SQLITE_SCRATCH_ENTRY');
    const records = entries.map(name => pinPath(join(scratch.path, name), 'file'));
    for (const entry of records) {
      assertPinned(entry);
      unlinkSync(entry.path);
    }
    assertPinned(scratch);
    rmdirSync(scratch.path);
  }
}
