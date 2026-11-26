import {gunzipSync} from 'node:zlib';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fail, sha } from '../../src/worker/r1/ollama-once.mjs';
import { lines } from './integration-stream.mjs';
import {createLegacySliceWatch} from './legacy-slice-watch.mjs';
import {readLegacySliceSample,readLegacyTail} from './legacy-tail.mjs';
import {startLegacySlice,stopLegacySlice,legacySliceGone,LEGACY_GROUP,LEGACY_SLICE,LEGACY_SERVICE} from './legacy-slice.mjs';

import {NX_ENGINE,NX_CODE,NX_AUDIT,NX_STAGE,nxInstalled,nxH3Mode} from '../nx-legacy/layout.mjs';
import {nxLaunch,writeNxReceipt,checkNxObserver} from '../nx-legacy/authority.mjs';

const root=nxInstalled ? NX_ENGINE : '/opt/acm-rc2-engine-readiness';
export const source=nxInstalled ? NX_CODE : '/opt/acm-r3-code';
export const state=nxInstalled ? NX_AUDIT+'/work' : source+'/src/tools/fixtures/work';
export const unit='acm-rc2-engine-readiness.service';
const bounds='/sys/fs/cgroup';
const slice=bounds+'/system.slice';
const unitPath=slice+'/'+unit;
const env={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'};
const prefix='ACM_R3_ENGINE_PIPE ';
const text=path=>readFileSync(path,'utf8').trim();
const check=(ok,code)=>{if(!ok)throw fail(code);};
export const emit=(stage,fields)=>console.log('ACM_R3_'+stage+'='+JSON.stringify(fields));
export const safeCode=error=>typeof error?.code==='string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
  ?error.code:'ENGINE_INTEGRATION_UNCLASSIFIED';

export function publishEngineDelta(mode, frame, publish) {
  check((mode==='sse'||mode==='legacy-sse')&&typeof frame.content==='string'&&frame.content.isWellFormed(),'ENGINE_UNIT_DELTA');
  publish(frame.content);
}

export function guestBoundary(mode='json'){
  const legacy=mode==='legacy-json'||mode==='legacy-sse';
  if(nxInstalled){
    check(mode===(nxH3Mode??'legacy-json')&&process.platform==='linux'&&process.arch==='arm64'&&process.versions.node==='24.22.3'&&
      process.execPath===source+'/runtime/node'&&protectedFile(process.execPath)==='8f9c2a55879e9705cb285b6cdd649d95df642c6720f052cb30f300d2677da99f'&&
      /Orin NX/.test(text('/proc/device-tree/model'))&&text('/proc/1/comm')==='systemd'&&unitIsGone()&&legacySliceGone(),
      'NX_ENGINE_OUTER_BOUNDARY');
    return nxLaunch().sha256;
  }
  check(process.platform==='linux' && process.arch==='arm64' && process.versions.node==='24.22.3' &&
    process.getuid()===0 && process.getgid()===0 && process.execPath===source+'/runtime/node' &&
    /QEMU/.test(text('/sys/class/dmi/id/product_name')) && text('/proc/1/comm')==='systemd' &&
    !text('/proc/net/route').split('\n').slice(1).some(line=>line.trim().split(/\s+/)[1]==='00000000') &&
    text('/proc/self/net/ipv6_route').split('\n').every(line=>!/^0{32} 00 .* (?!lo$)\S+$/.test(line)),
    'ENGINE_OUTER_BOUNDARY');
  check(protectedFile(process.execPath)==='8f9c2a55879e9705cb285b6cdd649d95df642c6720f052cb30f300d2677da99f',
    'ENGINE_NODE_PIN');
  const work=lstatSync(state);
  check(work.isDirectory() && work.uid===0 && work.gid===0 && (work.mode&0o777)===0o700 &&
    realpathSync(state)===state,'ENGINE_OUTER_STATE');
  const receipt=source+(legacy?'/legacy-preflight-pass.json':'/metadata-pass.json');
  const receiptSha=protectedFile(receipt);
  const gate=JSON.parse(text(receipt));
  check(gate.verdict===(legacy?'PASS_LEGACY_NATIVE_PREFLIGHT':'PASS_METADATA_ONLY') && gate.unitAndCgroupReleased===true && gate.generationRequests===0,
    'ENGINE_P0_NOT_QUALIFIED');
  check(unitIsGone(),'ENGINE_UNIT_ALREADY_PRESENT');
  return receiptSha;
}

export function protectedFile(path) {
  const id=lstatSync(path);
  check(id.isFile() && id.uid===0 && id.gid===0 && id.nlink===1 &&
    !(id.mode&0o222) && realpathSync(path)===path,'ENGINE_SOURCE_NOT_PROTECTED');
  return sha(readFileSync(path));
}

function unitState() {
  const result=spawnSync('/usr/bin/systemctl',['show',unit,'--property=LoadState','--property=ActiveState',
    '--property=MainPID','--property=InvocationID','--property=SubState','--property=ExecMainStatus',
    '--property=Environment','--property=ControlGroup','--property=Transient'],{env,stdio:['ignore','pipe','ignore'],encoding:'utf8',timeout:3000});
  check(!result.error && result.signal===null,'ENGINE_UNIT_STATUS');
  const state=Object.fromEntries(result.stdout.trim().split('\n').filter(row=>row.includes('='))
    .map(row=>[row.slice(0,row.indexOf('=')),row.slice(row.indexOf('=')+1)]));
  check(result.status===0 || result.status===1 && state.LoadState==='not-found' &&
    state.ActiveState==='inactive' && state.MainPID==='0','ENGINE_UNIT_STATUS');
  return state;
}

export function unitIsGone() {
  const status=unitState();
  return status.LoadState==='not-found' && status.ActiveState==='inactive' && status.MainPID==='0' && !existsSync(unitPath)&&!existsSync(LEGACY_GROUP+'/'+unit);
}

function topology() {
  return [bounds,slice].map(path=>{
    const stat=lstatSync(path,{bigint:true});
    return {device:String(stat.dev),inode:String(stat.ino),controllers:text(path+'/cgroup.controllers'),
      delegated:text(path+'/cgroup.subtree_control')};
  });
}

export function verifyRestoredUnit(proof) {
  check(proof.unitExited===true && unitIsGone() && (!proof.memoryTailSha256||legacySliceGone()) &&
    sha(JSON.stringify(topology()))===proof.parentStateSha256,'ENGINE_TOPOLOGY_NOT_RESTORED');
  return Date.now();
}

async function waitGone() {
  for(let last=performance.now()+4000; performance.now()<=last;){
    if(unitIsGone()) return;
    await delay(70);
  }
  throw fail('ENGINE_UNIT_NOT_RELEASED');
}

const fields={
  Type:'exec',Restart:'no',Delegate:'cpu memory pids',CPUQuota:'100%',CPUQuotaPeriodSec:'100ms',
  MemoryMax:'2147483648',MemorySwapMax:'0',TasksMax:'64',PrivateDevices:'yes',DevicePolicy:'closed',
  PrivateNetwork:'yes',PrivateIPC:'yes',RestrictAddressFamilies:'AF_UNIX AF_INET',NoNewPrivileges:'yes',
  ProtectSystem:'strict',ProtectHome:'yes',
  InaccessiblePaths:'-/tmp -/var/tmp -/usr/share/ollama -/var/lib/ollama -/root -/home '+state,
  TemporaryFileSystem:'/run:ro,nosuid,nodev,noexec,size=1M,mode=0555 '+root+
    '/engine-work:size=128M,mode=0700,uid=65202,gid=65202',
  CapabilityBoundingSet:'CAP_SETUID CAP_SETGID CAP_CHOWN CAP_DAC_OVERRIDE CAP_KILL',
  SystemCallFilter:'~io_uring_setup io_uring_enter io_uring_register',SystemCallErrorNumber:'EPERM',
  UMask:'0077',RuntimeMaxSec:'123s',TimeoutStopSec:'8s',KillMode:'control-group',SendSIGKILL:'no',
};

const legacyFields={...fields,Slice:LEGACY_SLICE,MemoryMax:'infinity',MemoryHigh:'infinity',MemorySwapMax:'infinity',TasksMax:'infinity'};
if(nxInstalled){
  legacyFields.InaccessiblePaths=fields.InaccessiblePaths.replace(state,NX_AUDIT)+' '+NX_STAGE;
}
// 子服務使用預設無配額；唯一硬限額由父 slice 執行並原生核對。
delete legacyFields.CPUQuota;

export async function runEngineUnit({binding,engine,mode,signal,publish,memoryMode=null}) {
  memoryMode ??= (mode==='legacy-json'||mode==='legacy-sse')?'LEGACY_KERNEL_BOUNDED_CPU_V1':null;
  signal.throwIfAborted();
  check(memoryMode===null||memoryMode==='LEGACY_KERNEL_BOUNDED_CPU_V1','ENGINE_MEMORY_MODE');
  check(unitIsGone(),'ENGINE_UNIT_ALREADY_PRESENT');
  const before=topology();
  const authority=nxInstalled?nxLaunch():null;
  const observerFault=new AbortController();
  if(authority){
    checkNxObserver(authority);
    signal=AbortSignal.any([signal,observerFault.signal]);
  }
  let legacyPin=null;
  const token=randomUUID(),stateId=lstatSync(state);
  const input={binding,engine,mode,token,...(memoryMode?{memoryMode}:{})};
  const variables={ACM_R3_ENGINE_INPUT:Buffer.from(JSON.stringify(input)).toString('base64url'),
    ACM_R3_OUTER_STATE_INODE:String(stateId.ino),ACM_R3_OUTER_STATE_DEV:String(stateId.dev),
    ACM_RC2_METADATA_PROBE:'offline-metadata-v1',ACM_RC2_METADATA_SHA:protectedFile(root+'/readiness.mjs'),
    ACM_RC2_STDIO_SHA:protectedFile(root+'/stdio-guard.py'),
    ACM_RC2_HOST_RUN_DEV:String(lstatSync('/run').dev)};
  for(const type of ['mnt','net','ipc']) variables['ACM_RC2_HOST_'+type.toUpperCase()+'_NS']=readlinkSync('/proc/1/ns/'+type);
  const entry=source+'/tools/engine-qualification/integration-unit.mjs';
  protectedFile(entry);
  if(authority){
    const {value}=authority;
    variables.ACM_NX_RELEASE=memoryMode;
    variables.ACM_NX_DISPATCH=JSON.stringify(value.approval);
    variables.ACM_NX_OPERATION=value.operation;
  }
  if(memoryMode)legacyPin=await startLegacySlice();
  if(nxInstalled)writeNxReceipt('slice.json',{operation:variables.ACM_NX_OPERATION,...legacyPin});
  const actor=spawn('/usr/bin/systemd-run',['--unit='+unit,'--wait','--collect','--pipe','--quiet',
    ...Object.entries(memoryMode?legacyFields:fields).map(([key,value])=>'--property='+key+'='+value),
    ...Object.entries(variables).map(([key,value])=>'--setenv='+key+'='+value),process.execPath,entry],
    {env,stdio:[nxInstalled?'pipe':'ignore','pipe','pipe']});
  const closed=new Promise((resolve,reject)=>{
    actor.once('error',reject);
    actor.once('close',(code,signal)=>resolve({code,signal}));
  });
  closed.catch(()=>{});
  actor.stderr.resume();
  let invocation,pid,engineError,terminal,memoryParts,tailEvidence,memorySamples,outerWatch,dispatchPassed=false;
  const memoryChunks=[];
  function stopOwnedUnit(){
    const record=unitState();
    const nxOwned=nxInstalled&&record.Transient==='yes'&&record.ControlGroup===LEGACY_SERVICE&&
      record.Environment?.split(' ').includes('ACM_NX_OPERATION='+variables.ACM_NX_OPERATION);
    const observed=invocation&&record.InvocationID===invocation&&
      (record.MainPID===String(pid)||memoryMode&&record.MainPID==='0'&&record.ActiveState==='active'&&record.SubState==='exited');
    if(nxInstalled ? nxOwned&&(!invocation||observed) : observed){
      execFileSync('/usr/bin/systemctl',['stop',unit],{env,stdio:'ignore',timeout:10000});
    }
  }
  function onAbort(){
    try{stopOwnedUnit();}catch{/* 結果保持 HOLD，單元上限仍然生效。 */}
  }
  signal.addEventListener('abort',onAbort,{once:true});
  const stopWatch=nxInstalled?setInterval(()=>{
    try{checkNxObserver(authority);}catch(error){observerFault.abort(error);}
  },250):null;
  actor.stdin?.on('error',()=>{});
  try{
    for await(const row of lines(actor.stdout,memoryMode?1048576:262144)){
      check(row.startsWith(prefix),'ENGINE_UNIT_PROTOCOL');
      const frame=JSON.parse(row.slice(prefix.length));
      if(frame.type==='hold'){
        engineError=safeCode({code:frame.code});
        continue;
      }
      signal.throwIfAborted();
      check(frame.token===token && !terminal && !engineError,'ENGINE_UNIT_PROTOCOL');
      if(frame.type==='memory-failure'&&memoryMode){
        check(frame.invocation===unitState().InvocationID,'LEGACY_TRANSCRIPT_PROTOCOL');
        emit('MEMORY_FAILURE',{invocation:frame.invocation,binding,diagnostic:frame.diagnostic});
        continue;
      }
      if(frame.type==='unit'){
        check(!invocation && /^[0-9a-f]{32}$/.test(frame.invocation) &&
          Number.isSafeInteger(frame.pid) && frame.pid>1,'ENGINE_UNIT_IDENTITY');
        const status=unitState();
        check(status.InvocationID===frame.invocation && status.MainPID===String(frame.pid) &&
          text('/proc/'+frame.pid+'/cgroup')==='0::'+(memoryMode?LEGACY_SERVICE:'/system.slice/'+unit)+'/controller','ENGINE_UNIT_IDENTITY');
        invocation=frame.invocation;
        pid=frame.pid;
        if(memoryMode){
          outerWatch=createLegacySliceWatch({read:readLegacySliceSample,onFailure:diagnostic=>emit('OUTER_MEMORY_FAILURE',{binding,invocation,diagnostic})});
          outerWatch.abortSignal.addEventListener('abort',onAbort,{once:true});
        }
      }else{
        check(invocation,'ENGINE_UNIT_IDENTITY');
        if(frame.type==='dispatch-gate'){
          check(nxInstalled&&!dispatchPassed&&frame.invocation===invocation&&outerWatch&&!outerWatch.abortSignal.aborted,'NX_GATE_PROTOCOL');
          nxLaunch();
          checkNxObserver(authority);
          outerWatch.sample();
          dispatchPassed=true;
          actor.stdin.end(token+'\n');
        }else if(frame.type==='stage'){
          check(/^[A-Z][A-Z0-9_]{1,58}$/.test(frame.row?.stage??''),'ENGINE_UNIT_PROTOCOL');
          emit('STAGE',{stage:frame.row.stage,verdict:frame.row.verdict,code:frame.row.code??null});
        }else if(frame.type==='delta'){
          publishEngineDelta(mode,frame,publish);
        }else if(frame.type==='memory'){
          check(memoryMode&&frame.invocation===invocation&&Number.isSafeInteger(frame.parts)&&frame.parts>0&&frame.parts<=16&&
            frame.index===memoryChunks.length&&(!memoryParts||memoryParts===frame.parts)&&
            typeof frame.data==='string'&&/^[A-Za-z0-9+/]{1,32768}={0,2}$/.test(frame.data),'LEGACY_TRANSCRIPT_PROTOCOL');
          memoryParts=frame.parts;memoryChunks.push(Buffer.from(frame.data,'base64'));
        }else{
          check(frame.type==='result' && frame.invocation===invocation,'ENGINE_UNIT_PROTOCOL');
          terminal=frame;
          if(memoryMode){
            check(memoryParts===memoryChunks.length,'LEGACY_TRANSCRIPT_MISSING');
            const raw=gunzipSync(Buffer.concat(memoryChunks),{maxOutputLength:8*1024**2});
            memorySamples=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
            check(Array.isArray(memorySamples)&&memorySamples.length===terminal.engineEvidence.memoryEvidence.sampleCount,
              'LEGACY_TRANSCRIPT_COUNT');
            check(memorySamples.reduce((head,sample)=>sha(JSON.stringify([head,sample])),'0'.repeat(64))===
              terminal.engineEvidence.memoryEvidence.samplesSha256,'LEGACY_TRANSCRIPT_HASH');
          }
        }
      }
    }
    const result=await closed;
    await waitGone();
    if(engineError)throw fail(engineError);
    check(result.code===0 && result.signal===null && terminal && invocation&&(!nxInstalled||dispatchPassed),'ENGINE_UNIT_EXIT');
    if(memoryMode){
      tailEvidence=readLegacyTail(terminal.engineEvidence.memoryEvidence,memorySamples[0].groups,outerWatch);
      emit('MEMORY_TAIL',{invocation,binding,...tailEvidence});
      await stopLegacySlice(legacyPin);
      check(legacySliceGone(),'LEGACY_SLICE_NOT_RELEASED');
      check(memoryParts===memoryChunks.length,'LEGACY_TRANSCRIPT_MISSING');
      const raw=gunzipSync(Buffer.concat(memoryChunks),{maxOutputLength:8*1024**2});
      const samples=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
      check(Array.isArray(samples)&&samples.length===terminal.engineEvidence.memoryEvidence.sampleCount,'LEGACY_TRANSCRIPT_COUNT');
      const head=samples.reduce((head,sample)=>sha(JSON.stringify([head,sample])),'0'.repeat(64));
      check(head===terminal.engineEvidence.memoryEvidence.samplesSha256,'LEGACY_TRANSCRIPT_HASH');
      emit('MEMORY_TRANSCRIPT',{invocation,binding,sha256:sha(raw),samples});
    }
    const after=topology();
    check(JSON.stringify(before)===JSON.stringify(after),'ENGINE_TOPOLOGY_NOT_RESTORED');
    signal.throwIfAborted();
    return {terminal,proof:{token,invocation,unitExited:true,
      topologySha256:sha(JSON.stringify({before,after,invocation,pid,...(memoryMode?{memoryTailSha256:sha(JSON.stringify(tailEvidence))}:{})})),
      ...(memoryMode?{memoryTailSha256:sha(JSON.stringify(tailEvidence))}:{}),
      parentStateSha256:sha(JSON.stringify(before)),verifiedAt:Date.now()}};
  }catch(error){
    try{stopOwnedUnit();}catch{/* 保留本次失敗原碼。 */}
    await waitGone().catch(()=>emit('UNIT_CLEANUP',{verdict:'HOLD',code:'ENGINE_UNIT_NOT_RELEASED'}));
    if(legacyPin)await stopLegacySlice(legacyPin).catch(()=>emit('UNIT_CLEANUP',{verdict:'HOLD',code:'LEGACY_SLICE_NOT_RELEASED'}));
    throw error;
  }finally{clearInterval(stopWatch);actor.stdin?.destroy();signal.removeEventListener('abort',onAbort);outerWatch?.abortSignal.removeEventListener('abort',onAbort);outerWatch?.stop();}
}
