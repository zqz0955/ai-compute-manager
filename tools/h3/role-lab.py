"""ARM64 QEMU role-isolation replay with synthetic keys and zero dispatch."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys

SOURCE=Path('/opt/acm-r3-code')
ROOT=Path('/opt/acm-nx-h3-json-v1')
CONTROL=Path('/opt/acm-nx-h3-json-control-v1')
AUDIT=Path('/opt/acm-nx-h3-json-audit-v1')
NODE_SHA='8f9c2a55879e9705cb285b6cdd649d95df642c6720f052cb30f300d2677da99f'


def need(ok, code):
    if not ok:
        raise RuntimeError(code)


def main():
    need(sys.flags.isolated and sys.dont_write_bytecode and len(sys.argv)==1 and
         os.getuid()==os.geteuid()==os.getgid()==os.getegid()==0 and os.uname().machine=='aarch64' and
         'QEMU' in Path('/sys/class/dmi/id/product_name').read_text() and
         Path('/proc/1/comm').read_text().strip()=='systemd' and
         not any(os.path.lexists(p) for p in (ROOT,CONTROL,AUDIT)) and
         Path(__file__).resolve()==SOURCE/'tools/h3/role-lab.py','H3_ROLE_LAB_BOUNDARY')
    node=SOURCE/'runtime/node'
    with node.open('rb') as source:
        need(hashlib.file_digest(source,'sha256').hexdigest()==NODE_SHA,'H3_ROLE_LAB_NODE_PIN')
    ROOT.mkdir(mode=0o755)
    code=ROOT/'code'
    code.mkdir(mode=0o755)
    CONTROL.mkdir(mode=0o700)
    AUDIT.mkdir(mode=0o711)
    (AUDIT/'work').mkdir(mode=0o700)
    (AUDIT/'launch.json').touch(mode=0o400,exist_ok=False)
    (CONTROL/'restoration.pem').touch(mode=0o400,exist_ok=False)
    prefixes=('src','tools/h3','tools/nx-legacy','tools/engine-qualification')
    selected=[node,*[path for prefix in prefixes for path in (SOURCE/prefix).rglob('*')
                     if path.suffix in ('.mjs','.py','.json')]]
    for source in selected:
        need(source.is_file() and source.resolve()==source and source.stat().st_uid==0,'H3_ROLE_LAB_SOURCE')
        target=code/source.relative_to(SOURCE)
        target.parent.mkdir(parents=True,exist_ok=True)
        with source.open('rb') as left,target.open('xb') as right:
            shutil.copyfileobj(left,right)
            os.fchmod(right.fileno(),0o555 if source==node else 0o444)
    result=subprocess.run([str(code/'runtime/node'),str(code/'tools/h3/role-lab.mjs')],
                          stdin=subprocess.DEVNULL,env={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'},
                          timeout=30,check=False)
    need(result.returncode==0,'H3_ROLE_LAB_EXEC')


if __name__=='__main__':
    os.umask(0o022)
    main()
