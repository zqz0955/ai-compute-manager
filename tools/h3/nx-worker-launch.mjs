import { execFileSync, spawn } from 'node:child_process';
import { closeSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { workerKeyPin } from '../../src/worker/admission.mjs';
import { protectedFile } from '../engine-qualification/integration-host.mjs';
import { NX_CODE, NX_H3_UID } from '../nx-legacy/layout.mjs';
import { exact, h3Frames, requireH3, writeH3Frame } from './wire.mjs';
import { openWorkerKey } from './nx-profile.mjs';
import { workerRoleCredentials } from './nx-worker-role.mjs';

const env={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'};
const status=pid=>readFileSync('/proc/'+pid+'/status','utf8');
const startTick=pid=>readFileSync('/proc/'+pid+'/stat','utf8').split(') ').at(-1).split(' ')[19];
const der=key=>key.export({format:'der',type:'spki'}).toString('hex');

function verifyRoleSlot() {
  for(const database of ['passwd','group']) {
    try {
      execFileSync('/usr/bin/getent',[database,String(NX_H3_UID)],{env,stdio:'ignore',timeout:1000});
      requireH3(false,'H3_ROLE_NSS_COLLISION');
    }catch(error){requireH3(error.status===2 && !error.signal,'H3_ROLE_NSS_COLLISION');}
  }
  const role=new RegExp('^(?:Uid|Gid|Groups):[ \\t]+(?:[0-9]+[ \\t]+)*'+NX_H3_UID+'(?:[ \\t]|$)','mu');
  for(const pid of readdirSync('/proc').filter(name=>/^[1-9][0-9]*$/u.test(name))) {
    try{requireH3(!role.test(status(pid)),'H3_ROLE_PROCESS_COLLISION');}
    catch(error){if(error.code!=='ENOENT'&&error.code!=='ESRCH')throw error;}
  }
}

function keyDescriptorClosed(pid) {
  try{readlinkSync('/proc/'+pid+'/fd/4');return false;}
  catch(error){if(error.code==='ENOENT')return true;throw error;}
}

async function beforeDeadline(promise, signal) {
  signal.throwIfAborted();
  let abort;
  try{
    return await Promise.race([promise,new Promise((_,reject)=>{
      abort=()=>reject(signal.reason);
      signal.addEventListener('abort',abort,{once:true});
    })]);
  }finally{signal.removeEventListener('abort',abort);}
}

export async function startNativeWorkerRole({options,qualified,signal}) {
  verifyRoleSlot();
  const script=NX_CODE+'/tools/nx-legacy/worker-exec.py';
  protectedFile(script);
  protectedFile(NX_CODE+'/tools/h3/nx-worker-role.mjs');
  const secretFD=openWorkerKey();
  let child;
  try {
    child=spawn('/usr/bin/unshare',['--net','--mount','--ipc','--propagation','private','--','/usr/bin/setpriv',
      '--no-new-privs','--','/usr/bin/python3','-I','-B',script,'h3-role'],
    {stdio:['pipe','pipe','pipe','ignore',secretFD],env});
  }finally{closeSync(secretFD);}
  const died=new AbortController();
  let graceful=false, exited=false, working=false;
  let diagnostic='';
  child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString('utf8')).slice(-4096);});
  const closed=new Promise(resolve=>{
    child.once('error',()=>{died.abort(Error('H3_ROLE_SPAWN'));resolve(null);});
    child.once('close',(code,signal)=>{
      exited=true;
      if(!graceful||code!==0||signal!==null)died.abort(Error('H3_ROLE_CLOSED'));
      resolve({code,signal});
    });
  });
  child.stdin.on('error',()=>{if(!graceful)died.abort(Error('H3_ROLE_CHANNEL_LOST'));});
  const childSignal=AbortSignal.any([signal,died.signal]);
  const reader=h3Frames(child.stdout);
  const limit=(ms)=>AbortSignal.any([childSignal,AbortSignal.timeout(ms)]);
  const incoming=async boundary=>{
    const next=await beforeDeadline(reader.next(),boundary);
    requireH3(!next.done,'H3_ROLE_CHANNEL_LOST');
    return next.value;
  };
  async function close(success=false) {
    graceful=success;
    child.stdin.end();
    if(!success&&!exited)child.kill('SIGKILL');
    const info=await beforeDeadline(closed,AbortSignal.timeout(success?500:4000));
    if(success) requireH3(info?.code===0&&info.signal===null,'H3_ROLE_EXIT_UNVERIFIED');
  }
  try{
    const hello=await incoming(limit(5000));
    requireH3(exact(hello,['event','pid','workerKey'])&&hello.event==='identity'&&hello.pid===child.pid&&
      hello.workerKey===workerKeyPin(options.workerPublicKey)&&workerRoleCredentials(status(child.pid),NX_H3_UID)&&
      readlinkSync('/proc/'+child.pid+'/exe')===process.execPath,'H3_ROLE_NATIVE_ID');
    const namespaces=Object.fromEntries(['net','mnt','ipc'].map(ns=>[ns,readlinkSync('/proc/'+child.pid+'/ns/'+ns)]));
    requireH3(Object.entries(namespaces).every(([ns,identity])=>identity!==readlinkSync('/proc/self/ns/'+ns))&&
      keyDescriptorClosed(child.pid),'H3_ROLE_NATIVE_NAMESPACE');
    const started=startTick(child.pid);
    const deadline=limit(1500);
    await writeH3Frame(child.stdin,{action:'init',pin:qualified.pin,epoch:qualified.claim.epoch,
      controller:der(options.controllerPublicKey),restoration:der(options.restorationAuthorityPublicKey)},deadline);
    const initialized=await incoming(deadline);
    requireH3(exact(initialized,['event'])&&initialized.event==='initialized','H3_ROLE_INIT');
    const call=async request=>{
      requireH3(!working,'H3_ROLE_PARALLEL');
      working=true;
      try{
        const boundary=limit(500);
        if(request.action==='reply'&&request.frame.sequence===3)graceful=true;
        await writeH3Frame(child.stdin,request,boundary);
        const frame=await incoming(boundary);
        requireH3(exact(frame,['event','result'])&&frame.event==='result','H3_ROLE_REPLY_PROTOCOL');
        return frame.result;
      }finally{working=false;}
    };
    return {call,close,signal:childSignal,identity:{pid:child.pid,uid:NX_H3_UID,gid:NX_H3_UID,started,namespaces,workerKey:hello.workerKey}};
  }catch(error){
    await close().catch(()=>{});
    const stage=diagnostic.match(/(?:ACM_H3_ROLE_HOLD |)(H3_ROLE_[A-Z_]+|NX_WORKER_[A-Z_]+)/u)?.[1];
    if(stage)requireH3(false,stage);
    throw error;
  }
}
