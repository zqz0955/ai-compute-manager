import { createHash, sign, verify } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { createQualifiedWorker, qualificationMessage, workerKeyPin } from '../../src/worker/admission.mjs';
import { LEGACY_MODE, MAX_TOKENS, REAL_PROMPT, uuid } from '../../src/worker/r1/ollama-once.mjs';
import { hash } from '../../src/worker/simulation.mjs';
import { exact, requireH3 } from './wire.mjs';

const bootId = value => typeof value === 'string' && uuid(value);
const HEX = /^[a-f0-9]{64}$/u;
// 每個 pin 綁定一份操作窗口；CPU 歷史回條本身沒有授權能力。
const TARGET = ['version','operation','mode','device','boot','hostTrust','controllerKey','workerKey','restoreKey',
  'runtime','release','endpoint','cpuEvidence'];
export function h3TransportPin(target) {
  requireH3(exact(target,TARGET) && target.version === 1 && bootId(target.operation) && bootId(target.boot) &&
    ['legacy-json','legacy-sse'].includes(target.mode) && TARGET.slice(3).filter(key=>key!=='boot')
      .every(key=>typeof target[key]==='string'&&HEX.test(target[key])), 'H3_TARGET_SCHEMA');
  return hash(TARGET.map(key=>[key,target[key]]));
}

export function h3Qualified(options, exchange) {
  const { target, admission, authorityPublicKey, workerPublicKey, controllerPublicKey, restorationAuthorityPublicKey } = options;
  const keyPins = [authorityPublicKey, workerPublicKey,controllerPublicKey,restorationAuthorityPublicKey].map(key=>{
    requireH3(key?.type==='public'&&key.asymmetricKeyType==='ed25519','H3_AUTHORITY_KEY');
    return workerKeyPin(key);
  });
  requireH3(new Set(keyPins).size===keyPins.length,'H3_AUTHORITY_ROLES');
  const worker = createQualifiedWorker({admission,authorityPublicKey,workerPublicKey,restorationAuthorityPublicKey,
    expectedMemoryMode:LEGACY_MODE, exchange});
  const { claim } = worker;
  requireH3(claim.id===target.operation && claim.transport===h3TransportPin(target) &&
    claim.node.resource===target.device && claim.runtime===target.runtime && claim.evidence===target.cpuEvidence &&
    target.workerKey===keyPins[1] && target.controllerKey===keyPins[2] && target.restoreKey===keyPins[3] &&
    claim.model.id==='qwen2.5:0.5b-instruct-q4_K_M' &&
    claim.model.digest==='a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67' &&
    claim.model.maxTokens===MAX_TOKENS,'H3_TARGET_DENIED');
  return worker;
}

const seal=(key,kind,value)=>({value,signature:sign(null,qualificationMessage(kind,value),key).toString('hex')});

export function h3Dispatch({ qualified, workerPrivateKey, sealWorker, restorePublicKey, context, recordIntent,
  dispatchReady, execute, authorizeRestore }) {
  const { claim, pin }=qualified;
  const fixed={pin,epoch:claim.epoch};
  const signWorker=sealWorker??((kind,value)=>seal(workerPrivateKey,kind,value));
  let phase=0, binding, engine, terminal, restoration;
  return async (request,{signal,onDelta})=>{
    signal.throwIfAborted();
    const now=Date.now();
    requireH3(request.pin===pin&&now>=claim.notBefore&&now<claim.expiresAt,'H3_WINDOW');
    if (phase===0) {
      requireH3(exact(request,['operation','pin','nonce'])&&request.operation==='ready'&&HEX.test(request.nonce)&&
        claim.expiresAt-now>=300000,'H3_READY');
      await dispatchReady();
      signal.throwIfAborted();
      phase=1;
      return signWorker('READY',{...fixed,nonce:request.nonce,at:Date.now(),healthy:true,active:0,resident:0});
    }
    if (phase===1) {
      binding=request.binding;
      requireH3(exact(request,['operation','pin','binding','kind','input','maxTokens'])&&request.operation==='execute'&&
        request.kind==='completion'&&request.input===REAL_PROMPT&&request.maxTokens===MAX_TOKENS&&
        exact(binding,['jobId','attemptId','nodeId','owner','resource','model','digest','inputHash','intentAt','admissionId','workerPin','maxTokens'])&&
        uuid(binding.jobId)&&uuid(binding.attemptId)&&uuid(binding.owner)&&binding.nodeId===claim.node.id&&binding.resource===claim.node.resource&&
        binding.model===claim.model.id&&binding.digest===claim.model.digest&&binding.workerPin===pin&&
        binding.admissionId===claim.id&&binding.maxTokens===request.maxTokens&&
        binding.inputHash===hash([request.kind,request.input,request.maxTokens])&&
        Number.isSafeInteger(binding.intentAt)&&binding.intentAt<=now&&binding.intentAt>=claim.notBefore&&
        claim.expiresAt-now>=300000,'H3_EXECUTE_DENIED');
      phase=2;
      // 在呼叫引擎前固定本次意圖。就算傳輸中止，重新連線也不得再次執行。
      recordIntent(binding);
      let sequence=0, pending=Promise.resolve();
      const expectedBinding=structuredClone(binding);
      const execution = await execute({binding:expectedBinding,claim,signal,publish(content){
        requireH3(context.mode==='legacy-sse'&&signal.aborted===false,'H3_DELTA_MODE');
        const value={...fixed,binding,sequence:++sequence,content};
        pending=pending.then(async()=>onDelta(await signWorker('DELTA',value)));
        pending.catch(()=>{});
      }});
      await pending;
      signal.throwIfAborted();
      ({engine, restoration}=execution);
      requireH3(uuid(engine)&&restoration&&same(expectedBinding,binding),'H3_TERMINAL_RESTORE_BINDING');
      const {terminal:raw}=execution;
      const result={outcome:'SUCCEEDED',output:raw.output,usage:raw.usage,code:null,finishReason:raw.engineEvidence.doneReason};
      terminal=await signWorker('TERMINAL',{...fixed,binding,at:Date.now(),result,engine});
      return terminal;
    }
    requireH3(phase===2&&terminal&&exact(request,['operation','pin','binding','nonce','terminalSha256'])&&
      request.operation==='sample'&&HEX.test(request.nonce)&&same(request.binding,binding)&&
      request.terminalSha256===hash(terminal),'H3_RESTORE_SAMPLE');
    phase=3;
    const value={...fixed,binding,engine,verifiedAt:restoration.verifiedAt,committedAt:restoration.committedAt,
      r1JobId:restoration.r1JobId,r1AttemptId:restoration.r1AttemptId,r1ReleaseSha256:restoration.r1ReleaseSha256,
      topologySha256:restoration.topologySha256,evidenceSha256:restoration.evidenceSha256,
      terminalSha256:request.terminalSha256,nonce:request.nonce};
    const restored=await authorizeRestore(value,signal);
    signal.throwIfAborted();
    requireH3(exact(restored,['value','signature'])&&same(restored.value,value)&&
      /^[a-f0-9]{128}$/u.test(restored.signature)&&verify(null,qualificationMessage('RESTORED',value),restorePublicKey,
        Buffer.from(restored.signature,'hex')),'H3_RESTORE_AUTHORITY');
    return signWorker('CLEARED',{...fixed,binding,nonce:value.nonce,at:Date.now(),
      terminalSha256:value.terminalSha256,engine,healthy:true,active:0,resident:0,gpuResidentBytes:0,reclaimed:true,restore:restored});
  };
}
