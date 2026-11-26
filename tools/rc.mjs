import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDENTIFIER, SHA256, TOKEN_SCOPES, validateConfig, validateNode, validateTokens } from './config.mjs';
import { digest, readJson, replaceJson, snapshotFile, writeNewJson } from './files.mjs';
import { absoluteLocalPath, acquireInstallationLock, acquireRecoveryLock, assertPinned, assertPrivateInstallation,
  containedIn, createPrivateRoot, fileIdentity, installationStorageScope, lockFileName, pinPath, recoveryLockName } from './lock.mjs';
import { installationId, marker, verifyInstallationManifest, writeInstallationManifest } from './manifest.mjs';
import { FILE_LIMIT, inspectDatabases, inventoryData, storageSealName } from './storage.mjs';

const productRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureRoot = join(productRoot, 'tools', 'fixtures', 'work');
const backupMarker = 'backup-manifest.json';
const retiredConfig = 'retired-config.json';
const archivedLockName = 'stale-lock.json';
const installationFiles = ['config.json', 'tokens.json', 'data', marker];
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function localTarget(input) {
  const path = absoluteLocalPath(input);
  if (containedIn(productRoot, path) && !containedIn(fixtureRoot, path)) throw new Error('PRODUCT_SOURCE_IS_NOT_INSTALL_STORAGE');
  return path;
}

function exists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}

function assertEntries(root, allowed, required = allowed) {
  const names = readdirSync(pinPath(root, 'directory').path);
  if (names.some(name => !allowed.includes(name))) throw new Error('UNKNOWN_INSTALLATION_ENTRY');
  if (required.some(name => !names.includes(name))) throw new Error('INCOMPLETE_INSTALLATION');
}

function initStorage(path, directories) {
  const root = createPrivateRoot(localTarget(path));
  for (const folder of directories) mkdirSync(join(root, folder), { mode: 0o700 });
  assertPrivateInstallation(root, directories.map(folder => join(root, folder)));
  return root;
}

function newDestination(source, input) {
  const path = localTarget(input);
  if (containedIn(source, path)) throw new Error('DESTINATION_INSIDE_SOURCE');
  return path;
}

function writeInstall(root, config, tokens) {
  validateConfig(config);
  validateTokens(tokens);
  writeNewJson(join(root, 'tokens.json'), tokens);
  writeInstallationManifest(root);
  // 最後才放入人工作業啟動入口，避免讀到未完整建立的資料。
  writeNewJson(join(root, 'config.json'), config);
  return { status: 'INSTALLED', mode: config.mode, activeTokens: tokens.tokens.length, started: false,
    storagePolicy: installationStorageScope(root) };
}

function setup(path, flags) {
  const options = new Set(flags);
  if (options.size !== flags.length || flags.some(flag => !['--simulation', '--monitor-local'].includes(flag))) {
    throw new Error('USAGE');
  }
  const monitor = options.has('--monitor-local');
  if (monitor && process.platform !== 'win32') throw new Error('WINDOWS_MONITOR_PLATFORM_UNSUPPORTED');
  const config = {
    version: 1, mode: options.has('--simulation') ? 'simulation' : 'read-only', port: 8787,
    dataDir: './data', tokenFile: './tokens.json', nodes: [], maxConcurrent: 2,
    ...(monitor ? { monitoring: { windowsLocal: true } } : {}),
  };
  return writeInstall(initStorage(path, ['data']), config, { version: 1, tokens: [] });
}

function protectedRoot(path, additional = []) {
  const root = localTarget(path);
  const rootPin = pinPath(root, 'directory');
  assertPrivateInstallation(root, [...installationFiles, ...additional].map(name => join(root, name)));
  assertPinned(rootPin);
  return rootPin;
}

function readInstallation(rootPin, additional) {
  assertPinned(rootPin);
  const root = rootPin.path;
  const required=[...installationFiles,...additional];
  assertEntries(root,[...required,storageSealName],required);
  const manifest = verifyInstallationManifest(root);
  const config = readJson(join(root, 'config.json'));
  const tokens = readJson(join(root, 'tokens.json'));
  validateConfig(config.value);
  validateTokens(tokens.value);
  assertPinned(rootPin);
  return { root, rootPin, manifest, config, tokens };
}

async function useInstallation(path, operation) {
  const rootPin = protectedRoot(path);
  const release = acquireInstallationLock(join(rootPin.path, 'config.json'));
  try {
    return await operation(readInstallation(rootPin, [lockFileName]));
  } finally {
    release();
  }
}

function tokenChange(installation, operation, id, scopes, ttlValue) {
  if (!IDENTIFIER.test(id ?? '')) throw new Error('INVALID_TOKEN_ID');
  const registry = installation.tokens.value;
  const active = registry.tokens.find(row => row.id.toLowerCase() === id.toLowerCase());
  const retired = registry.revokedIds ?? [];
  if (operation === 'issue' && (active || retired.some(old => old.toLowerCase() === id.toLowerCase()))) {
    throw new Error('TOKEN_ID_ALREADY_ASSIGNED');
  }
  if (operation !== 'issue' && !active) throw new Error('TOKEN_ID_UNKNOWN');
  const remaining = registry.tokens.filter(row => row !== active);
  if (operation === 'revoke') {
    const update = validateTokens({ version: 1, tokens: remaining, revokedIds: [...retired, active.id] });
    replaceJson(installation.tokens, update);
    return { status: 'REVOKED' };
  }
  const tokenScopes = operation === 'rotate' ? active.scopes : scopes?.split(',');
  if (!tokenScopes?.length || new Set(tokenScopes).size !== tokenScopes.length ||
      tokenScopes.some(scope => !TOKEN_SCOPES.includes(scope))) throw new Error('INVALID_TOKEN_SCOPES');
  const ttl = ttlValue === undefined ? 24 : Number(ttlValue);
  if ((ttlValue !== undefined && !/^\d{1,3}$/u.test(ttlValue)) || !Number.isInteger(ttl) || ttl < 1 || ttl > 720) {
    throw new Error('INVALID_TOKEN_LIFETIME');
  }
  const token = randomBytes(32).toString('base64url');
  const record = { id: active?.id ?? id, sha256: digest(token), scopes: tokenScopes, expiresAt: Date.now() + ttl * 3_600_000 };
  const update = validateTokens({ version: 1, tokens: [...remaining, record], revokedIds: retired });
  replaceJson(installation.tokens, update);
  return { status: operation === 'rotate' ? 'ROTATED' : 'ISSUED', id: record.id, token, scopes: tokenScopes, expiresAt: record.expiresAt };
}

function inventory(installation) {
  const layout = inventoryData(installation.root);
  return { ...layout, files: ['config.json', ...layout.files, 'tokens.json'] };
}

function capture(root, paths, output) {
  return paths.map(relative => {
    const source = join(root, relative);
    const { bytes, sha256 } = snapshotFile(source, FILE_LIMIT, output ? join(output, relative) : undefined);
    if (relative.startsWith('data/assets/') && relative.slice(-70, -6) !== sha256) throw new Error('ASSET_DIGEST_MISMATCH');
    return { path: relative, bytes, sha256 };
  });
}

async function backup(installation, output, staleLock) {
  const target = newDestination(installation.root, output);
  const layout = inventory(installation);
  const root = initStorage(target, layout.directories);
  const files = capture(installation.root, layout.files, root);
  if (staleLock) {
    assertPinned(staleLock.pin);
    const archived = snapshotFile(staleLock.pin.path, 1_048_576, join(root, archivedLockName));
    if (archived.sha256 !== staleLock.sha256) throw new Error('LOCK_CONTENT_CHANGED');
  }
  const sqlite = await inspectDatabases(root, layout.files);
  if (!sameJson(inventory(installation), layout) || !sameJson(capture(installation.root, layout.files), files) ||
      !sameJson(capture(root, layout.files), files)) throw new Error('BACKUP_SNAPSHOT_CHANGED');
  writeNewJson(join(root, backupMarker), {
    version: 1, kind: 'ACM_OFFLINE_BACKUP', sourceInstallId: installation.manifest.value.id,
    directories: layout.directories, files, sqlite,
    ...(staleLock ? { staleLockSha256: staleLock.sha256 } : {}),
  });
  return { status: 'BACKED_UP', fileCount: files.length, sqlite };
}

async function readBackup(input) {
  const root = localTarget(input);
  const paths = [backupMarker, 'config.json', 'tokens.json', 'data'];
  if (exists(join(root, archivedLockName))) paths.push(archivedLockName);
  if (exists(join(root,storageSealName))) paths.push(storageSealName);
  assertPrivateInstallation(root, paths.map(name => join(root, name)));
  assertEntries(root, paths);
  const manifest = readJson(join(root, backupMarker)).value;
  if (!manifest || manifest.version !== 1 || manifest.kind !== 'ACM_OFFLINE_BACKUP' || !installationId.test(manifest.sourceInstallId)) {
    throw new Error('BACKUP_MANIFEST_INVALID');
  }
  if (paths.includes(archivedLockName) !== Object.hasOwn(manifest, 'staleLockSha256') ||
      (paths.includes(archivedLockName) && snapshotFile(join(root, archivedLockName), 1_048_576).sha256 !== manifest.staleLockSha256)) {
    throw new Error('BACKUP_STALE_LOCK_HASH_MISMATCH');
  }
  const layout = inventory({ root });
  const all = capture(root, layout.files);
  if (!sameJson(layout.directories, manifest.directories) || !sameJson(all, manifest.files)) throw new Error('BACKUP_HASH_MISMATCH');
  const config = readJson(join(root, 'config.json'));
  const tokens = readJson(join(root, 'tokens.json'));
  validateConfig(config.value);
  validateTokens(tokens.value);
  const sqlite = await inspectDatabases(root, layout.files);
  if (!sameJson(sqlite, manifest.sqlite) || !sameJson(capture(root, layout.files), all)) {
    throw new Error('BACKUP_STORAGE_VALIDATION_FAILED');
  }
  return { root, manifest, layout, config, tokens };
}

async function restore(input, output) {
  const target = newDestination(localTarget(input), output);
  return restoreFrom(await readBackup(input), target);
}

async function restoreFrom(source, target) {
  const archived = source.tokens.value;
  const registry = validateTokens({ version: 1, tokens: [], revokedIds: [
    ...(archived.revokedIds ?? []), ...archived.tokens.map(row => row.id),
  ] });
  const runtimeFile = name => name.startsWith('data/') || name === storageSealName;
  const files = source.layout.files.filter(runtimeFile);
  const root = initStorage(target, source.layout.directories);
  const expected = source.manifest.files.filter(entry => runtimeFile(entry.path));
  if (!sameJson(capture(source.root, files, root), expected) || !sameJson(capture(root, files), expected) ||
      !sameJson(await inspectDatabases(root, files), source.manifest.sqlite)) throw new Error('RESTORE_SNAPSHOT_CHANGED');
  writeInstall(root, source.config.value, registry);
  return { status: 'RESTORED_OFFLINE', activeTokens: 0, fileCount: files.length, sqlite: source.manifest.sqlite,
    storagePolicy: installationStorageScope(root) };
}

async function upgrade(installation, backupPath, destination) {
  const archive = newDestination(installation.root, backupPath);
  const target = newDestination(installation.root, destination);
  if (containedIn(archive, target) || containedIn(target, archive)) throw new Error('UPGRADE_DESTINATIONS_OVERLAP');
  if (exists(archive) || exists(target)) throw new Error('UPGRADE_DESTINATION_EXISTS');
  await backup(installation, archive);
  const result = await restore(archive, target);
  return { ...result, status: 'UPGRADE_STAGED_OFFLINE', sourceRetained: true, started: false };
}

async function checkMigration(installation) {
  const layout = inventory(installation);
  const before = capture(installation.root, layout.files);
  const sqlite = await inspectDatabases(installation.root, layout.files);
  if (!sameJson(capture(installation.root, layout.files), before)) throw new Error('MIGRATION_SNAPSHOT_CHANGED');
  return { status: 'SCHEMA_COMPATIBLE', mode: installation.config.value.mode, sqlite,
    storagePolicy: installationStorageScope(installation.root) };
}

async function checkRollback(installation, source) {
  if (source.manifest.sourceInstallId !== installation.manifest.value.id) throw new Error('BACKUP_LINEAGE_MISMATCH');
  const current = await checkMigration(installation);
  const equal = sameJson(capture(installation.root, inventory(installation).files), source.manifest.files);
  return { status: equal ? 'IDENTICAL_SNAPSHOT' : 'DIVERGED_KEEP_CURRENT',
    inPlaceAllowed: false, currentSQLite: current.sqlite, backupSQLite: source.manifest.sqlite };
}

async function stageRollback(installation, input, output) {
  const target = newDestination(installation.root, output);
  const source = await readBackup(input);
  newDestination(source.root, target);
  const lineage = await checkRollback(installation, source);
  if (lineage.status === 'DIVERGED_KEEP_CURRENT') return lineage;
  // 沿用鎖內核對過的備份，避免再次解析路徑時更換來源。
  return restoreFrom(source, target);
}

function uninstall(installation, apply) {
  const { root, rootPin, manifest, config, tokens } = installation;
  inventory(installation);
  const result = { status: apply ? 'RETIRED' : 'UNINSTALL_PLAN',
    retain: ['data', 'tokens.json', marker, retiredConfig, ...(exists(join(root,storageSealName))?[storageSealName]:[])],
    retire: ['config.json'] };
  if (!apply) return result;
  const retired = join(root, retiredConfig);
  const captured = snapshotFile(config.pin.path, 1_048_576, retired);
  if (captured.sha256 !== config.sha256) throw new Error('CONFIG_CHANGED_DURING_UNINSTALL');
  for (const pin of [rootPin, manifest.pin, config.pin, tokens.pin]) assertPinned(pin);
  if (snapshotFile(config.pin.path, 1_048_576).sha256 !== config.sha256 ||
      snapshotFile(retired, 1_048_576).sha256 !== config.sha256) throw new Error('CONFIG_CHANGED_DURING_UNINSTALL');
  unlinkSync(config.pin.path);
  return result;
}

function boundLock(installation) {
  const lock = readJson(join(installation.root, lockFileName));
  const record = lock.value;
  const identity = installation.manifest.value;
  if (!record || Object.keys(record).length !== 8 || record.version !== 1 || record.kind !== 'INSTALLATION' ||
      !Number.isInteger(record.pid) || record.pid <= 0 || record.pid > 0x7fffffff ||
      record.rootIdentity !== identity.rootIdentity || record.dataIdentity !== identity.dataIdentity ||
      record.configIdentity !== fileIdentity(installation.config.pin.id) ||
      record.manifestIdentity !== identity.manifestIdentity || record.lockIdentity !== fileIdentity(lock.pin.id)) {
    throw new Error('LOCK_IDENTITY_UNVERIFIED');
  }
  return lock;
}

function ownerExited(pid) {
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return true; }
  return false;
}

function lockStatus(path) {
  const initial = pinPath(localTarget(path), 'directory');
  const root = initial.path;
  if (exists(join(root, recoveryLockName))) throw new Error('RECOVERY_LOCK_PRESENT');
  const hasLock = exists(join(root, lockFileName));
  const additional = hasLock ? [lockFileName] : [];
  const checked = protectedRoot(root, additional);
  assertPinned(initial);
  const installation = readInstallation(checked, additional);
  if (!hasLock) return { status: 'NO_LOCK' };
  const record = boundLock(installation);
  return { status: ownerExited(record.value.pid) ? 'OWNER_EXITED_BACKUP_REQUIRED' : 'OWNER_ACTIVE_OR_UNKNOWN',
    sha256: record.sha256 };
}

async function recoverLock(path, expected, output) {
  if (!SHA256.test(expected ?? '')) throw new Error('EXPECTED_LOCK_SHA256_REQUIRED');
  const rootPin = protectedRoot(path, [lockFileName]);
  const target = newDestination(rootPin.path, output);
  const release = acquireRecoveryLock(join(rootPin.path, 'config.json'));
  try {
    const installation = readInstallation(rootPin, [lockFileName, recoveryLockName]);
    const record = boundLock(installation);
    if (record.sha256 !== expected) throw new Error('LOCK_DIGEST_MISMATCH');
    if (!ownerExited(record.value.pid)) throw new Error('LOCK_OWNER_ACTIVE_OR_UNKNOWN');
    await backup(installation, target, record);
    const verified = await readBackup(target);
    if (verified.manifest.staleLockSha256 !== expected) throw new Error('BACKUP_STALE_LOCK_HASH_MISMATCH');
    const refreshed = readInstallation(rootPin, [lockFileName, recoveryLockName]);
    const again = boundLock(refreshed);
    if (again.sha256 !== expected || !ownerExited(again.value.pid) ||
        !sameJson(capture(refreshed.root, inventory(refreshed).files), verified.manifest.files)) {
      throw new Error('LOCK_RECOVERY_SOURCE_CHANGED');
    }
    // 全量封存確認後，才針對原先同個鎖物件釋放入口。
    assertPinned(record.pin);
    assertPinned(refreshed.rootPin);
    if (!ownerExited(record.value.pid)) throw new Error('LOCK_OWNER_ACTIVE_OR_UNKNOWN');
    unlinkSync(record.pin.path);
    return { status: 'STALE_LOCK_ARCHIVED', sha256: expected, dataPreserved: true, started: false };
  } finally {
    release();
  }
}

function enroll(installation, input) {
  const node = validateNode(readJson(input).value);
  if (node.status !== 'UNVERIFIED' || (node.metrics !== undefined && node.metrics !== null)) {
    throw new Error('ENROLLMENT_REQUIRES_UNVERIFIED_STATUS');
  }
  const config = validateConfig({ ...installation.config.value, nodes: [...installation.config.value.nodes, node] });
  replaceJson(installation.config, config);
  return { status: 'ENROLLED_UNVERIFIED', mode: config.mode, realDispatch: 'HOLD' };
}

function importAsset(installation, input, expected) {
  if (!SHA256.test(expected ?? '')) throw new Error('ASSET_SHA256_REQUIRED');
  inventory(installation);
  const inputFile = absoluteLocalPath(input);
  if (snapshotFile(inputFile, FILE_LIMIT).sha256 !== expected) throw new Error('ASSET_DIGEST_MISMATCH');
  const folder = join(installation.root, 'data', 'assets');
  if (!exists(folder)) mkdirSync(folder, { mode: 0o700 });
  const output = join(folder, expected + '.asset');
  if (exists(output)) {
    if (snapshotFile(output, FILE_LIMIT).sha256 !== expected) throw new Error('ASSET_DIGEST_MISMATCH');
    return { status: 'ALREADY_PINNED', sha256: expected };
  }
  if (readdirSync(folder).length >= 64) throw new Error('ASSET_COUNT_LIMIT');
  const copy = snapshotFile(inputFile, FILE_LIMIT, output);
  const copied = snapshotFile(output, FILE_LIMIT);
  if (copy.sha256 !== expected || copied.sha256 !== expected) {
    assertPinned(copied.pin);
    unlinkSync(output);
    throw new Error('ASSET_DIGEST_MISMATCH');
  }
  return { status: 'ASSET_PINNED', sha256: expected, bytes: copied.bytes };
}

function agentPlan() {
  return {
    status: 'PLAN_ONLY', transport: 'LOCAL_MANUAL', realDispatch: 'HOLD',
    account: 'UNPRIVILEGED_LOCAL_USER', platform: 'Linux/aarch64',
    preflight: [
      { argv: ['uname', '-s'], expected: 'Linux' },
      { argv: ['uname', '-m'], expected: 'aarch64' },
      { argv: ['id', '-u'], expected: 'nonzero' },
      { argv: ['node', '--version'], expected: '>=24.22.3 <25' },
      { argv: ['sha256sum', 'acm-v1-install.tar'], expected: 'match the independently retained release hash' },
    ],
    nextGate: 'SEPARATE_AGENT_AUTHENTICATION_AND_HARDWARE_QUALIFICATION',
  };
}

const usage = [
  'setup <new-dir> [--simulation] [--monitor-local]', 'doctor <dir>',
  'token issue <dir> <id> <scope[,scope...]> [ttl-hours]',
  'token rotate <dir> <id> [ttl-hours]', 'token revoke <dir> <id>',
  'backup <dir> <new-backup-dir>', 'restore <backup-dir> <new-dir>',
  'upgrade <dir> <new-backup-dir> <new-install-dir>',
  'migration-check <dir>', 'rollback-check <dir> <backup-dir>',
  'rollback-stage <dir> <backup-dir> <new-dir>',
  'lock-status <dir>', 'recover-lock <dir> <expected-lock-sha256> <new-backup-dir>',
  'uninstall <dir> [--apply]', 'node list <dir>', 'node enroll <dir> <descriptor.json>',
  'asset import <dir> <file> <sha256>', 'agent-plan',
];

function main(args) {
  const [command, path, option, ...extra] = args;
  if (command === '--help' && args.length === 1) return { usage, paths: 'Absolute local paths only' };
  if (command === 'agent-plan' && args.length === 1) return agentPlan();
  if (command === 'setup' && args.length >= 2 && args.length <= 4) return setup(path, args.slice(2));
  if (command === 'restore' && args.length === 3) return restore(path, option);
  if (command === 'upgrade' && args.length === 4) {
    return useInstallation(path, context => upgrade(context, option, extra[0]));
  }
  if (command === 'lock-status' && args.length === 2) return lockStatus(path);
  if (command === 'recover-lock' && args.length === 4) return recoverLock(path, option, extra[0]);
  if (command === 'token' && option !== undefined) {
    if (path === 'issue' && [5, 6].includes(args.length)) {
      return useInstallation(option, context => tokenChange(context, path, extra[0], extra[1], extra[2]));
    }
    if (path === 'rotate' && [4, 5].includes(args.length)) {
      return useInstallation(option, context => tokenChange(context, path, extra[0], undefined, extra[1]));
    }
    if (path === 'revoke' && args.length === 4) return useInstallation(option, context => tokenChange(context, path, extra[0]));
  }
  if (command === 'node' && path === 'list' && args.length === 3) {
    return useInstallation(option, ({ config }) => ({ status: 'READ_ONLY', nodes: config.value.nodes }));
  }
  if (command === 'node' && path === 'enroll' && args.length === 4) return useInstallation(option, context => enroll(context, extra[0]));
  if (command === 'asset' && path === 'import' && args.length === 5) {
    return useInstallation(option, context => importAsset(context, extra[0], extra[1]));
  }
  if (command === 'backup' && args.length === 3) return useInstallation(path, context => backup(context, option));
  if (command === 'rollback-check' && args.length === 3) {
    return useInstallation(path, async context => checkRollback(context, await readBackup(option)));
  }
  if (command === 'rollback-stage' && args.length === 4) {
    return useInstallation(path, context => stageRollback(context, option, extra[0]));
  }
  if (command === 'migration-check' && args.length === 2) return useInstallation(path, checkMigration);
  if (command === 'doctor' && args.length === 2) return useInstallation(path, async context => ({
    ...await checkMigration(context), status: 'READY_OFFLINE', activeTokens: context.tokens.value.tokens.filter(row => row.expiresAt > Date.now()).length,
  }));
  if (command === 'uninstall' && (args.length === 2 || (args.length === 3 && option === '--apply'))) {
    return useInstallation(path, context => uninstall(context, option === '--apply'));
  }
  throw new Error('USAGE');
}

try {
  console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
} catch (error) {
  const safe = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/u.test(value);
  const code = safe(error.message) ? error.message : safe(error.code) ? error.code : 'LOCAL_MAINTENANCE_FAILED';
  console.error(JSON.stringify(code === 'USAGE' ? { status: 'REFUSED', code, usage } : { status: 'REFUSED', code }));
  process.exitCode = 1;
}
