"""R1 protected-file helpers. Source SHA-256 7d19a7970956e82c964a9d85e9e96065275224784e3de265f063d6bedc57d393. """
import contextlib
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess

ENV={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'}
DIRFLAGS=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC

def need(value, reason):
    if not value:
        raise RuntimeError(reason)

def sha(value):
    return hashlib.sha256(value).hexdigest()

def file_id(st):
    return [st.st_dev,st.st_ino,st.st_uid,st.st_gid,stat.S_IMODE(st.st_mode),st.st_size,
            st.st_mtime_ns,st.st_ctime_ns,st.st_nlink]

def mount_id(fd):
    content=Path('/proc/self/fdinfo/'+str(fd)).read_text(encoding='ascii')
    match=re.search(r'^mnt_id:\s+(\d+)$',content,re.M)
    need(match,'MOUNT_ID_UNAVAILABLE')
    return int(match[1])

def directory_id(fd):
    info=os.fstat(fd)
    return [info.st_dev,info.st_ino,info.st_uid,info.st_gid,stat.S_IMODE(info.st_mode),mount_id(fd)]

@contextlib.contextmanager
def directory_handle(path):
    need(path.is_absolute() and '..' not in path.parts, 'UNTRUSTED_PATH')
    fd=os.open('/',DIRFLAGS)
    baseline=directory_id(fd)
    try:
        for part in path.parts[1:]:
            nxt=os.open(part,DIRFLAGS,dir_fd=fd)
            os.close(fd)
            fd=nxt
            dev,_,uid,gid,mode,mount=directory_id(fd)
            need(dev==baseline[0] and mount==baseline[-1] and uid==gid==0 and mode&0o022==0 and
                 not any(x.startswith('system.posix_acl_') for x in os.listxattr(fd)), 'UNTRUSTED_DIRECTORY')
        yield fd
    finally:
        os.close(fd)

def directory(path):
    with directory_handle(path):
        return path

def read_asset(path, record=None, keep=False, destination=None):
    with directory_handle(path.parent) as parent:
        fd = os.open(path.name,os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,dir_fd=parent)
        if mount_id(fd)!=mount_id(parent):
            os.close(fd)
            raise RuntimeError('ASSET_MOUNT_CHANGED')
    with os.fdopen(fd,'rb') as file:
        info = os.fstat(file.fileno())
        mode = stat.S_IMODE(info.st_mode)
        need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == info.st_gid == 0 and
             info.st_dev == path.parent.stat().st_dev and mode in (0o400,0o444,0o555) and
             not any(x.startswith('system.posix_acl_') for x in os.listxattr(file.fileno())) and
             (info.st_size <= 1048576 if keep else info.st_size <= 8*1024**3), 'UNTRUSTED_ASSET')
        if record:
            need((info.st_size,mode)==(record['size'],record['mode']),'ASSET_METADATA')
        digest = hashlib.sha256()
        saved = []
        while data := file.read(1024*1024):
            digest.update(data)
            if destination:
                destination.write(data)
            if keep:
                saved.append(data)
        need(file_id(info)==file_id(path.lstat())==file_id(os.fstat(file.fileno())), 'ASSET_REPLACED')
    digest = digest.hexdigest()
    if record:
        need(digest==record['sha256'],'ASSET_HASH')
    return (b''.join(saved) if keep else digest),file_id(info)

def call(*argv, timeout=12):
    return subprocess.run(argv,stdin=subprocess.DEVNULL,capture_output=True,text=True,env=ENV,timeout=timeout)

def verify_no_holder(targets):
    identities = set()
    for root,pins,extra in targets:
        for table in ('files','directories'):
            identities.update(tuple(row[:2]) for row in pins[table].values())
    for proc in Path('/proc').iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            for resource in (proc/'cwd',proc/'root',proc/'exe',*(proc/'fd').iterdir()):
                try:
                    inode=resource.stat()
                except (FileNotFoundError,ProcessLookupError):
                    continue
                need((inode.st_dev,inode.st_ino) not in identities,'CLEANUP_FILE_HELD')
            with (proc/'maps').open(encoding='utf-8',errors='replace') as maps:
                for line in maps:
                    row=line.split(maxsplit=5)
                    if len(row)>=5 and row[4]!='0':
                        dev=os.makedev(*(int(x,16) for x in row[3].split(':')))
                        need((dev,int(row[4])) not in identities,'CLEANUP_MAPPING_HELD')
        except (FileNotFoundError,ProcessLookupError):
            continue
