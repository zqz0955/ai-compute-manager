import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { qualificationMessage } from '../../src/worker/admission.mjs';
import { MAX_TOKENS, LEGACY_MODE } from '../../src/worker/r1/ollama-once.mjs';
import { readBytes, readJson, writeNewJson } from '../files.mjs';
import { assertPrivateInstallation } from '../lock.mjs';
import { h3Plan } from './plan.mjs';
import { h3Qualified, h3TransportPin } from './session.mjs';
import { exact, requireH3 } from './wire.mjs';

export function prepareH3Admission(request, privateKey, now=Date.now()) {
  requireH3(exact(request,['version','target','keys','store','node','notBefore','expiresAt'])&&request.version===1&&
    Number.isSafeInteger(now)&&request.notBefore<=now&&request.expiresAt-now>=300000,'H3_ISSUE_SCOPE');
  const {target,keys,store,node,notBefore,expiresAt}=request;
  const value={id:target.operation,scope:'ACM_V1_ISOLATED_ENGINE_ONCE_V1',source:'ISOLATED_REAL_ENGINE',
    memoryMode:LEGACY_MODE,store,node,
    model:{id:'qwen2.5:0.5b-instruct-q4_K_M',digest:'a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67',
      device:'cpu',context:512,maxTokens:MAX_TOKENS},
    epoch:randomUUID(),workerKey:target.workerKey,transport:h3TransportPin(target),runtime:target.runtime,
    evidence:target.cpuEvidence,notBefore,expiresAt};
  const admission={value,signature:sign(null,qualificationMessage('ADMISSION',value),privateKey).toString('hex')};
  const signed={version:1,target,admission,keys};
  h3Qualified(h3Plan(signed),()=>{throw Error('H3_ISSUER_HAS_NO_DISPATCH');});
  return signed;
}

function main(args) {
  const [root,pin,...rest]=args;
  requireH3(rest.length===0&&typeof pin==='string'&&/^[a-f0-9]{64}$/u.test(pin),'H3_ISSUE_USAGE');
  const requestFile=join(root,'request.json'), keyFile=join(root,'admission.pem');
  assertPrivateInstallation(root,[requestFile,keyFile]);
  const request=readJson(requestFile);
  requireH3(request.sha256===pin,'H3_ISSUE_REQUEST_PIN');
  const key=createPrivateKey(readBytes(keyFile,4096).contents);
  writeNewJson(join(root,'admission.json'),prepareH3Admission(request.value,key));
  console.log('ACM_H3_ADMISSION_WRITTEN');
}

if (process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url) {
  try{main(process.argv.slice(2));}
  catch(error) {
    console.error('ACM_H3_ISSUE_HOLD '+(/^[A-Z0-9_]{1,64}$/u.test(error?.code??error?.message)?error.code??error.message:'H3_ISSUE_ERROR'));
    process.exitCode=42;
  }
}
