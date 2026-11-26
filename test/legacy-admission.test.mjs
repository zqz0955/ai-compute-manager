import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {test} from 'node:test';
import {createQualifiedWorker,qualificationMessage,workerKeyPin} from '../src/worker/admission.mjs';
import {LEGACY_MODE} from '../src/worker/r1/legacy-memory.mjs';

test('product qualification explicitly binds legacy memory mode and rejects old or implicit claims',()=>{
  const authority=generateKeyPairSync('ed25519'),worker=generateKeyPairSync('ed25519'),now=Date.now();
  const claim={id:randomUUID(),scope:'ACM_V1_ISOLATED_ENGINE_ONCE_V1',source:'ISOLATED_REAL_ENGINE',
    memoryMode:LEGACY_MODE,store:'a'.repeat(64),epoch:randomUUID(),workerKey:workerKeyPin(worker.publicKey),
    node:{id:'legacy-fixture',resource:'b'.repeat(64),aliases:[],platform:'arm64-qemu'},
    model:{id:'fixture:legacy',digest:'c'.repeat(64),device:'cpu',context:512,maxTokens:16},
    transport:'d'.repeat(64),runtime:'e'.repeat(64),evidence:'f'.repeat(64),notBefore:now-1000,expiresAt:now+60000};
  const make=(value,expectedMemoryMode)=>createQualifiedWorker({admission:{value,
    signature:sign(null,qualificationMessage('ADMISSION',value),authority.privateKey).toString('hex')},
    authorityPublicKey:authority.publicKey,workerPublicKey:worker.publicKey,expectedMemoryMode,
    exchange:()=>assert.fail('qualification must not dispatch')});
  assert.equal(make(claim,LEGACY_MODE).claim.memoryMode,LEGACY_MODE);
  assert.throws(()=>make(claim),{code:'WORKER_NOT_QUALIFIED'});
  assert.throws(()=>make(claim,'OTHER_MODE'),{code:'WORKER_NOT_QUALIFIED'});
  const {memoryMode,...old}=claim;
  assert.ok(make(old));
  assert.throws(()=>make(old,LEGACY_MODE),{code:'WORKER_NOT_QUALIFIED'});
  for(const model of [{...claim.model,device:'gpu'},{...claim.model,context:1024},{...claim.model,maxTokens:8}])
    assert.throws(()=>make({...claim,model},LEGACY_MODE),{code:'WORKER_NOT_QUALIFIED'});
});
