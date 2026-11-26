import {createHash,randomUUID} from 'node:crypto';
import {request} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {LEGACY_MODE,validLegacyMemoryEvidence} from './legacy-memory.mjs';
export {LEGACY_MODE} from './legacy-memory.mjs';

export const REAL_MODE='ACM_V08_ISOLATED_OLLAMA_ONCE';
export const REAL_PROMPT='請只回答 OK。';
export const OLLAMA_PORT=11438;
export const GENERATE_MS=90000;
export const EXECUTE_MS=120000;
export const MAX_TOKENS=16;
export const hex=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
export const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const count=value=>Number.isSafeInteger(value)&&value>=0;
export const modelTag=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_.-]{0,63}:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value);
export const sha=value=>createHash('sha256').update(value).digest('hex');
export const fail=code=>Object.assign(new Error(code),{code});
const enforce=(assertion,code)=>{if(!assertion)throw fail(code);};
export const oneShotPayload=value=>value&&Object.keys(value).length===2&&
  value.prompt===REAL_PROMPT&&value.maxTokens===MAX_TOKENS;
const MAX_JSON=262144;

export function checkModelManifest(value){
  const prefix='application/vnd.ollama.image.';
  const types=['model','template','system','license','params','messages'];
  enforce(value?.schemaVersion===2&&value.config?.mediaType==='application/vnd.docker.container.image.v1+json'&&
    Array.isArray(value.layers)&&value.layers.length>0&&value.layers.length<=24,'OLLAMA_MANIFEST_SCHEMA');
  enforce(!value.layers.some(row=>row?.mediaType===prefix+'projector'),'OLLAMA_PROJECTOR_BLOCKED');
  enforce(value.layers.filter(row=>row?.mediaType===prefix+'model').length===1&&
    value.layers.every(row=>types.some(type=>row?.mediaType===prefix+type)),'OLLAMA_MANIFEST_LAYER');
  const files=[value.config,...value.layers].map(row=>{
    enforce(typeof row.digest==='string'&&/^sha256:[a-f0-9]{64}$/.test(row.digest)&&
      count(row.size)&&row.size>0&&row.size<=4*1024**3,'OLLAMA_MANIFEST_SCHEMA');
    return {digest:row.digest.slice(7),size:row.size,type:row.mediaType};
  });
  enforce(files.reduce((bytes,row)=>bytes+row.size,0)<=512*1024**2,'OLLAMA_MODEL_BLOB_BUDGET');
  enforce(new Set(files.map(row=>row.digest)).size===files.length,'OLLAMA_MANIFEST_DUPLICATE_BLOB');
  return files;
}

export function fixedOllamaRequest(method,path,body,signal){
  const verb={'/api/version':'GET','/api/tags':'GET','/api/show':'POST','/api/ps':'GET','/api/generate':'POST'};
  enforce(Object.hasOwn(verb,path)&&verb[path]===method&&((method==='POST')===(body!==null)),
    'OLLAMA_ROUTE_REFUSED');
  signal.throwIfAborted();
  const data=body===null?null:JSON.stringify(body);
  enforce(!data||Buffer.byteLength(data)<=4096,'OLLAMA_REQUEST_SIZE');
  return new Promise((resolve,reject)=>{
    const headers={'connection':'close','accept':'application/json'};
    if(data!==null)Object.assign(headers,{'content-type':'application/json','content-length':Buffer.byteLength(data)});
    const req=request({host:'127.0.0.1',port:OLLAMA_PORT,method,path,agent:false,headers,signal},res=>{
      const json=/^application\/json(?:\s*;|$)/i.test(String(res.headers['content-type']??''));
      const httpFailure=reason=>Object.assign(fail('OLLAMA_HTTP_INVALID'),{http:{path,status:res.statusCode,json,reason}});
      if(!json){
        res.destroy();reject(httpFailure('NON_JSON'));return;
      }
      let total=0;
      const blocks=[];
      res.on('error',reject);
      res.on('data',chunk=>{
        total+=chunk.length;
        if(total>MAX_JSON)res.destroy(fail('OLLAMA_RESPONSE_SIZE'));
        else blocks.push(chunk);
      });
      res.on('end',()=>{
        try{
          enforce(res.complete&&total>0,'OLLAMA_HTTP_INCOMPLETE');
          const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(blocks)));
          if(res.statusCode!==200){
            const classifier=/permission denied|read-only file system|no such file|not found|does not support|out of memory|runner|invalid|context/i;
            throw httpFailure(classifier.exec(String(value?.error??''))?.[0]?.toUpperCase()??'UNCLASSIFIED');
          }
          enforce(value&&typeof value==='object'&&!Array.isArray(value)&&!Object.hasOwn(value,'error'),
            'OLLAMA_RESPONSE_SCHEMA');
          resolve(value);
        }catch(error){reject(error);}
      });
    });
    req.on('error',reject);
    req.end(data);
  });
}

const matches=(row,policy)=>row&&row.name===policy.model&&
  ([policy.digest,'sha256:'+policy.digest].includes(row.digest));
function models(response){
  enforce(Array.isArray(response?.models)&&response.models.length<=1,'OLLAMA_MODELS_SCHEMA');
  return response.models;
}

const cleanExit=value=>value&&((value.code===0&&value.signal===null)||
  (value.code===null&&value.signal==='SIGTERM'));
const counters=['oom','oomKill','max','pidsMaxHits'];
function metric(value,legacy=false){
  enforce(value&&value.healthy===true&&typeof value.empty==='boolean'&&
    (value.peak===null||count(value.peak))&&count(value.sampledPeak)&&
    counters.every(key=>count(value[key])),'OLLAMA_CGROUP_SAMPLE');
  if(legacy)enforce(value.peak===null&&validLegacyMemoryEvidence(value.legacyEvidence,{complete:false})&&
    value.legacyEvidence.sampledPeakBytes===value.sampledPeak,'LEGACY_MEMORY_EVIDENCE');
  return value;
}

export function validEngineEvidence(value,binding,context,mode=REAL_MODE){
  const legacy=mode===LEGACY_MODE;
  if(![REAL_MODE,LEGACY_MODE,'LINUX_ISOLATED_SIMULATION'].includes(mode))return false;
  return value&&typeof value==='object'&&Object.keys(value).length===(legacy?21:19)&&
    value.attemptId===binding.attemptId&&value.digest===binding.digest&&
    hex(value.attestation)&&hex(value.responseSha256)&&
    value.httpStatus===200&&['stop','length'].includes(value.doneReason)&&
    count(value.evalCount)&&value.evalCount>0&&value.evalCount<=MAX_TOKENS&&value.context===context&&
    value.vramBytes===0&&value.residentAfter===0&&value.cgroupEmpty===true&&value.runnerObserved===true&&
    value.oomDelta===0&&value.oomKillDelta===0&&value.memoryMaxHitsDelta===0&&value.pidsMaxHitsDelta===0&&
    count(value.sampledPeakBytes)&&cleanExit(value.exit)&&
    (legacy?(context===512&&value.memoryMode===LEGACY_MODE&&value.peakBytes===null&&
      validLegacyMemoryEvidence(value.memoryEvidence)&&value.memoryEvidence.sampledPeakBytes===value.sampledPeakBytes):
      (count(value.peakBytes)&&value.peakBytes>0&&value.peakBytes>=value.sampledPeakBytes&&value.peakBytes<=1879048192));
}

export function createOllamaSupervisor(policy,pool){
  const legacy=policy?.mode===LEGACY_MODE;
  enforce(modelTag(policy?.model)&&hex(policy.digest)&&policy.version==='0.40.16'&&
    (legacy?(policy.context===512&&policy.limits?.memory===1610612736&&policy.limits?.memoryHigh===1476395008):
      ([512,1024].includes(policy.context)&&[2147483648,4294967296].includes(policy.limits?.memory)))&&
    ['LINUX_ISOLATED_SIMULATION',REAL_MODE,LEGACY_MODE].includes(policy.mode),'OLLAMA_ONCE_POLICY');
  const engine=randomUUID();
  let used=false,dirty=false,owner=null,finished=null;
  function sample(){
    try{
      const current=metric(pool.metrics(),legacy);
      if(!current.empty&&!owner)dirty=true;
      if(finished&&counters.some(key=>current[key]!==finished.counters[key]))dirty=true;
      return {engine,healthy:!dirty,active:Number(!!owner||!current.empty),
        resident:owner||dirty?1:0,attestation:dirty?null:finished?.attestation??null};
    }catch{dirty=true;return {engine,healthy:false,active:1,resident:1,attestation:null};}
  }
  async function execute(binding,payload,external){
    enforce(!used&&!dirty&&!owner&&uuid(binding?.attemptId)&&binding.model===policy.model&&
      binding.digest===policy.digest&&oneShotPayload(payload),'OLLAMA_ONCE_HELD');
    used=true;
    const abort=new AbortController();
    owner={attemptId:binding.attemptId,abort};
    const total=AbortSignal.any([abort.signal,AbortSignal.timeout(EXECUTE_MS),...(external?[external]:[])]);
    const startedAt=performance.now();
    let handle,result,closedMetrics,exit;
    try{
      const before=metric(pool.metrics(),legacy);
      enforce(before.empty,'OLLAMA_CGROUP_NOT_EMPTY');
      handle=await pool.start(total);
      const get=(path,signal=total)=>handle.request('GET',path,null,signal);
      const post=(path,data,signal=total)=>handle.request('POST',path,data,signal);
      enforce((await get('/api/version')).version===policy.version,'OLLAMA_RUNTIME_VERSION');
      const tags=models(await get('/api/tags'));
      enforce(tags.length===1&&matches(tags[0],policy),'OLLAMA_MODEL_DIGEST');
      const show=await post('/api/show',{model:policy.model,verbose:false});
      enforce(Array.isArray(show.capabilities)&&show.capabilities.includes('completion')&&
        !show.capabilities.some(cap=>['vision','audio','embedding'].includes(cap))&&
        show.details?.format==='gguf','OLLAMA_TEXT_MODEL_REQUIRED');
      enforce(models(await get('/api/ps')).length===0,'OLLAMA_ALREADY_RESIDENT');
      let response,pending=true,rpcError,seen=false;
      const dispatchedAt=performance.now();
      const generateDeadline=AbortSignal.timeout(GENERATE_MS);
      const generateSignal=AbortSignal.any([total,generateDeadline]);
      const classifyTermination=error=>{
        if(!generateDeadline.aborted)return error;
        pool.recordInference?.({result:'TIMED_OUT',requestMs:Math.ceil(performance.now()-dispatchedAt),
          hadResidentSample:seen});
        return fail('OLLAMA_GENERATE_TIMEOUT');
      };
      const call=post('/api/generate',{model:policy.model,prompt:payload.prompt,stream:false,think:false,keep_alive:0,
        options:{num_gpu:0,num_thread:1,num_ctx:policy.context,num_predict:MAX_TOKENS,temperature:0}},generateSignal)
        .then(value=>{response=value;},error=>{rpcError=error;}).finally(()=>{pending=false;});
      try{
        while(pending){
          const resident=models(await get('/api/ps',generateSignal));
          if(resident.length){
            enforce(matches(resident[0],policy)&&resident[0].context_length===policy.context&&
              resident[0].size_vram===0,'OLLAMA_EFFECTIVE_CPU_CONTEXT');
            seen=true;
          }
          const running=metric(pool.metrics(),legacy);
          enforce(!running.empty&&counters.every(key=>running[key]===before[key]),'OLLAMA_ENGINE_LIMIT_EVENT');
          if(pending)await delay(20,undefined,{signal:generateSignal});
        }
      }catch(error){abort.abort();await call;throw classifyTermination(error);}
      await call;
      const responseAt=performance.now();
      if(rpcError)throw classifyTermination(rpcError);
      enforce(responseAt-dispatchedAt<=GENERATE_MS&&seen&&response?.model===policy.model&&response.done===true&&
        ['stop','length'].includes(response.done_reason)&&typeof response.response==='string'&&
        response.response.trim()&&Buffer.byteLength(response.response)<=16384&&
        count(response.eval_count)&&response.eval_count>0&&response.eval_count<=MAX_TOKENS,'OLLAMA_TERMINAL_UNKNOWN');
      const drain=AbortSignal.any([total,AbortSignal.timeout(7000)]);
      while(true){
        const resident=models(await get('/api/ps',drain));
        if(!resident.length)break;
        enforce(matches(resident[0],policy),'OLLAMA_RESIDENT_IDENTITY');
        await delay(50,undefined,{signal:drain});
      }
      const proof=await handle.engineProof();
      enforce(hex(proof?.attestation)&&proof.actualContext===policy.context&&proof.runnerObserved===true,
        'OLLAMA_ENGINE_ATTESTATION');
      exit=await handle.stop();
      closedMetrics=metric(pool.metrics(),legacy);
      enforce(cleanExit(exit)&&closedMetrics.empty&&counters.every(key=>closedMetrics[key]===before[key])&&
        (legacy?validLegacyMemoryEvidence(closedMetrics.legacyEvidence):
          (Number.isSafeInteger(closedMetrics.peak)&&closedMetrics.peak>=closedMetrics.sampledPeak&&
          closedMetrics.peak<=policy.limits.memory-256*1024**2)),'OLLAMA_PEAK_OR_TEARDOWN_UNKNOWN');
      total.throwIfAborted();
      result={attestation:proof.attestation,attemptId:binding.attemptId,digest:binding.digest,
        context:policy.context,evalCount:response.eval_count,responseSha256:sha(response.response),
        httpStatus:200,doneReason:response.done_reason,vramBytes:0,residentAfter:0,exit,cgroupEmpty:true,
        peakBytes:closedMetrics.peak,sampledPeakBytes:closedMetrics.sampledPeak,runnerObserved:true,
        oomDelta:0,oomKillDelta:0,memoryMaxHitsDelta:0,pidsMaxHitsDelta:0,
        ...(legacy?{memoryMode:LEGACY_MODE,memoryEvidence:closedMetrics.legacyEvidence}:{})};
      enforce(validEngineEvidence(result,binding,policy.context,policy.mode),'OLLAMA_TERMINAL_UNKNOWN');
      pool.recordInference?.({requestMs:Math.ceil(responseAt-dispatchedAt),startupAndGenerateMs:Math.ceil(responseAt-startedAt),
        loadDurationNs:count(response.load_duration)?response.load_duration:null,
        evalDurationNs:count(response.eval_duration)?response.eval_duration:null,
        totalDurationNs:count(response.total_duration)?response.total_duration:null});
      finished={attestation:proof.attestation,counters:closedMetrics};
      return {attemptId:binding.attemptId,terminal:true,outcome:'SUCCEEDED',engine,engineEvidence:result};
    }catch(error){
      dirty=true;
      if(handle&&!exit){
        try{await handle.stop();}catch{ /* 保留原錯誤，後續觀察仍為 HOLD。 */ }
      }
      throw error;
    }finally{owner=null;}
  }
  function cancel(binding){
    enforce(owner?.attemptId===binding?.attemptId,'OLLAMA_ATTEMPT_MISMATCH');
    owner.abort.abort(fail('OLLAMA_CANCELLED_UNKNOWN'));
  }
  return Object.freeze({execute,cancel,sample});
}
