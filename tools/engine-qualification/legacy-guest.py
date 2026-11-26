"""New bounded-memory qualification in an offline ARM64 guest; never runs on NX."""
import importlib.util
import hashlib
from contextlib import closing
import json
import os
from pathlib import Path
import subprocess
import shutil
import sqlite3
import stat
import sys
import time

CODE=Path('/opt/acm-r3-code')
ENV={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'}

def emit(tag,value):
    print(tag+'='+json.dumps(value,sort_keys=True),flush=True)

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod

def native_pressure():
    # 這是新建假壓力群組，不是模型容量數值；只驗證原生計數與退出訊號。
    body=r'''import os,json,time,subprocess
from pathlib import Path
root=Path('/sys/fs/cgroup/system.slice/acm-legacy-pressure.service')
read=lambda n:(root/n).read_text().strip()
counters=lambda n:dict((k,int(v)) for k,v in (line.split() for line in read(n).splitlines()))
base=counters('memory.events')
props={n:read(n) for n in ('memory.max','memory.high','memory.swap.max','pids.max','cpu.max')}
assert props['memory.max']=='100663296' and props['memory.high']=='50331648' and props['memory.swap.max']=='0' and props['pids.max']=='64'
high=subprocess.run(['/usr/bin/python3','-I','-B','-c','import time; a=bytearray(40*1024**2); time.sleep(1)'],timeout=15)
after_high=counters('memory.events')
assert high.returncode==0 and after_high['high']>base['high']
print('ACM_LEGACY_PRESSURE_PHASE='+json.dumps({'stage':'HIGH_VERIFIED','events':after_high}),flush=True)
# 只調整本合成壓力單元，避免high回收節流掩蓋hard-max/OOM探針；真模型配額不變。
(root/'memory.high').write_text('max')
oom=subprocess.run(['/usr/bin/python3','-I','-B','-c','a=bytearray(256*1024**2)'],timeout=15)
after=counters('memory.events')
assert oom.returncode==-9 and after['oom_kill']>after_high['oom_kill'] and after['max']>after_high['max']
print('ACM_LEGACY_PRESSURE='+json.dumps({'status':'PASS_NATIVE_EVENT_COUNTERS','highExit':high.returncode,'oomExit':oom.returncode,'before':base,'afterHigh':after_high,'afterOom':after,'limits':props,'oomProbeHigh':'max','modelLimitsChanged':False,'sampledMaximumIsNotPeak':True}),flush=True)
'''
    unit='acm-legacy-pressure.service'
    props={'Type':'exec','Restart':'no','CPUQuota':'100%','CPUQuotaPeriodSec':'100ms','MemoryMax':'100663296',
           'MemoryHigh':'50331648','MemorySwapMax':'0','TasksMax':'64','OOMPolicy':'continue','RuntimeMaxSec':'40s',
           'PrivateNetwork':'yes','PrivateDevices':'yes','DevicePolicy':'closed','NoNewPrivileges':'yes','KillMode':'control-group'}
    started=subprocess.run(['/usr/bin/systemd-run','--unit='+unit,'--wait','--collect','--pipe','--quiet',
        *['--property='+key+'='+value for key,value in props.items()],'/usr/bin/python3','-I','-B','-c',body],
        env=ENV,stdin=subprocess.DEVNULL,timeout=50)
    assert started.returncode==0
    end=time.monotonic()+5
    while Path('/sys/fs/cgroup/system.slice',unit).exists() and time.monotonic()<end:time.sleep(.1)
    assert not Path('/sys/fs/cgroup/system.slice',unit).exists()
    return {'pressureCounterProbe':'PASS','pressureUnitReleased':True}

def native_sampler_round(helper,kind):
    assert kind in ('faults','tail')
    source=CODE/'tools/engine-qualification/legacy-active-faults.mjs'
    props={'Type':'exec','Restart':'no','Delegate':'cpu memory pids','CPUQuotaPeriodSec':'100ms',
       'MemoryMax':'infinity','MemoryHigh':'infinity','MemorySwapMax':'infinity','TasksMax':'infinity','Slice':'acmlegacycpu.slice',
       'PrivateDevices':'yes','DevicePolicy':'closed','PrivateNetwork':'yes','PrivateIPC':'yes',
       'RestrictAddressFamilies':'AF_UNIX AF_INET','NoNewPrivileges':'yes','ProtectSystem':'strict','ProtectHome':'yes',
       'InaccessiblePaths':'-/tmp -/var/tmp -/usr/share/ollama -/var/lib/ollama -/root -/home',
       'TemporaryFileSystem':('/run:ro,nosuid,nodev,noexec,size=1M,mode=0555 '
          f'{helper.ROOT}/engine-work:size=128M,mode=0700,uid=65202,gid=65202'),
       'CapabilityBoundingSet':'CAP_SETUID CAP_SETGID CAP_CHOWN CAP_DAC_OVERRIDE CAP_KILL',
       'SystemCallFilter':'~io_uring_setup io_uring_enter io_uring_register','SystemCallErrorNumber':'EPERM',
       'UMask':'0077','RuntimeMaxSec':'35s','TimeoutStopSec':'8s','KillMode':'control-group','SendSIGKILL':'no'}
    binding={f'ACM_RC2_HOST_{kind.upper()}_NS':os.readlink('/proc/1/ns/'+kind) for kind in ('mnt','net','ipc')}
    binding.update(ACM_RC2_HOST_RUN_DEV=str(os.stat('/run').st_dev),ACM_RC2_METADATA_SHA=helper.sha(helper.ROOT/'readiness.mjs'),
        ACM_RC2_STDIO_SHA=helper.sha(helper.ROOT/'stdio-guard.py'),ACM_RC2_METADATA_PROBE='offline-metadata-v1')
    tail_process=subprocess.Popen([str(helper.NODE),str(CODE/'tools/engine-qualification/legacy-tail-probe.mjs'),kind],
        env=ENV,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    ready=tail_process.stdout.readline();print(ready,end='',flush=True)
    assert ready.startswith('ACM_LEGACY_SLICE_READY=')
    process=subprocess.Popen(['/usr/bin/systemd-run','--unit='+helper.UNIT,'--wait','--collect','--pipe','--quiet',
       *['--property='+k+'='+v for k,v in props.items()],*['--setenv='+k+'='+v for k,v in binding.items()],
       str(helper.NODE),str(source),*(['tail-only'] if kind=='tail' else [])],env=ENV,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    found=False
    try:
        for line in process.stdout:
            print(line,end='',flush=True)
            if line.startswith('ACM_LEGACY_TAIL_PROBE='):
                data=json.loads(line.split('=',1)[1]);found=True
                end=time.monotonic()+3
                while time.monotonic()<end:
                    current=helper.unit_state()
                    if helper.released(current):break
                    time.sleep(.03)
                emit('ACM_LEGACY_UNIT_WAIT',{'kind':kind,'unitState':current,
                    'serviceGroupPresent':Path('/sys/fs/cgroup/acmlegacycpu.slice/acm-rc2-engine-readiness.service').exists(),
                    'slicePresent':Path('/sys/fs/cgroup/acmlegacycpu.slice').exists()})
                assert helper.released(current)
                target=CODE/('legacy-tail-probe-input-'+kind+'.json');temporary=CODE/('legacy-tail-probe-input-'+kind+'.pending')
                assert not target.exists()
                with temporary.open('x',encoding='utf-8') as f:
                    json.dump(data,f);f.flush();os.fsync(f.fileno())
                temporary.rename(target)
                for tail_line in tail_process.stdout:print(tail_line,end='',flush=True)
                assert tail_process.wait(timeout=5)==0
                break
        for line in process.stdout:print(line,end='',flush=True)
        assert found and process.wait(timeout=8)==0
    finally:
        current=helper.unit_state()
        if current.get('ActiveState') in ('active','activating') and str(source) in current.get('ExecStart',''):
            subprocess.run(['/usr/bin/systemctl','stop',helper.UNIT],env=ENV,timeout=10,check=False)
        if tail_process.poll() is None:
            with (CODE/('legacy-tail-probe-abort-'+kind)).open('x') as f:f.write('STOP')
            try:tail_process.wait(timeout=5)
            except subprocess.TimeoutExpired:tail_process.terminate();tail_process.wait(timeout=3)
    end=time.monotonic()+5
    while not helper.released(helper.unit_state()) and time.monotonic()<end:time.sleep(.1)
    assert helper.released(helper.unit_state()) and not Path('/sys/fs/cgroup/acmlegacycpu.slice').exists()
    return {'kind':kind,'status':'PASS','unitReleased':True,'sliceReleased':True}

def native_sampler_probe(helper):
    faults=native_sampler_round(helper,'faults')
    tail=native_sampler_round(helper,'tail')
    return {'nativeMonitorFaultProbe':faults['status'],'nativeSliceRetentionProbe':tail['status'],'monitorProbeUnitReleased':True}

def storage_summary(work):
    # 只開啟本輪測試庫的核對副本；原庫、WAL、SHM 不建立 SQLite 連線。
    digest=lambda value:hashlib.sha256(str(value).encode()).hexdigest() if value is not None else None
    atom=lambda value:value if isinstance(value,str) and 0<len(value)<=64 and all(c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789' for c in value) else None
    def file_id(path):
        info=path.lstat()
        assert stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==0
        return {'dev':str(info.st_dev),'ino':str(info.st_ino),'size':info.st_size,'mode':oct(info.st_mode&0o777),
                'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    rows=[]
    for directory in sorted(work.glob('r3-legacy-json-*')):
        assert directory.is_dir() and not directory.is_symlink() and directory.resolve()==directory
        audit=directory/'sanitized-audit-copy';audit.mkdir(mode=0o700)
        for name in ('controller.sqlite','r1.sqlite','upstream.sqlite','witness.sqlite'):
            source=directory/name
            if not source.exists():continue
            files=[p for p in (source,Path(str(source)+'-wal'),Path(str(source)+'-shm')) if p.exists()]
            before={p.name:file_id(p) for p in files}
            holders=[]
            for process in Path('/proc').iterdir():
                if not process.name.isdecimal():continue
                try:
                    for fd in (process/'fd').iterdir():
                        try:target=os.readlink(fd)
                        except FileNotFoundError:continue
                        if target in {str(p) for p in files}:holders.append(int(process.name))
                except FileNotFoundError:continue
            assert not holders,'LEGACY_AUDIT_DATABASE_STILL_HELD'
            for source_file in files:
                with (audit/source_file.name).open('xb') as output,source_file.open('rb') as original:
                    shutil.copyfileobj(original,output);output.flush();os.fsync(output.fileno())
            assert before=={p.name:file_id(p) for p in files},'LEGACY_AUDIT_SOURCE_CHANGED'
            with closing(sqlite3.connect(str(audit/name))) as db:
                tables={r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type='table'")}
                details={'store':name,'directorySha256':digest(directory.name),'sourceFiles':before,
                    'integrity':all(r[0]=='ok' for r in db.execute('PRAGMA integrity_check')),
                    'foreignKeyViolationCount':sum(1 for _ in db.execute('PRAGMA foreign_key_check')),
                    'userVersion':db.execute('PRAGMA user_version').fetchone()[0],
                    'schemaSha256':digest(json.dumps(list(db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')),sort_keys=True))}
                details['tableCounts']={table:db.execute('SELECT count(*) FROM "'+table+'"').fetchone()[0]
                    for table in sorted(tables) if table in {'jobs','reservations','reservation_aliases','events','worker_events','worker_identity',
                        'duals','requests','holds','operation_records','operation_events','v08_schema','v08_intents','v08_audit','v08_legacy','v08_upstream_policy','binding','witness'}}
                def projected(query,fields):
                    return [{field:(atom(value) if field in ('state','phase','event') else value if field in ('seq','revision','at') else digest(value))
                        for field,value in zip(fields,row)} for row in db.execute(query)]
                if name=='controller.sqlite':
                    details['jobs']=projected('SELECT id,json_extract(data,\'$.attemptId\'),state FROM jobs ORDER BY seq',('job','attempt','state'))
                    details['locks']=projected('SELECT job_id,attempt_id,phase FROM reservations ORDER BY job_id',('job','attempt','phase'))
                    details['events']=projected('SELECT seq,job_id,attempt_id,event,at FROM events ORDER BY seq',('seq','job','attempt','event','at'))
                elif name=='r1.sqlite':
                    details['jobs']=projected("SELECT id,json_extract(data,'$.dispatchAttemptId'),json_extract(data,'$.state') FROM jobs ORDER BY id",('job','attempt','state'))
                    details['locks']=projected('SELECT job_id,attempt_id,phase,revision FROM v08_intents ORDER BY job_id',('job','attempt','phase','revision'))
                    details['events']=projected('SELECT seq,job_id,event,at FROM v08_audit ORDER BY seq',('seq','job','event','at'))
                elif name=='upstream.sqlite':
                    details['events']=projected("SELECT seq,json_extract(document,'$.binding.jobId'),json_extract(document,'$.binding.attemptId'),json_extract(document,'$.state') FROM events ORDER BY seq",('seq','job','attempt','state'))
                elif name=='witness.sqlite':
                    details['checkpoint']=projected('SELECT sequence,pin,head FROM witness',('seq','manifest','head'))
            assert before=={p.name:file_id(p) for p in files},'LEGACY_AUDIT_SOURCE_CHANGED'
            rows.append(details)
    result={'scope':'CURRENT_ISOLATED_ATTEMPT_ONLY','originalDatabasesOpened':False,'privateFieldsIncluded':False,'stores':rows}
    target=work/'legacy-sanitized-storage-summary.json'
    with target.open('x',encoding='utf-8') as output:json.dump(result,output,sort_keys=True);output.flush();os.fsync(output.fileno())
    emit('ACM_LEGACY_STORAGE_SUMMARY',result)
    return result

def main(preflight_only=False):
    assert os.getuid()==os.getgid()==0 and os.uname().machine=='aarch64'
    assert 'QEMU' in Path('/sys/class/dmi/id/product_name').read_text()
    assert Path('/proc/1/comm').read_text().strip()=='systemd'
    assert not any(row.split()[1]=='00000000' for row in Path('/proc/net/route').read_text().splitlines()[1:])
    helper=module('arm64_guest',CODE/'tools/engine-qualification/arm64-guest.py')
    pins=json.loads((CODE/'qualification-sources.json').read_text())
    for name,digest in pins.items():
        path=Path(name)
        assert (path.is_relative_to(CODE) or path.is_relative_to(helper.ROOT)) and path.resolve(strict=True)==path
        assert path.stat().st_uid==0 and path.stat().st_nlink==1 and not path.stat().st_mode&0o222
        assert helper.sha(path)==digest
    emit('ACM_LEGACY_SOURCE',{'verified':len(pins),'kernel':os.uname().release,'expectedTegra515':False,'networkBackend':False})
    helper.stage()
    pressure={**native_pressure(),**native_sampler_probe(helper)}
    gate={'verdict':'PASS_LEGACY_NATIVE_PREFLIGHT','generationRequests':0,'unitAndCgroupReleased':True,
          'kernel':os.uname().release,'sourceManifestSha256':helper.sha(CODE/'qualification-sources.json'),**pressure}
    with (CODE/'legacy-preflight-pass.json').open('x',encoding='utf-8') as f:json.dump(gate,f)
    (CODE/'legacy-preflight-pass.json').chmod(0o444)
    work=CODE/'src/tools/fixtures/work';work.mkdir(parents=True,mode=0o700)
    if not preflight_only:
        try:
            subprocess.run([str(helper.NODE),str(CODE/'tools/engine-qualification/integration.mjs'),'legacy-json'],
                           env=ENV,stdin=subprocess.DEVNULL,timeout=180,check=True)
        finally:
            storage_summary(work)
    assert helper.released(helper.unit_state())
    emit('ACM_LEGACY_GUEST_DONE',{'status':'PASS','mode':'legacy-preflight' if preflight_only else 'legacy','preflight':'PASS_LEGACY_NATIVE_PREFLIGHT',
                               'kernel':os.uname().release,'tegra515Native':'UNVERIFIED'})
