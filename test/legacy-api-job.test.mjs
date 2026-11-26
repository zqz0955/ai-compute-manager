import assert from 'node:assert/strict';
import {test} from 'node:test';
import {observeLegacyApiJob} from '../tools/engine-qualification/legacy-api-job.mjs';

const id='12345678-1234-4234-8234-123456789012',model='qwen2.5:0.5b-instruct-q4_K_M';
test('legacy qualification submits once and polls the same job beyond the HTTP wait budget',async()=>{
  let now=0,posts=0,reads=0;
  const result=await observeLegacyApiJob({model,clock:()=>now,pause:async()=>{now+=31000;},request:async(method,path,body)=>{
    if(method==='POST'){
      posts++;assert.equal(path,'/acm/v1/jobs');assert.equal(body.max_tokens,16);
      return new Response(JSON.stringify({job:{id}}),{status:202,headers:{'x-acm-job-id':id}});
    }
    reads++;assert.equal(path,'/acm/v1/jobs/'+id);
    return new Response(JSON.stringify({job:{id,model,state:now>90000?'SUCCEEDED':'RUNNING',
      source:'ISOLATED_REAL_ENGINE',cleanup:{confirmed:now>90000},output:now>90000?'fixture':undefined,
      usage:{completion_tokens:3}}}));
  }});
  assert.equal(posts,1);assert.equal(reads,4);assert.equal(result.id,id);assert.equal(result.output,'fixture');
});

test('legacy unknown terminal and observation timeout never retry a POST or declare release',async()=>{
  for(const terminal of ['INTERRUPTED','RUNNING','SUCCEEDED']){
    let now=0,posts=0;
    await assert.rejects(observeLegacyApiJob({model,clock:()=>now,pause:async()=>{now+=70000;},request:async(method)=>{
      if(method==='POST'){posts++;return new Response(JSON.stringify({job:{id}}),{status:202,headers:{'x-acm-job-id':id}});}
      return new Response(JSON.stringify({job:{id,model,state:terminal,source:'ISOLATED_REAL_ENGINE',
        cleanup:{confirmed:false},output:'fixture',usage:{completion_tokens:3}}}));
    }}),/LEGACY_API_(JOB_NOT_RELEASED|OBSERVATION_TIMEOUT)/);
    assert.equal(posts,1);
  }
});

test('legacy polling rejects a different job identity',async()=>{
  let posts=0;
  await assert.rejects(observeLegacyApiJob({model,request:async(method)=>{
    if(method==='POST'){posts++;return new Response(JSON.stringify({job:{id}}),{status:202,headers:{'x-acm-job-id':id}});}
    return new Response(JSON.stringify({job:{id:'wrong',model,state:'SUCCEEDED'}}));
  }}),/LEGACY_API_JOB_IDENTITY/);
  assert.equal(posts,1);
});
