import {spawn} from 'node:child_process';
import {createPublicKey,generateKeyPairSync} from 'node:crypto';
import {readFileSync,readlinkSync} from 'node:fs';
import {once} from 'node:events';
import {openSimulationWorker,provisionSimulationWorker} from '../../src/worker/r1/upstream-terminal.mjs';
import {fail,LEGACY_MODE} from '../../src/worker/r1/ollama-once.mjs';
import {NX_AUDIT,NX_CODE,NX_WORKER_UID,nxInstalled} from './layout.mjs';

const need=(ok,code)=>{if(!ok)throw fail(code);};
const publicBytes=key=>key.export({type:'spki',format:'der'}).toString('hex');
const publicKey=hex=>createPublicKey({key:Buffer.from(hex,'hex'),format:'der',type:'spki'});

// 雙向 RPC 僅經父子私有 IPC。Worker 不接收任何回收簽章金鑰。
function rpc(parent,send,methods,signal){
  let sequence=0;
  const pending=new Map();
  const disconnect=()=>{for(const {reject} of pending.values())reject(fail('NX_WORKER_DISCONNECTED'));pending.clear();};
  parent.on('disconnect',disconnect);
  parent.on('message',async frame=>{
    if(!frame||!Number.isSafeInteger(frame.id)||Buffer.byteLength(JSON.stringify(frame))>32768) return disconnect();
    if(!Object.hasOwn(frame,'method')){
      const waiter=pending.get(frame.id);
      if(!waiter)return;
      pending.delete(frame.id);
      if(frame.ok===true)waiter.resolve(frame.value);
      else waiter.reject(fail('NX_WORKER_RPC_REJECTED'));
      return;
    }
    try{
      need(Object.hasOwn(methods,frame.method)&&Array.isArray(frame.args),'NX_WORKER_OPERATION');
      const value=await methods[frame.method](...frame.args);
      send({id:frame.id,ok:true,value});
    }catch{try{send({id:frame.id,ok:false});}catch{disconnect();}}
  });
  return async function call(method,...args){
    signal?.throwIfAborted();
    need(parent.connected&&pending.size<8,'NX_WORKER_CHANNEL');
    const id=++sequence;
    const timeout=AbortSignal.any([AbortSignal.timeout(method==='execute'?123000:4000),...(signal?[signal]:[])]);
    const abort=()=>{pending.get(id)?.reject(timeout.reason);pending.delete(id);};
    try{
      return await new Promise((resolve,reject)=>{
        pending.set(id,{resolve,reject});timeout.addEventListener('abort',abort,{once:true});
        send({id,method,args});
      });
    }finally{timeout.removeEventListener('abort',abort);pending.delete(id);}
  };
}

export async function startNxWorker({execute,sample,witness,signal}){
  need(nxInstalled&&process.getuid()===0,'NX_WORKER_PARENT');
  const child=spawn('/usr/bin/unshare',['--net','--mount','--ipc','--propagation','private','--',
    '/usr/bin/setpriv','--no-new-privs','--','/usr/bin/python3','-I','-B',NX_CODE+'/tools/nx-legacy/worker-exec.py'],
  {stdio:['ignore','ignore','pipe','ipc'],env:{PATH:'/usr/bin:/bin',LANG:'C'}});
  let diagnostic='';
  child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString('utf8')).slice(-4096);});
  const disconnected=new AbortController();
  let closing=false;
  const exit=new Promise(resolve=>{
    child.once('error',()=>resolve({code:null,signal:'SPAWN_ERROR'}));
    child.once('exit',(code,signal)=>resolve({code,signal}));
  });
  child.once('disconnect',()=>{if(!closing)disconnected.abort(fail('NX_WORKER_DISCONNECTED'));});
  const call=rpc(child,frame=>child.send(frame),{execute,
    sample,witnessRead:()=>witness.read(),witnessAdvance:(from,to)=>witness.advance(from,to)},signal);
  async function close(){
    closing=true;
    if(child.connected)child.disconnect();
    const closed=await Promise.race([exit,once(AbortSignal.timeout(4000),'abort').then(()=>null)]);
    need(closed?.code===0&&closed.signal===null,'NX_WORKER_EXIT_UNVERIFIED');
  }
  try{
    const hello=await call('identify');
    const status=readFileSync('/proc/'+child.pid+'/status','utf8');
    need(hello.pid===child.pid&&new RegExp('^Uid:\\s+'+Array(4).fill(NX_WORKER_UID).join('\\s+')+'$','m').test(status)&&
      new RegExp('^Gid:\\s+'+Array(4).fill(NX_WORKER_UID).join('\\s+')+'$','m').test(status)&&
      /^Groups:[ \t]*$/m.test(status)&&/^CapEff:\s+0+$/m.test(status)&&/^NoNewPrivs:\s+1$/m.test(status)&&
      ['net','mnt','ipc'].every(ns=>readlinkSync('/proc/'+child.pid+'/ns/'+ns)!==readlinkSync('/proc/self/ns/'+ns)),'NX_WORKER_CREDENTIALS');
    return {publicKey:publicKey(hello.publicKey),pid:child.pid,signal:disconnected.signal,
      initialize:identity=>call('initialize',{...identity,controllerPublicKey:publicBytes(identity.controllerPublicKey),
        workerPublicKey:publicBytes(identity.workerPublicKey)}),
      receive:wire=>call('receive',wire),close};
  }catch(error){
    await close().catch(()=>{});
    const code=diagnostic.match(/NX_WORKER_[A-Z_]+(?::[A-Za-z]+)?/)?.[0]??'NX_WORKER_NO_STAGE_RECEIPT';
    console.error(code);
    throw error;
  }
}

async function workerMain(){
  need(nxInstalled&&process.argv.length===3&&process.getuid()===NX_WORKER_UID&&process.getgid()===NX_WORKER_UID&&
    process.getgroups().every(gid=>gid===NX_WORKER_UID)&&process.connected,'NX_WORKER_BOUNDARY');
  const keys=generateKeyPairSync('ed25519');
  let worker,initializing=false;
  const call=rpc(process,frame=>process.send(frame),{
    identify:()=>({pid:process.pid,publicKey:publicBytes(keys.publicKey)}),
    async initialize(identity){
      need(!initializing&&identity.mode===LEGACY_MODE&&identity.workerPublicKey===publicBytes(keys.publicKey),'NX_WORKER_IDENTITY');
      initializing=true;
      identity={...identity,controllerPublicKey:publicKey(identity.controllerPublicKey),workerPublicKey:keys.publicKey};
      const options={identity,workerPrivateKey:keys.privateKey,database:NX_AUDIT+'/worker/upstream.sqlite'};
      const storage=provisionSimulationWorker(options);
      worker=openSimulationWorker({...options,storage,witness:{
        read:()=>call('witnessRead'),advance:(from,to)=>call('witnessAdvance',from,to)},
      sample:()=>call('sample'),execute:({binding})=>call('execute',{binding})});
      await worker.ready;
      return true;
    },
    receive:wire=>{need(worker,'NX_WORKER_NOT_READY');return worker.receive(wire);},
  });
  process.once('disconnect',()=>{worker?.close();});
}

if(process.argv[2]==='worker')await workerMain();
