import {request} from 'node:http';

const token=process.env.ACM_API_TOKEN;
if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) throw Error('Set a local client token in ACM_API_TOKEN');
const port=Number(process.argv[2]??8787);
if (!Number.isInteger(port)||port<1||port>65535||[8875,8897].includes(port)) throw Error('Use the isolated ACM port');
const data=JSON.stringify({model:'fixture:demo',messages:[{role:'user',content:'ACM preview'}],max_tokens:12});
const call=request({host:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST',agent:false,
  headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},
response=>{
  response.setEncoding('utf8');
  response.pipe(process.stdout);
  if (response.statusCode!==200) process.exitCode=1;
});
call.setTimeout(95000,()=>call.destroy(Error('Local request timed out')));
call.on('error',error=>{console.error(error.message);process.exitCode=1;});
call.end(data);
