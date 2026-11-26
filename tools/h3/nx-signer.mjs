import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { qualificationMessage } from '../../src/worker/admission.mjs';
import { hash } from '../../src/worker/simulation.mjs';
import { NX_AUDIT, NX_CODE, nxH3Mode } from '../nx-legacy/layout.mjs';
import { checkNxObserver, nxLaunch } from '../nx-legacy/authority.mjs';
import { unitIsGone } from '../engine-qualification/integration-host.mjs';
import { legacySliceGone } from '../engine-qualification/legacy-slice.mjs';
import { exact, requireH3 } from './wire.mjs';
import { protectedJson, restorationKey } from './nx-profile.mjs';

const sha=content=>createHash('sha256').update(content).digest('hex');
const HEX=/^[a-f0-9]{64}$/u;

// 由受保護的 root 監督程序呼叫，所有簽署內容都來自固定稽核路徑及已提交的 R1 資料。
export function signNxRestoration({qualified, options}) {
  requireH3(nxH3Mode&&fileURLToPath(import.meta.url)===NX_CODE+'/tools/h3/nx-signer.mjs'&&
    process.execPath===NX_CODE+'/runtime/node'&&process.getuid()===0&&process.getgid()===0,'H3_SIGNER_BOUNDARY');
  const launch=nxLaunch();
  checkNxObserver(launch);
  const payload=protectedJson(NX_AUDIT+'/h3-restore-sign-request.json');
  const intent=protectedJson(NX_AUDIT+'/h3-dispatch-intent.json');
  const completed=protectedJson(NX_AUDIT+'/h3-engine-committed.json');
  const terminal=protectedJson(NX_AUDIT+'/h3-terminal.json');
  const role=protectedJson(NX_AUDIT+'/h3-role-attestation.json');
  const requestFile=NX_AUDIT+'/restore-request.json';
  const hostFile=NX_AUDIT+'/host-restored.json';
  const request=protectedJson(requestFile);
  const host=protectedJson(hostFile);
  const envelope=protectedJson(NX_AUDIT+'/restore-approved.json');
  const baseline=protectedJson(NX_AUDIT+'/baseline.json');
  requireH3(unitIsGone()&&legacySliceGone()&&intent.bridgePid===process.pid&&same(intent.binding,payload.binding)&&
    intent.launch===launch.value.operation&&payload.pin===qualified.pin&&payload.epoch===qualified.claim.epoch&&
    request.operation===launch.value.operation&&request.releaseSha256===launch.value.releaseSha256&&
    host.requestSha256===sha(readFileSync(requestFile))&&same(host.after,baseline.topology)&&same(host.services,baseline.services)&&
    same(envelope,{operation:launch.value.operation,requestSha256:host.requestSha256,hostEvidenceSha256:sha(readFileSync(hostFile))}) &&
    request.jobId===payload.r1JobId&&request.attemptId===payload.r1AttemptId&&
    request.topologySha256===payload.topologySha256&&request.evidenceSha256===payload.evidenceSha256&&
    completed.engine===payload.engine&&same(completed.binding,payload.binding)&&
    completed.outputSha256===sha(terminal.value?.result?.output??'')&&same(completed.usage,terminal.value?.result?.usage)&&
    exact(completed.restoration,['verifiedAt','committedAt','r1JobId','r1AttemptId','r1ReleaseSha256','topologySha256','evidenceSha256'])&&
    Object.entries(completed.restoration).every(([k,v])=>payload[k]===v)&&exact(terminal,['value','signature'])&&
    terminal.value.pin===qualified.pin&&terminal.value.epoch===qualified.claim.epoch&&
    same(terminal.value.binding,payload.binding)&&terminal.value.engine===payload.engine&&
    hash(terminal)===payload.terminalSha256&&/^[a-f0-9]{128}$/u.test(terminal.signature)&&
    verify(null,qualificationMessage('TERMINAL',terminal.value),options.workerPublicKey,Buffer.from(terminal.signature,'hex'))&&
    intent.rolePid===role.pid&&role.workerKey===options.target.workerKey&&
    HEX.test(payload.nonce)&&Number.isSafeInteger(payload.committedAt)&&
    payload.committedAt<=Date.now()&&Date.now()-payload.committedAt<=700,'H3_SIGNER_RESTORE_EVIDENCE');
  const database=NX_AUDIT+'/work/r1.sqlite';
  const status=lstatSync(database);
  requireH3(status.isFile()&&status.uid===0&&status.gid===0&&status.nlink===1&&!(status.mode&0o022)&&
    realpathSync(database)===database,'H3_SIGNER_R1_STORAGE');
  const db=new DatabaseSync(database,{readOnly:true});
  try {
    const row=db.prepare('SELECT phase,attempt_id FROM v08_intents WHERE job_id=?').get(payload.r1JobId);
    const event=db.prepare('SELECT event,data FROM v08_audit WHERE job_id=? ORDER BY seq DESC LIMIT 1').get(payload.r1JobId);
    requireH3(row?.phase==='RELEASED'&&row.attempt_id===payload.r1AttemptId&&event?.event==='HOST_RESTORED_RELEASE'&&
      JSON.parse(event.data).restoreSha256===payload.r1ReleaseSha256,'H3_SIGNER_R1_NOT_COMMITTED');
  }finally{db.close();}
  const key=restorationKey();
  requireH3(createPublicKey(key).equals(options.restorationAuthorityPublicKey),'H3_SIGNER_PRIVATE_KEY_PIN');
  return {value:payload,signature:sign(null,qualificationMessage('RESTORED',payload),key).toString('hex')};
}
