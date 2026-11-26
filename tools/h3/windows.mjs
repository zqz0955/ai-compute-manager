import { spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { createHttpApp } from '../../src/http-app.mjs';
import { openController, provisionQualificationStore } from '../../src/controller.mjs';
import { digest, readBytes, readJson, snapshotFile } from '../files.mjs';
import { assertPinned, assertPrivateInstallation, pinPath } from '../lock.mjs';
import { createH3Exchange, exact, requireH3 } from './wire.mjs';
import { h3Qualified } from './session.mjs';
import { h3Plan } from './plan.mjs';
import { h3SshArgs } from './ssh-args.mjs';
import { requireNativeH3Admission } from './native-gate.mjs';


async function serve(root,configPin) {
  requireNativeH3Admission();
  const p=name=>join(root,name);
  const settings=['plan.json','controller.pem','known_hosts','ssh-identity','controller.sqlite'].map(p);
  assertPrivateInstallation(root,settings);
  const plan=readJson(settings[0]);
  requireH3(plan.sha256===configPin,'H3_WINDOWS_PLAN_PIN');
  const raw=plan.value;
  const options=h3Plan(raw,['ssh','token','nodeSha256']);
  requireH3(snapshotFile(process.execPath,256*1024**2).sha256===raw.nodeSha256,'H3_WINDOWS_NODE_PIN');
  const suffix=options.target.mode==='legacy-json'?'json':'sse';
  const attach='/usr/bin/python3 -I -B /opt/acm-nx-h3-'+suffix+'-v1/code/tools/h3/attach.py';
  const {ssh,token}=raw;
  requireH3(exact(ssh,['binary','sha256','user','host','port']) &&
    typeof ssh.user==='string' && /^[a-z_][a-z0-9_-]{0,31}$/u.test(ssh.user) &&
    typeof ssh.host==='string' && /^[a-z0-9][a-z0-9.-]{0,252}$/iu.test(ssh.host) &&
    ssh.port===22 && /^[a-f0-9]{64}$/u.test(ssh.sha256) &&
    exact(token,['id','sha256','scopes','expiresAt'])&&/^[a-z][a-z0-9-]{0,39}$/u.test(token.id)&&
    /^[a-f0-9]{64}$/u.test(token.sha256)&&Array.isArray(token.scopes)&&token.scopes.length===1&&
    token.scopes[0]==='models:run'&&Number.isSafeInteger(token.expiresAt),'H3_WINDOWS_TRANSPORT_POLICY');
  const host=readBytes(settings[2],4096);
  const match=/^acm-h3-target ssh-ed25519 ([A-Za-z0-9+/]+={0,2})\r?\n$/u.exec(host.contents.toString('utf8'));
  requireH3(match&&digest(Buffer.from(match[1],'base64'))===options.target.hostTrust,'H3_WINDOWS_HOST_KEY_PIN');
  const client=createPrivateKey(readBytes(settings[1],4096).contents);
  requireH3(createPublicKey(client).equals(options.controllerPublicKey),'H3_WINDOWS_CONTROLLER_KEY');
  let channel, child;
  const worker=h3Qualified(options,(request,context)=>{
    if (!child) {
      const binary=snapshotFile(ssh.binary,64*1024**2);
      requireH3(binary.sha256===ssh.sha256,'H3_WINDOWS_SSH_PIN');
      assertPinned(plan.pin);
      assertPinned(host.pin);
      assertPrivateInstallation(root,settings);
      pinPath(settings[3],'file');
      const args=h3SshArgs({host:ssh.host,user:ssh.user,port:ssh.port,identity:settings[3],
        knownHosts:settings[2],command:attach});
      assertPinned(binary.pin);
      child=spawn(binary.pin.path,args,{windowsHide:true,stdio:['pipe','pipe','ignore']});
      child.on('error',()=>{channel?.close();});
      child.stdin.on('error',()=>{channel?.close();});
      channel=createH3Exchange({input:child.stdout,output:child.stdin,pin:worker.pin,controllerPrivateKey:client,
        workerPublicKey:options.workerPublicKey,shutdown(){child.stdin.destroy();child.stdout.destroy();child.kill();}});
    }
    return channel.exchange(request,context);
  });
  requireH3(token.expiresAt<=worker.claim.expiresAt && token.expiresAt>Date.now(),'H3_WINDOWS_TOKEN_WINDOW');
  const controller=openController({dataDir:root,mode:'engine-qualification',maxConcurrent:1,timeoutMs:120000,qualifiedWorker:worker});
  const app=createHttpApp({controller,mode:'engine-qualification',tokens:[token],telemetry:{history:()=>[]},
    qualificationMode:options.target.mode});
  const stop=async()=>{
    app.close();
    app.closeAllConnections();
    channel?.close();
    await controller.close();
  };
  process.once('SIGINT',()=>void stop());
  process.once('SIGTERM',()=>void stop());
  try {
    app.listen({host:'127.0.0.1',port:0,exclusive:true});
    await once(app,'listening');
    console.log('ACM_H3_LISTEN='+JSON.stringify({host:'127.0.0.1',port:app.address().port,mode:options.target.mode,
      operation:options.target.operation}));
  } catch (error) {
    await stop();
    throw error;
  }
}

try {
  const [verb,root,planPin,...extra]=process.argv.slice(2);
  requireH3(process.platform==='win32'&&process.versions.node==='24.22.3'&&extra.length===0,'H3_WINDOWS_RUNTIME');
  assertPrivateInstallation(root);
  if (verb==='provision'&&planPin===undefined) console.log('ACM_H3_STORE='+provisionQualificationStore(root));
  else {
    requireH3(verb==='serve'&&typeof planPin==='string'&&/^[a-f0-9]{64}$/u.test(planPin),'H3_WINDOWS_USAGE');
    await serve(root,planPin);
  }
}catch(error) {
  console.error('ACM_H3_HOLD '+(/^[A-Z0-9_]{1,64}$/u.test(error?.code??error?.message)?error.code??error.message:'H3_WINDOWS_ERROR'));
  process.exitCode=42;
}
