import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,readFileSync,readdirSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
export const LEGACY_SLICE='acmlegacycpu.slice';
export const LEGACY_GROUP='/sys/fs/cgroup/'+LEGACY_SLICE;
export const LEGACY_SERVICE='/'+LEGACY_SLICE+'/acm-rc2-engine-readiness.service';
const env={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'};
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const text=path=>readFileSync(path,'utf8').trim();
const state=()=>Object.fromEntries(execFileSync('/usr/bin/systemctl',['show',LEGACY_SLICE,'--property=LoadState',
  '--property=ActiveState','--property=ControlGroup','--property=StopWhenUnneeded'],{encoding:'utf8',env,timeout:3000})
  .trim().split('\n').map(row=>row.split('=')));
export function rejectLocalOnlyEvents(){
  const row=text('/proc/self/mountinfo').split('\n').map(line=>line.split(' - '))
    .find(([left,right])=>left.split(' ')[4]==='/sys/fs/cgroup'&&right?.startsWith('cgroup2 '));
  need(row&&!row[1].split(' ')[2].split(',').includes('memory_localevents'),'LEGACY_HIERARCHICAL_EVENTS_REQUIRED');
}
export function legacySliceGone(){return !existsSync(LEGACY_GROUP);}
export async function startLegacySlice(){
  rejectLocalOnlyEvents();need(legacySliceGone(),'LEGACY_SLICE_ALREADY_PRESENT');
  const properties=[['Description','s','ACM isolated bounded CPU fixture'],['StopWhenUnneeded','b','false'],
    ['CPUAccounting','b','true'],['CPUQuotaPerSecUSec','t','1000000'],['CPUQuotaPeriodUSec','t','100000'],
    ['MemoryAccounting','b','true'],['MemoryMax','t','1610612736'],['MemoryHigh','t','1476395008'],
    ['MemorySwapMax','t','0'],['TasksAccounting','b','true'],['TasksMax','t','64']];
  execFileSync('/usr/bin/busctl',['call','org.freedesktop.systemd1','/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager','StartTransientUnit','ssa(sv)a(sa(sv))',LEGACY_SLICE,'fail',
    String(properties.length),...properties.flat(),'0'],{env,stdio:'ignore',timeout:5000});
  for(let until=performance.now()+3000;performance.now()<until;){
    if(existsSync(LEGACY_GROUP)&&state().ActiveState==='active'){
      const current=state();need(current.ControlGroup==='/'+LEGACY_SLICE&&current.StopWhenUnneeded==='no','LEGACY_SLICE_UNIT');
      const s=lstatSync(LEGACY_GROUP);return {dev:String(s.dev),ino:String(s.ino)};
    }
    await delay(30);
  }
  throw Object.assign(Error('LEGACY_SLICE_START_TIMEOUT'),{code:'LEGACY_SLICE_START_TIMEOUT'});
}
export async function stopLegacySlice(pin){
  if(legacySliceGone())return;
  const s=lstatSync(LEGACY_GROUP);
  need(pin&&String(s.dev)===pin.dev&&String(s.ino)===pin.ino&&state().ControlGroup==='/'+LEGACY_SLICE,
    'LEGACY_SLICE_IDENTITY');
  need(text(LEGACY_GROUP+'/cgroup.procs')===''&&text(LEGACY_GROUP+'/cgroup.events').includes('populated 0')&&
    !readdirSync(LEGACY_GROUP,{withFileTypes:true}).some(row=>row.isDirectory()),'LEGACY_SLICE_NOT_EMPTY');
  execFileSync('/usr/bin/systemctl',['stop',LEGACY_SLICE],{env,stdio:'ignore',timeout:5000});
  for(let until=performance.now()+3000;performance.now()<until;){if(legacySliceGone())return;await delay(30);}
  throw Object.assign(Error('LEGACY_SLICE_NOT_RELEASED'),{code:'LEGACY_SLICE_NOT_RELEASED'});
}
