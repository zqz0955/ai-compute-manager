"""Fixed zero-generation OpenSSH sidecar. Production SSH configuration stays outside this tool."""
from hashlib import sha256
import base64
import ipaddress
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time

ROOT = Path('/opt/acm-h3-ready-v1')
STAGE = Path('/opt/acm-h3-ready-stage-v1')
AUDIT = Path('/opt/acm-h3-ready-audit-v1')
USER = 'acm-h3-ready'
PORT = 38322
UNIT = 'acm-h3-ready-v1.service'
NODE_SHA = '8f9c2a55879e9705cb285b6cdd649d95df642c6720f052cb30f300d2677da99f'
FILES = ('node', 'ready-service.mjs', 'ready-protocol.mjs', 'wire.mjs')
EXTRA = ('plan.json', 'sshd.conf', 'authorized_keys', 'host_key', 'probe.pem')
HEX = re.compile('[a-f0-9]{64}')
ENV = {'PATH': '/usr/bin:/usr/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
COMMAND = f'{ROOT}/node {ROOT}/ready-service.mjs'
SSHD_ARGS = ('/usr/sbin/sshd', '-D', '-e', '-f', str(ROOT/'sshd.conf'))


def need(valid, code):
    if not valid:
        raise ValueError(code)


def call(*args):
    return subprocess.run(args, env=ENV, check=True, capture_output=True, text=True, timeout=20).stdout


def file(path, uid=0, modes=(0o400, 0o444), limit=140_000_000):
    s = path.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_uid == uid and s.st_nlink == 1 and
         path.resolve(strict=True) == path and 0 < s.st_size <= limit and stat.S_IMODE(s.st_mode) in modes,
         'H3_READY_INSTALL_FILE')
    return s


def info(path):
    s = path.lstat()
    return [s.st_dev, s.st_ino, s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode)]


def host_name(value):
    ip = ipaddress.IPv4Address(value)
    first,second,*_=ip.packed
    need(str(ip)==value and (first in (127,10) or first==172 and 16<=second<=31 or
         first==192 and second==168), 'H3_READY_PRIVATE_ADDRESS')
    return value


def public_key(key):
    parts = key.split()
    need(len(parts)==2 and parts[0]=='ssh-ed25519' and re.fullmatch('[A-Za-z0-9+/]{68}',parts[1]),
         'H3_READY_SSH_KEY_FORMAT')
    raw = base64.b64decode(parts[1], validate=True)
    need(raw.startswith(bytes.fromhex('0000000b')+b'ssh-ed25519'+bytes.fromhex('00000020')) and
         len(raw)==51, 'H3_READY_SSH_KEY_BLOB')
    return raw


def config(site):
    return '\n'.join((
        'AddressFamily inet', f'Port {PORT}', 'ListenAddress '+host_name(site['listen']),
        'HostKey '+str(ROOT/'host_key'), 'HostKeyAlgorithms ssh-ed25519', 'PubkeyAcceptedAlgorithms ssh-ed25519',
        'PidFile none', 'UseDNS no', 'UsePAM no', 'StrictModes yes',
        'AuthorizedKeysFile '+str(ROOT/'authorized_keys'), 'AuthorizedKeysCommand none',
        'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PermitEmptyPasswords no',
        'HostbasedAuthentication no', 'GSSAPIAuthentication no', 'AuthenticationMethods publickey',
        'PermitRootLogin no', 'AllowUsers '+USER+'@'+host_name(site['controller']),
        'PermitTTY no', 'X11Forwarding no', 'AllowAgentForwarding no', 'AllowTcpForwarding no',
        'AllowStreamLocalForwarding no', 'DisableForwarding yes', 'PermitTunnel no', 'GatewayPorts no',
        'PermitUserRC no', 'PermitUserEnvironment no', 'ForceCommand '+COMMAND,
        'MaxAuthTries 1', 'MaxSessions 1', 'MaxStartups 3', 'LoginGraceTime 10', 'LogLevel VERBOSE', '',
    ))


def digest(path):
    result=sha256()
    with path.open('rb') as stream:
        while block := stream.read(1024*1024):
            result.update(block)
    return result.hexdigest()


def write(path, value, mode=0o444, role=None):
    raw = value if isinstance(value, bytes) else (json.dumps(value,sort_keys=True)+'\n').encode()
    fd = os.open(path, os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd,'wb') as out:
        out.write(raw)
        if role:
            os.fchown(out.fileno(), *role)
        os.fchmod(out.fileno(),mode)
        out.flush()
        os.fsync(out.fileno())


def sync(path):
    fd = os.open(path, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def record(path):
    return info(path)+[path.stat().st_size,digest(path)]


def known_user(plan):
    user = pwd.getpwnam(USER)
    role = (user.pw_uid,user.pw_gid)
    shadow=[row.split(':')[1] for row in Path('/etc/shadow').read_text().splitlines()
            if row.split(':',1)[0]==USER]
    need(shadow==['*'] and not os.path.lexists(user.pw_dir) and role == (plan['uid'],plan['gid']) and all(type(x) is int and 0<x<65535 for x in role) and
         set(os.getgrouplist(USER,user.pw_gid))=={user.pw_gid} and user.pw_dir=='/nonexistent' and
         user.pw_shell=='/bin/sh','H3_READY_DEDICATED_ACCOUNT')
    return role


def install(bundle_sha, site_sha):
    need(HEX.fullmatch(bundle_sha) and HEX.fullmatch(site_sha) and
         Path(__file__).resolve(strict=True)==STAGE/'ready-admin.py' and info(STAGE)[2:]==[0,0,0o700],
         'H3_READY_STAGE_BOUNDARY')
    site_path=STAGE/'site.json'
    file(site_path, limit=8192)
    need(digest(site_path)==site_sha,'H3_READY_SITE_PIN')
    site=json.loads(site_path.read_bytes())
    need(set(site)=={'plan','listen','controller','authorizedKey','sshdSha256'} and HEX.fullmatch(site['sshdSha256']) and
         digest(Path(SSHD_ARGS[0]))==site['sshdSha256'],'H3_READY_SITE_SCHEMA')
    plan=site['plan']
    role=known_user(plan)
    need(HEX.fullmatch(plan['deviceSha256']) and sha256(Path('/etc/machine-id').read_text().strip().encode()).hexdigest()==plan['deviceSha256'] and
         Path('/proc/sys/kernel/random/boot_id').read_text().strip()==plan['boot'] and plan['nodeSha256']==NODE_SHA and
         type(plan['notBefore']) is int and type(plan['expiresAt']) is int and 0<plan['expiresAt']-plan['notBefore']<=1_800_000 and
         plan['notBefore']<=int(time.time()*1000)<plan['expiresAt'], 'H3_READY_SITE_IDENTITY')
    conf=config(site)
    public_key(site['authorizedKey'])
    for name in ('host_key','probe.pem'):
        file(STAGE/name, modes=(0o400,),limit=4096)
    host=' '.join(call('/usr/bin/ssh-keygen','-y','-f',str(STAGE/'host_key')).split()[:2])
    need(sha256(public_key(host)).hexdigest()==plan['sshHostSha256'], 'H3_READY_HOST_PIN')
    bundle=STAGE/'bundle.tar'
    file(bundle)
    need(digest(bundle)==bundle_sha, 'H3_READY_ARCHIVE_PIN')
    need(unit()['LoadState']=='not-found','H3_READY_UNIT_OCCUPIED')
    with tarfile.open(bundle, 'r:') as archive:
        entries=archive.getmembers()
        need(len(entries)==len(FILES) and {row.name for row in entries}==set(FILES) and
             all(row.isfile() and row.uid==row.gid==0 and row.size>0 and row.size<=
                 (124_000_000 if row.name=='node' else 128_000) for row in entries), 'H3_READY_ARCHIVE_INVENTORY')
        ROOT.mkdir(mode=0o755)
        ROOT.chmod(0o755)
        for name in FILES:
            with (ROOT/name).open('xb') as output, archive.extractfile(name) as source:
                shutil.copyfileobj(source,output)
                output.flush()
                os.fsync(output.fileno())
            (ROOT/name).chmod(0o555 if name=='node' else 0o444)
    need(digest(ROOT/'node')==NODE_SHA,'H3_READY_NODE_PIN')
    # 檢查 Node 的原生計畫結構與專用 Ed25519 金鑰配對。
    write(ROOT/'plan.json',plan)
    check="import {createPublicKey,createPrivateKey} from 'node:crypto';import {readFileSync} from 'node:fs';import {probePlan,probePublicKey} from './ready-protocol.mjs';const p=probePlan(JSON.parse(readFileSync('plan.json')));if(!createPublicKey(createPrivateKey(readFileSync(process.argv[1]))).equals(probePublicKey(p.probeKey)))process.exit(42);"
    subprocess.run([ROOT/'node','--input-type=module','-e',check,STAGE/'probe.pem'],cwd=ROOT,check=True,env=ENV,timeout=20)
    write(ROOT/'sshd.conf',conf.encode())
    write(ROOT/'authorized_keys',('restrict '+site['authorizedKey']+'\n').encode())
    write(ROOT/'host_key',(STAGE/'host_key').read_bytes(),0o400)
    write(ROOT/'probe.pem',(STAGE/'probe.pem').read_bytes(),0o400,role)
    state=ROOT/'state'
    state.mkdir(mode=0o700)
    os.chown(state,*role)
    script_sha=digest(STAGE/'ready-admin.py')
    write(ROOT/'install.json',{'root':info(ROOT),'state':info(state),'script':script_sha,
        'files':{name:record(ROOT/name) for name in FILES+EXTRA},
        'siteSha256':site_sha,'bundleSha256':bundle_sha,'sshdSha256':site['sshdSha256'],
        'role':list(role),'operation':plan['operation'],'expiresAt':plan['expiresAt']},0o400)
    sync(ROOT)
    sync(ROOT.parent)


def audit_tree():
    path=ROOT/'install.json'
    file(path,modes=(0o400,),limit=8192)
    value=json.loads(path.read_bytes())
    need(info(ROOT)==value['root'] and info(ROOT/'state')==value['state'] and
         ROOT.resolve(strict=True)==ROOT and not ROOT.is_symlink() and not (ROOT/'state').is_symlink() and
         digest(STAGE/'ready-admin.py')==value['script'] and set(value['files'])==set(FILES+EXTRA) and
         set(x.name for x in ROOT.iterdir())=={'install.json','state',*FILES,*EXTRA} and not any(
           (row.split()[4]==str(ROOT) or row.split()[4].startswith(str(ROOT)+'/'))
           for row in Path('/proc/self/mountinfo').read_text().splitlines()), 'H3_READY_CLEANUP_BOUNDARY')
    for name, pin in value['files'].items():
        file(ROOT/name,uid=value['role'][0] if name=='probe.pem' else 0,modes=(0o400,0o444,0o555))
        need(record(ROOT/name)==pin,'H3_READY_INSTALLED_DRIFT')
    return value


def unit():
    fields=('LoadState','ActiveState','Transient','ExecStart')
    result=subprocess.run(['/usr/bin/systemctl','show',UNIT,*('--property='+key for key in fields)],
        env=ENV,capture_output=True,text=True,timeout=20)
    value=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
    need('LoadState' in value and (result.returncode==0 or
         result.returncode==1 and value['LoadState']=='not-found'),'H3_READY_UNIT_QUERY')
    return value


def start(value, approve_site):
    need(approve_site==value['siteSha256'] and digest(Path(SSHD_ARGS[0]))==value['sshdSha256'] and
         unit()['LoadState']=='not-found' and not tuple((ROOT/'state').iterdir()),'H3_READY_START_APPROVAL')
    plan=json.loads((ROOT/'plan.json').read_bytes())
    known_user(plan)
    need(not role_process_exists(plan['uid']),'H3_READY_ROLE_ALREADY_RUNNING')
    privsep=Path('/run/sshd')
    need(privsep.is_dir() and not privsep.is_symlink() and info(privsep)[2:4]==[0,0] and
         not info(privsep)[4]&0o022,'H3_READY_PRIVSEP_DIRECTORY')
    try:
        call(SSHD_ARGS[0],'-t','-f',SSHD_ARGS[-1])
        actual=call(SSHD_ARGS[0],'-T','-f',SSHD_ARGS[-1])
    except subprocess.SubprocessError as exc:
        raise ValueError('H3_READY_SSHD_CONFIG_TEST') from exc
    need(all(line in actual.splitlines() for line in (
        'forcecommand '+COMMAND,'disableforwarding yes','permittty no','permitrootlogin no',
        'passwordauthentication no','kbdinteractiveauthentication no','authenticationmethods publickey',
        'port '+str(PORT),'authorizedkeysfile '+str(ROOT/'authorized_keys'))),'H3_READY_EFFECTIVE_CONFIG')
    left=(value['expiresAt']-int(time.time()*1000))//1000 - 2
    need(5<left<=1800 and plan['notBefore']<=int(time.time()*1000), 'H3_READY_WINDOW')
    call('/usr/bin/systemd-run','--unit='+UNIT,'--collect','--property=RuntimeMaxSec='+str(left),
         '--property=KillMode=control-group','--property=TasksMax=24','--property=MemoryMax=256M',
         '--property=NoNewPrivileges=yes','--property=ProtectHome=yes',
         '--property=ProtectSystem=strict','--property=ReadWritePaths='+str(ROOT/'state'),*SSHD_ARGS)


def stop():
    state=unit()
    if state['LoadState']=='not-found':
        return
    need(state['Transient']=='yes' and 'argv[]='+' '.join(SSHD_ARGS)+' ;' in state['ExecStart'],
         'H3_READY_UNIT_IDENTITY')
    call('/usr/bin/systemctl','stop',UNIT)


def role_process_exists(uid):
    return any(str(uid) in row.split()[1:]
               for path in Path('/proc').glob('[0-9]*/status')
               for row in process_status(path) if row.startswith('Uid:'))


def cleanup(value):
    need(unit()['LoadState']=='not-found' and not role_process_exists(value['role'][0]), 'H3_READY_CLEANUP_ACTIVE')
    state=ROOT/'state'
    names=set(x.name for x in state.iterdir())
    need(names in (set(),{'used.json'}), 'H3_READY_STATE_UNKNOWN')
    marker=None
    if names:
        file(state/'used.json',uid=value['role'][0],limit=4096)
        marker=json.loads((state/'used.json').read_bytes())
        need(set(marker)=={'operation','nonce'} and marker['operation']==value['operation'] and HEX.fullmatch(marker['nonce']),
             'H3_READY_STATE_INVALID')
    AUDIT.mkdir(mode=0o700)
    write(AUDIT/'record.json',{'operation':value['operation'],'siteSha256':value['siteSha256'],
          'bundleSha256':value['bundleSha256'],'marker':marker,'generationRequests':0},0o400)
    sync(AUDIT)
    if marker is not None:
        (state/'used.json').unlink()
    state.rmdir()
    for name in FILES+EXTRA+('install.json',):
        (ROOT/name).unlink()
    ROOT.rmdir()
    sync(ROOT.parent)


def process_status(path):
    try:
        return path.read_text().splitlines()
    except FileNotFoundError:
        return ()


def main(args):
    need(sys.flags.isolated and sys.dont_write_bytecode and os.geteuid()==0 and os.getegid()==0 and
         platform.machine()=='aarch64' and Path('/proc/1/comm').read_text().strip()=='systemd' and
         Path(__file__).resolve(strict=True)==STAGE/'ready-admin.py' and info(STAGE)[2:]==[0,0,0o700] and
         info(Path('/opt'))[2:4]==[0,0] and not info(Path('/opt'))[4]&0o022 and not os.path.lexists(AUDIT),
         'H3_READY_ADMIN_BOUNDARY')
    file(STAGE/'ready-admin.py')
    if len(args)==3 and args[0]=='install':
        install(args[1],args[2])
    else:
        value=audit_tree()
        if len(args)==2 and args[0]=='start':
            start(value,args[1])
        elif args==['stop']:
            stop()
        elif args==['cleanup']:
            cleanup(value)
        else:
            need(args==['check'], 'H3_READY_ADMIN_USAGE')
    print(json.dumps({'status':'OK','action':args[0],'generationRequests':0}))


if __name__=='__main__':
    try:
        main(sys.argv[1:])
    except (OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError,tarfile.TarError) as exc:
        code=str(exc)
        print('H3_READY_ADMIN_HOLD '+(code if re.fullmatch('[A-Z0-9_]{3,80}',code) else 'H3_READY_ADMIN_BOUNDARY'),
              file=sys.stderr)
        raise SystemExit(42) from None
