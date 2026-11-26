import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createLegacyMemoryMonitor,LEGACY_MODE,LEGACY_LIMITS,LEGACY_INHERITED_LIMITS} from '../src/worker/r1/legacy-memory.mjs';
import {createLegacySliceWatch} from '../tools/engine-qualification/legacy-slice-watch.mjs';
import {verifyLegacyTail} from '../tools/engine-qualification/legacy-tail.mjs';

test('outer post-controller evidence rejects late events, changed limits, members and monitoring gap',()=>{
  const root='/sys/fs/cgroup/acmlegacycpu.slice',service=root+'/acm-rc2-engine-readiness.service';
  let now=100;
  const sample=()=>({monotonicMs:now,readDurationMs:1,peakBytes:null,retentionKind:'TRANSIENT_SLICE_HIERARCHICAL_V1',schemaRevision:2,metricSource:'CGROUP_V2_CURRENT_AND_EVENTS_NO_PEAK',
    groups:[root,service,service+'/controller',service+'/engine'].map((path,i)=>({path,identity:{dev:'1',ino:String(i+1)},
      limits:{...(i===0?LEGACY_LIMITS:LEGACY_INHERITED_LIMITS)},current:1024,swap:0,events:{high:0,max:0,oom:0,oom_kill:0},local:null,
      pidsEvents:{max:0},members:[]}))});
  const first=sample(),monitor=createLegacyMemoryMonitor({clock:()=>now});
  monitor.observe(first);now=200;monitor.observe(sample());const evidence=monitor.complete();
  const row={...first.groups[0],pidsMax:0,populated:0,childGroups:[]};
  now=150;const watch=createLegacySliceWatch({read:()=>({monotonicMs:now,readDurationMs:1,group:row}),clock:()=>now});
  now=300;
  const tail={mode:LEGACY_MODE,peakBytes:null,monotonicMs:now,readDurationMs:1,serviceGone:true,
    retentionKind:'TRANSIENT_SLICE_HIERARCHICAL_V1',schemaRevision:2,groups:[row]};
  tail.outerEvidence=watch.finish(evidence,tail);watch.stop();
  assert.equal(verifyLegacyTail(tail,evidence,first.groups),true);
  const faults=[r=>r.groups[0].events.high=1,r=>r.groups[0].events.max=1,r=>r.groups[0].events.oom=1,
    r=>r.groups[0].events.oom_kill=1,r=>r.groups[0].swap=1,r=>r.groups[0].pidsMax=1,
    r=>r.groups[0].members=['999'],r=>r.groups[0].identity.ino='99',
    r=>r.groups[0].limits['memory.high']='max',r=>r.monotonicMs=1201,r=>r.peakBytes=2048,
    r=>r.groups[0].childGroups=['unknown'],r=>r.groups[0].populated=1,r=>r.readDurationMs=1001];
  for(const mutate of faults){const bad=structuredClone(tail);mutate(bad);
    assert.throws(()=>verifyLegacyTail(bad,evidence,first.groups),/LEGACY_TAIL_/);}
});
