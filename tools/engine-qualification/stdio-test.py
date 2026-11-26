"""Create finite Linux-local descriptor fixtures. Never starts an engine."""

import json
import os
import runpy
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve(strict=True)
GUARD = runpy.run_path(str(HERE.with_name('stdio-guard.py')))
IDENTITY = GUARD['parent_identity']
PYTHON = '/usr/bin/python3'
QEMU = Path('/sys/class/dmi/id/product_name')


def argv(*args):
    return [PYTHON, '-I', '-B', str(HERE), *map(str, args)]


def probe(mode, expected):
    if mode == 'missing-peer':
        del socket.SO_PEERCRED
    try:
        result = {'verdict': 'PASS', 'fds': GUARD['verify_stdio'](*map(int, expected))}
    except RuntimeError as problem:
        result = {'verdict': 'HOLD', 'code': str(problem)}
    print(json.dumps(result), file=sys.stderr, flush=True)


def fixture(mode):
    with tempfile.TemporaryDirectory(prefix='acm-r3-stdio-', dir='/tmp') as temp:
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            if mode == 'named':
                server.bind(temp + '/named.sock')
                server.listen()
                inbox = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                inbox.connect(temp + '/named.sock')
                gate, _ = server.accept()
                command = argv('probe', 'normal', *IDENTITY(os.getpid()))
            elif mode == 'wrong-peer':
                inbox, gate = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
                command = argv('middle')
            else:
                raise RuntimeError('TEST_SCOPE')
            with inbox, gate:
                result = subprocess.run(command, stdin=gate, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                        text=True, timeout=6, check=True)
            print(result.stderr.strip(), file=sys.stderr, flush=True)
        finally:
            server.close()


def main():
    assert sys.platform == 'linux' and os.uname().machine == 'aarch64' and 'QEMU' in QEMU.read_text()
    mode, *args = sys.argv[1:]
    if mode == 'probe':
        probe(args[0], args[1:])
    elif mode == 'fixture':
        fixture(*args)
    elif mode == 'middle':
        # socketpair 由外層程序建立。最後一層接收端的真父程序是這一層。
        subprocess.run(argv('probe', 'normal', *IDENTITY(os.getpid())), check=True, timeout=3)
    else:
        raise RuntimeError('TEST_SCOPE')


if __name__ == '__main__':
    main()
