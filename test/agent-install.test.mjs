import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorkspaceFixture } from '../tools/fixtures/workspace-fixture.mjs';
import { agentStatus, installAgent, openAgent, retireAgent } from '../agent/installation.mjs';
import { verifyAgentSnapshot } from '../agent/protocol.mjs';

const metrics = {cpuPercent:3,ramUsedBytes:1,ramBytes:25,swapUsedBytes:0,swapBytes:0,
  diskUsedBytes:10,diskBytes:60,gpuPercent:null,gpuUsedBytes:null,temperatureC:null};
const nodeId = 'fixture-nx';
const files = ['agent-config.json','agent-key.der','agent-seq.json','maintenance.lock','agent-retired.json'];
const nonce = () => randomBytes(32).toString('base64url');

test('部署 → 已簽署採樣 → 重啟續號 → 解除安裝保留公開撤銷回條',async t=>{
  const f = await createWorkspaceFixture('jcm-acm-agent-',files.map(name=>join('agent',name)));
  const root = join(f.root,'agent');
  t.after(()=>f.clean());
  const first = installAgent(root,nodeId);
  await f.recordDirectory(root);
  assert.equal(first.status,'INSTALLED');
  assert.equal(first.nodeId,nodeId);
  assert.equal(agentStatus(root).sequence,0);
  const oldCapturedAt = Date.now()-700;
  const collect = async ({ollama})=>{
    assert.equal(ollama,false);
    return {metrics,models:null,resident:[],sampledAt:oldCapturedAt};
  };
  const session = openAgent(root,{collect});
  const verify = (sample,challenge,lastSequence) => verifyAgentSnapshot(sample,{
    nodeId,publicKey:first.publicKey,challenge,lastSequence,
  });
  const challenge = nonce();
  try {
    assert.equal(agentStatus(root).status,'LOCK_PRESENT');
    assert.throws(()=>openAgent(root,{collect}), /INSTALLATION_LOCKED/u);
    assert.throws(()=>retireAgent(root,{apply:true}), /INSTALLATION_LOCKED/u);
    await assert.rejects(session.sample('wrong'),/AGENT_CHALLENGE_INVALID/u);
    const snapshot = verify(await session.sample(challenge),challenge,0);
    assert.equal(snapshot.sampledAt,oldCapturedAt);
    assert.equal(snapshot.sequence,1);
    assert.deepEqual(snapshot.metrics,metrics);
    assert.deepEqual(snapshot.resident,[]);
  } finally {
    await session.close();
  }
  const reopened = openAgent(root,{collect});
  try {
    const next = nonce();
    assert.equal(verify(await reopened.sample(next),next,1).sequence,2);
    assert.throws(()=>retireAgent(root),/INSTALLATION_LOCKED/u);
  } finally {
    await reopened.close();
  }
  assert.equal(retireAgent(root).status,'UNINSTALL_PLAN');
  assert.equal(existsSync(join(root,'agent-key.der')),true);
  const receipt=retireAgent(root,{apply:true});
  assert.deepEqual(receipt,{status:'RETIRED',nodeId,publicKey:first.publicKey,sequence:2});
  assert.deepEqual(agentStatus(root),receipt);
  assert.equal(existsSync(join(root,'agent-key.der')),false);
  assert.equal(existsSync(join(root,'agent-config.json')),false);
  assert.throws(()=>openAgent(root,{collect}),/AGENT_RETIRED/u);
});

test('採樣中的檔案換置與不明檔案都拒絕簽發或解除安裝',async t=>{
  const f = await createWorkspaceFixture('jcm-acm-agent-',files.map(name=>join('agent',name)));
  const root = join(f.root,'agent');
  t.after(()=>f.clean());
  installAgent(root,nodeId,{ollama:true});
  await f.recordDirectory(root);
  const config = join(root,'agent-config.json');
  const original = readFileSync(config);
  let resume;
  const session = openAgent(root,{collect:({ollama})=>{
    assert.equal(ollama,true);
    return new Promise(resolve=>{resume=()=>resolve({metrics,models:[],resident:null});});
  }});
  try {
    const pending = session.sample(nonce());
    await assert.rejects(session.sample(nonce()),/AGENT_SAMPLE_BUSY/u);
    writeFileSync(config,Buffer.concat([original,Buffer.from(' ')]));
    resume();
    await assert.rejects(pending,/AGENT_INSTALLATION_CHANGED/u);
    writeFileSync(config,original);
    const key=join(root,'agent-key.der');
    const originalKey=readFileSync(key);
    const changedKey=Buffer.from(originalKey);
    changedKey[changedKey.length-1]^=1;
    try {
      const newPending=session.sample(nonce());
      writeFileSync(key,changedKey);
      resume();
      await assert.rejects(newPending,/AGENT_INSTALLATION_CHANGED/u);
    } finally {
      writeFileSync(key,originalKey);
      originalKey.fill(0);
      changedKey.fill(0);
    }
  } finally {
    writeFileSync(config,original);
    await session.close();
  }
  await f.createFile(join('agent','operator.txt'),'retain me');
  assert.throws(()=>retireAgent(root,{apply:true}),/AGENT_UNKNOWN_ENTRY/u);
  assert.equal(existsSync(join(root,'agent-key.der')),true);
  assert.equal(existsSync(join(root,'agent-retired.json')),false);
});

test('不符合平台要求時不能使用產品 CLI 建立設備 Agent', {skip:process.platform==='linux'&&process.arch==='arm64'&&process.getuid?.()!==0}, async t=>{
  const f = await createWorkspaceFixture('jcm-acm-agent-',[]);
  t.after(()=>f.clean());
  const root = join(f.root,'agent');
  const result = spawnSync(process.execPath,['agent/cli.mjs','install',root,nodeId],{encoding:'utf8',timeout:10_000});
  assert.equal(result.status,1,result.stderr);
  assert.equal(JSON.parse(result.stderr).code,'AGENT_REQUIRE_NON_ROOT_LINUX_ARM64');
  assert.equal(result.stdout,'');
  assert.equal(existsSync(root),false);
});
