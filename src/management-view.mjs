import {jobView} from './inference-http.mjs';

const sampleFields=['cpuPercent','gpuPercent','gpuUsedBytes','ramUsedBytes','swapUsedBytes','diskUsedBytes','temperatureC','sampledAt'];
const metric=(row,key)=>Number.isFinite(row?.[key])?row[key]:null;
const kiB=(value)=>Number.isFinite(value)?Math.floor(value/1024):null;
const fresh=(at,now)=>Number.isFinite(at) && now-at<=15000 && at<=now+1000;

export const observedSources=Object.freeze(['WINDOWS_LOCAL','JETSON_AGENT','V06_V07_BRIDGE']);
const isObserved=node=>observedSources.includes(node.source);

function sampled(node,now) {
  if (isObserved(node)) return node.identityVerified===true ? node.metrics??{} : {};
  if (node.status!=='SIMULATED' || node.metrics?.source!=='SIMULATION') return {};
  return {...node.metrics,sampledAt:node.metrics.sampledAt ?? now};
}

export function publicNode(node,now=Date.now()) {
  const sample=sampled(node,now);
  const observed=isObserved(node);
  const verified=!node.observationExpired&&fresh(sample.sampledAt,now);
  const source=observed?node.source:node.simulated?'SIMULATION':'CONFIGURED_ONLY';
  const {id,name,platform,status,availability,aliases,gpu,cpuCores,gpuBytes,ramBytes,swapBytes,diskBytes,models,resident}=node;
  return {id,name,platform,status:observed&&!verified?'UNKNOWN':status,availability,aliases,gpu,cpuCores,gpuBytes,
    ramBytes:observed&&!verified?null:ramBytes,swapBytes:observed&&!verified?null:swapBytes,diskBytes:observed&&!verified?null:diskBytes,
    source,freshness:verified?'FRESH':sample.sampledAt==null?'UNKNOWN':'STALE',
    metrics:Object.fromEntries(sampleFields.map(key=>[key,metric(verified||key==='sampledAt'?sample:null,key)])),
    models:observed&&(!verified||models===null)?null:models?.map(({id,digest,device,context,maxTokens,sizeBytes})=>
      ({id,digest,device,context,maxTokens,sizeBytes}))??[],
    resident:verified&&Array.isArray(resident)?resident:null};
}

function combined(configured,observations){
  const ids=new Set(configured.map(node=>node.id.toLowerCase()));
  const observed=observations().filter(node=>!ids.has(node.id.toLowerCase()));
  return [...configured,...observed];
}

function sourceOf(mode,nodes){
  if (nodes.some(node=>isObserved(node)&&node.freshness==='FRESH')) return mode==='simulation'?'MIXED':'OBSERVED';
  return mode==='simulation'?'SIMULATION':'CONFIGURED_ONLY';
}

function readonlyPlacement(nodes,mode,now){
  // 只解釋唯讀模式為何拒絕派送；遙測不成為執行資格，也不另建排程或預留資源。
  const base={kind:'READ_ONLY_ADMISSION',reservationPerformed:false,dispatchPerformed:false};
  if(mode!=='read-only') return {...base,status:'NOT_EVALUATED',evaluatedAt:null,selection:null,nodes:[]};
  return {...base,status:'REJECTED',evaluatedAt:now,selection:[],nodes:nodes.map(node=>({
    nodeId:node.id,eligible:false,source:node.source,status:node.status,freshness:node.freshness,
    executionQualification:'NOT_EVALUATED',
    reasons:['READ_ONLY_MODE',...(isObserved(node)?['OBSERVATION_NOT_EXECUTION_QUALIFICATION']:[]),
      ...(node.freshness==='STALE'?['TELEMETRY_STALE']:node.freshness==='UNKNOWN'?['TELEMETRY_UNKNOWN']:[]),
      ...(node.status==='OFFLINE'?['NODE_OFFLINE']:[])]
  }))};
}

function storage(used,total){
  return {usedKiB:kiB(used),totalKiB:kiB(total),
    availableKiB:Number.isFinite(used)&&Number.isFinite(total)&&total>=used?kiB(total-used):null};
}
function legacyNode(row) {
  const {id,name,status,source,metrics:m,freshness}=row;
  const verified=freshness==='FRESH';
  return {id,name,source,identityVerified:verified,status:verified?'ONLINE':status==='OFFLINE'?'OFFLINE':'UNKNOWN',
    ollamaStatus:verified&&source==='SIMULATION'?'SIMULATED':verified&&row.models!==null?'READ_ONLY_SAMPLED':'UNKNOWN',
    monitoring:{lastSampleAt:m.sampledAt,stale:!verified,status:verified?'ACTIVE':'UNKNOWN'},
    telemetry:{cpuPercent:m.cpuPercent,gpuPercent:m.gpuPercent,ram:storage(m.ramUsedBytes,row.ramBytes),
      swap:storage(m.swapUsedBytes,row.swapBytes),disk:storage(m.diskUsedBytes,row.diskBytes),
      temperatures:m.temperatureC==null?[]:[{name:'node',celsius:m.temperatureC}]}};
}

const missing=()=>Object.assign(Error('No qualified model observation'),{code:'NODE_UNAVAILABLE'});

export function legacyViews(controller,telemetry,mode,now=Date.now(),legacy=null,observations=()=>[]) {
  const nodes=combined(controller.nodes(),observations).map(node=>publicNode(node,now));
  const list=()=>nodes;
  const manager={
    list:()=>list().map(legacyNode), find:id=>list().find(node=>node.id===id), view:legacyNode,
    listModels(node){
      if (node.freshness!=='FRESH'||node.models===null) throw missing();
      return node.models.map(model=>({name:model.id,digest:model.digest,size:model.sizeBytes??null}));
    },
    residentSnapshot(node){
      if (node.resident===null) throw missing();
      return {sampledAt:node.metrics.sampledAt,models:node.resident};
    }
  };
  const history={
    status:()=>({error:null}),
    query({nodeIds,from,to,limit}){
      return telemetry.history({nodeId:nodeIds[0],from,to,limit}).map(row=>{
        const {sampledAt,observedAt,nodeId,cpuPercent,gpuPercent,ramUsedBytes,ramBytes,swapUsedBytes,temperatureC}=row;
        return {nodeId,sampledAt,observedAt,source:row.source,valid:true,status:'SAMPLED',
          metrics:{cpuPercent,gpuPercent,ramUsedKiB:kiB(ramUsedBytes),
            ramAvailableKiB:storage(ramUsedBytes,ramBytes).availableKiB,swapUsedKiB:kiB(swapUsedBytes),temperatureC}};
      });
    }
  };
  const work=()=>({db:{
    snapshotOnly:true,coverage:legacy?'LOCAL_AND_ARCHIVED':'LOCAL_RECENT',
    taskPage:()=>({tasks:[
      ...controller.snapshot().jobs.map(job=>({...job,source:job.source??'LOCAL',errorCode:job.error?.code})),
      ...(legacy?.tasks??[]).map(job=>({...job,source:legacy.source}))
    ].sort((a,b)=>b.createdAt-a.createdAt).slice(0,50),nextBefore:null}),
    duals:()=>legacy?.duals.slice(0,50).map(group=>({...group,source:legacy.source}))??[]
  }});
  return {manager,history,work,source:sourceOf(mode,nodes),inference:mode==='simulation'?'SIMULATION_ONLY':'DISABLED'};
}

export function dashboardView(controller,mode,version,now=Date.now(),legacy=null,observations=()=>[]) {
  const snapshot=controller.snapshot();
  const {jobs,locks,events}=snapshot;
  const nodes=combined(snapshot.nodes,observations).map(node=>publicNode(node,now));
  const cleanupByJob=new Map(jobs.map(job=>[job.id,job.cleanup?.reason]));
  return {version,mode,source:sourceOf(mode,nodes),
    nodes,placement:readonlyPlacement(nodes,mode,now),jobs:jobs.map(job=>jobView(job)),
    archive:legacy?{source:legacy.source,capturedAt:legacy.capturedAt,requestsCount:legacy.requestsCount,
      holdsCount:legacy.holdsCount,tasks:legacy.tasks.slice(0,40),duals:legacy.duals.slice(0,20)}:null,
    locks:locks.map(({jobId,attemptId,nodeId,resource,phase})=>({jobId,attemptId,nodeId,resource,phase,reason:cleanupByJob.get(jobId)??null})),
    events:events.map(({seq,jobId,attemptId,nodeId,event,at})=>({seq,jobId,attemptId,nodeId,event,at})),
    gates:{inference:mode==='simulation'?'SIMULATION':'BLOCKED',cleanup:'HOLD',hardware:'UNVERIFIED',
      gpu:'BLOCKED',remoteAccess:'BLOCKED'}};
}
