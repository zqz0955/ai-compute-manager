import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createOllamaSupervisor, fail, fixedOllamaRequest, REAL_MODE, LEGACY_MODE, REAL_PROMPT, MAX_TOKENS,
  sha, checkModelManifest, uuid } from '../../src/worker/r1/ollama-once.mjs';
import {NX_ENGINE, NX_AUDIT, nxInstalled, nxH3Mode, checkNxDispatch} from '../nx-legacy/layout.mjs';
const root=nxInstalled ? NX_ENGINE : '/opt/acm-rc2-engine-readiness';
const {createEngineLifecycle}=await import('file://'+root+'/readiness.mjs');
import {gzipSync} from 'node:zlib';
import { lines,streamGenerate } from './integration-stream.mjs';
import { createLegacyNativeSampler } from './legacy-native-memory.mjs';

const service='/system.slice/acm-rc2-engine-readiness.service';
const leaf='/sys/fs/cgroup'+service+'/engine';
const model='qwen2.5:0.5b-instruct-q4_K_M';
const digest='a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67';
const libraries=root+'/assets/ollama/lib/ollama';
const weights=root+'/assets/models/blobs/sha256-';
const protect=nxInstalled ? NX_AUDIT+'/work' : '/opt/acm-r3-code/src/tools/fixtures/work';
const text=path=>readFileSync(path,'utf8').trim();
const check=(ok,code)=>{if(!ok)throw fail(code);};
const emit=wire=>console.log('ACM_R3_ENGINE_PIPE '+JSON.stringify(wire));

function args() {
  const encoded=process.env.ACM_R3_ENGINE_INPUT;
  check(typeof encoded==='string' && /^[A-Za-z0-9_-]{1,4096}$/.test(encoded),'ENGINE_UNIT_INPUT');
  const request=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
  const {binding,engine,mode,token,memoryMode=null}=request;
  check(uuid(binding?.attemptId) && uuid(binding.jobId) && binding.model===model && binding.digest===digest &&
    uuid(engine) && uuid(token) && (nxH3Mode?mode===nxH3Mode:['json','sse','legacy-json'].includes(mode)) &&
    (mode.startsWith('legacy-')?memoryMode===LEGACY_MODE:memoryMode===null),'ENGINE_UNIT_INPUT');
  return request;
}

async function run(){
  const {binding,engine,mode,token}=args();
  const legacy=mode.startsWith('legacy-');
  const service=legacy?'/acmlegacycpu.slice/acm-rc2-engine-readiness.service':'/system.slice/acm-rc2-engine-readiness.service';
  const leaf='/sys/fs/cgroup'+service+'/engine';
  const invocation=process.env.INVOCATION_ID;
  check(/^[a-f0-9]{32}$/.test(invocation??''),'ENGINE_UNIT_INVOCATION');
  check(text('/proc/self/cgroup')==='0::'+service,'ENGINE_UNIT_BOUNDARY');
  // 獨立工作資料留在單元外，受限單元即使使用本次根程序身分也無法存取。
  let stateHidden=false;
  try{
    const id=lstatSync(protect);
    stateHidden=id.ino!==Number(process.env.ACM_R3_OUTER_STATE_INODE) ||
      id.dev!==Number(process.env.ACM_R3_OUTER_STATE_DEV);
  }catch(error){if(!['EACCES','ENOENT'].includes(error.code))throw error;stateHidden=true;}
  check(stateHidden,'ENGINE_STATE_NOT_MASKED');
  const lifecycle=await createEngineLifecycle(legacy?{memoryMode:LEGACY_MODE,legacySampler:scope=>createLegacyNativeSampler({...scope,
    onFailure:diagnostic=>emit({type:'memory-failure',token,invocation,diagnostic})})}:{});
  emit({type:'unit',token,invocation,pid:process.pid});
  const manifest=readFileSync(root+'/assets/models/manifests/registry.ollama.ai/library/qwen2.5/0.5b-instruct-q4_K_M');
  check(sha(manifest)===digest,'ENGINE_WEIGHT_MANIFEST');
  const weight=checkModelManifest(JSON.parse(manifest)).find(row=>row.type.endsWith('.model')).digest;
  const runnerPath=libraries+'/llama-server';
  const runnerMeta=lstatSync(runnerPath);
  check(realpathSync(runnerPath)===runnerPath && runnerMeta.isFile() && runnerMeta.uid===0 &&
    runnerMeta.gid===0 && runnerMeta.nlink===1 && !(runnerMeta.mode & 0o222),'ENGINE_RUNNER_FILE');
  let actor,runner,response,observedMs,requests=0;
  function counters(){
    const result=lifecycle.metrics();
    if(actor && !result.empty){
      for(const pid of text(leaf+'/cgroup.procs').split('\n').filter(Boolean).map(Number)){
        if(pid===actor.pid) continue;
        const proc='/proc/'+pid;
        try{
          const status=text(proc+'/status');
          const ticks=text(proc+'/stat').split(') ').at(-1).split(' ')[19];
          const argv=readFileSync(proc+'/cmdline','utf8').split('\0').filter(Boolean);
          if(!argv.length) continue;
          check(lifecycle.member(pid) && /^Uid:\s+65202\s+65202\s+65202\s+65202$/m.test(status) &&
            /^Gid:\s+65202\s+65202\s+65202\s+65202$/m.test(status) && /^CapEff:\s+0+$/m.test(status) &&
            /^NoNewPrivs:\s+1$/m.test(status) && /^Seccomp:\s+2$/m.test(status) &&
            new RegExp('^PPid:\\s+'+actor.pid+'$','m').test(status),'ENGINE_RUNNER_IDENTITY');
          const has=(flag,value)=>argv.indexOf(flag)>0 && argv[argv.indexOf(flag)+1]===value;
          check(argv[0]===runnerPath && has('-ngl','0') && has('-t','1') && has('-np','1') &&
            has('-c','512') && has('--host','127.0.0.1') && has('--model',weights+weight) &&
            !argv.includes('--mmproj'),'ENGINE_RUNNER_ARGUMENTS');
          runner={pid,ticks,uid:65202,context:512,cpuLayers:0,threadCount:1};
        }catch(error){if(!['ENOENT','ESRCH'].includes(error.code) || existsSync(proc)) throw error;}
      }
    }
    return result;
  }
  const supervisor=createOllamaSupervisor({mode:legacy?LEGACY_MODE:REAL_MODE,model,digest,version:'0.40.16',context:512,
    limits:legacy?{memory:1610612736,memoryHigh:1476395008}:{memory:2147483648}},{
    metrics:counters,
    async start(signal){
      actor=await lifecycle.start((stage,verdict,code)=>emit({type:'stage',token,row:{stage,verdict,code}}),signal);
      return {
        async request(method,path,body,requestSignal){
          check(lifecycle.member(actor.pid),'ENGINE_ACTOR_LOST');
          if(path!=='/api/generate') return fixedOllamaRequest(method,path,body,requestSignal);
          if(nxInstalled){
            emit({type:'dispatch-gate',token,invocation});
            const gate=lines(process.stdin,38);
            const answer=await gate.next();
            check(answer.value===token && (await gate.next()).done,'NX_GATE_REFUSED');
            requestSignal.throwIfAborted();
            checkNxDispatch(process.env.ACM_NX_DISPATCH);
          }
          check(++requests===1,'ENGINE_DUPLICATE_DISPATCH');
          emit({type:'stage',token,row:{stage:'GENERATE',verdict:'START'}});
          response=mode==='sse'||mode==='legacy-sse'
            ?await streamGenerate(body,requestSignal,content=>emit({type:'delta',token,content}))
            :await fixedOllamaRequest(method,path,body,requestSignal);
          return response;
        },
        engineProof(){
          check(runner && typeof actor.startTick==='string','ENGINE_RUNNER_UNOBSERVED');
          return {attestation:sha(JSON.stringify({token,invocation,engine,binding,actor,runner})),
            actualContext:runner.context,runnerObserved:true};
        },
        stop:lifecycle.stop,
      };
    },
    recordInference(value){observedMs=value.requestMs;},
  });
  try{
    const result=await supervisor.execute(binding,{prompt:REAL_PROMPT,maxTokens:MAX_TOKENS},lifecycle.monitorSignal);
    check(requests===1 && result.engineEvidence.responseSha256===sha(response.response) &&
      Number.isSafeInteger(observedMs) && observedMs<=90000 && supervisor.sample().healthy &&
      supervisor.sample().active===0 && supervisor.sample().resident===0,'ENGINE_TERMINAL_EVIDENCE');
    if(legacy){
      const transcript=Buffer.from(JSON.stringify(lifecycle.memoryTranscript()));
      check(transcript.length<=8*1024**2,'LEGACY_TRANSCRIPT_LIMIT');
      const packed=gzipSync(transcript),parts=Math.ceil(packed.length/24576);
      check(parts>0&&parts<=16,'LEGACY_TRANSCRIPT_LIMIT');
      for(let index=0;index<parts;index++)emit({type:'memory',token,invocation,index,parts,
        data:packed.subarray(index*24576,(index+1)*24576).toString('base64')});
    }
    emit({type:'result',token,invocation,engine,innerEngine:result.engine,binding,
      engineEvidence:result.engineEvidence,output:response.response,
      stateHidden,usage:{prompt_tokens:response.prompt_eval_count,completion_tokens:response.eval_count,
        total_tokens:response.prompt_eval_count+response.eval_count},runner,observedMs,requests});
  }finally{
    if(legacy){
      try{await lifecycle.stop();}catch{/* 原生成或監測錯誤保留，外層仍要求單元收割。 */}
      finally{lifecycle.stopMonitor();}
    }else if(!lifecycle.metrics().empty)await lifecycle.stop();
  }
}
await run().catch(error=>{
  const code=typeof error?.code==='string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'ENGINE_UNIT_UNCLASSIFIED';
  emit({type:'hold',code});
  process.exitCode=42;
});
