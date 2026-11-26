import {randomUUID} from 'node:crypto';
import {fail} from './api-error.mjs';

export const bodyLimit=65536;
const activeStates=new Set(['QUEUED','RUNNING','STOPPING']);
const roles=new Set(['system','user','assistant']);
const requestIdPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

export function hasKeys(value,keys) {
  return value!==null && typeof value==='object' && !Array.isArray(value) &&
    Object.keys(value).every(key=>keys.includes(key));
}
const nonempty=value=>typeof value==='string' && value.isWellFormed() && value.trim().length>0;

export async function readJson(req) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw fail('CONTENT_TYPE');
  const length=req.headers['content-length'];
  if (!/^[1-9][0-9]{0,5}$/.test(length ?? '')) throw fail(length==='0'||!length?'BAD_REQUEST':'BODY_LIMIT');
  if (Number(length)>bodyLimit) throw fail('BODY_LIMIT');
  const chunks=[];
  let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if (size>bodyLimit) throw fail('BODY_LIMIT');
    chunks.push(chunk);
  }
  if (size!==Number(length)) throw fail('BAD_REQUEST');
  try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
  catch {throw fail('BAD_REQUEST');}
}

export function requestFor(body,kind,models,client,requestId=randomUUID()) {
  if (!requestIdPattern.test(requestId)) throw fail('BAD_REQUEST');
  const common=['model','max_tokens'];
  const extras=kind==='job'?['input','priority']:
    ['stream','stream_options',...(kind==='chat'?['messages','max_completion_tokens']:['prompt'])];
  if (!hasKeys(body,[...common,...extras]) || !nonempty(body.model)) throw fail('BAD_REQUEST');
  if ('stream' in body && typeof body.stream!=='boolean') throw fail('BAD_REQUEST');
  if ('stream_options' in body && (body.stream!==true ||
      !hasKeys(body.stream_options,['include_usage']) ||
      typeof body.stream_options.include_usage!=='boolean')) throw fail('BAD_REQUEST');
  if ('max_tokens' in body && 'max_completion_tokens' in body) throw fail('BAD_REQUEST');
  const model=models.find(row=>row.id===body.model);
  if (!model) throw fail('MODEL_UNAVAILABLE');
  const maxTokens='max_tokens' in body?body.max_tokens:
    'max_completion_tokens' in body?body.max_completion_tokens:Math.min(model.maxTokens,16);
  if (!Number.isInteger(maxTokens) || maxTokens<1 || maxTokens>model.maxTokens) throw fail('BAD_REQUEST');
  const priority='priority' in body?body.priority:0;
  if (!Number.isInteger(priority) || priority<-10 || priority>10) throw fail('BAD_REQUEST');

  let input, context;
  if (kind==='chat') {
    if (!Array.isArray(body.messages) || body.messages.length<1 || body.messages.length>32 ||
        body.messages.some(row=>!hasKeys(row,['role','content']) || !roles.has(row.role) || !nonempty(row.content)) ||
        body.messages.at(-1).role!=='user') throw fail('BAD_REQUEST');
    input=JSON.stringify(body.messages.map(({role,content})=>({role,content})));
    context=Buffer.byteLength(input)+8;
  } else {
    input=kind==='job'?body.input:body.prompt;
    if (!nonempty(input)) throw fail('BAD_REQUEST');
    context=Buffer.byteLength(input)+8;
  }
  // 真實模型的分詞與提示模板上限須由合格的引擎另外證明。
  if (context+maxTokens>model.context) throw fail('CONTEXT_LIMIT');
  return {clientId:client.id,requestId,model:model.id,kind:kind==='chat'?'chat':'completion',
    input,maxTokens,priority};
}

export function jobView(row,includeOutput=false) {
  const {id,model,kind,state,nodeId,createdAt,startedAt,finishedAt,attemptId,durationMs,decision,usage,cleanup,error}=row;
  return {id,model,kind,state,source:row.source??'SIMULATION',nodeId:nodeId??null,createdAt,startedAt:startedAt??null,
    finishedAt:finishedAt??null,attemptId:attemptId??null,durationMs:durationMs??null,
    decision:decision?{code:enumCode(decision.code),device:decision.device,priority:decision.priority}:null,
    usage:usage?{prompt_tokens:usage.prompt_tokens,completion_tokens:usage.completion_tokens,
      total_tokens:usage.total_tokens}:null,
    cleanup:cleanup?{confirmed:cleanup.confirmed===true,reason:enumCode(cleanup.reason)}:null,
    error:error?{code:enumCode(error.code)??'JOB_FAILED'}:null,
    canCancel:includeOutput && activeStates.has(state),
    ...(includeOutput&&state==='SUCCEEDED'&&cleanup?.confirmed===true?{output:row.output}:{})};
}

function enumCode(value) {
  return typeof value==='string' && /^[A-Z0-9_]{1,64}$/.test(value)?value:null;
}

function completion(job,kind){
  const chat=kind==='chat';
  return {id:(chat?'chatcmpl-':'cmpl-')+job.id,object:chat?'chat.completion':'text_completion',
    created:Math.floor(job.createdAt/1000),model:job.model,
    choices:[{index:0,...(chat?{message:{role:'assistant',content:job.output}}:{text:job.output}),
      finish_reason:job.finishReason==='length'?'length':'stop'}],usage:job.usage,acm_source:job.source??'SIMULATION'};
}

export function complete(job,kind){
  if (job?.state==='CANCELLED') throw fail('JOB_CANCELLED');
  if (job?.state==='INTERRUPTED') throw fail('JOB_INTERRUPTED');
  if (job?.error?.code==='TIMEOUT') throw fail('READ_TIMEOUT');
  if (job?.state!=='SUCCEEDED'||job.cleanup?.confirmed!==true||typeof job.output!=='string') throw fail('JOB_FAILED');
  return completion(job,kind);
}

export function createCompletionStream(res,job,kind,includeUsage=false){
  const chat=kind==='chat';
  const base={id:(chat?'chatcmpl-':'cmpl-')+job.id,object:chat?'chat.completion.chunk':'text_completion',
    created:Math.floor(job.createdAt/1000),model:job.model,acm_source:job.source??'SIMULATION'};
  let bytes=0,preview='';
  function write(data){
    const frame='data: '+data+'\n\n';
    const size=Buffer.byteLength(frame);
    if (bytes+size>262144 || res.writableLength+size>262144) throw fail('RESPONSE_LIMIT');
    if (!res.headersSent) res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8'});
    bytes+=size;
    res.write(frame);
  }
  const frame=record=>write(JSON.stringify(record));
  const choice=(value,provisional)=>frame({...base,choices:[{index:0,...value}],
    ...(includeUsage?{usage:null}:{}),...(provisional?{acm_provisional:true}:{})});
  function content(fragment,provisional){
    if (!fragment) return;
    choice({...(chat?{delta:{content:fragment}}:{text:fragment}),finish_reason:null},provisional);
    preview+=fragment;
  }
  function role(provisional){
    if (chat&&!res.headersSent) choice({delta:{role:'assistant'},finish_reason:null},provisional);
  }
  return {
    delta(fragment){
      role(true);
      content(fragment,true);
    },
    finish(result){
      const response=complete(result,kind);
      // 暫定內容一旦送出，只有完整結果相符且終態已提交才能送出完成訊號。
      if (!result.output.startsWith(preview)) throw fail('STREAM_MISMATCH');
      role(false);
      content(result.output.slice(preview.length),false);
      choice({...(chat?{delta:{}}:{text:''}),finish_reason:response.choices[0].finish_reason},false);
      if (includeUsage) frame({...base,choices:[],usage:response.usage});
      write('[DONE]');
      res.end();
    },
    error(fault,requestId){
      try {frame({error:{code:fault.code,message:fault.message},requestId});res.end();}
      catch {res.destroy();}
    }
  };
}
