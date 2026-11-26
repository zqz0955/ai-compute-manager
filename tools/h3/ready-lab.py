"""Exercise the fixed READY-only SSH service in the disposable offline ARM64 guest."""
import base64
import hashlib
from pathlib import Path
import json
import os
import pwd
import shutil
import subprocess
import time
import tarfile
import uuid

CODE=Path('/opt/acm-r3-code')
NODE=CODE/'runtime/node'
TOOLS=CODE/'tools/h3'
STAGE=Path('/opt/acm-h3-ready-stage-v1')
ROOT=Path('/opt/acm-h3-ready-v1')
AUDIT=Path('/opt/acm-h3-ready-audit-v1')
USER='acm-h3-ready'
ENV={'PATH':'/usr/bin:/usr/sbin:/bin','LANG':'C','LC_ALL':'C'}


def emit(name,data):
    print(name+'='+json.dumps(data,sort_keys=True),flush=True)


def run(*args, **kwargs):
    result=subprocess.run(args,capture_output=True,text=True,timeout=60,env=ENV,**kwargs)
    if result.returncode:
        print((result.stderr or result.stdout)[-2400:],flush=True)
        result.check_returncode()
    return result.stdout.strip()


def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f,'sha256').hexdigest()


def main():
    assert os.getuid()==0 and os.uname().machine=='aarch64'
    assert 'QEMU' in Path('/sys/class/dmi/id/product_name').read_text()
    assert not any(row.split()[1]=='00000000' for row in Path('/proc/net/route').read_text().splitlines()[1:])
    assert set(p.name for p in Path('/sys/class/net').iterdir()) <= {'lo','enp0s1','enp0s2','ens2'}
    assert shutil.which('sshd',path=ENV['PATH'])=='/usr/sbin/sshd'
    assert not any(p.exists() for p in (STAGE,ROOT,AUDIT))
    privsep_created=not Path('/run/sshd').exists()
    if privsep_created:
        Path('/run/sshd').mkdir(mode=0o755)
        Path('/run/sshd').chmod(0o755)
    STAGE.mkdir(mode=0o700)
    subprocess.run(['/usr/sbin/useradd','-M','-d','/nonexistent','-s','/bin/sh','-p','*','-U',USER],
                   check=True,env=ENV,timeout=15)
    role=pwd.getpwnam(USER)
    hostpub={}
    for name in ('host_key','ssh-identity','other_identity'):
        run('/usr/bin/ssh-keygen','-q','-t','ed25519','-C','','-N','','-f',str(STAGE/name))
        hostpub[name]=(STAGE/(name+'.pub')).read_text().strip()
    (STAGE/'host_key').chmod(0o400)
    role_script="""
    import {generateKeyPairSync} from 'node:crypto';
    import {writeFileSync} from 'node:fs';
    const keys={};
    for(const label of ['probe','controller']){
      const pair=generateKeyPairSync('ed25519');
      writeFileSync(label+'.pem',pair.privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o400});
      keys[label]=pair.publicKey.export({type:'spki',format:'der'}).toString('hex');
    }
    console.log(JSON.stringify(keys));
    """
    keys=json.loads(run(str(NODE),'--input-type=module','-e',role_script,cwd=STAGE))
    (STAGE/'known_hosts').write_text('acm-h3-target '+hostpub['host_key']+'\n')
    (STAGE/'wrong_hosts').write_text('acm-h3-target '+hostpub['other_identity']+'\n')
    now=int(time.time()*1000)
    plan={'version':1,'scope':'ACM_H3_ZERO_GENERATION_V1','operation':str(uuid.uuid4()),
          'deviceSha256':hashlib.sha256(Path('/etc/machine-id').read_text().strip().encode()).hexdigest(),
          'boot':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
          'sshHostSha256':hashlib.sha256(base64.b64decode(hostpub['host_key'].split()[1])).hexdigest(),
          'nodeSha256':digest(NODE),'controllerKey':keys['controller'],'probeKey':keys['probe'],
          'notBefore':now-5000,'expiresAt':now+170000,'uid':role.pw_uid,'gid':role.pw_gid}
    site={'plan':plan,'listen':'127.0.0.1','controller':'127.0.0.1','authorizedKey':hostpub['ssh-identity'],
          'sshdSha256':digest(Path('/usr/sbin/sshd'))}
    (STAGE/'site.json').write_text(json.dumps(site))
    (STAGE/'site.json').chmod(0o400)
    admin=STAGE/'ready-admin.py'
    shutil.copyfile(TOOLS/'ready-admin.py',admin)
    admin.chmod(0o444)
    path=STAGE/'bundle.tar'
    with tarfile.open(path,'x',format=tarfile.USTAR_FORMAT) as archive:
        for src in (NODE, *(TOOLS/name for name in ('ready-service.mjs','ready-protocol.mjs','wire.mjs'))):
            row=archive.gettarinfo(src,arcname=src.name)
            assert row.isfile() and row.uid==row.gid==0
            with src.open('rb') as source:
                archive.addfile(row,source)
    path.chmod(0o400)
    invoke=('/usr/bin/python3','-I','-B',str(admin))
    started=False
    result=None
    try:
        run(*invoke,'install',digest(path),digest(STAGE/'site.json'))
        run(*invoke,'check')
        run('/usr/sbin/sshd','-t','-f',str(ROOT/'sshd.conf'))
        run(*invoke,'start',digest(STAGE/'site.json'))
        started=True
        for _ in range(80):
            started_state=run('/usr/bin/systemctl','show','acm-h3-ready-v1.service','--property=SubState','--value')
            if started_state=='running':
                break
            time.sleep(0.1)
        time.sleep(0.7)
        result=json.loads(run(str(NODE),str(TOOLS/'ready-lab-client.mjs')))
    finally:
        if started:
            run(*invoke,'stop')
        if ROOT.exists() and (ROOT/'install.json').exists():
            for _ in range(50):
                if run('/usr/bin/systemctl','show','acm-h3-ready-v1.service','--property=LoadState','--value')=='not-found':
                    break
                time.sleep(0.1)
            run(*invoke,'cleanup')
        if privsep_created:
            Path('/run/sshd').rmdir()
    assert result['status']=='PASS_AUTHENTICATED_ZERO_GENERATION' and not ROOT.exists()
    audit=json.loads((AUDIT/'record.json').read_bytes())
    assert audit['marker']['operation']==plan['operation'] and audit['generationRequests']==0
    emit('ACM_H3_READY_LAB',{'status':'PASS','generationRequests':0,'arch':'aarch64','guest':'QEMU','nativeSshd':True,
                           'separateProbeUid':role.pw_uid>0,'unitAndInstallRemoved':True,
                           'retainedOnceMarker':True,'handshake':result})


if __name__=='__main__':
    os.umask(0o077)
    main()
