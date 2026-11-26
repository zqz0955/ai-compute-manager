import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWorkspaceFixture } from '../tools/fixtures/workspace-fixture.mjs';
import { projectH5Snapshot, verifyH5 } from '../tools/h5/verify-receipt.mjs';
import { digest } from '../tools/files.mjs';
import { openController } from '../src/controller.mjs';

const cpuModel = { id: 'fixture:cpu', digest: 'a'.repeat(64), context: 128, maxTokens: 16, device: 'cpu' };
const nodes = ['a', 'b'].map(id => ({
  id: 'fixture-' + id, resource: 'resource-' + id, aliases: ['hardware-' + id], models: [cpuModel],
}));

test('既有 Controller 雙節點唯讀回條將失聯鎖保留至重啟，健康端仍正常釋放', { timeout: 15000 }, async t => {
  const fixture = await createWorkspaceFixture('jcm-hfive-', [
    ...['', '-wal', '-shm', '-journal'].map(suffix => join('data', 'controller.sqlite' + suffix)),
    'receipt.json',
  ]);
  t.after(() => fixture.clean());
  const dataDir = join(fixture.root, 'data');
  mkdirSync(dataDir, { mode: 0o700 });
  await fixture.recordDirectory(dataDir);
  const ready = new Map(nodes.map(node => [node.id, Promise.withResolvers()]));
  const permission = new Map(nodes.map(node => [node.id, Promise.withResolvers()]));
  const controller = openController({ dataDir, mode: 'simulation', nodes, maxConcurrent: 2, simulation: {
    async beforeRun({ node }) {
      ready.get(node.id).resolve();
      return permission.get(node.id).promise;
    },
  } });
  let receipt;
  try {
    const jobs = [1, 2].map(n => controller.submit({
      clientId: 'fixture', requestId: 'qualification-' + n, model: cpuModel.id,
      kind: 'completion', input: 'Synthetic simultaneous request.', maxTokens: 8,
    }));
    await Promise.all([...ready.values()].map(row => row.promise));
    const active = projectH5Snapshot(controller.snapshot());
    assert.equal(active.locks.length, 2);
    const failed = active.jobs.find(job => job.nodeId === nodes[0].id);
    permission.get(nodes[0].id).resolve('WORKER_DISCONNECTED');
    permission.get(nodes[1].id).resolve(undefined);
    await Promise.all(jobs.map(job => controller.wait(job.id)));
    receipt = {
      version: 1, kind: 'MULTINODE_TRANSPORT_LOSS', source: 'SIMULATION',
      nodes: nodes.map(node => ({ nodeId: node.id, resource: node.resource, aliases: node.aliases,
        physicalIdSha256: digest(node.resource), admissionSha256: digest('fixture-admission-' + node.id), modelSha256: cpuModel.digest })),
      controllerBuildSha256: digest('synthetic-build'), restartProofSha256: digest('synthetic-restart'),
      transportLossProofSha256: digest('injected-worker-disconnected'),
      failedJobId: failed.id, active, reopened: null,
    };
  } finally {
    for (const row of permission.values()) row.resolve(undefined);
    await controller.close();
  }

  const reopened = openController({ dataDir, mode: 'simulation', nodes, maxConcurrent: 2 });
  try { receipt.reopened = projectH5Snapshot(reopened.snapshot()); }
  finally { await reopened.close(); }

  assert.deepEqual(verifyH5(receipt), {
    status: 'H5_EVIDENCE_CONSISTENT', source: 'SIMULATION', physicalDevices: 2, simultaneousIntentCount: 2,
    interruptedLockHeldAfterRestart: true, healthyPeerReleased: true, replayedAttempts: 0, hardwareQualified: false,
    gate: 'INDEPENDENT_RAW_EVIDENCE_AND_HARDWARE_REVIEW_REQUIRED',
  });
  const rejects = (pattern, edit) => {
    const copy = structuredClone(receipt);
    edit(copy);
    assert.throws(() => verifyH5(copy), pattern);
  };
  rejects(/H5_DUPLICATE_PHYSICAL_DEVICE_OR_ADMISSION/u, copy => {
    copy.nodes[1].physicalIdSha256 = copy.nodes[0].physicalIdSha256;
  });
  rejects(/H5_NODE_ALIAS_COLLISION/u, copy => { copy.nodes[1].aliases.push(copy.nodes[0].aliases[0].toUpperCase()); });
  rejects(/H5_REOPENED_HOLD_OR_RELEASE_INVALID/u, copy => { copy.reopened.locks.length = 0; });
  rejects(/H5_DUPLICATE_OR_MISSING_INTENT/u, copy => {
    const intent = copy.reopened.events.find(event => event.event === 'INTENT');
    const last = copy.reopened.events.at(-1);
    copy.reopened.events.push({ ...intent, seq: last.seq + 1, at: last.at });
  });
  rejects(/H5_HOLD_RELEASE_EVIDENCE_MISSING/u, copy => {
    const release = copy.reopened.events.find(event => event.event === 'RELEASE');
    release.event = 'CANCEL_REQUESTED';
    release.terminal = null;
  });
  rejects(/H5_SNAPSHOT_INCOMPLETE/u, copy => { copy.active.events.length = 0; });
  const bytes = JSON.stringify(receipt);
  assert.ok(!bytes.includes('Synthetic simultaneous request.'));
  const path = await fixture.createFile('receipt.json', bytes);
  const cli = fileURLToPath(new URL('../tools/h5/verify-receipt.mjs', import.meta.url));
  const accepted = spawnSync(process.execPath, [cli, path, digest(bytes)], { encoding: 'utf8', timeout: 5000 });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).hardwareQualified, false);
  const stale = spawnSync(process.execPath, [cli, path, 'f'.repeat(64)], { encoding: 'utf8', timeout: 5000 });
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stderr).code, 'H5_RECEIPT_SHA_MISMATCH');
});
