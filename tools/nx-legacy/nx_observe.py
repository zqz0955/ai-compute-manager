"""固定來源的 NX 前檢及監測。此模組不執行設備寫入或 Ollama 生成。"""
import http.client
import json
import os
import pwd
import grp
import re
import signal
import subprocess
import time
from pathlib import Path

CG = Path('/sys/fs/cgroup')
SLICE = 'acmv08fixture.slice'
SERVICE = 'acmv08fixture.service'
PARENT = CG / SLICE / SERVICE
BASE_GROUPS = ('', 'init.scope', 'system.slice', 'user.slice', 'system.slice/ollama.service')
BASE_UNITS = ('ollama.service', 'nvargus-daemon.service')
UIDS = (65201, 65202)
DEVICE = re.compile(r'^/dev/(?:dri/|nvidia|nvgpu|nvhost|nvmap|tegra|video|media|v4l)')
WATCH = re.compile(r'python|nvargus|camera|video|ffmpeg|gstream|gst-|ollama|llama|torch|cuda|render|jupyter|deepstream', re.I)
WORK_PROCESS = re.compile(r'^(?:ffmpeg|gst-launch|gstreamer|llama(?:[-_].*)?|torchrun|deepstream(?:-app)?)(?:\.py)?$', re.I)
MODEL_ROOT = '/usr/share/ollama/.ollama/models'

def required(ok, why):
    if not ok:
        raise RuntimeError(why)

def text(path):
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return f.read(131072).strip()

def optional(path):
    try:
        return text(path)
    except FileNotFoundError:
        return None

def command(*args):
    return subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                          text=True, timeout=6, env={'PATH':'/usr/bin:/bin','LANG':'C'})

def unit(name):
    fields = ('LoadState,ActiveState,SubState,MainPID,ControlGroup,ActiveEnterTimestampMonotonic,'
              'NRestarts,InvocationID,Transient,FragmentPath,DropInPaths,Environment')
    r = command('/usr/bin/systemctl', '--system', '--no-pager', 'show', '-p', fields, '--', name)
    required(r.returncode == 0, 'UNIT_QUERY_FAILED')
    return dict(line.split('=', 1) for line in r.stdout.splitlines() if '=' in line)

def public_unit(name):
    result = unit(name)
    result.pop('Environment', None)
    return result

def topology():
    keys = ('cgroup.controllers','cgroup.subtree_control','cpu.max','cpu.weight','memory.max','pids.max')
    names = set(BASE_GROUPS)
    names.update(p.name for p in CG.iterdir() if p.is_dir() and p.name != SLICE)
    return {n or '/': {k: optional(CG/n/k) for k in keys} for n in sorted(names)}

def no_id_collision():
    for number in UIDS:
        for query in (pwd.getpwuid, grp.getgrgid):
            try:
                query(number)
            except KeyError:
                continue
            raise RuntimeError('FIXTURE_NSS_ID_IN_USE')
    required(not process_projection()['idConflicts'], 'FIXTURE_PROCESS_ID_IN_USE')

def health():
    start = time.monotonic()
    conn = http.client.HTTPConnection('127.0.0.1',11434,timeout=0.7)
    def deadline(*_):
        raise TimeoutError('OLLAMA_HEALTH_DEADLINE')
    old=signal.signal(signal.SIGALRM,deadline)
    signal.setitimer(signal.ITIMER_REAL,1.2)
    try:
        conn.request('GET','/api/ps',headers={'Connection':'close'})
        resp = conn.getresponse()
        data = resp.read(262145)
        required(resp.status==200 and len(data)<=262144,'OLLAMA_HEALTH_INVALID')
        models=json.loads(data)['models']
        required(isinstance(models,list),'OLLAMA_HEALTH_SCHEMA')
        return {'status':200,'resident':len(models),'ms':round((time.monotonic()-start)*1000,2)}
    finally:
        signal.setitimer(signal.ITIMER_REAL,0)
        signal.signal(signal.SIGALRM,old)
        conn.close()

def model_scope(ollama):
    pid = int(ollama['MainPID'])
    required(pid>1 and ollama['ActiveState']=='active','OLLAMA_INACTIVE')
    # 只讀取指定鍵並驗證路徑，其餘環境不輸出。
    with open('/proc/'+str(pid)+'/environ','rb') as f:
        env=f.read(131073)
    required(len(env)<=131072,'OLLAMA_ENV_OVERSIZE')
    values=[r.split(b'=',1)[1].decode('utf-8') for r in env.split(b'\0') if r.startswith(b'OLLAMA_MODELS=')]
    if not values:
        homes=[r[5:].decode('utf-8') for r in env.split(b'\0') if r.startswith(b'HOME=')]
        required(len(homes)==1 and homes[0]=='/usr/share/ollama','OLLAMA_HOME_UNQUALIFIED')
        values=[homes[0]+'/.ollama/models']
    spot=Path(MODEL_ROOT)
    peer=Path('/proc/'+str(pid)+'/root'+MODEL_ROOT)
    required(values==[MODEL_ROOT] and spot.is_dir() and str(spot.resolve())==MODEL_ROOT and
             spot.samefile(peer),'OLLAMA_MODEL_PATH_UNQUALIFIED')
    ids=set()
    for fd in Path('/proc/'+str(pid)+'/fd').iterdir():
        try:
            link=os.readlink(fd)
        except FileNotFoundError:
            continue
        m=re.fullmatch(r'socket:\[(\d+)\]',link)
        if m:ids.add(m[1])
    sockets=[]
    with open('/proc/'+str(pid)+'/net/unix',encoding='utf-8',errors='replace') as unix:
        for line in unix:
            columns=line.strip().split(maxsplit=7)
            if len(columns)!=8 or columns[6] not in ids:continue
            path=columns[7]
            if path.startswith('@'):
                sockets.append('ABSTRACT_HOST_NAMESPACE')
            else:
                required(path.startswith(('/run/','/tmp/','/var/tmp/')),'OLLAMA_SOCKET_PATH_UNQUALIFIED')
                sockets.append(path)
    required(unit('ollama.service')['MainPID']==str(pid),'OLLAMA_PROCESS_CHANGED')
    return {'modelRoot':MODEL_ROOT,'unixSockets':sorted(set(sockets))}

def process_projection(device_scan=None):
    rows=[]; denied=[]; realtime=[]; conflicts=[]
    for path in Path('/proc').glob('[0-9]*'):
        try:
            pid=int(path.name)
            if pid==os.getpid():continue
            stat=text(path/'stat').rsplit(')',1)[1].split()
            status=text(path/'status')
            credentials={k: set(map(int,v.split())) for row in status.splitlines()
                         for k,_,v in [row.partition(':')] if k in ('Uid','Gid','Groups')}
            if any(set(UIDS)&value for value in credentials.values()):conflicts.append(pid)
            name=text(path/'comm')
            try:
                exe=os.path.basename(os.readlink(path/'exe'))
            except FileNotFoundError:
                exe=None
            policy=os.sched_getscheduler(pid)
            if exe:
                for task in (path/'task').iterdir():
                    try:
                        if os.sched_getscheduler(int(task.name)) in (1,2,6):
                            realtime.append(int(task.name))
                    except ProcessLookupError:
                        continue
            if not exe and stat[0]!='Z' and any(int(x) for x in stat[11:13]) and not name:
                denied.append(pid)
            devices={}; errors=False
            for fd in (path/'fd').iterdir():
                try:
                    target=os.readlink(fd)
                    if DEVICE.match(target) or (device_scan and device_scan(fd,target)):
                        devices[fd.name]=target
                except PermissionError:
                    errors=True
                except FileNotFoundError:
                    pass
            if errors and exe:denied.append(pid)
            if devices or (exe and WATCH.search(name+' '+exe)):
                fixture=('/'+SLICE+'/'+SERVICE) in text(path/'cgroup')
                argv=text(path/'cmdline').split('\0')[:3]
                scripts=[os.path.basename(word) for word in argv[1:] if re.fullmatch(r'[A-Za-z0-9_./+-]+\.py',word)]
                rows.append({'fixture':fixture,'pid':pid,'comm':name,'exe':exe,'script':scripts[:1],'uid':min(credentials['Uid']),
                             'startTicks':int(stat[19]),'ticks':int(stat[11])+int(stat[12]),
                             'gpuCameraFDs':sorted(set(devices.values())),'deviceFds':devices,'state':stat[0],'policy':policy,
                             'schedstat':optional(path/'schedstat')})
        except (FileNotFoundError,ProcessLookupError):
            continue
        except PermissionError:
            denied.append(int(path.name))
    return {'processes':sorted(rows,key=lambda row: row['pid']),'unreadable':sorted(set(denied)),
            'realtime':sorted(set(realtime)),'idConflicts':sorted(set(conflicts))}

def counters():
    lines=text('/proc/stat').splitlines()
    ticks=list(map(int,lines[0].split()[1:9]))
    required(len(ticks)==8,'PROC_STAT_SCHEMA')
    fields={a:int(b) for line in lines if line.startswith(('procs_running ','procs_blocked '))
            for a,b in [line.split()]}
    groups={}
    for base in [CG/'system.slice',CG/'system.slice/ollama.service',PARENT,PARENT/'engine']:
        value=optional(base/'cpu.stat')
        if value:
            groups[str(base)]={k:int(v) for k,v in [row.split() for row in value.splitlines()]}
    return {'cpuTicks':ticks,'cpuCount':sum(bool(re.match(r'^cpu[0-9]+ ',row)) for row in lines),
            'loadavg':text('/proc/loadavg').split(),'queue':fields,'cgroupCpuStat':groups,
            'psiSupported':optional('/proc/pressure/cpu') is not None}

def sample(gpu_path, device_scan=None):
    return {'at':time.time(),'cpu':counters(),'ollama':health(),'services':{n:public_unit(n) for n in BASE_UNITS},
            'gpuRaw':optional(gpu_path),'process':process_projection(device_scan)}

def unverified_work(row):
    scripts = row.get('script')
    if isinstance(scripts,str):
        scripts = [scripts]
    if not isinstance(scripts,list) or not all(isinstance(name,str) and name.strip() for name in scripts):
        return True
    names = (row.get('comm'),row.get('exe'),*scripts)
    return any(not isinstance(name,str) or not name.strip() or WORK_PROCESS.fullmatch(name) for name in names)

def interval_reasons(previous, row, baseline):
    reasons=[]
    p=row['process']
    if p['unreadable'] or p['realtime']:reasons.append('FD_OR_RT_UNKNOWN')
    desktop=row.get('desktop',{})
    if desktop.get('status')!='MATCH' and any(x['gpuCameraFDs'] for x in p['processes']):
        reasons.append('DEVICE_OPEN')
    if desktop.get('status')=='HOLD':reasons.append(desktop['reason'])
    watched=lambda sample: {(x['pid'],x['startTicks'],x['comm']) for x in sample['process']['processes']
                          if not x['fixture'] and x['uid'] not in UIDS and x['state']!='Z'}
    if watched(row)!=watched(baseline):reasons.append('WATCHED_PROCESS_CHANGED')
    if any(not x['fixture'] and x['state']!='Z' and unverified_work(x) for x in p['processes']):
        reasons.append('WORK_PROCESS_UNVERIFIED')
    if row['gpuRaw']!='0' or row['ollama']['resident']!=0:reasons.append('WORK_OBSERVED')
    if row['services']!=baseline['services']:reasons.append('SERVICE_IDENTITY_CHANGED')
    latency=max(250,3*baseline['ollama']['ms'])
    if row['ollama']['ms']>latency:reasons.append('HEALTH_LATENCY')
    c=row['cpu']
    queue=c['queue']
    if queue['procs_blocked']>=2 or queue['procs_running']>c['cpuCount']+2:reasons.append('QUEUE_LIMIT')
    if previous:
        delta=[b-a for a,b in zip(previous['cpu']['cpuTicks'],c['cpuTicks'])]
        total=sum(delta)
        if min(delta)<0 or total<=0:reasons.append('CPU_SAMPLE_INVALID')
        elif 100*(total-delta[3]-delta[4])>=85*total or 100*delta[4]>=10*total:
            reasons.append('CPU_OR_WAIT_LIMIT')
        prior=previous['cpu']['cgroupCpuStat']
        for key,values in c['cgroupCpuStat'].items():
            if key in prior and key in (str(CG/'system.slice'),str(CG/'system.slice/ollama.service')):
                if values.get('nr_throttled',0)!=prior[key].get('nr_throttled',0):
                    reasons.append('EXISTING_THROTTLE_CHANGED')
    return reasons
