import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startService } from '../../server.mjs';
import { parseLegacyHistory } from '../../src/legacy-history.mjs';
import { SHA256, validateConfig } from '../config.mjs';
import { readJson, snapshotFile } from '../files.mjs';
import { absoluteLocalPath, assertPinned, containedIn } from '../lock.mjs';
import { importHistory } from '../import-history.mjs';

const releaseTool = fileURLToPath(new URL('../release.mjs', import.meta.url));
const rcTool = fileURLToPath(new URL('../rc.mjs', import.meta.url));
const code = /^[A-Z0-9_]{3,80}$/u;

function verifyRuntimeIdentity(pin) {
  const current = assertPinned(pin);
  if (current.size !== pin.id.size || current.mtimeNs !== pin.id.mtimeNs || current.ctimeNs !== pin.id.ctimeNs) {
    throw Error('H6_NODE_CHANGED');
  }
}

function fixedCommand(runtime, tool, args) {
  verifyRuntimeIdentity(runtime);
  const result = spawnSync(runtime.path, [tool, ...args], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 120_000, maxBuffer: 1_048_576,
  });
  verifyRuntimeIdentity(runtime);
  if (result.status !== 0) {
    let refusal;
    try { refusal = JSON.parse(result.stderr).code; } catch { refusal = null; }
    throw Error(code.test(refusal ?? '') ? refusal : 'H6_MAINTENANCE_FAILED');
  }
  return JSON.parse(result.stdout);
}

function absolutelyDistinct(values) {
  const paths = values.map(absoluteLocalPath);
  for (const [index, path] of paths.entries()) {
    if (paths.slice(index + 1).some(other => containedIn(path, other) || containedIn(other, path))) {
      throw Error('H6_STORAGE_ROLES_OVERLAP');
    }
  }
  return paths;
}

function configuration(root) {
  const config = readJson(join(absoluteLocalPath(root), 'config.json'));
  if (validateConfig(config.value).mode !== 'read-only') throw Error('H6_READ_ONLY_REQUIRED');
  return config;
}

function checkedSource(runtime, archive, archiveSha256) {
  if (!SHA256.test(archiveSha256 ?? '')) throw Error('H6_ARCHIVE_SHA_REQUIRED');
  const result = fixedCommand(runtime, releaseTool, ['verify', absoluteLocalPath(archive), archiveSha256]);
  if (result.status !== 'INSTALL_TAR_VERIFIED' || result.sha256 !== archiveSha256) throw Error('H6_RELEASE_VERIFICATION_FAILED');
}

const usage = [
  '<node-sha256> <release.tar> <release-sha256> stage-legacy <new-install> [<projection.json> <projection-sha256>]',
  '<node-sha256> <release.tar> <release-sha256> stage-v1 <old-install> <new-backup> <new-install>',
  '<node-sha256> <release.tar> <release-sha256> rollback <original-install> <same-lineage-backup> <new-rollback-install>',
  '<node-sha256> <release.tar> <release-sha256> launch <install> <reviewed-config-sha256>',
];

export async function operate([nodeSha256, archive, archiveSha256, operation, ...args]) {
  if (!({
    'stage-legacy': [1, 3], 'stage-v1': [3], rollback: [3], launch: [2],
  })[operation]?.includes?.(args.length)) throw Error('H6_USAGE');
  if (!SHA256.test(nodeSha256 ?? '')) throw Error('H6_NODE_SHA_REQUIRED');
  if (Object.keys(process.env).some(name => /^(?:NODE_OPTIONS|NODE_PATH)$/iu.test(name) && process.env[name])) {
    throw Error('H6_UNTRUSTED_NODE_ENVIRONMENT');
  }
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 22 || minor === 22 && patch < 3 || !process.versions.sqlite) {
    throw Error('NODE_COMPATIBILITY_REQUIRED');
  }
  const actual = snapshotFile(process.execPath, 512 * 1024 ** 2);
  if (actual.sha256 !== nodeSha256) throw Error('H6_NODE_SHA_MISMATCH');
  const runtime = actual.pin;
  checkedSource(runtime, archive, archiveSha256);
  const rc = (...arguments_) => fixedCommand(runtime, rcTool, arguments_);
  const ready = (root, result) => {
    const migration = rc('migration-check', root);
    const checked = rc('doctor', root);
    const config = configuration(root);
    if (migration.status !== 'SCHEMA_COMPATIBLE' || checked.status !== 'READY_OFFLINE' || checked.activeTokens !== 0) {
      throw Error('H6_STAGED_INSTALL_HOLD');
    }
    return { ...result, admitted: false, started: false, releaseSha256: archiveSha256,
      configSha256: config.sha256, mode: migration.mode, storagePolicy: checked.storagePolicy };
  };

  if (operation === 'stage-legacy') {
    const [root, projection] = absolutelyDistinct([archive, ...args.slice(0, 2)]).slice(1);
    if (projection) {
      const source = readJson(projection);
      if (source.sha256 !== args[2]) throw Error('LEGACY_SOURCE_HASH_MISMATCH');
      parseLegacyHistory(source.value);
    }
    if (rc('setup', root).status !== 'INSTALLED') throw Error('H6_SETUP_FAILED');
    const history = projection ? importHistory(root, projection, args[2]) : null;
    return ready(root, { status: 'H6_LEGACY_STAGED_OFFLINE', history });
  }
  if (operation === 'stage-v1' || operation === 'rollback') {
    const [original, backup, target] = absolutelyDistinct([archive, ...args]).slice(1);
    configuration(original);
    if (operation === 'stage-v1') {
      if (rc('upgrade', original, backup, target).status !== 'UPGRADE_STAGED_OFFLINE') throw Error('H6_UPGRADE_FAILED');
      return ready(target, { status: 'H6_V1_STAGED_OFFLINE', originalRetained: true, backupRetained: true });
    }
    const result = rc('rollback-stage', original, backup, target);
    if (result.status === 'DIVERGED_KEEP_CURRENT' && result.inPlaceAllowed === false) {
      return { status: result.status, inPlaceAllowed: false, destinationCreated: false, started: false, admitted: false };
    }
    if (result.status !== 'RESTORED_OFFLINE') throw Error('H6_ROLLBACK_LINEAGE_HOLD');
    return ready(target, { status: 'H6_ROLLBACK_COPY_STAGED_OFFLINE', originalRetained: true, backupRetained: true });
  }

  const [root] = absolutelyDistinct([archive, args[0]]).slice(1);
  const config = configuration(root);
  if (config.sha256 !== args[1]) throw Error('H6_CONFIG_SHA_MISMATCH');
  // 正式入口要求具名埠及安裝根的正式 ACL 限制。
  if (config.value.port === 0 || process.env.ACM_INSTALL_WORKSPACE_FIXTURE || process.env.ACM_TEST_ROOT) {
    throw Error('H6_FORMAL_LAUNCH_REQUIRES_APPROVED_PORT_AND_PRIVATE_ANCESTORS');
  }
  verifyRuntimeIdentity(runtime);
  const service = await startService(config.pin.path, { requiredConfigSha256: config.sha256 });
  const stop = () => service.close().catch(() => {
    process.exitCode = 1;
    console.error('ACM_STOP_HOLD');
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log('ACM_LISTEN=' + JSON.stringify({ ...service.info, releaseSha256: archiveSha256, configSha256: config.sha256 }));
  return undefined;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--help') console.log(JSON.stringify({ usage }, null, 2));
    else {
      const result = await operate(process.argv.slice(2));
      if (result !== undefined) console.log(JSON.stringify(result, null, 2));
      if (result?.status === 'DIVERGED_KEEP_CURRENT') process.exitCode = 2;
    }
  } catch (error) {
    const reason = code.test(error.message ?? '') ? error.message : 'H6_OPERATION_HOLD';
    console.error(JSON.stringify({ status: 'HOLD', code: reason }));
    process.exitCode = 1;
  }
}
