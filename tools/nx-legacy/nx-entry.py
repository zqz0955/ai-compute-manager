"""管理者專用的 NX 單次入口。入口及輔助模組須先由操作者固定雜湊。"""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import subprocess
import sys
import time

HERE = Path(__file__).absolute()
H3 = next((mode for mode in ('json','sse') if any(
    HERE == Path('/opt/acm-nx-h3-'+mode+tail+'/code/tools/nx-legacy/nx-entry.py')
    for tail in ('-v1','-stage-v1'))), None)
PROFILE = 'acm-nx-h3-'+H3 if H3 else 'acm-nx-legacy-cpu'
ROOT = Path('/opt/'+PROFILE+'-v1')
STAGE = Path('/opt/'+PROFILE+'-stage-v1')
AUDIT = Path('/opt/'+PROFILE+'-audit-v1')
CONTROL = Path('/opt/'+PROFILE+'-control-v1')
CG = Path('/sys/fs/cgroup')
SLICE = 'acmlegacycpu.slice'
UNIT = 'acm-rc2-engine-readiness.service'
GROUP = CG / SLICE
MODE = 'LEGACY_KERNEL_BOUNDED_CPU_V1'
TOOLS = 'code/tools/nx-legacy/'
NODE = ROOT / 'code/runtime/node'
ENTRY = ROOT / ('code/tools/h3/nx-peer.mjs' if H3 else 'code/tools/engine-qualification/integration.mjs')
HEX = re.compile('[0-9a-f]{64}')
UUID = re.compile('[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}')
NAME = re.compile('[A-Za-z0-9_.+-]+')
LIMITS = {'memory.max':'1610612736','memory.high':'1476395008','memory.swap.max':'0',
          'pids.max':'64','cpu.max':'100000 100000'}
MOUNTS = ('dev-hugepages.mount','dev-mqueue.mount','sys-fs-fuse-connections.mount',
          'sys-kernel-config.mount','sys-kernel-debug.mount','sys-kernel-tracing.mount')


def load(name, path, raw=None):
    spec = importlib.util.spec_from_loader(name, loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__file__ = str(path)
    exec(compile(raw if raw is not None else path.read_bytes(), str(path), 'exec'), module.__dict__)
    return module


def need(value, code):
    if not value:
        raise RuntimeError(code)


def text(path):
    return Path(path).read_text(encoding='utf8').strip()


def shape(value, fields):
    return isinstance(value, dict) and set(value) == set(fields.split())


def emit(event, **fields):
    print('ACM_NX_LEGACY_'+event+'='+json.dumps(fields, sort_keys=True), flush=True)


def sync_dir(path):
    with filesys.directory_handle(path) as fd:
        os.fsync(fd)


def write_once(path, value, raw=False):
    data = value if raw else json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
    with path.with_suffix(path.suffix+'.pending').open('xb') as out:
        out.write(data)
        os.fchmod(out.fileno(), 0o400)
        out.flush()
        os.fsync(out.fileno())
    os.link(path.with_suffix(path.suffix+'.pending'), path, follow_symlinks=False)
    path.with_suffix(path.suffix+'.pending').unlink()
    sync_dir(path.parent)
    return filesys.sha(data)


def small(path):
    raw, _ = filesys.read_asset(path, keep=True)
    return json.loads(raw), filesys.sha(raw)


def heartbeat(launch):
    path=AUDIT/'heartbeat.json'
    temporary=AUDIT/'heartbeat-next.json'
    with temporary.open('xb') as out:
        os.fchmod(out.fileno(),0o400)
        out.write(json.dumps({'operation':launch['operation'],'monotonicMs':time.monotonic_ns()//1000000}).encode())
        out.flush()
    os.replace(temporary,path)


def secure_record(path, expected=None):
    actual, identity = filesys.read_asset(path, expected)
    return {'sha256':actual, 'id':identity}


def items(base, expected, extras=()):
    files = set(expected)
    dirs = {'.', *extras}
    for name in files:
        dirs.update(p.as_posix() for p in Path(name).parents)
    observed = {'files':{}, 'directories':{}}
    for parent, subs, names in os.walk(base, followlinks=False):
        parent = Path(parent)
        with filesys.directory_handle(parent) as fd:
            key = parent.relative_to(base).as_posix()
            need(key in dirs, 'UNKNOWN_RELEASE_DIRECTORY')
            observed['directories'][key] = filesys.directory_id(fd)
        for sub in subs:
            filesys.directory(parent/sub)
        for name in names:
            path = parent/name
            relative = path.relative_to(base).as_posix()
            need(relative in files, 'UNKNOWN_RELEASE_FILE')
            observed['files'][relative] = secure_record(path, expected[relative])
    need(set(observed['files']) == files and set(observed['directories']) == dirs, 'RELEASE_INVENTORY')
    return observed


def check_window(approval, now, remaining=300):
    need(shape(approval, 'ref managerConsent workWindowConfirmed purpose notBefore expires') and
         approval['purpose'] == MODE and approval['managerConsent'] is True and approval['workWindowConfirmed'] is True and
         isinstance(approval['ref'],str) and 0 < len(approval['ref'].strip()) <= 160 and
         type(approval['notBefore']) is int and type(approval['expires']) is int and
         0 < approval['expires']-approval['notBefore'] <= 1800 and approval['notBefore'] <= now and
         approval['expires']-now >= remaining, 'NX_APPROVAL_WINDOW')


def manifest_members(base, manifest_sha):
    manifest, parsed = small(base/'files.json')
    need(parsed == manifest_sha and shape(manifest,'mode files nativeEvidenceSha256') and
         manifest['mode'] == MODE and bool(HEX.fullmatch(manifest['nativeEvidenceSha256'])), 'NX_MANIFEST_PIN')
    members = manifest['files']
    need(isinstance(members,dict) and 10 < len(members) <= 200 and
         all(isinstance(name,str) and all(x not in ('.','..') and NAME.fullmatch(x) for x in name.split('/')) and
             name.startswith(('code/','engine/')) and shape(row,'sha256 size mode') and
             bool(HEX.fullmatch(row['sha256'])) and type(row['size']) is int and 0 < row['size'] <= 512*1024**2 and
             row['mode'] in (0o444,0o555) for name,row in members.items()), 'NX_MANIFEST_SCHEMA')
    need(members['code/runtime/node']['sha256'] == '8f9c2a55879e9705cb285b6cdd649d95df642c6720f052cb30f300d2677da99f' and
         members['engine/assets/ollama/bin/ollama']['sha256'] == '645f7c676bac5d81332c43e5ef9d3acd792bc4391404582301c3f29eaf06c3ee',
         'NX_RUNTIME_PIN')
    return members


def release(base, manifest_sha, policy_sha):
    policy_path = base/'release.json' if base == STAGE else AUDIT/'release.json'
    policy, pinned = small(policy_path)
    need(pinned == policy_sha and stat.S_IMODE(policy_path.stat().st_mode) == 0o400 and
         shape(policy,'mode manifestSha256 machineSha256 hostKeyFingerprint desktop acceptForceCharge acceptNonPSI acceptParentCPUDelegation') and
         policy['mode'] == MODE and policy['manifestSha256'] == manifest_sha and
         all(policy[k] is True for k in ('acceptForceCharge','acceptNonPSI','acceptParentCPUDelegation')) and
         policy['machineSha256'] == filesys.sha(text('/etc/machine-id').encode()), 'NX_RELEASE_NOT_BOUND')
    return policy


def platform(host_pin):
    release_id = text('/etc/nv_tegra_release')
    host = filesys.call('/usr/bin/ssh-keygen','-lf','/etc/ssh/ssh_host_ed25519_key.pub')
    manager = filesys.call('/usr/bin/systemctl','--version')
    need(os.uname().machine=='aarch64' and os.uname().release=='5.15.148-tegra' and
         'Orin NX' in text('/proc/device-tree/model') and re.search(r'# R36 .*REVISION: 4\.3,',release_id) and
         os.confstr('CS_GNU_LIBC_VERSION')=='glibc 2.35' and Path('/lib/ld-linux-aarch64.so.1').is_file() and
         text('/proc/1/comm')=='systemd' and manager.returncode==0 and re.search(r'^systemd 249\b',manager.stdout) and
         host.returncode==0 and re.fullmatch('SHA256:[A-Za-z0-9+/]{43}',host_pin) and host_pin in host.stdout.split(),
         'NX_PLATFORM_IDENTITY')
    mount = [part.split(' - ',1)[1].split() for part in text('/proc/self/mountinfo').splitlines()
             if part.split()[4] == str(CG)]
    need(len(mount)==1 and mount[0][0]=='cgroup2' and 'memory_localevents' not in mount[0][2].split(',') and
         {'cpu','memory','pids'} <= set(text(CG/'cgroup.controllers').split()), 'NX_CGROUP_INTERFACE')


def inventory(base, members):
    expected = {**members,'files.json':None}
    return items(base,{**expected,'release.json':None} if base==STAGE else expected,
                 () if base==STAGE else ('engine/engine-work','engine/assets/models/manifests-v2'))


def absent_units(obs):
    s, u = obs.unit(SLICE),obs.unit(UNIT)
    need(not os.path.lexists(GROUP) and s['ActiveState']=='inactive' and not s['ControlGroup'] and
         not s['FragmentPath'] and not s['DropInPaths'] and s['Transient']=='no' and u['LoadState']=='not-found',
         'NX_UNIT_SLOT')


def cancelled(launch):
    path=AUDIT/'cancel.json'
    if not os.path.lexists(path):
        return False
    value,_=small(path)
    need(value=={'operation':launch['operation']},'NX_CANCEL_IDENTITY')
    return True


def topology(obs):
    rows = obs.topology()
    for relative,row in rows.items():
        path = CG/relative if relative!='/' else CG
        info = path.lstat()
        need(stat.S_ISDIR(info.st_mode),'NX_GROUP_IDENTITY')
        row['id']=[info.st_dev,info.st_ino]
    for name in MOUNTS:
        slot=obs.unit(name)
        need(slot['ControlGroup']=='/'+name and slot['LoadState']=='loaded','NX_MOUNT_IDENTITY')
        group=CG/name
        need(text(group/'pids.max')=='18452' and text(group/'pids.current')=='0' and text(group/'pids.events')=='max 0',
             'NX_MOUNT_BASELINE')
        info=group.lstat()
        rows[name]={
            'id':[info.st_dev,info.st_ino],'invocation':slot['InvocationID'],
            **{key:obs.optional(group/key) for key in ('cpu.max','cpu.weight','memory.max','pids.max')}}
    return rows


def snapshot(base,members):
    obs,desktop,guard=observers(base,members,{'desktop':None})
    start=previous=first=None
    try:
        for index in range(13):
            if index:
                time.sleep(5)
            ids=desktop.host_device_ids()
            row=obs.sample('/sys/devices/platform/17000000.gpu/load',
                           lambda fd,target:desktop.device_fd(fd,target,ids))
            carrying=[r for r in row['process']['processes'] if r['gpuCameraFDs']]
            selected={role:[r for r in carrying if r['exe']==role] for role in desktop.ROLE_NAMES}
            need(len(carrying)==3 and all(len(value)==1 for value in selected.values()) and
                 not any(row['process'][name] for name in ('unreadable','realtime','idConflicts')),
                 'NX_DESKTOP_UNQUALIFIED')
            user=desktop.logind('show-user','1000',('Display',))
            session,holders=desktop.desktop_snapshot({'Id':user['Display']},
                [selected[role][0] for role in desktop.ROLE_NAMES],desktop.PROFILE_NX)
            current={'schema':1,'profile':desktop.PROFILE_NX,'boot':desktop.read_boot(),
                     'session':session,'holders':holders,'approval':None}
            need(start is None or desktop.canonical(current)==desktop.canonical(start),'NX_DESKTOP_CHANGED')
            guard.verify_open_descriptions(holders)
            guard.started=True
            desktop.verify_session_unchanged(session,holders[0],desktop.PROFILE_NX)
            row['desktop']={'status':'MATCH'}
            need(not obs.interval_reasons(previous,row,first or row),'NX_HOST_WINDOW_CHANGED')
            start,previous,first=current,row,first or row
            emit('SNAPSHOT_PROGRESS',sample=index+1,total=13)
        emit('DESKTOP_UNAPPROVED', **start)
    finally:
        guard.close()


def observers(base, members, policy):
    def pinned(name):
        relative = TOOLS+name+'.py'
        raw,_ = filesys.read_asset(base/relative,members[relative],keep=True)
        return load(name,base/relative,raw)
    obs,desktop = pinned('nx_observe'),pinned('nx_desktop')
    obs.SLICE,obs.SERVICE,obs.PARENT = SLICE,UNIT,GROUP/UNIT
    desktop.PURPOSE = MODE
    return obs,desktop,desktop.DesktopGuard(policy['desktop'],'ORIN_NX')


def observation(obs, desktop, guard, prior, first):
    guard.permission()
    ids = desktop.host_device_ids()
    row = obs.sample('/sys/devices/platform/17000000.gpu/load',
                     lambda fd,target:desktop.device_fd(fd,target,ids))
    row['desktop']=guard.qualify(row['process']['processes'])
    reasons=obs.interval_reasons(prior,row,first or row)
    need(row['desktop']['status']=='MATCH' and not reasons, 'NX_HOST_WINDOW_CHANGED')
    return row


def preflight(obs,desktop,guard):
    absent_units(obs)
    obs.no_id_collision()
    need(set(text(CG/'cgroup.subtree_control').split())=={'memory','pids'},'NX_PARENT_BASELINE')
    guard.permission(375)
    first = previous = None
    for index in range(13):
        if index:
            time.sleep(5)
        previous=observation(obs,desktop,guard,previous,first)
        first=first or previous
        emit('PREFLIGHT', sample=index+1, total=13)
    scope=obs.model_scope(previous['services']['ollama.service'])
    need(scope['modelRoot']=='/usr/share/ollama/.ollama/models','NX_MODEL_SCOPE')
    memory=re.search(r'^MemAvailable:\s+(\d+)\s+kB$',text('/proc/meminfo'),re.M)
    need(memory and int(memory[1])*1024>=6*1024**3,'NX_MEMORY_HEADROOM')
    guard.permission(300)
    return first,previous,topology(obs),scope


def install(members, manifest_sha, policy_sha):
    stage_ids=inventory(STAGE,members)
    need(stage_ids['directories']['.'][4]==0o700 and not any(os.path.lexists(p) for p in (ROOT,AUDIT)),
         'NX_STAGE_OR_RESIDUAL')
    policy_raw,_=filesys.read_asset(STAGE/'release.json',keep=True)
    manifest_raw,_=filesys.read_asset(STAGE/'files.json',keep=True)
    need(filesys.sha(policy_raw)==policy_sha and filesys.sha(manifest_raw)==manifest_sha,'NX_STAGING_DRIFT')
    free=os.statvfs(STAGE.parent)
    need(free.f_bavail*free.f_frsize>=sum(row['size'] for row in members.values())+256*1024**2,'NX_STORAGE_HEADROOM')
    AUDIT.mkdir(mode=0o711)
    sync_dir(AUDIT.parent)
    write_once(AUDIT/'release.json',policy_raw,raw=True)
    ROOT.mkdir(mode=0o755)
    sync_dir(ROOT.parent)
    with filesys.directory_handle(ROOT) as folder:
        destination=filesys.directory_id(folder)
    write_once(AUDIT/'installation-intent.json',{'stage':stage_ids,'destination':destination,
               'manifest':manifest_sha,'policy':policy_sha})
    for name,record in members.items():
        target=ROOT/name
        target.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
        with target.open('xb') as out:
            filesys.read_asset(STAGE/name,record,destination=out)
            os.fchmod(out.fileno(),record['mode'])
            out.flush()
            os.fsync(out.fileno())
    with (ROOT/'files.json').open('xb') as out:
        out.write(manifest_raw)
        os.fchmod(out.fileno(),0o444)
        out.flush()
        os.fsync(out.fileno())
    (ROOT/'engine/engine-work').mkdir(mode=0o755)
    (ROOT/'engine/assets/models/manifests-v2').mkdir(mode=0o755)
    installed=inventory(ROOT,members)
    for name in installed['directories']:
        sync_dir(ROOT/name)
    write_once(AUDIT/'installation.json',{'stage':stage_ids,'root':installed,'manifest':manifest_sha,'policy':policy_sha})
    emit('INSTALLED',files=len(members))


def owned_stop(obs,launch):
    slot=obs.unit(UNIT)
    if slot['LoadState']!='not-found':
        need(slot['Transient']=='yes' and slot['ControlGroup']=='/'+SLICE+'/'+UNIT and
             'ACM_NX_OPERATION='+launch['operation'] in slot['Environment'].split(),'NX_FOREIGN_UNIT')
        need(filesys.call('/usr/bin/systemctl','stop','--',UNIT,timeout=12).returncode==0,'NX_STOP_FAILED')
    if GROUP.exists():
        pin,_=small(AUDIT/'slice.json')
        disk=GROUP.lstat()
        need(pin=={'operation':launch['operation'],'dev':str(disk.st_dev),'ino':str(disk.st_ino)} and
             obs.unit(SLICE)['Transient']=='yes' and text(GROUP/'cgroup.procs')=='' and
             'populated 0' in text(GROUP/'cgroup.events').splitlines() and
             not any(p.is_dir() for p in GROUP.iterdir()),'NX_RESIDUAL_SLICE')
        need(filesys.call('/usr/bin/systemctl','stop','--',SLICE,timeout=8).returncode==0,'NX_SLICE_STOP_FAILED')
    absent_units(obs)


def approve_restore(obs,launch,before,first,last,request,request_sha):
    need(shape(request,'operation releaseSha256 invocation topologySha256 memoryTailSha256 jobId attemptId evidenceSha256 workerPid') and
         request['operation']==launch['operation'] and request['releaseSha256']==launch['releaseSha256'] and
         all(HEX.fullmatch(request[k]) for k in ('topologySha256','memoryTailSha256','evidenceSha256')) and
         re.fullmatch('[a-f0-9]{32}',request['invocation']) and
         all(UUID.fullmatch(request[k]) for k in ('jobId','attemptId')) and
         type(request['workerPid']) is int and request['workerPid']>1 and not Path('/proc',str(request['workerPid'])).exists(),
         'NX_RESTORE_REQUEST')
    need(not cancelled(launch),'NX_CANCELLED')
    absent_units(obs)
    obs.no_id_collision()
    after=topology(obs)
    need(before==after and first['services']==last['services'],'NX_HOST_RESTORE_DRIFT')
    evidence=write_once(AUDIT/'host-restored.json',{'after':after,'services':last['services'],'requestSha256':request_sha})
    write_once(AUDIT/'restore-approved.json',{'operation':launch['operation'],'requestSha256':request_sha,
               'hostEvidenceSha256':evidence})


def start(obs,desktop,guard,members,policy,manifest_sha,policy_sha,h3_plan_sha=None):
    install_pin,_=small(AUDIT/'installation.json')
    need(install_pin['manifest']==manifest_sha and install_pin['policy']==policy_sha and
         inventory(ROOT,members)==install_pin['root'] and inventory(STAGE,members)==install_pin['stage'],
         'NX_INSTALLED_OBJECT_DRIFT')
    need(not os.path.lexists(AUDIT/'launch.json'),'NX_ONCE_CONSUMED')
    first,last,before,scope=preflight(obs,desktop,guard)
    result=filesys.call(str(NODE),'-p',"JSON.stringify([process.arch,process.version,require('node:sqlite').DatabaseSync.name])")
    need(result.returncode==0 and json.loads(result.stdout)==['arm64','v24.22.3','DatabaseSync'],'NX_NATIVE_RUNTIME')
    launch={'boot':text('/proc/sys/kernel/random/boot_id'),'pid':os.getpid(),
            'parentStart':text('/proc/self/stat').rsplit(')',1)[1].split()[19],
            'releaseSha256':policy_sha,'operation':secrets.token_hex(16),'resource':policy['machineSha256'],
            'approval':policy['desktop']['approval']}
    check_window(launch['approval'],time.time())
    if H3:
        with filesys.directory_handle(CONTROL) as fd:
            need(stat.S_IMODE(os.fstat(fd).st_mode)==0o700,'H3_CONTROL_MODE')
        _, actual=small(CONTROL/'plan.json')
        need(actual==h3_plan_sha,'H3_PLAN_PIN')
        launch.update(manifestSha256=manifest_sha,h3PlanSha256=h3_plan_sha)
    write_once(AUDIT/'baseline.json',{'topology':before,'services':first['services'],'modelScope':scope})
    write_once(AUDIT/'launch.json',launch)
    (AUDIT/'work').mkdir(mode=0o700)
    worker=AUDIT/'worker'
    worker.mkdir(mode=0o700)
    os.chown(worker,65201,65201)
    sync_dir(AUDIT)
    heartbeat(launch)
    with (AUDIT/'execution.log').open('xb') as log:
        os.fchmod(log.fileno(),0o400)
        argv=[str(NODE),str(ENTRY),*([] if H3 else ['legacy-json'])]
        child=subprocess.Popen(argv,env=filesys.ENV,stdin=subprocess.DEVNULL,
                               stdout=log,stderr=subprocess.STDOUT,close_fds=True)
        restored=False
        try:
            deadline=time.monotonic()+170
            index=0
            while child.poll() is None:
                need(time.monotonic()<deadline,'NX_SUPERVISOR_DEADLINE')
                need(not cancelled(launch),'NX_CANCELLED')
                last=observation(obs,desktop,guard,last,first)
                heartbeat(launch)
                index+=1
                emit('OBSERVE', sample=index, elapsed=round(170-(deadline-time.monotonic()),1))
                if not restored and (AUDIT/'restore-request.json').exists():
                    request,request_sha=small(AUDIT/'restore-request.json')
                    approve_restore(obs,launch,before,first,last,request,request_sha)
                    restored=True
                time.sleep(1)
            need(child.returncode==0 and restored,'NX_EXECUTION_HOLD')
            absent_units(obs)
            need(topology(obs)==before,'NX_HOST_RESTORE_DRIFT')
            log.flush()
            os.fsync(log.fileno())
            with open(log.name,'rb') as content:
                execution=content.read(20*1024**2+1)
            verdict=b'"verdict":"NX_H3_WORKER_ACCEPT_LIMITED"' if H3 else b'"verdict":"NX_LEGACY_BOUNDED_CPU_ACCEPT_LIMITED"'
            need(len(execution)<=20*1024**2 and execution.count(verdict)==1,'NX_SUCCESS_RECEIPT_MISSING')
            write_once(AUDIT/'complete.json',{'operation':launch['operation'],'executionSha256':filesys.sha(execution),
                       'releaseSha256':policy_sha,'baseline':before})
            emit('COMPLETE', operation=launch['operation'])
        finally:
            try:
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=10)
            finally:
                try:
                    owned_stop(obs,launch)
                finally:
                    log.flush()
                    os.fsync(log.fileno())


def cleanup(obs,members,policy_sha):
    launch,_=small(AUDIT/'launch.json')
    complete,_=small(AUDIT/'complete.json')
    initial,_=small(AUDIT/'installation.json')
    baseline,_=small(AUDIT/'baseline.json')
    asked,asked_sha=small(AUDIT/'restore-request.json')
    grant,_=small(AUDIT/'restore-approved.json')
    _,host_sha=small(AUDIT/'host-restored.json')
    need(launch['boot']==text('/proc/sys/kernel/random/boot_id') and complete['operation']==launch['operation'] and
         launch['releaseSha256']==complete['releaseSha256']==policy_sha and topology(obs)==baseline['topology'] and
         {name:obs.public_unit(name) for name in obs.BASE_UNITS}==baseline['services'],'NX_CLEANUP_RESTORE_REQUIRED')
    need(asked['releaseSha256']==policy_sha and asked['operation']==launch['operation'] and
         grant=={'operation':launch['operation'],'requestSha256':asked_sha,'hostEvidenceSha256':host_sha} and
         secure_record(AUDIT/'execution.log')['sha256']==complete['executionSha256'],'NX_CLEANUP_EVIDENCE_CHANGED')
    absent_units(obs)
    obs.no_id_collision()
    targets=[(STAGE,initial['stage']),(ROOT,initial['root'])]
    for path,pins in targets:
        need(inventory(path,members)==pins,'NX_CLEANUP_OBJECT_DRIFT')
    filesys.verify_no_holder([(p,{'files':{n:r['id'] for n,r in pins['files'].items()},
                                'directories':pins['directories']},()) for p,pins in targets])
    write_once(AUDIT/'cleanup-intent.json',{'targets':[str(p) for p,_ in targets],'operation':launch['operation'],
               'installation':initial})
    for path,pins in targets:
        for name,row in pins['files'].items():
            leaf=Path(name)
            with filesys.directory_handle(path/leaf.parent) as parent:
                need(filesys.directory_id(parent)==pins['directories'][leaf.parent.as_posix()] and
                     filesys.file_id(os.stat(leaf.name,dir_fd=parent,follow_symlinks=False))==row['id'],
                     'NX_CLEANUP_FILE_REPLACED')
                os.unlink(leaf.name,dir_fd=parent)
                os.fsync(parent)
        for name in sorted(pins['directories'],key=lambda n:len(Path(n).parts),reverse=True):
            target=path/name
            with filesys.directory_handle(target.parent) as parent,filesys.directory_handle(target) as child:
                need(filesys.directory_id(child)==pins['directories'][name] and
                     (name=='.' or filesys.directory_id(parent)==pins['directories'][Path(name).parent.as_posix()]),
                     'NX_CLEANUP_DIR_REPLACED')
                os.rmdir(target.name,dir_fd=parent)
                os.fsync(parent)
    write_once(AUDIT/'cleanup.json',{'removed':[str(p) for p,_ in targets],'operation':launch['operation']})
    emit('CLEANED', auditRetained=True)


def main():
    global filesys
    need(sys.platform=='linux' and os.getuid()==os.getgid()==os.geteuid()==os.getegid()==0 and
         sys.flags.isolated and sys.dont_write_bytecode and len(sys.argv) in (4,5),'NX_ROOT_FIXED_ENTRY')
    verb,manifest_sha,policy_sha,*h3plan=sys.argv[1:]
    need((len(h3plan)==1 and HEX.fullmatch(h3plan[0])) if H3 and verb=='qualify-once' else not h3plan,'H3_USAGE')
    need(verb in ('snapshot','check','install','qualify-once','stop','cleanup') and HEX.fullmatch(manifest_sha) and
         (re.fullmatch('SHA256:[A-Za-z0-9+/]{43}',policy_sha) if verb=='snapshot' else HEX.fullmatch(policy_sha)),'NX_USAGE')
    # H3 實機的角色隔離與跨主機通道仍待驗收。不得安裝、綁定或消耗一次性資格。
    need(not H3 or verb not in ('install','qualify-once'),'H3_NATIVE_ROLE_SEPARATION_PENDING')
    base=STAGE if verb in ('snapshot','check','install') else ROOT
    entry=Path(__file__).absolute()
    need(entry==base/TOOLS/'nx-entry.py' and entry.resolve(strict=True)==entry,'NX_ENTRY_LOCATION')
    # 啟動者先核對入口摘要。輔助檔在載入前再由固定清單與 root 祖先共同約束。
    for path in reversed([entry,*entry.parents]):
        st=path.lstat()
        need(not path.is_symlink() and st.st_uid==st.st_gid==0 and not st.st_mode&0o022,'NX_ENTRY_ANCESTOR')
    raw=(base/'files.json').read_bytes()
    import hashlib
    need(hashlib.sha256(raw).hexdigest()==manifest_sha,'NX_BOOTSTRAP_MANIFEST')
    helper=base/TOOLS/'protected_files.py'
    helper_raw=helper.read_bytes()
    need(hashlib.sha256(helper_raw).hexdigest()==json.loads(raw)['files'][TOOLS+'protected_files.py']['sha256'],
         'NX_BOOTSTRAP_HELPER')
    filesys=load('protected_files',helper,helper_raw)
    members=manifest_members(base,manifest_sha)
    need(filesys.read_asset(entry,members[TOOLS+'nx-entry.py'])[0]==members[TOOLS+'nx-entry.py']['sha256'],
         'NX_ENTRY_PIN')
    if verb=='snapshot':
        platform(policy_sha)
        snapshot(base,members)
        return
    policy=release(base,manifest_sha,policy_sha)
    platform(policy['hostKeyFingerprint'])
    obs,desktop,guard=observers(base,members,policy)
    try:
        if verb in ('check','install'):
            check_window(policy['desktop']['approval'],time.time())
            preflight(obs,desktop,guard)
            inventory(STAGE,members)
            if verb=='install':
                install(members,manifest_sha,policy_sha)
            else:
                emit('CHECKED', manifestSha256=manifest_sha, releaseSha256=policy_sha)
        elif verb=='qualify-once':
            start(obs,desktop,guard,members,policy,manifest_sha,policy_sha,h3plan[0] if h3plan else None)
        elif verb=='stop':
            launch,_=small(AUDIT/'launch.json')
            need(launch['releaseSha256']==policy_sha and launch['boot']==text('/proc/sys/kernel/random/boot_id'),
                 'NX_STOP_IDENTITY')
            if not cancelled(launch):
                write_once(AUDIT/'cancel.json',{'operation':launch['operation']})
            owned_stop(obs,launch)
            until=time.monotonic()+12
            while time.monotonic()<until:
                try:
                    ticks=text('/proc/'+str(launch['pid'])+'/stat').rsplit(')',1)[1].split()[19]
                except FileNotFoundError:
                    break
                if ticks!=launch['parentStart']:
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('NX_SUPERVISOR_STILL_HELD')
            absent_units(obs)
            obs.no_id_collision()
            emit('STOPPED', operation=launch['operation'])
        else:
            cleanup(obs,members,policy_sha)
    finally:
        guard.close()


if __name__ == '__main__':
    os.umask(0o022)
    for mark in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP):
        signal.signal(mark,lambda *_:need(False,'NX_INTERRUPTED'))
    try:
        main()
    except Exception as error:
        kind=str(error)
        emit('HOLD', code=kind if re.fullmatch('[A-Z0-9_]+',kind) else type(error).__name__)
        sys.exit(42)
