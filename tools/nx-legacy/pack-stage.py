"""Assemble the fixed unsigned NX staging tree from already verified local media."""
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import stat
import subprocess
import sys
import tarfile

MODE='LEGACY_KERNEL_BOUNDED_CPU_V1'
NODE_SHA='8f9c2a55879e9705cb285b6cdd649d95df642c6720f052cb30f300d2677da99f'
NODE_ARCHIVE='6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c'
MEDIA='a7d318fae69a8bfe7f214b3695437fdb8d36fa73188ae9c709fe0194796e9dec'
ASSETS='20a54975e2253fa8238032d0d81ba5f4c3040d6c1f6fd72ace7c863840085018'
NATIVE_EVIDENCE='bca256edbb4a85bd04f67bc966b732cf2f3f7fd5e964c5f00e039c2ceca2b8ce'
MODEL='models/manifests/registry.ollama.ai/library/qwen2.5/0.5b-instruct-q4_K_M'
PREFIX='acm-nx-real-stage-v08-20261124/'


def need(value, reason):
    if not value:
        raise RuntimeError(reason)


def digest(stream, count=None):
    h=sha256()
    while count is None or count>0:
        block=stream.read(1024*1024 if count is None else min(count,1024*1024))
        if not block:
            break
        h.update(block)
        if count is not None:
            count-=len(block)
    need(count is None or count==0,'SHORT_ASSET')
    return h.hexdigest()


def pinned(path):
    info=path.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and path.absolute()==path.resolve(strict=True),'LOCAL_ASSET_ID')
    return path


def assembly(repo,node_media,engine_media,asset_manifest,evidence,output):
    need(not output.exists() and output.parent.resolve()==output.parent,'NEW_OUTPUT_REQUIRED')
    with pinned(node_media).open('rb') as stream:
        need(digest(stream,30991864)==NODE_ARCHIVE and stream.read()==bytes(8),'NODE_MEDIA_PIN')
    with pinned(engine_media).open('rb') as stream:
        need(digest(stream)==MEDIA,'ENGINE_MEDIA_PIN')
    raw=pinned(asset_manifest).read_bytes()
    need(sha256(raw).hexdigest()==ASSETS,'ASSET_METADATA_PIN')
    assets=json.loads(raw)
    need(sha256(pinned(evidence).read_bytes()).hexdigest()==NATIVE_EVIDENCE,'NATIVE_EVIDENCE_PIN')
    expected={**assets['runtime']['cpuFiles'],MODEL:assets['model']['manifestSha256'],
              **{'models/blobs/sha256-'+key:key for key in assets['blobs']}}
    paths=subprocess.check_output(['git','ls-files','-z'],cwd=repo).decode().strip('\0').split('\0')
    revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
    entries={}
    def put(archive,name,source,size,mode,wanted=None):
        need(name not in entries,'DUPLICATE_RELEASE_OBJECT')
        computed=digest(source,size)
        need(not wanted or wanted==computed,'FILE_SHA_MISMATCH:'+name)
        source.seek(0)
        record=tarfile.TarInfo(name)
        record.size=size
        record.mode=mode
        archive.addfile(record,source)
        entries[name]={'sha256':computed,'size':size,'mode':mode}
    with tarfile.open(output,'x',format=tarfile.USTAR_FORMAT) as out:
        for relative in sorted(paths):
            if relative in ('package.json','server.mjs') or (relative.startswith(('src/','public/','tools/')) and
                    Path(relative).suffix in ('.mjs','.js','.json','.html','.css','.py') and
                    not relative.startswith('tools/fixtures/') and
                    Path(relative).name not in ('nx-entry-lab.py','lab-worker.mjs','pack-stage.py','arm64-replay.py','arm64-guest.py','legacy-guest.py')):
                data=pinned(repo/relative).read_bytes()
                need(data==subprocess.check_output(['git','show',revision+':'+relative],cwd=repo),'SOURCE_DRIFT')
                put(out,'code/'+relative,BytesIO(data),len(data),0o444)
                if relative in ('tools/engine-qualification/readiness.mjs','tools/engine-qualification/stdio-guard.py'):
                    put(out,'engine/'+Path(relative).name,BytesIO(data),len(data),0o444)
        with tarfile.open(node_media,'r:xz') as archive:
            node=archive.getmember('node-v24.22.3-linux-arm64/bin/node')
            need(node.isfile() and node.size==123446736,'NODE_MEMBER')
            with archive.extractfile(node) as stream:
                put(out,'code/runtime/node',stream,node.size,0o555,NODE_SHA)
        with tarfile.open(engine_media,'r:') as archive:
            for name,wanted in sorted(expected.items()):
                member=archive.getmember(PREFIX+name)
                need(member.isfile() and member.uid==member.gid==0 and 0<member.size<=512*1024**2,'ENGINE_MEMBER')
                with archive.extractfile(member) as stream:
                    put(out,'engine/assets/'+name,stream,member.size,0o555 if member.mode==0o555 else 0o444,wanted)
        manifest=json.dumps({'mode':MODE,'files':entries,'nativeEvidenceSha256':NATIVE_EVIDENCE},
                            sort_keys=True,separators=(',',':')).encode()
        put(out,'files.json',BytesIO(manifest),len(manifest),0o444)
    with output.open('rb') as archive:
        result={'sourceCommit':revision,'tarSha256':digest(archive),'manifestSha256':sha256(manifest).hexdigest(),
                'payloads':len(entries)-1,'approvalIncluded':False,'assetsIncluded':True}
    return result


if __name__=='__main__':
    need(len(sys.argv)==7,'USAGE repo node-media engine-media asset-pins evidence fresh-output-tar')
    print(json.dumps(assembly(*(Path(p).absolute() for p in sys.argv[1:])),sort_keys=True))
