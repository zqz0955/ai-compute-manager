import assert from 'node:assert/strict';
import {test} from 'node:test';
import {captureIdentity,finalizeQualification,observerEnvironment,reviewedObserverFiles,
  verifyObservedView,verifyObserverFiles} from '../tools/h2-live-telemetry.mjs';

test('native identity attestation keeps COMPUTERNAME in its minimal environment',()=>{
  const environment=observerEnvironment({SystemRoot:'C:\\Windows',ProgramData:'C:\\ProgramData',COMPUTERNAME:'fixture-host',
    SECRET_TOKEN:'never-inherit'});
  assert.equal(environment.COMPUTERNAME,'fixture-host');
  assert.equal(environment.ProgramData,'C:\\ProgramData');
  assert.equal(Object.hasOwn(environment,'SECRET_TOKEN'),false);
});

test('native source proof requires process generation, runtime and complete source count',()=>{
  const proof={pid:12,createdTicks:'134000000000000000',port:8875,address:'127.0.0.1',manifestEntries:588,
    runtimeSha256:'A'.repeat(64),manifestSha256:'B'.repeat(64),owner:'fixture',image:'fixture',command:'fixture'};
  const pin=captureIdentity(proof);
  assert.match(pin,/^[a-f0-9]{64}$/);
  assert.notEqual(captureIdentity({...proof,pid:13}),pin);
  assert.notEqual(captureIdentity({...proof,createdTicks:'134000000000000001'}),pin);
  assert.throws(()=>captureIdentity({...proof,manifestEntries:587}),/H2_SOURCE_ATTESTATION_INVALID/);
  assert.throws(()=>captureIdentity({...proof,address:'0.0.0.0'}),/H2_SOURCE_ATTESTATION_INVALID/);
});

test('live comparison preserves zero, unavailable models and original sample time',()=>{
  const at=Date.now();
  const frame={source:'V06_LOOPBACK_VERIFIED',capturedAt:at,nodes:[{node:{id:'node-a',identityVerified:true,
    status:'ONLINE',monitoring:{status:'ACTIVE',stale:false,lastSampleAt:at},telemetry:{cpuPercent:0,gpuPercent:0,
      ram:{usedKiB:4,totalKiB:16},disk:{usedKiB:2,totalKiB:32},swap:{usedKiB:0,totalKiB:0},temperatures:[]}},
    models:{ok:false},resident:{ok:false}}]};
  const view={id:'node-a',source:'V06_V07_BRIDGE',status:'ONLINE',freshness:'FRESH',availability:'UNVERIFIED',
    metrics:{sampledAt:at,cpuPercent:0,gpuPercent:0,ramUsedBytes:4096,diskUsedBytes:2048,swapUsedBytes:0,temperatureC:null},
    ramBytes:16384,diskBytes:32768,swapBytes:0,models:null,resident:null};
  const actual=verifyObservedView(view,frame,'node-a',at);
  assert.equal(actual.installedQuery,'UNKNOWN');assert.equal(actual.installedCount,null);
  assert.equal(actual.metrics.cpuPercent,0);assert.equal(actual.metrics.swapBytes,0);
  assert.throws(()=>verifyObservedView({...view,models:[]},frame,'node-a',at));
  assert.throws(()=>verifyObservedView(view,frame,'node-b',at));
  assert.throws(()=>verifyObservedView(view,frame,'node-a',at+16000));
});

test('observer manifest requires reviewed digest and fifteen safe single-component source names',()=>{
  const value=Object.fromEntries(Array.from({length:15},(_,index)=>['source-'+index+'.mjs','A'.repeat(64)]));
  const manifest={sha256:'57efb01e9ee690444810f40c87b7b484ced822c0dad6d0f6123cba88b086424d',value};
  assert.equal(reviewedObserverFiles(manifest).length,15);
  assert.throws(()=>reviewedObserverFiles({...manifest,sha256:'0'.repeat(64)}),/H2_REVIEWED_OBSERVER_MANIFEST_REQUIRED/);
  for(const invalid of ['../source-0.mjs','folder/source-0.mjs','source-0.exe','source-0.mjs:alternate']){
    const bad={...value};delete bad['source-0.mjs'];bad[invalid]='A'.repeat(64);
    assert.throws(()=>reviewedObserverFiles({...manifest,value:bad}),/H2_REVIEWED_OBSERVER_MANIFEST_REQUIRED/);
  }
  assert.throws(()=>reviewedObserverFiles({...manifest,value:{...value,'source-0.mjs':'not-a-sha'}}),/H2_REVIEWED_OBSERVER_MANIFEST_REQUIRED/);
});

test('all observer dependencies reject content drift and same-content replacement',()=>{
  const original={sha256:'a'.repeat(64),pin:{id:{dev:1n,ino:11n}}};
  const pins=new Map([['live-readonly.mjs',original],['acm-api.mjs',original]]);
  verifyObserverFiles('C:\\fixture',pins,()=>original);
  assert.throws(()=>verifyObserverFiles('C:\\fixture',pins,path=>path.endsWith('acm-api.mjs')?
    {...original,sha256:'b'.repeat(64)}:original),/H2_OBSERVER_SOURCE_DRIFT/);
  assert.throws(()=>verifyObserverFiles('C:\\fixture',pins,path=>path.endsWith('acm-api.mjs')?
    {...original,pin:{id:{dev:1n,ino:12n}}}:original),/H2_OBSERVER_SOURCE_DRIFT/);
});

test('failed close still revokes credentials, removes temporary access and saves HOLD',async()=>{
  const calls=[],record={status:'PASS_LIVE_READONLY_TELEMETRY'};
  await finalizeQualification({record,issuedIds:['one','two'],close:async()=>{calls.push('close');throw Error('secret details');},
    revoke:id=>calls.push('revoke:'+id),removeAccess:()=>calls.push('remove'),writeReceipt:saved=>{
      calls.push('write');assert.equal(saved.status,'HOLD');assert.equal(saved.isolatedServiceStopped,false);
      assert.deepEqual(saved.cleanupErrors,[{stage:'SERVICE_CLOSE',code:'H2_CLEANUP_FAILED'}]);
    }});
  assert.deepEqual(calls,['close','revoke:one','revoke:two','remove','write']);
  assert.deepEqual(record.tokensRevoked,['one','two']);
});

test('revoke and access-removal failures cannot suppress receipt or become PASS',async()=>{
  let written=false;
  const record={status:'PASS_LIVE_READONLY_TELEMETRY'};
  await finalizeQualification({record,issuedIds:['one','two'],close:async()=>{},
    revoke:id=>{if(id==='one')throw Object.assign(Error('private token detail'),{code:'EACCES'});},
    removeAccess:()=>{throw Error('PATH_IDENTITY_CHANGED');},writeReceipt:()=>{written=true;}});
  assert.equal(written,true);assert.equal(record.status,'HOLD');
  assert.equal(record.isolatedServiceStopped,true);
  assert.equal(record.temporaryAccessRemoved,false);
  assert.deepEqual(record.tokensRevoked,['two']);
  assert.deepEqual(record.cleanupErrors,[{stage:'TOKEN_REVOKE',code:'EACCES'},
    {stage:'TEMPORARY_ACCESS_REMOVE',code:'PATH_IDENTITY_CHANGED'}]);
});

test('normal finalizer reports stop only after successful close and persists original verdict',async()=>{
  const calls=[],record={status:'PASS_LIVE_READONLY_TELEMETRY'};
  await finalizeQualification({record,issuedIds:['one'],close:async()=>calls.push('close'),
    revoke:()=>calls.push('revoke'),removeAccess:()=>calls.push('remove'),writeReceipt:()=>calls.push('write')});
  assert.deepEqual(calls,['close','revoke','remove','write']);
  assert.equal(record.status,'PASS_LIVE_READONLY_TELEMETRY');assert.equal(record.isolatedServiceStopped,true);
  assert.deepEqual(record.cleanupErrors,[]);
  const neverStarted={status:'HOLD'};
  await finalizeQualification({record:neverStarted,writeReceipt:()=>{}});
  assert.equal(neverStarted.isolatedServiceStopped,false);assert.equal(neverStarted.serviceLifecycle,'NOT_STARTED');
});

test('receipt writer failure is visible and does not expose filesystem details',async()=>{
  await assert.rejects(finalizeQualification({record:{status:'HOLD'},writeReceipt:()=>{throw Error('private path');}}),
    /^Error: H2_RECEIPT_WRITE_FAILED$/);
});
