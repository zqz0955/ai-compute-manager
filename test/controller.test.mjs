import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openController } from '../src/controller.mjs';
import { createIsolatedR1Adapter, inspectOrReleaseR1, verifyR1Evidence } from '../src/worker/real-one-shot.mjs';
import { TaskStore } from '../src/worker/r1/task-store.mjs';
import { createWorkspaceFixture } from '../tools/fixtures/workspace-fixture.mjs';

async function fixture(t) {
  const work = await createWorkspaceFixture('jcm-controller-', [
    'controller.sqlite', 'controller.sqlite-wal', 'controller.sqlite-shm', 'controller.sqlite-journal',
  ]);
  const opened = [];
  t.after(async () => {
    for (const controller of opened) await controller.close();
    await work.clean();
  });
  return {
    dataDir: work.root,
    open(options = {}) {
      const controller = openController({ dataDir: work.root, mode: 'simulation', ...options });
      opened.push(controller);
      return controller;
    },
  };
}

const input = (requestId, rest = {}) => ({
  clientId: 'example', requestId, model: 'fixture:demo', kind: 'chat', input: 'test prompt', maxTokens: 8, ...rest,
});
const turn = () => new Promise(resolve => setImmediate(resolve));
function latch() {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  return { ready, release };
}

test('two distinct simulated nodes run durable jobs and release with signed evidence', async t => {
  const work = await fixture(t);
  const gate = latch();
  const controller = work.open({ simulation: { beforeRun: () => gate.ready } });
  const first = controller.submit(input('first'));
  const second = controller.submit(input('second'));
  assert.equal(first.state, 'QUEUED');
  assert.equal(first.output, undefined);
  await turn();
  const snapshot = controller.snapshot();
  assert.equal(snapshot.nodes.length, 3);
  assert.equal(snapshot.jobs.filter(job => job.state === 'RUNNING').length, 2);
  assert.equal(new Set(snapshot.locks.map(lock => lock.resource)).size, 2);
  gate.release();
  const done = await Promise.all([controller.wait(first.id), controller.wait(second.id)]);
  assert.equal(new Set(done.map(job => job.nodeId)).size, 2);
  assert.ok(done.every(job => job.state === 'SUCCEEDED' && job.cleanup.confirmed && job.output));
  for (const job of done) {
    assert.equal(job.usage.prompt_tokens, 2);
    assert.equal(job.usage.total_tokens, job.usage.prompt_tokens + job.usage.completion_tokens);
  }
  assert.equal(controller.snapshot().locks.length, 0);
  const releases = controller.snapshot().events.filter(event => event.event === 'RELEASE');
  assert.equal(releases.length, 2);
  assert.ok(releases.every(event => event.detail.evidence.sample.signature.length === 128));
  await controller.close();
  const reopened = work.open();
  assert.deepEqual(reopened.get(first.id), done[0]);
  assert.equal(reopened.submit(input('first')).id, first.id);
  assert.throws(() => reopened.submit(input('first', { input: 'other prompt' })), { code: 'IDEMPOTENCY_CONFLICT', status: 409 });
});

test('aliases reserve one physical resource and priority wins after the active job', async t => {
  const work = await fixture(t), gate = latch();
  const start = [];
  const controller = work.open({
    nodes: [
      { id: 'node-c', resource: 'other-name', aliases: ['host-2'] },
      { id: 'node-b', resource: 'host-2', aliases: ['HOST-SHARED'] },
      { id: 'node-a', resource: 'host-1', aliases: ['host-shared'] },
    ],
    simulation: { beforeRun: ({ binding }) => { start.push(binding.jobId); return start.length === 1 ? gate.ready : undefined; } },
  });
  const first = controller.submit(input('running'));
  await turn();
  const low = controller.submit(input('low', { priority: -5 }));
  const high = controller.submit(input('high', { priority: 7 }));
  const tie = controller.submit(input('tie', { priority: 7 }));
  await turn();
  assert.deepEqual(start, [first.id]);
  assert.equal(controller.snapshot().locks.length, 1);
  assert.ok(controller.nodes().every(node => node.availability === 'BUSY'));
  assert.throws(() => work.open(), { code: 'CONTROLLER_BUSY', status: 409 });
  gate.release();
  const done = await Promise.all([first, low, high, tie].map(job => controller.wait(job.id)));
  assert.deepEqual(start, [first.id, high.id, tie.id, low.id]);
  assert.ok(done.every(job => job.nodeId === 'node-a' && job.resource === 'host-1'));
});

test('canceling an HTTP waiter preserves a running job until an explicit cancel and cleanup', async t => {
  const work = await fixture(t), gate = latch();
  const controller = work.open({ maxConcurrent: 1, simulation: { beforeRun: () => gate.ready } });
  const running = controller.submit(input('running'));
  await turn();
  const queued = controller.submit(input('queued'));
  assert.equal(controller.cancel(queued.id).cleanup.reason, 'NOT_DISPATCHED');
  assert.equal((await controller.wait(queued.id)).attemptId, null);
  const signal = new AbortController();
  const waiting = controller.wait(running.id, { signal: signal.signal });
  signal.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(controller.get(running.id).state, 'RUNNING');
  assert.equal(controller.cancel(running.id).state, 'STOPPING');
  assert.equal(controller.snapshot().locks.length, 1);
  gate.release();
  const terminal = await controller.wait(running.id);
  assert.equal(terminal.state, 'CANCELLED');
  assert.equal(terminal.cleanup.confirmed, true);
  assert.equal(terminal.output, undefined);
  assert.equal(controller.snapshot().locks.length, 0);
});

test('GPU simulated monitoring and residency are visible only while the worker is active', async t => {
  const work = await fixture(t), gate = latch();
  const controller = work.open({ simulation: { beforeRun: () => gate.ready } });
  const job = controller.submit(input('gpu', { model: 'fixture:gpu', kind: 'completion' }));
  await turn();
  const active = controller.get(job.id);
  const node = controller.nodes().find(node => node.id === active.nodeId);
  assert.equal(node.platform, 'jetson');
  assert.equal(node.gpu.state, 'SUPPORTED');
  assert.equal(node.metrics.source, 'SIMULATION');
  assert.equal(node.metrics.gpuPercent, 45);
  assert.equal(node.metrics.gpuUsedBytes, 1073741824);
  assert.deepEqual(node.resident, ['fixture:gpu']);
  gate.release();
  assert.equal((await controller.wait(job.id)).cleanup.confirmed, true);
  assert.deepEqual(controller.nodes().find(node => node.id === active.nodeId).resident, []);
});

test('unverified nodes or stale GPU monitoring cannot make a namespaced model schedulable', async t => {
  const work = await fixture(t);
  const model = { id: 'lab/custom:gpu', digest: 'b'.repeat(64), context: 64, maxTokens: 64, device: 'gpu', gpuBytes: 2048 };
  const catalog = {
    models: [model], gpu: { state: 'SUPPORTED' }, gpuBytes: 4096,
    metrics: { gpuUsedBytes: 0 },
  };
  const controller = work.open({ nodes: [
    { ...catalog, id: 'unverified', status: 'UNVERIFIED' },
    { ...catalog, id: 'stale', metrics: { gpuUsedBytes: 0, sampledAt: 1 } },
    { ...catalog, id: 'unknown', gpu: { state: 'UNKNOWN' } },
  ] });
  assert.equal(controller.models()[0].id, 'lab/custom:gpu');
  assert.deepEqual(controller.models({ eligibleOnly: true }), []);
  assert.throws(() => controller.submit(input('gpu', { model: model.id })), { code: 'MODEL_UNAVAILABLE', status: 503 });
  assert.equal(controller.snapshot().jobs.length, 0);
});

test('OOM and cooperative timeout have a signed failure and resource release', async t => {
  const work = await fixture(t);
  const first = work.open({ simulation: { beforeRun: () => 'OUT_OF_MEMORY', delayMs: 0 } });
  const oom = await first.wait(first.submit(input('oom')).id);
  assert.equal(oom.state, 'FAILED');
  assert.equal(oom.error.code, 'OUT_OF_MEMORY');
  assert.equal(oom.cleanup.confirmed, true);
  await first.close();
  const reopened = work.open({ timeoutMs: 20, simulation: { delayMs: 100 } });
  assert.deepEqual(reopened.get(oom.id), oom);
  const timeout = await reopened.wait(reopened.submit(input('timeout')).id);
  assert.equal(timeout.state, 'FAILED');
  assert.equal(timeout.error.code, 'TIMEOUT');
  assert.equal(timeout.cleanup.confirmed, true);
});

test('worker disconnection and unresponsive timeout hold distinct resources without release', async t => {
  const work = await fixture(t);
  const controller = work.open({ timeoutMs: 30, simulation: {
    beforeRun: ({ node }) => node.id === 'sim-jetson-a' ? 'WORKER_DISCONNECTED' : new Promise(() => {}),
  } });
  const first = controller.submit(input('disconnect'));
  const second = controller.submit(input('timeout'));
  const end = await Promise.all([controller.wait(first.id), controller.wait(second.id)]);
  assert.deepEqual(end.map(job => [job.state, job.error.code, job.cleanup.confirmed]), [
    ['INTERRUPTED', 'WORKER_DISCONNECTED', false], ['INTERRUPTED', 'TIMEOUT', false],
  ]);
  assert.deepEqual(controller.snapshot().locks.map(lock => lock.phase), ['HOLD', 'HOLD']);
  assert.equal(controller.snapshot().events.filter(event => event.event === 'RELEASE').length, 0);
});

test('GPU residency, replays, and modified fresh evidence keep the related lock', async t => {
  for (const scenario of ['resident', 'replayed', 'modified']) {
    await t.test(scenario, async t => {
      const work = await fixture(t);
      let firstEvidence;
      const controller = work.open({ simulation: {
        delayMs: 0,
        sample: binding => scenario === 'resident' && binding.model === 'fixture:gpu' ? { gpuResidentBytes: 64 } : {},
        exchange: evidence => {
          if (!firstEvidence) { firstEvidence = evidence; return evidence; }
          if (scenario === 'replayed') return firstEvidence;
          if (scenario === 'modified') evidence.sample.record.observedAt++;
          return evidence;
        },
      } });
      const clean = await controller.wait(controller.submit(input('clean')).id);
      assert.equal(clean.state, 'SUCCEEDED');
      const job = await controller.wait(controller.submit(input('bad-gpu', { model: 'fixture:gpu' })).id);
      assert.equal(job.state, 'INTERRUPTED');
      assert.equal(job.error.code, 'EVIDENCE_UNAVAILABLE');
      assert.equal(job.output, undefined);
      const lock = controller.snapshot().locks[0];
      assert.equal(lock.phase, 'HOLD');
      assert.equal(lock.attemptId, job.attemptId);
    });
  }
});

test('abrupt process exit does not replay accepted or queued work and preserves its aliases', async t => {
  const work = await fixture(t);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { openController } from ${JSON.stringify(new URL('../src/controller.mjs', import.meta.url).href)};
    const controller = openController({ dataDir: process.argv[1], mode: 'simulation', maxConcurrent: 1,
      nodes: [{ id: 'old-node', resource: 'old-identity', aliases: ['same-host'] }],
      simulation: { beforeRun: () => new Promise(() => {}) } });
    const active = controller.submit(${JSON.stringify(input('active'))});
    const queued = controller.submit(${JSON.stringify(input('queued'))});
    setImmediate(() => {
      const response = JSON.stringify([controller.get(active.id), controller.get(queued.id)]);
      process.stdout.write(response, () => process.exit(77));
    });
  `, work.dataDir], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(result.status, 77, result.stderr);
  const [active, queued] = JSON.parse(result.stdout);
  assert.equal(active.state, 'RUNNING');
  assert.equal(queued.state, 'QUEUED');
  let dispatched = 0;
  const controller = work.open({ nodes: [{ id: 'renamed-node', resource: 'new-identity', aliases: ['SAME-HOST'] }],
    simulation: { beforeRun: () => { dispatched++; } } });
  assert.equal(controller.get(active.id).state, 'INTERRUPTED');
  assert.equal(controller.get(active.id).cleanup.confirmed, false);
  assert.equal(controller.get(queued.id).state, 'INTERRUPTED');
  assert.equal(controller.get(queued.id).cleanup.reason, 'NOT_DISPATCHED');
  assert.equal(controller.submit(input('active')).id, active.id);
  assert.equal(controller.nodes()[0].availability, 'HOLD');
  const pending = controller.submit(input('new'));
  await turn();
  assert.equal(controller.get(pending.id).state, 'QUEUED');
  assert.equal(dispatched, 0);
  assert.ok(controller.snapshot().events.some(event => event.event === 'CRASH_HOLD'));
  await controller.close();
  const reopened = work.open();
  assert.deepEqual(reopened.snapshot().locks.map(lock => [lock.jobId, lock.phase]), [[active.id, 'HOLD']]);
});

test('a modified persisted release cannot pass controller recovery', async t => {
  const work = await fixture(t), controller = work.open({ simulation: { delayMs: 0 } });
  const job = await controller.wait(controller.submit(input('clean')).id);
  assert.equal(job.cleanup.confirmed, true);
  await controller.close();
  const database = new DatabaseSync(join(work.dataDir, 'controller.sqlite'));
  try {
    database.exec(`UPDATE events SET detail=json_set(detail,'$.evidence.sample.record.resident',1) WHERE event='RELEASE'`);
  } finally { database.close(); }
  assert.throws(() => work.open(), { code: 'DURABLE_STATE_INVALID', status: 503 });
});

test('configured read-only nodes and the isolated R1 source do not enable general dispatch', async t => {
  const work = await fixture(t);
  const client = work.open({
    mode: undefined,
    nodes: [{ id: 'configured-node', status: 'ONLINE', gpu: { state: 'SUPPORTED' } }],
    simulation: { beforeRun: () => assert.fail('read-only ran a simulation or real inference') },
  });
  assert.equal(client.nodes()[0].status, 'LOCKED');
  assert.throws(() => client.submit(input('forbidden')), { code: 'INFERENCE_DISABLED', status: 403 });
  assert.deepEqual(client.snapshot().jobs, []);
  const worker = generateKeyPairSync('ed25519'), controller = generateKeyPairSync('ed25519');
  const identity = {
    mode: 'ACM_V08_ISOLATED_OLLAMA_ONCE', resource: 'a'.repeat(64), epoch: randomUUID(), model: 'fixture:real',
    release: 'b'.repeat(64), digest: 'c'.repeat(64), context: 512, workerPublicKey: worker.publicKey,
    controllerPublicKey: controller.publicKey,
  };
  const adapter = createIsolatedR1Adapter({ identity, controllerPrivateKey: controller.privateKey,
    exchange: () => assert.fail('an unapproved R1 call reached the worker exchange') });
  assert.equal(verifyR1Evidence(identity).pin, adapter.pin);
  assert.equal(verifyR1Evidence(identity).verifiesAudit({}, {}), false);
  assert.throws(() => adapter.run({ approval: null }), { code: 'DISPATCH_WINDOW_REMAINING' });
});

test('isolated R1 adapter accepts one independently signed fixture and still requires host restore', async t => {
  const keys = generateKeyPairSync('ed25519'), worker = generateKeyPairSync('ed25519');
  const fixture = await createWorkspaceFixture('jcm-controller-r-one-',
    ['', '-wal', '-shm', '-journal'].map(suffix => 'r1-controller.sqlite' + suffix));
  const database = await fixture.createFile('r1-controller.sqlite');
  const store = new TaskStore(database, { recover: false, durable: true });
  t.after(async () => { store.close(); await fixture.clean(); });
  const identity = { mode: 'ACM_V08_ISOLATED_OLLAMA_ONCE', resource: 'a'.repeat(64), aliases: ['node:test'],
    epoch: randomUUID(), model: 'fixture:real', release: 'b'.repeat(64), digest: 'c'.repeat(64), context: 512,
    controllerPublicKey: keys.publicKey, workerPublicKey: worker.publicKey };
  const engine = randomUUID(), attestation = 'd'.repeat(64);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const bytes = (kind, value) => Buffer.from(JSON.stringify(['ACM_V08_REAL_OLLAMA_ONCE_V1', kind, value]));
  const seal = (kind, value) => ({ value, signature: sign(null, bytes(kind, value), worker.privateKey).toString('hex') });
  let dispatches = 0, requestHash;
  const adapter = createIsolatedR1Adapter({ identity, controllerPrivateKey: keys.privateKey, exchange: wire => {
    assert.equal(verify(null, bytes('REQUEST', wire.value), keys.publicKey, Buffer.from(wire.signature, 'hex')), true);
    const { op, nonce, epoch, binding, payload } = wire.value;
    const dispatch = op === 'DISPATCH';
    if (dispatch) {
      dispatches++;
      assert.deepEqual(payload, { prompt: '請只回答 OK。', maxTokens: 16 });
      requestHash = hash(JSON.stringify([payload.prompt, payload.maxTokens]));
    }
    const state = dispatch ? 'ACCEPTED' : 'TERMINAL';
    const engineEvidence = {
      attemptId: binding.attemptId, digest: binding.digest, attestation, responseSha256: 'e'.repeat(64), context: 512,
      evalCount: 2, httpStatus: 200, doneReason: 'stop', vramBytes: 0, residentAfter: 0, exit: { code: 0, signal: null },
      cgroupEmpty: true, runnerObserved: true, oomDelta: 0, oomKillDelta: 0, memoryMaxHitsDelta: 0, pidsMaxHitsDelta: 0,
      peakBytes: 1200000000, sampledPeakBytes: 1199990000,
    };
    const event = seal('EVENT', { seq: dispatch ? 1 : 3, previous: '0'.repeat(64), binding, state, input: requestHash,
      engine: dispatch ? null : engine, outcome: dispatch ? null : 'SUCCEEDED', engineEvidence: dispatch ? null : engineEvidence });
    const resources = dispatch ? null : { engine, healthy: true, active: 0, resident: 0, attestation };
    return seal('RESPONSE', { op, nonce, epoch, binding, state, event, resources });
  } });
  const now = Math.floor(Date.now() / 1000);
  const approval = { notBefore: now - 1, expires: now + 600 };
  const result = await adapter.run({ store, approval });
  assert.equal(result.phase, 'HOLD');
  assert.equal(result.stage, 'HOST_RESTORE_PENDING');
  assert.equal(verifyR1Evidence(identity).verifiesAudit(result.binding, result.evidence), true);
  const expected = { boot: 'test', manifest: '1'.repeat(64), release: identity.release, token: 'test', invocation: 'test' };
  const publicIdentity = { ...identity, controllerPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    workerPublicKey: worker.publicKey.export({ type: 'spki', format: 'pem' }) };
  assert.throws(() => inspectOrReleaseR1({ store, identity: publicIdentity, expected, permit: {} }),
    { code: 'HOST_RESTORE_EVIDENCE_REQUIRED' });
  assert.equal(inspectOrReleaseR1({ store, identity: publicIdentity, expected }).cleanupConfirmed, false);
  await assert.rejects(adapter.run({ store, approval }), { code: 'REAL_RUN_ALREADY_CONSUMED' });
  assert.equal(dispatches, 1);
});

test('a persisted success missing its attempt fails closed before it can be read', async t => {
  const work = await fixture(t), controller = work.open({ simulation: { delayMs: 0 } });
  const job = await controller.wait(controller.submit(input('clean')).id);
  assert.equal(job.state, 'SUCCEEDED');
  await controller.close();
  const database = new DatabaseSync(join(work.dataDir, 'controller.sqlite'));
  try {
    database.prepare("UPDATE jobs SET data=json_set(data,'$.attemptId',NULL) WHERE id=?").run(job.id);
  } finally { database.close(); }
  assert.throws(() => work.open(), { code: 'DURABLE_STATE_INVALID', status: 503 });
});

test('missing and previously empty SQLite stores are held without creating a new primary', async t => {
  const work = await createWorkspaceFixture('jcm-store-loss-', []);
  t.after(() => work.clean());
  const dbPath=join(work.root,'controller.sqlite');
  const {existsSync,statSync,unlinkSync}=await import('node:fs');
  const orphan=await work.createFile('controller.sqlite-wal','synthetic unowned sidecar');
  assert.throws(()=>openController({dataDir:work.root}),{code:'STORAGE_UNSAFE'});
  assert.equal(existsSync(dbPath),false);
  unlinkSync(orphan);
  await work.createFile('controller.sqlite');
  assert.throws(()=>openController({dataDir:work.root}),{code:'STORAGE_FORMAT_UNSUPPORTED'});
  assert.equal(statSync(dbPath).size,0);
});
