import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import {openController} from './src/controller.mjs';
import {createHttpApp} from './src/http-app.mjs';
import {openSettings} from './src/settings.mjs';
import {openTelemetry} from './src/telemetry.mjs';
import {createLocalMonitor} from './src/local-monitor.mjs';
import {createObservationStore} from './src/observation-store.mjs';

const listeningHost='127.0.0.1';


export async function startService(configPath,{requiredConfigSha256,audit=row=>process.stdout.write('ACM_AUDIT='+JSON.stringify(row)+'\n')}={}){

  const [major,minor,patch]=process.versions.node.split('.').map(Number);
  if (major!==24 || minor<22 || minor===22 && patch<3 || !process.versions.sqlite) throw Error('NODE_COMPATIBILITY_REQUIRED');

  const {options,tokens,legacy,dataDir,verifyRegistry,recordStorageReady,release}=openSettings(configPath,{requiredConfigSha256});
  let controller,telemetry,server,timer,stop;
  const close=()=>stop??=(async()=>{
    clearInterval(timer);
    const ending=server?.listening?new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())):null;
    server?.closeIdleConnections();
    const grace=setTimeout(()=>server?.closeAllConnections(),2000);
    grace.unref();
    try {
      const results=await Promise.allSettled([ending,controller?.close()]);
      const failure=results.find(result=>result.status==='rejected');
      if (failure) throw failure.reason;
      telemetry?.close();
      release();
    } finally {
      clearTimeout(grace);
    }
  })();
  try{
    const {mode,nodes,maxConcurrent,port,monitoring={}}=options;
    if (monitoring.windowsLocal&&process.platform!=='win32') throw Error('WINDOWS_MONITOR_PLATFORM_REQUIRED');
    controller=openController({dataDir,mode,nodes,maxConcurrent});
    telemetry=openTelemetry(dataDir);
    recordStorageReady();
    const observations=createObservationStore({sources:monitoring.sources,telemetry});
    const localMonitor=monitoring.windowsLocal?createLocalMonitor(dataDir):null;
    const scheduledIds=new Set(controller.nodes().map(node=>node.id.toLowerCase()));
    const monitoredIds=[...(localMonitor?['windows-local']:[]),...observations.nodes().map(node=>node.id.toLowerCase())];
    if (monitoredIds.some(id=>scheduledIds.has(id))) throw Error('MONITORING_NODE_COLLISION');
    server=createHttpApp({controller,mode,tokens,verifyRegistry,telemetry,legacy,audit,
      observations:observations.nodes,telemetryIngress:observations.ingest});
    server.listen({host:listeningHost,port,exclusive:true});
    await once(server,'listening');
    if (mode==='simulation'||localMonitor){
      function collect() {
        if (localMonitor) observations.setLocal(localMonitor());
        if (mode==='simulation') telemetry.record(controller.nodes());
      }
      collect();
      timer=setInterval(()=>{
        try {
          if (!verifyRegistry()) throw Error('SESSION_INTEGRITY_CHANGED');
          collect();
        }catch{close().catch(()=>console.error('ACM_STOP_HOLD 安裝資料仍需核對'));}
      },5000);
      timer.unref();
    }
    return {server,close,info:{host:listeningHost,port:server.address().port,mode,pid:process.pid}};
  } catch(cause){
    await close();
    throw cause;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url){
  try {
    const [, , flag,configPath,...extra]=process.argv;
    if (flag!=='--config'||!configPath||extra.length) throw Error('EXPECTED_CONFIG_ARGUMENT');
    const service=await startService(configPath);
    const stop=()=>service.close().catch(()=>{process.exitCode=1;console.error('ACM_STOP_HOLD 安裝資料仍需核對');});
    process.once('SIGINT',stop);
    process.once('SIGTERM',stop);
    console.log('ACM_LISTEN='+JSON.stringify(service.info));
  } catch(cause){
    // 啟動診斷只發布內部固定錯誤識別，不回傳例外內的配置或機密。
    const message=/^[A-Z0-9_]+$/.test(cause?.message ?? '') ? cause.message : cause?.code==='EADDRINUSE'
      ? 'PORT_ALREADY_IN_USE' : 'STARTUP_VALIDATION_FAILED';
    console.error('ACM_START_HOLD '+message);
    process.exitCode=1;
  }
}
