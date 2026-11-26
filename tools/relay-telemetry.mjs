import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {installAgent,openAgent} from '../agent/installation.mjs';
import {hasFields,readAgentPublicKey} from '../agent/protocol.mjs';
import {verifyLegacyCapture} from '../src/legacy-capture-auth.mjs';
import {IDENTIFIER,SHA256} from './config.mjs';
import {readJson,snapshotFile,writeNewJson} from './files.mjs';
import {assertPinned,assertPrivateInstallation,createPrivateRoot,fileIdentity,pinPath,sameIdentity} from './lock.mjs';

const [command,state,...args]=process.argv.slice(2);
const bindingName='relay-binding.json';
function verifyPin(upstreamNodeId,observerKey,sourceIdentity){
  if (typeof upstreamNodeId!=='string'||!IDENTIFIER.test(upstreamNodeId)||
      typeof sourceIdentity!=='string'||!SHA256.test(sourceIdentity)) throw Error('RELAY_BINDING_INVALID');
  readAgentPublicKey(observerKey);
}
try{
  if (command==='init'&&state&&args.length===4){
    const [nodeId,upstreamNodeId,observerKey,sourceIdentity]=args;
    verifyPin(upstreamNodeId,observerKey,sourceIdentity);
    if(!IDENTIFIER.test(nodeId)) throw Error('RELAY_NODE_INVALID');
    const root=pinPath(createPrivateRoot(state),'directory');
    const signer=installAgent(join(root.path,'signer'),nodeId,{ollama:false});
    assertPinned(root);
    writeNewJson(join(root.path,bindingName),{version:1,rootIdentity:fileIdentity(root.id),nodeId,
      upstreamNodeId,observerKey,sourceIdentity});
    console.log(JSON.stringify(signer));
  } else if (command==='sign'&&state&&args.length===1){
    const chunks=[];
    let length=0;
    for await (const chunk of process.stdin){
      length+=chunk.length;
      if (length>262144) throw Error('LEGACY_TELEMETRY_INPUT_TOO_LARGE');
      chunks.push(chunk);
    }
    const envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    const root=pinPath(state,'directory');
    const bindingPath=join(root.path,bindingName),signer=join(root.path,'signer');
    const files=readdirSync(root.path);
    if (files.length!==2||!files.includes('signer')||!files.includes(bindingName)) throw Error('RELAY_BINDING_INVALID');
    assertPrivateInstallation(root.path,[bindingPath,signer]);
    const {value,pin,sha256}=readJson(bindingPath);
    if (!hasFields(value,['version','rootIdentity','nodeId','upstreamNodeId','observerKey','sourceIdentity'])||
        value.version!==1||value.rootIdentity!==fileIdentity(root.id)) throw Error('RELAY_BINDING_INVALID');
    verifyPin(value.upstreamNodeId,value.observerKey,value.sourceIdentity);
    const [challenge]=args;
    const record=verifyLegacyCapture(envelope,{...value,challenge});
    const agent=openAgent(signer,{collect:()=>record});
    try{
      if (agent.nodeId!==value.nodeId) throw Error('RELAY_BINDING_INVALID');
      const response=await agent.sample(challenge);
      const observed=snapshotFile(bindingPath,1048576);
      assertPinned(root);
      if (!sameIdentity(pin.id,observed.pin.id)||observed.sha256!==sha256) throw Error('RELAY_BINDING_CHANGED');
      console.log(JSON.stringify(response));
    }finally{await agent.close();}
  } else throw Error('USAGE_RELAY_INIT_OR_SIGN');
}catch(cause){
  console.error('ACM_RELAY_HOLD '+(/^[A-Z0-9_]+$/.test(cause?.message??'')?cause.message:'RELAY_INPUT_REJECTED'));
  process.exitCode=1;
}
