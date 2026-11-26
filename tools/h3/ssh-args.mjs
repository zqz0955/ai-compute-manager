import { isIPv4 } from 'node:net';
import { requireH3 } from './wire.mjs';

export function h3SshArgs({ host,user,port,identity,knownHosts,command }) {
  requireH3(typeof user==='string' && /^[a-z_][a-z0-9_-]{0,31}$/u.test(user) &&
    typeof host==='string' && /^[a-z0-9][a-z0-9.-]{0,252}$/iu.test(host) &&
    Number.isSafeInteger(port) && port>=1 && port<=65535 &&
    [identity,knownHosts].every(path=>typeof path==='string'&&!/["\r\n]/u.test(path)), 'H3_SSH_ARGUMENTS');
  return ['-F','none','-T',
    '-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes',
    '-o','UserKnownHostsFile="'+knownHosts.replaceAll('\\','/')+'"','-o','GlobalKnownHostsFile=none',
    '-o','HostKeyAlias=acm-h3-target','-o','HostKeyAlgorithms=ssh-ed25519','-o','ForwardAgent=no',
    '-o','ForwardX11=no','-o','ClearAllForwardings=yes','-o','ControlMaster=no','-o','UpdateHostKeys=no',
    '-o','VerifyHostKeyDNS=no','-o','ConnectTimeout=5','-o','ConnectionAttempts=1','-o','ServerAliveInterval=5',
    '-o','ServerAliveCountMax=1','-o','IdentityAgent=none','-o','IdentityFile=none','-o','CertificateFile=none',
    '-o','PreferredAuthentications=publickey','-i',identity,'-l',user,'-p',String(port),'--',host,command];
}

export function h3PrivateAddress(host) {
  if (!isIPv4(host)) return false;
  const [a,b] = host.split('.').map(Number);
  return a===127 || a===10 || a===172&&b>=16&&b<=31 || a===192&&b===168;
}
