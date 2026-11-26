import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const h3Path=/^\/opt\/acm-nx-h3-(json|sse)-v1\/code\/tools\/nx-legacy\/layout\.mjs$/u.exec(fileURLToPath(import.meta.url));
export const nxH3Mode=h3Path?'legacy-'+h3Path[1]:null;
const nxProfile=h3Path?'acm-nx-h3-'+h3Path[1]:'acm-nx-legacy-cpu';
export const NX_ROOT='/opt/'+nxProfile+'-v1';
export const NX_ENGINE=NX_ROOT+'/engine';
export const NX_CODE=NX_ROOT+'/code';
export const NX_AUDIT='/opt/'+nxProfile+'-audit-v1';
export const NX_STAGE='/opt/'+nxProfile+'-stage-v1';
export const NX_CONTROL='/opt/'+nxProfile+'-control-v1';
export const nxInstalled=fileURLToPath(import.meta.url)===NX_CODE+'/tools/nx-legacy/layout.mjs';
export const NX_WORKER_UID=65201;
export const NX_ENGINE_UID=65202;
export const NX_H3_UID=65203;

export function checkNxDispatch(encoded, now=Date.now(), meminfo=()=>readFileSync('/proc/meminfo','utf8')){
  const {notBefore,expires}=JSON.parse(encoded??'null')??{};
  if(!Number.isSafeInteger(notBefore)||!Number.isSafeInteger(expires)||expires-notBefore>1800||
    now<notBefore*1000||expires*1000-now<300000)
    throw Object.assign(Error('NX_DISPATCH_WINDOW'),{code:'NX_DISPATCH_WINDOW'});
  const kb=/^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo());
  if(!kb||Number(kb[1])*1024<6*1024**3)
    throw Object.assign(Error('NX_MEMORY_HEADROOM'),{code:'NX_MEMORY_HEADROOM'});
}
