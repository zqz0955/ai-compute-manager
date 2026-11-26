"""一次操作窗口的桌面 FD 例外。僅在管理端觀測器內保有 FD 證據。"""
from collections import Counter
import ctypes
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import select
import stat
import subprocess
import time


CARD = ('/dev/dri/card1', 226, 1)
RENDER = ('/dev/dri/renderD128', 226, 128)
CTRL = ('/dev/nvgpu/igpu0/ctrl', 487, 14)
MODESET = ('/dev/nvidia-modeset', 195, 254)
NVMAP = ('/dev/nvmap', 10, 124)
ROLES = {
    'Xorg': (CARD, *([RENDER] * 8), CTRL, *([MODESET] * 3), NVMAP),
    'gnome-shell': (RENDER, RENDER, CTRL, MODESET, NVMAP),
    'xdg-desktop-portal-gnome': (RENDER, RENDER, CTRL, MODESET, NVMAP),
}
ROLE_NAMES = tuple(ROLES)
DEVICE_PATH = re.compile(r'^/dev/(?:dri/|nvidia|nvgpu|nvhost|nvmap|tegra|video|media|v4l|fb\d|nvdisp|nvdec|nvenc|acm-fixture-)')
EXE_PATH = re.compile(r'^/usr/(?:bin|lib|libexec)/[A-Za-z0-9_./+-]+$')
SESSION_PROPS = ('Id', 'User', 'Scope', 'Leader', 'Display', 'Active', 'Remote',
                 'State', 'Type', 'Seat', 'Class', 'TimestampMonotonic')
X11_DIRECTORY = Path('/tmp/.X11-unix')
X11_ENDPOINT = re.compile(r'(@?)/tmp/\.X11-unix/X(0|[1-9][0-9]{0,2})')
PURPOSE = 'NX_FAKE_ENGINE_SYSTEMD_ONCE'
LAB_WINDOW = Path('/opt/acm-lab-desktop-window.json')
PROFILE_NX = 'ORIN_NX'
PROFILE_LAB = 'ISOLATED_QEMU_X64'
MAX_WINDOW_SECONDS = 1800
WIN_MIN_REMAINING = 160
PIDFD_GETFD = 438
KCMP_FILE = 0


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)

def safe_failure(error):
    message = str(error)
    result = {'type': type(error).__name__}
    if isinstance(error, RuntimeError) and re.fullmatch(r'[A-Z][A-Z0-9_, ]{0,180}', message):
        result['reason'] = message
    if isinstance(error, OSError):
        result['errno'] = errno.errorcode.get(error.errno)
    trace = error.__traceback__
    while trace is not None:
        code = trace.tb_frame.f_code
        filename = Path(code.co_filename).name
        if filename in ('nx_desktop.py', 'nx_observe.py', 'nxctl.py', 'nx-preflight-readonly.py'):
            if code.co_name not in ('require','required') and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', code.co_name):
                result['at'] = {'file': filename, 'function': code.co_name, 'line': trace.tb_lineno}
        trace = trace.tb_next
    return result

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def read_boot():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def proc_ticks(proc):
    return int((proc/'stat').read_text().rsplit(')', 1)[1].split()[19])


def owner_mode(s):
    return [s.st_dev, s.st_ino, s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode)]


def same_node(a, b):
    return (a.st_dev, a.st_ino, a.st_rdev) == (b.st_dev, b.st_ino, b.st_rdev)


def command(*argv):
    result = subprocess.run(argv, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=4,
                            env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
    require(result.returncode == 0 and len(result.stdout) < 16384, 'DESKTOP_METADATA_UNAVAILABLE')
    return result.stdout.rstrip()


def properties(output):
    result = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        key, sep, value = line.partition('=')
        require(sep and key and key not in result, 'DESKTOP_METADATA_FORMAT')
        result[key] = value.strip()
    return result


def logind(verb, ident, fields):
    return properties(command('/usr/bin/loginctl','--no-pager','--all',
                              *('--property='+field for field in fields),verb,'--',ident))


def session_state(expected, profile):
    if profile == PROFILE_LAB:
        # 只有隔離 guest 使用 systemd 系統單元模擬 logind 工作階段。
        return {'lab': True, 'boot': read_boot()}
    ident = expected['Id']
    require(re.fullmatch(r'[A-Za-z0-9]{1,16}', ident), 'DESKTOP_SESSION_SCHEMA')
    info = logind('show-session', ident, SESSION_PROPS)
    required_fields = set(SESSION_PROPS) - {'Display'}
    require(required_fields <= info.keys() <= set(SESSION_PROPS), 'DESKTOP_SESSION_PROPERTIES_MISSING')
    require(info['Id'] == ident and
            info['User'] == '1000' and info['Scope'] == 'session-'+ident+'.scope' and
            info['Active'] == 'yes' and info['Remote'] == 'no' and info['State'] == 'active' and
            info['Type'] == 'x11' and info['Seat'] == 'seat0' and info['Class'] == 'user' and
            (not info.get('Display') or re.fullmatch(r':[0-9]{1,3}', info['Display'])) and
            info['Leader'].isdigit() and int(info['Leader']) > 1 and
            info['TimestampMonotonic'].isdigit() and int(info['TimestampMonotonic']) > 0,
            'DESKTOP_SESSION_UNQUALIFIED')
    info.setdefault('Display', None)
    user = logind('show-user', '1000', ('Display','Sessions'))
    for other in user.get('Sessions', '').split():
        require(re.fullmatch(r'[A-Za-z0-9]{1,16}', other), 'DESKTOP_SESSION_SCHEMA')
        if other != ident:
            peer = logind('show-session', other, ('Type',))
            require(peer.get('Type') in ('tty', 'unspecified'), 'DESKTOP_SESSION_AMBIGUOUS')
    require(user.get('Display') == ident and ident in user.get('Sessions', '').split(),
            'DESKTOP_SESSION_AMBIGUOUS')
    leader = Path('/proc')/info['Leader']
    info['LeaderStartTicks'] = proc_ticks(leader)
    require(info['LeaderStartTicks'] > 0 and (leader/'cgroup').read_text().strip() ==
            '0::'+desktop_cgroup('Xorg',info,profile), 'DESKTOP_SESSION_LEADER_IDENTITY')
    return info


def x11_listeners(text, socket_fds):
    lines = text.splitlines()
    require(lines and lines[0].split() == ['Num','RefCount','Protocol','Flags','Type','St','Inode','Path'],
            'DESKTOP_X11_SOCKET_TABLE')
    listening = []
    for line in lines[1:]:
        cols = line.split(maxsplit=7)
        if len(cols) != 8 or not X11_ENDPOINT.fullmatch(cols[7]):
            continue
        flags, kind, state = map(lambda v: int(v,16), cols[3:6])
        if flags & 0x10000 and kind == 1:
            require(state == 1 and cols[6].isdigit(), 'DESKTOP_X11_SOCKET_TABLE')
            listening.append((cols[7], int(cols[6])))
    owned = [(path,inode) for path,inode in listening if inode in socket_fds]
    displays = {path.removeprefix('@') for path,_ in owned}
    require(len(displays) == 1, 'DESKTOP_X11_SOCKET_OWNER_AMBIGUOUS')
    pathname = displays.pop()
    endpoints = [(path,inode) for path,inode in listening if path.removeprefix('@') == pathname]
    require(len(endpoints) == len({p for p,_ in endpoints}) and
            pathname in {p for p,_ in endpoints} and endpoints == owned, 'DESKTOP_X11_SOCKET_OWNER_MISMATCH')
    return pathname, [{'address':path,'inode':inode,'fds':socket_fds[inode]} for path,inode in sorted(endpoints)]


def namespace(proc, kind):
    info = (proc/'ns'/kind).stat()
    return [info.st_dev,info.st_ino]


def x11_binding(xorg, reported):
    proc = Path('/proc')/str(xorg['pid'])
    net, mount = namespace(proc,'net'), namespace(proc,'mnt')
    require(net == namespace(Path('/proc/self'),'net') and mount == namespace(Path('/proc/self'),'mnt'),
            'DESKTOP_X11_NAMESPACE')
    socket_fds = {}
    for item in (proc/'fd').iterdir():
        try:
            handle = os.readlink(item)
        except FileNotFoundError:
            continue
        matched = re.fullmatch(r'socket:\[(\d+)\]', handle)
        if matched:
            socket_fds.setdefault(int(matched[1]),[]).append(int(item.name))
    with (proc/'net/unix').open('r',encoding='utf-8',errors='replace') as table:
        text = table.read(524289)
    require(len(text) <= 524288, 'DESKTOP_X11_SOCKET_TABLE_OVERSIZE')
    pathname, sockets = x11_listeners(text,{inode:sorted(values) for inode,values in socket_fds.items()})
    display = ':'+X11_ENDPOINT.fullmatch(pathname)[2]
    require(not reported or reported == display, 'DESKTOP_X11_LOGIND_MISMATCH')
    parents = []
    for parent in (X11_DIRECTORY.parent,X11_DIRECTORY):
        st = parent.lstat()
        require(stat.S_ISDIR(st.st_mode) and st.st_uid == st.st_gid == 0 and
                (not st.st_mode & 0o022 or st.st_mode & stat.S_ISVTX), 'DESKTOP_X11_SOCKET_ANCESTRY')
        parents.append(owner_mode(st))
    node = Path(pathname).lstat()
    require(stat.S_ISSOCK(node.st_mode) and node.st_uid == node.st_gid == 0 and node.st_nlink == 1,
            'DESKTOP_X11_SOCKET_FILE')
    for endpoint in sockets:
        for fd in endpoint['fds']:
            link = proc/'fd'/str(fd)
            st = link.stat()
            require(stat.S_ISSOCK(st.st_mode) and st.st_ino == endpoint['inode'] and
                    os.readlink(link) == "socket:["+str(endpoint['inode'])+"]", 'DESKTOP_X11_SOCKET_FD_CHANGED')
    require(proc_ticks(proc) == xorg['startTicks'] and (proc/'cgroup').read_text().strip() == '0::'+xorg['cgroup'] and
            namespace(proc,'net') == net and namespace(proc,'mnt') == mount, 'DESKTOP_X11_PROCESS_CHANGED')
    return {'display':display,'pid':xorg['pid'],'startTicks':xorg['startTicks'],
            'listeners':sockets,'socketNode':owner_mode(node),'parentNodes':parents,
            'netNamespace':net,'mountNamespace':mount}


def host_device_ids():
    ids = {(major, minor) for devices in ROLES.values() for _, major, minor in devices}
    def unreadable(error):
        raise error
    for root, _, files in os.walk('/dev', followlinks=False, onerror=unreadable):
        for name in files:
            path = Path(root)/name
            if not DEVICE_PATH.match(str(path)):
                continue
            details = path.lstat()
            if stat.S_ISCHR(details.st_mode):
                ids.add((os.major(details.st_rdev), os.minor(details.st_rdev)))
    return ids


def device_fd(path, target, ids):
    if DEVICE_PATH.match(target) or re.match(r'^(?:anon_inode:\[?|/)dma[_-]?buf', target):
        return True
    if not ids or not target.startswith('/'):
        return False
    s = path.stat()
    if not stat.S_ISCHR(s.st_mode):
        return False
    dev = (os.major(s.st_rdev), os.minor(s.st_rdev))
    # Tegra 的停用裝置節點可能使用 null driver，不能把其他 null FD 當成裝置別名。
    return dev != (1,3) and (dev[0] in (29,81,195,226) or dev in ids)


def executable(proc, role, profile):
    link = proc/'exe'
    path = Path(os.readlink(link))
    if profile == PROFILE_NX:
        known_path = EXE_PATH.fullmatch(str(path)) and path.name == role
    else:
        known_path = path == Path('/opt/acm-lab-desktop-bin')/role
    require(known_path and path.resolve(strict=True) == path, 'DESKTOP_EXEC_PATH')
    for folder in path.parents:
        details = folder.lstat()
        require(stat.S_ISDIR(details.st_mode) and details.st_uid == 0 and not details.st_mode & 0o022,
                'DESKTOP_EXEC_ANCESTRY')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        details = os.fstat(source.fileno())
        require(stat.S_ISREG(details.st_mode) and details.st_nlink == 1 and details.st_uid == 0 and
                not details.st_mode & 0o022 and 0 < details.st_size <= 64*1024*1024 and
                same_node(details, link.stat()) and source.read(4) == b'\x7fELF',
                'DESKTOP_EXEC_IDENTITY')
        source.seek(0)
        sha = hashlib.sha256()
        for chunk in iter(lambda: source.read(65536), b''):
            sha.update(chunk)
        require(os.fstat(fd).st_ctime_ns == details.st_ctime_ns and same_node(details, path.stat()) and
                same_node(details, link.stat()), 'DESKTOP_EXEC_IDENTITY')
    package, version = 'isolated-test-substitute', '1'
    if profile == PROFILE_NX:
        dpkg = '/usr/bin/dpkg-query'
        matches = command(dpkg, '--search', '--', str(path)).splitlines()
        package, sep, registered = matches[0].partition(': ') if len(matches) == 1 else ('', '', '')
        require(sep and registered == str(path) and re.fullmatch(r'[a-z0-9][a-z0-9+.-]*(?::arm64)?', package),
                'DESKTOP_EXEC_PACKAGE')
        status, version = command(dpkg, '--show', '--showformat=${db:Status-Abbrev}|${Version}', '--', package).split('|')
        require(status.strip() == 'ii' and version, 'DESKTOP_EXEC_PACKAGE')
    return {'path': str(path), 'node': owner_mode(details), 'sha256': sha.hexdigest(),
            'package': package, 'version': version}


def desktop_cgroup(role, session, profile):
    if profile == PROFILE_LAB:
        return '/system.slice/acm-lab-desktop-'+str(ROLE_NAMES.index(role))+'.service'
    user = '/user.slice/user-1000.slice'
    return {
        'Xorg': user+'/'+session['Scope'],
        'gnome-shell': user+'/user@1000.service/session.slice/org.gnome.Shell@x11.service',
        'xdg-desktop-portal-gnome': user+'/user@1000.service/app.slice/xdg-desktop-portal-gnome.service',
    }[role]


def device_state(proc, number, target):
    path = Path(target)
    link = proc/'fd'/number
    require(path.is_absolute() and path.resolve(strict=True) == path and
            os.readlink(link) == target, 'DESKTOP_DEVICE_PATH')
    details = path.lstat()
    info = dict(line.split(':', 1) for line in (proc/'fdinfo'/number).read_text().splitlines() if ':' in line)
    flags = int(info['flags'], 8)
    require(stat.S_ISCHR(details.st_mode) and same_node(details, link.stat()) and
            int(info['ino']) == details.st_ino and flags & os.O_ACCMODE == os.O_RDWR and
            not flags & os.O_PATH and os.readlink(link) == target, 'DESKTOP_DEVICE_IDENTITY')
    try:
        acl = hashlib.sha256(os.getxattr(path, 'system.posix_acl_access')).hexdigest()
    except OSError as error:
        if error.errno != errno.ENODATA:
            raise
        acl = None
    return {'fd': int(number), 'path': target, 'flags': flags, 'mount': int(info['mnt_id']),
            'node': [*owner_mode(details), os.major(details.st_rdev), os.minor(details.st_rdev), acl]}


def holder_state(row, role, session, profile):
    proc = Path('/proc')/str(row['pid'])
    ticks = proc_ticks(proc)
    uid = next(line for line in (proc/'status').read_text().splitlines() if line.startswith('Uid:'))
    uids = [int(x) for x in uid.split()[1:]]
    cgroup = desktop_cgroup(role, session, profile)
    expected_uid = [1000, 0] if role == 'Xorg' else [1000, 1000]
    require(row['pid'] > 1 and row['startTicks'] == ticks and len(uids) == 4 and uids[:2] == expected_uid and
            (proc/'cgroup').read_text().strip() == '0::'+cgroup, 'DESKTOP_PROCESS_IDENTITY')
    if profile == PROFILE_NX and role != 'Xorg':
        # 僅將必要的兩個工作階段鍵拿來比對，其他環境值不回傳。
        with (proc/'environ').open('rb') as source:
            content = source.read(131073)
        pairs = [word for word in content.split(b'\0') if word.startswith((b'DISPLAY=', b'XDG_SESSION_ID='))]
        x11 = session['X11Binding']
        display = ('DISPLAY='+x11['display']).encode()
        ident = ('XDG_SESSION_ID='+session['Id']).encode()
        require(len(content) <= 131072 and sorted(pairs) in ([display], sorted([display, ident])) and
                namespace(proc,'net') == x11['netNamespace'] and namespace(proc,'mnt') == x11['mountNamespace'],
                'DESKTOP_PROCESS_SESSION')
    exe = executable(proc, role, profile)
    expected = ROLES[role]
    if profile == PROFILE_LAB:
        expected = [(path, 1, 3) for path, _, _ in expected]
    counts = Counter(row['deviceFds'].values())
    require(counts == Counter(path for path, _, _ in expected), 'DESKTOP_FD_SET_CHANGED')
    fds = [device_state(proc, number, target) for number, target in row['deviceFds'].items()]
    require(Counter((v['path'], *v['node'][5:7]) for v in fds) == Counter(expected) and
            proc_ticks(proc) == ticks and (proc/'cgroup').read_text().strip() == '0::'+cgroup,
            'DESKTOP_FD_SET_CHANGED')
    return {'role': role, 'pid': row['pid'], 'uids': uids, 'startTicks': ticks, 'cgroup': cgroup,
            'mountNamespace': (proc/'ns/mnt').stat().st_ino,
            'fds': sorted(fds, key=lambda v: v['fd']), 'executable': exe}

def desktop_snapshot(expected, rows, profile):
    session = session_state(expected,profile)
    xorg = holder_state(rows[0], 'Xorg', session, profile)
    if profile == PROFILE_NX:
        session['X11Binding'] = x11_binding(xorg,session['Display'])
    others = [holder_state(row,role,session,profile) for row,role in zip(rows[1:], ROLE_NAMES[1:])]
    return session, [xorg,*others]


def verify_session_unchanged(session, xorg, profile):
    actual = session_state(session,profile)
    if profile == PROFILE_NX:
        actual['X11Binding'] = x11_binding(xorg,actual['Display'])
    require(canonical(actual) == canonical(session), 'DESKTOP_SESSION_CHANGED')


def syscall(number, *args):
    result = ctypes.CDLL(None, use_errno=True).syscall(number, *args)
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result


class DesktopGuard:
    def __init__(self, window, profile):
        self.window = window
        self.profile = profile
        self.anchors = {}
        self.started = False
        self.failure = None
        self.failure_detail = None
        self.clock = None

    def permission(self, min_remaining=0):
        w = self.window
        require(isinstance(w, dict) and set(w) == {'schema', 'profile', 'boot', 'session', 'approval', 'holders'} and
                w['schema'] == 1 and w['profile'] == self.profile and w['boot'] == read_boot(),
                'DESKTOP_WINDOW_UNVERIFIED')
        a = w['approval']
        require(a['managerConsent'] is True and a['workWindowConfirmed'] is True and a['purpose'] == PURPOSE and
                isinstance(a['ref'], str) and 1 <= len(a['ref'].strip()) <= 160,
                'DESKTOP_WINDOW_PERMISSION_REQUIRED')
        now = time.time()
        steady = time.monotonic()
        if self.clock is None:
            self.clock = (now, steady)
        require(abs((now-self.clock[0])-(steady-self.clock[1])) <= 2, 'DESKTOP_WINDOW_CLOCK_DRIFT')
        require(type(a['notBefore']) is int and type(a['expires']) is int and
                a['notBefore'] <= now and now+min_remaining < a['expires'] <= a['notBefore']+MAX_WINDOW_SECONDS,
                'DESKTOP_WINDOW_EXPIRED_OR_UNVERIFIED')

    def verify_open_descriptions(self, states):
        compare = {'x86_64': 312, 'aarch64': 272}[platform.machine()]
        local_pid = os.getpid()
        for state in states:
            pid = state['pid']
            if not self.started:
                pfd = os.pidfd_open(pid)
                self.anchors[pid] = (pfd, {})
            pfd, fds = self.anchors[pid]
            poll = select.poll()
            poll.register(pfd, select.POLLIN)
            require(not poll.poll(0), 'DESKTOP_PID_EXITED')
            for entry in state['fds']:
                n = entry['fd']
                # 比對兩個本地固定引用，避免用仍可變動的遠端 FD 編號直接比較。
                live = syscall(PIDFD_GETFD, pfd, n, 0)
                try:
                    require(not os.get_inheritable(live), 'DESKTOP_FD_CLOEXEC')
                    s = os.fstat(live)
                    require(owner_mode(s) == entry['node'][:5] and
                            [os.major(s.st_rdev), os.minor(s.st_rdev)] == entry['node'][5:7] and
                            fcntl.fcntl(live, fcntl.F_GETFL) == entry['flags'] & ~os.O_CLOEXEC,
                            'DESKTOP_DEVICE_IDENTITY')
                    if not self.started:
                        fds[n] = live
                        live = None
                    else:
                        require(syscall(compare, local_pid, local_pid, KCMP_FILE, fds[n], live) == 0,
                                'DESKTOP_OPEN_DESCRIPTION_CHANGED')
                finally:
                    if live is not None:
                        os.close(live)
            require(not poll.poll(0) and proc_ticks(Path('/proc')/str(pid)) == state['startTicks'],
                    'DESKTOP_PID_EXITED')
        self.started = True

    def qualify(self, rows):
        if not self.failure:
            try:
                self.permission()
                w = self.window
                expected = w['holders']
                require(isinstance(expected, list) and [h['role'] for h in expected] == list(ROLE_NAMES),
                        'DESKTOP_ROLE_SET_UNVERIFIED')
                nodes = {h['pid']: h for h in expected}
                observed = {row['pid']: row for row in rows if row['gpuCameraFDs']}
                require(len(nodes) == 3 and set(observed) == set(nodes), 'DESKTOP_HOLDER_SET_CHANGED')
                session, actual = desktop_snapshot(w['session'],[observed[h['pid']] for h in expected],self.profile)
                require(canonical(session) == canonical(w['session']), 'DESKTOP_SESSION_CHANGED')
                require(canonical(actual) == canonical(expected), 'DESKTOP_IDENTITY_CHANGED')
                self.verify_open_descriptions(actual)
                verify_session_unchanged(session,actual[0],self.profile)
                self.permission()
                return {'status': 'MATCH', 'windowSha256': hashlib.sha256(canonical(w)).hexdigest(),
                        'roles': [{'role': h['role'], 'pid': h['pid'], 'fdCount': len(h['fds'])} for h in actual]}
            except RuntimeError as error:
                self.failure = str(error)
                self.failure_detail = safe_failure(error)
            except (OSError, KeyError, StopIteration, ValueError, TypeError, AttributeError,
                    subprocess.SubprocessError) as error:
                self.failure = 'DESKTOP_EVIDENCE_UNAVAILABLE'
                self.failure_detail = safe_failure(error)
            self.close()
        return {'status': 'HOLD', 'reason': self.failure, 'failure': self.failure_detail}

    def close(self):
        for pfd, fds in self.anchors.values():
            for fd in (*fds.values(), pfd):
                os.close(fd)
        self.anchors.clear()
