import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWorkspaceFixture } from '../tools/fixtures/workspace-fixture.mjs';
import { digest, readJson, replaceJson, snapshotFile } from '../tools/files.mjs';
import { startService } from '../server.mjs';

const script = path => fileURLToPath(new URL('../' + path, import.meta.url));
const rc = script('tools/rc.mjs');
const release = script('tools/release.mjs');
const operator = script('tools/h6/operator.mjs');
const nodeSha = () => snapshotFile(process.execPath, 512 * 1024 ** 2).sha256;

function invoke(path, ...args) {
  return spawnSync(process.execPath, [path, ...args], { encoding: 'utf8', timeout: 125000, windowsHide: true });
}

function decoded(result) {
  assert.equal(result.status, 0, result.stderr || result.error?.code);
  return JSON.parse(result.stdout);
}

test('H6 按固定來源進行跨代投影、同代遷移和新根回滾，分岔不覆寫', { timeout: 180000 }, async t => {
  const members = ['release.tar', 'projection.json'];
  const roots = ['old', 'backup', 'new', 'rollback'];
  const databases = ['controller.sqlite','telemetry.sqlite'].flatMap(name =>
    ['', '-wal', '-shm', '-journal'].map(suffix => join('data', name + suffix)));
  for (const root of roots) {
    members.push(...['config.json', 'tokens.json', 'install-manifest.json', 'backup-manifest.json', 'maintenance.lock', 'storage-seal.json',
      join('data', 'legacy-history.json'), ...databases].map(name => join(root, name)));
  }
  const fixture = await createWorkspaceFixture('jcm-hsix-', members);
  t.after(() => fixture.clean());
  const root = name => join(fixture.root, name);
  async function record(...names) {
    for (const name of names) {
      if (existsSync(root(name))) await fixture.recordDirectory(root(name));
      const data = join(root(name), 'data');
      if (existsSync(data)) await fixture.recordDirectory(data);
    }
  }
  const projectionContents = JSON.stringify({ version: 1, source: 'V0.6_SNAPSHOT', capturedAt: 1000,
    requestsCount: 1, holdsCount: 1, tasks: [{ id: 'prior-job', nodeId: null, kind: 'completion',
      state: 'INTERRUPTED', createdAt: 100, startedAt: 200, finishedAt: 300, model: 'fixture:cpu', errorCode: 'INCOMPLETE' }],
    duals: [] });
  const projection = await fixture.createFile('projection.json', projectionContents);
  const archive = root('release.tar');
  const built = decoded(invoke(release, 'build', archive));
  const verified = [nodeSha(), archive, built.sha256];
  const h6 = (...args) => invoke(operator, ...verified, ...args);
  const invalid = invoke(operator, '0'.repeat(64), archive, built.sha256, 'stage-legacy', root('invalid'));
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).code, 'H6_NODE_SHA_MISMATCH');
  assert.equal(existsSync(root('invalid')), false);
  const mismatch = h6('stage-legacy', root('invalid'), projection, '0'.repeat(64));
  assert.equal(mismatch.status, 1);
  assert.equal(JSON.parse(mismatch.stderr).code, 'LEGACY_SOURCE_HASH_MISMATCH');
  assert.equal(existsSync(root('invalid')), false);
  const legacyRun = h6('stage-legacy', root('old'), projection, digest(projectionContents));
  await record('old');
  const legacy = decoded(legacyRun);
  assert.equal(legacy.status, 'H6_LEGACY_STAGED_OFFLINE');
  assert.equal(legacy.history.sha256, digest(projectionContents));
  assert.equal(legacy.started, false);
  assert.equal(legacy.history.tasks, 1);
  assert.equal(decoded(invoke(rc, 'token', 'issue', root('old'), 'fixture-old-token', 'manage:read', '1')).status, 'ISSUED');
  const oldConfig = join(root('old'), 'config.json');
  const original = readJson(oldConfig);
  replaceJson(original, { ...original.value, port: 0 });
  const isolated = await startService(oldConfig, { requiredConfigSha256: readJson(oldConfig).sha256 });
  await isolated.close();
  assert.ok(existsSync(join(root('old'), 'data', 'controller.sqlite')));
  assert.ok(existsSync(join(root('old'), 'data', 'telemetry.sqlite')));
  const before = readJson(oldConfig);
  const upgradedRun = h6('stage-v1', root('old'), root('backup'), root('new'));
  await record('backup', 'new');
  const upgraded = decoded(upgradedRun);
  assert.equal(upgraded.status, 'H6_V1_STAGED_OFFLINE');
  assert.equal(upgraded.started, false);
  assert.deepEqual(readJson(join(root('new'), 'tokens.json')).value,
    { version: 1, tokens: [], revokedIds: ['fixture-old-token'] });
  assert.equal(readJson(join(root('new'), 'data', 'legacy-history.json')).sha256, legacy.history.sha256);
  const rollbackRun = h6('rollback', root('old'), root('backup'), root('rollback'));
  await record('rollback');
  const rollback = decoded(rollbackRun);
  assert.equal(rollback.status, 'H6_ROLLBACK_COPY_STAGED_OFFLINE');
  assert.equal(rollback.started, false);
  assert.equal(readJson(join(root('old'), 'config.json')).sha256, before.sha256);
  const launch = h6('launch', root('new'), '0'.repeat(64));
  assert.equal(launch.status, 1);
  assert.equal(JSON.parse(launch.stderr).code, 'H6_CONFIG_SHA_MISMATCH');
  const fixtureLaunch = h6('launch', root('new'), upgraded.configSha256);
  assert.equal(fixtureLaunch.status, 1);
  assert.equal(JSON.parse(fixtureLaunch.stderr).code, 'H6_FORMAL_LAUNCH_REQUIRES_APPROVED_PORT_AND_PRIVATE_ANCESTORS');
  decoded(invoke(rc, 'token', 'issue', root('old'), 'fixture-divergence', 'manage:read', '1'));
  const diverged = h6('rollback', root('old'), root('backup'), root('denied'));
  assert.equal(diverged.status, 2);
  assert.equal(JSON.parse(diverged.stdout).status, 'DIVERGED_KEEP_CURRENT');
  assert.equal(existsSync(root('denied')), false);
});

test('啟動鎖內重新核對設定 SHA，漂移時未建立資料庫且可正常重取鎖', { timeout: 30000 }, async t => {
  const files = ['config.json', 'tokens.json', 'install-manifest.json', 'maintenance.lock', 'storage-seal.json',
    ...['controller.sqlite','telemetry.sqlite'].flatMap(name =>
      ['', '-wal', '-shm', '-journal'].map(suffix => join('data', name + suffix)))];
  const fixture = await createWorkspaceFixture('jcm-hsix-launch-', files.map(name => join('install', name)));
  t.after(() => fixture.clean());
  const install = join(fixture.root, 'install');
  const setup = invoke(rc, 'setup', install);
  if (existsSync(install)) await fixture.recordDirectory(install);
  if (existsSync(join(install, 'data'))) await fixture.recordDirectory(join(install, 'data'));
  decoded(setup);
  const config = join(install, 'config.json');
  const previous = readJson(config);
  replaceJson(previous, { ...previous.value, port: 0 });
  await assert.rejects(startService(config, { requiredConfigSha256: previous.sha256 }), /REVIEWED_CONFIGURATION_CHANGED/u);
  assert.equal(existsSync(join(install, 'data', 'controller.sqlite')), false);
  assert.equal(existsSync(join(install, 'maintenance.lock')), false);
  const service = await startService(config, { requiredConfigSha256: readJson(config).sha256 });
  try {
    assert.equal(service.info.host, '127.0.0.1');
    assert.equal(service.info.mode, 'read-only');
    assert.ok(service.info.port > 0);
  } finally { await service.close(); }
  assert.equal(existsSync(join(install, 'maintenance.lock')), false);
});
