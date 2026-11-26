import { createHash, createPrivateKey } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROBE_COMMAND, probePlan, readProbeFrame, respondProbe } from './ready-protocol.mjs';
import { requireH3 } from './wire.mjs';

const root = '/opt/acm-h3-ready-v1';
const digest = data => createHash('sha256').update(data).digest('hex');
function fixedFile(name, uid, mode, maxBytes) {
  const fd = openSync(root+'/'+name, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    requireH3(info.isFile() && info.nlink===1 && info.uid===uid && (info.mode&0o777)===mode &&
      info.size>0 && info.size<=maxBytes, 'H3_READY_FILE_BOUNDARY');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function main() {
  const signal = AbortSignal.timeout(5000);
  signal.addEventListener('abort',()=>process.stdin.destroy(Error('H3_PROBE_TRANSPORT_DEADLINE')),{once:true});
  requireH3(process.platform==='linux' && process.arch==='arm64' && process.versions.node==='24.22.3' &&
    process.execPath===root+'/node' && fileURLToPath(import.meta.url)===root+'/ready-service.mjs' &&
    process.getuid()>0 && process.getuid()===process.geteuid() && process.getgid()===process.getegid() &&
    process.argv.length===2 && process.env.SSH_ORIGINAL_COMMAND===PROBE_COMMAND && !process.env.SSH_TTY &&
    fstatSync(0).isFIFO() && fstatSync(1).isFIFO(), 'H3_READY_FORCED_COMMAND');
  for (const path of ['/opt',root]) {
    const dir = lstatSync(path);
    requireH3(dir.isDirectory() && dir.uid===0 && !(dir.mode&0o022), 'H3_READY_ROOT_BOUNDARY');
  }
  const plan = probePlan(JSON.parse(fixedFile('plan.json',0,0o444,4096)));
  requireH3(plan.uid===process.getuid() && plan.gid===process.getgid() &&
    process.getgroups().every(gid=>gid===plan.gid) &&
    plan.boot===readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim() &&
    plan.deviceSha256===digest(readFileSync('/etc/machine-id','utf8').trim()), 'H3_READY_DEVICE_BOUNDARY');
  const state = lstatSync(root+'/state');
  requireH3(state.isDirectory() && state.uid===plan.uid && state.gid===plan.gid && (state.mode&0o777)===0o700,
    'H3_READY_STATE_BOUNDARY');
  const key = createPrivateKey(fixedFile('probe.pem',plan.uid,0o400,4096));
  const wire = await readProbeFrame(process.stdin);
  const response = respondProbe({plan,wire,key,claimOnce(operation,nonce){
    const fd=openSync(root+'/state/used.json','wx',0o400);
    try {
      writeFileSync(fd,JSON.stringify({operation,nonce}));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const dir=openSync(root+'/state',constants.O_DIRECTORY|constants.O_RDONLY|constants.O_NOFOLLOW);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }});
  signal.throwIfAborted();
  process.stdout.write(JSON.stringify(response)+'\n');
}
try { await main(); }
catch(error) {
  const code = error.code==='EEXIST'?'H3_PROBE_REPLAY':error.code??error.message;
  console.error('ACM_H3_READY_HOLD '+(/^[A-Z0-9_]{2,80}$/u.test(code??'')?code:'H3_READY_REFUSED'));
  process.exitCode=42;
  process.stdin.destroy();
}
