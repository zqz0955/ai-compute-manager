import {request} from 'node:http';
import {IDENTIFIER} from './config.mjs';
import {bodyLimit} from '../src/inference-http.mjs';

const [mode,portArg,nodeId,...extra]=process.argv.slice(2);
const token=process.env.ACM_TELEMETRY_TOKEN;
const port=Number(portArg);
try{
  if (extra.length || !['challenge','snapshot'].includes(mode) || !/^[1-9][0-9]{0,4}$/.test(portArg??'') ||
      port>65535||[8875,8897,11434].includes(port)||!IDENTIFIER.test(nodeId??'')||
      !/^[A-Za-z0-9_-]{43}$/.test(token??'')) throw Error('TELEMETRY_CLIENT_INPUT_REJECTED');
  const payload={nodeId};
  if(mode==='snapshot'){
    const pieces=[];
    let length=0;
    for await(const chunk of process.stdin){
      length+=chunk.length;
      if(length>bodyLimit) throw Error('TELEMETRY_CLIENT_INPUT_TOO_LARGE');
      pieces.push(chunk);
    }
    payload.snapshot=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(pieces)));
  }
  const text=JSON.stringify(payload);
  if(Buffer.byteLength(text)>bodyLimit) throw Error('TELEMETRY_CLIENT_INPUT_TOO_LARGE');
  const result=await new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port,method:'POST',path:'/acm/v1/telemetry/'+mode,agent:false,
      headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(text)}},res=>{
      const data=[];
      let length=0;
      res.on('data',chunk=>{
        length+=chunk.length;
        if(length>2048) res.destroy(Error('TELEMETRY_CLIENT_RESPONSE_LIMIT'));
        else data.push(chunk);
      });
      res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(data).toString('utf8')}));
    });
    req.setTimeout(8000,()=>req.destroy(Error('TELEMETRY_CLIENT_TIMEOUT')));
    req.on('error',reject);
    req.end(text);
  });
  const reply=JSON.parse(result.text);
  if(result.status!==200) throw Error('TELEMETRY_CLIENT_UPSTREAM_'+result.status);
  if(reply.nodeId!==nodeId||
      (mode==='challenge'&&!/^[A-Za-z0-9_-]{43}$/.test(reply.challenge??''))||
      (mode==='snapshot'&&!Number.isSafeInteger(reply.sequence))) throw Error('TELEMETRY_CLIENT_RESPONSE_REJECTED');
  console.log(JSON.stringify(mode==='challenge'?{nodeId,challenge:reply.challenge,expiresAt:reply.expiresAt}:
    {nodeId,sequence:reply.sequence,sampledAt:reply.sampledAt}));
}catch(cause){
  console.error('ACM_TELEMETRY_HOLD '+(/^[A-Z0-9_]+$/.test(cause?.message??'')?cause.message:'TELEMETRY_CLIENT_FAILED'));
  process.exitCode=1;
}
