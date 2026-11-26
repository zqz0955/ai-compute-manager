import {lstatSync,readFileSync,readdirSync} from 'node:fs';
import {NX_ENGINE, nxInstalled} from '../nx-legacy/layout.mjs';
const monotonicMs=()=>Number(process.hrtime.bigint())/1e6;
import {rejectLocalOnlyEvents} from './legacy-slice.mjs';
import {createLegacyMemoryMonitor} from '../../src/worker/r1/legacy-memory.mjs';

const text=path=>readFileSync(path,'utf8').trim();
const need=(value,code)=>{if(!value)throw Object.assign(Error(code),{code});};
const id=path=>{const s=lstatSync(path);need(s.isDirectory()&&!s.isSymbolicLink(),'LEGACY_GROUP_IDENTITY');return {dev:String(s.dev),ino:String(s.ino)};};
const counters=path=>Object.fromEntries(text(path).split('\n').map(row=>row.split(/\s+/)).map(([key,value])=>{need(/^\d+$/.test(value),'LEGACY_MEMORY_COUNTER');return [key,Number(value)];}));
const limits={'memory.max':'1610612736','memory.high':'1476395008','memory.swap.max':'0','pids.max':'64','cpu.max':'100000 100000'};

export function readLegacyNativeSample({group,service,leaf,controller,memberIdentity}){
  const started=monotonicMs(),groups=[];
  need(group==='/sys/fs/cgroup/acmlegacycpu.slice'&&service===group+'/acm-rc2-engine-readiness.service'&&leaf===service+'/engine'&&
    controller===service+'/controller'&&memberIdentity===65202,'LEGACY_NATIVE_BOUNDARY');
  rejectLocalOnlyEvents();
  need(JSON.stringify(readdirSync(group,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name).sort())===
    JSON.stringify(['acm-rc2-engine-readiness.service']),'LEGACY_UNKNOWN_CGROUP');
  need(JSON.stringify(readdirSync(service,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name).sort())===
    JSON.stringify(['controller','engine']),'LEGACY_UNKNOWN_CGROUP');
  for(const path of [group,service,controller,leaf]){
    need(readdirSync(path,{withFileTypes:true}).every(x=>!x.isDirectory()||path===group||path===service),'LEGACY_UNKNOWN_CGROUP');
    need(text(path+'/cgroup.type')==='domain','LEGACY_CGROUP_TYPE');
    const before=id(path),members=[];
    const pids=text(path+'/cgroup.procs').split('\n').filter(Boolean).map(Number);
    for(const pid of pids){
      need(Number.isSafeInteger(pid)&&pid>1,'LEGACY_PROCESS_IDENTITY');
      const base='/proc/'+pid;
      try{
        const status=text(base+'/status'),ticks=text(base+'/stat').split(') ').at(-1).split(' ')[19];
        const memberPath=text(base+'/cgroup');
        const uid=status.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m)?.slice(1).map(Number);
        const gid=status.match(/^Gid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m)?.slice(1).map(Number);
        need(uid?.length===4&&gid?.length===4&&uid.every(x=>x===uid[0])&&gid.every(x=>x===uid[0])&&
          memberPath==='0::'+path.slice('/sys/fs/cgroup'.length),'LEGACY_PROCESS_IDENTITY');
        const command=readFileSync(base+'/cmdline','utf8').split('\0').filter(Boolean);
        if(path===controller)need(pid===process.pid&&uid[0]===0,'LEGACY_CONTROLLER_MEMBER');
        else if(path===leaf){
          const parentTick=text('/proc/'+process.pid+'/stat').split(') ').at(-1).split(' ')[19];
          const guardedPython=uid[0]===0&&new RegExp('^PPid:\\s+'+process.pid+'$','m').test(status)&&
            JSON.stringify(command)===JSON.stringify(['/usr/bin/python3','-I','-B',(nxInstalled ? NX_ENGINE : '/opt/acm-rc2-engine-readiness')+'/stdio-guard.py',
              service.slice('/sys/fs/cgroup'.length)+'/engine',String(process.pid),parentTick,'0','0']);
          need(uid[0]===memberIdentity||guardedPython,'LEGACY_ENGINE_MEMBER');
        }else need(false,'LEGACY_ROOT_MEMBER');
        need(text(base+'/stat').split(') ').at(-1).split(' ')[19]===ticks,'LEGACY_PROCESS_REUSED');
        members.push({pid,startTick:ticks,uid:uid[0],gid:gid[0],group:memberPath.slice(3)});
      }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
    }
    const actual=Object.fromEntries(Object.keys(limits).map(name=>[name,text(path+'/'+name)]));
    const wanted=path===group?limits:{'memory.max':'max','memory.high':'max','memory.swap.max':'max','pids.max':'max','cpu.max':'max 100000'};
    need(Object.entries(wanted).every(([name,value])=>actual[name]===value),'LEGACY_LIMIT_DRIFT');
    const events=counters(path+'/memory.events');let local=null;
    try{local=counters(path+'/memory.events.local');}catch(error){if(error.code!=='ENOENT')throw error;}
    const current=Number(text(path+'/memory.current')),swap=Number(text(path+'/memory.swap.current'));
    need(Number.isSafeInteger(current)&&current>=0&&swap===0,'LEGACY_MEMORY_READING');
    const after=id(path);need(JSON.stringify(before)===JSON.stringify(after),'LEGACY_GROUP_IDENTITY');
    const pidsCurrent=Number(text(path+'/pids.current'));
    need(Number.isSafeInteger(pidsCurrent)&&pidsCurrent>=0&&pidsCurrent<=64,'LEGACY_TASKS_LIMIT');
    groups.push({path,identity:before,limits:actual,current,swap,events,local,pidsCurrent,cgroupType:'domain',
      cpuStat:counters(path+'/cpu.stat'),pidsEvents:counters(path+'/pids.events'),members});
  }
  need(text(group+'/cgroup.procs')==='','LEGACY_ROOT_MEMBER');
  return {retentionKind:'TRANSIENT_SLICE_HIERARCHICAL_V1',schemaRevision:2,monotonicMs:monotonicMs(),readDurationMs:monotonicMs()-started,groups,
    peakBytes:null,metricSource:'CGROUP_V2_CURRENT_AND_EVENTS_NO_PEAK'};
}

function failureSnapshot(scope){
  const read=path=>{try{return text(path);}catch(error){return {unavailable:error.code??'UNKNOWN'};}};
  return {at:monotonicMs(),groups:[scope.group,scope.service,scope.controller,scope.leaf].map(path=>({path,
    limits:Object.fromEntries(Object.keys(limits).map(name=>[name,read(path+'/'+name)])),
    memoryCurrent:read(path+'/memory.current'),memoryEvents:read(path+'/memory.events'),
    memoryEventsLocal:read(path+'/memory.events.local'),swapCurrent:read(path+'/memory.swap.current'),
    pidsEvents:read(path+'/pids.events'),members:read(path+'/cgroup.procs')}))};
}

export function createLegacyNativeSampler(scope){
  const monitor=createLegacyMemoryMonitor({clock:monotonicMs});
  const abort=new AbortController();
  let fault=null,complete=false,last,lastAt=-Infinity,bytes=0,groupBindings;
  const transcript=[];
  function collect(force=false){
    if(fault)throw fault;
    if(complete){
      const raw=readLegacyNativeSample(scope);
      need(JSON.stringify(raw.groups.map(g=>({path:g.path,identity:g.identity,limits:g.limits})))===groupBindings&&
        raw.groups.every(g=>g.current<=1476395008&&['high','max','oom','oom_kill'].every(k=>g.events[k]===0&&
          (g.local===null||g.local[k]===0))&&g.pidsEvents.max===0),'LEGACY_POST_TERMINAL_DRIFT');
      return last;
    }
    if(!force&&last&&monotonicMs()-lastAt<100)return last;
    try{
      const raw=readLegacyNativeSample(scope);
      bytes+=Buffer.byteLength(JSON.stringify(raw));need(bytes<=8*1024**2,'LEGACY_TRANSCRIPT_LIMIT');
      transcript.push(raw);
      monitor.observe(raw);
      groupBindings??=JSON.stringify(raw.groups.map(g=>({path:g.path,identity:g.identity,limits:g.limits})));
      lastAt=monotonicMs();
      const proof=monitor.evidence();
      const sum=(key,local=false)=>raw.groups.reduce((n,g)=>n+(local?g.local?.[key]??0:g.events[key]??0),0);
      last={healthy:true,peak:null,sampledPeak:proof.sampledPeakBytes,
        oom:sum('oom'),oomKill:sum('oom_kill'),max:sum('max'),
        pidsMaxHits:raw.groups.reduce((n,g)=>n+g.pidsEvents.max,0),legacyEvidence:proof};
      return last;
    }catch(error){
      fault=error;
      abort.abort(error);
      try{scope.onFailure?.({code:error.code??'LEGACY_NATIVE_MONITOR_FAILED',lastObserved:transcript.at(-1)??null,
        actual:failureSnapshot(scope)});}catch{/* 診斷失敗不能解除HOLD。 */}
      try{monitor.failed(typeof error.code==='string'?error.code:'LEGACY_NATIVE_MONITOR_FAILED');}catch{/* 首次錯誤已鎖定。 */}
      throw error;
    }
  }
  collect();
  // 固定週期是離散觀測；任何延遲超出契約都鎖定 HOLD，不延長時間容忍取得成功。
  const timer=setInterval(()=>{try{collect(true);}catch{/* 原錯誤與 abort 已保存。 */}},100);
  return {sample:collect,signal:abort.signal,transcript:()=>transcript,
    complete(){collect(true);monitor.complete();complete=true;clearInterval(timer);last={...last,legacyEvidence:monitor.evidence()};return last;},
    stop(){clearInterval(timer);if(!complete){fault??=Object.assign(Error('LEGACY_MONITOR_STOPPED'),{code:'LEGACY_MONITOR_STOPPED'});abort.abort(fault);try{monitor.failed('LEGACY_MONITOR_STOPPED');}catch{/* 後續sample會拒絕。 */}}},
  };
}
