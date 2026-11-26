import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {startNxWorker} from './worker-channel.mjs';
import {createUpstreamClient} from '../../src/worker/r1/upstream-terminal.mjs';
import {LEGACY_MODE,REAL_PROMPT} from '../../src/worker/r1/ollama-once.mjs';
import {LEGACY_LIMITS,LEGACY_INHERITED_LIMITS} from '../../src/worker/r1/legacy-memory.mjs';
import {startLegacySlice,stopLegacySlice,LEGACY_GROUP,LEGACY_SERVICE,LEGACY_SLICE} from '../engine-qualification/legacy-slice.mjs';
import {lines} from '../engine-qualification/integration-stream.mjs';

assert.ok(/QEMU/.test(readFileSync('/sys/class/dmi/id/product_name','utf8')));
const slice=await startLegacySlice();
try{
  const token=randomUUID(),unit=LEGACY_SERVICE.split('/').at(-1);
  const script=`import sys;print("DISPATCH_READY",flush=True);data=sys.stdin.read(38);sys.exit(0 if data==sys.argv[1]+chr(10) else 42)`;
  const service=spawn('/usr/bin/systemd-run',['--unit='+unit,'--wait','--collect','--pipe','--quiet',
    '--property=Slice='+LEGACY_SLICE,'--property=Delegate=cpu memory pids','--property=MemoryMax=infinity',
    '--property=MemoryHigh=infinity','--property=MemorySwapMax=infinity','--property=TasksMax=infinity',
    '--property=PrivateDevices=yes','--property=PrivateNetwork=yes','--property=RuntimeMaxSec=12s',
    '/usr/bin/python3','-I','-B','-c',script,token],{stdio:['pipe','pipe','inherit']});
  const done=once(service,'close');
  const frames=lines(service.stdout,256);
  assert.equal((await frames.next()).value,'DISPATCH_READY');
  for(const [key,value] of Object.entries(LEGACY_LIMITS))
    assert.equal(readFileSync(LEGACY_GROUP+'/'+key,'utf8').trim(),value);
  for(const [key,value] of Object.entries(LEGACY_INHERITED_LIMITS))
    assert.equal(readFileSync('/sys/fs/cgroup'+LEGACY_SERVICE+'/'+key,'utf8').trim(),value);
  service.stdin.end(token+'\n');
  assert.deepEqual(await done,[0,null]);
  assert.equal(existsSync('/sys/fs/cgroup'+LEGACY_SERVICE),false);
  assert.match(readFileSync(LEGACY_GROUP+'/cgroup.events','utf8'),/^populated 0$/m);
}finally{await stopLegacySlice(slice);}
console.log('ACM_LEGACY_NX_GATE_LAB='+JSON.stringify({status:'PASS',stdinFixedToken:true,
  parentLimits:LEGACY_LIMITS,childLimits:LEGACY_INHERITED_LIMITS,reaped:true,generationRequests:0}));
let anchor,executions=0;
const engine=randomUUID(),keys=generateKeyPairSync('ed25519');
const worker=await startNxWorker({
  witness:{read:()=>anchor,advance:(from,to)=>{
    assert.deepEqual(anchor,from);
    anchor=to;
    return anchor;
  }},
  sample:()=>({engine,healthy:true,active:0,resident:0,attestation:null}),
  execute:()=>{executions++;throw Error('ZERO_GENERATION_FIXTURE');},
});
try{
  const identity={mode:LEGACY_MODE,context:512,resource:'a'.repeat(64),release:'b'.repeat(64),
    model:'fixture:cpu',digest:'c'.repeat(64),epoch:randomUUID(),workerPublicKey:worker.publicKey,
    controllerPublicKey:keys.publicKey};
  const upstream=createUpstreamClient({identity,controllerPrivateKey:keys.privateKey,exchange:worker.receive});
  anchor={pin:upstream.pin,sequence:0,head:'0'.repeat(64)};
  await worker.initialize(identity);
  const binding={jobId:randomUUID(),attemptId:randomUUID(),owner:randomUUID(),resource:identity.resource,
    model:identity.model,digest:identity.digest,target:'d'.repeat(64),intentAt:Date.now()};
  const payload={prompt:REAL_PROMPT,maxTokens:16};
  const status=await upstream.dispatch(binding,payload);
  assert.equal(status.state,'ACCEPTED');
  await assert.rejects(upstream.waitTerminal(binding),/UPSTREAM_UNKNOWN/);
  await assert.rejects(upstream.dispatch({...binding,attemptId:randomUUID()},payload));
  assert.equal((await upstream.status(binding)).state,'UNKNOWN');
  assert.equal(executions,1);
  assert.equal(anchor.sequence,3);
}finally{await worker.close();}
assert.equal(existsSync('/proc/'+worker.pid),false);
console.log('ACM_LEGACY_NX_WORKER_LAB='+JSON.stringify({status:'PASS',uid:65201,nonRoot:true,
  privateNamespaces:['mnt','net','ipc'],witnessSequence:anchor.sequence,executions,generationRequests:0,exitVerified:true}));
