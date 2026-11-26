import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { qualificationMessage, workerKeyPin } from '../../src/worker/admission.mjs';
import { hash } from '../../src/worker/simulation.mjs';
import { uuid } from '../../src/worker/r1/ollama-once.mjs';
import { NX_AUDIT, NX_CODE, NX_CONTROL, NX_H3_UID, nxH3Mode } from '../nx-legacy/layout.mjs';
import { exact, h3Frames, openH3Frame, requireH3, sealH3Frame, writeH3Frame } from './wire.mjs';

const HEX=/^[a-f0-9]{64}$/u;
const SIGNATURE=/^[a-f0-9]{128}$/u;
const operations=['ready','execute','sample'];

// 每份回覆都綁定 Windows 已簽章的原始請求。只有三個固定階段，沒有任意簽署介面。
export function createWorkerRole({pin,epoch,mode,workerKey,controllerKey,restorationKey}) {
  let sequence=0,request,receipt,terminal,deltaCount=0;
  return message=>{
    if(message?.action==='request') {
      requireH3(exact(message,['action','envelope']),'H3_ROLE_REQUEST');
      const frame=openH3Frame(message.envelope,controllerKey);
      requireH3(!request&&sequence<3&&frame.type==='request'&&frame.sequence===sequence+1&&frame.pin===pin&&
        frame.payload?.pin===pin&&frame.payload?.operation===operations[sequence],'H3_ROLE_REQUEST');
      if(sequence===1) requireH3(frame.payload.binding?.workerPin===pin&&uuid(frame.payload.binding?.attemptId),'H3_ROLE_BINDING');
      if(sequence===2) requireH3(same(frame.payload.binding,terminal?.value.binding)&&
        frame.payload.terminalSha256===hash(terminal)&&HEX.test(frame.payload.nonce),'H3_ROLE_BINDING');
      request=frame;
      return null;
    }
    if(message?.action==='reply') {
      const {frame}=message;
      requireH3(exact(message,['action','frame'])&&exact(frame,['pin','sequence','nonce','type','payload'])&&request&&receipt&&
        frame.pin===pin&&frame.sequence===request.sequence&&frame.nonce===request.nonce&&
        frame.type===(receipt.kind==='DELTA'?'delta':'result')&&same(frame.payload,receipt.envelope),'H3_ROLE_REPLY');
      if(receipt.kind!=='DELTA') { sequence++; request=null; }
      receipt=null;
      return sealH3Frame(frame,workerKey);
    }
    requireH3(exact(message,['action','kind','value'])&&message.action==='seal'&&request&&!receipt,'H3_ROLE_PHASE');
    const {kind,value}=message;
    requireH3(value?.pin===pin&&value.epoch===epoch&&(['READY','TERMINAL','CLEARED'][sequence]===kind ||
      (sequence===1&&kind==='DELTA'&&mode==='legacy-sse')),'H3_ROLE_PHASE');
    const body=request.payload;
    if(kind==='READY') {
      requireH3(exact(value,['pin','epoch','nonce','at','healthy','active','resident'])&&HEX.test(body.nonce)&&
        value.nonce===body.nonce&&Number.isSafeInteger(value.at)&&value.healthy===true&&
        value.active===0&&value.resident===0,'H3_ROLE_READY');
    }else if(kind==='DELTA') {
      requireH3(exact(value,['pin','epoch','binding','sequence','content'])&&same(value.binding,body.binding)&&
        value.sequence===deltaCount+1&&deltaCount<16&&typeof value.content==='string'&&value.content.isWellFormed()&&
        Buffer.byteLength(value.content)<=32768,'H3_ROLE_DELTA');
      deltaCount++;
    }else if(kind==='TERMINAL') {
      requireH3(exact(value,['pin','epoch','binding','at','result','engine'])&&same(value.binding,body.binding)&&
        Number.isSafeInteger(value.at)&&uuid(value.engine)&&value.result?.outcome==='SUCCEEDED','H3_ROLE_TERMINAL');
    }else {
      const p=value.restore?.value;
      requireH3(exact(value,['pin','epoch','binding','nonce','at','terminalSha256','engine','healthy','active',
        'resident','gpuResidentBytes','reclaimed','restore'])&&same(value.binding,body.binding)&&
        value.nonce===body.nonce&&value.terminalSha256===body.terminalSha256&&value.engine===terminal.value.engine&&
        Number.isSafeInteger(value.at)&&value.healthy===true&&value.active===0&&value.resident===0&&
        value.gpuResidentBytes===0&&value.reclaimed===true&&exact(value.restore,['value','signature'])&&
        p?.pin===pin&&p.epoch===epoch&&same(p.binding,body.binding)&&p.nonce===body.nonce&&
        p.engine===value.engine&&p.terminalSha256===body.terminalSha256&&SIGNATURE.test(value.restore.signature)&&
        verify(null,qualificationMessage('RESTORED',p),restorationKey,Buffer.from(value.restore.signature,'hex')),
      'H3_ROLE_RESTORE');
    }
    const envelope={value,signature:sign(null,qualificationMessage(kind,value),workerKey).toString('hex')};
    receipt={kind,envelope};
    if(kind==='TERMINAL') terminal=envelope;
    return envelope;
  };
}

const publicKey=hex=>createPublicKey({key:Buffer.from(hex,'hex'),format:'der',type:'spki'});

export function workerRoleCredentials(status,id) {
  return ['Uid','Gid'].every(label=>new RegExp('^'+label+':\\s+'+Array(4).fill(id).join('\\s+')+'$','m').test(status))&&
    /^Groups:[ \t]*$/mu.test(status)&&
    ['Inh','Prm','Eff','Amb'].every(cap=>new RegExp('^Cap'+cap+':\\s+0+$','m').test(status))&&
    /^NoNewPrivs:\s+1$/mu.test(status);
}

async function main() {
  requireH3(nxH3Mode&&process.platform==='linux'&&process.arch==='arm64'&&process.versions.node==='24.22.3'&&
    fileURLToPath(import.meta.url)===NX_CODE+'/tools/h3/nx-worker-role.mjs'&&process.execPath===NX_CODE+'/runtime/node'&&
    process.argv.length===2&&workerRoleCredentials(readFileSync('/proc/self/status','utf8'),NX_H3_UID),'H3_ROLE_NATIVE_BOUNDARY');
  // FD 4 只由固定的 root 父程序傳入；Worker 降權後才讀取並立即關閉。
  const id=fstatSync(4);
  requireH3(id.isFile()&&id.uid===0&&id.gid===0&&id.nlink===1&&(id.mode&0o777)===0o400&&id.size>0&&id.size<=4096,
    'H3_ROLE_KEY_DESCRIPTOR');
  let bytes;
  try{bytes=readFileSync(4);}finally{closeSync(4);}
  let workerKey;
  try{workerKey=createPrivateKey(bytes);}finally{bytes.fill(0);}
  requireH3(workerKey.asymmetricKeyType==='ed25519'&&realpathSync(process.execPath)===process.execPath,'H3_ROLE_KEY');
  for(const path of [NX_CONTROL+'/restoration.pem', NX_AUDIT+'/launch.json', NX_AUDIT+'/work']) {
    try{
      const fd=openSync(path,'r');
      closeSync(fd);
      requireH3(false,'H3_ROLE_PRIVATE_RESOURCE');
    }catch(error){requireH3(['EACCES','EPERM'].includes(error?.code),'H3_ROLE_PRIVATE_RESOURCE');}
  }
  const signal=AbortSignal.timeout(165000);
  const stream=h3Frames(process.stdin);
  await writeH3Frame(process.stdout,{event:'identity',pid:process.pid,workerKey:workerKeyPin(createPublicKey(workerKey))},signal);
  const init=await stream.next();
  const value=init.value;
  requireH3(!init.done&&exact(value,['action','pin','epoch','controller','restoration'])&&value.action==='init'&&
    HEX.test(value.pin)&&uuid(value.epoch)&&/^[a-f0-9]{88}$/u.test(value.controller)&&/^[a-f0-9]{88}$/u.test(value.restoration),
    'H3_ROLE_INIT');
  const role=createWorkerRole({pin:value.pin,epoch:value.epoch,mode:nxH3Mode,workerKey,
    controllerKey:publicKey(value.controller),restorationKey:publicKey(value.restoration)});
  await writeH3Frame(process.stdout,{event:'initialized'},signal);
  while(true) {
    signal.throwIfAborted();
    const next=await stream.next();
    requireH3(!next.done,'H3_ROLE_CHANNEL_LOST');
    const result=role(next.value);
    await writeH3Frame(process.stdout,{event:'result',result},signal);
    if(next.value.action==='reply'&&next.value.frame.sequence===3) break;
  }
  await stream.return();
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  try{await main();}
  catch(error){
    process.stderr.write('ACM_H3_ROLE_HOLD '+(/^[A-Z0-9_]{1,75}$/u.test(error?.code??'')?error.code:'H3_ROLE_ERROR')+'\n');
    process.exitCode=42;
  }
}
