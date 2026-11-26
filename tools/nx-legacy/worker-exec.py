"""Fixed preparatory entry for the non-root signing worker."""
import errno
import fcntl
import os
from pathlib import Path
import stat
import subprocess
import sys

current=Path(__file__).absolute()
ROOT=current.parents[2]
ROOT_ALLOWED=any(ROOT==Path('/opt/acm-nx-'+slot+'-v1/code') for slot in ('legacy-cpu','h3-json','h3-sse'))
UID=65201
H3_UID=65203
ENV={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'}


def require(condition):
    if not condition:
        raise SystemExit('NX_WORKER_NAMESPACE')


def main():
    h3=sys.argv[1:]==['h3-role']
    script=ROOT/'tools/nx-legacy/worker-exec.py'
    require(ROOT_ALLOWED and Path(__file__).resolve(strict=True)==script and os.geteuid()==os.getegid()==0)
    if h3:
        require(ROOT.parent.name in ('acm-nx-h3-json-v1','acm-nx-h3-sse-v1') and
                not os.getenv('NODE_CHANNEL_FD') and all(stat.S_ISSOCK(os.fstat(fd).st_mode) for fd in (0,1)))
        key=os.fstat(4)
        require(stat.S_ISREG(key.st_mode) and key.st_uid==key.st_gid==0 and key.st_nlink==1 and
                stat.S_IMODE(key.st_mode)==0o400 and 0<key.st_size<=4096 and
                fcntl.fcntl(4,fcntl.F_GETFL)&os.O_ACCMODE==os.O_RDONLY)
    else:
        require(len(sys.argv)==1 and os.getenv('NODE_CHANNEL_FD')=='3' and stat.S_ISSOCK(os.fstat(3).st_mode))
    require(all(os.readlink('/proc/self/ns/'+ns)!=os.readlink('/proc/1/ns/'+ns) for ns in ('net','mnt','ipc')))
    interfaces=Path('/proc/self/net/dev').read_text().splitlines()[2:]
    require([row.split(':')[0].strip() for row in interfaces]==['lo'])
    # /dev 最後遮蔽，mount 子程序仍須能使用原 /dev/null。
    for path in ('/run','/tmp','/var/tmp','/usr/share/ollama','/var/lib/ollama','/dev'):
        if os.path.lexists(path):
            info=Path(path).lstat()
            require(stat.S_ISDIR(info.st_mode) and (info.st_uid==0 or path=='/usr/share/ollama'))
            subprocess.run(['/usr/bin/mount','-t','tmpfs','-o','nodev,nosuid,noexec,ro,size=64k,mode=000',
                            'tmpfs',path],env=ENV,stdin=subprocess.DEVNULL,close_fds=True,check=True,timeout=4)
    os.setgroups([])
    if h3:
        os.setresgid(H3_UID,H3_UID,H3_UID)
        os.setresuid(H3_UID,H3_UID,H3_UID)
    else:
        os.setgid(UID)
        os.setuid(UID)
    for path in ('/proc/1/root/usr/share/ollama','/usr/share/ollama','/var/lib/ollama','/dev','/run','/tmp','/var/tmp'):
        try:
            fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
        except OSError as exc:
            require(exc.errno in (errno.ENOENT,errno.EACCES,errno.EPERM))
        else:
            os.close(fd)
            require(False)
    node=str(ROOT/'runtime/node')
    if h3:
        # 去除未列入本角色契約的繼承描述元，保留固定訊框管道及唯讀金鑰。
        for name in os.listdir('/proc/self/fd'):
            fd=int(name)
            if fd>=3 and fd!=4:
                try:
                    os.close(fd)
                except OSError as error:
                    require(error.errno==errno.EBADF)
        os.set_inheritable(4,True)
        os.execve(node,[node,str(ROOT/'tools/h3/nx-worker-role.mjs')],ENV)
    os.set_inheritable(3,True)
    os.execve(node,[node,str(ROOT/'tools/nx-legacy/worker-channel.mjs'),'worker'],{**ENV,'NODE_CHANNEL_FD':'3'})


if __name__=='__main__':
    try:
        main()
    except (OSError,subprocess.SubprocessError) as error:
        print('NX_WORKER_SETUP_NOT_CONFIRMED:'+type(error).__name__,file=sys.stderr,flush=True)
        raise SystemExit(42) from None
