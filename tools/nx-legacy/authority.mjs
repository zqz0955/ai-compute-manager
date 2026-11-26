import {existsSync,lstatSync,readFileSync,realpathSync,writeFileSync,openSync,fsyncSync,closeSync,linkSync,unlinkSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {fail,sha} from '../../src/worker/r1/ollama-once.mjs';
import {checkNxDispatch,NX_AUDIT,nxInstalled} from './layout.mjs';

const check=(ok,code)=>{if(!ok)throw fail(code);};
const read=path=>readFileSync(path,'utf8').trim();
function protectedJson(name){
  const path=NX_AUDIT+'/'+name,info=lstatSync(path);
  check(info.isFile()&&info.uid===0&&info.gid===0&&info.nlink===1&&(info.mode&0o777)===0o400&&
    info.size<=65536&&realpathSync(path)===path,'NX_AUTHORITY_FILE');
  const bytes=readFileSync(path);
  return {value:JSON.parse(bytes),sha256:sha(bytes)};
}

export function nxLaunch(){
  check(nxInstalled&&process.getuid()===0&&process.getgid()===0,'NX_AUTHORITY_BOUNDARY');
  const manifest=protectedJson('launch.json');
  const value=manifest.value;
  const start=read('/proc/'+process.ppid+'/stat').split(') ').at(-1).split(' ')[19];
  check(value.pid===process.ppid&&value.parentStart===start&&value.boot===read('/proc/sys/kernel/random/boot_id')&&
    /^[a-f0-9]{64}$/.test(value.releaseSha256)&&/^[a-f0-9]{64}$/.test(value.resource)&&
    /^[a-f0-9]{32}$/.test(value.operation),'NX_AUTHORITY_PARENT');
  check(!existsSync(NX_AUDIT+'/cancel.json'),'NX_CANCELLED');
  checkNxDispatch(JSON.stringify(value.approval));
  return manifest;
}

export function checkNxObserver(launch){
  const {value}=protectedJson('heartbeat.json');
  const age=Number(process.hrtime.bigint()/1000000n)-value.monotonicMs;
  const parent=read('/proc/'+launch.value.pid+'/stat').split(') ').at(-1).split(' ');
  check(value.operation===launch.value.operation&&Number.isSafeInteger(value.monotonicMs)&&age>=-1&&age<=8000&&
    parent[0]!=='Z'&&parent[19]===launch.value.parentStart&&!existsSync(NX_AUDIT+'/cancel.json'),
    'NX_HOST_OBSERVER_UNAVAILABLE');
}

export function writeNxReceipt(name,value){
  const path=NX_AUDIT+'/'+name;
  const raw=Buffer.from(JSON.stringify(value));
  const file=openSync(path+'.pending','wx',0o400);
  try{writeFileSync(file,raw);fsyncSync(file);}finally{closeSync(file);}
  linkSync(path+'.pending',path);
  unlinkSync(path+'.pending');
  const folder=openSync(NX_AUDIT,'r');
  try{fsyncSync(folder);}finally{closeSync(folder);}
  return raw;
}

export async function requireNxRestored({launch,proof,binding,evidenceSha256,workerPid,signal}){
  const request={operation:launch.value.operation,releaseSha256:launch.value.releaseSha256,
    invocation:proof.invocation,topologySha256:proof.topologySha256,memoryTailSha256:proof.memoryTailSha256,
    jobId:binding.jobId,attemptId:binding.attemptId,evidenceSha256,workerPid};
  const raw=writeNxReceipt('restore-request.json',request);
  const wait=AbortSignal.any([signal,AbortSignal.timeout(20000)]);
  while(true){
    wait.throwIfAborted();
    checkNxObserver(launch);
    try{
      const answer=protectedJson('restore-approved.json');
      check(answer.value.operation===request.operation&&answer.value.requestSha256===sha(raw)&&
        /^[a-f0-9]{64}$/.test(answer.value.hostEvidenceSha256),'NX_RESTORE_AUTHORITY_BINDING');
      return answer.sha256;
    }catch(error){if(error.code!=='ENOENT')throw error;}
    await delay(150,undefined,{signal:wait});
  }
}
