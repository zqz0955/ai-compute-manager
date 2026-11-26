"""Start a pinned, disposable ARM64 snapshot without a network backend."""
import base64
from hashlib import file_digest, sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys

ROOT = '/opt/acm-rc2-engine-readiness/'
CODE = '/opt/acm-r3-code/'
P0 = ('readiness.mjs','stdio-guard.py','stdio-test.mjs','stdio-test.py')
TOOL_DIR = 'tools/engine-qualification/'


def sha(path):
    with path.open('rb') as source:
        return file_digest(source,'sha256').hexdigest()


def pin(path, digest):
    assert path.resolve(strict=True) == path and path.is_file() and path.stat().st_nlink == 1
    assert sha(path) == digest, path.name
    return str(path)


def exclusive(path, value):
    with path.open('x',encoding='utf8') as stream:
        json.dump(value,stream,ensure_ascii=False,indent=2,sort_keys=True)


def main():
    phase, run_id, revision,*extras = sys.argv[1:]
    assert phase in ('metadata','all','legacy','legacy-preflight','nx-entry','h3-ready','h3-probe') and re.fullmatch(r'[a-z0-9-]{3,34}',run_id)
    assert re.fullmatch(r'[0-9a-f]{40}',revision)
    assert len(extras)==(1 if phase=='nx-entry' else 0)
    here = Path(__file__).absolute()
    candidate = here.parents[2]
    project = candidate.parents[1]
    work = project/'tools/fixtures/work'
    evidence = project/'evidence'/candidate.name
    assert candidate.parent.name == 'candidates' and ('rc2-r3' in candidate.name or phase.startswith('legacy') and 'legacy-kernel-bounded' in candidate.name or phase=='nx-entry' and 'legacy-nx-entry' in candidate.name or phase in ('h3-ready','h3-probe') and 'h3-cpu-first' in candidate.name)
    assert all(path.resolve(strict=True) == path for path in (candidate,work,evidence))
    assert shutil.disk_usage(work).free >= 2 * 1024**3
    git = shutil.which('git')
    def git_read(*args):
        return subprocess.check_output([git,'-C',str(candidate),*args])
    assert git_read('rev-parse',revision+'^{commit}').decode().strip() == revision
    assert git_read('show',revision+':'+TOOL_DIR+here.name) == here.read_bytes()
    tree = git_read('ls-tree','-r','-z',revision).decode().strip('\0').split('\0')
    source = {}
    for line in tree:
        info,name = line.split('\t')
        parts = PurePosixPath(name).parts
        if name not in {'server.mjs','package.json'} and (parts[0] not in ('src','tools','public','agent') or parts[-1].split('.')[-1] not in ('mjs','py','js','html','css')):
            continue
        assert info.startswith(('100644 blob ','100755 blob ')) and not name.startswith('/') and '..' not in parts
        source[CODE+name] = git_read('show',revision+':'+name)
    for name in P0:
        source[ROOT+name] = source[CODE+TOOL_DIR+name]
    if phase == 'all':
        assert CODE+TOOL_DIR+'integration.mjs' in source
    pins = {name:sha256(data).hexdigest() for name,data in source.items()}
    source[CODE+'qualification-sources.json'] = json.dumps(pins,sort_keys=True).encode()
    assets = work/'v08-first-real-ollama-r1-20261124'
    qemu = work/'jcm-native-assets-20261123/qemu'
    image = pin(assets/'acquisition/ubuntu-arm64.img','3dc8370d923978d4b610fa7964d1b36ba040eefb43198809ca5bc8ac51777b18')
    bios = pin(qemu/'share/edk2-aarch64-code.fd','47765fe344818cbc464b1c14ae658fb4b854f5c2ceffa982411731eb4865594d')
    machine = pin(qemu/'qemu-system-aarch64.exe','8d2183e745155a303ffb9fd861c5da31c5e6c19fcbfd082081cc3e4bcdb0e748')
    disk = pin(qemu/'qemu-img.exe','6d484fd8cd6e90150772529160347a52a8f48eb50f132acc1228d8a4e7bd2d75')
    engine = None if phase in ('h3-ready','h3-probe') else pin(assets/'cold-10-stage.tar','a7d318fae69a8bfe7f214b3695437fdb8d36fa73188ae9c709fe0194796e9dec')
    node = work/'jcm-rc2-engine-smoke/node-media.raw'
    assert node.resolve(strict=True) == node and node.stat().st_nlink == 1
    with node.open('rb') as reader:
        archive = reader.read(30991864)
        assert sha256(archive).hexdigest() == '6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c'
        assert reader.read(512) == b'\0' * 8 and not reader.read(1)
    target = work/('jcm-rc2-r3-'+run_id)
    target.mkdir()
    seed = target/'seed'
    seed.mkdir()
    env = {**os.environ,'TMP':str(target),'TEMP':str(target),'TMPDIR':str(target)}
    files = [{'path':name,'encoding':'b64','permissions':'0444','content':base64.b64encode(data).decode()}
             for name,data in source.items()]
    cloud = {'write_files':files,'runcmd':[['/usr/bin/python3','-I','-B',CODE+TOOL_DIR+'arm64-guest.py',phase],
            ['/usr/bin/systemctl','poweroff','--no-block']], 'disable_root':True,'ssh_pwauth':False,
            'package_update':False,'package_upgrade':False}
    (seed/'user-data').write_text('#cloud-config\n'+json.dumps(cloud)+'\n',encoding='utf8')
    (seed/'meta-data').write_text(f'instance-id: acm-r3-{run_id}\nlocal-hostname: offline-r3\n',encoding='utf8')
    (seed/'network-config').write_text("version: 2\nethernets:\n  isolated:\n    match:\n      macaddress: '52:54:00:11:30:01'\n    dhcp4: false\n    dhcp6: false\n    accept-ra: false\n    optional: true\n    link-local: []\n",encoding='utf8')
    iso, overlay = target/'seed.iso',target/'guest.qcow2'
    native_tar = Path(os.environ['SystemRoot'])/'System32/tar.exe'
    subprocess.run([native_tar,'--format=iso9660','--options','iso9660:volume-id=CIDATA','-cf',iso,'-C',seed,'meta-data','user-data','network-config'],check=True,env=env)
    subprocess.run([disk,'create','-f','qcow2','-F','qcow2','-b',image,overlay],check=True,env=env)
    manifest = {'sourceCommit':revision,'phase':phase,'sourceSha256':pins,
                'networkBackend':False,'engineMediaSha256':None if engine is None else 'a7d318fae69a8bfe7f214b3695437fdb8d36fa73188ae9c709fe0194796e9dec'}
    exclusive(evidence/(run_id+'-sources.json'),manifest)
    command = [machine,'-machine','virt,gic-version=3','-accel','tcg,thread=multi','-cpu','cortex-a76',
               '-smp','2','-m','3072','-bios',bios,'-display','none','-monitor','none','-serial','stdio',
               '-nic','none','-device','virtio-net-pci,mac=52:54:00:11:30:01','-no-reboot']
    bound = [(overlay,'qcow2','guest',False,'ACMRC2R3GUEST'),(iso,'raw','seed',True,'ACMRC2R3SEED'),
             (node,'raw','node',True,'ACMRC2NODE')]
    if engine is not None:
        bound.append((engine,'raw','engine',True,'ACMRC2ENGINEASSETS'))
    if phase=='nx-entry':
        stage=pin(evidence/'ACM-Legacy-NX-Stage.tar',extras[0])
        bound.append((stage,'raw','nxstage',True,'ACMNXSTAGE'))
    for path,fmt,name,readonly,label in bound:
        command.extend(['-drive',f'file={path},format={fmt},if=none,id={name},readonly={"on" if readonly else "off"}',
                        '-device',f'virtio-blk-device,drive={name},serial={label}'+(',bootindex=0' if name=='guest' else '')])
    log = evidence/(run_id+'-serial.log')
    status=None
    with log.open('xb') as output:
        try:
            status=subprocess.run(command,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,
                                  timeout=950 if phase in ('all','legacy','legacy-preflight') else 650,env=env,creationflags=subprocess.CREATE_NO_WINDOW).returncode
        except subprocess.TimeoutExpired:
            pass
    serial=log.read_text(encoding='utf8',errors='replace')
    receipts=[]
    for line in serial.splitlines():
        match=re.search(r'\b(ACM_(?:R3|RC2_ENGINE|LEGACY|H3)_[A-Z0-9_]+)=(\{.*\})',line)
        if match:
            try:
                receipts.append({'tag':match[1],'value':json.loads(match[2])})
            except json.JSONDecodeError:
                continue
    gates=[row['value'] for row in receipts if row['tag']=='ACM_R3_METADATA_GATE']
    metadata_ok=(len(gates)==1 and gates[0].get('verdict')=='PASS_METADATA_ONLY' and gates[0].get('unitExit')==0
                 and gates[0].get('unitAndCgroupReleased') is True and gates[0].get('generationRequests')==0)
    integration=[row['value'] for row in receipts if row['tag']=='ACM_R3_INTEGRATION']
    if phase in ('legacy','legacy-preflight'):
        legacy=[row['value'] for row in receipts if row['tag']=='ACM_LEGACY_GUEST_DONE']
        integration_ok=(len(integration)==1 and integration[0].get('verdict')=='PASS_ISOLATED_LEGACY_BOUNDED_CPU'
            and integration[0].get('requests')==1 and integration[0].get('productCommitted') is True
            and integration[0].get('unitReleased') is True and integration[0].get('peakBytes') is None
            and len(legacy)==1 and legacy[0].get('status')=='PASS')
        if phase=='legacy-preflight':integration_ok=not integration and len(legacy)==1 and legacy[0].get('status')=='PASS'
        metadata_ok=bool(legacy and legacy[0].get('preflight')=='PASS_LEGACY_NATIVE_PREFLIGHT')
    elif phase=='nx-entry':
        checks=[row['value'] for row in receipts if row['tag']=='ACM_LEGACY_NX_ENTRY_LAB']
        metadata_ok=not integration and len(checks)==1 and checks[0].get('status')=='PASS' and checks[0].get('generationRequests')==0
        integration_ok=metadata_ok
    elif phase in ('h3-ready','h3-probe'):
        probes=[row['value'] for row in receipts if row['tag']=='ACM_H3_READY_LAB']
        roles=[row['value'] for row in receipts if row['tag']=='ACM_H3_ROLE_LAB']
        metadata_ok=(not integration and len(probes)==1 and probes[0].get('status')=='PASS' and
                     probes[0].get('generationRequests')==0 and
                     (phase=='h3-probe' and not roles or len(roles)==1 and
                      roles[0].get('status')=='PASS_ARM64_QEMU_ROLE_ISOLATION' and roles[0].get('generationRequests')==0))
        integration_ok=metadata_ok
    elif phase=='all':
        expected=['PASS_ISOLATED_REAL_ENGINE_JSON','PASS_ISOLATED_REAL_ENGINE_SSE']
        integration_ok=(len(integration)==2 and [row.get('verdict') for row in integration]==expected
            and all(row.get('requests')==1 and row.get('productCommitted') is True and row.get('unitReleased') is True
                    for row in integration)
            and integration[0].get('productAttempt')!=integration[1].get('productAttempt')
            and integration[0].get('r1Attempt')!=integration[1].get('r1Attempt'))
    else:
        integration_ok=not integration
    passed=status == 0 and 'reboot: Power down' in serial and metadata_ok and integration_ok and any(
        row['tag']==('ACM_LEGACY_GUEST_DONE' if phase.startswith('legacy') else 'ACM_R3_GUEST_DONE') and row['value'].get('status')=='PASS' and row['value'].get('mode')==phase for row in receipts)
    result={'status':'PASS' if passed else 'HOLD','phase':phase,'sourceCommit':revision,
            'qemuExit':status,'guestPoweredDown':'reboot: Power down' in serial,'networkBackend':False,
            'serialSha256':sha(log),'receipts':receipts}
    exclusive(evidence/(run_id+'-result.json'),result)
    print(json.dumps(result,ensure_ascii=False))
    raise SystemExit(0 if passed else 42)



if __name__ == '__main__':
    if not __debug__:
        raise SystemExit('QUALIFICATION_REQUIRES_ACTIVE_GUARDS')
    main()
