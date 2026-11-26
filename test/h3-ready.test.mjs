import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { probePlan, requestProbe, respondProbe, verifyProbe, readProbeFrame } from '../tools/h3/ready-protocol.mjs';

function fixture(){
  const controller=generateKeyPairSync('ed25519'), worker=generateKeyPairSync('ed25519');
  const identity=key=>key.export({type:'spki',format:'der'}).toString('hex');
  const plan={version:1,scope:'ACM_H3_ZERO_GENERATION_V1',operation:randomUUID(),boot:randomUUID(),
    deviceSha256:'1'.repeat(64),sshHostSha256:'2'.repeat(64),nodeSha256:'3'.repeat(64),
    controllerKey:identity(controller.publicKey),probeKey:identity(worker.publicKey),
    notBefore:1000,expiresAt:20000,uid:1001,gid:1001};
  const request=requestProbe(plan,controller.privateKey,2000);
  const used=new Set();
  const answer=(wire=request, readClock=[2010,2011], ticks=[100,101])=>respondProbe({plan,wire,key:worker.privateKey,
    clock:()=>readClock.shift(),monotonic:()=>ticks.shift(),claimOnce(id){
      if(used.has(id))throw Error('H3_TEST_REPLAY');
      used.add(id);
    }});
  return {plan,controller,request,answer};
}

test('READY-only 雙簽章綁定設備、視窗與 nonce，可以獨立重播觀測結果',()=>{
  const {plan,request,answer}=fixture();
  const response=answer();
  const attempt={plan,request,response,sentAt:2000,receivedAt:2015,roundTripMs:15};
  assert.deepEqual(verifyProbe(attempt),{status:'PASS_AUTHENTICATED_ZERO_GENERATION',generationRequests:0,
    offsetLowMs:-4,offsetHighMs:10,roundTripMs:15,remoteLocalMs:1,compatibleWith700msAtProbe:true});
  assert.throws(()=>verifyProbe({...attempt,request:{...request,signature:'0'.repeat(128)}}),/H3_PROBE_SIGNATURE/u);
  assert.throws(()=>verifyProbe({...attempt,plan:{...plan,boot:randomUUID()}}),/H3_PROBE_REQUEST/u);
  assert.throws(()=>answer(),/H3_TEST_REPLAY/u);
});

test('偽造訊框拒絕在消耗前，先前回覆不能套用新 challenge',()=>{
  const {plan,controller,request,answer}=fixture();
  assert.throws(()=>answer({...request,value:{...request.value,operation:'execute'}}),/H3_PROBE_SIGNATURE/u);
  const response=answer();
  assert.throws(()=>verifyProbe({plan,request:requestProbe(plan,controller.privateKey,2000),response,
    sentAt:2000,receivedAt:2015,roundTripMs:15}),/H3_PROBE_RESPONSE/u);
});

test('傳輸期限與原生本機取樣期限分開，牆鐘跳動及過期拒絕',()=>{
  const {plan,request,answer}=fixture();
  assert.throws(()=>probePlan({...plan,expiresAt:1801001}),/H3_PROBE_PLAN/u);
  assert.throws(()=>answer(request,[2010,2711],[10,711]),/H3_PROBE_LOCAL_DEADLINE/u);
  const f=fixture(), response=f.answer();
  assert.throws(()=>verifyProbe({...f,response,sentAt:2000,receivedAt:2015,roundTripMs:5001}),/H3_PROBE_RESPONSE/u);
  assert.throws(()=>verifyProbe({...f,response,sentAt:2000,receivedAt:2015,roundTripMs:550}),/H3_PROBE_CLOCK_STEP/u);
  assert.equal(verifyProbe({...f,response,sentAt:2000,receivedAt:2800,roundTripMs:800}).compatibleWith700msAtProbe,false);
});

test('固定訊框拒絕多訊息、重複欄位、非 UTF-8 和超額資料',async()=>{
  const read=(...parts)=>readProbeFrame(Readable.from(parts.map(part=>Buffer.from(part))));
  assert.deepEqual(await read('{"v"',':1}\n'),{v:1});
  await assert.rejects(read('{}\n{}\n'),/H3_PROBE_SINGLE_FRAME/u);
  await assert.rejects(read('{"v":1,"v":2}\n'),/H3_PROBE_FRAME_CANONICAL/u);
  await assert.rejects(read(Buffer.from([0xff,0x0a])));
  await assert.rejects(read(' '.repeat(4096),'\n'),/H3_PROBE_FRAME_SIZE/u);
});
