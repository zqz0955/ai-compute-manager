import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { h3SshArgs } from './ssh-args.mjs';
import { requestProbe, verifyProbe, PROBE_COMMAND, PROBE_PORT } from './ready-protocol.mjs';

const root='/opt/acm-h3-ready-stage-v1';
const plan=JSON.parse(readFileSync(root+'/site.json')).plan;
const key=createPrivateKey(readFileSync(root+'/controller.pem'));
const args=h3SshArgs({host:'127.0.0.1',user:'acm-h3-ready',port:PROBE_PORT,
  knownHosts:root+'/known_hosts',identity:root+'/ssh-identity',command:PROBE_COMMAND});
const run=(argv, input='')=>spawnSync('/usr/bin/ssh',argv,{input,encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin',LANG:'C'}});
const refusal=(res,status)=>{
  assert.ifError(res.error);
  assert.equal(res.status,status,res.stderr);
  assert.equal(res.stdout,'');
};
refusal(run([...args.slice(0,-1),'wrong-operation']),42);
refusal(run(args.map(arg=>arg.endsWith('/ssh-identity')?root+'/other_identity':arg)),255);
refusal(run(args.map(arg=>arg.replace('/known_hosts"','/wrong_hosts"'))),255);
refusal(run(['-W','127.0.0.1:'+PROBE_PORT,...args.slice(0,-1)]),255);
const tty=run(['-tt',...args.filter(arg=>arg!=='-T')]);
refusal(tty,255);
assert.match(tty.stderr,/PTY allocation request failed/u);
refusal(run(args,JSON.stringify({value:{operation:'ready-only'},signature:'0'.repeat(128)})+'\n'),42);
refusal(run(args,'x'.repeat(4097)+'\n'),42);
const sentAt=Date.now(), start=performance.now();
const request=requestProbe(plan,key,sentAt);
const text=JSON.stringify(request)+'\n';
const response=run(args,text);
assert.ifError(response.error);
assert.equal(response.status,0,response.stderr);
const receipt=verifyProbe({plan,request,response:JSON.parse(response.stdout),sentAt,receivedAt:Date.now(),
  roundTripMs:Math.ceil(performance.now()-start)});
refusal(run(args,text),42);
console.log(JSON.stringify({...receipt,denied:['wrong-command','wrong-key','wrong-host-key','forwarding','tty','forged-request','oversize','replay']}));
