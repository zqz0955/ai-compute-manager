import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWorkspaceFixture } from '../tools/fixtures/workspace-fixture.mjs';
import { acquireInstallationLock, assertPinned, assertPrivateInstallation, createPrivateRoot, installationStorageScope, pinPath } from '../tools/lock.mjs';

const cli = fileURLToPath(new URL('../tools/rc.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stateFiles = ['config.json', 'tokens.json', 'install-manifest.json', 'maintenance.lock',
  'maintenance.recovery-lock', 'retired-config.json'];

function invoke(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true, timeout: 70_000 });
}

function command(...args) {
  const result = invoke(...args);
  assert.equal(result.status, 0, result.stderr || result.error?.code);
  return JSON.parse(result.stdout);
}

function denied(code, ...args) {
  const result = invoke(...args);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).code, code);
}

async function recordDirectories(fixture, ...paths) {
  for (const path of paths) if (existsSync(path)) await fixture.recordDirectory(path);
}

async function install(t, { data = [], other = [], simulation = false } = {}) {
  const fixture = await createWorkspaceFixture('jcm-acm-ops-', [
    ...stateFiles.map(name => join('install', name)),
    ...data.map(name => join('install', 'data', name)),
    ...other,
  ]);
  t.after(() => fixture.clean());
  const path = join(fixture.root, 'install');
  const result = command('setup', path, ...simulation ? ['--simulation'] : []);
  await recordDirectories(fixture, path, join(path, 'data'));
  return { fixture, path, result };
}

test('Windows 本機監控安裝旗標寫入明確設定，其他平台拒絕配置', async t => {
  const fixture = await createWorkspaceFixture('jcm-acm-monitor-', stateFiles.map(name => join('install', name)));
  t.after(() => fixture.clean());
  const path = join(fixture.root, 'install');
  if (process.platform !== 'win32') {
    denied('WINDOWS_MONITOR_PLATFORM_UNSUPPORTED', 'setup', path, '--monitor-local');
    assert.equal(existsSync(path), false);
    return;
  }
  assert.equal(command('setup', path, '--monitor-local').mode, 'read-only');
  await recordDirectories(fixture, path, join(path, 'data'));
  assert.deepEqual(JSON.parse(readFileSync(join(path, 'config.json'), 'utf8')).monitoring, { windowsLocal: true });
});

test('相同安裝同時只能持有一把離線維護鎖', async t => {
  const fixture = await createWorkspaceFixture('jcm-acm-install-', ['maintenance.lock']);
  t.after(() => fixture.clean());
  const config = await fixture.createFile('config.json', '{}');
  const release = acquireInstallationLock(config);
  try {
    assert.throws(() => acquireInstallationLock(config), /INSTALLATION_LOCKED/);
  } finally {
    release();
  }
  const releaseAgain = acquireInstallationLock(config);
  release();
  assert.throws(() => acquireInstallationLock(config), /INSTALLATION_LOCKED/);
  releaseAgain();
});

test('安裝目錄從首次排他建立起即屬受保護的私人目錄', async t => {
  const fixture = await createWorkspaceFixture('jcm-acm-install-', []);
  t.after(() => fixture.clean());
  const root = join(fixture.root, 'install');
  try {
    assert.equal(createPrivateRoot(root), root);
  } finally {
    // 記錄本測試建立的目錄，交由專案工具核對後逐項清理。
    try { await fixture.recordDirectory(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.equal(assertPrivateInstallation(root), root);
  assert.throws(() => createPrivateRoot(root), /PRIVATE_ROOT_CREATE_FAILED|EEXIST/u);
});

test('離線憑證可簽發、同權限輪替、撤銷且保留工作身分；執行鎖或硬連結阻擋修改', async t => {
  const { fixture, path, result } = await install(t);
  assert.deepEqual(result, { status: 'INSTALLED', mode: 'read-only', activeTokens: 0, started: false,
    storagePolicy: installationStorageScope(path) });
  const tokenPath = join(path, 'tokens.json');
  const installedConfig = readFileSync(join(path, 'config.json'));
  assert.notEqual(invoke('setup', path).status, 0);
  assert.deepEqual(readFileSync(join(path, 'config.json')), installedConfig);
  const release = acquireInstallationLock(join(path, 'config.json'));
  try {
    denied('INSTALLATION_LOCKED', 'token', 'issue', path, 'runner', 'models:run');
  } finally {
    release();
  }
  const issued = command('token', 'issue', path, 'runner', 'models:run', '1');
  assert.ok(/^[A-Za-z0-9_-]{43}$/u.test(issued.token));
  const issuedDigest = hash(issued.token);
  const firstRegistry = readFileSync(tokenPath, 'utf8');
  assert.ok(!firstRegistry.includes(issued.token));
  assert.deepEqual(JSON.parse(firstRegistry).tokens[0].scopes, ['models:run']);
  assert.equal(JSON.parse(firstRegistry).tokens[0].sha256, issuedDigest);
  const rotated = command('token', 'rotate', path, 'runner', '1');
  assert.ok(/^[A-Za-z0-9_-]{43}$/u.test(rotated.token));
  assert.notEqual(hash(rotated.token), issuedDigest);
  const afterRotation = JSON.parse(readFileSync(tokenPath, 'utf8'));
  assert.deepEqual(afterRotation.tokens[0].scopes, ['models:run']);
  assert.equal(afterRotation.tokens[0].sha256, hash(rotated.token));
  const alias = join(fixture.root, 'token-hardlink.json');
  const original = pinPath(tokenPath, 'file');
  linkSync(tokenPath, alias);
  try {
    denied('UNSAFE_PHYSICAL_PATH', 'token', 'revoke', path, 'runner');
  } finally {
    const linkInfo = lstatSync(alias, { bigint: true });
    assert.equal(linkInfo.ino, original.id.ino);
    assert.equal(linkInfo.dev, original.id.dev);
    unlinkSync(alias);
  }
  assert.equal(command('token', 'revoke', path, 'runner').status, 'REVOKED');
  denied('TOKEN_ID_ALREADY_ASSIGNED', 'token', 'issue', path, 'RUNNER', 'manage:read');
  assert.deepEqual(JSON.parse(readFileSync(tokenPath, 'utf8')), { version: 1, tokens: [], revokedIds: ['runner'] });
});

test('節點註冊只記未驗證能力、拒身分碰撞；固定雜湊資產與退役保留資料', async t => {
  const contents = 'An optional local asset.\n';
  const digest = hash(contents);
  const { fixture, path } = await install(t, { data: [join('assets', digest + '.asset')] });
  const a = { id: 'node-a', name: '測試節點', resource: 'unit-a', aliases: ['stable-a'], platform: 'jetson',
    status: 'UNVERIFIED', gpu: { state: 'UNKNOWN' }, models: [], resident: [] };
  const descriptor = await fixture.createFile('node-a.json', JSON.stringify(a));
  const collision = await fixture.createFile('node-b.json', JSON.stringify({
    ...a, id: 'node-b', resource: 'unit-b',
  }));
  assert.equal(command('node', 'enroll', path, descriptor).realDispatch, 'HOLD');
  denied('NODE_ALIAS_CONFLICT', 'node', 'enroll', path, collision);
  assert.deepEqual(command('node', 'list', path).nodes, [a]);
  const source = await fixture.createFile('asset.txt', contents);
  denied('ASSET_DIGEST_MISMATCH', 'asset', 'import', path, source, '0'.repeat(64));
  assert.equal(command('asset', 'import', path, source, digest).status, 'ASSET_PINNED');
  await recordDirectories(fixture, join(path, 'data', 'assets'));
  const asset = join(path, 'data', 'assets', digest + '.asset');
  const unknown = await fixture.createFile(join('install', 'data', 'keep.txt'), 'Operator-owned content.');
  const unknownPin = pinPath(unknown, 'file');
  denied('UNKNOWN_DATA_ENTRY', 'uninstall', path, '--apply');
  assert.equal(readFileSync(unknown, 'utf8'), 'Operator-owned content.');
  assertPinned(unknownPin);
  unlinkSync(unknown);
  const config = readFileSync(join(path, 'config.json'));
  assert.equal(command('uninstall', path).status, 'UNINSTALL_PLAN');
  assert.equal(command('uninstall', path, '--apply').status, 'RETIRED');
  assert.equal(existsSync(join(path, 'config.json')), false);
  assert.deepEqual(readFileSync(join(path, 'retired-config.json')), config);
  assert.equal(hash(readFileSync(asset)), digest);
});

test('備份保留 SQLite WAL 中尚未 checkpoint 的 HOLD；還原不重用封存憑證', async t => {
  const dbFiles = ['controller.sqlite', 'telemetry.sqlite']
    .flatMap(name => [name, name + '-wal', name + '-shm', name + '-journal']);
  const backupFiles = ['config.json', 'tokens.json', 'backup-manifest.json', ...dbFiles.map(name => join('data', name))];
  const restoreFiles = [...stateFiles, ...dbFiles.map(name => join('data', name))];
  const { fixture, path, result } = await install(t, {
    simulation: true, data: dbFiles,
    other: [...backupFiles.map(name => join('backup', name)), ...restoreFiles.map(name => join('restored', name)),
      ...backupFiles.map(name => join('upgrade-archive', name)), ...restoreFiles.map(name => join('upgraded', name))],
  });
  assert.equal(result.mode, 'simulation');
  const imports = [
    "import { openController } from " + JSON.stringify(new URL('../src/controller.mjs', import.meta.url).href) + ';',
    "import { openTelemetry } from " + JSON.stringify(new URL('../src/telemetry.mjs', import.meta.url).href) + ';',
    'const dataDir = process.argv[1];',
  ];
  const seed = [
    ...imports,
    "const control = openController({ dataDir, mode: 'simulation', simulation: { beforeRun: () => 'WORKER_DISCONNECTED' } });",
    'const telemetry = openTelemetry(dataDir);',
    'telemetry.record(control.nodes());',
    "const job = control.submit({ clientId: 'fixture', requestId: 'hold', model: 'fixture:demo', kind: 'chat', input: 'Synthetic hold', maxTokens: 8 });",
    "if ((await control.wait(job.id)).state !== 'INTERRUPTED' || telemetry.history().length === 0) process.exit(1);",
    'process.exit(0);',
  ].join('\n');
  const runLocal = (script, dir) => spawnSync(process.execPath, ['--input-type=module', '-e', script, join(dir, 'data')],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  const seeded = runLocal(seed, path);
  assert.equal(seeded.status, 0, seeded.stderr);
  assert.ok(readFileSync(join(path, 'data', 'controller.sqlite-wal')).length > 32);
  const archiveFiles = dbFiles.filter(name => existsSync(join(path, 'data', name)));
  const databaseHashes = root => archiveFiles.map(name => hash(readFileSync(join(root, 'data', name))));
  const hashes = databaseHashes(path);
  assert.equal(command('token', 'issue', path, 'reader', 'manage:read').status, 'ISSUED');
  const backup = join(fixture.root, 'backup');
  denied('DESTINATION_INSIDE_SOURCE', 'backup', path, join(path, 'nested'));
  assert.equal(existsSync(join(path, 'nested')), false);
  const saved = command('backup', path, backup);
  await recordDirectories(fixture, backup, join(backup, 'data'));
  assert.equal(saved.sqlite.controller.holds, 1);
  assert.equal(saved.sqlite.telemetry.integrity, 'ok');
  assert.deepEqual(databaseHashes(path), hashes);
  assert.deepEqual(databaseHashes(backup), hashes);
  assert.equal(command('migration-check', path).sqlite.controller.reservationSha256, saved.sqlite.controller.reservationSha256);
  assert.equal(command('rollback-check', path, backup).status, 'IDENTICAL_SNAPSHOT');
  assert.equal(command('token', 'revoke', path, 'reader').status, 'REVOKED');
  assert.equal(command('rollback-check', path, backup).status, 'DIVERGED_KEEP_CURRENT');
  denied('DESTINATION_INSIDE_SOURCE', 'restore', backup, join(backup, 'nested'));
  assert.equal(existsSync(join(backup, 'nested')), false);
  const restored = join(fixture.root, 'restored');
  const copy = command('restore', backup, restored);
  await recordDirectories(fixture, restored, join(restored, 'data'));
  assert.equal(copy.activeTokens, 0);
  assert.deepEqual(copy.sqlite, saved.sqlite);
  assert.deepEqual(databaseHashes(restored), hashes);
  assert.deepEqual(JSON.parse(readFileSync(join(restored, 'tokens.json'), 'utf8')), { version: 1, tokens: [], revokedIds: ['reader'] });
  const reopened = runLocal([
    ...imports,
    'const controller = openController({ dataDir });',
    'const telemetry = openTelemetry(dataDir);',
    "if (controller.snapshot().locks.filter(lock => lock.phase === 'HOLD').length !== 1 || telemetry.history().length === 0) process.exit(1);",
    'telemetry.close();',
    'await controller.close();',
  ].join('\n'), restored);
  assert.equal(reopened.status, 0, reopened.stderr);
  const upgradeArchive = join(fixture.root, 'upgrade-archive');
  const upgraded = join(fixture.root, 'upgraded');
  denied('UPGRADE_DESTINATIONS_OVERLAP', 'upgrade', path, upgradeArchive, join(upgradeArchive, 'nested'));
  assert.equal(existsSync(upgradeArchive), false);
  denied('UPGRADE_DESTINATION_EXISTS', 'upgrade', path, upgradeArchive, restored);
  assert.equal(existsSync(upgradeArchive), false);
  const staged = command('upgrade', path, upgradeArchive, upgraded);
  await recordDirectories(fixture, upgradeArchive, join(upgradeArchive, 'data'), upgraded, join(upgraded, 'data'));
  assert.equal(staged.status, 'UPGRADE_STAGED_OFFLINE');
  assert.equal(staged.sourceRetained, true);
  assert.equal(staged.started, false);
  assert.equal(staged.activeTokens, 0);
  assert.equal(staged.sqlite.controller.holds, 1);
  assert.deepEqual(databaseHashes(upgraded), hashes);
  assert.deepEqual(databaseHashes(path), hashes);
  assert.equal(command('rollback-check', path, upgradeArchive).status, 'IDENTICAL_SNAPSHOT');
});

test('執行鎖只可在原 PID 已退出且封存檢驗合格後顯式復原', async t => {
  const other = ['config.json', 'tokens.json', 'backup-manifest.json', 'stale-lock.json'].map(name => join('archive', name));
  const { fixture, path } = await install(t, { other });
  const config = join(path, 'config.json');
  const archive = join(fixture.root, 'archive');
  const live = acquireInstallationLock(config);
  try {
    const active = command('lock-status', path);
    assert.equal(active.status, 'OWNER_ACTIVE_OR_UNKNOWN');
    denied('LOCK_OWNER_ACTIVE_OR_UNKNOWN', 'recover-lock', path, active.sha256, archive);
    assert.equal(existsSync(archive), false);
  } finally { live(); }
  const script = [
    "import { acquireInstallationLock } from " + JSON.stringify(new URL('../tools/lock.mjs', import.meta.url).href) + ';',
    'acquireInstallationLock(process.argv[1]);',
    'process.exit(0);',
  ].join('\n');
  const stopped = spawnSync(process.execPath, ['--input-type=module', '-e', script, config],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(stopped.status, 0, stopped.stderr);
  const stale = command('lock-status', path);
  assert.equal(stale.status, 'OWNER_EXITED_BACKUP_REQUIRED');
  denied('LOCK_DIGEST_MISMATCH', 'recover-lock', path, '0'.repeat(64), archive);
  assert.equal(existsSync(archive), false);
  const resumed = command('recover-lock', path, stale.sha256, archive);
  await recordDirectories(fixture, archive, join(archive, 'data'));
  assert.equal(resumed.status, 'STALE_LOCK_ARCHIVED');
  assert.equal(hash(readFileSync(join(archive, 'stale-lock.json'))), stale.sha256);
  assert.equal(command('lock-status', path).status, 'NO_LOCK');
  const next = acquireInstallationLock(config);
  next();
});

test('封裝可重現；驗證拒絕改過的封裝與來源中的敏感字串', async t => {
  const fixture = await createWorkspaceFixture('jcm-acm-release-', ['first.tar', 'second.tar']);
  t.after(() => fixture.clean());
  const staged = join(fixture.root, 'staged');
  const toolDir = join(staged, 'tools');
  mkdirSync(staged);
  mkdirSync(toolDir);
  const agentDir = join(staged, 'agent');
  const docsDir = join(staged, 'docs');
  mkdirSync(agentDir);
  mkdirSync(docsDir);
  await recordDirectories(fixture, staged, toolDir, agentDir, docsDir);
  for (const [file, content] of Object.entries({
    'package.json': '{"name":"installation-test"}',
    'server.mjs': '',
    'start.cmd': '',
    'start.sh': '',
    [join('tools', 'rc.mjs')]: '',
    [join('agent', 'cli.mjs')]: '',
    [join('docs', 'sbom.cdx.json')]: '{}',
  })) await fixture.createFile(join('staged', file), content);
  for (const name of ['release.mjs', 'config.mjs', 'files.mjs', 'lock.mjs']) {
    await fixture.createFile(join('staged', 'tools', name), readFileSync(new URL('../tools/' + name, import.meta.url)));
  }
  const release = (...args) => spawnSync(process.execPath, [join(toolDir, 'release.mjs'), ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  const first = join(fixture.root, 'first.tar');
  const second = join(fixture.root, 'second.tar');
  const builtA = release('build', first);
  const builtB = release('build', second);
  assert.equal(builtA.status, 0, builtA.stderr);
  assert.equal(builtB.status, 0, builtB.stderr);
  const sha256 = JSON.parse(builtA.stdout).sha256;
  assert.equal(JSON.parse(builtB.stdout).sha256, sha256);
  assert.equal(release('verify', first, sha256).status, 0);
  const tampered = readFileSync(second);
  tampered[4] ^= 1;
  writeFileSync(second, tampered);
  assert.equal(JSON.parse(release('verify', second).stderr).code, 'RELEASE_ARTIFACT_MISMATCH');
  const probe = 'A'.repeat(42) + 'g';
  await fixture.createFile(join('staged', 'README.md'), 'Authorization: Bearer ' + probe);
  const rejected = release('scan');
  assert.notEqual(rejected.status, 0);
  assert.equal(JSON.parse(rejected.stderr).code, 'SECRET_SCAN_REFUSED');
  assert.ok(!rejected.stderr.includes(probe) && !rejected.stdout.includes(probe));
});
