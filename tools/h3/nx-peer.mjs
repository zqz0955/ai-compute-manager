import { createHash, verify } from 'node:crypto';
import { createServer } from 'node:net';
import { chownSync, chmodSync, lstatSync } from 'node:fs';
import { once } from 'node:events';
import { isDeepStrictEqual as same } from 'node:util';
import { qualificationMessage } from '../../src/worker/admission.mjs';
import { NX_AUDIT, nxH3Mode } from '../nx-legacy/layout.mjs';
import { guestBoundary, unitIsGone } from '../engine-qualification/integration-host.mjs';
import { legacySliceGone } from '../engine-qualification/legacy-slice.mjs';
import { nxLaunch, checkNxObserver, writeNxReceipt } from '../nx-legacy/authority.mjs';
import { roundTripR1 } from '../engine-qualification/integration.mjs';
import { h3Dispatch, h3Qualified } from './session.mjs';
import { runH3Peer, exact, requireH3 } from './wire.mjs';
import { nxWorkerProfile } from './nx-profile.mjs';
import { startNativeWorkerRole } from './nx-worker-launch.mjs';
import { signNxRestoration } from './nx-signer.mjs';
import { requireNativeH3Admission } from './native-gate.mjs';

async function main() {
  requireNativeH3Admission();
  requireH3(process.argv.length===2,'H3_NX_PEER_USAGE');
  guestBoundary(nxH3Mode);
  const launch=nxLaunch();
  const {options,relayGid}=nxWorkerProfile(launch,import.meta.url,'nx-peer.mjs');
  const qualified=h3Qualified(options,()=>{throw Error('H3_NX_PEER_NOT_CONTROLLER');});
  const socketPath=NX_AUDIT+'/transport.sock';
  const broker=createServer({allowHalfOpen:false});
  broker.maxConnections=1;
  const session=new AbortController();
  const deadline=AbortSignal.timeout(Math.max(1,Math.min(160000,qualified.claim.expiresAt-Date.now())));
  const signal=AbortSignal.any([session.signal,deadline]);
  let socket,role,roleExited=false;
  try {
    role=await startNativeWorkerRole({options,qualified,signal});
    writeNxReceipt('h3-role-attestation.json',role.identity);
    const active=role.signal;
    broker.listen({path:socketPath,signal:active});
    await once(broker,'listening',{signal:active});
    chownSync(socketPath,0,relayGid);
    chmodSync(socketPath,0o660);
    const pinned=lstatSync(socketPath);
    console.log('ACM_H3_NX_SOCKET_READY');
    [socket]=await once(broker,'connection',{signal:active});
    const actual=lstatSync(socketPath);
    requireH3(actual.ino===pinned.ino&&actual.dev===pinned.dev&&actual.uid===0&&actual.gid===relayGid&&
      (actual.mode&0o777)===0o660,'H3_NX_SOCKET_PIN');
    broker.close();
    // 不因斷線或中止開第二個連線；原本稽核及持久意圖交由管理者保全。
    socket.once('error',()=>session.abort());
    socket.once('end',()=>session.abort());
    socket.once('close',()=>session.abort());
    const stop=()=>socket.destroy();
    active.addEventListener('abort',stop,{once:true});
    const dispatch=h3Dispatch({qualified,restorePublicKey:options.restorationAuthorityPublicKey,
      context:options.target,
      async sealWorker(kind,value) {
        const receipt=await role.call({action:'seal',kind,value});
        requireH3(exact(receipt,['value','signature'])&&same(receipt.value,value)&&
          /^[a-f0-9]{128}$/u.test(receipt.signature)&&verify(null,qualificationMessage(kind,value),
            options.workerPublicKey,Buffer.from(receipt.signature,'hex')),'H3_ROLE_SIGNATURE');
        if(kind==='TERMINAL')writeNxReceipt('h3-terminal.json',receipt);
        return receipt;
      },
      dispatchReady(){
        checkNxObserver(launch);
        requireH3(unitIsGone()&&legacySliceGone(),'H3_NX_NOT_IDLE');
      },
      recordIntent(binding){
        checkNxObserver(launch);
        writeNxReceipt('h3-dispatch-intent.json',{binding,bridgePid:process.pid,rolePid:role.identity.pid,launch:launch.value.operation});
      },
      async execute(args) {
        const result=await roundTripR1({...args,directory:NX_AUDIT+'/work',runtime:options.target.runtime,mode:nxH3Mode});
        checkNxObserver(launch);
        // 由 R1 執行的實際結果取得真實證據，與 Worker 收到的回覆 payload 相互核對。
        writeNxReceipt('h3-engine-committed.json',{binding:args.binding,engine:result.engine,restoration:result.restoration,
          outputSha256:createHash('sha256').update(result.terminal.output).digest('hex'),usage:result.terminal.usage});
        return result;
      },
      async authorizeRestore(value,abort) {
        abort.throwIfAborted();
        checkNxObserver(launch);
        writeNxReceipt('h3-restore-sign-request.json',value);
        const response=signNxRestoration({qualified,options});
        writeNxReceipt('h3-product-restore.json',response);
        return response;
      },
    });
    try {
      await runH3Peer({input:socket,output:socket,pin:qualified.pin,controllerPublicKey:options.controllerPublicKey,
        workerPublicKey:options.workerPublicKey,
        async observeRequest(envelope) {
          requireH3(await role.call({action:'request',envelope})===null,'H3_ROLE_REQUEST_PROTOCOL');
        },
        async sealReply(frame) {
          const response=await role.call({action:'reply',frame});
          if(frame.sequence===3) {
            await role.close(true);
            roleExited=true;
            checkNxObserver(launch);
            writeNxReceipt('h3-role-exit.json',{...role.identity,reaped:true});
          }
          return response;
        },
        dispatch,signal:active});
      console.log('ACM_H3_INTEGRATION='+JSON.stringify({verdict:'NX_H3_WORKER_ACCEPT_LIMITED',
        mode:nxH3Mode,operation:options.target.operation,release:launch.value.releaseSha256}));
    }finally{active.removeEventListener('abort',stop);}
  } finally {
    socket?.end();
    broker.close();
    if(role&&!roleExited)await role.close().catch(()=>{});
  }
}

try{ await main(); }
catch(error) {
  console.error('ACM_H3_NX_HOLD '+(/^[A-Z0-9_]{1,64}$/u.test(error?.code??error?.message)?error.code??error.message:'H3_NX_ERROR'));
  process.exitCode=42;
}
