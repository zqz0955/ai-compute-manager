"""Forward fixed H3 frames over a root-owned local UNIX socket."""

import os
import selectors
import socket
import stat
import struct
import sys


OWN_PATH = os.path.abspath(__file__)
SLOT = next((slot for slot in ('json','sse') if
             OWN_PATH == '/opt/acm-nx-h3-'+slot+'-v1/code/tools/h3/attach.py'), None)


def relay():
    if os.geteuid() == 0 or SLOT is None or os.path.realpath(__file__) != OWN_PATH or len(sys.argv) != 1:
        raise RuntimeError('H3_ATTACH_BOUNDARY')
    path = '/opt/acm-nx-h3-'+SLOT+'-audit-v1/transport.sock'
    parent = os.lstat(os.path.dirname(path))
    node = os.lstat(path)
    if not (stat.S_ISDIR(parent.st_mode) and parent.st_uid == 0 and parent.st_gid == 0 and
            stat.S_IMODE(parent.st_mode) == 0o711 and stat.S_ISSOCK(node.st_mode) and
            node.st_uid == 0 and node.st_gid == os.getegid() and stat.S_IMODE(node.st_mode) == 0o660):
        raise RuntimeError('H3_ATTACH_SOCKET')
    if not stat.S_ISFIFO(os.fstat(0).st_mode) or not stat.S_ISFIFO(os.fstat(1).st_mode):
        raise RuntimeError('H3_ATTACH_STDIO')
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as endpoint:
        endpoint.settimeout(120)
        endpoint.connect(path)
        _, uid, gid = struct.unpack('=iII',
                                  endpoint.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('=iII')))
        if uid != 0 or gid != 0 or os.lstat(path).st_ino != node.st_ino:
            raise RuntimeError('H3_ATTACH_PEER')
        with selectors.DefaultSelector() as poll:
            poll.register(0, selectors.EVENT_READ)
            poll.register(endpoint, selectors.EVENT_READ)
            while True:
                events = poll.select(timeout=125)
                if not events:
                    raise RuntimeError('H3_ATTACH_TIMEOUT')
                for event, _ in events:
                    if event.fileobj == 0:
                        data = os.read(0, 8192)
                        if not data:
                            endpoint.shutdown(socket.SHUT_WR)
                            poll.unregister(0)
                        else:
                            endpoint.sendall(data)
                    else:
                        data = endpoint.recv(8192)
                        if not data:
                            return
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()


if __name__ == '__main__':
    try:
        relay()
    except (OSError, RuntimeError):
        print('ACM_H3_ATTACH_HOLD', file=sys.stderr)
        raise SystemExit(42) from None
