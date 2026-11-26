import {randomUUID} from 'node:crypto';
import {createDurableCleanup} from './durable-cleanup.mjs';
import {REAL_PROMPT,MAX_TOKENS,fail} from './ollama-once.mjs';

export function requireDispatchWindow(approval,now=Date.now()){
  if(!Number.isSafeInteger(approval?.notBefore)||!Number.isSafeInteger(approval?.expires)||
     now<approval.notBefore*1000||approval.expires*1000-now<300000)
    throw fail('DISPATCH_WINDOW_REMAINING');
}

export async function runDurableOnce({store,upstream,identity,approval:window,signal}){
  const durable=createDurableCleanup(store,{upstream,authorizeRecovery:()=>null});
  if(store.db.prepare('SELECT 1 FROM v08_intents LIMIT 1').get())throw fail('REAL_RUN_ALREADY_CONSUMED');
  signal?.throwIfAborted();
  requireDispatchWindow(window);
  const task={id:randomUUID(),requestId:randomUUID(),state:'RUNNING',resource:identity.resource,
    expectedResource:identity.resource,model:identity.model,digest:identity.digest,
    targetKey:'acm-real-ollama:'+identity.release,createdAt:Date.now()};
  store.insert(task);
  const {terminalBinding:binding}=durable.reserve(durable.grant(task),task,identity);
  let approval=null,reason='TERMINAL_EVIDENCE_MISSING';
  try{
    const payload={prompt:REAL_PROMPT,maxTokens:MAX_TOKENS};
    requireDispatchWindow(window);
    const accepted=await upstream.dispatch(binding,payload,signal);
    if(accepted.state!=='ACCEPTED')throw fail('REAL_ACCEPTANCE_UNKNOWN');
    if(await upstream.waitTerminal(binding,signal)!=='SUCCEEDED')throw fail('REAL_TERMINAL_UNKNOWN');
    approval=await durable.completion(task.id,null,false,signal);
    signal?.throwIfAborted();
  }catch(error){
    approval=null;
    if(/^[A-Z_]{1,64}$/.test(String(error?.code)))reason=error.code;
    else if(signal?.aborted)reason='CONTROLLER_CANCELLED';
  }
  const finalize=value=>store.transaction(()=>{
    const state='INTERRUPTED';
    const current=store.get(task.id);
    store.save({...current,state,finishedAt:Date.now(),cleanup:{confirmed:false}});
    if(value)durable.deferRestoredRelease(task.id,value);
    else durable.settle(task.id,state,null);
  });
  try{finalize(approval);}
  catch(error){
    if(!approval||error.code!=='RECOVERY_EVIDENCE_REQUIRED')throw error;
    approval=null;
    finalize(null);
  }
  return {binding,phase:'HOLD',stage:approval?'HOST_RESTORE_PENDING':'EVIDENCE_HOLD',
    ...(approval?{evidence:approval}:{reason})};
}
