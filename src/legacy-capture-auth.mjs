import {sign,verify} from 'node:crypto';
import {canonicalBytes,hasFields,readAgentPublicKey} from '../agent/protocol.mjs';
import {IDENTIFIER,SHA256} from '../tools/config.mjs';
import {projectLegacyTelemetry} from './legacy-telemetry.mjs';

const error=()=>Error('LEGACY_OBSERVER_PROOF_REJECTED');
const domain=Buffer.from('ACM_ENROLLED_LEGACY_OBSERVER_V1\0');
const projections=Object.freeze(['health','node','models','resident']);
const recordKeys=['version','sourceIdentity','upstreamNodeId','challenge','frame'];
function bytes(payload){
  if (!hasFields(payload,recordKeys)||payload.version!==1||
      typeof payload.sourceIdentity!=='string'||!SHA256.test(payload.sourceIdentity)||
      typeof payload.upstreamNodeId!=='string'||!IDENTIFIER.test(payload.upstreamNodeId)||
      !canonicalBytes(payload.challenge,32)) throw error();
  const encoded=Buffer.from(JSON.stringify(recordKeys.map(key=>payload[key])));
  if (encoded.length>260000) throw error();
  return Buffer.concat([domain,encoded]);
}

// 由既有受信的觀測程序呼叫。resolveIdentity 必須透過受保護的作業系統入口核對上游服務身分。
export function createPinnedLegacyObserver({resolveIdentity,capture,sourceIdentity,privateKey,now=Date.now}){
  if (typeof resolveIdentity!=='function'||typeof capture!=='function'||typeof sourceIdentity!=='string'||
      !SHA256.test(sourceIdentity)||privateKey?.type!=='private'||privateKey.asymmetricKeyType!=='ed25519') throw error();
  return async({challenge,upstreamNodeId})=>{
    if (!canonicalBytes(challenge,32)||typeof upstreamNodeId!=='string'||!IDENTIFIER.test(upstreamNodeId)||
        await resolveIdentity()!==sourceIdentity) throw error();
    const frame=await capture({method:'GET',projections,upstreamNodeId});
    if (await resolveIdentity()!==sourceIdentity) throw error();
    projectLegacyTelemetry(frame,upstreamNodeId,now());
    const payload={version:1,sourceIdentity,upstreamNodeId,challenge,frame};
    return {payload,signature:sign(null,bytes(payload),privateKey).toString('base64url')};
  };
}

export function verifyLegacyCapture(envelope,{sourceIdentity,observerKey,upstreamNodeId,challenge,now=Date.now()}){
  if (!hasFields(envelope,['payload','signature'])) throw error();
  const payload=envelope.payload,signature=canonicalBytes(envelope.signature,64);
  if (!signature||payload?.sourceIdentity!==sourceIdentity||payload.upstreamNodeId!==upstreamNodeId||
      payload.challenge!==challenge||!verify(null,bytes(payload),readAgentPublicKey(observerKey),signature)) throw error();
  return projectLegacyTelemetry(payload.frame,upstreamNodeId,now);
}
