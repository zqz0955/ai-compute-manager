import {existsSync,readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {createLegacySliceWatch} from './legacy-slice-watch.mjs';
import {readLegacySliceSample,readLegacyTail} from './legacy-tail.mjs';
import {startLegacySlice,stopLegacySlice} from './legacy-slice.mjs';
const kind=process.argv[2];
if(process.argv.length!==3||!['faults','tail'].includes(kind))throw Error('LEGACY_PROBE_MODE');
const input='/opt/acm-r3-code/legacy-tail-probe-input-'+kind+'.json';
const abort='/opt/acm-r3-code/legacy-tail-probe-abort-'+kind;
const pin=await startLegacySlice();
const watcher=kind==='tail'?createLegacySliceWatch({read:readLegacySliceSample,
  onFailure:diagnostic=>console.log('ACM_LEGACY_OUTER_PROBE_FAILURE='+JSON.stringify(diagnostic))}):null;
console.log('ACM_LEGACY_SLICE_READY='+JSON.stringify({status:'READY',pin}));
try{
  const deadline=performance.now()+60000;
  while(!existsSync(input)&&!existsSync(abort)&&performance.now()<deadline)await delay(5);
  if(!existsSync(input))throw Error('LEGACY_TAIL_PROBE_INPUT_TIMEOUT');
  const record=JSON.parse(readFileSync(input,'utf8'));
  if(kind==='tail'){
    const tail=readLegacyTail(record.evidence,record.baseline,watcher);
    console.log('ACM_LEGACY_RETAINED_TAIL='+JSON.stringify({status:'PASS',generationRequests:0,tail}));
  }else console.log('ACM_LEGACY_ACTIVE_CLEANUP='+JSON.stringify({status:'PASS_OWNED_FAULT_CLEANUP',generationRequests:0}));
}finally{watcher?.stop();await stopLegacySlice(pin);}
