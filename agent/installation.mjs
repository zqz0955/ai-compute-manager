import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  absoluteLocalPath, acquireInstallationLock, assertPinned, assertPrivateInstallation,
  createPrivateRoot, fileIdentity, lockFileName, pinPath,
} from '../tools/lock.mjs';
import { digest, readBytes, readJson, replaceJson, snapshotFile, writeFresh, writeNewJson } from '../tools/files.mjs';
import { collectAgentSample } from './collect.mjs';
import { agentMaxAgeMs, agentNodeId, canonicalBytes, hasFields, readAgentPublicKey, signAgentSnapshot } from './protocol.mjs';

const configName='agent-config.json';
const sequenceName='agent-seq.json';
const keyName='agent-key.der';
const retiredName='agent-retired.json';
const activeNames=[configName,sequenceName,keyName];

function syncDirectory(root){
  if (process.platform==='win32') return;
  assertPinned(root);
  const fd=openSync(root.path,'r');
  try {fsyncSync(fd);} finally {closeSync(fd);}
  assertPinned(root);
}

function allowedNames(root,required,optional=[]){
  assertPinned(root);
  const actual=readdirSync(root.path);
  if (actual.some(name=>!required.includes(name)&&!optional.includes(name))) throw new Error('AGENT_UNKNOWN_ENTRY');
  if (required.some(name=>!actual.includes(name))) throw new Error('AGENT_INSTALLATION_INCOMPLETE');
  assertPrivateInstallation(root.path,actual.map(name=>join(root.path,name)));
  assertPinned(root);
  return actual;
}

function sequenceSnapshot(root){
  const result=readJson(join(root.path,sequenceName));
  const value=result.value;
  if (!hasFields(value,['version','sequence']) || value.version!==1 || !Number.isSafeInteger(value.sequence)
    || value.sequence<0) throw new Error('AGENT_SEQUENCE_INVALID');
  return result;
}

function activeConfig(root){
  assertPinned(root);
  if (readdirSync(root.path).includes(retiredName)) throw new Error('AGENT_RETIRED');
  const names=allowedNames(root,activeNames,[lockFileName]);
  const config=readJson(join(root.path,configName));
  const row=config.value;
  if (!hasFields(row,['version','nodeId','publicKey','rootIdentity','ollama']) || row.version!==1
    || typeof row.nodeId!=='string' || !agentNodeId.test(row.nodeId)
    || row.rootIdentity!==fileIdentity(root.id) || typeof row.ollama!=='boolean') {
    throw new Error('AGENT_CONFIG_INVALID');
  }
  readAgentPublicKey(row.publicKey);
  assertPinned(root);
  return {config,names};
}

function protectedRoot(input){
  const root=pinPath(input,'directory');
  assertPrivateInstallation(root.path);
  return root;
}

export function installAgent(input,nodeId,{ollama=false}={}){
  if (typeof nodeId!=='string' || !agentNodeId.test(nodeId) || typeof ollama!=='boolean') throw new Error('AGENT_CONFIG_INVALID');
  const path=absoluteLocalPath(input);
  const root=pinPath(createPrivateRoot(path),'directory');
  const keys=generateKeyPairSync('ed25519');
  const publicKey=keys.publicKey.export({type:'spki',format:'der'}).toString('base64url');
  const der=keys.privateKey.export({type:'pkcs8',format:'der'});
  try {writeFresh(join(root.path,keyName),fd=>writeFileSync(fd,der));}
  finally {der.fill(0);}
  writeNewJson(join(root.path,sequenceName),{version:1,sequence:0});
  writeNewJson(join(root.path,configName),{version:1,nodeId,publicKey,rootIdentity:fileIdentity(root.id),ollama});
  activeConfig(root);
  syncDirectory(root);
  return {status:'INSTALLED',nodeId,publicKey};
}

export function agentStatus(input){
  const root=protectedRoot(input);
  const receiptPath=join(root.path,retiredName);
  if (readdirSync(root.path).includes(retiredName)){
    const entries=allowedNames(root,[retiredName],activeNames);
    const {value}=readJson(receiptPath);
    if (!hasFields(value,['status','nodeId','publicKey','sequence']) || value.status!=='RETIRED'
      || typeof value.nodeId!=='string' || !agentNodeId.test(value.nodeId) || !Number.isSafeInteger(value.sequence)
      || value.sequence<0) throw new Error('AGENT_RETIREMENT_INVALID');
    readAgentPublicKey(value.publicKey);
    if (entries.length!==1) throw new Error('AGENT_RETIREMENT_INCOMPLETE');
    return value;
  }
  const {config,names}=activeConfig(root);
  return {status:names.includes(lockFileName)?'LOCK_PRESENT':'INSTALLED',nodeId:config.value.nodeId,
    publicKey:config.value.publicKey,sequence:sequenceSnapshot(root).value.sequence,ollama:config.value.ollama};
}

function lockedInstallation(input){
  const root=protectedRoot(input);
  activeConfig(root);
  const release=acquireInstallationLock(join(root.path,configName));
  try {
    const {config}=activeConfig(root);
    const {pin,contents}=readBytes(join(root.path,keyName),48);
    const keyDigest=digest(contents);
    let key;
    try {
      if (contents.length!==48) throw new Error('AGENT_KEY_INVALID');
      key=createPrivateKey({key:contents,type:'pkcs8',format:'der'});
      const actual=createPublicKey(key).export({type:'spki',format:'der'}).toString('base64url');
      if (key.asymmetricKeyType!=='ed25519' || actual!==config.value.publicKey) throw new Error('AGENT_KEY_INVALID');
    } finally {contents.fill(0);}
    return {root,config,key,keyPin:pin,keyDigest,sequence:sequenceSnapshot(root),release};
  } catch (error) {
    release();
    throw error;
  }
}

function confirmCurrent({root,config,keyPin,keyDigest,sequence}){
  assertPinned(root);
  assertPinned(config.pin);
  assertPinned(keyPin);
  assertPinned(sequence.pin);
  if (snapshotFile(config.pin.path,4096).sha256!==config.sha256
    || snapshotFile(keyPin.path,48).sha256!==keyDigest
    || snapshotFile(sequence.pin.path,128).sha256!==sequence.sha256) throw new Error('AGENT_INSTALLATION_CHANGED');
}

export function openAgent(input,{collect=collectAgentSample}={}){
  if (typeof collect!=='function') throw new Error('AGENT_SAMPLER_INVALID');
  const state=lockedInstallation(input);
  const {root,config,key,release}=state;
  let pending;
  let closed=false;
  let closing;
  return Object.freeze({
    nodeId:config.value.nodeId,
    publicKey:config.value.publicKey,
    async sample(challenge,{signal}={}){
      if (closed) throw new Error('AGENT_CLOSED');
      if (pending) throw new Error('AGENT_SAMPLE_BUSY');
      if (canonicalBytes(challenge,32)===null) throw new Error('AGENT_CHALLENGE_INVALID');
      signal?.throwIfAborted();
      confirmCurrent(state);
      const run=(async()=>{
        const report=await collect({ollama:config.value.ollama,signal});
        signal?.throwIfAborted();
        confirmCurrent(state);
        const {metrics,models,resident,sampledAt=Date.now()}=report;
        const current=Date.now();
        if (sampledAt<current-agentMaxAgeMs || sampledAt>current+1_000) throw new Error('AGENT_SAMPLE_STALE');
        const sequence=state.sequence.value.sequence+1;
        const envelope=signAgentSnapshot({version:1,nodeId:config.value.nodeId,sequence,challenge,
          sampledAt,metrics,models,resident},key);
        replaceJson(state.sequence,{version:1,sequence});
        syncDirectory(root);
        state.sequence=sequenceSnapshot(root);
        if (state.sequence.value.sequence!==sequence) throw new Error('AGENT_SEQUENCE_INVALID');
        return envelope;
      })();
      pending=run;
      try {return await run;} finally {pending=null;}
    },
    close(){
      if (closing) return closing;
      closed=true;
      closing=(async()=>{
        try {await pending;} catch { /* A failed sample does not retain the live lock. */ }
        release();
      })();
      return closing;
    },
  });
}

export function retireAgent(input,{apply=false}={}){
  if (typeof apply!=='boolean') throw new Error('AGENT_UNINSTALL_INVALID');
  const state=lockedInstallation(input);
  const {root,config,keyPin,sequence,release}=state;
  try {
    const info={status:apply?'RETIRED':'UNINSTALL_PLAN',nodeId:config.value.nodeId,
      publicKey:config.value.publicKey,sequence:sequence.value.sequence};
    if (!apply) return info;
    confirmCurrent(state);
    writeNewJson(join(root.path,retiredName),info);
    syncDirectory(root);
    allowedNames(root,[...activeNames,retiredName,lockFileName]);
    confirmCurrent(state);
    for (const item of [keyPin,sequence.pin,config.pin]) {
      assertPinned(item);
      unlinkSync(item.path);
    }
    syncDirectory(root);
    return info;
  } finally {
    release();
  }
}
