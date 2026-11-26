import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readOllamaStream } from '../tools/engine-qualification/integration-stream.mjs';

const model='qwen:fixture';
const event=(response,done=false,extra={})=>JSON.stringify({model,response,done,...extra})+'\n';
const mock=(parts,complete=true)=>({
  statusCode:200,headers:{'content-type':'application/x-ndjson'},complete,
  async *[Symbol.asyncIterator](){for(const part of parts) yield Buffer.from(part);},
});

test('Ollama 的 NDJSON 只有一筆終態，之前逐段交付暫定內容',async()=>{
  const preview=[];
  const response=mock([]);
  response[Symbol.asyncIterator]=async function*(){
    const first=Buffer.from(event('確'));
    yield first.subarray(0,first.length-12);
    yield first.subarray(first.length-12);
    assert.deepEqual(preview,['確']);
    yield Buffer.from(event('認')+event('',true,{eval_count:2,done_reason:'stop'}));
  };
  const result=await readOllamaStream(response,model,part=>preview.push(part));
  assert.equal(result.response,'確認');
  assert.equal(result.eval_count,2);
  assert.deepEqual(preview,['確','認']);
});

test('Ollama 缺終態、中斷 UTF-8、終態後多一筆及錯模型均不會回傳正式結果',async()=>{
  const inputs=[
    [event('preview'),'ENGINE_STREAM_TRUNCATED'],
    [event('preview',true).trimEnd(),'ENGINE_FRAME_TRUNCATED'],
    [event('preview',true)+event('after'),'ENGINE_STREAM_PROTOCOL'],
    [event('preview',false,{model:'wrong'})+event('',true),'ENGINE_STREAM_PROTOCOL'],
  ];
  for(const [body,code] of inputs)
    await assert.rejects(readOllamaStream(mock([body]),model,()=>{}),{code});
});
