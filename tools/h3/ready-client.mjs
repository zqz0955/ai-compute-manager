import { spawn } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, readBytes, readJson, snapshotFile } from '../files.mjs';
import { assertPinned, assertPrivateInstallation, pinPath } from '../lock.mjs';
import { exact, requireH3 } from './wire.mjs';
import { h3PrivateAddress, h3SshArgs } from './ssh-args.mjs';
import { PROBE_COMMAND, PROBE_PORT, PROBE_TRANSPORT_MS, probePlan, readProbeFrame, requestProbe, verifyProbe } from './ready-protocol.mjs';

export async function probeOverSsh({ binary, args, plan, key }) {
  const sentAt=Date.now(), start=performance.now();
  const wire=requestProbe(plan,key,sentAt);
  const timeout=AbortSignal.timeout(PROBE_TRANSPORT_MS);
  const child=spawn(binary,args,{stdio:['pipe','pipe','ignore'],windowsHide:true,signal:timeout});
  child.stdin.on('error',()=>child.stdout.destroy());
  try {
    child.stdin.end(JSON.stringify(wire)+'\n');
    const [[exit],response]=await Promise.all([once(child,'close'), readProbeFrame(child.stdout)]);
    requireH3(exit===0&&!timeout.aborted,'H3_PROBE_SSH_EXIT');
    const receivedAt=Date.now(), roundTripMs=Math.ceil(performance.now()-start);
    const transcript={request:wire,response,sentAt,receivedAt,roundTripMs};
    return {...verifyProbe({plan,...transcript}),transcript};
  } catch(error) {
    child.kill();
    throw error;
  }
}

async function main(root, expected) {
  requireH3(process.platform==='win32' && process.versions.node==='24.22.3','H3_READY_WINDOWS_RUNTIME');
  const names=['ready-client.json','controller.pem','known_hosts','ssh-identity'].map(name=>join(root,name));
  assertPrivateInstallation(root,names);
  const config=readJson(names[0]);
  const raw=config.value;
  requireH3(config.sha256===expected && exact(raw,['plan','host','ssh','sshSha256','nodeSha256']) &&
    h3PrivateAddress(raw.host) && raw.nodeSha256===snapshotFile(process.execPath,256*1024**2).sha256,'H3_READY_CLIENT_PIN');
  const plan=probePlan(raw.plan);
  const [host,role]=[readBytes(names[2],4096),readBytes(names[1],4096)];
  const known=/^acm-h3-target ssh-ed25519 ([A-Za-z0-9+/]+={0,2})\r?\n$/u.exec(host.contents.toString('utf8'));
  requireH3(known && digest(Buffer.from(known[1],'base64'))===plan.sshHostSha256,'H3_READY_SSH_HOST_KEY');
  const ssh=snapshotFile(raw.ssh,64*1024**2);
  requireH3(ssh.sha256===raw.sshSha256,'H3_READY_SSH_BINARY_PIN');
  [config.pin,host.pin,role.pin,ssh.pin,pinPath(names[3],'file')].forEach(assertPinned);
  return probeOverSsh({binary:ssh.pin.path,plan,key:createPrivateKey(role.contents),
    args:h3SshArgs({host:raw.host,user:'acm-h3-ready',port:PROBE_PORT,identity:names[3],knownHosts:names[2],command:PROBE_COMMAND})});
}

if (process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url) {
  try {
    const [root,sha,...extra]=process.argv.slice(2);
    requireH3(!extra.length && /^[a-f\d]{64}$/u.test(sha??''),'H3_READY_CLIENT_USAGE');
    console.log(JSON.stringify(await main(root,sha)));
  } catch(error) {
    const code=error.code??error.message;
    console.error('ACM_H3_READY_HOLD '+(/^[A-Z0-9_]{2,80}$/u.test(code??'')?code:'H3_READY_CLIENT_REFUSED'));
    process.exitCode=42;
  }
}
