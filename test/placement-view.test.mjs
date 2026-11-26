import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dashboardView} from '../src/management-view.mjs';

const now=1900000000000;
const observed=(extra={})=>({
  id:'observed-node',name:'Observed device',platform:'orin-nx',status:'ONLINE',availability:'UNVERIFIED',
  source:'V06_V07_BRIDGE',identityVerified:true,models:[],resident:[],
  metrics:{sampledAt:now,cpuPercent:0,gpuPercent:0,ramUsedBytes:0},...extra
});
function view(observations,mode='read-only',snapshot={nodes:[],jobs:[],locks:[],events:[]}) {
  // 診斷公開介面只有讀取快照的能力；若誤呼叫派送或預留，測試立即失敗。
  const controller=new Proxy({snapshot:()=>structuredClone(snapshot)},{get(target,key){
    assert.equal(key,'snapshot','唯讀診斷不得呼叫其他 Controller 操作');
    return target[key];
  }});
  return dashboardView(controller,mode,'1.0.0-rc2',now,null,()=>observations);
}

test('新鮮實際零值僅供觀測，唯讀逐節點判斷不產生選擇或執行資格',()=>{
  const data=view([observed()]);
  assert.equal(data.nodes[0].metrics.cpuPercent,0);
  assert.equal(data.nodes[0].metrics.gpuPercent,0);
  assert.equal(data.placement.kind,'READ_ONLY_ADMISSION');
  assert.equal(data.placement.status,'REJECTED');
  assert.equal(data.placement.evaluatedAt,now);
  assert.deepEqual(data.placement.selection,[]);
  assert.equal(data.placement.reservationPerformed,false);
  assert.equal(data.placement.dispatchPerformed,false);
  assert.deepEqual(data.placement.nodes,[{
    nodeId:'observed-node',eligible:false,source:'V06_V07_BRIDGE',status:'ONLINE',freshness:'FRESH',
    executionQualification:'NOT_EVALUATED',
    reasons:['READ_ONLY_MODE','OBSERVATION_NOT_EXECUTION_QUALIFICATION']
  }]);
  assert.equal(data.gates.inference,'BLOCKED');
});

test('過期及未知採樣沿用公開遙測判斷，不拿歷史數值授予資格',()=>{
  const data=view([
    observed({id:'stale',metrics:{sampledAt:now-15001,cpuPercent:12,gpuPercent:30}}),
    observed({id:'unknown',metrics:null}),
    observed({id:'untrusted',identityVerified:false}),
  ]);
  assert.deepEqual(data.placement.nodes.map(row=>row.freshness),['STALE','UNKNOWN','UNKNOWN']);
  assert.deepEqual(data.placement.nodes.map(row=>row.reasons),[
    ['READ_ONLY_MODE','OBSERVATION_NOT_EXECUTION_QUALIFICATION','TELEMETRY_STALE'],
    ['READ_ONLY_MODE','OBSERVATION_NOT_EXECUTION_QUALIFICATION','TELEMETRY_UNKNOWN'],
    ['READ_ONLY_MODE','OBSERVATION_NOT_EXECUTION_QUALIFICATION','TELEMETRY_UNKNOWN'],
  ]);
  for(const node of data.nodes){
    assert.equal(node.metrics.cpuPercent,null);
    assert.equal(node.metrics.gpuPercent,null);
    assert.equal(node.models,null);
  }
  assert.ok(data.placement.nodes.every(row=>row.eligible===false));
  assert.deepEqual(data.placement.selection,[]);
});

test('明確離線保留離線理由，過期後不把 UNKNOWN 假裝成已知 OFFLINE',()=>{
  const data=view([
    observed({id:'offline',status:'OFFLINE'}),
    observed({id:'expired',status:'OFFLINE',metrics:{sampledAt:now-15001,cpuPercent:0}}),
  ]);
  assert.equal(data.placement.nodes[0].status,'OFFLINE');
  assert.ok(data.placement.nodes[0].reasons.includes('NODE_OFFLINE'));
  assert.equal(data.placement.nodes[1].status,'UNKNOWN');
  assert.ok(!data.placement.nodes[1].reasons.includes('NODE_OFFLINE'));
  assert.ok(data.placement.nodes[1].reasons.includes('TELEMETRY_STALE'));
  assert.deepEqual(data.placement.selection,[]);
});

test('唯讀投影不修改輸入或既有鎖，不把觀測裝置放入執行設定',()=>{
  const snapshot={nodes:[{id:'configured',status:'LOCKED',availability:'HOLD',source:'CONFIGURED_ONLY',models:[]}],
    jobs:[],locks:[{jobId:'old',attemptId:'old-attempt',nodeId:'configured',resource:'physical-node',phase:'HOLD'}],events:[]};
  const observation=observed({id:'telemetry-only'});
  const before=structuredClone({snapshot,observation});
  const data=view([observation],'read-only',snapshot);
  assert.deepEqual({snapshot,observation},before);
  assert.equal(data.locks[0].phase,'HOLD');
  assert.equal(snapshot.nodes.length,1);
  assert.deepEqual(data.placement.nodes.map(row=>row.eligible),[false,false]);
  assert.equal(data.placement.reservationPerformed,false);
  assert.equal(data.placement.dispatchPerformed,false);
  assert.equal(data.jobs.length,0);
  assert.equal(data.events.length,0);
});

test('模擬、引擎資格及未知模式都不由唯讀視圖推算可派送節點',()=>{
  for(const mode of ['simulation','engine-qualification','unknown']){
    const data=view([observed()],mode);
    assert.deepEqual(data.placement,{
      kind:'READ_ONLY_ADMISSION',status:'NOT_EVALUATED',evaluatedAt:null,selection:null,nodes:[],
      reservationPerformed:false,dispatchPerformed:false
    });
  }
});
