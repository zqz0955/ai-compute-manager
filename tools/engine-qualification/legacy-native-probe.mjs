import assert from 'node:assert/strict';
import {existsSync,writeFileSync} from 'node:fs';
import {createEngineLifecycle} from 'file:///opt/acm-rc2-engine-readiness/readiness.mjs';
import {createLegacyNativeSampler,readLegacyNativeSample} from './legacy-native-memory.mjs';
import {LEGACY_MODE} from '../../src/worker/r1/legacy-memory.mjs';

const group='/sys/fs/cgroup/acmlegacycpu.slice',service=group+'/acm-rc2-engine-readiness.service';
const scope={group,service,leaf:service+'/engine',controller:service+'/controller',memberIdentity:65202,onFailure:diagnostic=>console.log('ACM_LEGACY_NATIVE_FAULT='+JSON.stringify(diagnostic))};
const checks=[];
const lifecycle=createEngineLifecycle({memoryMode:LEGACY_MODE,legacySampler:bound=>createLegacyNativeSampler({...bound,onFailure:scope.onFailure})});
const first=lifecycle.metrics();
assert.equal(first.peak,null);assert.equal(first.healthy,true);
checks.push('WHOLE_GROUP_IDENTITY_LIMITS_AND_MEMBERS');
try{
  writeFileSync(scope.group+'/memory.high','1476390912');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120);
  assert.throws(()=>lifecycle.metrics(),/LEGACY_/);
  assert.equal(lifecycle.monitorSignal.aborted,true);
  checks.push('ACTUAL_MEMORY_HIGH_DRIFT_REJECTED');
}finally{writeFileSync(scope.group+'/memory.high','1476395008');lifecycle.stopMonitor();}
const gap=createLegacyNativeSampler(scope);
try{
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);
  assert.throws(()=>gap.sample(),/LEGACY_/);assert.equal(gap.signal.aborted,true);
  checks.push('ACTUAL_EVENT_LOOP_INTERRUPTION_REJECTED');
}finally{gap.stop();}
const stopped=createLegacyNativeSampler(scope);
stopped.stop();
assert.throws(()=>stopped.sample(),/LEGACY_/);
checks.push('STOPPED_MONITOR_CANNOT_AUTHORIZE_RELEASE');
const snapshot=readLegacyNativeSample(scope);
assert.equal(snapshot.groups[3].members.length,0);
console.log('ACM_LEGACY_NATIVE_PROBE='+JSON.stringify({status:'PASS',checks,
  peakBytes:null,kernelPeakFileAvailable:existsSync(group+'/memory.peak'),
  groups:snapshot.groups.map(row=>({path:row.path,identity:row.identity,limits:row.limits,
    current:row.current,events:row.events,local:row.local,members:row.members})),
  generationRequests:0}));
