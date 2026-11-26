import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {createEngineLifecycle} from 'file:///opt/acm-rc2-engine-readiness/readiness.mjs';
import {LEGACY_MODE} from '../../src/worker/r1/legacy-memory.mjs';
import {createLegacyNativeSampler,readLegacyNativeSample} from './legacy-native-memory.mjs';

const group='/sys/fs/cgroup/acmlegacycpu.slice',service=group+'/acm-rc2-engine-readiness.service';
const scope={group,service,leaf:service+'/engine',controller:service+'/controller',memberIdentity:65202,
  onFailure:diagnostic=>console.log('ACM_LEGACY_ACTIVE_DIAGNOSTIC='+JSON.stringify(diagnostic))};
const text=path=>readFileSync(path,'utf8').trim();
const tick=pid=>text('/proc/'+pid+'/stat').split(') ').at(-1).split(' ')[19];
const setup=createEngineLifecycle({memoryMode:LEGACY_MODE,legacySampler:createLegacyNativeSampler});
setup.stopMonitor();
process.setgroups([]);
const tailOnly=process.argv[2]==='tail-only';
assert.ok(process.argv.length===2||process.argv.length===3&&tailOnly);
const results=[];
for(const name of tailOnly?[]:['ACTIVE_GAP','ACTIVE_LIMIT_DRIFT','ACTIVE_MONITOR_STOP','ACTIVE_PROCESS_CRASH']){
  const child=spawn('/usr/bin/python3',['-I','-B','-c','import os,time; print("READY",os.getuid(),os.getgid(),os.getgroups(),flush=True); time.sleep(30)'],
    {uid:65202,gid:65202,env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['ignore','pipe','ignore']});
  let closed=false,signalled=false;
  const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{closed=true;resolve({code,signal});});});
  completion.catch(()=>{});
  const pid=child.pid,birth=tick(pid);
  writeFileSync(scope.leaf+'/cgroup.procs',String(pid));
  const ready=await Promise.race([new Promise(resolve=>child.stdout.once('data',b=>resolve(b.toString()))),delay(3000,null,{ref:false})]);
  assert.match(ready??'',/^READY 65202 65202 \[\]\s*$/);
  const sample=readLegacyNativeSample(scope);
  assert.ok(sample.groups[3].members.some(m=>m.pid===pid&&m.startTick===birth&&m.uid===65202&&m.gid===65202));
  const monitor=createLegacyNativeSampler(scope);
  const stopOwned=()=>{
    if(closed)return;
    assert.equal(tick(pid),birth);
    assert.equal(text('/proc/'+pid+'/cgroup'),'0::'+scope.leaf.slice('/sys/fs/cgroup'.length));
    signalled=child.kill('SIGTERM');assert.equal(signalled,true);
  };
  monitor.signal.addEventListener('abort',stopOwned,{once:true});
  try{
    if(name==='ACTIVE_GAP'){
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);
      assert.throws(()=>monitor.sample(),/LEGACY_MONITOR_GAP/);
    }else if(name==='ACTIVE_LIMIT_DRIFT'){
      writeFileSync(scope.group+'/memory.high','1476390912');
      await delay(150);
      assert.throws(()=>monitor.sample(),/LEGACY_LIMIT_DRIFT/);
    }else if(name==='ACTIVE_MONITOR_STOP'){
      monitor.stop();assert.throws(()=>monitor.sample(),/LEGACY_MONITOR_STOPPED/);
    }else{
      assert.equal(tick(pid),birth);
      assert.equal(text('/proc/'+pid+'/cgroup'),'0::'+scope.leaf.slice('/sys/fs/cgroup'.length));
      assert.equal(child.kill('SIGKILL'),true);
      const outcome=await completion;assert.equal(outcome.signal,'SIGKILL');
      monitor.stop();assert.throws(()=>monitor.sample(),/LEGACY_MONITOR_STOPPED/);
    }
    const outcome=await Promise.race([completion,delay(3000,null,{ref:false})]);
    assert.ok(outcome);
    assert.equal(monitor.signal.aborted,true);
    assert.equal(text(scope.leaf+'/cgroup.procs'),'');
    assert.equal(existsSync('/proc/'+pid),false);
    assert.equal(outcome.signal,name==='ACTIVE_PROCESS_CRASH'?'SIGKILL':'SIGTERM');
    results.push({name,pid,startTick:birth,uid:65202,gid:65202,status:'PASS_ACTIVE_FAULT_REJECTED',
      monitorAborted:true,ownedStopRequested:signalled,childReaped:true,leafEmpty:true,
      cleanupConfirmed:false,releaseAuthorized:false,generationRequests:0});
  }finally{
    monitor.signal.removeEventListener('abort',stopOwned);
    if(!closed)stopOwned();
    await completion;monitor.stop();
    writeFileSync(scope.group+'/memory.high','1476395008');
  }
}
if(!tailOnly)console.log('ACM_LEGACY_ACTIVE_FAULTS='+JSON.stringify({status:'PASS_REJECTION_ONLY',cases:results,
  contract:LEGACY_MODE,peakBytes:null,kernelPeakFileAvailable:existsSync(group+'/memory.peak'),generationRequests:0}));

const finalMonitor=createLegacyNativeSampler(scope);
await delay(120);finalMonitor.sample();
const evidence=finalMonitor.complete().legacyEvidence;
const baseline=readLegacyNativeSample(scope).groups;
finalMonitor.stop();
console.log('ACM_LEGACY_TAIL_PROBE='+JSON.stringify({evidence,baseline,generationRequests:0}));
