import { agentStatus, installAgent, openAgent, retireAgent } from './installation.mjs';
import { hasFields } from './protocol.mjs';

const maxRequestBytes=512;
const usage=[
  'install <absolute-new-directory> <node-id> [--ollama]',
  'status <absolute-directory>',
  'sample <absolute-directory> <challenge>',
  'start <absolute-directory>',
  'uninstall <absolute-directory> [--apply]',
];

function requireAgentHost(){
  if (process.platform!=='linux' || process.arch!=='arm64' || typeof process.getuid!=='function' || process.getuid()===0) {
    throw new Error('AGENT_REQUIRE_NON_ROOT_LINUX_ARM64');
  }
  const [major,minor,patch]=process.versions.node.split('.').map(Number);
  if (!((major===22 && (minor>23 || (minor===23 && patch>=5))) ||
        (major===24 && (minor>22 || (minor===22 && patch>=3))))) {
    throw new Error('AGENT_UNSUPPORTED_NODE');
  }
}

function deliver(record){
  return new Promise((resolve,reject)=>{
    process.stdout.write(JSON.stringify(record)+'\n',error=>error?reject(error):resolve());
  });
}

async function streamChallenges(session,signal){
  await deliver({status:'READY',nodeId:session.nodeId,publicKey:session.publicKey});
  let pending=Buffer.alloc(0);
  for await (const chunk of process.stdin){
    let start=0;
    while (start<chunk.length) {
      signal.throwIfAborted();
      const end=chunk.indexOf(10,start);
      const slice=chunk.subarray(start,end<0?chunk.length:end);
      if (pending.length+slice.length>maxRequestBytes) throw new Error('AGENT_REQUEST_TOO_LARGE');
      pending=Buffer.concat([pending,slice]);
      if (end<0) break;
      let document;
      try {document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pending));}
      catch {throw new Error('AGENT_REQUEST_INVALID');}
      if (!hasFields(document,['challenge'])) throw new Error('AGENT_REQUEST_INVALID');
      await deliver(await session.sample(document.challenge,{signal}));
      pending=Buffer.alloc(0);
      start=end+1;
    }
  }
  if (pending.length!==0) throw new Error('AGENT_REQUEST_TRUNCATED');
}

async function withSession(root,action,challenge){
  const session=openAgent(root);
  const shutdown=new AbortController();
  const stop=()=>{
    shutdown.abort();
    if (action==='start') process.stdin.destroy();
  };
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
  process.on('error',stop);
  process.stdout.once('error',stop);
  try {
    if (action==='start') return await streamChallenges(session,shutdown.signal);
    await deliver(await session.sample(challenge,{signal:shutdown.signal}));
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  } finally {
    process.removeListener('SIGINT',stop);
    process.removeListener('SIGTERM',stop);
    process.removeListener('error',stop);
    process.stdout.removeListener('error',stop);
    await session.close();
  }
}

async function main([action,root,arg,flag,...rest]){
  if (action==='--help' && root===undefined) return deliver({usage});
  requireAgentHost();
  switch (action) {
    case 'install':
      if (root && arg && rest.length===0 && (flag===undefined||flag==='--ollama')) {
        return deliver(installAgent(root,arg,{ollama:flag==='--ollama'}));
      }
      break;
    case 'status':
      if (root && arg===undefined) return deliver(agentStatus(root));
      break;
    case 'sample':
      if (root && arg && flag===undefined) return withSession(root,'sample',arg);
      break;
    case 'start':
      if (root && arg===undefined) return withSession(root,'start');
      break;
    case 'uninstall':
      if (root && (arg===undefined||arg==='--apply') && flag===undefined) return deliver(retireAgent(root,{apply:arg==='--apply'}));
      break;
  }
  throw new Error('AGENT_USAGE');
}

try {await main(process.argv.slice(2));}
catch (error) {
  const message=error?.message;
  const code=/^[A-Z0-9_]{2,50}$/u.test(message ?? '')?message:'AGENT_OPERATION_FAILED';
  console.error(JSON.stringify({status:'REFUSED',code}));
  process.exitCode=1;
}
