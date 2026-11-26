import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {createLegacyMemoryMonitor,LEGACY_LIMITS,LEGACY_INHERITED_LIMITS,LEGACY_MODE,LEGACY_RETENTION_KIND,LEGACY_SCHEMA_REVISION,validLegacyMemoryEvidence} from '../src/worker/r1/legacy-memory.mjs';
import {createOllamaSupervisor,REAL_MODE,REAL_PROMPT,validEngineEvidence} from '../src/worker/r1/ollama-once.mjs';
import {createUpstreamAuditVerifier,createUpstreamClient} from '../src/worker/r1/upstream-terminal.mjs';

const root='/sys/fs/cgroup/acmlegacycpu.slice';
const service=root+'/acm-rc2-engine-readiness.service';
const zero=()=>({high:0,max:0,oom:0,oom_kill:0});
function sample(at=100){return {monotonicMs:at,readDurationMs:1,peakBytes:null,retentionKind:LEGACY_RETENTION_KIND,schemaRevision:LEGACY_SCHEMA_REVISION,metricSource:'CGROUP_V2_CURRENT_AND_EVENTS_NO_PEAK',
  groups:[root,service,service+'/controller',service+'/engine'].map((path,i)=>({path,identity:{dev:'1',ino:String(i+10)},
    limits:{...(i===0?LEGACY_LIMITS:LEGACY_INHERITED_LIMITS)},current:1024,swap:0,events:zero(),local:zero(),pidsEvents:{max:0},members:i===2?
      [{pid:2,startTick:'33',uid:0,gid:0,group:path.slice('/sys/fs/cgroup'.length)}]:[]}))};}
function completeEvidence(){let now=100;const m=createLegacyMemoryMonitor({clock:()=>now});m.observe(sample(now));now=200;m.observe(sample(now));return m.complete();}
const binding=()=>({attemptId:randomUUID(),model:'qwen2.5:0.5b-instruct-q4_K_M',digest:'a'.repeat(64)});
const baseEvidence=b=>({attestation:'b'.repeat(64),attemptId:b.attemptId,digest:b.digest,context:512,evalCount:1,
  responseSha256:'c'.repeat(64),httpStatus:200,doneReason:'stop',vramBytes:0,residentAfter:0,
  exit:{code:0,signal:null},cgroupEmpty:true,peakBytes:1024,sampledPeakBytes:1024,runnerObserved:true,
  oomDelta:0,oomKillDelta:0,memoryMaxHitsDelta:0,pidsMaxHitsDelta:0});

test('bounded evidence explicitly has unknown kernel peak and independently sampled maximum',()=>{
  const value=completeEvidence();assert.ok(validLegacyMemoryEvidence(value));assert.equal(value.peakBytes,null);
  assert.equal(value.sampledPeakBytes,1024);assert.equal(value.groups.length,4);
  for(const field of ['eventsBaseline','eventsFinal','eventsDelta'])assert.equal(value[field].length,4);
  assert.equal(validLegacyMemoryEvidence({...value,peakBytes:1024}),false);
  assert.equal(validLegacyMemoryEvidence({...value,complete:false}),false);
  assert.equal(validLegacyMemoryEvidence({...value,sampleCount:1}),false);
});

test('every memory/local/pids event rejects and permanently poisons the monitor',()=>{
  for(const group of [0,1,2,3])for(const [field,name] of [...['events','local'].flatMap(field=>['high','max','oom','oom_kill'].map(name=>[field,name])),['pidsEvents','max']]){
    const m=createLegacyMemoryMonitor({clock:()=>100});m.observe(sample());const bad=sample(200);bad.groups[group][field][name]=1;
    assert.throws(()=>m.observe(bad),/LEGACY_.*EVENT/);assert.equal(m.healthy(),false);
    assert.throws(()=>m.observe(sample(300)));assert.throws(()=>m.complete());
  }
});

test('pressure, quota, identity, swap, missing members and interrupted monitor fail closed',()=>{
  const mutations=[r=>r.groups[0].current=1476395009,r=>r.groups[2].limits['memory.max']='2147483648',
    r=>r.groups[0].identity.ino='99',r=>r.groups[2].swap=1,r=>delete r.groups[2].members,
    r=>r.groups[0].members=[{pid:3,startTick:'4',uid:0,gid:0,group:'/other'}],r=>r.readDurationMs=1001,
    r=>r.monotonicMs=1101,r=>r.groups[0].local=null];
  for(const change of mutations){const m=createLegacyMemoryMonitor({clock:()=>100});m.observe(sample());const bad=sample(200);change(bad);assert.throws(()=>m.observe(bad));assert.throws(()=>m.evidence());}
  let now=100;const m=createLegacyMemoryMonitor({clock:()=>now});m.observe(sample(now));now=1101;
  assert.throws(()=>m.evidence(),/LEGACY_MONITOR_GAP/);assert.throws(()=>m.complete());
});

test('caller mutation cannot rewrite pinned scope, limits or returned evidence',()=>{
  const m=createLegacyMemoryMonitor({clock:()=>100});const raw=sample();m.observe(raw);
  raw.groups[0].identity.ino='99';raw.groups[1].limits['memory.max']='2147483648';
  const publicView=m.evidence();publicView.groups[0].identity.ino='98';publicView.eventsBaseline[0].memory.high=1;
  assert.equal(m.evidence().groups[0].identity.ino,'10');assert.equal(m.evidence().eventsBaseline[0].memory.high,0);
  assert.doesNotThrow(()=>m.observe(sample(200)));
  const replacement=sample(300);replacement.groups[0].identity.ino='99';
  assert.throws(()=>m.observe(replacement),/LEGACY_GROUP_OR_LIMIT_DRIFT/);
});

test('optional local events remain explicitly unavailable; counter resets and scope changes reject',()=>{
  const m=createLegacyMemoryMonitor({clock:()=>100});let r=sample();for(const g of r.groups)g.local=null;m.observe(r);
  r=sample(200);for(const g of r.groups)g.local=null;m.observe(r);const e=m.complete();assert.ok(validLegacyMemoryEvidence(e));
  assert.ok(e.groups.every(g=>!g.localAvailable));assert.ok(e.eventsFinal.every(g=>g.local===null));
});

test('retention revision rejects consumed three-group contract and nested hard limit drift',()=>{
  const e=completeEvidence();assert.equal(e.retentionKind,'TRANSIENT_SLICE_HIERARCHICAL_V1');assert.equal(e.schemaRevision,2);
  assert.equal(validLegacyMemoryEvidence({...e,retentionKind:'SERVICE_REMAIN_AFTER_EXIT_V1'}),false);
  assert.equal(validLegacyMemoryEvidence({...e,groups:e.groups.slice(1)}),false);
  const missing=sample();delete missing.retentionKind;
  assert.throws(()=>createLegacyMemoryMonitor({clock:()=>100}).observe(missing),/LEGACY_MONITOR_SAMPLE/);
  for(const group of [1,2,3]){
    const r=sample();r.groups[group].limits['memory.max']='1610612736';
    assert.throws(()=>createLegacyMemoryMonitor({clock:()=>100}).observe(r),/LEGACY_LIMIT_DRIFT/);
  }
  const rootMember=sample();rootMember.groups[1].members=[{pid:3,startTick:'4',uid:0,gid:0,group:'/acmlegacycpu.slice/acm-rc2-engine-readiness.service'}];
  assert.throws(()=>createLegacyMemoryMonitor({clock:()=>100}).observe(rootMember),/LEGACY_PROCESS_MEMBERSHIP/);
});

test('new evidence cannot satisfy original R1; mode and sampled data are bound',()=>{
  const b=binding(),old=baseEvidence(b);assert.ok(validEngineEvidence(old,b,512));
  const next={...old,peakBytes:null,memoryMode:LEGACY_MODE,memoryEvidence:completeEvidence()};
  assert.ok(validEngineEvidence(next,b,512,LEGACY_MODE));assert.equal(validEngineEvidence(next,b,512),false);
  assert.equal(validEngineEvidence(old,b,512,LEGACY_MODE),false);
  assert.equal(validEngineEvidence({...next,memoryMode:REAL_MODE},b,512,LEGACY_MODE),false);
  assert.equal(validEngineEvidence({...next,sampledPeakBytes:2048},b,512,LEGACY_MODE),false);
  assert.equal(validEngineEvidence(next,{...b,attemptId:randomUUID()},512,LEGACY_MODE),false);
  assert.equal(validEngineEvidence(next,b,1024,LEGACY_MODE),false);
});

test('legacy upstream domain and policy pin cannot reuse original signed response',async()=>{
  const controller=generateKeyPairSync('ed25519'),worker=generateKeyPairSync('ed25519');
  const identity={mode:REAL_MODE,model:'qwen2.5:0.5b-instruct-q4_K_M',context:512,digest:'a'.repeat(64),
    release:'b'.repeat(64),resource:'c'.repeat(64),epoch:randomUUID(),controllerPublicKey:controller.publicKey,workerPublicKey:worker.publicKey};
  const create=mode=>createUpstreamClient({identity:{...identity,mode},controllerPrivateKey:controller.privateKey,
    exchange:async wire=>{const value={op:wire.value.op,nonce:wire.value.nonce,epoch:identity.epoch,binding:wire.value.binding,
      state:'UNKNOWN',event:null,resources:null};return {value,signature:sign(null,Buffer.from(JSON.stringify(['ACM_V08_REAL_OLLAMA_ONCE_V1','RESPONSE',value])),worker.privateKey).toString('hex')};}});
  const old=create(REAL_MODE),next=create(LEGACY_MODE);assert.equal(next.real,true);assert.notEqual(next.pin,old.pin);
  assert.equal(createUpstreamAuditVerifier({...identity,mode:LEGACY_MODE}).real,true);
  const b={jobId:randomUUID(),attemptId:randomUUID(),owner:randomUUID(),resource:identity.resource,model:identity.model,digest:identity.digest,target:'d'.repeat(64),intentAt:1};
  assert.equal((await old.status(b)).state,'UNKNOWN');await assert.rejects(next.status(b),{code:'UPSTREAM_SIGNATURE'});
});

function poolFixture(fault){
  let at=100,active=false,stopped=false,requests=0;const monitor=createLegacyMemoryMonitor({clock:()=>at});monitor.observe(sample(at));
  const metric=()=>{at+=1;const r=sample(at);r.groups[3].members=active?[{pid:3,startTick:'44',uid:65202,gid:65202,group:'/acmlegacycpu.slice/acm-rc2-engine-readiness.service/engine'}]:[];
    if(active&&fault==='event')r.groups[0].events.high=1;monitor.observe(r);
    return {healthy:true,empty:!active,peak:null,sampledPeak:1024,oom:0,oomKill:0,max:0,pidsMaxHits:0,legacyEvidence:monitor.evidence()};};
  const pool={metrics:()=>stopped?{healthy:true,empty:true,peak:null,sampledPeak:1024,oom:0,oomKill:0,max:0,pidsMaxHits:0,legacyEvidence:monitor.evidence()}:metric(),
    start:async()=>{active=true;return {request:async(method,path,body)=>{
      if(path==='/api/version')return {version:'0.40.16'};
      if(path==='/api/tags')return {models:[{name:'qwen2.5:0.5b-instruct-q4_K_M',digest:'a'.repeat(64)}]};
      if(path==='/api/show')return {capabilities:['completion'],details:{format:'gguf'}};
      if(path==='/api/ps')return {models:requests&&!stopped?[{name:'qwen2.5:0.5b-instruct-q4_K_M',digest:'a'.repeat(64),context_length:512,size_vram:0}]:[]};
      if(path==='/api/generate'){requests++;await delay(10);pool.draining=true;return {model:'qwen2.5:0.5b-instruct-q4_K_M',done:true,done_reason:'stop',response:'OK',eval_count:1};}
      throw Error('unexpected route');},engineProof:async()=>({attestation:'b'.repeat(64),actualContext:512,runnerObserved:true}),
      stop:async()=>{active=false;metric();if(fault==='stop')throw Error('stop failed');monitor.complete();stopped=true;return {code:0,signal:null};}};},
    draining:false};
  const start=pool.start;pool.start=async(...args)=>{const handle=await start(...args),request=handle.request;handle.request=(method,path,body)=>path==='/api/ps'&&pool.draining?Promise.resolve({models:[]}):request(method,path,body);return handle;};
  return {pool,requests:()=>requests};
}
const policy={mode:LEGACY_MODE,model:'qwen2.5:0.5b-instruct-q4_K_M',digest:'a'.repeat(64),version:'0.40.16',context:512,limits:{memory:1610612736,memoryHigh:1476395008}};

test('supervisor returns bounded terminal only after clean engine stop; rejects replay',async()=>{
  const fixture=poolFixture(),s=createOllamaSupervisor(policy,fixture.pool),b=binding();
  const result=await s.execute(b,{prompt:REAL_PROMPT,maxTokens:16});
  assert.ok(validEngineEvidence(result.engineEvidence,b,512,LEGACY_MODE));assert.equal(result.engineEvidence.peakBytes,null);
  assert.equal(s.sample().healthy,true);assert.equal(fixture.requests(),1);
  await assert.rejects(s.execute(b,{prompt:REAL_PROMPT,maxTokens:16}),{code:'OLLAMA_ONCE_HELD'});
});

test('limit event and stop failure keep supervisor HOLD even if HTTP response succeeds',async()=>{
  for(const fault of ['event','stop']){const fixture=poolFixture(fault),s=createOllamaSupervisor(policy,fixture.pool);
    await assert.rejects(s.execute(binding(),{prompt:REAL_PROMPT,maxTokens:16}));assert.equal(s.sample().healthy,false);
    await assert.rejects(s.execute(binding(),{prompt:REAL_PROMPT,maxTokens:16}),{code:'OLLAMA_ONCE_HELD'});
  }
});
