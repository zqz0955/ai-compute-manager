import {createHash,createPublicKey,randomBytes,sign,verify} from 'node:crypto';
import {closeSync,lstatSync,openSync,realpathSync} from 'node:fs';
import {basename,dirname,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {REAL_MODE,LEGACY_MODE,EXECUTE_MS,modelTag,oneShotPayload,validEngineEvidence} from './ollama-once.mjs';

const domain='ACM_V08_SIMULATION_UPSTREAM_V1';
const schemaTag='ACM_V08_SIMULATION_UPSTREAM_DB_V1';
export const UPSTREAM_EVIDENCE_BUDGET_MS=700;
const maxQueryMs=UPSTREAM_EVIDENCE_BUDGET_MS;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code)=>Object.assign(Error(code),{code});
const hex=(value,n)=>typeof value==='string'&&value.length===n&&/^[0-9a-f]+$/.test(value);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const bindingFields=['jobId','attemptId','owner','resource','model','digest','target','intentAt'];
const isCount=n=>Number.isSafeInteger(n)&&n>=0;
const states=['ACCEPTED','RUNNING','TERMINAL','UNKNOWN'];
const outcomes=['SUCCEEDED','FAILED','CANCELLED'];
const clients=new WeakSet();
const layout=fileURLToPath(new URL('../../tools/fixtures/work',import.meta.url));
const blank='0'.repeat(64);
const isReal=identity=>[REAL_MODE,LEGACY_MODE].includes(identity.mode);
const domainFor=identity=>identity.mode===LEGACY_MODE?'ACM_LEGACY_KERNEL_BOUNDED_CPU_V1':
  isReal(identity)?'ACM_V08_REAL_OLLAMA_ONCE_V1':domain;
const schemaFor=identity=>identity.mode===LEGACY_MODE?'ACM_LEGACY_KERNEL_BOUNDED_CPU_DB_V1':
  isReal(identity)?'ACM_V08_REAL_OLLAMA_ONCE_DB_V1':schemaTag;

function exact(value,keys) {
  return value!==null&&typeof value==='object'&&!Array.isArray(value)&&
    Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
}
function bindingFor(binding,identity) {
  if(!exact(binding,bindingFields)||!['jobId','attemptId','owner'].every(k=>uuid(binding[k]))||
     binding.resource!==identity.resource||binding.model!==identity.model||binding.digest!==identity.digest||
     !hex(binding.target,64)||!isCount(binding.intentAt)||binding.intentAt===0)throw fail('UPSTREAM_BINDING');
  return Object.fromEntries(bindingFields.map(k=>[k,binding[k]]));
}
function policy(identity) {
  const {resource,epoch,model,digest,workerPublicKey,controllerPublicKey}=identity;
  const real=isReal(identity);
  if(!hex(resource,64)||!hex(digest,64)||!uuid(epoch)||typeof model!=='string'||
     (real?(!modelTag(model)||!hex(identity.release,64)||!(identity.mode===LEGACY_MODE?identity.context===512:[512,1024].includes(identity.context))):
       (identity.mode!==undefined||!/^fixture:[a-z0-9_.-]{1,48}$/.test(model)))||
     ![workerPublicKey,controllerPublicKey].every(k=>k?.type==='public'&&k.asymmetricKeyType==='ed25519')||
     workerPublicKey.equals(controllerPublicKey))throw fail('UPSTREAM_IDENTITY');
  return hash([domainFor(identity),resource,epoch,model,digest,workerPublicKey.export({type:'spki',format:'der'}).toString('hex'),
    controllerPublicKey.export({type:'spki',format:'der'}).toString('hex'),...(real?[identity.release,identity.context]:[])]);
}
function signer(privateKey,pinned,identity) {
  if(privateKey?.type!=='private'||privateKey.asymmetricKeyType!=='ed25519'||!createPublicKey(privateKey).equals(pinned))
    throw fail('UPSTREAM_IDENTITY');
  return (kind,value)=>({value,signature:sign(null,Buffer.from(JSON.stringify([domainFor(identity),kind,value])),privateKey).toString('hex')});
}
function authenticated(kind,wire,key,identity) {
  if(!exact(wire,['value','signature'])||!hex(wire.signature,128))throw fail('UPSTREAM_SIGNATURE');
  const bytes=Buffer.from(JSON.stringify([domainFor(identity),kind,wire.value]));
  if(bytes.length>8192||!verify(null,bytes,key,Buffer.from(wire.signature,'hex')))throw fail('UPSTREAM_SIGNATURE');
  return wire.value;
}
function fileId(path) {
  const meta=lstatSync(path,{bigint:true});
  if(!meta.isFile()||meta.nlink!==1n||meta.ino===0n||realpathSync(path)!==path)throw fail('UPSTREAM_STORAGE');
  return String(meta.dev)+':'+String(meta.ino);
}
function pathFor(path,identity) {
  const nx=identity.mode===LEGACY_MODE && ['legacy-cpu','h3-json','h3-sse'].some(slot=>
    path==='/opt/acm-nx-'+slot+'-audit-v1/worker/upstream.sqlite' &&
    fileURLToPath(import.meta.url)==='/opt/acm-nx-'+slot+'-v1/code/src/worker/r1/upstream-terminal.mjs');
  if(resolve(path)!==path||basename(path)!=='upstream.sqlite'||
     (!nx&&(dirname(dirname(path))!==layout||realpathSync(layout)!==layout))||
     realpathSync(dirname(path))!==dirname(path))throw fail('UPSTREAM_STORAGE');
  return path;
}
function sidecars(path) {
  for(const suffix of ['-wal','-shm','-journal']){
    try{fileId(path+suffix);}
    catch(cause){if(cause.code!=='ENOENT')throw cause;}
  }
}
function sqlite(path) {
  const db=new DatabaseSync(path);
  try{
    db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='wal'||
       db.prepare('PRAGMA synchronous').get().synchronous!==2||
       db.prepare('PRAGMA quick_check').all().some(r=>r.quick_check!=='ok'))throw fail('UPSTREAM_STORAGE');
    return db;
  } catch(cause){db.close();throw cause;}
}
function transaction(db,run) {
  db.exec('BEGIN IMMEDIATE');
  try{const value=run();db.exec('COMMIT');return value;}
  catch(cause){if(db.isTransaction)try{db.exec('ROLLBACK');}catch{} throw cause;}
}
async function within(signal,run) {
  signal.throwIfAborted();
  let onAbort;
  try{
    const stopped=new Promise((_,reject)=>{
      onAbort=()=>reject(signal.reason);
      signal.addEventListener('abort',onAbort,{once:true});
    });
    return await Promise.race([stopped,run()]);
  }finally{signal.removeEventListener('abort',onAbort);}
}

export function provisionSimulationWorker({database,identity,workerPrivateKey}) {
  const path=pathFor(database,identity),pin=policy(identity);
  const seal=signer(workerPrivateKey,identity.workerPublicKey,identity);
  sidecars(path);
  const descriptor=openSync(path,'wx');
  closeSync(descriptor);
  const storage=fileId(path),db=sqlite(path);
  try{
    transaction(db,()=>{
      db.exec('CREATE TABLE binding(checkpoint TEXT NOT NULL CHECK(json_valid(checkpoint)), signature TEXT NOT NULL);'+
        'CREATE TABLE events(seq INTEGER PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document)), signature TEXT NOT NULL);');
      const first=seal('CHECKPOINT',[schemaFor(identity),pin,storage,0,blank]);
      db.prepare('INSERT INTO binding VALUES(?,?)').run(JSON.stringify(first.value),first.signature);
    });
  } finally{db.close();}
  return storage;
}
function eventData(record,identity) {
  const real=isReal(identity);
  if(!exact(record,['seq','previous','binding','state','input','engine','outcome',...(real?['engineEvidence']:[])])||
     !isCount(record.seq)||record.seq===0||!hex(record.previous,64)||!states.includes(record.state)||!hex(record.input,64))
    throw fail('UPSTREAM_LEDGER');
  bindingFor(record.binding,identity);
  if(record.state==='TERMINAL'){
    if(!uuid(record.engine)||!outcomes.includes(record.outcome)||
       (real&&(record.outcome!=='SUCCEEDED'||!validEngineEvidence(record.engineEvidence,record.binding,identity.context,identity.mode))))
      throw fail('UPSTREAM_LEDGER');
  }else if(record.outcome!==null||
           (real&&record.engineEvidence!==null)||
           (record.state==='ACCEPTED'?record.engine!==null:!uuid(record.engine)&&record.engine!==null)||
           (record.state==='RUNNING'&&!uuid(record.engine)))throw fail('UPSTREAM_LEDGER');
  return record;
}
function snapshot(value,identity) {
  const real=isReal(identity);
  if(!exact(value,['engine','healthy','active','resident',...(real?['attestation']:[])])||
     (real&&value.attestation!==null&&!hex(value.attestation,64))||!uuid(value.engine)||typeof value.healthy!=='boolean'||
     !isCount(value.active)||!isCount(value.resident))return null;
  return {...value};
}

export function openSimulationWorker({database,storage,identity,workerPrivateKey,execute,sample,afterAccept,witness,cancel}) {
  identity=Object.freeze({...identity});
  const path=pathFor(database,identity),pin=policy(identity),seal=signer(workerPrivateKey,identity.workerPublicKey,identity);
  const real=isReal(identity);
  if(real&&(!witness||typeof witness.read!=='function'||typeof witness.advance!=='function'))
    throw fail('UPSTREAM_ANCHOR');
  if(typeof execute!=='function'||typeof sample!=='function'||fileId(path)!==storage)throw fail('UPSTREAM_STORAGE');
  sidecars(path);
  const db=sqlite(path),rows=new Map();
  let head=blank,sequence=0,active=null,closed=false,poisoned=false,anchoring,ready;
  const coordinate=()=>({pin,sequence,head});
  function remember(wire) {
    const row=eventData(authenticated('EVENT',wire,identity.workerPublicKey,identity),identity);
    const id=row.binding.attemptId,prior=rows.get(id)?.value;
    if(row.seq!==sequence+1||row.previous!==head||
       (!prior?(row.state!=='ACCEPTED'||active!==null||(real&&rows.size!==0)):
         (active!==id||hash(row.binding)!==hash(prior.binding)||row.input!==prior.input||
          !({ACCEPTED:['RUNNING','UNKNOWN'],RUNNING:['TERMINAL','UNKNOWN']}[prior.state]??[]).includes(row.state)||
          (prior.state==='RUNNING'&&row.engine!==prior.engine))))throw fail('UPSTREAM_LEDGER');
    rows.set(id,wire);
    active=row.state==='TERMINAL'?null:id;
    head=hash(wire);
    sequence=row.seq;
    return wire;
  }
  function append(binding,state,input,engine=null,outcome=null,engineEvidence=null) {
    if(closed||poisoned)throw fail('UPSTREAM_UNAVAILABLE');
    try{
      if(fileId(path)!==storage)throw fail('UPSTREAM_STORAGE');
      const record={seq:sequence+1,previous:head,binding,state,input,engine,outcome,...(real?{engineEvidence}:{})};
      const wire=seal('EVENT',record);
      const next=seal('CHECKPOINT',[schemaFor(identity),pin,storage,record.seq,hash(wire)]);
      transaction(db,()=>{
        db.prepare('INSERT INTO events VALUES(?,?,?)').run(record.seq,JSON.stringify(record),wire.signature);
        if(db.prepare('UPDATE binding SET checkpoint=?,signature=?').run(JSON.stringify(next.value),next.signature).changes!==1)
          throw fail('UPSTREAM_LEDGER');
      });
      if(witness){
        const from=coordinate(),to={pin,sequence:record.seq,head:next.value[4]};
        // Worker 開始執行或核發終態前，獨立見證必須先持久確認 SQLite 的新端點。
        anchoring=Promise.resolve().then(()=>witness.advance(from,to)).then(reply=>{
          if(closed||hash(reply)!==hash(to))throw fail('UPSTREAM_ANCHOR');
          return remember(wire);
        }).catch(cause=>{poisoned=true;throw cause;}).finally(()=>{anchoring=null;});
        return anchoring;
      }
      return remember(wire);
    }catch(cause){poisoned=true;throw cause;}
  }
  try{
    transaction(db,()=>{
      const metadata=db.prepare('SELECT * FROM binding').all();
      if(metadata.length!==1)throw fail('UPSTREAM_STORAGE');
      const checkpoint=authenticated('CHECKPOINT',{value:JSON.parse(metadata[0].checkpoint),
        signature:metadata[0].signature},identity.workerPublicKey,identity);
      for(const stored of db.prepare('SELECT seq,document,signature FROM events ORDER BY seq').iterate()){
        const value=JSON.parse(stored.document);
        if(stored.seq!==value.seq)throw fail('UPSTREAM_LEDGER');
        remember({value,signature:stored.signature});
      }
      if(hash(checkpoint)!==hash([schemaFor(identity),pin,storage,sequence,head]))throw fail('UPSTREAM_LEDGER');
    });
    const pending=rows.get(active)?.value;
    const restore=()=>pending?.state==='RUNNING'?append(pending.binding,'UNKNOWN',pending.input,pending.engine):undefined;
    if(witness){
      ready=Promise.resolve().then(()=>witness.read()).then(receipt=>{
        if(hash(receipt)!==hash(coordinate()))throw fail('UPSTREAM_ANCHOR');
        return restore();
      }).catch(cause=>{poisoned=true;throw cause;});
      void ready.catch(()=>{});
    }else restore();
  }catch(cause){db.close();throw cause;}

  async function run(accepted,payload) {
    const {binding,input}=accepted.value;
    let engine=null;
    try {
      await afterAccept?.(binding);
      if(closed||poisoned)return;
      const probeDeadline=AbortSignal.timeout(maxQueryMs);
      const initial=snapshot(await within(probeDeadline,()=>sample(probeDeadline)),identity);
      if(!initial?.healthy||initial.active!==0||initial.resident!==0)throw fail('UPSTREAM_RESOURCES');
      engine=initial.engine;
      // RUNNING 必須先落盤。程序退出後不能從這個狀態重送。
      await append(binding,'RUNNING',input,engine);
      const executionDeadline=AbortSignal.timeout(real?EXECUTE_MS+3000:60000);
      const result=await within(executionDeadline,()=>execute({binding,payload,signal:executionDeadline}));
      if(closed||poisoned)return;
      if(!exact(result,['attemptId','terminal','outcome','engine',...(real?['engineEvidence']:[])])||
         result.attemptId!==binding.attemptId||result.terminal!==true||result.engine!==engine||
         !outcomes.includes(result.outcome)||(real&&(result.outcome!=='SUCCEEDED'||
           !validEngineEvidence(result.engineEvidence,binding,identity.context,identity.mode))))
        throw fail('UPSTREAM_TERMINAL_UNKNOWN');
      await append(binding,'TERMINAL',input,engine,result.outcome,result.engineEvidence);
    }catch{
      if(!closed&&!poisoned)await append(binding,'UNKNOWN',input,rows.get(binding.attemptId)?.value.engine??null);
    }
  }
  async function receive(wire,signal) {
    if(ready)await ready;
    while(anchoring)await anchoring;
    if(closed||poisoned||fileId(path)!==storage)throw fail('UPSTREAM_UNAVAILABLE');
    signal?.throwIfAborted();
    const value=authenticated('REQUEST',wire,identity.controllerPublicKey,identity);
    if(!exact(value,['op','nonce','epoch','binding','payload'])||value.epoch!==identity.epoch||
       !hex(value.nonce,64)||!['DISPATCH','QUERY','CANCEL'].includes(value.op))throw fail('UPSTREAM_REQUEST');
    const binding=bindingFor(value.binding,identity), id=binding.attemptId;
    let event=rows.get(id)??null;
    if(event&&hash(event.value.binding)!==hash(binding))throw fail('UPSTREAM_BINDING');
    let resources=null;
    if(value.op==='DISPATCH'){
      if(!exact(value.payload,['prompt','maxTokens'])||typeof value.payload.prompt!=='string'||
         !value.payload.prompt.trim()||Buffer.byteLength(value.payload.prompt)>512||
         (real?!oneShotPayload(value.payload):![32,64,128,256].includes(value.payload.maxTokens)))throw fail('UPSTREAM_LIMIT');
      const input=hash([value.payload.prompt,value.payload.maxTokens]);
      if(event&&event.value.input!==input)throw fail('UPSTREAM_BINDING');
      if(!event){
        if(real&&rows.size!==0)throw fail('UPSTREAM_ONE_SHOT_CONSUMED');
        if(active!==null)throw fail('UPSTREAM_HELD');
        event=await append(binding,'ACCEPTED',input);
        void run(event,value.payload).catch(()=>{poisoned=true;});
      }
    }else if(value.op==='CANCEL'){
      if(value.payload!==null||typeof cancel!=='function'||!event)throw fail('UPSTREAM_CANCEL_UNAVAILABLE');
      if(event.value.state==='RUNNING')await cancel(binding,signal);
    }else{
      if(value.payload!==null)throw fail('UPSTREAM_REQUEST');
      if(event?.value.state==='TERMINAL'&&active===null){
        const checkpoint=sequence,start=performance.now();
        try{
          const deadline=AbortSignal.timeout(maxQueryMs);
          const probeSignal=signal?AbortSignal.any([signal,deadline]):deadline;
          const sampled=snapshot(await within(probeSignal,()=>sample(probeSignal)),identity);
          // 第二筆派送插入或 Worker 關閉時，丟棄核對中的資源樣本。
          if(!closed&&!poisoned&&!anchoring&&sequence===checkpoint&&performance.now()-start<=maxQueryMs&&
             sampled?.engine===event.value.engine)resources=sampled;
        }catch{}
      }
    }
    if(closed||poisoned||fileId(path)!==storage)throw fail('UPSTREAM_UNAVAILABLE');
    signal?.throwIfAborted();
    return structuredClone(seal('RESPONSE',{op:value.op,nonce:value.nonce,epoch:identity.epoch,binding,
      state:event?.value.state??'UNKNOWN',event,resources}));
  }
  return Object.freeze({receive,ready,close(){if(!closed){closed=true;db.close();}}});
}

function evidenceVerifier(identity){
  const pin=policy(identity);
  function terminalReceipt(binding,wire){
    const value=authenticated('RESPONSE',wire,identity.workerPublicKey,identity);
    if(value.op!=='QUERY'||!hex(value.nonce,64)||value.epoch!==identity.epoch||value.state!=='TERMINAL'||
       hash(value.binding)!==hash(bindingFor(binding,identity)))return null;
    const event=eventData(authenticated('EVENT',value.event,identity.workerPublicKey,identity),identity);
    const resources=snapshot(value.resources,identity);
    if(event.state!=='TERMINAL'||hash(event.binding)!==hash(value.binding)||resources?.engine!==event.engine||
       !resources.healthy||resources.active!==0||resources.resident!==0||
       (isReal(identity)&&resources.attestation!==event.engineEvidence.attestation))return null;
    return {source:domainFor(identity),policy:pin,workerEpoch:identity.epoch,
      workerSequence:event.seq,outcome:event.outcome,workerReceipt:wire};
  }
  function verifiesAudit(binding,evidence) {
    try {
      const matched=terminalReceipt(binding,evidence.workerReceipt);
      return !!matched&&['source','policy','workerEpoch','workerSequence','outcome'].every(key=>matched[key]===evidence[key]);
    }catch{return false;}
  }
  return {pin,terminalReceipt,verifiesAudit};
}

export function createUpstreamAuditVerifier(identity){
  if(!isReal(identity))throw fail('UPSTREAM_IDENTITY');
  const {pin,verifiesAudit}=evidenceVerifier(Object.freeze({...identity}));
  const client=Object.freeze({pin,verifiesAudit,real:true,verificationOnly:true});
  clients.add(client);
  return client;
}

export function createUpstreamClient({identity,controllerPrivateKey,exchange}) {
  identity=Object.freeze({...identity});
  const {pin,terminalReceipt,verifiesAudit}=evidenceVerifier(identity);
  const seal=signer(controllerPrivateKey,identity.controllerPublicKey,identity);
  if(typeof exchange!=='function')throw fail('UPSTREAM_IDENTITY');
  async function request(op,original,payload,external) {
    const binding=bindingFor(original,identity);
    const nonce=randomBytes(32).toString('hex'),local=AbortSignal.timeout(maxQueryMs);
    const signal=external?AbortSignal.any([external,local]):local;
    signal.throwIfAborted();
    const start=performance.now();
    const sent=seal('REQUEST',{op,nonce,epoch:identity.epoch,binding,payload});
    const wire=await within(signal,()=>exchange(sent,signal));
    signal.throwIfAborted();
    if(performance.now()-start>maxQueryMs)throw fail('UPSTREAM_TIMEOUT');
    const value=authenticated('RESPONSE',wire,identity.workerPublicKey,identity);
    if(!exact(value,['op','nonce','epoch','binding','state','event','resources'])||value.op!==op||value.nonce!==nonce||
       value.epoch!==identity.epoch||hash(value.binding)!==hash(binding)||!states.includes(value.state))
      throw fail('UPSTREAM_REPLAY_OR_IDENTITY');
    if(value.event===null){
      if(value.state!=='UNKNOWN'||value.resources!==null)throw fail('UPSTREAM_PROTOCOL');
    }else{
      const record=eventData(authenticated('EVENT',value.event,identity.workerPublicKey,identity),identity);
      if(hash(record.binding)!==hash(binding)||value.state!==record.state||
         (op==='DISPATCH'&&record.input!==hash([payload.prompt,payload.maxTokens])))throw fail('UPSTREAM_BINDING');
      if(value.resources!==null&&(op!=='QUERY'||record.state!=='TERMINAL'||
         snapshot(value.resources,identity)?.engine!==record.engine))throw fail('UPSTREAM_RESOURCES');
    }
    return {value,wire};
  }
  const status=async(binding,signal)=>(await request('QUERY',binding,null,signal)).value;
  const dispatch=async(binding,payload,signal)=>(await request('DISPATCH',binding,payload,signal)).value;
  const cancel=async(binding,signal)=>(await request('CANCEL',binding,null,signal)).value;
  async function waitTerminal(binding,external) {
    const deadline=AbortSignal.timeout(isReal(identity)?EXECUTE_MS+5000:60000);
    const signal=external?AbortSignal.any([external,deadline]):deadline;
    for(;;){
      const progress=await status(binding,signal);
      if(progress.state==='TERMINAL')return progress.event.value.outcome;
      if(progress.state==='UNKNOWN')throw fail('UPSTREAM_UNKNOWN');
      await delay(25,undefined,{signal});
    }
  }
  async function terminalEvidence(binding,signal) {
    const {value,wire}=await request('QUERY',binding,null,signal);
    return value.state==='TERMINAL'?terminalReceipt(binding,wire):null;
  }
  const client=Object.freeze({pin,dispatch,status,cancel,waitTerminal,terminalEvidence,verifiesAudit,real:isReal(identity)});
  clients.add(client);
  return client;
}

export const isUpstreamClient=value=>clients.has(value);
