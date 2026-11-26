import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {test} from 'node:test';
import {createIsolatedR1Adapter,verifyR1Evidence} from '../src/worker/real-one-shot.mjs';
import {createDurableCleanup} from '../src/worker/r1/durable-cleanup.mjs';
import {TaskStore} from '../src/worker/r1/task-store.mjs';
import {validateConfig} from '../tools/config.mjs';
import {createWorkspaceFixture} from '../tools/fixtures/workspace-fixture.mjs';
import {createLegacyMemoryMonitor,LEGACY_LIMITS,LEGACY_INHERITED_LIMITS} from '../src/worker/r1/legacy-memory.mjs';

const mode='LEGACY_KERNEL_BOUNDED_CPU_V1';
function identity(){
  const controller=generateKeyPairSync('ed25519'),worker=generateKeyPairSync('ed25519');
  return {controller,identity:{mode,resource:'a'.repeat(64),aliases:['node:legacy-fixture'],epoch:randomUUID(),
    model:'fixture:legacy',release:'b'.repeat(64),digest:'c'.repeat(64),context:512,
    controllerPublicKey:controller.publicKey,workerPublicKey:worker.publicKey}};
}

test('legacy admission stays separate from R1 and cannot be enabled by public installation mode',()=>{
  const {controller,identity:claim}=identity();
  const options={identity:claim,controllerPrivateKey:controller.privateKey,exchange:()=>assert.fail('dispatch')};
  const adapter=createIsolatedR1Adapter(options);
  const exact=createIsolatedR1Adapter({...options,identity:{...claim,mode:'ACM_V08_ISOLATED_OLLAMA_ONCE'}});
  assert.notEqual(adapter.pin,exact.pin);
  assert.equal(verifyR1Evidence(claim).pin,adapter.pin);
  assert.throws(()=>adapter.run({approval:null}),{code:'DISPATCH_WINDOW_REMAINING'});
  assert.throws(()=>validateConfig({version:1,mode,port:0,dataDir:'./data',tokenFile:'./tokens.json',nodes:[],maxConcurrent:1}),
    /INVALID_INSTALLATION_CONFIG/);
});

test('unknown legacy dispatch retains durable HOLD across two reopens without replay or manual release',async t=>{
  const work=await createWorkspaceFixture('jcm-legacy-durable-',
    ['', '-wal','-shm','-journal'].map(s=>'legacy.sqlite'+s));
  const database=await work.createFile('legacy.sqlite');
  let store=new TaskStore(database,{recover:false,durable:true});
  t.after(async()=>{store?.close();await work.clean();});
  const {controller,identity:claim}=identity();
  let dispatches=0;
  const adapter=createIsolatedR1Adapter({identity:claim,controllerPrivateKey:controller.privateKey,
    exchange:()=>{dispatches++;throw Object.assign(Error('observer unavailable'),{code:'LEGACY_MONITOR_FAILED'});}});
  const now=Math.floor(Date.now()/1000),approval={notBefore:now-1,expires:now+600};
  const result=await adapter.run({store,approval});
  assert.equal(result.phase,'HOLD');assert.equal(result.stage,'EVIDENCE_HOLD');
  assert.equal(store.get(result.binding.jobId).cleanup.confirmed,false);
  for(let count=0;count<2;count++){
    store.close();store=new TaskStore(database,{recover:false,durable:true});
    const cleanup=createDurableCleanup(store,{upstream:verifyR1Evidence(claim),authorizeRecovery:()=>null,
      authorizeRestore:()=>true});
    assert.match(cleanup.blocked({resource:claim.resource,aliases:['node:legacy-fixture']}),/耐久派送鎖/u);
    assert.throws(()=>cleanup.releaseRestored(result.binding.jobId,{}),{code:'HOST_RESTORE_EVIDENCE_REQUIRED'});
    await assert.rejects(adapter.run({store,approval}),{code:'REAL_RUN_ALREADY_CONSUMED'});
    assert.equal(store.db.prepare('SELECT phase FROM v08_intents').get().phase,'HOLD');
  }
  assert.equal(dispatches,1);
});

for(const fault of [false,true]) test('signed legacy '+(fault?'memory event cannot unlock':'terminal still awaits host restoration'),async t=>{
  const work=await createWorkspaceFixture('jcm-legacy-signed-',
    ['', '-wal','-shm','-journal'].map(s=>'legacy.sqlite'+s));
  const database=await work.createFile('legacy.sqlite');
  let store=new TaskStore(database,{recover:false,durable:true});
  t.after(async()=>{store.close();await work.clean();});
  const controller=generateKeyPairSync('ed25519'),worker=generateKeyPairSync('ed25519');
  const claim={...identity().identity,controllerPublicKey:controller.publicKey,workerPublicKey:worker.publicKey};
  const root='/sys/fs/cgroup/acmlegacycpu.slice',service=root+'/acm-rc2-engine-readiness.service';
  let time=100;
  const monitor=createLegacyMemoryMonitor({clock:()=>time});
  const raw=()=>({monotonicMs:time,readDurationMs:1,peakBytes:null,retentionKind:'TRANSIENT_SLICE_HIERARCHICAL_V1',schemaRevision:2,metricSource:'CGROUP_V2_CURRENT_AND_EVENTS_NO_PEAK',
    groups:[root,service,service+'/controller',service+'/engine'].map((path,i)=>({path,identity:{dev:'1',ino:String(i+1)},
      limits:{...(i===0?LEGACY_LIMITS:LEGACY_INHERITED_LIMITS)},current:1024,swap:0,events:{high:0,max:0,oom:0,oom_kill:0},local:{high:0,max:0,oom:0,oom_kill:0},
      pidsEvents:{max:0},members:[]}))});
  monitor.observe(raw());time=200;monitor.observe(raw());
  const memoryEvidence=monitor.complete();
  if(fault) memoryEvidence.eventsDelta[0].memory.high=1;
  const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const seal=(kind,value)=>({value,signature:sign(null,Buffer.from(JSON.stringify(
    ['ACM_LEGACY_KERNEL_BOUNDED_CPU_V1',kind,value])),worker.privateKey).toString('hex')});
  const engine=randomUUID(),attestation='d'.repeat(64);
  let dispatches=0,input;
  const adapter=createIsolatedR1Adapter({identity:claim,controllerPrivateKey:controller.privateKey,exchange:wire=>{
    const {op,nonce,epoch,binding,payload}=wire.value,first=op==='DISPATCH';
    if(first){dispatches++;input=hash([payload.prompt,payload.maxTokens]);}
    const state=first?'ACCEPTED':'TERMINAL';
    const engineEvidence={attemptId:binding.attemptId,digest:binding.digest,attestation,responseSha256:'e'.repeat(64),
      context:512,evalCount:1,httpStatus:200,doneReason:'stop',vramBytes:0,residentAfter:0,exit:{code:0,signal:null},
      cgroupEmpty:true,runnerObserved:true,oomDelta:0,oomKillDelta:0,memoryMaxHitsDelta:0,pidsMaxHitsDelta:0,
      peakBytes:null,sampledPeakBytes:1024,memoryMode:mode,memoryEvidence};
    const event=seal('EVENT',{seq:first?1:3,previous:'0'.repeat(64),binding,state,input,
      engine:first?null:engine,outcome:first?null:'SUCCEEDED',engineEvidence:first?null:engineEvidence});
    return seal('RESPONSE',{op,nonce,epoch,binding,state,event,
      resources:first?null:{engine,healthy:true,active:0,resident:0,attestation}});
  }});
  const now=Math.floor(Date.now()/1000),approval={notBefore:now-1,expires:now+600};
  const result=await adapter.run({store,approval});
  assert.equal(result.stage,fault?'EVIDENCE_HOLD':'HOST_RESTORE_PENDING');
  assert.equal(store.get(result.binding.jobId).cleanup.confirmed,false);
  assert.equal(store.db.prepare('SELECT phase FROM v08_intents').get().phase,'HOLD');
  if(fault) for(let restart=0;restart<2;restart++){
    store.close();store=new TaskStore(database,{recover:false,durable:true});
    const durable=createDurableCleanup(store,{upstream:verifyR1Evidence(claim),authorizeRecovery:()=>null,
      authorizeRestore:()=>true});
    assert.ok(durable.blocked(claim));
    assert.throws(()=>durable.releaseRestored(result.binding.jobId,{}),{code:'HOST_RESTORE_EVIDENCE_REQUIRED'});
    assert.equal(store.get(result.binding.jobId).cleanup.confirmed,false);
  }
  await assert.rejects(adapter.run({store,approval}),{code:'REAL_RUN_ALREADY_CONSUMED'});
  assert.equal(dispatches,1);
});
