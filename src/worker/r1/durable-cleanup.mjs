import {createHash,randomUUID} from 'node:crypto';
import {isUpstreamClient,UPSTREAM_EVIDENCE_BUDGET_MS} from './upstream-terminal.mjs';

const key=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s);
const alias=s=>typeof s==='string'&&/^(host|node):[a-z0-9_.:[\]-]{1,255}$/.test(s);
const stamp=n=>Number.isSafeInteger(n)&&n>0;
const hash=s=>createHash('sha256').update(s).digest('hex');
const error=(code,status=409)=>Object.assign(Error(code),{code,status});
const validIdentity=id=>id&&key(id.resource)&&Array.isArray(id.aliases)&&id.aliases.length>0&&
  id.aliases.length<=128&&id.aliases.every(alias);
const terminalStates=['SUCCEEDED','FAILED','CANCELLED','INTERRUPTED'];

export function createDurableCleanup(store,{terminalEvidence,authorizeRecovery,authorizeRestore,upstream}={}) {
  const trusted=isUpstreamClient(upstream);
  const real=trusted&&upstream.real===true;
  if(typeof authorizeRecovery!=='function'||(upstream!==undefined?
     !trusted||terminalEvidence!==undefined:typeof terminalEvidence!=='function'))throw error('SIMULATION_POLICY_REQUIRED',403);
  const sql=store.db, generation=randomUUID(), grants=new WeakMap(), approvals=new WeakMap();
  const log=(job,event,details={})=>sql.prepare('INSERT INTO v08_audit(job_id,event,at,data) VALUES (?,?,?,?)')
    .run(job,event,Date.now(),JSON.stringify(details));
  const get=id=>sql.prepare('SELECT * FROM v08_intents WHERE job_id=?').get(id);
  const active=()=>sql.prepare("SELECT * FROM v08_intents WHERE phase<>'RELEASED'").all();
  const readAliases=row=>{
    const parsed=JSON.parse(row.aliases);
    if(!Array.isArray(parsed)||!parsed.length||parsed.length>128||!parsed.every(alias))throw error('DURABLE_STATE_INVALID',503);
    return parsed;
  };
  const phase=(row,next,event,details={})=>{
    const changed=sql.prepare("UPDATE v08_intents SET phase=?, revision=revision+1 WHERE job_id=? AND phase=? AND revision=?")
      .run(next,row.job_id,row.phase,row.revision);
    if(changed.changes!==1)throw error('RECOVERY_CONFLICT');
    log(row.job_id,event,{attemptId:row.attempt_id,from:row.phase,to:next,...details});
  };
  function blocked(identity) {
    if(!validIdentity(identity))return '缺少新鮮的實體節點身分';
    const overlaps=(resource,aliases)=>resource===identity.resource||aliases.some(value=>identity.aliases.includes(value));
    for(const row of active())if(overlaps(row.resource,readAliases(row)))return '此實體或別名仍持有耐久派送鎖';
    for(const row of sql.prepare('SELECT resource,aliases FROM v08_legacy').all()){
      if(!row.resource||overlaps(row.resource,JSON.parse(row.aliases)))return '舊紀錄仍需獨立核對';
    }
    return null;
  }
  function migrateLegacy() {
    const known=sql.prepare('INSERT OR IGNORE INTO v08_legacy VALUES (?,?,?,?)');
    function preserve(id,record) {
      const resource=key(record.resource)?record.resource:null;
      const aliases=[record.hostKey,record.nodeId&&'node:'+record.nodeId].filter(alias);
      if(known.run(id,resource,JSON.stringify(aliases),JSON.stringify(record)).changes){
        log(id,'LEGACY_HOLD',{physicalIdentityKnown:resource!==null});
      }
    }
    for(const hold of store.holds())preserve('hold:'+hold.resource,hold);
    for(const row of sql.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.sentAt') IS NOT NULL AND json_extract(data,'$.state') IN ('RUNNING','STOPPING','INTERRUPTED')").all()){
      const job=JSON.parse(row.data);
      if(!job.dispatchAttemptId&&!get(job.id))preserve('job:'+job.id,job);
    }
  }
  // 同一 SQLite 檔與舊工作共用交易，啟動檢查完成才交給排程器。
  if(sql.prepare('PRAGMA journal_mode').get().journal_mode!=='wal'||
     sql.prepare('PRAGMA synchronous').get().synchronous!==2||
     sql.prepare('PRAGMA quick_check').all().some(row=>row.quick_check!=='ok'))throw error('DURABLE_STORAGE_UNAVAILABLE',503);
  store.transaction(()=>{
    const names=sql.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'v08_%'").all().map(row=>row.name);
    const policyExists=names.includes('v08_upstream_policy');
    if(policyExists){
      const pins=sql.prepare('SELECT pin FROM v08_upstream_policy').all();
      if(!trusted||pins.length!==1||pins[0].pin!==upstream.pin)throw error('UPSTREAM_POLICY_MISMATCH',503);
    }else if(sql.prepare("SELECT 1 FROM jobs WHERE json_extract(data,'$.upstreamPolicy') IS NOT NULL LIMIT 1").get()){
      throw error('UPSTREAM_POLICY_MISMATCH',503);
    }
    if(names.length&&['v08_schema','v08_intents','v08_audit','v08_legacy'].some(name=>!names.includes(name)))throw error('DURABLE_STATE_INVALID',503);
    if(!names.length){
      // 有既有工作引用新制，但保護表消失時，拒絕開啟空保護庫。
      if(sql.prepare("SELECT 1 FROM jobs WHERE json_extract(data,'$.dispatchAttemptId') IS NOT NULL LIMIT 1").get())throw error('DURABLE_STATE_INVALID',503);
      sql.exec(`
        CREATE TABLE v08_schema(version INTEGER NOT NULL CHECK(version=1));
        INSERT INTO v08_schema VALUES(1);
        CREATE TABLE v08_intents(
          job_id TEXT NOT NULL PRIMARY KEY REFERENCES jobs(id),
          attempt_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
          resource TEXT NOT NULL CHECK(length(resource)=64), aliases TEXT NOT NULL CHECK(json_valid(aliases)),
          target TEXT NOT NULL CHECK(length(target)=64), intent_at INTEGER NOT NULL,
          phase TEXT NOT NULL CHECK(phase IN ('INTENT','HOLD','RELEASED')),
          revision INTEGER NOT NULL CHECK(revision>=0)
        );
        CREATE UNIQUE INDEX v08_active_physical ON v08_intents(resource) WHERE phase<>'RELEASED';
        CREATE TABLE v08_audit(seq INTEGER PRIMARY KEY,job_id TEXT NOT NULL,event TEXT NOT NULL,at INTEGER NOT NULL,
          data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX v08_audit_job ON v08_audit(job_id);
        CREATE TABLE v08_legacy(id TEXT PRIMARY KEY,resource TEXT,aliases TEXT NOT NULL CHECK(json_valid(aliases)),
          data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE TRIGGER v08_intents_no_delete BEFORE DELETE ON v08_intents BEGIN SELECT RAISE(ABORT,'retain intent'); END;
        CREATE TRIGGER v08_identity_fixed BEFORE UPDATE OF job_id,attempt_id,owner,resource,aliases,target,intent_at ON v08_intents
          BEGIN SELECT RAISE(ABORT,'fixed intent'); END;
        CREATE TRIGGER v08_legacy_no_delete BEFORE DELETE ON v08_legacy BEGIN SELECT RAISE(ABORT,'retain legacy'); END;
        CREATE TRIGGER v08_legacy_no_update BEFORE UPDATE ON v08_legacy BEGIN SELECT RAISE(ABORT,'fixed legacy'); END;
        CREATE TRIGGER v08_audit_no_delete BEFORE DELETE ON v08_audit BEGIN SELECT RAISE(ABORT,'retain audit'); END;
        CREATE TRIGGER v08_audit_no_update BEFORE UPDATE ON v08_audit BEGIN SELECT RAISE(ABORT,'retain audit'); END;
      `);
    }
    const schemaNames=new Set(sql.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'v08_%'").all().map(row=>row.name));
    for(const name of ['v08_active_physical','v08_intents_no_delete','v08_identity_fixed','v08_legacy_no_delete',
      'v08_legacy_no_update','v08_audit_no_delete','v08_audit_no_update']){
      if(!schemaNames.has(name))throw error('DURABLE_STATE_INVALID',503);
    }
    for(const historical of sql.prepare("SELECT id,resource,aliases FROM v08_legacy").all()){
      if((historical.resource!==null&&!key(historical.resource))||!JSON.parse(historical.aliases).every(alias)||
        !sql.prepare("SELECT 1 FROM v08_audit WHERE job_id=? AND event='LEGACY_HOLD'").get(historical.id))
        throw error('DURABLE_STATE_INVALID',503);
    }
    if(sql.prepare("SELECT 1 FROM v08_audit LEFT JOIN v08_legacy ON id=job_id WHERE event='LEGACY_HOLD' AND id IS NULL").get())
      throw error('DURABLE_STATE_INVALID',503);
    const versions=sql.prepare('SELECT version FROM v08_schema').all();
    if(versions.length!==1||versions[0].version!==1||sql.prepare('PRAGMA foreign_key_check(v08_intents)').all().length)throw error('DURABLE_STATE_INVALID',503);
    if(trusted&&!policyExists){
      if(sql.prepare('SELECT 1 FROM v08_intents LIMIT 1').get())throw error('UPSTREAM_POLICY_MISMATCH',503);
      sql.exec('CREATE TABLE v08_upstream_policy(pin TEXT NOT NULL)');
      sql.prepare('INSERT INTO v08_upstream_policy VALUES (?)').run(upstream.pin);
    }
    for(const row of sql.prepare('SELECT * FROM v08_intents').all()){
      const t=store.get(row.job_id);
      const events=sql.prepare('SELECT event,data FROM v08_audit WHERE job_id=? ORDER BY seq').all(row.job_id);
      const last=events.at(-1);
      if(!t||!key(row.resource)||!key(row.target)||!uuid(row.owner)||!uuid(row.attempt_id)||!stamp(row.intent_at)||
         t.dispatchAttemptId!==row.attempt_id||t.sentAt!==row.intent_at||t.resource!==row.resource||
         events[0]?.event!=='INTENT'||events.length!==row.revision+1||JSON.parse(last.data).to!==row.phase||
         JSON.parse(last.data).attemptId!==row.attempt_id)throw error('DURABLE_STATE_INVALID',503);
      readAliases(row);
      if((trusted&&(t.upstreamPolicy!==upstream.pin||JSON.parse(events[0].data).upstreamPolicy!==upstream.pin||
           (row.phase==='RELEASED'&&!upstream.verifiesAudit(proofRequest(row),JSON.parse(last.data).evidence))))||
         (!trusted&&t.upstreamPolicy))throw error('UPSTREAM_POLICY_MISMATCH',503);
      if(real&&row.phase==='RELEASED'&&(last.event!=='HOST_RESTORED_RELEASE'||t.state!=='SUCCEEDED'||
         t.cleanup?.confirmed!==true||!key(JSON.parse(last.data).restoreSha256)))
        throw error('RESTORED_RELEASE_INCONSISTENT',503);
      if(real&&row.phase!=='RELEASED'&&t.cleanup?.confirmed===true)throw error('RESTORED_RELEASE_INCONSISTENT',503);
      if(row.phase==='INTENT')phase(row,'HOLD','CRASH_HOLD');
    }
    migrateLegacy();
    for(const t of store.active()){
      if(t.dispatchAttemptId&&!get(t.id))throw error('DURABLE_STATE_INVALID',503);
      // 連尚未送出的舊佇列都不跨程序重播。
      store.save({...t,state:'INTERRUPTED',finishedAt:Date.now(),
        reason:'前一控制程序已退出，工作未重送',
        ...(t.dispatchAttemptId?{cleanup:{confirmed:false,reason:'RESIDENT_UNKNOWN'}}:{})});
    }
    for(const row of sql.prepare("SELECT id,data FROM jobs WHERE json_extract(data,'$.dispatchAttemptId') IS NOT NULL").all()){
      if(get(row.id)?.attempt_id!==JSON.parse(row.data).dispatchAttemptId)throw error('DURABLE_STATE_INVALID',503);
    }
  });

  function grant(task) {
    if(upstream?.verificationOnly)throw error('RESTORE_VERIFIER_CANNOT_DISPATCH',403);
    const admission={};
    grants.set(admission,task);
    return admission;
  }
  function verifyGrant(admission,task) {
    if(grants.get(admission)!==task||!task)throw error('INFERENCE_DISABLED',403);
  }
  function reserve(admission,task,identity) {
    verifyGrant(admission,task);
    grants.delete(admission);
    if(!validIdentity(identity))throw error('IDENTITY_UNVERIFIED');
    return store.transaction(()=>{
      const current=store.get(task.id);
      if(!current||current.state!=='RUNNING'||current.sentAt||get(task.id)||
         current.expectedResource!==identity.resource||!uuid(current.requestId))throw error('DISPATCH_REFUSED');
      if(blocked(identity))throw error('RESOURCE_HELD');
      const attemptId=randomUUID(),intentAt=Date.now();
      sql.prepare('INSERT INTO v08_intents VALUES (?,?,?,?,?,?,?,?,?)').run(task.id,attemptId,generation,
        identity.resource,JSON.stringify([...new Set(identity.aliases)].sort()),hash(current.targetKey),intentAt,'INTENT',0);
      const binding=trusted?{upstreamPolicy:upstream.pin}:{};
      store.save({...current,sentAt:intentAt,dispatchAttemptId:attemptId,reason:'已提交派送意圖',...binding});
      log(task.id,'INTENT',{attemptId,to:'INTENT',requestId:current.requestId,...binding});
      return {sentAt:intentAt,dispatchAttemptId:attemptId,terminalBinding:proofRequest(get(task.id)),...binding};
    });
  }
  function proofRequest(row) {
    const modelBinding=trusted?store.get(row.job_id):null;
    return Object.freeze({jobId:row.job_id,attemptId:row.attempt_id,resource:row.resource,
      owner:row.owner,target:row.target,intentAt:row.intent_at,
      ...(modelBinding?{model:modelBinding.model,digest:modelBinding.digest}:{})});
  }
  function validated(row,observation) {
    const request=proofRequest(row),now=Date.now();
    if(!observation||Object.entries(request).some(([k,v])=>observation[k]!==v)||
       observation.source!=='ISOLATED_OLLAMA'||observation.terminal!==true||observation.healthy!==true||
       observation.active!==0||observation.resident!==0||!stamp(observation.terminalAt)||!stamp(observation.observedAt)||
       observation.terminalAt<row.intent_at||observation.terminalAt>observation.observedAt||
       observation.observedAt>now||now-observation.observedAt>15000)return null;
    return {terminalAt:observation.terminalAt,observedAt:observation.observedAt,healthy:true,active:0,resident:0,source:'ISOLATED_OLLAMA'};
  }
  async function verifiedRemote(row,signal) {
    const start=performance.now();
    const evidence=await upstream.terminalEvidence(proofRequest(row),signal);
    if(!evidence||!upstream.verifiesAudit(proofRequest(row),evidence))return null;
    return {evidence,start,observedAt:Date.now()};
  }
  function completion(jobId,cleanup,uncertain=false,signal) {
    const row=get(jobId);
    if(!row||row.phase!=='INTENT'||row.owner!==generation||uncertain)return null;
    if(trusted)return verifiedRemote(row,signal).then(observation=>{
      if(!observation)return null;
      approvals.set(observation.evidence,{attempt:row.attempt_id,start:observation.start,observedAt:observation.observedAt});
      return observation.evidence;
    }).catch(()=>null);
    if(cleanup?.confirmed!==true||cleanup.healthy!==true||cleanup.modelsAfter!==0)return null;
    try {
      const evidence=validated(row,terminalEvidence(proofRequest(row)));
      if(evidence)approvals.set(evidence,{attempt:row.attempt_id});
      return evidence;
    } catch {return null;}
  }
  function settle(jobId,state,approved) {
    if(!sql.isTransaction||!terminalStates.includes(state))throw error('ATOMIC_FINALIZATION_REQUIRED',503);
    const row=get(jobId);
    if(!row||row.phase!=='INTENT'||row.owner!==generation)throw error('DISPATCH_REFUSED');
    if(approved){
      if(real)throw error('HOST_RESTORE_REQUIRED');
      const authorization=approvals.get(approved);
      if(authorization?.attempt!==row.attempt_id||
         (trusted&&performance.now()-authorization.start>UPSTREAM_EVIDENCE_BUDGET_MS))throw error('RECOVERY_EVIDENCE_REQUIRED');
      approvals.delete(approved);
      phase(row,'RELEASED','RELEASE',{state,evidence:approved});
    } else phase(row,'HOLD','EVIDENCE_HOLD',{state});
  }
  function deferRestoredRelease(jobId,approved){
    if(!real||!sql.isTransaction)throw error('ATOMIC_FINALIZATION_REQUIRED',503);
    const row=get(jobId);
    const permission=approvals.get(approved);
    if(!row||row.owner!==generation||row.phase!=='INTENT'||permission?.attempt!==row.attempt_id||
       performance.now()-permission.start>UPSTREAM_EVIDENCE_BUDGET_MS)throw error('RECOVERY_EVIDENCE_REQUIRED');
    approvals.delete(approved);
    phase(row,'HOLD','HOST_RESTORE_PENDING',{observedAt:permission.observedAt,evidence:approved});
  }
  function releaseRestored(jobId,permit){
    if(!real||!upstream.verificationOnly||typeof authorizeRestore!=='function')throw error('HOST_RESTORE_REQUIRED',403);
    return store.transaction(()=>{
      const row=get(jobId);
      if(!row||row.phase!=='HOLD')throw error('RECOVERY_REFUSED');
      const last=sql.prepare('SELECT event,data FROM v08_audit WHERE job_id=? ORDER BY seq DESC LIMIT 1').get(jobId);
      const pending=JSON.parse(last.data);
      const binding=proofRequest(row);
      if(last.event!=='HOST_RESTORE_PENDING'||pending.attemptId!==row.attempt_id||
         !upstream.verifiesAudit(binding,pending.evidence)||authorizeRestore(permit,binding,pending)!==true)
        throw error('HOST_RESTORE_EVIDENCE_REQUIRED');
      store.save({...store.get(jobId),state:'SUCCEEDED',finishedAt:Date.now(),cleanup:{confirmed:true}});
      phase(row,'RELEASED','HOST_RESTORED_RELEASE',{state:'SUCCEEDED',evidence:pending.evidence,
        restoreSha256:hash(JSON.stringify(permit))});
      return {jobId,phase:'RELEASED',evidence:pending.evidence};
    });
  }
  async function recover(jobId,readIdentity,authorization) {
    if(real)throw error('HOST_RESTORE_REQUIRED',403);
    const actor=authorizeRecovery(authorization);
    if(typeof actor!=='string'||!/^[a-z0-9_-]{1,64}$/.test(actor))throw error('RECOVERY_DENIED',403);
    const row=get(jobId), initial=readIdentity();
    if(!row||row.phase!=='HOLD'||!validIdentity(initial)||initial.resource!==row.resource)throw error('RECOVERY_REFUSED');
    let observed;
    try {observed=trusted?await verifiedRemote(row):await terminalEvidence(proofRequest(row));}
    catch {throw error('RECOVERY_EVIDENCE_REQUIRED');}
    return store.transaction(()=>{
      const current=get(jobId),identity=readIdentity();
      if(!current||current.phase!=='HOLD'||current.revision!==row.revision||current.attempt_id!==row.attempt_id||
         !validIdentity(identity)||identity.resource!==row.resource||identity.binding!==initial.binding)throw error('RECOVERY_CONFLICT');
      const evidence=trusted?(observed&&performance.now()-observed.start<=UPSTREAM_EVIDENCE_BUDGET_MS?observed.evidence:null):
        validated(current,observed);
      if(!evidence)throw error('RECOVERY_EVIDENCE_REQUIRED');
      phase(current,'RELEASED','RECOVERY_RELEASE',{actor,evidence});
      return {jobId,phase:'RELEASED'};
    });
  }
  return {grant,verifyGrant,reserve,completion,settle,deferRestoredRelease,releaseRestored,blocked,recover,trusted};
}

