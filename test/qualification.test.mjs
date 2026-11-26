import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';
import { openController, provisionQualificationStore } from '../src/controller.mjs';
import { createHttpApp } from '../src/http-app.mjs';
import { createQualifiedWorker, qualificationMessage, workerKeyPin } from '../src/worker/admission.mjs';
import { hash } from '../src/worker/simulation.mjs';
import { validateConfig } from '../tools/config.mjs';
import { createWorkspaceFixture } from '../tools/fixtures/workspace-fixture.mjs';

const databaseFiles = ['controller.sqlite','controller.sqlite-wal','controller.sqlite-shm'];
const signWire = (key, kind, value) => ({value,signature:sign(null,qualificationMessage(kind,value),key).toString('hex')});

async function scenario(t, {alterReady,alterSample,alterClaim,checkBeforeDispatch}={}) {
  const work = await createWorkspaceFixture('jcm-engine-qualification-', databaseFiles);
  const controllers=[];
  t.after(async()=>{
    for (const controller of controllers) await controller.close();
    await work.clean();
  });
  const authority = generateKeyPairSync('ed25519'), key = generateKeyPairSync('ed25519');
  const clock = Date.now();
  const claim = {
    id:randomUUID(),scope:'ACM_V1_ISOLATED_ENGINE_ONCE_V1',source:'QUALIFICATION_FIXTURE',
    store:provisionQualificationStore(work.root),
    node:{id:'fixture-qualified',resource:'a'.repeat(64),aliases:['lab-alias'],platform:'fixture'},
    model:{id:'fixture:qualification',digest:'1'.repeat(64),device:'cpu',context:512,maxTokens:16},
    epoch:randomUUID(),workerKey:workerKeyPin(key.publicKey),
    transport:'2'.repeat(64),runtime:'3'.repeat(64),evidence:'4'.repeat(64),
    notBefore:clock-1000,expiresAt:clock+60000,
  };
  alterClaim?.(claim);
  const pin=hash(claim),engine=randomUUID();
  let dispatches=0;
  const exchange=async (request,{signal,onDelta})=>{
    signal.throwIfAborted();
    assert.equal(request.pin,pin);
    const epoch=claim.epoch,at=Date.now();
    if(request.operation==='ready'){
      const receipt={pin,epoch,nonce:request.nonce,at,healthy:true,active:0,resident:0};
      alterReady?.(receipt);
      return signWire(key.privateKey,'READY',receipt);
    }
    const {binding}=request;
    if(request.operation==='execute'){
      checkBeforeDispatch?.(binding);
      dispatches++;
      onDelta(signWire(key.privateKey,'DELTA',{pin,epoch,binding,sequence:1,content:'candidate'}));
      const result={outcome:'SUCCEEDED',output:'candidate output',usage:{prompt_tokens:1,completion_tokens:2,total_tokens:3},
        finishReason:'stop',code:null};
      return signWire(key.privateKey,'TERMINAL',{pin,epoch,binding,at,result,engine});
    }
    assert.equal(request.operation,'sample');
    const sample={pin,epoch,binding,nonce:request.nonce,at,terminalSha256:request.terminalSha256,engine,
      healthy:true,active:0,resident:0,gpuResidentBytes:0,reclaimed:true};
    alterSample?.(sample);
    return signWire(key.privateKey,'CLEARED',sample);
  };
  function next({newAuthority=authority.publicKey,statement=claim}={}){
    return createQualifiedWorker({admission:signWire(authority.privateKey,'ADMISSION',statement),
      authorityPublicKey:newAuthority,workerPublicKey:key.publicKey,exchange});
  }
  function open(qualifiedWorker=next(),dataDir=work.root){
    const controller=openController({dataDir,mode:'engine-qualification',qualifiedWorker});
    controllers.push(controller);
    return controller;
  }
  return {next,open,root:work.root,claim,dispatches:()=>dispatches};
}

async function start(t,controller){
  const secret=randomBytes(32).toString('base64url');
  const server=createHttpApp({controller,mode:'engine-qualification',
    tokens:[{id:'qualification-test',sha256:createHash('sha256').update(secret).digest('hex'),
      scopes:['models:run'],expiresAt:Date.now()+60000}],telemetry:{history:()=>[]}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return (path,body,requestId='qualification-http')=>fetch('http://127.0.0.1:'+server.address().port+path,{
    headers:{authorization:'Bearer '+secret,...(body?{'content-type':'application/json','idempotency-key':requestId}:{})},
    ...(body?{method:'POST',body:JSON.stringify(body)}:{}),
  });
}
const input={clientId:'qualification-test',requestId:'first',model:'fixture:qualification',kind:'completion',input:'prompt',maxTokens:8};

test('生產設定、R1 範圍、其他簽署金鑰與新工作庫不能打開隔離執行', async t=>{
  const f=await scenario(t);
  assert.throws(()=>validateConfig({version:1,mode:'engine-qualification',port:0,dataDir:'./data',tokenFile:'./tokens.json',
    nodes:[],maxConcurrent:1}), /INVALID_INSTALLATION_CONFIG/);
  assert.throws(()=>openController({dataDir:f.root,mode:'engine-qualification',qualifiedWorker:{claim:f.claim}}),
    {code:'INFERENCE_DISABLED'});
  assert.throws(()=>createHttpApp({mode:'engine-qualification',controller:{},tokens:[]}),/HTTP_CONFIGURATION_INVALID/);
  assert.throws(()=>f.next({newAuthority:generateKeyPairSync('ed25519').publicKey}),{code:'WORKER_NOT_QUALIFIED'});
  assert.throws(()=>f.next({statement:{...f.claim,scope:'ACM_V08_REAL_OLLAMA_ONCE_V1'}}),{code:'WORKER_NOT_QUALIFIED'});
  assert.throws(()=>openController({dataDir:f.root,mode:'read-only'}),{code:'STORAGE_FORMAT_UNSUPPORTED'});
  const sibling=await createWorkspaceFixture('jcm-engine-sibling-',databaseFiles);
  t.after(()=>sibling.clean());
  provisionQualificationStore(sibling.root);
  assert.throws(()=>f.open(f.next(),sibling.root),{code:'INFERENCE_DISABLED'});
  assert.equal(f.dispatches(),0);
});

test('隔離 API 完成單次派送，先保留意圖及別名鎖才呼叫已簽署通道', async t=>{
  let controller;
  const f=await scenario(t,{checkBeforeDispatch(binding){
    const snapshot=controller.snapshot();
    assert.equal(snapshot.jobs.find(job=>job.id===binding.jobId).state,'RUNNING');
    assert.equal(snapshot.locks[0].attemptId,binding.attemptId);
    assert.ok(snapshot.locks[0].aliases.includes('lab-alias'));
    assert.ok(snapshot.events.some(event=>event.event==='INTENT'));
  }});
  controller=f.open();
  const call=await start(t,controller);
  assert.equal((await (await call('/v1/models')).json()).data[0].id,f.claim.model.id);
  const body={model:f.claim.model.id,prompt:'prompt',max_tokens:8};
  const response=await call('/v1/completions',body);
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.choices[0].text,'candidate output');
  assert.equal(result.acm_source,'QUALIFICATION_FIXTURE');
  const id=response.headers.get('x-acm-job-id');
  assert.equal(controller.get(id).cleanup.reason,'SIGNED_ISOLATED_EVIDENCE');
  assert.deepEqual(controller.snapshot().locks,[]);
  assert.equal((await call('/v1/completions',body)).headers.get('x-acm-job-id'),id);
  assert.equal((await call('/v1/completions',body,'second')).status,403);
  assert.deepEqual((await (await call('/v1/models')).json()).data,[]);
  assert.equal(f.dispatches(),1);
  await controller.close();
  const restarted=f.open();
  assert.equal(restarted.get(id).cleanup.confirmed,true);
  assert.throws(()=>restarted.submit(input),{code:'INFERENCE_DISABLED'});
  assert.equal(f.dispatches(),1);
});

test('過期許可、世代不符及未清場收據保留停止或 HOLD', async t=>{
  await t.test('過期許可',async t=>{
    const f=await scenario(t,{alterClaim(claim){claim.expiresAt=Date.now()-1;}});
    const controller=f.open();
    assert.deepEqual(controller.models({eligibleOnly:true}),[]);
    assert.throws(()=>controller.submit(input),{code:'MODEL_UNAVAILABLE'});
    assert.equal(f.dispatches(),0);
  });
  await t.test('通道世代漂移',async t=>{
    const f=await scenario(t,{alterReady(receipt){receipt.epoch=randomUUID();}});
    const controller=f.open(),job=controller.submit(input);
    assert.equal((await controller.wait(job.id)).cleanup.confirmed,false);
    assert.equal(controller.snapshot().locks[0].phase,'HOLD');
    assert.equal(f.dispatches(),0);
  });
  await t.test('清場收據 nonce 錯誤',async t=>{
    const f=await scenario(t,{alterSample(sample){sample.nonce='0'.repeat(64);}});
    let controller=f.open();
    const job=controller.submit(input);
    assert.equal((await controller.wait(job.id)).state,'INTERRUPTED');
    assert.equal(controller.get(job.id).output,undefined);
    await controller.close();
    controller=f.open();
    assert.equal(controller.snapshot().locks[0].phase,'HOLD');
    assert.throws(()=>controller.submit({...input,requestId:'second'}),{code:'INFERENCE_DISABLED'});
    assert.equal(f.dispatches(),1);
  });
});
