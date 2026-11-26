import {createHash} from 'node:crypto';
import {LEGACY_MODE,LEGACY_RETENTION_KIND,LEGACY_LIMITS,validLegacyMemoryEvidence} from '../../src/worker/r1/legacy-memory.mjs';

const root='/sys/fs/cgroup/acmlegacycpu.slice';
const now=()=>Number(process.hrtime.bigint())/1e6;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const counters=['high','max','oom','oom_kill'];
function validate(sample,pin,previous){
  need(Number.isFinite(sample?.readDurationMs)&&sample.readDurationMs>=0&&sample.readDurationMs<=1000,
    'LEGACY_OUTER_READ_DURATION');
  need(Number.isFinite(sample?.monotonicMs)&&sample.monotonicMs>=0&&
    (!previous||(sample.monotonicMs>previous.monotonicMs&&sample.monotonicMs-previous.monotonicMs<=1000)),
    'LEGACY_OUTER_MONITOR_GAP');
  const row=sample.group;
  need(row?.path===root&&typeof row.identity?.dev==='string'&&typeof row.identity.ino==='string'&&
    (!pin||hash(row.identity)===hash(pin)),'LEGACY_OUTER_IDENTITY');
  need(Object.entries(LEGACY_LIMITS).every(([key,value])=>row.limits?.[key]===value),'LEGACY_OUTER_LIMIT_DRIFT');
  need(Number.isSafeInteger(row.current)&&row.current>=0&&row.current<=1476395008&&row.swap===0,
    'LEGACY_OUTER_PRESSURE');
  need(counters.every(key=>row.events?.[key]===0)&&row.pidsMax===0&&
    (row.local===null||counters.every(key=>row.local?.[key]===0)),'LEGACY_OUTER_EVENT');
  need(Array.isArray(row.members)&&row.members.length===0&&[0,1].includes(row.populated)&&
    Array.isArray(row.childGroups)&&row.childGroups.length<=1&&
    row.childGroups.every(name=>name==='acm-rc2-engine-readiness.service'),'LEGACY_OUTER_SCOPE');
  if(previous)need((previous.group.local===null)===(row.local===null),'LEGACY_OUTER_LOCAL_DRIFT');
}

export function verifyLegacySliceWatchEvidence(outer,inner,tail){
  try{
    need(validLegacyMemoryEvidence(inner)&&outer?.mode===LEGACY_MODE&&outer.retentionKind===LEGACY_RETENTION_KIND&&
      outer.schemaRevision===2&&outer.peakBytes===null&&outer.complete===true&&outer.healthy===true,
      'LEGACY_OUTER_EVIDENCE');
    need(Array.isArray(outer.frames)&&outer.frames.length>=2&&outer.frames.length===outer.sampleCount&&
      Buffer.byteLength(JSON.stringify(outer.frames))<=8*1024**2,'LEGACY_OUTER_TRANSCRIPT');
    let previous,maxGap=0,maxRead=0,peak=0,head='0'.repeat(64);
    const pin=inner.groups[0].identity;
    for(const frame of outer.frames){
      validate(frame,pin,previous);
      if(previous)maxGap=Math.max(maxGap,frame.monotonicMs-previous.monotonicMs);
      maxRead=Math.max(maxRead,frame.readDurationMs);
      peak=Math.max(peak,frame.group.current);head=hash([head,frame]);previous=frame;
    }
    need(outer.firstSampleMs===outer.frames[0].monotonicMs&&outer.lastSampleMs===previous.monotonicMs&&
      outer.maxGapMs===maxGap&&outer.maxReadDurationMs===maxRead&&outer.sampledPeakBytes===peak&&outer.samplesSha256===head&&
      outer.scopeSha256===hash({path:root,identity:pin}),'LEGACY_OUTER_TRANSCRIPT');
    need(outer.firstSampleMs<=inner.lastSampleMs&&outer.lastSampleMs>=tail.monotonicMs&&
      tail.monotonicMs>=inner.lastSampleMs&&outer.lastSampleMs-tail.monotonicMs<=1000,
      'LEGACY_OUTER_COVERAGE');
    return true;
  }catch{return false;}
}

export function createLegacySliceWatch({read,clock=now,onFailure}={}){
  need(typeof read==='function','LEGACY_OUTER_READER');
  const abort=new AbortController(),frames=[];
  let fault=null,complete=false,bytes=0,maxGap=0,maxRead=0,peak=0,head='0'.repeat(64),pin,timer;
  function poison(error,failedSample=null){
    fault??=error;clearInterval(timer);abort.abort(fault);
    try{onFailure?.({code:fault.code??'LEGACY_OUTER_MONITOR_FAILED',last:frames.at(-1)??null,failedSample});}catch{}
    throw fault;
  }
  function sample(){
    if(fault)throw fault;
    need(!complete,'LEGACY_OUTER_MONITOR_COMPLETED');
    let raw;
    try{
      raw=structuredClone(read());const previous=frames.at(-1);
      validate(raw,pin,previous);
      need(Math.abs(clock()-raw.monotonicMs)<=1000,'LEGACY_OUTER_MONITOR_GAP');
      bytes+=Buffer.byteLength(JSON.stringify(raw));need(bytes<=8*1024**2,'LEGACY_OUTER_TRANSCRIPT');
      pin??=structuredClone(raw.group.identity);
      if(previous)maxGap=Math.max(maxGap,raw.monotonicMs-previous.monotonicMs);
      maxRead=Math.max(maxRead,raw.readDurationMs);
      peak=Math.max(peak,raw.group.current);head=hash([head,raw]);frames.push(raw);return raw;
    }catch(error){return poison(error,raw??null);}
  }
  sample();
  timer=setInterval(()=>{try{sample();}catch{/* 首次失敗已中止工作並保存。 */}},100);
  return {sample,abortSignal:abort.signal,
    finish(inner,tail){
      if(fault)throw fault;
      sample();
      const proof={mode:LEGACY_MODE,retentionKind:LEGACY_RETENTION_KIND,schemaRevision:2,peakBytes:null,
        firstSampleMs:frames[0].monotonicMs,lastSampleMs:frames.at(-1).monotonicMs,sampleCount:frames.length,
        maxGapMs:maxGap,maxReadDurationMs:maxRead,sampledPeakBytes:peak,scopeSha256:hash({path:root,identity:pin}),samplesSha256:head,
        frames:structuredClone(frames),complete:true,healthy:true};
      if(!verifyLegacySliceWatchEvidence(proof,inner,tail))return poison(Object.assign(Error('LEGACY_OUTER_COVERAGE'),{code:'LEGACY_OUTER_COVERAGE'}));
      complete=true;clearInterval(timer);return proof;
    },
    stop(){clearInterval(timer);if(!complete&&!fault){try{poison(Object.assign(Error('LEGACY_OUTER_MONITOR_STOPPED'),{code:'LEGACY_OUTER_MONITOR_STOPPED'}));}catch{}}}
  };
}
