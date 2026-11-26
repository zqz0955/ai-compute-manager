import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';
import { qualificationMessage } from '../src/worker/admission.mjs';
import { hash } from '../src/worker/simulation.mjs';
import { createWorkerRole } from '../tools/h3/nx-worker-role.mjs';
import { openH3Frame, sealH3Frame } from '../tools/h3/wire.mjs';

const key = () => generateKeyPairSync('ed25519');
const hex = digit => digit.repeat(64);
const pin=hex('a'), transportNonce=hex('b'), readyNonce=hex('c');

test('H3 Worker key only signs a reply to the authenticated Controller and the exact approved operation',()=>{
  const worker=key(), controller=key(), restoration=key(), foreign=key();
  const epoch='98533ed6-6c84-4ec9-90ad-4121143d432a';
  const role=createWorkerRole({pin,epoch,mode:'legacy-json',workerKey:worker.privateKey,
    controllerKey:controller.publicKey,restorationKey:restoration.publicKey});
  const request={pin,sequence:1,nonce:transportNonce,type:'request',payload:{pin,operation:'ready',nonce:readyNonce}};
  const value={pin,epoch,nonce:readyNonce,at:Date.now(),healthy:true,active:0,resident:0};
  const early={action:'seal',kind:'READY',value};
  assert.throws(()=>role(early),{code:'H3_ROLE_PHASE'});
  assert.throws(()=>role({action:'request',envelope:sealH3Frame(request,foreign.privateKey)}),{code:'H3_CHANNEL_SIGNATURE'});
  assert.equal(role({action:'request',envelope:sealH3Frame(request,controller.privateKey)}),null);
  assert.throws(()=>role({...early,kind:'RESTORED'}),{code:'H3_ROLE_PHASE'});
  assert.throws(()=>role({...early,value:{...value,nonce:hex('d')}}),{code:'H3_ROLE_READY'});
  const receipt=role(early);
  assert.deepEqual(receipt,{value,signature:sign(null,qualificationMessage('READY',value),worker.privateKey).toString('hex')});
  const reply={pin,sequence:1,nonce:transportNonce,type:'result',payload:receipt};
  assert.throws(()=>role({action:'reply',frame:{...reply,nonce:hex('d')}}),{code:'H3_ROLE_REPLY'});
  assert.deepEqual(openH3Frame(role({action:'reply',frame:reply}),worker.publicKey),reply);
  assert.throws(()=>role({action:'request',envelope:sealH3Frame(request,controller.privateKey)}),{code:'H3_ROLE_REQUEST'});
});

test('H3 final reply requires independent restoration signature for the exact terminal and challenge',()=>{
  const worker=key(),controller=key(),restoration=key();
  const epoch=randomUUID(),engine=randomUUID(),at=Date.now(),binding={workerPin:pin,attemptId:randomUUID()};
  const role=createWorkerRole({pin,epoch,mode:'legacy-json',workerKey:worker.privateKey,
    controllerKey:controller.publicKey,restorationKey:restoration.publicKey});
  const request=(sequence,operation,body)=>role({action:'request',envelope:sealH3Frame({pin,sequence,
    nonce:transportNonce,type:'request',payload:{pin,operation,...body}},controller.privateKey)});
  const workerSeal=(kind,value)=>role({action:'seal',kind,value});
  const reply=(sequence,payload)=>role({action:'reply',frame:{pin,sequence,nonce:transportNonce,type:'result',payload}});
  request(1,'ready',{nonce:readyNonce});
  reply(1,workerSeal('READY',{pin,epoch,nonce:readyNonce,at,healthy:true,active:0,resident:0}));
  request(2,'execute',{binding});
  const terminal=workerSeal('TERMINAL',{pin,epoch,binding,at,engine,result:{outcome:'SUCCEEDED'}});
  reply(2,terminal);
  const terminalSha256=hash(terminal), challenge=hex('d');
  request(3,'sample',{binding,nonce:challenge,terminalSha256});
  const signRestoration=(key,nonce)=> {
    const value={pin,epoch,binding,nonce,engine,terminalSha256};
    return {value,signature:sign(null,qualificationMessage('RESTORED',value),key).toString('hex')};
  };
  const cleared={pin,epoch,binding,nonce:challenge,at,terminalSha256,engine,healthy:true,active:0,resident:0,
    gpuResidentBytes:0,reclaimed:true};
  assert.throws(()=>workerSeal('CLEARED',{...cleared,restore:signRestoration(worker.privateKey,challenge)}),{code:'H3_ROLE_RESTORE'});
  assert.throws(()=>workerSeal('CLEARED',{...cleared,restore:signRestoration(restoration.privateKey,readyNonce)}),{code:'H3_ROLE_RESTORE'});
  const accepted=workerSeal('CLEARED',{...cleared,restore:signRestoration(restoration.privateKey,challenge)});
  assert.deepEqual(openH3Frame(reply(3,accepted),worker.publicKey).payload,accepted);
});
