import {lstatSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {LEGACY_LIMITS,LEGACY_MODE,validLegacyMemoryEvidence} from '../../src/worker/r1/legacy-memory.mjs';
import {verifyLegacySliceWatchEvidence} from './legacy-slice-watch.mjs';
import {LEGACY_GROUP,LEGACY_SERVICE,rejectLocalOnlyEvents} from './legacy-slice.mjs';
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const text=path=>readFileSync(path,'utf8').trim();
const events=path=>Object.fromEntries(text(path).split('\n').map(row=>{
  const [key,value]=row.split(/\s+/);need(/^\d+$/.test(value),'LEGACY_TAIL_COUNTER');return [key,Number(value)];
}));
const identity=path=>{const s=lstatSync(path);need(s.isDirectory()&&!s.isSymbolicLink(),'LEGACY_TAIL_IDENTITY');return {dev:String(s.dev),ino:String(s.ino)};};
const now=()=>Number(process.hrtime.bigint())/1e6;
export function readLegacySliceSample(){
  const started=now();
  rejectLocalOnlyEvents();
  const before=identity(LEGACY_GROUP),row={path:LEGACY_GROUP,identity:before,
    limits:Object.fromEntries(Object.keys(LEGACY_LIMITS).map(name=>[name,text(LEGACY_GROUP+'/'+name)])),
    members:text(LEGACY_GROUP+'/cgroup.procs').split('\n').filter(Boolean),current:Number(text(LEGACY_GROUP+'/memory.current')),
    swap:Number(text(LEGACY_GROUP+'/memory.swap.current')),events:events(LEGACY_GROUP+'/memory.events'),
    pidsMax:events(LEGACY_GROUP+'/pids.events').max,populated:events(LEGACY_GROUP+'/cgroup.events').populated,
    childGroups:readdirSync(LEGACY_GROUP,{withFileTypes:true}).filter(row=>row.isDirectory()).map(row=>row.name).sort()};
  try{row.local=events(LEGACY_GROUP+'/memory.events.local');}catch(error){if(error.code!=='ENOENT')throw error;row.local=null;}
  need(JSON.stringify(before)===JSON.stringify(identity(LEGACY_GROUP)),'LEGACY_TAIL_IDENTITY');
  const ended=now();
  return {monotonicMs:ended,readDurationMs:ended-started,group:row};
}
export function verifyLegacyTail(tail,evidence,baseline){
  need(validLegacyMemoryEvidence(evidence),'LEGACY_TAIL_EVIDENCE');
  need(tail?.mode===LEGACY_MODE&&tail.schemaRevision===2&&tail.retentionKind==='TRANSIENT_SLICE_HIERARCHICAL_V1'&&
    tail.peakBytes===null&&tail.serviceGone===true&&Number.isFinite(tail.monotonicMs)&&
    Number.isFinite(tail.readDurationMs)&&tail.readDurationMs>=0&&tail.readDurationMs<=1000&&
    tail.monotonicMs>=evidence.lastSampleMs&&verifyLegacySliceWatchEvidence(tail.outerEvidence,evidence,tail),'LEGACY_TAIL_GAP');
  need(Array.isArray(tail.groups)&&tail.groups.length===1&&Array.isArray(baseline)&&baseline.length===4,'LEGACY_TAIL_SCOPE');
  const row=tail.groups[0],pin=evidence.groups[0];
  need(row.path===LEGACY_GROUP&&row.path===pin.path&&row.identity.dev===pin.identity.dev&&
    row.identity.ino===pin.identity.ino,'LEGACY_TAIL_IDENTITY');
  need(Object.entries(LEGACY_LIMITS).every(([file,value])=>row.limits[file]===value),'LEGACY_TAIL_LIMIT_DRIFT');
  need(Array.isArray(row.members)&&row.members.length===0&&row.populated===0&&
    Array.isArray(row.childGroups)&&row.childGroups.length===0,'LEGACY_TAIL_PROCESS_REMAINS');
  need(Number.isSafeInteger(row.current)&&row.current>=0&&row.current<=1476395008&&row.swap===0,'LEGACY_TAIL_PRESSURE');
  need(['high','max','oom','oom_kill'].every(key=>row.events[key]===0)&&row.pidsMax===0&&
    (pin.localAvailable?row.local&&['high','max','oom','oom_kill'].every(key=>row.local[key]===0):row.local===null),'LEGACY_TAIL_EVENT');
  return true;
}
export function readLegacyTail(evidence,baseline,watcher){
  const sample=readLegacySliceSample();
  const tail={mode:LEGACY_MODE,schemaRevision:2,retentionKind:'TRANSIENT_SLICE_HIERARCHICAL_V1',
    peakBytes:null,serviceGone:!existsSync('/sys/fs/cgroup'+LEGACY_SERVICE),
    monotonicMs:sample.monotonicMs,readDurationMs:sample.readDurationMs,groups:[sample.group]};
  need(watcher&&typeof watcher.finish==='function','LEGACY_OUTER_MONITOR_REQUIRED');
  tail.outerEvidence=watcher.finish(evidence,tail);
  verifyLegacyTail(tail,evidence,baseline);return tail;
}
