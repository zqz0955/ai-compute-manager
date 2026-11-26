import {createPublicKey} from 'node:crypto';
import {createDurableCleanup} from './durable-cleanup.mjs';
import {createUpstreamAuditVerifier} from './upstream-terminal.mjs';
import {fail,hex,sha} from './ollama-once.mjs';

export function restorePermission(permit,expected,binding,pending,now=Date.now()){
  return !!permit&&['boot','manifest','release','token','invocation'].every(name=>
    typeof expected[name]==='string'&&expected[name]&&permit[name]===expected[name])&&
    permit.attemptId===binding.attemptId&&permit.jobId===binding.jobId&&
    permit.evidenceSha256===sha(JSON.stringify(pending.evidence))&&hex(permit.topologySha256)&&
    permit.serviceGone===true&&permit.sliceGone===true&&permit.baselineRestored===true&&
    permit.worker?.code===0&&permit.worker.signal===null&&permit.worker.rootReleaseDenied===true&&
    Number.isSafeInteger(pending.observedAt)&&Number.isSafeInteger(permit.verifiedAt)&&
    pending.observedAt>=binding.intentAt&&pending.observedAt<=permit.verifiedAt&&
    permit.verifiedAt<=now&&now-permit.verifiedAt<=30000&&now-pending.observedAt<=60000;
}

export function inspectOrRelease({store,identity,expected,permit}){
  const upstream=createUpstreamAuditVerifier({...identity,workerPublicKey:createPublicKey(identity.workerPublicKey),
    controllerPublicKey:createPublicKey(identity.controllerPublicKey)});
  if(identity.release!==expected.release)throw fail('RELEASE_IDENTITY');
  const durable=createDurableCleanup(store,{upstream,authorizeRecovery:()=>null,
    authorizeRestore:(a,binding,pending)=>restorePermission(a,expected,binding,pending)});
  const rows=store.db.prepare('SELECT job_id,attempt_id,phase FROM v08_intents').all();
  if(rows.length!==1)throw fail('RESTORE_SINGLE_INTENT_REQUIRED');
  const row=rows[0];
  if(permit&&row.phase==='HOLD')durable.releaseRestored(row.job_id,permit);
  const state=store.db.prepare('SELECT phase FROM v08_intents WHERE job_id=?').get(row.job_id);
  const last=store.db.prepare('SELECT event,data FROM v08_audit WHERE job_id=? ORDER BY seq DESC LIMIT 1').get(row.job_id);
  const data=JSON.parse(last.data);
  if(state.phase==='RELEASED'&&permit&&data.restoreSha256!==sha(JSON.stringify(permit)))
    throw fail('RESTORE_PERMIT_ALREADY_CONSUMED');
  return {jobId:row.job_id,attemptId:row.attempt_id,phase:state.phase,event:last.event,
    cleanupConfirmed:store.get(row.job_id).cleanup?.confirmed===true,
    ...(state.phase==='RELEASED'?{restoreSha256:data.restoreSha256,evidence:data.evidence}:{})};
}
