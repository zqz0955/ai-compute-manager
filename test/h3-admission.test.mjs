import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { openController, provisionQualificationStore } from '../src/controller.mjs';
import { createHttpApp } from '../src/http-app.mjs';
import { qualificationMessage, workerKeyPin } from '../src/worker/admission.mjs';
import { LEGACY_MODE, REAL_PROMPT, MAX_TOKENS } from '../src/worker/r1/ollama-once.mjs';
import { createWorkspaceFixture } from '../tools/fixtures/workspace-fixture.mjs';
import { createH3Exchange, runH3Peer } from '../tools/h3/wire.mjs';
import { h3Dispatch, h3Qualified, h3TransportPin } from '../tools/h3/session.mjs';
import { requireNativeH3Admission } from '../tools/h3/native-gate.mjs';
import { publishEngineDelta } from '../tools/engine-qualification/integration-host.mjs';

const seal=(key,kind,value)=>({value,signature:sign(null,qualificationMessage(kind,value),key).toString('hex')});
const model='qwen2.5:0.5b-instruct-q4_K_M';
const d=(n)=>n.repeat(64);

async function fixture(t,{mode='legacy-json',fault}={}) {
  const fixture=await createWorkspaceFixture('jcm-cross-host-wire-',['controller.sqlite','controller.sqlite-wal','controller.sqlite-shm']);
  const [admitter,worker,controller,restore]=Array.from({length:4},()=>generateKeyPairSync('ed25519'));
  const target={version:1,operation:randomUUID(),mode,device:d('a'),boot:randomUUID(),hostTrust:d('2'),
    controllerKey:workerKeyPin(controller.publicKey),workerKey:workerKeyPin(worker.publicKey),restoreKey:workerKeyPin(restore.publicKey),
    runtime:d('3'),release:d('4'),endpoint:d('5'),cpuEvidence:d('6')};
  const acm=provisionQualificationStore(fixture.root);
  const claim={id:target.operation,scope:'ACM_V1_ISOLATED_ENGINE_ONCE_V1',source:'ISOLATED_REAL_ENGINE',
    memoryMode:LEGACY_MODE,store:acm,node:{id:'nx-h3-fixture',resource:target.device,aliases:['nx-fixture'],platform:'fixture'},
    model:{id:model,digest:'a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67',device:'cpu',context:512,maxTokens:MAX_TOKENS},
    epoch:randomUUID(),workerKey:target.workerKey,transport:h3TransportPin(target),runtime:target.runtime,
    evidence:target.cpuEvidence,notBefore:Date.now()-1000,expiresAt:Date.now()+410000};
  const options={target,admission:seal(admitter.privateKey,'ADMISSION',claim),authorityPublicKey:admitter.publicKey,
    restorationAuthorityPublicKey:restore.publicKey,workerPublicKey:worker.publicKey,controllerPublicKey:controller.publicKey};
  const checking=h3Qualified(options,()=>assert.fail('Only admission is checked here'));
  const c2s=new PassThrough(),s2c=new PassThrough();
  const sessionAbort=new AbortController();
  const exchange=createH3Exchange({input:s2c,output:c2s,pin:checking.pin,controllerPrivateKey:controller.privateKey,
    workerPublicKey:worker.publicKey,shutdown(){sessionAbort.abort();c2s.destroy();s2c.destroy();}});
  let originalReady, app, dispatches=0, recorded=0, releaseSeen=false;
  const dispatch=h3Dispatch({qualified:checking,workerPrivateKey:worker.privateKey,restorePublicKey:restore.publicKey,context:target,
    recordIntent(binding) {
      recorded++;
      assert.equal(app.snapshot().locks[0].attemptId,binding.attemptId);
      assert.equal(app.snapshot().locks[0].phase,'INTENT');
    },
    dispatchReady(){ return; },
    async execute({publish}){
      dispatches++;
      if(fault==='disconnect'){exchange.close();throw Error('LINK_CLOSED');}
      if(mode==='legacy-sse'){publish('candidate');}
      const at=Date.now();
      const terminal={output:'candidate output',usage:{prompt_tokens:31,completion_tokens:2,total_tokens:33},engineEvidence:{doneReason:'stop'}};
      return { terminal,engine:randomUUID(),restoration:{verifiedAt:at,committedAt:at,r1JobId:randomUUID(),r1AttemptId:randomUUID(),
        topologySha256:d('b'),r1ReleaseSha256:d('c'),evidenceSha256:d('d')} };
    },
    authorizeRestore(value){
      assert.ok(app.snapshot().locks.length===1);
      releaseSeen=true;
      return seal(fault==='wrong-role'?admitter.privateKey:restore.privateKey,'RESTORED',value);
    },
  });
  const daemon=runH3Peer({input:c2s,output:s2c,pin:checking.pin,controllerPublicKey:controller.publicKey,
    workerPrivateKey:worker.privateKey,dispatch,signal:sessionAbort.signal});
  daemon.catch(()=>{s2c.destroy();});
  app=openController({dataDir:fixture.root,mode:'engine-qualification',maxConcurrent:1,
    qualifiedWorker:h3Qualified(options,exchange.exchange)});
  let server;
  t.after(async()=>{
    if(server) await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    exchange.close();
    await daemon.catch(()=>{});
    await app.close();
    await fixture.clean();
  });
  const token=randomBytes(32).toString('base64url');
  server=createHttpApp({controller:app,mode:'engine-qualification',tokens:[{id:'qualification-test',
    sha256:createHash('sha256').update(token).digest('hex'),scopes:['models:run'],expiresAt:Date.now()+60000}],
    telemetry:{history:()=>[]},qualificationMode:target.mode});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const send=(requestId='h3-first',stream=mode==='legacy-sse')=>fetch('http://127.0.0.1:'+server.address().port+'/v1/completions',{
    method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':requestId},
    body:JSON.stringify({model,prompt:REAL_PROMPT,max_tokens:MAX_TOKENS,
      ...(stream?{stream:true,stream_options:{include_usage:true}}:{})})});
  return {send,app,options,exchange,root:fixture.root,dispatches:()=>dispatches,recorded:()=>recorded,releaseSeen:()=>releaseSeen};
}

test('H3 簽章 JSON 透過本機記憶體通道與產品保持唯一工作及雙權威清場',async t=>{
  const s=await fixture(t);
  assert.throws(()=>h3Qualified({...s.options,target:{...s.options.target,boot:randomUUID()}},s.exchange.exchange),{code:'H3_TARGET_DENIED'});
  assert.throws(()=>h3Qualified({...s.options,restorationAuthorityPublicKey:s.options.authorityPublicKey},s.exchange.exchange),{code:'H3_AUTHORITY_ROLES'});
  assert.equal((await s.send('mode-mismatch',true)).status,403);
  assert.equal(s.dispatches(),0);
  const response=await s.send();
  assert.equal(response.status,200);
  assert.equal((await response.json()).choices[0].text,'candidate output');
  const id=response.headers.get('x-acm-job-id');
  assert.equal(s.app.get(id).cleanup.confirmed,true);
  assert.equal((await s.send()).headers.get('x-acm-job-id'),id);
  assert.equal((await s.send('h3-new')).status,403);
  assert.deepEqual([s.dispatches(),s.recorded(),s.releaseSeen()],[1,1,true]);
});

test('H3 已部署入口在原生權威隔離前保持關閉',()=>{
  assert.throws(requireNativeH3Admission,{code:'H3_NATIVE_ROLE_SEPARATION_PENDING'});
});

test('原生引擎幀處理正確接受 legacy-sse 且拒絕非串流與無效字元',()=>{
  let observed=[];
  publishEngineDelta('legacy-sse',{content:'甲'},value=>observed.push(value));
  publishEngineDelta('sse',{content:'乙'},value=>observed.push(value));
  assert.deepEqual(observed,['甲','乙']);
  for(const [mode,content] of [['legacy-json','skipped'],['legacy-sse',String.fromCharCode(0xd800)]])
    assert.throws(()=>publishEngineDelta(mode,{content},()=>assert.fail('Must not publish')),{code:'ENGINE_UNIT_DELTA'});
});

test('H3 執行固定協定經過兩個本機 Node 程序的真實 stdio',async t=>{
  const controller=generateKeyPairSync('ed25519'), worker=generateKeyPairSync('ed25519'), pin=d('1');
  const childScript=`
    import { createPrivateKey, createPublicKey } from 'node:crypto';
    import { runH3Peer } from ${JSON.stringify(new URL('../tools/h3/wire.mjs',import.meta.url).href)};
    const [pin,verify,key]=JSON.parse(process.env.ACM_H3_TEST_EPHEMERAL);
    await runH3Peer({input:process.stdin,output:process.stdout,pin,
      controllerPublicKey:createPublicKey({key:Buffer.from(verify,'hex'),type:'spki',format:'der'}),
      workerPrivateKey:createPrivateKey({key:Buffer.from(key,'hex'),type:'pkcs8',format:'der'}),
      signal:AbortSignal.timeout(5000),
      dispatch(request,{onDelta}){
        if(request.operation==='execute') onDelta('local preview');
        return {phase:request.operation};
      },
    });
    process.stdin.destroy();
  `;
  const child=spawn(process.execPath,['--input-type=module','--eval',childScript],{
    windowsHide:true,stdio:['pipe','pipe','inherit'],env:{ACM_H3_TEST_EPHEMERAL:JSON.stringify([pin,
      controller.publicKey.export({format:'der',type:'spki'}).toString('hex'),
      worker.privateKey.export({format:'der',type:'pkcs8'}).toString('hex')])},
  });
  const closed=once(child,'close');
  const channel=createH3Exchange({input:child.stdout,output:child.stdin,pin,controllerPrivateKey:controller.privateKey,
    workerPublicKey:worker.publicKey,shutdown(){child.stdin.destroy();child.stdout.destroy();}});
  t.after(()=>{channel.close();if(child.exitCode===null) child.kill();});
  assert.deepEqual(await channel.exchange({operation:'ready',pin}),{phase:'ready'});
  const chunks=[];
  assert.deepEqual(await channel.exchange({operation:'execute',pin},{onDelta:delta=>chunks.push(delta)}),{phase:'execute'});
  assert.deepEqual(chunks,['local preview']);
  assert.deepEqual(await channel.exchange({operation:'sample',pin}),{phase:'sample'});
  channel.close();
  assert.deepEqual(await closed,[0,null]);
});

test('H3 SSE 預覽片段保留，雙權威提交完成後才能收到正式終態',async t=>{
  const s=await fixture(t,{mode:'legacy-sse'});
  assert.equal((await s.send('mode-mismatch',false)).status,403);
  assert.equal(s.dispatches(),0);
  const response=await s.send(), body=await response.text();
  assert.equal(response.status,200);
  const preview=body.indexOf('"acm_provisional":true'), done=body.indexOf('data: [DONE]');
  assert.ok(preview>=0&&done>preview);
  assert.deepEqual([s.dispatches(),s.recorded(),s.releaseSeen()],[1,1,true]);
  assert.equal(s.app.get(response.headers.get('x-acm-job-id')).state,'SUCCEEDED');
});

for(const fault of ['disconnect','wrong-role']) {
  test('H3 '+fault+' 保留持久鎖且重開不能重送',async t=>{
    const s=await fixture(t,{fault}),response=await s.send();
    assert.notEqual(response.status,200);
    await response.text();
    assert.deepEqual([s.dispatches(),s.recorded()],[1,1]);
    const before=s.app.snapshot();
    assert.equal(before.jobs[0].state,'INTERRUPTED');
    assert.equal(before.locks[0].phase,'HOLD');
    await s.app.close();
    const reopened=openController({dataDir:s.root,mode:'engine-qualification',maxConcurrent:1,
      qualifiedWorker:h3Qualified(s.options,s.exchange.exchange)});
    try {
      assert.equal(reopened.snapshot().locks[0].phase,'HOLD');
      assert.throws(()=>reopened.submit({clientId:'qualification-test',requestId:'retry-h3',model,kind:'completion',
        input:REAL_PROMPT,maxTokens:MAX_TOKENS}),{code:'INFERENCE_DISABLED'});
      assert.equal(s.dispatches(),1);
    } finally {await reopened.close();}
  });
}
