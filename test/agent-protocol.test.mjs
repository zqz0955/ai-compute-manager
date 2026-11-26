import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { signAgentSnapshot, verifyAgentSnapshot } from '../agent/protocol.mjs';

const challenge = Buffer.alloc(32, 9).toString('base64url');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pin = publicKey.export({type:'spki',format:'der'}).toString('base64url');
const now = 1_800_000;
const sample = {
  version:1, nodeId:'fixture-nx', sequence:2, challenge, sampledAt:now,
  metrics:{cpuPercent:0,ramUsedBytes:20,ramBytes:100,swapUsedBytes:0,swapBytes:0,
    diskUsedBytes:10,diskBytes:100,gpuPercent:null,gpuUsedBytes:null,temperatureC:null},
  models:[], resident:null,
};
const verifier = {nodeId:'fixture-nx',publicKey:pin,challenge,lastSequence:1,now};

test('簽章的單次只讀回條保留實際零值、沒有資料的欄位與列表差異',()=>{
  const signed=signAgentSnapshot(sample,privateKey);
  const verified=verifyAgentSnapshot(JSON.parse(JSON.stringify(signed)),verifier);
  assert.deepEqual(verified,sample);
  assert.throws(()=>{verified.metrics.cpuPercent=3;},TypeError);
});

test('拒絕舊序號、舊時間、不同設備身分、錯誤公鑰和不同挑戰',()=>{
  const signed=signAgentSnapshot(sample,privateKey);
  const unrelated=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).toString('base64url');
  for(const mismatch of [
    {lastSequence:2},{now:now+30_001},{now:now-1_001},{nodeId:'different-node'},
    {publicKey:unrelated},{challenge:Buffer.alloc(32,3).toString('base64url')},
  ]){
    assert.throws(()=>verifyAgentSnapshot(signed,{...verifier,...mismatch}), /AGENT_SNAPSHOT/u);
  }
  assert.throws(()=>verifyAgentSnapshot({...signed,payload:{...sample,sequence:3}},verifier),/AGENT_SNAPSHOT/u);
});

test('額外欄位、偽造監控來源、不合理利用率及重複模型不進入回條',()=>{
  for(const invalid of [
    {...sample,command:'start'}, {...sample,source:'LIVE'},
    {...sample,metrics:{...sample.metrics,cpuPercent:101}},
    {...sample,metrics:{...sample.metrics,ramUsedBytes:200}},
    {...sample,resident:[{name:'x',digest:'1'.repeat(64),sizeBytes:2},{name:'x',digest:'2'.repeat(64),sizeBytes:5}]},
  ]) assert.throws(()=>signAgentSnapshot(invalid,privateKey), /AGENT_SNAPSHOT/u);
});
