import {createHash,randomBytes} from 'node:crypto';
import {readAgentPublicKey,verifyAgentSnapshot} from '../agent/protocol.mjs';
import {hasKeys} from './inference-http.mjs';

const lifetimeMs=30000;
const freshnessMs=15000;
const fault=(code,status)=>Object.assign(Error(code),{code,status});

export function createObservationStore({sources=[],telemetry,now=Date.now,monotonic=()=>performance.now()}){
  const bindings=new Map(sources.map(source=>{
    readAgentPublicKey(source.publicKey);
    return [source.nodeId,{...source,fingerprint:createHash('sha256').update(source.publicKey).digest('hex')}];
  }));
  const pending=new Map(),latest=new Map();
  let local=null;
  function bindingFor(body,token,keys){
    if (!hasKeys(body,keys) || typeof body.nodeId!=='string') throw fault('TELEMETRY_REJECTED',400);
    const binding=bindings.get(body.nodeId);
    if (!binding || binding.tokenId!==token.id) throw fault('TELEMETRY_SCOPE_DENIED',403);
    return binding;
  }
  function view(binding,sample,expired=false){
    const metrics=sample?.metrics??{};
    return {id:binding.nodeId,name:binding.name??binding.nodeId,platform:'linux-arm64',
      status:sample?'ONLINE':'UNKNOWN',availability:'UNVERIFIED',source:binding.kind,identityVerified:!!sample,observationExpired:expired,
      aliases:[],cpuCores:null,gpuBytes:null,gpu:{state:'UNKNOWN'},ramBytes:metrics.ramBytes??null,
      swapBytes:metrics.swapBytes??null,diskBytes:metrics.diskBytes??null,
      metrics:sample?{...metrics,sampledAt:sample.sampledAt}:null,
      models:sample?.models?.map(model=>({id:model.name,digest:model.digest,sizeBytes:model.sizeBytes}))??null,
      resident:sample?.resident?.map(model=>model.name)??null};
  }
  function timed(sample,receivedAt,tick){
    return {sample,tick,deadline:tick+freshnessMs-Math.max(0,receivedAt-sample.sampledAt),expired:false};
  }
  function expired(record){
    const tick=monotonic();
    record.expired ||= tick<record.tick || tick>record.deadline || now()-record.sample.sampledAt>freshnessMs;
    return record.expired;
  }
  return {
    nodes(){
      const own=local?[{...local.sample.node,observationExpired:expired(local)}]:[];
      const peers=[...bindings.values()].map(binding=>{
        const record=latest.get(binding.nodeId);
        return view(binding,record?.sample,record?expired(record):false);
      });
      return [...own,...peers];
    },
    setLocal(node){
      const at=now();
      telemetry.record([node],at);
      local=timed({node,sampledAt:node.metrics.sampledAt},at,monotonic());
    },
    ingest({path,token,body}){
      const at=now(),tick=monotonic();
      if (path==='/acm/v1/telemetry/challenge'){
        const binding=bindingFor(body,token,['nodeId']);
        const last=pending.get(binding.nodeId);
        if (last && tick-last.since<200) throw fault('TELEMETRY_BUSY',429);
        const challenge=randomBytes(32).toString('base64url');
        pending.set(binding.nodeId,{challenge,since:tick});
        return {nodeId:binding.nodeId,challenge,expiresAt:at+lifetimeMs};
      }
      if (path!=='/acm/v1/telemetry/snapshot') throw fault('TELEMETRY_REJECTED',400);
      const binding=bindingFor(body,token,['nodeId','snapshot']);
      const request=pending.get(binding.nodeId);
      if (!request || tick<request.since || tick-request.since>lifetimeMs) throw fault('TELEMETRY_REJECTED',400);
      const {nodeId,publicKey,fingerprint}=binding;
      const lastSequence=telemetry.sequenceFloor(nodeId,fingerprint);
      let sample;
      try{
        sample=verifyAgentSnapshot(body.snapshot,{nodeId,publicKey,challenge:request.challenge,lastSequence,now:at,maxAgeMs:freshnessMs});
      }catch{throw fault('TELEMETRY_REJECTED',400);}
      telemetry.acceptObservation(view(binding,sample),at,{fingerprint,sequence:sample.sequence});
      pending.delete(nodeId);
      latest.set(nodeId,timed(sample,at,tick));
      return {nodeId,source:binding.kind,sampledAt:sample.sampledAt,sequence:sample.sequence};
    }
  };
}
