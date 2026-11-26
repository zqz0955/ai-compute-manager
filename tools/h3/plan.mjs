import { createPublicKey } from 'node:crypto';
import { exact, requireH3 } from './wire.mjs';

const publicKey = value => {
  requireH3(typeof value==='string' && /^[a-f0-9]{88}$/u.test(value),'H3_PLAN_PUBLIC_KEY');
  const key=createPublicKey({key:Buffer.from(value,'hex'),type:'spki',format:'der'});
  requireH3(key.asymmetricKeyType==='ed25519','H3_PLAN_PUBLIC_KEY');
  return key;
};

export function h3Plan(value, fields=[]) {
  requireH3(exact(value,['version','target','admission','keys',...fields])&&value.version===1&&
    exact(value.keys,['admission','worker','controller','restoration']),'H3_PLAN_SCHEMA');
  return {target:value.target,admission:value.admission,authorityPublicKey:publicKey(value.keys.admission),
    workerPublicKey:publicKey(value.keys.worker),controllerPublicKey:publicKey(value.keys.controller),
    restorationAuthorityPublicKey:publicKey(value.keys.restoration)};
}
