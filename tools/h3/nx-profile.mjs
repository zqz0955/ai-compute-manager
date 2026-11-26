import { createHash, createPrivateKey } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { constants, closeSync, fstatSync, openSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { NX_CODE, NX_ENGINE, NX_CONTROL, NX_H3_UID, NX_WORKER_UID, NX_ENGINE_UID, nxH3Mode } from '../nx-legacy/layout.mjs';
import { checkNxObserver } from '../nx-legacy/authority.mjs';
import { protectedFile } from '../engine-qualification/integration-host.mjs';
import { requireH3 } from './wire.mjs';
import { h3Plan } from './plan.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

export function protectedJson(path, expected) {
  const pin=protectedFile(path);
  const bytes=readFileSync(path);
  requireH3(sha(bytes)===pin&&(expected===undefined||pin===expected),'H3_NX_JSON_PIN');
  return JSON.parse(bytes);
}

function privateControl() {
  const control=lstatSync(NX_CONTROL);
  requireH3(control.isDirectory()&&control.uid===0&&control.gid===0&&(control.mode&0o777)===0o700&&
    realpathSync(NX_CONTROL)===NX_CONTROL,
    'H3_NX_PRIVATE_CONTROL');
}

export function openWorkerKey() {
  privateControl();
  const path=NX_CONTROL+'/worker.pem';
  const before=lstatSync(path);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const info=fstatSync(fd);
    requireH3(info.isFile()&&info.uid===0&&info.gid===0&&info.nlink===1&&(info.mode&0o777)===0o400&&
      info.size>0&&info.size<=4096&&info.dev===before.dev&&info.ino===before.ino,'H3_NX_ROLE_KEY_MODE');
    return fd;
  }catch(error){closeSync(fd);throw error;}
}

export function restorationKey() {
  privateControl();
  const path=NX_CONTROL+'/restoration.pem';
  const pin=protectedFile(path);
  const info=lstatSync(path);
  requireH3((info.mode&0o777)===0o400&&info.size<=4096,'H3_NX_ROLE_KEY_MODE');
  const bytes=readFileSync(path);
  requireH3(sha(bytes)===pin,'H3_NX_ROLE_KEY_PIN');
  return createPrivateKey(bytes);
}

export function nxWorkerProfile(launch, moduleUrl, leaf) {
  requireH3(nxH3Mode && fileURLToPath(moduleUrl)===NX_CODE+'/tools/h3/'+leaf &&
    process.platform==='linux' && process.arch==='arm64' && process.versions.node==='24.22.3' &&
    process.getuid()===0 && process.getgid()===0 && process.execPath===NX_CODE+'/runtime/node','H3_NX_BOUNDARY');
  privateControl();
  const raw=protectedJson(NX_CONTROL+'/plan.json',launch.value.h3PlanSha256);
  const options=h3Plan(raw,['relayGid']);
  const {target,admission}=options, claim=admission.value;
  const pub=readFileSync('/etc/ssh/ssh_host_ed25519_key.pub','utf8').trim().split(/\s+/u);
  requireH3(pub[0]==='ssh-ed25519' && typeof pub[1]==='string' && sha(Buffer.from(pub[1],'base64'))===target.hostTrust &&
    target.boot===launch.value.boot&&target.device===launch.value.resource&&
    target.endpoint===protectedFile(NX_CODE+'/tools/h3/attach.py')&&target.release===launch.value.manifestSha256&&
    (leaf==='nx-signer.mjs'||target.runtime===protectedFile(NX_ENGINE+'/assets/ollama/bin/ollama')),
    'H3_NX_TARGET_PIN');
  requireH3(target.mode===nxH3Mode&&target.cpuEvidence==='0dc8520f12abec76fe83e507559508b596c8ad15647a7c71faf9ee3b6ef4c7c3'&&
    claim.notBefore>=launch.value.approval.notBefore*1000&&claim.expiresAt<=launch.value.approval.expires*1000&&
    Number.isSafeInteger(raw.relayGid)&&raw.relayGid>0&&raw.relayGid<65535&&
    ![NX_H3_UID,NX_WORKER_UID,NX_ENGINE_UID].includes(raw.relayGid),'H3_NX_MODE_WINDOW');
  checkNxObserver(launch);
  return {options,relayGid:raw.relayGid};
}
