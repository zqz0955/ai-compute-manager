import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes} from 'node:crypto';
import {execFile,spawnSync} from 'node:child_process';
import {existsSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {startService} from '../server.mjs';
import {createPinnedLegacyObserver,verifyLegacyCapture} from '../src/legacy-capture-auth.mjs';
import {projectLegacyTelemetry} from '../src/legacy-telemetry.mjs';
import {pinPath,assertPinned,sameIdentity,createPrivateRoot} from './lock.mjs';
import {readJson,snapshotFile,writeNewJson} from './files.mjs';

const execute=promisify(execFile);
const product=fileURLToPath(new URL('..',import.meta.url));
const reviewedManifest='57efb01e9ee690444810f40c87b7b484ced822c0dad6d0f6123cba88b086424d';
const sha=value=>createHash('sha256').update(value).digest('hex');
const failure=code=>Error(code);

export function reviewedObserverFiles(manifest){
  if(manifest?.sha256!==reviewedManifest||!manifest.value||
     Object.getPrototypeOf(manifest.value)!==Object.prototype) throw failure('H2_REVIEWED_OBSERVER_MANIFEST_REQUIRED');
  const names=Object.keys(manifest.value);
  if(names.length!==15||new Set(names.map(name=>name.toLowerCase())).size!==15||
     names.some(name=>! /^[A-Za-z][A-Za-z0-9-]{0,63}\.(?:mjs|ps1|py)$/.test(name)||
       !/^[A-Fa-f0-9]{64}$/.test(manifest.value[name]))) throw failure('H2_REVIEWED_OBSERVER_MANIFEST_REQUIRED');
  return names;
}

export function verifyObserverFiles(root,pins,snapshot=snapshotFile){
  for(const [name,expected] of pins){
    const current=snapshot(join(root,name),1048576);
    if(current.sha256!==expected.sha256||!sameIdentity(current.pin.id,expected.pin.id))
      throw failure('H2_OBSERVER_SOURCE_DRIFT');
  }
}

// 各項收尾互不掩蓋；即使關閉或撤銷失敗，也先保存安全化回條並維持 HOLD。
export async function finalizeQualification({record,close,revoke,removeAccess,writeReceipt,issuedIds=[]}){
  const safeCode=cause=>/^[A-Z][A-Z0-9_]{0,79}$/.test(cause?.code??'')?cause.code:
    /^[A-Z][A-Z0-9_]{0,79}$/.test(cause?.message??'')?cause.message:'H2_CLEANUP_FAILED';
  record.cleanupErrors=[];
  record.isolatedServiceStopped=false;
  record.tokensRevoked=[];
  async function step(stage,action){
    try{await action();return true;}catch(cause){
      record.cleanupErrors.push({stage,code:safeCode(cause)});record.status='HOLD';return false;
    }
  }
  if(close) record.isolatedServiceStopped=await step('SERVICE_CLOSE',close);
  else record.serviceLifecycle='NOT_STARTED';
  for(const id of issuedIds){
    if(await step('TOKEN_REVOKE',()=>revoke(id))) record.tokensRevoked.push(id);
  }
  if(removeAccess) record.temporaryAccessRemoved=await step('TEMPORARY_ACCESS_REMOVE',removeAccess);
  record.stoppedAt=new Date().toISOString();
  try{await writeReceipt(record);}catch{throw failure('H2_RECEIPT_WRITE_FAILED');}
  return record;
}

export function observerEnvironment(environment){
  return {SystemRoot:environment.SystemRoot,ProgramData:environment.ProgramData,COMPUTERNAME:environment.COMPUTERNAME,
    Path:join(environment.SystemRoot,'System32'),
    PSModulePath:join(environment.SystemRoot,'System32','WindowsPowerShell','v1.0','Modules')};
}

// 來源已核對但模型查詢失敗時，保留 null，不能把查詢錯誤轉成有效空清單。
export function verifyObservedView(view,frame,upstreamId,now=Date.now()){
  const sample=projectLegacyTelemetry(frame,upstreamId,now);
  assert.equal(view.id,upstreamId);
  assert.equal(view.source,'V06_V07_BRIDGE');
  assert.equal(view.status,'ONLINE');
  assert.equal(view.freshness,'FRESH');
  assert.equal(view.availability,'UNVERIFIED');
  assert.equal(view.metrics.sampledAt,sample.sampledAt);
  for(const key of ['cpuPercent','gpuPercent','ramUsedBytes','diskUsedBytes','swapUsedBytes','temperatureC'])
    assert.equal(view.metrics[key],sample.metrics[key]);
  for(const key of ['ramBytes','swapBytes','diskBytes']) assert.equal(view[key],sample.metrics[key]);
  assert.deepEqual(view.models?.map(({id,digest,sizeBytes})=>({name:id,digest,sizeBytes}))??null,sample.models);
  assert.deepEqual(view.resident,sample.resident?.map(row=>row.name)??null);
  return {nodeId:upstreamId,sampledAt:sample.sampledAt,source:view.source,metrics:sample.metrics,
    installedQuery:sample.models===null?'UNKNOWN':'VALID',installedCount:sample.models?.length??null,
    residentQuery:sample.resident===null?'UNKNOWN':'VALID',residentCount:sample.resident?.length??null,
    executionEligible:false,reason:'HARDWARE_AND_WORKER_QUALIFICATION_REQUIRED'};
}

export function captureIdentity(proof){
  if(!Number.isSafeInteger(proof?.pid)||proof.pid<1||!/^\d{16,20}$/.test(proof.createdTicks??'')||
     proof.port!==8875||proof.address!=='127.0.0.1'||proof.manifestEntries!==588||
     !/^[A-F0-9]{64}$/.test(proof.runtimeSha256??'')||!/^[A-F0-9]{64}$/.test(proof.manifestSha256??'')||
     typeof proof.owner!=='string'||typeof proof.image!=='string'||typeof proof.command!=='string')
    throw failure('H2_SOURCE_ATTESTATION_INVALID');
  return sha(JSON.stringify(['ACM_H2_NATIVE_OBSERVER_V1',proof.pid,proof.createdTicks,proof.owner,
    proof.image,proof.command,proof.runtimeSha256,proof.manifestSha256]));
}

export async function qualifyLiveTelemetry({bridgeRoot,workspace,receiptPath}){
  if(process.platform!=='win32'||process.versions.node!=='24.22.3') throw failure('H2_WINDOWS_RUNTIME_REQUIRED');
  const bridge=pinPath(bridgeRoot,'directory');
  const manifest=readJson(join(bridge.path,'release-sha256.json'));
  const inputs=reviewedObserverFiles(manifest);
  const pins=new Map(inputs.map(name=>{
    const entry=snapshotFile(join(bridge.path,name),1048576);
    if(entry.sha256!==manifest.value[name]?.toLowerCase()) throw failure('H2_OBSERVER_SOURCE_DRIFT');
    return [name,entry];
  }));
  const settings=readJson(join(bridge.path,'settings.json'));
  const python=snapshotFile(settings.value.python,1048576);
  if(python.sha256!==settings.value.pythonSha?.toLowerCase()) throw failure('H2_PYTHON_RUNTIME_DRIFT');
  const ps=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  function checkSource(){
    assertPinned(bridge);
    assertPinned(manifest.pin);
    if(snapshotFile(manifest.pin.path,65536).sha256!==manifest.sha256) throw failure('H2_OBSERVER_MANIFEST_DRIFT');
    assertPinned(settings.pin);
    if(snapshotFile(settings.pin.path,4096).sha256!==settings.sha256) throw failure('H2_OBSERVER_SETTINGS_DRIFT');
    verifyObserverFiles(bridge.path,pins);
    if(snapshotFile(settings.value.python,1048576).sha256!==python.sha256) throw failure('H2_PYTHON_RUNTIME_DRIFT');
  }
  const childEnv=observerEnvironment(process.env);
  async function attest(){
    checkSource();
    const command="& ([scriptblock]::Create([IO.File]::ReadAllText('"+
      pins.get('v06-attestation.ps1').pin.path.replaceAll("'","''")+"')))";
    let stdout;
    try{
      ({stdout}=await execute(ps,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],
        {env:childEnv,windowsHide:true,timeout:20000,maxBuffer:65536}));
    }catch(cause){throw failure('H2_ATTESTATION_'+(cause.stderr?.match(/\b(?:FORMAL|SOURCE)_[A-Z_]+\b/)?.[0]??'FAILED'));}
    checkSource();
    return JSON.parse(stdout);
  }
  const initialProof=await attest(),sourceIdentity=captureIdentity(initialProof);
  const {projectCapture}=await import(pathToFileURL(pins.get('live-readonly.mjs').pin.path));
  async function capture(){
    checkSource();
    const {stdout}=await execute(settings.value.python,['-I','-S','-B',pins.get('v06-loopback.py').pin.path,
      String(initialProof.pid),'release',initialProof.createdTicks],
      {env:childEnv,windowsHide:true,timeout:15000,maxBuffer:6*1024*1024});
    checkSource();
    return projectCapture(JSON.parse(stdout),'V06_LOOPBACK_VERIFIED');
  }
  let frame=await capture();
  const ids=frame.nodes.map(row=>row.node.id);
  if(ids.length!==2||new Set(ids).size!==2) throw failure('H2_DEVICE_COUNT_MISMATCH');
  for(const id of ids) projectLegacyTelemetry(frame,id);
  const authority=generateKeyPairSync('ed25519');
  const observerKey=authority.publicKey.export({type:'spki',format:'der'}).toString('base64url');
  let sourceAvailable=true;
  const observe=createPinnedLegacyObserver({sourceIdentity,privateKey:authority.privateKey,
    resolveIdentity:async()=>sourceAvailable?captureIdentity(await attest()):'0'.repeat(64),capture:async()=>frame});
  const scope=createPrivateRoot(workspace),installation=join(scope,'installed');
  const actualIdentity=spawnSync(join(process.env.SystemRoot,'System32','whoami.exe'),['/user','/fo','csv','/nh'],
    {windowsHide:true,encoding:'utf8',timeout:5000});
  if(actualIdentity.status!==0) throw failure('H2_OPERATOR_IDENTITY_UNAVAILABLE');
  const actualSid=actualIdentity.stdout.match(/S-1-5-[0-9-]+/u)?.[0];
  if(!actualSid) throw failure('H2_OPERATOR_IDENTITY_UNAVAILABLE');
  const record={version:1,startedAt:new Date().toISOString(),pid:process.pid,mode:'READ_ONLY',
    executionContext:{operatorSid:actualSid,observerPid:process.pid,apiPid:process.pid,
      separation:'SAME_PROCESS_TRUSTED_MANAGEMENT_TEST',nativeV07Pipe:'NOT_EXECUTED',
      apiRunnerCrossSid:'NOT_EXECUTED'},
    source:{identitySha256:sourceIdentity,pid:initialProof.pid,createdTicks:initialProof.createdTicks,
      runtimeSha256:initialProof.runtimeSha256,manifestSha256:initialProof.manifestSha256,manifestEntries:588},
    observerManifestSha256:reviewedManifest,verifiedObserverFiles:inputs,checks:[],cycles:[],generationRequests:0,remoteWrites:0};
  let app,reader,runner,uiAccess;
  const issuedIds=[];
  function cli(script,args,input){
    const reply=spawnSync(process.execPath,[join(product,script),...args],{
      cwd:product,encoding:'utf8',windowsHide:true,timeout:40000,input});
    if(reply.status!==0) throw failure('H2_CLI_'+(reply.stderr.match(/ACM_\w+ ([A-Z0-9_]+)/)?.[1]??'FAILED'));
    return JSON.parse(reply.stdout);
  }
  async function relaySign(state,challenge,envelope){
    return await new Promise((resolve,reject)=>{
      const child=execFile(process.execPath,[join(product,'tools/relay-telemetry.mjs'),'sign',state,challenge],
        {cwd:product,encoding:'utf8',windowsHide:true,timeout:40000,maxBuffer:1048576},(cause,stdout)=>{
          if(cause) return reject(failure('H2_RELAY_SIGN_FAILED'));
          try{resolve(JSON.parse(stdout));}catch{reject(failure('H2_RELAY_OUTPUT_INVALID'));}
        });
      child.stdin.end(JSON.stringify(envelope));
    });
  }
  const check=(name,condition)=>{assert.ok(condition,name);record.checks.push({name,status:'PASS',at:new Date().toISOString()});};
  async function call(path,token,body){
    const response=await fetch('http://127.0.0.1:'+app.info.port+path,{redirect:'error',
      signal:AbortSignal.timeout(10000),headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},
      ...(body?{method:'POST',body:JSON.stringify(body)}:{})});
    return {status:response.status,value:await response.json()};
  }
  try{
    cli('tools/rc.mjs',['setup',installation,'--monitor-local']);
    const devices=ids.map((id,index)=>{
      const relay=join(scope,'relay-'+index);
      const key=cli('tools/relay-telemetry.mjs',['init',relay,id,id,observerKey,sourceIdentity]);
      return {id,relay,source:{nodeId:id,name:frame.nodes[index].node.name,publicKey:key.publicKey,
        kind:'V06_V07_BRIDGE',tokenId:'h2-publisher-'+index}};
    });
    const config=readJson(join(installation,'config.json'));
    writeFileSync(config.pin.path,JSON.stringify({...config.value,port:0,
      monitoring:{windowsLocal:true,sources:devices.map(row=>row.source)}}));
    const token=(id,scope)=>{
      const result=cli('tools/rc.mjs',['token','issue',installation,id,scope,'1']);
      issuedIds.push(id);
      return result.token;
    };
    reader=token('h2-reader','manage:read');runner=token('h2-disabled-runner','models:run');
    for(const device of devices) device.token=token(device.source.tokenId,'telemetry:publish');
    app=await startService(config.pin.path,{audit:row=>record.lastAudit={event:row.event,code:row.code}});
    record.endpoint={host:app.info.host,port:app.info.port};
    check('DYNAMIC_LOOPBACK',app.info.host==='127.0.0.1'&&![8875,8897,11434].includes(app.info.port));
    check('READER_CANNOT_PUBLISH',(await call('/acm/v1/telemetry/challenge',reader,{nodeId:ids[0]})).status===403);
    check('PUBLISHER_CANNOT_READ',(await call('/acm/v1/nodes',devices[0].token)).status===403);
    check('CROSS_NODE_SCOPE_DENIED',(await call('/acm/v1/telemetry/challenge',devices[0].token,{nodeId:ids[1]})).status===403);
    async function publishCycle(){
      record.currentStage='SOURCE_CAPTURE';
      frame=await capture();
      const cycle={capturedAt:frame.capturedAt,nodes:[]};
      // 兩個節點不共用 signer 或 challenge；並行核對可避免驗收本身消耗第二台的 15 秒新鮮度。
      // 原生來源世代前後核對、簽章與來源時間均維持原守門，不能改寫 sample 時間。
      const published=await Promise.allSettled(devices.map(async device=>{
        const candidateSample=projectLegacyTelemetry(frame,device.id);
        if(candidateSample.sampledAt<=(device.lastSampleAt??0)) return null;
        record.currentStage='CHALLENGE_'+device.id;
        const request=await call('/acm/v1/telemetry/challenge',device.token,{nodeId:device.id});
        assert.equal(request.status,200);
        const challenge=request.value.challenge;
        record.currentStage='OBSERVER_SIGNATURE_'+device.id;
        const envelope=await observe({challenge,upstreamNodeId:device.id});
        verifyLegacyCapture(envelope,{sourceIdentity,observerKey,upstreamNodeId:device.id,challenge});
        assert.throws(()=>verifyLegacyCapture(envelope,{sourceIdentity,observerKey,upstreamNodeId:device.id,
          challenge:randomBytes(32).toString('base64url')}),/LEGACY_OBSERVER_PROOF_REJECTED/);
        record.currentStage='RELAY_SIGNATURE_'+device.id;
        const signed=await relaySign(device.relay,challenge,envelope);
        record.currentStage='PUBLISH_'+device.id;
        const accepted=await call('/acm/v1/telemetry/snapshot',device.token,{nodeId:device.id,snapshot:signed});
        record.checks.push({name:'INGEST',nodeId:device.id,status:accepted.status,sampledAt:candidateSample.sampledAt,
          ingestedAt:Date.now(),sampleAgeMs:Date.now()-candidateSample.sampledAt});
        assert.equal(accepted.status,200);
        assert.equal((await call('/acm/v1/telemetry/snapshot',device.token,{nodeId:device.id,snapshot:signed})).status,400);
        const dashboard=(await call('/acm/v1/dashboard',reader)).value;
        record.currentStage='DASHBOARD_COMPARE_'+device.id;
        const observed=verifyObservedView(dashboard.nodes.find(row=>row.id===device.id),frame,device.id);
        for(const suffix of ['', '/models','/resident']){
          record.currentStage='MANAGEMENT_QUERY_'+device.id+suffix;
          const response=await call('/acm/v1/nodes/'+device.id+suffix,reader);
          const expectedStatus=suffix==='/models'&&candidateSample.models===null||
            suffix==='/resident'&&candidateSample.resident===null?503:200;
          record.checks.push({name:'MANAGEMENT_QUERY'+suffix,nodeId:device.id,status:response.status,
            expectedStatus,sampledAt:candidateSample.sampledAt,queriedAt:Date.now()});
          assert.equal(response.status,expectedStatus);
        }
        device.lastSampleAt=candidateSample.sampledAt;
        assert.equal(dashboard.jobs.length,0);
        assert.equal(dashboard.locks.length,0);
        return observed;
      }));
      const failed=published.find(result=>result.status==='rejected');
      if(failed) throw failed.reason;
      cycle.nodes=published.map(result=>result.value).filter(Boolean);
      return cycle;
    }
    for(let round=0;round<2;round++){
      if(round) await delay(5000);
      const cycle=await publishCycle();
      assert.equal(cycle.nodes.length,2);
      record.cycles.push(cycle);
    }
    check('TWO_LIVE_SIGNED_DEVICE_CYCLES',record.cycles.length===2);
    const dashboard=(await call('/acm/v1/dashboard',reader)).value;
    const placement=dashboard.placement;
    check('LIVE_READONLY_PLACEMENT_REJECTED',placement?.kind==='READ_ONLY_ADMISSION'&&placement.status==='REJECTED');
    assert.deepEqual(placement.selection,[]);
    check('PLACEMENT_NO_DISPATCH_OR_RESERVATION',placement.reservationPerformed===false&&placement.dispatchPerformed===false);
    assert.equal(placement.nodes.length,3);
    for(const candidate of placement.nodes){
      const observed=dashboard.nodes.find(node=>node.id===candidate.nodeId);
      assert.ok(observed);
      assert.equal(candidate.source,observed.source);assert.equal(candidate.freshness,'FRESH');
      assert.equal(candidate.eligible,false);assert.equal(candidate.executionQualification,'NOT_EVALUATED');
      assert.deepEqual(candidate.reasons,['READ_ONLY_MODE','OBSERVATION_NOT_EXECUTION_QUALIFICATION']);
    }
    record.placement=placement;
    check('THREE_REAL_NODE_ADMISSION_REASONS',true);
    const local=dashboard.nodes.find(row=>row.id==='windows-local');
    check('WINDOWS_NATIVE_MONITOR',local?.source==='WINDOWS_LOCAL'&&local.freshness==='FRESH'&&
      Number.isFinite(local.metrics.cpuPercent)&&local.ramBytes>0&&local.diskBytes>0);
    record.windows={source:local.source,metrics:local.metrics,ramBytes:local.ramBytes,diskBytes:local.diskBytes};
    check('MODEL_INFERENCE_REJECTED',(await call('/v1/chat/completions',runner,
      {model:'qualification-disabled',messages:[{role:'user',content:'read-only admission'}],max_tokens:1})).status===403);
    const last=record.cycles.at(-1);
    sourceAvailable=false;
    await assert.rejects(observe({challenge:randomBytes(32).toString('base64url'),upstreamNodeId:ids[0]}),/LEGACY_OBSERVER_PROOF_REJECTED/);
    check('INJECTED_SOURCE_IDENTITY_LOSS_REJECTED',true);
    // 僅停止本次轉送，不停止上游服務，用實際經過時間核對過期遮蔽。
    await delay(16000);
    const stale=(await call('/acm/v1/dashboard',reader)).value;
    for(const id of ids){
      const row=stale.nodes.find(node=>node.id===id);
      check('STALE_MASK_'+id,row.freshness==='STALE'&&row.status==='UNKNOWN'&&row.metrics.cpuPercent===null&&
        row.metrics.gpuPercent===null&&row.models===null&&row.resident===null);
      assert.equal(row.metrics.sampledAt,last.nodes.find(node=>node.nodeId===id).sampledAt);
      const history=(await call('/acm/v1/dashboard/history?nodeId='+id,reader)).value.samples;
      check('LIVE_HISTORY_'+id,history.length===2&&history.every(sample=>sample.source==='V06_V07_BRIDGE'));
      const rejected=stale.placement.nodes.find(node=>node.nodeId===id);
      check('STALE_PLACEMENT_REJECTED_'+id,rejected?.eligible===false&&rejected.reasons.includes('TELEMETRY_STALE'));
    }
    check('NO_JOB_OR_RESOURCE_RESERVATION',stale.jobs.length===0&&stale.locks.length===0);
    sourceAvailable=true;
    check('SOURCE_PROCESS_PRESERVED',captureIdentity(await attest())===sourceIdentity);
    await publishCycle();
    uiAccess=writeNewJson(join(scope,'ui-access.json'),{url:'http://127.0.0.1:'+app.info.port,token:reader,
      purpose:'TEMPORARY_READONLY_BROWSER_CHECK_NOT_FOR_ARCHIVE'});
    console.log('H2_UI_READY '+JSON.stringify({port:app.info.port,workspace:scope,maximumSeconds:300}));
    const uiDeadline=Date.now()+300000;
    while(Date.now()<uiDeadline){
      const done=join(scope,'ui-done.json');
      if(existsSync(done)){
        assert.deepEqual(readJson(done).value,{done:true});
        record.uiControl='COMPLETED';
        break;
      }
      await delay(5000);
      await publishCycle();
    }
    record.uiControl??='TIME_LIMIT_REACHED';
    record.status='PASS_LIVE_READONLY_TELEMETRY';
    record.sourceFailureTest='INJECTED_OBSERVER_IDENTITY_LOSS_AND_REAL_ELAPSED_STALENESS';
    record.h5='OBSERVED_ONLY_NO_QUALIFIED_EXECUTION_NODE';
  }catch(cause){
    record.status='HOLD';
    record.failure=/^[A-Z0-9_]+$/.test(cause?.message??'')?cause.message:cause?.code??'H2_ASSERTION_OR_SOURCE_FAILURE';
    record.failedStage=record.currentStage??record.checks.at(-1)?.name??'START';
    record.failureDetail={code:cause.code??null,
      actual:typeof cause.actual==='number'||typeof cause.actual==='boolean'?cause.actual:null,
      expected:typeof cause.expected==='number'||typeof cause.expected==='boolean'?cause.expected:null,
      location:cause.stack?.match(/h2-live-telemetry\.mjs:\d+:\d+/)?.[0]??null};
    throw cause;
  }finally{
    await finalizeQualification({record,issuedIds,close:app?()=>app.close():null,
      revoke:id=>cli('tools/rc.mjs',['token','revoke',installation,id]),
      removeAccess:uiAccess?()=>{assertPinned(uiAccess);unlinkSync(uiAccess.path);}:null,
      writeReceipt:value=>writeNewJson(receiptPath,value)});
  }
  return record;
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const [bridgeRoot,workspace,receiptPath,...extra]=process.argv.slice(2);
  try{
    if(extra.length||!bridgeRoot||!workspace||!receiptPath) throw failure('H2_EXPECTED_BRIDGE_WORKSPACE_RECEIPT');
    const result=await qualifyLiveTelemetry({bridgeRoot,workspace,receiptPath});
    console.log(JSON.stringify({status:result.status,checks:result.checks.length,cycles:result.cycles.length,
      endpoint:result.endpoint,isolatedServiceStopped:result.isolatedServiceStopped}));
    if(result.status!=='PASS_LIVE_READONLY_TELEMETRY') process.exitCode=1;
  }catch(cause){
    console.error('H2_HOLD '+(/^[A-Z0-9_]+$/.test(cause?.message??'')?cause.message:cause?.code??'H2_SOURCE_OR_CHECK_FAILED'));
    process.exitCode=1;
  }
}
