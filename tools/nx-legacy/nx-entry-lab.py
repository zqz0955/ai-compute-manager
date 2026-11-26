"""Isolated QEMU-only native filesystem and role test. Never invokes the NX main entry."""
import hashlib
import json
import os
from pathlib import Path,PurePosixPath
import stat
import subprocess
import tarfile
from types import SimpleNamespace

CODE=Path('/opt/acm-r3-code')
ENV={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'}


def require(ok,code):
    if not ok:
        raise RuntimeError(code)


def main():
    require('QEMU' in Path('/sys/class/dmi/id/product_name').read_text() and os.uname().machine=='aarch64' and
            os.getuid()==os.getgid()==0 and not any(r.split()[1]=='00000000'
            for r in Path('/proc/net/route').read_text().splitlines()[1:]),'LAB_BOUNDARY')
    root=CODE/'tools/nx-legacy'
    from importlib.util import spec_from_file_location,module_from_spec
    spec=spec_from_file_location('nx_entry',root/'nx-entry.py')
    entry=module_from_spec(spec)
    spec.loader.exec_module(entry)
    entry.filesys=entry.load('protected_files',root/'protected_files.py')
    medium=Path('/dev/disk/by-id/virtio-ACMNXSTAGE')
    require(stat.S_ISBLK(medium.stat().st_mode) and
            Path('/sys/class/block',medium.resolve().name,'ro').read_text().strip()=='1','LAB_READONLY_MEDIA')
    entry.STAGE.mkdir(mode=0o700)
    with tarfile.open(medium,'r:') as stream:
        members=stream.getmembers()
        for row in members:
            name=PurePosixPath(row.name)
            require(row.isfile() and not name.is_absolute() and '..' not in name.parts and row.mode in (0o444,0o555),
                    'LAB_STAGE_MEMBER')
            target=entry.STAGE.joinpath(*name.parts)
            target.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
            with target.open('xb') as out,stream.extractfile(row) as inp:
                import shutil
                shutil.copyfileobj(inp,out)
                os.fchmod(out.fileno(),row.mode)
    pin=hashlib.sha256((entry.STAGE/'files.json').read_bytes()).hexdigest()
    files=entry.manifest_members(entry.STAGE,pin)
    require(files[entry.TOOLS+'nx-entry.py']['sha256']==hashlib.sha256((root/'nx-entry.py').read_bytes()).hexdigest(),
            'LAB_RUNNING_SOURCE')
    policy=entry.STAGE/'release.json'
    policy.write_bytes(b'{"labOnly":true}')
    policy.chmod(0o400)
    policy_sha=hashlib.sha256(policy.read_bytes()).hexdigest()
    entry.install(files,pin,policy_sha)
    initial,_=entry.small(entry.AUDIT/'installation.json')
    require(entry.inventory(entry.ROOT,files)==initial['root'],'LAB_STAGING_INVENTORY')
    unexpected=entry.ROOT/'unexpected'
    unexpected.write_bytes(b'fixture')
    try:
        entry.inventory(entry.ROOT,files)
    except RuntimeError as err:
        require(str(err)=='UNKNOWN_RELEASE_FILE','LAB_EXPECTED_UNKNOWN_OBJECT')
    else:
        raise RuntimeError('LAB_UNKNOWN_NOT_REJECTED')
    unexpected.unlink()
    (entry.ROOT/'engine/engine-work'/'foreign-file').symlink_to('/etc/hostname')
    try:
        entry.inventory(entry.ROOT,files)
    except RuntimeError as err:
        require(str(err)=='UNKNOWN_RELEASE_FILE','LAB_EXPECTED_LINK_REFUSAL')
    else:
        raise RuntimeError('LAB_LINK_NOT_REJECTED')
    (entry.ROOT/'engine/engine-work'/'foreign-file').unlink()
    worker=entry.AUDIT/'worker'
    worker.mkdir(mode=0o700)
    os.chown(worker,65201,65201)
    tool=entry.ROOT/'code/tools/nx-legacy/lab-worker.mjs'
    # 測試程式從已固定客體媒體複製。NX 發行資料不帶本測試入口。
    require(not tool.exists(),'LAB_CODE_COLLOCATION')
    tool.write_bytes((root/'lab-worker.mjs').read_bytes())
    tool.chmod(0o444)
    result=subprocess.run([str(entry.NODE),str(tool)],env=ENV,timeout=35,capture_output=True,text=True)
    print(result.stdout, end='',flush=True)
    print(result.stderr, end='',flush=True)
    require(result.returncode==0,'LAB_ROLE_CHECK')
    require(tool.read_bytes()==(root/'lab-worker.mjs').read_bytes(),'LAB_TOOL_DRIFT')
    tool.unlink()
    boot=entry.text('/proc/sys/kernel/random/boot_id')
    operation='2'*32
    entry.write_once(entry.AUDIT/'launch.json',{'operation':operation,'boot':boot,'releaseSha256':policy_sha})
    entry.write_once(entry.AUDIT/'baseline.json',{'topology':{'fixture':'before'},'services':{}})
    entry.topology=lambda _: {'fixture':'changed'}
    obs=SimpleNamespace(BASE_UNITS=(),no_id_collision=lambda:None)
    entry.absent_units=lambda _:None
    requested={'operation':operation,'releaseSha256':policy_sha,'invocation':'1'*32,
       'topologySha256':'2'*64,'memoryTailSha256':'3'*64,'evidenceSha256':'4'*64,'workerPid':4000000,
       'jobId':'01000000-0000-4000-8000-000000000000','attemptId':'02000000-0000-4000-8000-000000000000'}
    req_sha=entry.write_once(entry.AUDIT/'restore-request.json',requested)
    first={'services':{}}
    try:
        entry.approve_restore(obs,{'operation':operation,'releaseSha256':policy_sha},
                              {'fixture':'before'},first,first,requested,req_sha)
    except RuntimeError as err:
        require(str(err)=='NX_HOST_RESTORE_DRIFT','LAB_WRONG_HOLD')
    else:
        raise RuntimeError('LAB_DRIFT_NOT_REJECTED')
    require(not (entry.AUDIT/'restore-approved.json').exists(),'LAB_DRIFT_GRANTED')
    # 僅在客體注入已回復的觀測值，實際逐檔清理仍使用 NX 入口。
    entry.topology=lambda _: {'fixture':'before'}
    entry.approve_restore(obs,{'operation':operation,'releaseSha256':policy_sha},
                          {'fixture':'before'},first,first,requested,req_sha)
    log_sha=entry.write_once(entry.AUDIT/'execution.log',{'scope':'SIMULATED_RESTORE_ONLY'})
    entry.write_once(entry.AUDIT/'complete.json',{'operation':operation,'executionSha256':log_sha,'releaseSha256':policy_sha})
    entry.cleanup(obs,files,policy_sha)
    require(not entry.ROOT.exists() and not entry.STAGE.exists() and
            (entry.AUDIT/'launch.json').exists() and (worker/'upstream.sqlite').exists(),'LAB_CLEANUP_BOUNDARY')
    print('ACM_LEGACY_NX_ENTRY_LAB='+json.dumps({'status':'PASS','verifiedFiles':len(files),
          'installedModesNative':True,'stagingReadOnlyMedia':True,'unknownFileRejected':True,
          'objectLinkRejected':True,'restoreDriftRefused':True,'restoreObservationInjected':True,
          'exactCleanup':True,'onceReceiptAndWorkerDbRetained':True,
          'nxMainInvoked':False,'generationRequests':0,'kernel':os.uname().release}),flush=True)
