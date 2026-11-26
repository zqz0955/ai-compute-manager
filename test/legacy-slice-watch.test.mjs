import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createLegacyMemoryMonitor,LEGACY_MODE,LEGACY_LIMITS,LEGACY_INHERITED_LIMITS} from '../src/worker/r1/legacy-memory.mjs';
import {createLegacySliceWatch,verifyLegacySliceWatchEvidence} from '../tools/engine-qualification/legacy-slice-watch.mjs';

function scenario(){
  const root='/sys/fs/cgroup/acmlegacycpu.slice',service=root+'/acm-rc2-engine-readiness.service';
  let now=100;
  const inside=createLegacyMemoryMonitor({clock:()=>now});
  const raw=()=>({monotonicMs:now,readDurationMs:1,mode:LEGACY_MODE,retentionKind:'TRANSIENT_SLICE_HIERARCHICAL_V1',
    schemaRevision:2,peakBytes:null,metricSource:'CGROUP_V2_CURRENT_AND_EVENTS_NO_PEAK',
    groups:[root,service,service+'/controller',service+'/engine'].map((path,i)=>({path,
      identity:{dev:'1',ino:String(i+1)},limits:{...(i===0?LEGACY_LIMITS:LEGACY_INHERITED_LIMITS)},
      current:1024,swap:0,events:{high:0,max:0,oom:0,oom_kill:0},local:null,pidsEvents:{max:0},members:[]}))});
  inside.observe(raw());now=200;inside.observe(raw());const inner=inside.complete();now=150;
  const row=()=>({...raw().groups[0],pidsMax:0,populated:now>=300?0:1,
    childGroups:now>=300?[]:['acm-rc2-engine-readiness.service']});
  return {inner,row,get now(){return now;},set now(n){now=n;},
    tail:()=>({monotonicMs:now,groups:[row()]}),read:()=>({monotonicMs:now,readDurationMs:1,group:row()})};
}

test('independent parent observations bridge controller tail without changing sampling gap',()=>{
  const f=scenario(),watch=createLegacySliceWatch({read:f.read,clock:()=>f.now});
  f.now=300;const tail=f.tail(),proof=watch.finish(f.inner,tail);watch.stop();
  assert.ok(verifyLegacySliceWatchEvidence(proof,f.inner,tail));assert.equal(proof.peakBytes,null);
  assert.equal(proof.sampleCount,2);assert.equal(proof.maxGapMs,150);assert.equal(proof.sampledPeakBytes,1024);
  assert.equal(proof.maxReadDurationMs,1);
  for(const change of [p=>p.frames[0].group.events.high=1,p=>p.samplesSha256='0'.repeat(64),
    p=>p.firstSampleMs=201,p=>p.frames[1].group.identity.ino='99']){
    const bad=structuredClone(proof);change(bad);assert.equal(verifyLegacySliceWatchEvidence(bad,f.inner,tail),false);
  }
});

test('first outer read must obey the same complete-reading deadline',()=>{
  for(const duration of [1001,-1,NaN,undefined]){
    const f=scenario();
    assert.throws(()=>createLegacySliceWatch({read:()=>{f.now=2500;return {...f.read(),readDurationMs:duration};},clock:()=>f.now}),/LEGACY_OUTER_READ_DURATION/);
  }
});

test('outer monitor failure and stop immediately abort and never authorize resource release',()=>{
  for(const fault of ['event','gap','limit','stop']){
    const f=scenario();let failures=0,diagnostic;
    const watch=createLegacySliceWatch({read:()=>{const r=f.read();if(fault==='event'&&f.now>150)r.group.events.oom_kill=1;
      if(fault==='limit'&&f.now>150)r.group.limits['memory.max']='max';return r;},clock:()=>f.now,onFailure:value=>{failures++;diagnostic=value;}});
    try{
      f.now=fault==='gap'?1151:300;
      if(fault==='stop')watch.stop();else assert.throws(()=>watch.sample(),/LEGACY_OUTER_/);
      assert.equal(watch.abortSignal.aborted,true);assert.equal(failures,1);
      if(fault==='event')assert.equal(diagnostic.failedSample.group.events.oom_kill,1);
      assert.throws(()=>watch.finish(f.inner,f.tail()),/LEGACY_OUTER_/);
    }finally{watch.stop();}
  }
});
