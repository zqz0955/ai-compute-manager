import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {openController} from '../src/controller.mjs';
import {createHttpApp} from '../src/http-app.mjs';
import {createWorkspaceFixture} from '../tools/fixtures/workspace-fixture.mjs';

function credential(id,scopes){
  const secret=randomBytes(32).toString('base64url');
  return {secret,row:{id,sha256:createHash('sha256').update(secret).digest('hex'),
    scopes,expiresAt:Date.now()+60000}};
}

async function fixture(t,mode='simulation',{simulation,waitMs,now}={}){
  const reader=credential('reader',['manage:read']);
  const runner=credential('runner',['models:run']);
  const second=credential('other',['models:run']);
  const expired=credential('expired',['models:run']);
  expired.row.expiresAt=Date.now()-1000;
  const jobs=new Map();
  const model={id:'fixture:demo',digest:'a'.repeat(64),context:512,maxTokens:64,device:'cpu'};
  const rows=[];
  let safe=true;
  const work=simulation && await createWorkspaceFixture('jcm-sse-', ['controller.sqlite','controller.sqlite-wal','controller.sqlite-shm']);
  const controller=work?openController({dataDir:work.root,mode,simulation}):{
    nodes:()=>[],models:()=>mode==='simulation'?[model]:[],
    snapshot:()=>({nodes:[],jobs:[...jobs.values()],locks:[],events:[]}),
    submit(request){
      assert.equal(mode,'simulation');
      const job={...request,id:randomUUID(),state:'QUEUED',createdAt:Date.now()};
      jobs.set(job.id,job);
      return job;
    },
    get:id=>jobs.get(id),
    wait(id){
      const final={...jobs.get(id),state:'SUCCEEDED',output:'Synthetic completion',
        cleanup:{confirmed:true},usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}};
      jobs.set(id,final);
      return final;
    },
    cancel(id){
      const result={...jobs.get(id),state:'CANCELLED'};
      jobs.set(id,result);
      return result;
    }
  };
  const server=createHttpApp({controller,mode,tokens:[reader.row,runner.row,second.row,expired.row],
    verifyRegistry:()=>safe,telemetry:{history:()=>[]},audit:record=>rows.push(record),waitMs,now});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    if (work){await controller.close();await work.clean();}
  });
  const base='http://127.0.0.1:'+server.address().port;
  const call=(path,cred,{body,method=body===undefined?'GET':'POST',headers={}}={})=>fetch(base+path,{
    method,headers:{...(cred?{authorization:'Bearer '+cred.secret}:{}),
      ...(body===undefined?{}:{'content-type':'application/json'}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  return {reader,runner,second,expired,controller,jobs,call,base,rows,drift:()=>{safe=false;}};
}

test('分權、過期憑證及瀏覽器來源錯誤都在派送前拒絕',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/v1/models')).status,401);
  assert.equal((await f.call('/v1/models',f.reader)).status,403);
  assert.equal((await f.call('/v1/models',f.expired)).status,401);
  assert.equal((await f.call('/acm/v1/dashboard',f.runner)).status,403);
  assert.equal((await f.call('/v1/models',f.runner,{headers:{origin:'http://foreign.invalid'}})).status,403);
  const response=await f.call('/v1/models',f.runner);
  assert.deepEqual((await response.json()).data.map(x=>x.id),['fixture:demo']);
  assert.equal(f.jobs.size,0);
});

test('read-only 不以合法 Token 或請求參數打開推論',async t=>{
  const f=await fixture(t,'read-only');
  assert.deepEqual((await (await f.call('/v1/models',f.runner)).json()).data,[]);
  const response=await f.call('/v1/chat/completions',f.runner,{body:{
    model:'fixture:demo',messages:[{role:'user',content:'hello'}],max_tokens:4}});
  assert.equal(response.status,403);
  assert.equal((await response.json()).error.code,'INFERENCE_DISABLED');
  assert.equal(f.jobs.size,0);
});

test('Chat JSON、Completion SSE、查詢與取消使用同一個工作介面',async t=>{
  const f=await fixture(t);
  const chat=await f.call('/v1/chat/completions',f.runner,{body:{
    model:'fixture:demo',messages:[{role:'user',content:'hello'}],max_completion_tokens:4}});
  const output=await chat.json();
  assert.equal(chat.status,200);
  assert.equal(output.object,'chat.completion');
  assert.equal(output.choices[0].message.content,'Synthetic completion');
  assert.equal(output.usage.total_tokens,5);
  const id=chat.headers.get('x-acm-job-id');
  assert.equal(f.jobs.get(id).kind,'chat');
  assert.equal((await f.call('/acm/v1/jobs/'+id,f.second)).status,404);
  const projected=await (await f.call('/acm/v1/jobs/'+id,f.reader)).json();
  assert.equal(Object.hasOwn(projected.job,'output'),false);
  assert.equal(Object.hasOwn(projected.job,'input'),false);
  const mine=await (await f.call('/acm/v1/jobs/'+id,f.runner)).json();
  assert.equal(mine.job.output,'Synthetic completion');
  const sse=await f.call('/v1/completions',f.runner,{body:{model:'fixture:demo',prompt:'hello',stream:true,max_tokens:4}});
  assert.match(sse.headers.get('content-type'),/^text\/event-stream/);
  const events=await sse.text();
  assert.match(events,/"text":"Synthetic completion"/);
  assert.match(events,/data: \[DONE\]/);
  const queued=await f.call('/acm/v1/jobs',f.runner,{body:{model:'fixture:demo',input:'hello',max_tokens:4,priority:2}});
  assert.equal(queued.status,202);
  const {job}=await queued.json();
  assert.equal(job.canCancel,true);
  const cancelled=await f.call('/acm/v1/jobs/'+job.id+'/cancel',f.runner,{method:'POST'});
  assert.equal((await cancelled.json()).job.state,'CANCELLED');
});

test('不支援的輸入、超界內容與登錄來源漂移不觸發工作',async t=>{
  const f=await fixture(t);
  const path='/v1/completions';
  assert.equal((await f.call(path,f.runner,{body:{model:'fixture:demo',prompt:'a',tools:[]}})).status,400);
  assert.equal((await f.call(path,f.runner,{body:{model:'missing-model',prompt:'a'}})).status,404);
  assert.equal((await f.call(path,f.runner,{body:{model:'fixture:demo',prompt:'a'.repeat(65537)}})).status,413);
  assert.equal((await f.call(path,f.runner,{body:{model:'fixture:demo',prompt:'a'.repeat(520),max_tokens:4}})).status,400);
  f.drift();
  assert.equal((await f.call('/v1/models',f.runner)).status,503);
  assert.equal(f.jobs.size,0);
  assert.ok(f.rows.every(row=>!JSON.stringify(row).includes(f.runner.secret)));
});

test('SSE 先送工作中的暫定內容，只有持久化終態才能送出用量及完成',async t=>{
  const sampling=Promise.withResolvers(),release=Promise.withResolvers();
  const f=await fixture(t,'simulation',{simulation:{sample:async()=>{sampling.resolve();await release.promise;return {};}}});
  try {
    const body={model:'fixture:demo',messages:[{role:'user',content:'alpha bravo charlie'}],max_tokens:32,
      stream:true,stream_options:{include_usage:true}};
    const call=()=>f.call('/v1/chat/completions',f.runner,{body,headers:{'Idempotency-Key':'stream-test'}});
    const pending=call();
    await sampling.promise;
    const response=await Promise.race([pending,delay(400,undefined,{ref:false}).then(()=>assert.fail('簽章證據提交前沒有串流回應'))]);
    const id=response.headers.get('x-acm-job-id');
    const reader=response.body.getReader();
    const decoder=new TextDecoder();
    const first=decoder.decode((await reader.read()).value,{stream:true});
    assert.match(first,/"acm_provisional":true/);
    assert.doesNotMatch(first,/\[DONE\]|"completion_tokens"/);
    assert.equal(f.controller.get(id).cleanup.confirmed,false);
    const retry=await call();
    assert.equal(retry.headers.get('x-acm-job-id'),id);
    release.resolve();
    let stream=first;
    for(let next=await reader.read();!next.done;next=await reader.read()) stream+=decoder.decode(next.value,{stream:true});
    stream+=decoder.decode();
    const final=f.controller.get(id);
    assert.equal(final.cleanup.confirmed,true);
    assertStreaming(stream,final.output);
    assertStreaming(await retry.text(),final.output);
    assert.equal(f.controller.snapshot().jobs.length,1);
  } finally {release.resolve();}
});

function assertStreaming(body,expected){
  const events=body.split('\n\n').filter(Boolean).map(row=>row.slice(6));
  assert.equal(events.pop(),'[DONE]');
  const frames=events.map(row=>JSON.parse(row));
  const contents=frames.flatMap(row=>row.choices).map(choice=>choice.delta.content).filter(Boolean);
  assert.equal(contents.join(''),expected);
  assert.equal(frames.filter(row=>row.choices.some(choice=>choice.finish_reason!==null)).length,1);
  assert.ok(frames.at(-1).usage.completion_tokens>0);
}

test('串流清場未確認及驗證期限結束時不送完成或用量',async t=>{
  await t.test('未清場保留 HOLD',async t=>{
    const f=await fixture(t,'simulation',{simulation:{sample:()=>({resident:1})}});
    const response=await f.call('/v1/completions',f.runner,{body:{model:'fixture:demo',prompt:'fixture words',
      stream:true,stream_options:{include_usage:true}}});
    const body=await response.text();
    assert.match(body,/"acm_provisional":true/);
    assert.match(body,/"code":"JOB_INTERRUPTED"/);
    assert.doesNotMatch(body,/\[DONE\]|"completion_tokens"|"finish_reason":"stop"/);
    assert.equal(f.controller.snapshot().locks[0].phase,'HOLD');
  });
  await t.test('已開串流的憑證失效',async t=>{
    const release=Promise.withResolvers();
    let clock=Date.now();
    const f=await fixture(t,'simulation',{simulation:{sample:async()=>{await release.promise;return {};}},now:()=>clock});
    try {
      const response=await f.call('/v1/completions',f.runner,{body:{model:'fixture:demo',prompt:'fixture words',
        stream:true,stream_options:{include_usage:true}}});
      clock=f.runner.row.expiresAt;
      release.resolve();
      const body=await response.text();
      assert.match(body,/"code":"UNAUTHENTICATED"/);
      assert.doesNotMatch(body,/\[DONE\]|"completion_tokens"|"finish_reason":"stop"/);
    } finally {release.resolve();}
  });
});

test('HTTP 等待逾時保留原工作，取回已提交結果時沿用工作 ID',async t=>{
  const release=Promise.withResolvers();
  const f=await fixture(t,'simulation',{simulation:{delayMs:0,sample:async()=>{await release.promise;return {};}},waitMs:250});
  try {
    const request={body:{model:'fixture:demo',prompt:'fixture words',stream:true},
      headers:{'idempotency-key':'wait-timeout'}};
    const response=await f.call('/v1/completions',f.runner,request);
    const id=response.headers.get('x-acm-job-id');
    const pending=await response.text();
    assert.match(pending,/"code":"READ_TIMEOUT"/);
    assert.doesNotMatch(pending,/\[DONE\]/);
    assert.equal(f.controller.get(id).state,'RUNNING');
    release.resolve();
    assert.equal((await f.controller.wait(id)).cleanup.confirmed,true);
    const restored=await f.call('/v1/completions',f.runner,request);
    assert.equal(restored.headers.get('x-acm-job-id'),id);
    assert.match(await restored.text(),/\[DONE\]/);
    assert.equal(f.controller.snapshot().jobs.length,1);
  } finally {release.resolve();}
});

test('工作擁有者可取消進行中的 SSE，取消回應不加入成功完成訊號',async t=>{
  const f=await fixture(t,'simulation',{simulation:{delayMs:2200}});
  const response=await f.call('/v1/completions',f.runner,{body:{model:'fixture:demo',
    prompt:'one two three four five six seven eight',stream:true}});
  const id=response.headers.get('x-acm-job-id');
  assert.equal((await f.call('/acm/v1/jobs/'+id+'/cancel',f.second,{method:'POST'})).status,404);
  assert.equal((await f.call('/acm/v1/jobs/'+id+'/cancel',f.runner,{method:'POST'})).status,200);
  const stream=await response.text();
  assert.match(stream,/"acm_provisional":true/);
  assert.match(stream,/"code":"JOB_CANCELLED"/);
  assert.doesNotMatch(stream,/\[DONE\]/);
  const job=f.controller.get(id);
  assert.equal(job.state,'CANCELLED');
  assert.equal(job.cleanup.confirmed,true);
  assert.equal(f.controller.snapshot().locks.length,0);
});

test('使用既有官方 Python OpenAI SDK 實際呼叫本機端點', {skip:process.env.ACM_RC2_SDK!=='1'},async t=>{
  const f=await fixture(t,'simulation',{simulation:{delayMs:100}});
  const client=spawn('python',['-I','-B',fileURLToPath(new URL('./openai-client-check.py',import.meta.url))],{
    windowsHide:true,stdio:['pipe','pipe','pipe'],signal:AbortSignal.timeout(20000),
  });
  const stdout=[],stderr=[];
  client.stdout.on('data',chunk=>stdout.push(chunk));
  client.stderr.on('data',chunk=>stderr.push(chunk));
  const completion=new Promise((resolve,reject)=>{client.once('error',reject);client.once('close',resolve);});
  client.stdin.end(JSON.stringify({base:f.base,reader:f.reader.secret,runner:f.runner.secret}));
  assert.equal(await completion,0,Buffer.concat(stderr).toString());
  const receipt=JSON.parse(Buffer.concat(stdout).toString());
  assert.deepEqual(receipt.cases,['models','json','chat-sse','completion-sse','scope']);
  assert.equal(f.controller.snapshot().jobs.length,3);
  t.diagnostic(JSON.stringify(receipt));
});
