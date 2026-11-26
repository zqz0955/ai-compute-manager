import {cpus,freemem,totalmem} from 'node:os';
import {statfsSync} from 'node:fs';

function ticks(cores) {
  if (!cores.length || cores.some(cpu=>Object.values(cpu.times).some(value=>!Number.isFinite(value)))) return null;
  return {...cores.reduce(({idle,total},{times})=>({
    idle:idle+times.idle,total:total+Object.values(times).reduce((sum,value)=>sum+value,0)
  }),{idle:0,total:0}),cores:cores.length};
}

function bytes(value){
  return value>=0n&&value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):null;
}

export function createLocalMonitor(dataDir,{readCpus=cpus,readMemory=()=>[totalmem(),freemem()],
  readDisk=path=>statfsSync(path,{bigint:true}),now=Date.now}={}){
  let last=null;
  return function collect(){
    const sample=ticks(readCpus());
    let cpuPercent=null;
    if (sample && last && sample.cores===last.cores){
      const total=sample.total-last.total,idle=sample.idle-last.idle;
      if (total>0 && idle>=0 && idle<=total) cpuPercent=(total-idle)*100/total;
    }
    last=sample;
    const [total,free]=readMemory();
    const validMemory=Number.isSafeInteger(total)&&Number.isSafeInteger(free)&&total>=free&&free>=0;
    let diskBytes=null,diskUsedBytes=null;
    try {
      const disk=readDisk(dataDir);
      const block=disk.frsize>0n?disk.frsize:disk.bsize;
      if (block>0n&&disk.blocks>=disk.bfree&&disk.bfree>=0n) {
        diskBytes=bytes(block*disk.blocks);
        diskUsedBytes=bytes(block*(disk.blocks-disk.bfree));
      }
    } catch { /* 無法查核的磁碟維持 UNKNOWN。 */ }
    return {id:'windows-local',name:'Windows 本機',platform:'windows',status:'ONLINE',availability:'UNVERIFIED',
      source:'WINDOWS_LOCAL',identityVerified:true,aliases:[],cpuCores:sample?.cores??null,gpuBytes:null,
      gpu:{state:'UNKNOWN'},ramBytes:validMemory?total:null,diskBytes,swapBytes:null,
      metrics:{sampledAt:now(),cpuPercent,gpuPercent:null,gpuUsedBytes:null,temperatureC:null,swapUsedBytes:null,
        ramUsedBytes:validMemory?total-free:null,diskUsedBytes},models:null,resident:null};
  };
}
