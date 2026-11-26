import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {statfsSync,readFileSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {totalmem} from 'node:os';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {startService} from '../server.mjs';
import {signAgentSnapshot} from '../agent/protocol.mjs';
import {projectLegacyTelemetry} from '../src/legacy-telemetry.mjs';
import {createLocalMonitor} from '../src/local-monitor.mjs';
import {publicNode} from '../src/management-view.mjs';
import {createObservationStore} from '../src/observation-store.mjs';
import {openTelemetry} from '../src/telemetry.mjs';
import {createPinnedLegacyObserver} from '../src/legacy-capture-auth.mjs';
import {createWorkspaceFixture} from '../tools/fixtures/workspace-fixture.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const metrics={
  cpuPercent:0,ramUsedBytes:4194304,ramBytes:8388608,swapUsedBytes:0,swapBytes:0,diskUsedBytes:0,diskBytes:16384,
  gpuPercent:null,gpuUsedBytes:null,temperatureC:42
};
const row={name:'fixture:preview',digest:'a'.repeat(64),sizeBytes:16};
function key(nodeId,kind,tokenId){
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  return {pin:{nodeId,kind,tokenId,publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64url')},privateKey};
}

async function installed(t,monitoring){
  const allowed=['config.json','tokens.json','install-manifest.json','maintenance.lock','storage-seal.json',
    ...['controller.sqlite','telemetry.sqlite'].flatMap(db=>['','-wal','-shm','-journal'].map(suffix=>'data/'+db+suffix))]
    .map(path=>join('installed',path));
  const fixture=await createWorkspaceFixture('jcm-observations-',allowed);
  const target=join(fixture.root,'installed'),config=join(target,'config.json');
  let app;
  t.after(async()=>{await app?.close();await fixture.clean();});
  function cli(...args){
    const outcome=spawnSync(process.execPath,[join(project,'tools','rc.mjs'),...args],
      {cwd:project,encoding:'utf8',windowsHide:true,timeout:40000});
    assert.equal(outcome.status,0,outcome.stderr.trim());
    return JSON.parse(outcome.stdout);
  }
  cli('setup',target);
  await fixture.recordDirectory(target);
  await fixture.recordDirectory(join(target,'data'));
  writeFileSync(config,JSON.stringify({...JSON.parse(readFileSync(config)),port:0,monitoring}));
  const issue=(id,scope)=>cli('token','issue',target,id,scope).token;
  const open=async()=>{app=await startService(config,{audit:()=>{}});};
  const call=async(path,token,body)=>{
    const reply=await fetch('http://127.0.0.1:'+app.info.port+path,{
      headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},
      ...(body?{method:'POST',body:JSON.stringify(body)}:{})
    });
    return {status:reply.status,value:await reply.json()};
  };
  return {issue,open,call,close:()=>app.close(),dataDir:join(target,'data')};
}

function snapshot(device,challenge,sequence,sampledAt=Date.now(),extra={}){
  return signAgentSnapshot({version:1,nodeId:device.pin.nodeId,sequence,challenge,sampledAt,
    metrics,models:[row],resident:[],...extra},device.privateKey);
}

test('本機 CPU 使用率根據相鄰樣本，保留有效零值及不可核對項目',()=>{
  let idle=0;
  const monitor=createLocalMonitor('unused',{readCpus:()=>[{times:{idle,user:1,sys:0}}],readMemory:()=>[100,50],
    readDisk:()=>({bsize:4n,frsize:4n,blocks:20n,bfree:20n}),now:()=>1000});
  assert.equal(monitor().metrics.cpuPercent,null);
  idle=100;
  const node=monitor();
  assert.equal(node.metrics.cpuPercent,0);
  assert.equal(node.cpuCores,1);
  assert.equal(node.metrics.diskUsedBytes,0);
  assert.equal(node.metrics.gpuPercent,null);
  assert.equal(node.models,null);
});

test('真實本機 HTTP：簽章遙測的角色、節點證據、空清單與重啟不重播',async t=>{
  const first=key('lab-agent','JETSON_AGENT','publisher-a');
  const rogue=key('lab-agent','JETSON_AGENT','publisher-a');
  const relayFixture=await createWorkspaceFixture('jcm-relay-observations-',[
    join('relay','relay-binding.json'),
    ...['agent-config.json','agent-seq.json','agent-key.der','maintenance.lock'].map(name=>join('relay','signer',name))
  ]);
  const relay=join(relayFixture.root,'relay');
  const authority=key('observer','V06_V07_BRIDGE','source-observer');
  const sourceIdentity='b'.repeat(64);
  t.after(()=>relayFixture.clean());
  function runRelay(args,input){
    const result=spawnSync(process.execPath,[join(project,'tools','relay-telemetry.mjs'),...args],
      {cwd:project,encoding:'utf8',windowsHide:true,timeout:40000,input});
    assert.equal(result.status,0,result.stderr.trim());
    return JSON.parse(result.stdout);
  }
  const pinned=runRelay(['init',relay,'legacy-node','fixture-upstream',authority.pin.publicKey,sourceIdentity]);
  await relayFixture.recordDirectory(relay);
  await relayFixture.recordDirectory(join(relay,'signer'));
  const bridge={nodeId:pinned.nodeId,publicKey:pinned.publicKey,kind:'V06_V07_BRIDGE',tokenId:'publisher-b'};
  const app=await installed(t,{sources:[first.pin,bridge]});
  const reader=app.issue('viewer','manage:read'),pubA=app.issue('publisher-a','telemetry:publish'),
    pubB=app.issue('publisher-b','telemetry:publish'),runner=app.issue('runner','models:run');
  await app.open();
  const root='/acm/v1';
  assert.equal((await app.call(root+'/dashboard',reader)).value.source,'CONFIGURED_ONLY');
  const challenge=(token,nodeId)=>app.call(root+'/telemetry/challenge',token,{nodeId});
  const publish=(token,nodeId,record)=>app.call(root+'/telemetry/snapshot',token,{nodeId,snapshot:record});
  assert.equal((await challenge(reader,first.pin.nodeId)).status,403);
  assert.equal((await challenge(pubA,bridge.nodeId)).status,403);
  assert.equal((await app.call(root+'/nodes',pubA)).status,403);
  const request=await challenge(pubA,first.pin.nodeId);
  assert.equal(request.status,200);
  const nonce=request.value.challenge;
  const old=snapshot(first,nonce,1,Date.now()-16000);
  assert.equal((await publish(pubA,first.pin.nodeId,old)).status,400);
  assert.equal((await publish(pubA,first.pin.nodeId,snapshot(rogue,nonce,1))).status,400);
  const accepted=snapshot(first,nonce,1);
  assert.equal((await publish(pubA,first.pin.nodeId,accepted)).status,200);
  assert.equal((await publish(pubA,first.pin.nodeId,accepted)).status,400);
  const data=(await app.call(root+'/nodes/'+first.pin.nodeId,reader)).value.data;
  assert.equal(data.source,'JETSON_AGENT');
  assert.equal(data.telemetry.cpuPercent,0);
  assert.equal(data.telemetry.gpuPercent,null);
  assert.equal(data.monitoring.freshness,'FRESH');
  const list=(await app.call(root+'/nodes/'+first.pin.nodeId+'/resident',reader)).value.data;
  assert.deepEqual(list.models,[]);
  assert.equal(list.source,'JETSON_AGENT');

  const legacyNonce=(await challenge(pubB,bridge.nodeId)).value.challenge;
  const timestamp=Date.now();
  const upstream=legacyFrame(timestamp);
  const unsigned=spawnSync(process.execPath,[join(project,'tools','relay-telemetry.mjs'),'sign',relay,legacyNonce],
    {cwd:project,encoding:'utf8',windowsHide:true,input:JSON.stringify(upstream)});
  assert.equal(unsigned.status,1);
  assert.match(unsigned.stderr,/LEGACY_OBSERVER_PROOF_REJECTED/);
  let binding=sourceIdentity;
  const exporter=createPinnedLegacyObserver({sourceIdentity,privateKey:authority.privateKey,resolveIdentity:()=>binding,
    capture:({method,projections,upstreamNodeId})=>{
      assert.deepEqual([method,projections,upstreamNodeId],['GET',['health','node','models','resident'],'fixture-upstream']);
      return upstream;
    }});
  binding='c'.repeat(64);
  await assert.rejects(exporter({challenge:legacyNonce,upstreamNodeId:'fixture-upstream'}),/LEGACY_OBSERVER_PROOF_REJECTED/);
  binding=sourceIdentity;
  const capture=await exporter({challenge:legacyNonce,upstreamNodeId:'fixture-upstream'});
  const signed=runRelay(['sign',relay,legacyNonce],JSON.stringify(capture));
  assert.equal(signed.payload.sampledAt,timestamp);
  assert.equal((await publish(pubB,bridge.nodeId,signed)).status,200);
  const observation=(await app.call(root+'/dashboard',reader)).value;
  assert.equal(observation.nodes.find(node=>node.id===bridge.nodeId).source,'V06_V07_BRIDGE');
  assert.ok(observation.nodes.every(node=>node.availability==='UNVERIFIED'));
  assert.equal(observation.jobs.length,0);
  assert.equal((await app.call('/v1/completions',runner,{model:row.name,prompt:'fixture'})).status,403);
  const history=(await app.call(root+'/dashboard/history?nodeId='+first.pin.nodeId,reader)).value.samples;
  assert.equal(history[0].source,'JETSON_AGENT');
  assert.equal(history[0].cpuPercent,0);
  await app.close();
  await app.open();
  const freshNonce=(await challenge(pubA,first.pin.nodeId)).value.challenge;
  assert.equal((await publish(pubA,first.pin.nodeId,snapshot(first,freshNonce,1))).status,400);
  assert.equal((await publish(pubA,first.pin.nodeId,snapshot(first,freshNonce,2))).status,200);
  assert.equal((await app.call(root+'/dashboard',reader)).value.jobs.length,0);
});

function legacyFrame(at){
  const node={id:'fixture-upstream',identityVerified:true,status:'ONLINE',monitoring:{status:'ACTIVE',freshness:'FRESH',sampledAt:at},
    telemetry:{cpuPercent:0,gpuPercent:null,ram:{usedKiB:1024,totalKiB:8192},disk:{usedKiB:0,totalKiB:32},
      swap:{usedKiB:0,totalKiB:0},temperatures:[]}};
  return {source:'V07_MANAGEMENT_CAPTURE',capturedAt:at,
    health:{data:{apiVersion:'1',mode:'READ_ONLY',dataSource:'V06_LOOPBACK_VERIFIED',inference:'DISABLED'}},
    node:{data:node},models:{data:{nodeId:node.id,models:[row]}},resident:{data:{nodeId:node.id,models:[row.name],sampledAt:at}}};
}
test('V0.6 觀測器與 V0.7 API 格式保留原採樣時間，拒絕模擬及交叉身分',()=>{
  const now=Date.now(),legacy=legacyFrame(now);
  const sample=projectLegacyTelemetry(legacy,'fixture-upstream',now);
  assert.equal(sample.sampledAt,now);
  assert.equal(sample.metrics.cpuPercent,0);
  assert.equal(sample.metrics.swapBytes,0);
  assert.deepEqual(sample.resident,[row]);
  assert.throws(()=>projectLegacyTelemetry(legacy,'another-id',now),/SOURCE_UNVERIFIED/);
  assert.throws(()=>projectLegacyTelemetry(legacy,'fixture-upstream',now+16000),/SOURCE_UNVERIFIED/);
  assert.throws(()=>projectLegacyTelemetry({...legacy,health:{data:{...legacy.health.data,dataSource:'SIMULATION'}}},
    'fixture-upstream',now),/SOURCE_UNVERIFIED/);
  const frame={source:'V06_LOOPBACK_VERIFIED',capturedAt:now,nodes:[{
    node:{...legacy.node.data,monitoring:{lastSampleAt:now,stale:false,status:'ACTIVE'}},
    models:{ok:true,data:[]},resident:{ok:false}
  }]};
  const previous=projectLegacyTelemetry(frame,'fixture-upstream',now);
  assert.deepEqual(previous.models,[]);
  assert.equal(previous.resident,null);
});

test('Windows 真實本機 CPU/RAM/磁碟採樣送達 Dashboard，狀態未取得執行資格',
  {skip:process.platform!=='win32'},async t=>{
    const app=await installed(t,{windowsLocal:true});
    const reader=app.issue('windows-view','manage:read');
    await app.open();
    const view=async()=> (await app.call('/acm/v1/dashboard',reader)).value.nodes[0];
    const first=await view();
    assert.equal(first.source,'WINDOWS_LOCAL');
    assert.equal(first.freshness,'FRESH');
    assert.equal(first.ramBytes,totalmem());
    assert.equal(first.availability,'UNVERIFIED');
    assert.equal(first.metrics.gpuPercent,null);
    assert.equal(first.resident,null);
    const disk=statfsSync(app.dataDir,{bigint:true});
    assert.equal(first.diskBytes,Number(disk.blocks*(disk.frsize>0n?disk.frsize:disk.bsize)));
    await delay(5150);
    const next=await view();
    assert.ok(next.metrics.sampledAt>first.metrics.sampledAt);
    assert.ok(Number.isFinite(next.metrics.cpuPercent)&&next.metrics.cpuPercent<=100&&next.metrics.cpuPercent>=0);
    const history=(await app.call('/acm/v1/dashboard/history?nodeId=windows-local',reader)).value.samples;
    assert.ok(history.length>=2&&history.every(row=>row.source==='WINDOWS_LOCAL'));
  });

test('已核對來源過期時沿用原時間，移除即時數值與模型狀態',()=>{
  const monitored={id:'example-node',source:'JETSON_AGENT',status:'ONLINE',identityVerified:true,
    metrics:{sampledAt:1000,cpuPercent:0},models:[{id:'fixture:preview'}],resident:[]};
  const fresh=publicNode(monitored,5000);
  assert.equal(fresh.metrics.cpuPercent,0);
  assert.deepEqual(fresh.resident,[]);
  const stale=publicNode(monitored,17000);
  assert.equal(stale.status,'UNKNOWN');
  assert.equal(stale.freshness,'STALE');
  assert.equal(stale.metrics.sampledAt,1000);
  assert.equal(stale.metrics.cpuPercent,null);
  assert.equal(stale.models,null);
  assert.equal(stale.resident,null);
});

test('接收後以單調時間判斷過期，時鐘回校不使樣本復活',()=>{
  let epoch=1700000000000,elapsed=0;
  const store=createObservationStore({telemetry:{record:()=>{}},now:()=>epoch,monotonic:()=>elapsed});
  store.setLocal({id:'windows-local',source:'WINDOWS_LOCAL',status:'ONLINE',identityVerified:true,
    metrics:{sampledAt:epoch,cpuPercent:0},models:null,resident:null});
  assert.equal(publicNode(store.nodes()[0],epoch).freshness,'FRESH');
  elapsed=16000;
  epoch-=500;
  assert.equal(publicNode(store.nodes()[0],epoch).freshness,'STALE');
  epoch+=1000;
  assert.equal(publicNode(store.nodes()[0],epoch).metrics.cpuPercent,null);
});

test('歷史資料同時間衝突時不提交遙測序號',async t=>{
  const fixture=await createWorkspaceFixture('jcm-history-collision-',
    ['','-wal','-shm','-journal'].map(suffix=>'telemetry.sqlite'+suffix));
  const db=openTelemetry(fixture.root);
  t.after(async()=>{db.close();await fixture.clean();});
  const sampledAt=Date.now(),fingerprint='test-pin';
  const node={id:'example',source:'JETSON_AGENT',status:'ONLINE',identityVerified:true,
    metrics:{sampledAt,cpuPercent:0},models:[],resident:[]};
  db.record([node],sampledAt);
  assert.throws(()=>db.acceptObservation(node,sampledAt,{fingerprint,sequence:1}),/Observation ordering rejected/);
  assert.equal(db.sequenceFloor(node.id,fingerprint),0);
  const next={...node,metrics:{sampledAt:sampledAt+1,cpuPercent:1}};
  db.acceptObservation(next,sampledAt+1,{fingerprint,sequence:1});
  assert.equal(db.sequenceFloor(node.id,fingerprint),1);
  assert.deepEqual(db.history({nodeId:node.id,to:sampledAt+1}).map(row=>row.cpuPercent),[0,1]);
});
