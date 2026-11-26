import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openController, provisionQualificationStore } from '../../src/controller.mjs';
import { createHttpApp } from '../../src/http-app.mjs';
import { createQualifiedWorker, qualificationMessage, workerKeyPin } from '../../src/worker/admission.mjs';
import { createDurableCleanup } from '../../src/worker/r1/durable-cleanup.mjs';
import { createUpstreamAuditVerifier, createUpstreamClient,
  openSimulationWorker, provisionSimulationWorker } from '../../src/worker/r1/upstream-terminal.mjs';
import { runDurableOnce } from '../../src/worker/r1/run-durable-once.mjs';
import { TaskStore } from '../../src/worker/r1/task-store.mjs';
import { fail, MAX_TOKENS, REAL_MODE, LEGACY_MODE, REAL_PROMPT, sha, validEngineEvidence } from '../../src/worker/r1/ollama-once.mjs';
import { hash } from '../../src/worker/simulation.mjs';
import { emit, guestBoundary, protectedFile, runEngineUnit, safeCode, source, state, unitIsGone, verifyRestoredUnit } from './integration-host.mjs';
import { lines } from './integration-stream.mjs';
import {observeLegacyApiJob} from './legacy-api-job.mjs';

import {NX_ENGINE,nxInstalled} from '../nx-legacy/layout.mjs';
import {nxLaunch,requireNxRestored,checkNxObserver,writeNxReceipt} from '../nx-legacy/authority.mjs';
import {startNxWorker} from '../nx-legacy/worker-channel.mjs';

const model='qwen2.5:0.5b-instruct-q4_K_M';
const digest='a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67';
const capacityPin='da246d3d067d3ed2aebb3dea434a9c33409f43625646bc1ed87a030e5a118eb1';
const binary=(nxInstalled ? NX_ENGINE : '/opt/acm-rc2-engine-readiness')+'/assets/ollama/bin/ollama';
const check=(ok,code)=>{if(!ok)throw fail(code);};
const seal=(key,kind,value)=>({value,signature:sign(null,qualificationMessage(kind,value),key).toString('hex')});

export async function roundTripR1({directory,binding,claim,runtime,signal,mode,publish}){
  const controllerKeys=generateKeyPairSync('ed25519'), workerKeys=nxInstalled?null:generateKeyPairSync('ed25519');
  const launch=nxInstalled?nxLaunch():null;
  const identity={mode:mode.startsWith('legacy-')?LEGACY_MODE:REAL_MODE,context:512,model,digest,epoch:randomUUID(),
    release:hash([binding,claim.transport,runtime,claim.evidence,...(launch?[launch.value.releaseSha256]:[])]),
    resource:binding.resource,aliases:[launch?'node:orin-nx-legacy-cpu':'node:isolated-arm64-ollama'],
    controllerPublicKey:controllerKeys.publicKey,workerPublicKey:workerKeys?.publicKey};
  const engine=randomUUID(), upstreamDB=join(directory,'upstream.sqlite');
  const store=new TaskStore(join(directory,'r1.sqlite'),{recover:false,durable:true});
  const anchor=new DatabaseSync(join(directory,'witness.sqlite'));
  let worker,workerClosed=false,engineExecuted=false,observation,identitySample={engine,healthy:true,active:0,resident:0,attestation:null},executionError;
  try{
    anchor.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE witness(pin, sequence, head);');
    check(anchor.prepare('PRAGMA journal_mode').get().journal_mode==='wal' &&
      anchor.prepare('PRAGMA synchronous').get().synchronous===2,'R1_ANCHOR_STORAGE');
    const witness={
      read:()=>anchor.prepare('SELECT * FROM witness').get(),
      advance(from,to){
        check(to.pin===upstream.pin && to.sequence===from.sequence+1 &&
          anchor.prepare('UPDATE witness SET sequence=?, head=? WHERE pin=? AND sequence=? AND head=?')
            .run(to.sequence,to.head,from.pin,from.sequence,from.head).changes===1,'R1_ANCHOR_DRIFT');
        return witness.read();
      },
    };
    const execute=async ({binding:lease,signal:workerSignal})=>{
        if(nxInstalled){check(!engineExecuted,'NX_EXECUTE_REPEATED');engineExecuted=true;}
        try{
          const intent=store.db.prepare('SELECT phase,attempt_id FROM v08_intents WHERE job_id=?').get(lease.jobId);
          check(intent?.phase==='INTENT' && intent.attempt_id===lease.attemptId && witness.read().sequence===2,
            'R1_DISPATCH_WITHOUT_INTENT');
          emit('R1_INTENT',{productAttempt:binding.attemptId,r1Attempt:lease.attemptId,phase:intent.phase});
          const combined=AbortSignal.any([signal,...(workerSignal?[workerSignal]:[]),...(worker?.signal?[worker.signal]:[])]);
          try{
            observation=await runEngineUnit({binding:lease,engine,mode,signal:combined,publish});
          }finally{
            // 任何不完整啟動或回收都維持不明，不能成為 R1 終態的資源樣本。
            if(!observation) identitySample={...identitySample,healthy:false};
          }
          const {terminal,proof}=observation;
          check(proof.unitExited===true && unitIsGone() &&
            terminal.engine===engine && JSON.stringify(terminal.binding)===JSON.stringify(lease) &&
            terminal.stateHidden===true && terminal.requests===1 && terminal.observedMs<=90000 &&
            validEngineEvidence(terminal.engineEvidence,lease,512,identity.mode) &&
            terminal.engineEvidence.responseSha256===sha(terminal.output) &&
            terminal.usage?.completion_tokens===terminal.engineEvidence.evalCount,'R1_ENGINE_RECEIPT');
          identitySample={...identitySample,attestation:terminal.engineEvidence.attestation};
          return {attemptId:lease.attemptId,terminal:true,outcome:'SUCCEEDED',engine,
            engineEvidence:terminal.engineEvidence};
        }catch(error){executionError=error;throw error;}
    };
    if(nxInstalled){
      worker=await startNxWorker({execute,sample:()=>identitySample,witness,signal});
      identity.workerPublicKey=worker.publicKey;
      const publicDer=key=>key.export({type:'spki',format:'der'}).toString('hex');
      writeNxReceipt('upstream-identity.json',{...identity,workerPublicKey:publicDer(identity.workerPublicKey),
        controllerPublicKey:publicDer(identity.controllerPublicKey),workerPid:worker.pid});
    }
    const upstream=createUpstreamClient({identity,controllerPrivateKey:controllerKeys.privateKey,
      exchange:(wire,requestSignal)=>worker.receive(wire,requestSignal)});
    anchor.prepare('INSERT INTO witness VALUES (?,?,?)').run(upstream.pin,0,'0'.repeat(64));
    if(nxInstalled)await worker.initialize(identity);
    else{
      const options={database:upstreamDB,identity,workerPrivateKey:workerKeys.privateKey};
      worker=openSimulationWorker({...options,storage:provisionSimulationWorker(options),witness,
        sample:()=>identitySample,execute});
      await worker.ready;
    }
    const now=Math.floor(Date.now()/1000);
    const ran=await runDurableOnce({store,upstream,identity,approval:launch?.value.approval??{notBefore:now-5,expires:now+430},signal});
    const pending=store.db.prepare('SELECT phase,attempt_id FROM v08_intents WHERE job_id=?').get(ran.binding.jobId);
    check(pending?.phase==='HOLD' && pending.attempt_id===ran.binding.attemptId,'R1_POSTRUN_HOLD');
    if(executionError) throw executionError;
    check(ran.stage==='HOST_RESTORE_PENDING' && observation?.proof.unitExited===true && unitIsGone() &&
      witness.read().sequence===3,'R1_DEFERRED_EVIDENCE');
    const {terminal,proof}=observation;
    signal.throwIfAborted();
    let nxAuthority;
    if(launch){
      await worker.close();
      workerClosed=true;
      nxAuthority=await requireNxRestored({launch,proof,binding:ran.binding,evidenceSha256:hash(ran.evidence),
        workerPid:worker.pid,signal});
    }
    const permit=Object.freeze({invocation:proof.invocation,token:proof.token,topologySha256:proof.topologySha256,
      verifiedAt:verifyRestoredUnit(proof),productBindingSha256:hash(binding),r1BindingSha256:hash(ran.binding),
      engineEvidenceSha256:hash(terminal.engineEvidence),evidenceSha256:hash(ran.evidence),...(nxAuthority?{nxAuthority}:{})});
    const verifier=createUpstreamAuditVerifier(identity);
    const durable=createDurableCleanup(store,{upstream:verifier,authorizeRecovery:()=>null,
      authorizeRestore:(present,r1Binding,audit)=>present===permit && hash(r1Binding)===permit.r1BindingSha256 &&
        hash(audit.evidence)===permit.evidenceSha256 && audit.observedAt<=permit.verifiedAt &&
        verifyRestoredUnit(proof)-permit.verifiedAt<=30000});
    if(launch)checkNxObserver(launch);
    const committed=durable.releaseRestored(ran.binding.jobId,permit);
    const event=store.db.prepare('SELECT event,data FROM v08_audit WHERE job_id=? ORDER BY seq DESC LIMIT 1')
      .get(ran.binding.jobId);
    check(committed.phase==='RELEASED' && event.event==='HOST_RESTORED_RELEASE' &&
      store.get(ran.binding.jobId).cleanup?.confirmed===true &&
      JSON.parse(event.data).restoreSha256===hash(permit),'R1_RELEASE_COMMIT');
    const restoration={verifiedAt:permit.verifiedAt,committedAt:Date.now(),topologySha256:permit.topologySha256,
      r1JobId:ran.binding.jobId,r1AttemptId:ran.binding.attemptId,r1ReleaseSha256:hash(permit),
      evidenceSha256:permit.evidenceSha256};
    emit('R1_RELEASED',{productAttempt:binding.attemptId,r1Attempt:ran.binding.attemptId,unitExited:true,
      topologySha256:restoration.topologySha256,r1ReleaseSha256:restoration.r1ReleaseSha256,
      kernelPeakBytes:terminal.engineEvidence.peakBytes,requestMs:terminal.observedMs});
    return {terminal,restoration,engine};
  }finally{try{if(!workerClosed)await worker?.close();}finally{anchor.close();store.close();}}
}

async function checkResponse(response,mode,canSeeProvisional){
  if(mode==='json'||mode==='legacy-json'){
    const body=await response.json();
    check(response.status===200,typeof body.error?.code==='string'?body.error.code:'ENGINE_API_JSON_STATUS');
    check(body.acm_source==='ISOLATED_REAL_ENGINE' && typeof body.choices?.[0]?.text==='string',
      'ENGINE_API_JSON_OUTPUT');
    return {output:body.choices[0].text,usage:body.usage,deltaCount:0};
  }
  check(response.status===200 && /^text\/event-stream/.test(response.headers.get('content-type')??''),
    'ENGINE_API_SSE_STATUS');
  let output='',usage,count=0,done=false,finish=false,provisionalReceivedWhileLocked=false;
  for await(const row of lines(response.body)){
    if(row==='')continue;
    check(row.startsWith('data: ') && !done,'ENGINE_API_SSE_FRAME');
    const content=row.slice(6);
    if(content==='[DONE]'){done=true;continue;}
    const frame=JSON.parse(content),fragment=frame.choices?.[0]?.text,reason=frame.choices?.[0]?.finish_reason;
    check(!frame.error && frame.acm_source==='ISOLATED_REAL_ENGINE','ENGINE_API_SSE_FAILURE');
    if(reason){check(!finish && frame.acm_provisional!==true,'ENGINE_API_SSE_FINISH');finish=true;}
    if(typeof fragment==='string' && fragment.length){
      check(!finish && frame.acm_provisional===true,'ENGINE_API_SSE_NOT_LIVE');
      provisionalReceivedWhileLocked ||= canSeeProvisional();
      output+=fragment;
      count++;
    }
    if(frame.usage){check(finish && !usage,'ENGINE_API_SSE_USAGE');usage=frame.usage;}
  }
  check(count>0 && finish && done && usage && provisionalReceivedWhileLocked,'ENGINE_API_SSE_INCOMPLETE');
  return {output,usage,deltaCount:count};
}

async function run(mode){
  check(['json','sse','legacy-json'].includes(mode) && process.argv.length===3,'ENGINE_PROBE_MODE');
  const metadataSha=guestBoundary(mode),boot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  const jsonReceipt=state+'/json-pass.json';
  if(mode==='sse'){
    protectedFile(jsonReceipt);
    const first=JSON.parse(readFileSync(jsonReceipt,'utf8'));
    check(first.verdict==='PASS_ISOLATED_REAL_ENGINE_JSON' && first.boot===boot &&
      first.metadataSha===metadataSha,'ENGINE_JSON_NOT_QUALIFIED');
  }
  const launch=nxInstalled?nxLaunch():null;
  const directory=mkdtempSync(join(state,'r3-'+mode+'-'));
  const authority=generateKeyPairSync('ed25519'),key=generateKeyPairSync('ed25519');
  const now=Date.now(),runtime=protectedFile(binary);
  const claim={id:randomUUID(),scope:'ACM_V1_ISOLATED_ENGINE_ONCE_V1',source:'ISOLATED_REAL_ENGINE',
    ...(mode==='legacy-json'?{memoryMode:LEGACY_MODE}:{}),
    store:provisionQualificationStore(directory),epoch:randomUUID(),workerKey:workerKeyPin(key.publicKey),
    node:launch?{id:'orin-nx-legacy-cpu',resource:launch.value.resource,aliases:['nx-legacy-once'],platform:'aarch64-linux'}:
      {id:'isolated-arm64-ollama',resource:hash([boot,source]),aliases:['r3-fixture'],platform:'arm64-qemu'},
    model:{id:model,digest,device:'cpu',context:512,maxTokens:MAX_TOKENS},
    transport:protectedFile(new URL(import.meta.url).pathname),
    runtime,evidence:hash([capacityPin,metadataSha,...(mode==='legacy-json'?[LEGACY_MODE]:[])]),notBefore:now-1000,expiresAt:now+480000};
  const pin=hash(claim),context={pin,epoch:claim.epoch};
  if(launch)writeNxReceipt('qualification-identity.json',{claim,
    authorityPublicKey:authority.publicKey.export({type:'spki',format:'der'}).toString('hex'),
    workerPublicKey:key.publicKey.export({type:'spki',format:'der'}).toString('hex')});
  let controller,journal,productTerminal,dispatches=0,deltaSequence=0,provisionalWhileLocked=0,dispatchError;
  const worker=createQualifiedWorker({
    ...(mode==='legacy-json'?{expectedMemoryMode:LEGACY_MODE}:{}),
    admission:seal(authority.privateKey,'ADMISSION',claim),
    authorityPublicKey:authority.publicKey,workerPublicKey:key.publicKey,
    async exchange(request,{signal,onDelta}){
      signal.throwIfAborted();
      check(request.pin===pin,'ENGINE_WORKER_PIN');
      const bind=request.binding;
      if(request.operation==='ready'){
        check(dispatches===0 && unitIsGone(),'ENGINE_WORKER_NOT_READY');
        return seal(key.privateKey,'READY',{...context,at:Date.now(),nonce:request.nonce,
          healthy:true,active:0,resident:0});
      }
      if(request.operation==='execute'){
        check(++dispatches===1 && request.kind==='completion' && request.input===REAL_PROMPT &&
          request.maxTokens===MAX_TOKENS,'ENGINE_PRODUCT_REQUEST');
        const snap=controller.snapshot();
        check(snap.jobs.find(job=>job.id===bind.jobId)?.state==='RUNNING' &&
          snap.locks.some(lock=>lock.attemptId===bind.attemptId) &&
          snap.events.some(row=>row.attemptId===bind.attemptId && row.event==='INTENT'),'ENGINE_PRODUCT_INTENT');
        emit('PRODUCT_INTENT',{productAttempt:bind.attemptId});
        try{
          journal=await roundTripR1({directory,binding:bind,claim,runtime,signal,mode,publish(content){
            check(mode==='sse','ENGINE_UNEXPECTED_DELTA');
            if(controller.snapshot().locks.some(lock=>lock.attemptId===bind.attemptId)) provisionalWhileLocked++;
            onDelta(seal(key.privateKey,'DELTA',{...context,binding:bind,sequence:++deltaSequence,content}));
          }});
        }catch(error){dispatchError=error;throw error;}
        const {terminal,engine}=journal;
        const result={outcome:'SUCCEEDED',output:terminal.output,usage:terminal.usage,code:null,
          finishReason:terminal.engineEvidence.doneReason};
        productTerminal=seal(key.privateKey,'TERMINAL',{...context,binding:bind,at:Date.now(),result,engine});
        return productTerminal;
      }
      check(request.operation==='sample' && journal && request.terminalSha256===hash(productTerminal) &&
        unitIsGone(),'ENGINE_RESTORE_NOT_CONFIRMED');
      if(launch)checkNxObserver(launch);
      const {engine,restoration}=journal;
      const restore=seal(authority.privateKey,'RESTORED',{...context,binding:bind,engine,...restoration,
        terminalSha256:request.terminalSha256,nonce:request.nonce});
      emit('PRODUCT_RELEASE_EVIDENCE',{productAttempt:bind.attemptId,r1Attempt:restoration.r1AttemptId});
      return seal(key.privateKey,'CLEARED',{...context,binding:bind,nonce:request.nonce,at:Date.now(),
        terminalSha256:request.terminalSha256,engine,healthy:true,active:0,resident:0,gpuResidentBytes:0,reclaimed:true,restore});
    },
  });
  controller=openController({dataDir:directory,mode:'engine-qualification',qualifiedWorker:worker,timeoutMs:120000});
  const secret=randomBytes(32).toString('base64url'), server=createHttpApp({controller,mode:'engine-qualification',
    tokens:[{id:'arm64-fixture',sha256:sha(secret),scopes:['models:run'],expiresAt:now+480000}],telemetry:{history:()=>[]}});
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const port=server.address().port;
    check(![8875,8897].includes(port),'ENGINE_API_PORT');
    let id,result;
    if(mode==='legacy-json'){
      try{result=await observeLegacyApiJob({model,request:(method,path,body)=>fetch('http://127.0.0.1:'+port+path,{
        method,signal:AbortSignal.timeout(5000),headers:{authorization:'Bearer '+secret,'content-type':'application/json',
          ...(method==='POST'?{'idempotency-key':claim.id}:{})},...(body?{body:JSON.stringify(body)}:{})})});}
      catch(error){throw dispatchError??error;}
      id=result.id;
    }else{
    const response=await fetch('http://127.0.0.1:'+port+'/v1/completions',{
      method:'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json',
        'idempotency-key':claim.id},body:JSON.stringify({model,prompt:REAL_PROMPT,max_tokens:MAX_TOKENS,
        ...(mode==='sse'?{stream:true,stream_options:{include_usage:true}}:{})}),
    });
    id=response.headers.get('x-acm-job-id');
    try{result=await checkResponse(response,mode,()=>provisionalWhileLocked>0 &&
      controller.snapshot().locks.some(lock=>lock.jobId===id));}
    catch(error){throw dispatchError??error;}
    }
    const job=controller.get(id);
    check(journal && dispatches===1 && result.output===journal.terminal.output &&
      JSON.stringify(result.usage)===JSON.stringify(journal.terminal.usage) && job.state==='SUCCEEDED' &&
      job.cleanup?.confirmed===true && controller.snapshot().locks.length===0 && unitIsGone(),'ENGINE_PRODUCT_COMMIT');
    const verdict=mode==='legacy-json'?(launch?'NX_LEGACY_BOUNDED_CPU_ACCEPT_LIMITED':'PASS_ISOLATED_LEGACY_BOUNDED_CPU'):
      mode==='json'?'PASS_ISOLATED_REAL_ENGINE_JSON':'PASS_ISOLATED_REAL_ENGINE_SSE';
    const receipt={verdict,boot,metadataSha,productAttempt:job.attemptId,r1Attempt:journal.restoration.r1AttemptId,
      r1ReleaseSha256:journal.restoration.r1ReleaseSha256,engineEvidenceSha256:hash(journal.terminal.engineEvidence),
      ...(mode==='legacy-json'?{memoryMode:LEGACY_MODE,peakBytes:journal.terminal.engineEvidence.peakBytes,
        sampledPeakBytes:journal.terminal.engineEvidence.sampledPeakBytes,memoryEvidence:journal.terminal.engineEvidence.memoryEvidence,
        apiContract:result.apiContract}:{}),
      requests:journal.terminal.requests,requestMs:journal.terminal.observedMs,usage:result.usage,
      provisionalFrames:result.deltaCount,productCommitted:true,unitReleased:true};
    if(mode==='json'||mode==='legacy-json'){
      writeFileSync(mode==='legacy-json'?state+'/legacy-pass.json':jsonReceipt,JSON.stringify(receipt),{flag:'wx',mode:0o400});
      chmodSync(mode==='legacy-json'?state+'/legacy-pass.json':jsonReceipt,0o400);
    }
    emit('INTEGRATION',receipt);
  }catch(error){
    emit('PRODUCT_STATE',{state:controller.snapshot().jobs.map(job=>job.state),
      phases:controller.snapshot().locks.map(lock=>lock.phase),dispatches});
    throw error;
  }finally{
    if(server.listening) await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    await controller.close();
  }
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await run(process.argv[2]).catch(error=>{
  emit('INTEGRATION',{verdict:'HOLD',mode:['json','sse','legacy-json'].includes(process.argv[2])?process.argv[2]:null,code:safeCode(error)});
  process.exitCode=42;
});
