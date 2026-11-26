import {createHash} from 'node:crypto';

export const LEGACY_MODE='LEGACY_KERNEL_BOUNDED_CPU_V1';
export const LEGACY_LIMITS=Object.freeze({'memory.max':'1610612736','memory.high':'1476395008',
  'memory.swap.max':'0','pids.max':'64','cpu.max':'100000 100000'});
export const LEGACY_RETENTION_KIND='TRANSIENT_SLICE_HIERARCHICAL_V1';
export const LEGACY_SCHEMA_REVISION=2;
export const LEGACY_INHERITED_LIMITS=Object.freeze({'memory.max':'max','memory.high':'max',
  'memory.swap.max':'max','pids.max':'max','cpu.max':'max 100000'});
export const LEGACY_SAMPLE_MS=100;
export const LEGACY_MAX_GAP_MS=1000;
const root='/sys/fs/cgroup/acmlegacycpu.slice';
const service=root+'/acm-rc2-engine-readiness.service';
const paths=[root,service,service+'/controller',service+'/engine'];
const keys=['high','max','oom','oom_kill'];
const count=n=>Number.isSafeInteger(n)&&n>=0;
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const exact=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name));
const fail=code=>Object.assign(Error(code),{code});
const need=(value,code)=>{if(!value)throw fail(code);};
const fields=['mode','metricSource','peakBytes','sampledPeakBytes','sampleCount','firstSampleMs','lastSampleMs',
  'maxGapMs','maxReadDurationMs','scopeSha256','limitsSha256','samplesSha256','membersSha256','groups',
  'zeroEvents','swapBytes','healthy','complete','eventsBaseline','eventsFinal','eventsDelta','retentionKind','schemaRevision'];

export function validLegacyMemoryEvidence(value,{complete=true}={}){
  return exact(value,fields)&&value.mode===LEGACY_MODE&&value.retentionKind===LEGACY_RETENTION_KIND&&
    value.schemaRevision===LEGACY_SCHEMA_REVISION&&value.metricSource==='CGROUP_V2_CURRENT_AND_EVENTS_NO_PEAK'&&
    value.peakBytes===null&&count(value.sampledPeakBytes)&&value.sampledPeakBytes>0&&value.sampledPeakBytes<=1476395008&&
    count(value.sampleCount)&&value.sampleCount>=(complete?2:1)&&Number.isFinite(value.firstSampleMs)&&value.firstSampleMs>=0&&
    Number.isFinite(value.lastSampleMs)&&value.lastSampleMs>=value.firstSampleMs&&
    Number.isFinite(value.maxGapMs)&&value.maxGapMs>=0&&value.maxGapMs<=LEGACY_MAX_GAP_MS&&
    Number.isFinite(value.maxReadDurationMs)&&value.maxReadDurationMs>=0&&value.maxReadDurationMs<=LEGACY_MAX_GAP_MS&&
    ['scopeSha256','samplesSha256','membersSha256'].every(k=>hex(value[k]))&&value.limitsSha256===sha(LEGACY_LIMITS)&&
    Array.isArray(value.groups)&&value.groups.length===4&&value.groups.every((g,i)=>exact(g,['path','identity','localAvailable'])&&
      g.path===paths[i]&&exact(g.identity,['dev','ino'])&&['dev','ino'].every(k=>typeof g.identity[k]==='string'&&/^\d+$/.test(g.identity[k]))&&
      typeof g.localAvailable==='boolean')&&value.scopeSha256===sha(value.groups)&&
    ['eventsBaseline','eventsFinal','eventsDelta'].every(k=>Array.isArray(value[k])&&value[k].length===4&&value[k].every((r,i)=>
      exact(r,['path','memory','local','pidsMax'])&&r.path===paths[i]&&exact(r.memory,keys)&&keys.every(n=>r.memory[n]===0)&&
      (r.local===null?!value.groups[i].localAvailable:exact(r.local,keys)&&keys.every(n=>r.local[n]===0)&&value.groups[i].localAvailable)&&r.pidsMax===0))&&
    value.zeroEvents===true&&value.swapBytes===0&&value.healthy===true&&typeof value.complete==='boolean'&&(!complete||value.complete);
}

export function createLegacyMemoryMonitor({clock=()=>performance.now()}={}){
  let baseline,first,last,samples=0,maxGap=0,maxRead=0,peak=0,head='0'.repeat(64),members='0'.repeat(64),done=false,poison=null,firstEvents,lastEvents;
  const reject=code=>{poison??=code;throw fail(poison);};
  const ensure=()=>{if(poison)throw fail(poison);};
  function observe(raw){
    ensure();
    try{
      need(!done&&raw?.peakBytes===null&&raw.schemaRevision===LEGACY_SCHEMA_REVISION&&
        raw.retentionKind===LEGACY_RETENTION_KIND&&raw.metricSource==='CGROUP_V2_CURRENT_AND_EVENTS_NO_PEAK'&&
        Number.isFinite(raw.monotonicMs)&&raw.monotonicMs>=0&&Number.isFinite(raw.readDurationMs)&&raw.readDurationMs>=0&&
        raw.readDurationMs<=LEGACY_MAX_GAP_MS&&Array.isArray(raw.groups)&&raw.groups.length===4,'LEGACY_MONITOR_SAMPLE');
      need(last===undefined||(raw.monotonicMs>last&&raw.monotonicMs-last<=LEGACY_MAX_GAP_MS),'LEGACY_MONITOR_GAP');
      const scope=raw.groups.map((g,i)=>{
        need(g?.path===paths[i]&&exact(g.identity,['dev','ino'])&&['dev','ino'].every(k=>typeof g.identity[k]==='string'&&/^\d+$/.test(g.identity[k])),
          'LEGACY_GROUP_IDENTITY');
        need(g.limits&&Object.keys(LEGACY_LIMITS).every(k=>typeof g.limits[k]==='string')&&
          Object.entries(i===0?LEGACY_LIMITS:LEGACY_INHERITED_LIMITS).every(([k,v])=>g.limits[k]===v),'LEGACY_LIMIT_DRIFT');
        need(count(g.current)&&g.current<=1476395008&&g.swap===0,'LEGACY_MEMORY_PRESSURE');
        need(g.events&&keys.every(k=>g.events[k]===0)&&g.pidsEvents?.max===0,'LEGACY_MEMORY_EVENT');
        need(g.local===null||(g.local&&keys.every(k=>g.local[k]===0)),'LEGACY_LOCAL_MEMORY_EVENT');
        need(Array.isArray(g.members)&&g.members.every(m=>count(m.pid)&&m.pid>1&&/^\d+$/.test(m.startTick)&&
          count(m.uid)&&count(m.gid)&&m.group===g.path.slice('/sys/fs/cgroup'.length))&&
          new Set(g.members.map(m=>m.pid)).size===g.members.length&&(i>1||g.members.length===0),'LEGACY_PROCESS_MEMBERSHIP');
        return {path:g.path,identity:g.identity,localAvailable:g.local!==null};
      });
      const binding={scope,limits:raw.groups.map(g=>g.limits)};
      need(!baseline||sha(binding)===sha(baseline),'LEGACY_GROUP_OR_LIMIT_DRIFT');
      baseline??=structuredClone(binding);
      const actualEvents=raw.groups.map(g=>({path:g.path,memory:Object.fromEntries(keys.map(k=>[k,g.events[k]])),
        local:g.local===null?null:Object.fromEntries(keys.map(k=>[k,g.local[k]])),pidsMax:g.pidsEvents.max}));
      firstEvents??=actualEvents;lastEvents=actualEvents;
      first??=raw.monotonicMs;
      if(last!==undefined)maxGap=Math.max(maxGap,raw.monotonicMs-last);
      last=raw.monotonicMs;maxRead=Math.max(maxRead,raw.readDurationMs);
      peak=Math.max(peak,raw.groups[0].current);samples++;
      head=sha([head,raw]);members=sha([members,raw.groups.map(g=>g.members)]);
      return evidence();
    }catch(error){return reject(error.code??'LEGACY_MONITOR_SAMPLE');}
  }
  function evidence(){
    ensure();
    if(!done&&last!==undefined&&clock()-last>LEGACY_MAX_GAP_MS)return reject('LEGACY_MONITOR_GAP');
    return {mode:LEGACY_MODE,retentionKind:LEGACY_RETENTION_KIND,schemaRevision:LEGACY_SCHEMA_REVISION,metricSource:'CGROUP_V2_CURRENT_AND_EVENTS_NO_PEAK',peakBytes:null,
      sampledPeakBytes:peak,sampleCount:samples,firstSampleMs:first??0,lastSampleMs:last??0,maxGapMs:maxGap,
      maxReadDurationMs:maxRead,scopeSha256:sha(baseline?.scope??[]),limitsSha256:sha(LEGACY_LIMITS),
      samplesSha256:head,membersSha256:members,groups:structuredClone(baseline?.scope??[]),zeroEvents:true,swapBytes:0,
      healthy:true,complete:done,eventsBaseline:structuredClone(firstEvents??[]),eventsFinal:structuredClone(lastEvents??[]),
      eventsDelta:structuredClone(lastEvents??[])};
  }
  return Object.freeze({observe,evidence,failed:code=>reject(/^LEGACY_[A-Z_]+$/.test(code??'')?code:'LEGACY_MONITOR_FAILED'),
    healthy:()=>!poison,latest:()=>({peak:null,sampledPeak:peak}),complete(){
      ensure();need(samples>=2,'LEGACY_MONITOR_INCOMPLETE');evidence();done=true;return evidence();
    }});
}
