"""Build the zero-generation NX staging TAR from frozen Git and pinned offline ARM64 Node media."""
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile

NODE_ARCHIVE_SHA='6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c'
NODE_SHA='8f9c2a55879e9705cb285b6cdd649d95df642c6720f052cb30f300d2677da99f'
SOURCES=('ready-service.mjs','ready-protocol.mjs','wire.mjs')


def main():
    revision,node_media,target=sys.argv[1:]
    repo=Path(__file__).resolve().parents[2]
    git=lambda *args:subprocess.check_output(['git',*args],cwd=repo)
    assert re.fullmatch(r'[0-9a-f]{40}',revision) and git('rev-parse',revision+'^{commit}').decode().strip()==revision
    media=Path(node_media)
    dst=Path(target)
    assert media.is_absolute() and media.resolve(strict=True)==media and media.is_file() and media.stat().st_nlink==1
    assert dst.is_absolute() and dst.parent.resolve(strict=True)==dst.parent
    with media.open('rb') as f:
        archive=f.read(30991864)
        assert sha256(archive).hexdigest()==NODE_ARCHIVE_SHA and f.read(9)==bytes(8)
    rows={}
    with tarfile.open(dst,'x',format=tarfile.USTAR_FORMAT) as output:
        def record(name,bytes_,mode):
            m=tarfile.TarInfo(name)
            m.mode,m.size=mode,len(bytes_)
            output.addfile(m,BytesIO(bytes_))
            rows[name]={'sha256':sha256(bytes_).hexdigest(),'size':len(bytes_),'mode':mode}
        with tarfile.open(fileobj=BytesIO(archive),mode='r:xz') as source:
            member=source.getmember('node-v24.22.3-linux-arm64/bin/node')
            assert member.isfile() and member.size==123446736
            node=source.extractfile(member).read()
            assert sha256(node).hexdigest()==NODE_SHA
            record('node',node,0o555)
        for name in SOURCES:
            record(name,git('show',revision+':tools/h3/'+name),0o444)
    h=sha256()
    with dst.open('rb') as f:
        while block:=f.read(1024*1024):
            h.update(block)
    print(json.dumps({'sourceCommit':revision,'artifact':dst.name,'sha256':h.hexdigest(),'files':rows,
                      'installerSha256':sha256(git('show',revision+':tools/h3/ready-admin.py')).hexdigest(),
                      'generationIncluded':False,'credentialsIncluded':False,'approvalIncluded':False},indent=2))


if __name__=='__main__':
    if not __debug__:
        raise SystemExit('QUALIFICATION_REQUIRES_ACTIVE_GUARDS')
    main()
