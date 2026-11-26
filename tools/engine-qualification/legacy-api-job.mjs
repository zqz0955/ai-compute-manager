import {setTimeout as delay} from 'node:timers/promises';
import {fail,REAL_PROMPT,MAX_TOKENS,uuid} from '../../src/worker/r1/ollama-once.mjs';

// HTTP 等待期限含啟動時間；用既有非同步工作介面觀測同一 attempt，不重送生成。
export async function observeLegacyApiJob({request,model,clock=()=>performance.now(),pause=delay}){
  const need=(ok,code)=>{if(!ok)throw fail(code);};
  const started=clock();
  const response=await request('POST','/acm/v1/jobs',{model,input:REAL_PROMPT,max_tokens:MAX_TOKENS});
  const queued=await response.json(),id=queued.job?.id;
  need(response.status===202&&uuid(id)&&response.headers.get('x-acm-job-id')===id,'LEGACY_API_JOB_NOT_ACCEPTED');
  while(true){
    need(clock()-started<=130000,'LEGACY_API_OBSERVATION_TIMEOUT');
    const reply=await request('GET','/acm/v1/jobs/'+id),body=await reply.json(),job=body.job;
    need(reply.status===200&&job?.id===id&&job.model===model,'LEGACY_API_JOB_IDENTITY');
    if(!['QUEUED','RUNNING','STOPPING'].includes(job.state)){
      need(job.state==='SUCCEEDED'&&job.source==='ISOLATED_REAL_ENGINE'&&job.cleanup?.confirmed===true&&
        typeof job.output==='string'&&job.output.length>0&&job.usage,'LEGACY_API_JOB_NOT_RELEASED');
      return {id,output:job.output,usage:job.usage,deltaCount:0,apiContract:'ASYNC_JOB_AND_READONLY_POLL'};
    }
    await pause(1000);
  }
}
