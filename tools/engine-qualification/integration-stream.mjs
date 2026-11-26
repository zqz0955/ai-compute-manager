import { request } from 'node:http';
import { fail, OLLAMA_PORT } from '../../src/worker/r1/ollama-once.mjs';

const check=(ok,code)=>{if(!ok)throw fail(code);};

export async function* lines(input,limit=262144) {
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let pending='',total=0;
  for await(const block of input){
    total+=block.byteLength;
    check(total<=limit,'ENGINE_FRAME_LIMIT');
    pending+=decoder.decode(block,{stream:true});
    for(let index;(index=pending.indexOf('\n'))!==-1;){
      const row=pending.slice(0,index);
      pending=pending.slice(index+1);
      check(Buffer.byteLength(row)<=65536,'ENGINE_FRAME_LIMIT');
      yield row;
    }
    check(Buffer.byteLength(pending)<=65536,'ENGINE_FRAME_LIMIT');
  }
  check(pending+decoder.decode()==='','ENGINE_FRAME_TRUNCATED');
}

export async function readOllamaStream(response,model,publish) {
  check(response.statusCode===200 &&
    /^application\/x-ndjson(?:\s*;|$)/i.test(response.headers['content-type']??''),'ENGINE_STREAM_HTTP');
  let output='',terminal;
  for await(const row of lines(response)){
    const event=JSON.parse(row);
    check(!terminal && event?.model===model && typeof event.done==='boolean' &&
      typeof event.response==='string' && event.response.isWellFormed() && !event.error,'ENGINE_STREAM_PROTOCOL');
    output+=event.response;
    check(Buffer.byteLength(output)<=16384,'ENGINE_STREAM_LIMIT');
    if(event.response) publish(event.response);
    if(event.done) terminal=event;
  }
  check(response.complete && terminal,'ENGINE_STREAM_TRUNCATED');
  return {...terminal,response:output};
}

export function streamGenerate(body,signal,publish) {
  signal.throwIfAborted();
  const json=JSON.stringify({...body,stream:true});
  check(Buffer.byteLength(json)<=4096,'ENGINE_REQUEST_LIMIT');
  return new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:OLLAMA_PORT,path:'/api/generate',method:'POST',
      agent:false,signal,headers:{connection:'close',accept:'application/x-ndjson',
        'content-type':'application/json','content-length':Buffer.byteLength(json)}},async res=>{
      try{resolve(await readOllamaStream(res,body.model,publish));}
      catch(error){res.destroy();reject(error);}
    });
    req.once('error',reject);
    req.end(json);
  });
}
