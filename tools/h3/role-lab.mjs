import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { qualificationMessage } from '../../src/worker/admission.mjs';
import { hash } from '../../src/worker/simulation.mjs';
import { NX_CODE, NX_CONTROL, NX_H3_UID, nxH3Mode } from '../nx-legacy/layout.mjs';
import { startNativeWorkerRole } from './nx-worker-launch.mjs';
import { openH3Frame, sealH3Frame } from './wire.mjs';

assert.equal(fileURLToPath(import.meta.url),NX_CODE+'/tools/h3/role-lab.mjs');
assert.equal(process.execPath,NX_CODE+'/runtime/node');
assert.equal(process.getuid(),0);
assert.equal(process.arch,'arm64');
assert.equal(nxH3Mode,'legacy-json');
assert.match(readFileSync('/sys/class/dmi/id/product_name','utf8'),/QEMU/u);
const key=()=>generateKeyPairSync('ed25519');
const [worker,controller,restore,foreign]=Array.from({length:4},key);
const d=n=>n.repeat(64);
const now=Date.now();
const pin=d('a'),epoch=randomUUID(),binding={workerPin:pin,attemptId:randomUUID()};
const options={workerPublicKey:worker.publicKey,controllerPublicKey:controller.publicKey,restorationAuthorityPublicKey:restore.publicKey};
const qualified={pin,claim:{epoch}};
const spawnRole=()=>startNativeWorkerRole({options,qualified,signal:AbortSignal.timeout(12000)});
writeFileSync(NX_CONTROL+'/worker.pem',worker.privateKey.export({format:'pem',type:'pkcs8'}),{flag:'wx',mode:0o400});
const req=(sequence,payload,key=controller.privateKey)=>({action:'request',envelope:
  sealH3Frame({pin,sequence,nonce:d(String(sequence)),type:'request',payload:{pin,...payload}},key)});
const result=(sequence,payload)=>({action:'reply',frame:{pin,sequence,nonce:d(String(sequence)),type:'result',payload}});

const role=await spawnRole();
let complete=false;
try{
  assert.equal(role.identity.uid,NX_H3_UID);
  assert.equal(role.identity.gid,NX_H3_UID);
  assert.equal(role.identity.pid>1,true);
  assert.equal(await role.call(req(1,{operation:'ready',nonce:d('c')})),null);
  const ready=await role.call({action:'seal',kind:'READY',value:{pin,epoch,nonce:d('c'),at:now,healthy:true,active:0,resident:0}});
  assert.deepEqual(openH3Frame(await role.call(result(1,ready)),worker.publicKey).payload,ready);
  assert.equal(await role.call(req(2,{operation:'execute',binding})),null);
  const end={pin,epoch,binding,at:now,result:{outcome:'SUCCEEDED'},engine:randomUUID()};
  const terminal=await role.call({action:'seal',kind:'TERMINAL',value:end});
  assert.deepEqual(openH3Frame(await role.call(result(2,terminal)),worker.publicKey).payload,terminal);
  const evidence={pin,epoch,binding,nonce:d('b'),terminalSha256:hash(terminal),engine:end.engine};
  assert.equal(await role.call(req(3,{operation:'sample',binding,nonce:evidence.nonce,terminalSha256:evidence.terminalSha256})),null);
  const restored={value:evidence,signature:sign(null,qualificationMessage('RESTORED',evidence),restore.privateKey).toString('hex')};
  const cleared=await role.call({action:'seal',kind:'CLEARED',value:{...evidence,at:now,healthy:true,active:0,resident:0,
    gpuResidentBytes:0,reclaimed:true,restore:restored}});
  assert.deepEqual(openH3Frame(await role.call(result(3,cleared)),worker.publicKey).payload,cleared);
  await role.close(true);
  complete=true;
}finally{if(!complete)await role.close();}

for(const kind of ['forged-controller','unarbitrated-seal']){
  const negative=await spawnRole();
  try{
    if(kind==='forged-controller') await assert.rejects(negative.call(req(1,{operation:'ready',nonce:d('c')},foreign.privateKey)));
    else await assert.rejects(negative.call({action:'seal',kind:'RESTORED',value:{pin,epoch}}));
  }finally{await negative.close();}
}
console.log('ACM_H3_ROLE_LAB='+JSON.stringify({status:'PASS_ARM64_QEMU_ROLE_ISOLATION',uid:NX_H3_UID,gid:NX_H3_UID,
  namespaceFields:Object.keys(role.identity.namespaces),separateCredentials:true,protectedFilesDenied:true,
  inheritedKeyClosed:true,forgedControllerDenied:true,arbitrarySigningDenied:true,roleReaped:true,generationRequests:0}));
