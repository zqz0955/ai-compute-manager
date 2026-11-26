import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';
import { openController, provisionQualificationStore } from '../src/controller.mjs';
import { createQualifiedWorker, qualificationMessage, workerKeyPin } from '../src/worker/admission.mjs';
import { LEGACY_MODE } from '../src/worker/r1/legacy-memory.mjs';
import { hash } from '../src/worker/simulation.mjs';
import { projectH5Snapshot, verifyH5 } from '../tools/h5/verify-receipt.mjs';
import { createWorkspaceFixture } from '../tools/fixtures/workspace-fixture.mjs';

function deferred() { return Promise.withResolvers(); }

function signedPeer(store, name, resource, {key = generateKeyPairSync('ed25519'), restorationKey, ...overrides} = {}) {
  const authority = generateKeyPairSync('ed25519');
  const clock = Date.now();
  const claim = {
    id: randomUUID(), scope: 'ACM_V1_ISOLATED_ENGINE_ONCE_V1', source: 'QUALIFICATION_FIXTURE',
    store, node: {id: name, resource, aliases: [name + '-alias'], platform: 'fixture'},
    model: {id: 'fixture:h5', digest: '8'.repeat(64), device: 'cpu', context: 512, maxTokens: 16},
    epoch: randomUUID(), workerKey: workerKeyPin(key.publicKey), transport: '2'.repeat(64), runtime: '3'.repeat(64),
    evidence: '4'.repeat(64), notBefore: clock - 1000, expiresAt: clock + 60_000,
    ...overrides,
  };
  const launched = deferred(), finish = deferred(), engine = randomUUID();
  let dispatches = 0, worker, terminalAt;
  const seal = (kind, value, privateKey = key.privateKey) => ({
    value, signature: sign(null, qualificationMessage(kind, value), privateKey).toString('hex'),
  });
  function create() {
    worker = createQualifiedWorker({
      admission: seal('ADMISSION', claim, authority.privateKey),
      authorityPublicKey: authority.publicKey, workerPublicKey: key.publicKey,
      ...(restorationKey ? {restorationAuthorityPublicKey:restorationKey.publicKey,expectedMemoryMode:LEGACY_MODE} : {}),
      async exchange(request, {signal}) {
        signal.throwIfAborted();
        assert.equal(request.pin, worker.pin);
        const base = {pin: worker.pin, epoch: claim.epoch};
        if (request.operation === 'ready') {
          return seal('READY', {...base, nonce:request.nonce, at:Date.now(), healthy:true, active:0, resident:0});
        }
        const {binding} = request;
        if (request.operation === 'execute') {
          dispatches++;
          assert.equal(binding.resource, claim.node.resource);
          assert.equal(binding.nodeId, claim.node.id);
          assert.equal(binding.model, claim.model.id);
          assert.equal(binding.digest, claim.model.digest);
          assert.equal(binding.admissionId, claim.id);
          launched.resolve(binding);
          if (await finish.promise === 'disconnect') throw Object.assign(Error('fixture lost'), {code:'WORKER_DISCONNECTED'});
          signal.throwIfAborted();
          const result = {outcome:'SUCCEEDED', output:'fixture', usage:{prompt_tokens:1, completion_tokens:1, total_tokens:2},
            code:null, finishReason:'stop'};
          terminalAt = Date.now();
          return seal('TERMINAL', {...base, binding, at:terminalAt, result, engine});
        }
        assert.equal(request.operation, 'sample');
        const witness = {...base,binding,engine,nonce:request.nonce,terminalSha256:request.terminalSha256};
        const restore = restorationKey ? seal('RESTORED', {...witness,verifiedAt:terminalAt,committedAt:terminalAt,
          r1JobId:randomUUID(),r1AttemptId:randomUUID(),r1ReleaseSha256:'5'.repeat(64),
          topologySha256:'6'.repeat(64),evidenceSha256:'7'.repeat(64)}, restorationKey.privateKey) : null;
        return seal('CLEARED', {...witness,at:Date.now(),healthy:true,active:0,resident:0,gpuResidentBytes:0,reclaimed:true,
          ...(restore ? {restore} : {})});
      },
    });
    return worker;
  }
  return {create, claim, launched, finish, dispatches:()=>dispatches};
}

const request = {clientId:'h5-fixture', requestId:'one', model:'fixture:h5', kind:'completion', input:'test', maxTokens:4};

async function storeFixture(t) {
  const fixture = await createWorkspaceFixture('jcm-qualified-workers-', ['controller.sqlite','controller.sqlite-wal','controller.sqlite-shm']);
  const store = provisionQualificationStore(fixture.root);
  const controllers = [];
  t.after(async()=> {
    for (const controller of controllers) await controller.close();
    await fixture.clean();
  });
  function open(qualifiedWorkers, options = {}) {
    const controller = openController({dataDir:fixture.root, mode:'engine-qualification', qualifiedWorkers, ...options});
    controllers.push(controller);
    return controller;
  }
  return {store, open};
}

test('兩個獨立限定 Worker 同時持鎖，失聯時僅保留該端且重啟不重送', {timeout:8000}, async t=> {
  const f = await storeFixture(t);
  const legacy = () => ({source:'ISOLATED_REAL_ENGINE',memoryMode:LEGACY_MODE,restorationKey:generateKeyPairSync('ed25519')});
  const a = signedPeer(f.store, 'alpha', 'a'.repeat(64),legacy());
  const b = signedPeer(f.store, 'bravo', 'b'.repeat(64),legacy());
  const definitions = [a.create(), b.create()];
  const app = f.open(definitions);
  assert.deepEqual(app.models({eligibleOnly:true}).map(model=>model.id), ['fixture:h5']);
  const one = app.submit(request);
  assert.equal(app.submit(request).id, one.id);
  const two = app.submit({...request, requestId:'two'});
  assert.notEqual(two.workerPin, one.workerPin);
  assert.throws(()=>app.submit({...request, requestId:'three'}), {code:'INFERENCE_DISABLED'});
  assert.deepEqual(app.models({eligibleOnly:true}), []);
  const [bindingA, bindingB] = await Promise.all([a.launched.promise, b.launched.promise]);
  const active = projectH5Snapshot(app.snapshot());
  assert.equal(active.locks.length, 2);
  assert.ok(active.locks.every(lock=>lock.phase==='INTENT'));
  assert.equal(bindingA.jobId, one.id);
  assert.equal(bindingB.jobId, two.id);

  a.finish.resolve('disconnect');
  b.finish.resolve('success');
  const [failed, completed] = await Promise.all([app.wait(one.id),app.wait(two.id)]);
  assert.equal(failed.state, 'INTERRUPTED');
  assert.equal(failed.error.code, 'WORKER_DISCONNECTED');
  assert.equal(failed.cleanup.confirmed, false);
  assert.equal(completed.state, 'SUCCEEDED');
  assert.equal(completed.cleanup.confirmed, true);
  await app.close();

  assert.throws(()=>f.open([b.create()]), {code:'DURABLE_STATE_INVALID'});
  const restarted = f.open([b.create(),a.create()]);
  assert.equal(restarted.get(one.id).attemptId, bindingA.attemptId);
  assert.equal(restarted.get(two.id).attemptId, bindingB.attemptId);
  assert.deepEqual(restarted.snapshot().locks.map(lock=>[lock.resource,lock.phase]), [[a.claim.node.resource,'HOLD']]);
  assert.equal(restarted.submit(request).id, one.id);
  assert.throws(()=>restarted.submit({...request,requestId:'new-after-restart'}), {code:'INFERENCE_DISABLED'});
  assert.deepEqual([a.dispatches(), b.dispatches()], [1,1]);
  const receipt = verifyH5({
    version:1,kind:'MULTINODE_TRANSPORT_LOSS',source:'ISOLATED_REAL_ENGINE',
    nodes:[a,b].map(({claim})=>({nodeId:claim.node.id,resource:claim.node.resource,aliases:claim.node.aliases,
      physicalIdSha256:claim.node.resource,admissionSha256:hash(claim),modelSha256:claim.model.digest})),
    controllerBuildSha256:'c'.repeat(64),restartProofSha256:'d'.repeat(64),transportLossProofSha256:'e'.repeat(64),
    failedJobId:one.id,active,reopened:projectH5Snapshot(restarted.snapshot()),
  });
  assert.equal(receipt.status,'H5_EVIDENCE_CONSISTENT');
  assert.equal(receipt.hardwareQualified,false);
});

test('限定 Worker 陣列不可混用執行模式、其他工作庫或共用實體及別名', async t=> {
  const f = await storeFixture(t);
  const a = signedPeer(f.store, 'alpha', 'a'.repeat(64));
  const b = signedPeer(f.store, 'bravo', 'b'.repeat(64));
  assert.throws(()=>f.open([a.create()], {mode:'simulation'}), {code:'INFERENCE_DISABLED'});
  assert.throws(()=>f.open([a.create()], {qualifiedWorker:b.create()}), {code:'INFERENCE_DISABLED'});
  assert.throws(()=>f.open([a.create(), signedPeer('6'.repeat(64),'bravo','b'.repeat(64)).create()]), {code:'INFERENCE_DISABLED'});
  for (const node of [
    {id:'alias-device',resource:a.claim.node.resource,aliases:[],platform:'fixture'},
    {id:'alias-device',resource:b.claim.node.resource,aliases:['node:alpha'],platform:'fixture'},
    {id:'alpha',resource:b.claim.node.resource,aliases:[],platform:'fixture'},
    {id:'alias-device',resource:b.claim.node.resource,aliases:['alpha-alias'],platform:'fixture'},
  ]) {
    assert.throws(()=>f.open([a.create(),signedPeer(f.store,node.id,node.resource,{node}).create()]), {code:'INFERENCE_DISABLED'});
  }
  const sharedKey = generateKeyPairSync('ed25519');
  assert.throws(()=>f.open([signedPeer(f.store,'alpha','a'.repeat(64),{key:sharedKey}).create(),
    signedPeer(f.store,'bravo','b'.repeat(64),{key:sharedKey}).create()]), {code:'INFERENCE_DISABLED'});
  assert.throws(()=>f.open([a.create(),signedPeer(f.store,'bravo','b'.repeat(64),{id:a.claim.id}).create()]), {code:'INFERENCE_DISABLED'});
  assert.equal(a.dispatches(),0);
  assert.equal(b.dispatches(),0);
});

test('已鎖定的資格在等候時失效，仍禁止改派尚未使用的相同模型 Worker', {timeout:8000}, async t=> {
  const f = await storeFixture(t);
  const now = Date.now();
  const a = signedPeer(f.store, 'alpha', 'a'.repeat(64));
  const b = signedPeer(f.store, 'bravo', 'b'.repeat(64), {expiresAt:now+5000});
  const c = signedPeer(f.store, 'charlie', 'c'.repeat(64));
  const app = f.open([a.create(),b.create(),c.create()],{maxConcurrent:1});
  const first = app.submit(request);
  const waiting = app.submit({...request,requestId:'waiting'});
  await a.launched.promise;
  assert.equal(app.get(waiting.id).state,'QUEUED');
  t.mock.method(Date,'now',()=>now+5001);
  a.finish.resolve('success');
  const [firstDone, abandoned] = await Promise.all([app.wait(first.id),app.wait(waiting.id)]);
  assert.equal(firstDone.state,'SUCCEEDED');
  assert.equal(abandoned.state,'INTERRUPTED');
  assert.equal(abandoned.attemptId,null);
  assert.equal(abandoned.cleanup.reason,'NOT_DISPATCHED');
  assert.equal(abandoned.error.code,'WORKER_NOT_QUALIFIED');
  assert.equal(app.submit({...request,requestId:'waiting'}).id,waiting.id);
  const third = app.submit({...request,requestId:'new-explicit'});
  await c.launched.promise;
  c.finish.resolve('success');
  assert.equal((await app.wait(third.id)).state,'SUCCEEDED');
  assert.deepEqual([a.dispatches(), b.dispatches(), c.dispatches()],[1,0,1]);
});

test('每個限定 Worker 只接收自己的 CPU 模型和預算，取消的未送出工作仍消耗資格', async t=> {
  const f = await storeFixture(t);
  const a = signedPeer(f.store, 'alpha', 'a'.repeat(64));
  const b = signedPeer(f.store, 'bravo', 'b'.repeat(64), {
    model:{...a.claim.model,id:'fixture:h5-small',digest:'9'.repeat(64),context:6,maxTokens:3},
  });
  const app = f.open([a.create(),b.create()]);
  assert.throws(()=>app.submit({...request,model:'fixture:gpu'}), {code:'MODEL_NOT_FOUND'});
  assert.throws(()=>app.submit({...request,model:b.claim.model.id}), {code:'MODEL_LIMIT_EXCEEDED'});
  assert.throws(()=>app.submit({...request,model:b.claim.model.id,maxTokens:3,input:'a b c d'}), {code:'MODEL_LIMIT_EXCEEDED'});
  const cancelled = app.submit(request);
  assert.equal(app.cancel(cancelled.id).state,'CANCELLED');
  assert.equal(app.get(cancelled.id).cleanup.reason,'NOT_DISPATCHED');
  assert.throws(()=>app.submit({...request,requestId:'no-fallback'}), {code:'MODEL_UNAVAILABLE'});
  assert.deepEqual(app.models({eligibleOnly:true}).map(model=>model.id), [b.claim.model.id]);
  await app.close();
  const restarted = f.open([a.create(),b.create()]);
  assert.equal(restarted.submit(request).id,cancelled.id);
  assert.throws(()=>restarted.submit({...request,requestId:'no-fallback'}), {code:'MODEL_UNAVAILABLE'});
  assert.equal(a.dispatches(),0);
  assert.equal(b.dispatches(),0);
});
