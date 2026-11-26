"""Run R3 qualification in a fresh, offline ARM64 guest."""
from hashlib import file_digest
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import tarfile

CODE = Path('/opt/acm-r3-code')
ROOT = Path('/opt/acm-rc2-engine-readiness')
NODE = CODE / 'runtime/node'
NODE_SHA = '8f9c2a55879e9705cb285b6cdd649d95df642c6720f052cb30f300d2677da99f'
MODEL_SHA = 'a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67'
UNIT = 'acm-rc2-engine-readiness.service'
CGROUP = Path('/sys/fs/cgroup/system.slice') / UNIT
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}


def emit(tag, data):
    print(tag + '=' + json.dumps(data, sort_keys=True), flush=True)


def sha(path):
    with path.open('rb') as src:
        return file_digest(src, 'sha256').hexdigest()


def medium(serial):
    result = Path('/dev/disk/by-id') / ('virtio-' + serial)
    assert stat.S_ISBLK(result.stat().st_mode)
    assert Path('/sys/class/block', result.resolve().name, 'ro').read_text().strip() == '1'
    return result


def copy_member(bundle, row, target):
    with bundle.extractfile(row) as src, target.open('xb') as dst:
        while data := src.read(1024 * 1024):
            dst.write(data)


def stage_node():
    NODE.parent.mkdir(mode=0o755)
    with tarfile.open(medium('ACMRC2NODE'), 'r|xz') as archive:
        for row in archive:
            if row.name == 'node-v24.22.3-linux-arm64/bin/node':
                assert row.isfile() and row.size == 123446736
                copy_member(archive, row, NODE)
                break
    assert sha(NODE) == NODE_SHA
    NODE.chmod(0o555)


def stage():
    stage_node()
    assets = ROOT / 'assets'
    assets.mkdir(mode=0o755)
    seen = set()
    with tarfile.open(medium('ACMRC2ENGINEASSETS'), 'r|') as archive:
        for row in archive:
            path = PurePosixPath(row.name)
            if len(path.parts) < 2 or path.parts[1] not in ('ollama', 'models'):
                continue
            assert path.parts[0] == 'acm-nx-real-stage-v08-20261124'
            assert not path.is_absolute() and '..' not in path.parts and path not in seen
            assert row.uid == row.gid == 0 and (row.isfile() or row.isdir())
            seen.add(path)
            dest = assets.joinpath(*path.parts[1:])
            if row.isdir():
                dest.mkdir(mode=0o755)
            else:
                assert row.mode in (0o400,0o444,0o555) and 0 < row.size <= 512 * 1024 * 1024
                copy_member(archive, row, dest)
                dest.chmod(0o555 if row.mode == 0o555 else 0o444)
    manifest = assets / 'models/manifests/registry.ollama.ai/library/qwen2.5/0.5b-instruct-q4_K_M'
    assert sha(manifest) == MODEL_SHA
    parsed = json.loads(manifest.read_text())
    parts = [parsed['config'], *parsed['layers']]
    assert len(parts) == 5 and sum(row['size'] for row in parts) == 397821319
    for row in parts:
        blob = assets / 'models/blobs' / row['digest'].replace(':','-')
        assert blob.stat().st_size == row['size'] and sha(blob) == row['digest'].split(':')[1]
    assert sha(assets / 'ollama/bin/ollama') == '645f7c676bac5d81332c43e5ef9d3acd792bc4391404582301c3f29eaf06c3ee'
    (ROOT / 'engine-work').mkdir(mode=0o755)
    emit('ACM_R3_ASSETS', {'nodeSha256':NODE_SHA, 'modelSha256':MODEL_SHA, 'blobs':len(parts), 'mediaReadOnly':True})


def unit_state():
    summary = subprocess.run(['/usr/bin/systemctl','show',UNIT,'--property=LoadState',
        '--property=ActiveState','--property=MainPID','--property=ExecStart'],
        capture_output=True, text=True, env=ENV, timeout=8)
    return dict(line.split('=',1) for line in summary.stdout.splitlines() if '=' in line)


def released(state):
    return (state.get('LoadState') == 'not-found' and state.get('ActiveState') == 'inactive'
            and state.get('MainPID') == '0' and not CGROUP.exists())


def metadata():
    source = ROOT / 'readiness.mjs'
    guard = ROOT / 'stdio-guard.py'
    assert released(unit_state())
    props = {
        'Type':'exec', 'Restart':'no', 'Delegate':'cpu memory pids', 'CPUQuota':'100%',
        'CPUQuotaPeriodSec':'100ms', 'MemoryMax':'2147483648','MemorySwapMax':'0','TasksMax':'64',
        'PrivateDevices':'yes','DevicePolicy':'closed','PrivateNetwork':'yes','PrivateIPC':'yes',
        'RestrictAddressFamilies':'AF_UNIX AF_INET','NoNewPrivileges':'yes','ProtectSystem':'strict',
        'ProtectHome':'yes','InaccessiblePaths':'-/tmp -/var/tmp -/usr/share/ollama -/var/lib/ollama -/root -/home',
        'TemporaryFileSystem':('/run:ro,nosuid,nodev,noexec,size=1M,mode=0555 '
                               f'{ROOT}/engine-work:size=128M,mode=0700,uid=65202,gid=65202'),
        'CapabilityBoundingSet':'CAP_SETUID CAP_SETGID CAP_CHOWN CAP_DAC_OVERRIDE CAP_KILL',
        'SystemCallFilter':'~io_uring_setup io_uring_enter io_uring_register','SystemCallErrorNumber':'EPERM',
        'UMask':'0077','RuntimeMaxSec':'145s','TimeoutStopSec':'8s','KillMode':'control-group','SendSIGKILL':'no',
    }
    binding = {f'ACM_RC2_HOST_{kind.upper()}_NS':os.readlink('/proc/1/ns/' + kind) for kind in ('mnt','net','ipc')}
    binding.update(ACM_RC2_HOST_RUN_DEV=str(os.stat('/run').st_dev), ACM_RC2_METADATA_SHA=sha(source),
                   ACM_RC2_STDIO_SHA=sha(guard), ACM_RC2_METADATA_PROBE='offline-metadata-v1')
    status = None
    try:
        run = subprocess.run(['/usr/bin/systemd-run','--unit='+UNIT,'--wait','--collect','--pipe','--quiet',
             *[f'--property={key}={value}' for key,value in props.items()],
             *[f'--setenv={key}={value}' for key,value in binding.items()], str(NODE), str(source)],
             stdin=subprocess.DEVNULL, timeout=65, env=ENV)
        status = run.returncode
    finally:
        current = unit_state()
        if current.get('ActiveState') in ('active','activating') and str(source) in current.get('ExecStart',''):
            subprocess.run(['/usr/bin/systemctl','stop',UNIT], env=ENV, timeout=12, check=False)
        # systemd-run may return just before collected state disappears.
        import time
        end = time.monotonic()+4
        while not released(unit_state()) and time.monotonic()<end:
            time.sleep(.1)
        clean = released(unit_state())
        record = {'status':'PASS' if status == 0 and clean else 'HOLD',
                  'verdict':'PASS_METADATA_ONLY' if status == 0 and clean else 'HOLD',
                  'unitExit':status, 'unitAndCgroupReleased':clean, 'generationRequests':0,
                  'readinessSha256':sha(source), 'stdioGuardSha256':sha(guard)}
        emit('ACM_R3_METADATA_GATE',record)
    assert status == 0 and clean
    with (CODE/'metadata-pass.json').open('x',encoding='utf-8') as out:
        json.dump(record,out)
    (CODE/'metadata-pass.json').chmod(0o444)


def main():
    if sys.argv[1:]==['nx-entry']:
        from importlib.util import spec_from_file_location,module_from_spec
        spec=spec_from_file_location('nx_lab',CODE/'tools/nx-legacy/nx-entry-lab.py')
        mod=module_from_spec(spec);spec.loader.exec_module(mod);mod.main()
        emit('ACM_R3_GUEST_DONE',{'status':'PASS','mode':'nx-entry'})
        return
    if sys.argv[1:] in (['legacy'],['legacy-preflight']):
        from importlib.util import spec_from_file_location,module_from_spec
        spec=spec_from_file_location('legacy_guest',CODE/'tools/engine-qualification/legacy-guest.py')
        mod=module_from_spec(spec);spec.loader.exec_module(mod);mod.main(preflight_only=sys.argv[1]=='legacy-preflight');return
    assert sys.argv[1:] in (['metadata'],['all'],['h3-ready'],['h3-probe'])
    assert os.getuid() == 0 and os.uname().machine == 'aarch64'
    assert 'QEMU' in Path('/sys/class/dmi/id/product_name').read_text()
    assert Path('/proc/1/comm').read_text().strip() == 'systemd'
    assert not any(row.split()[1] == '00000000' for row in Path('/proc/net/route').read_text().splitlines()[1:])
    pins = json.loads((CODE/'qualification-sources.json').read_text())
    for path,pin in pins.items():
        item = Path(path)
        assert (item.is_relative_to(CODE) or item.is_relative_to(ROOT)) and item.resolve(strict=True) == item
        assert item.stat().st_uid == 0 and item.stat().st_nlink == 1 and not item.stat().st_mode & 0o222
        assert sha(item) == pin
    emit('ACM_R3_GUEST_SOURCE', {'verified':len(pins),'mode':sys.argv[1]})
    if sys.argv[1] in ('h3-ready','h3-probe'):
        stage_node()
        statuses=[]
        labs=('ready-lab.py','role-lab.py') if sys.argv[1]=='h3-ready' else ('ready-lab.py',)
        for lab in labs:
            result=subprocess.run(['/usr/bin/python3','-I','-B',CODE/'tools/h3'/lab],
                                  stdin=subprocess.DEVNULL,timeout=130,env=ENV,check=False)
            statuses.append(result.returncode)
        assert statuses==[0]*len(labs), ('H3_LAB_STATUS',statuses)
        emit('ACM_R3_GUEST_DONE',{'status':'PASS','mode':sys.argv[1]})
        return
    stage()
    subprocess.run([str(NODE),str(ROOT/'stdio-test.mjs')], stdin=subprocess.DEVNULL, timeout=30, env=ENV, check=True)
    metadata()
    if sys.argv[1] == 'all':
        work=CODE/'src/tools/fixtures/work'
        work.parent.mkdir(parents=True,mode=0o755)
        work.mkdir(mode=0o700)
        entry=CODE/'tools/engine-qualification/integration.mjs'
        for mode in ('json','sse'):
            subprocess.run([str(NODE),str(entry),mode],stdin=subprocess.DEVNULL,timeout=170,env=ENV,check=True)
    emit('ACM_R3_GUEST_DONE',{'status':'PASS','mode':sys.argv[1]})


if __name__ == '__main__':
    if not __debug__:
        raise SystemExit('QUALIFICATION_REQUIRES_ACTIVE_GUARDS')
    try:
        main()
    except Exception as error:
        import traceback
        traceback.print_exc()
        emit('ACM_R3_GUEST_DONE', {'status':'HOLD','failure':type(error).__name__})
        raise SystemExit(42)
