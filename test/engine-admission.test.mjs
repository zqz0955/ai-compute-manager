import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';
import { createQualifiedWorker, qualificationMessage, workerKeyPin } from '../src/worker/admission.mjs';
import { hash } from '../src/worker/simulation.mjs';

test('真正引擎的 Worker 清場欄位須有可信主機對同次 R1 提交的簽章', async () => {
  const authority = generateKeyPairSync('ed25519'), key = generateKeyPairSync('ed25519');
  const now = Date.now(), engine = randomUUID();
  const claim = {
    id:randomUUID(),scope:'ACM_V1_ISOLATED_ENGINE_ONCE_V1',source:'ISOLATED_REAL_ENGINE',
    store:'0'.repeat(64),node:{id:'isolated-host',resource:'a'.repeat(64),aliases:[],platform:'fixture'},
    model:{id:'fixture:qualification',digest:'1'.repeat(64),device:'cpu',context:512,maxTokens:16},
    epoch:randomUUID(),workerKey:workerKeyPin(key.publicKey),
    transport:'2'.repeat(64),runtime:'3'.repeat(64),evidence:'4'.repeat(64),notBefore:now-1000,expiresAt:now+60_000,
  };
  const pin=hash(claim), nonce='c'.repeat(64);
  const binding = {workerPin:pin,admissionId:claim.id,resource:claim.node.resource,nodeId:claim.node.id,
    model:claim.model.id,digest:claim.model.digest,jobId:randomUUID(),attemptId:randomUUID(),
    intentAt:now,maxTokens:16,inputHash:hash(['completion','test',16])};
  const result={outcome:'SUCCEEDED',output:'OK',usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3},
    code:null,finishReason:'stop'};
  const seal=(kind,value,signer=key.privateKey)=>({value,signature:sign(null,qualificationMessage(kind,value),signer).toString('hex')});
  let terminalAt;
  const worker=createQualifiedWorker({
    admission:seal('ADMISSION',claim,authority.privateKey),authorityPublicKey:authority.publicKey,
    workerPublicKey:key.publicKey,
    async exchange(request) {
      if(request.operation==='ready') return seal('READY',{pin,epoch:claim.epoch,nonce:request.nonce,
        at:Date.now(),healthy:true,active:0,resident:0});
      if(request.operation==='execute') {
        terminalAt=Date.now();
        return seal('TERMINAL',{pin,epoch:claim.epoch,binding,at:terminalAt,result,engine});
      }
      return seal('CLEARED',{pin,epoch:claim.epoch,binding,nonce,at:Date.now(),terminalSha256:request.terminalSha256,
        engine,healthy:true,active:0,resident:0,gpuResidentBytes:0,reclaimed:true});
    }
  });
  await worker.execute({binding,kind:'completion',input:'test',maxTokens:16,signal:new AbortController().signal});
  const evidence=await worker.queryEvidence(binding,nonce,new AbortController().signal);
  assert.equal(worker.verifies(binding,result,evidence,nonce,Date.now()),false);
  const restored={pin,epoch:claim.epoch,binding,engine,verifiedAt:terminalAt,committedAt:terminalAt,
    terminalSha256:hash(evidence.terminal),nonce,
    r1JobId:randomUUID(),r1AttemptId:randomUUID(),
    r1ReleaseSha256:'5'.repeat(64),topologySha256:'6'.repeat(64),evidenceSha256:'7'.repeat(64)};
  const sample=(restore)=>({terminal:evidence.terminal,sample:seal('CLEARED',{...evidence.sample.value,restore})});
  assert.equal(worker.verifies(binding,result,sample(seal('RESTORED',restored)),nonce,Date.now()),false);
  const replay={...restored,binding:{...binding,attemptId:randomUUID()}};
  assert.equal(worker.verifies(binding,result,sample(seal('RESTORED',replay,authority.privateKey)),nonce,Date.now()),false);
  const replacedOutput={...restored,terminalSha256:'0'.repeat(64)};
  assert.equal(worker.verifies(binding,result,sample(seal('RESTORED',replacedOutput,authority.privateKey)),nonce,Date.now()),false);
  const outOfOrder={...restored,committedAt:restored.verifiedAt-1};
  assert.equal(worker.verifies(binding,result,sample(seal('RESTORED',outOfOrder,authority.privateKey)),nonce,Date.now()),false);
  assert.equal(worker.verifies(binding,result,sample(seal('RESTORED',restored,authority.privateKey)),nonce,Date.now()),true);
});
