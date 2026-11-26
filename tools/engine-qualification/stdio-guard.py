"""Linux descriptor and process-identity guard for the isolated ARM64 engine actor."""

import errno
import json
import os
import re
import socket
import stat
import struct
import sys
from pathlib import Path

current = Path(__file__).absolute()
NX_ROOT = current.parent
NX = any(current == Path('/opt/acm-nx-'+slot+'-v1/engine/stdio-guard.py')
         for slot in ('legacy-cpu','h3-json','h3-sse'))
ROOT = NX_ROOT if NX else Path('/opt/acm-rc2-engine-readiness')
BINARY = str(ROOT / 'assets/ollama/bin/ollama')
GROUP = '/system.slice/acm-rc2-engine-readiness.service/engine'
ACTOR_ID = 65202


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def parent_identity(pid):
    status = Path(f'/proc/{pid}/status').read_text(encoding='utf-8')
    fields = dict(line.split(':', 1) for line in status.splitlines() if ':' in line)
    row = Path(f'/proc/{pid}/stat').read_text(encoding='utf-8').rpartition(') ')[2].split()
    uid, gid = ([int(value) for value in fields[name].split()] for name in ('Uid', 'Gid'))
    require(len(uid) == len(gid) == 4 and len(set(uid)) == len(set(gid)) == 1, 'STDIO_PARENT_IDENTITY')
    return pid, int(row[19]), uid[0], gid[0]


def check_parent(expected):
    try:
        actual = parent_identity(expected[0])
    except (OSError, KeyError, IndexError, ValueError):
        raise RuntimeError('STDIO_PARENT_UNVERIFIED') from None
    require(os.getppid() == expected[0] and actual == expected, 'STDIO_PARENT_IDENTITY')


def snapshot():
    rows = {}
    try:
        for name in os.listdir('/proc/self/fd'):
            try:
                rows[int(name)] = os.readlink('/proc/self/fd/' + name)
            except FileNotFoundError:
                continue  # procfs 結束列舉時已關閉暫時的目錄描述元。
    except (OSError, ValueError):
        raise RuntimeError('STDIO_FD_UNVERIFIED') from None
    require(set(rows) == {0, 1, 2}, 'STDIO_FD_SET')
    return rows


def check_endpoint(fd, path, expected):
    duplicate = None
    try:
        info = os.fstat(fd)
        require(stat.S_ISSOCK(info.st_mode) and path == f'socket:[{info.st_ino}]', 'STDIO_OBJECT')
        duplicate = os.dup(fd)
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM, 0, fileno=duplicate) as endpoint:
            duplicate = None
            same = os.fstat(endpoint.fileno())
            require((same.st_dev, same.st_ino) == (info.st_dev, info.st_ino), 'STDIO_OBJECT')
            option = lambda key: endpoint.getsockopt(socket.SOL_SOCKET, key)
            require(option(socket.SO_DOMAIN) == socket.AF_UNIX and option(socket.SO_TYPE) == socket.SOCK_STREAM
                    and option(socket.SO_ACCEPTCONN) == 0 and endpoint.getsockname() == ''
                    and endpoint.getpeername() == '', 'STDIO_SOCKET_KIND')
            raw = endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('=iII'))
            peer = struct.unpack('=iII', raw)
    except (OSError, AttributeError, struct.error):
        raise RuntimeError('STDIO_PEER_UNVERIFIED') from None
    finally:
        if duplicate is not None:
            os.close(duplicate)
    require(peer == (expected[0], expected[2], expected[3]), 'STDIO_PEER_IDENTITY')
    return info.st_dev, info.st_ino


def verify_stdio(parent_pid, parent_tick, parent_uid, parent_gid):
    expected = parent_pid, parent_tick, parent_uid, parent_gid
    check_parent(expected)
    paths = snapshot()
    try:
        info, null = os.fstat(1), os.stat('/dev/null', follow_symlinks=False)
    except OSError:
        raise RuntimeError('STDIO_NULL') from None
    require(paths[1] == '/dev/null' and stat.S_ISCHR(null.st_mode) and stat.S_ISCHR(info.st_mode)
            and (os.major(info.st_rdev), os.minor(info.st_rdev)) == (1, 3)
            and (info.st_dev, info.st_ino, info.st_rdev) == (null.st_dev, null.st_ino, null.st_rdev), 'STDIO_NULL')
    require(check_endpoint(0, paths[0], expected) != check_endpoint(2, paths[2], expected), 'STDIO_OBJECT')
    require(snapshot() == paths, 'STDIO_FD_CHANGED')
    check_parent(expected)
    return {'0': 'ANONYMOUS_UNIX_STREAM', '1': 'DEV_NULL', '2': 'ANONYMOUS_UNIX_STREAM'}


def emit(verdict, **fields):
    print('ACM_RC2_ACTOR_GATE=' + json.dumps({'verdict': verdict, **fields}), file=sys.stderr, flush=True)


def launch(arguments):
    legacy = '/acmlegacycpu.slice/acm-rc2-engine-readiness.service/engine'
    require(len(arguments) == 5 and arguments[0] in ((legacy,) if NX else (GROUP, legacy)), 'ACTOR_ARGUMENTS')
    require(Path(__file__).resolve(strict=True) == ROOT / 'stdio-guard.py', 'ACTOR_ARGUMENTS')
    require(all(re.fullmatch(r'[0-9]{1,20}', value) for value in arguments[1:]), 'ACTOR_ARGUMENTS')
    expected = tuple(map(int, arguments[1:]))
    require(os.getuid() == os.getgid() == os.geteuid() == os.getegid() == 0, 'ACTOR_UID')
    require(expected[2:] == (0, 0), 'ACTOR_UID')
    try:
        os.setgroups([])
        os.setgid(ACTOR_ID)
        os.setuid(ACTOR_ID)
    except OSError:
        raise RuntimeError('ACTOR_UID') from None
    require(set(os.getresuid() + os.getresgid()) == {ACTOR_ID} and not os.getgroups(), 'ACTOR_UID')
    kinds = verify_stdio(*expected)
    require(os.read(0, 1) == b'R' and os.read(0, 1) == b'', 'ACTOR_GATE_REFUSED')
    require(Path('/proc/self/cgroup').read_text(encoding='utf-8').strip() == '0::' + arguments[0], 'ACTOR_CGROUP')
    for path in ('/run/ollama.sock', '/run/nvargus_socket', '/tmp/argus_socket', '/usr/share/ollama',
                 '/var/lib/ollama', '/proc/1/root/usr/share/ollama'):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError as error:
            require(error.errno in (errno.ENOENT, errno.EACCES, errno.EPERM, errno.ENOTDIR, errno.ELOOP),
                    'ACTOR_SCOPE')
        else:
            os.close(fd)
            raise RuntimeError('ACTOR_SCOPE')
    require(verify_stdio(*expected) == kinds, 'STDIO_FD_CHANGED')
    emit('PASS', fds=kinds)
    try:
        os.execve(BINARY, [BINARY, 'serve'], os.environ)
    except OSError:
        raise RuntimeError('ACTOR_EXEC') from None


if __name__ == '__main__':
    try:
        launch(sys.argv[1:])
    except (ValueError, OSError, RuntimeError) as error:
        detail = str(error)
        code = detail if re.fullmatch(r'(?:STDIO|ACTOR)_[A-Z_]+', detail) else 'ACTOR_IO_UNVERIFIED'
        emit('HOLD', code=code)
        raise SystemExit(42)
