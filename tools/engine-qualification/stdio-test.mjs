import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
assert.equal(process.versions.node, '24.22.3');
assert.match(readFileSync('/sys/class/dmi/id/product_name', 'utf8'), /QEMU/);

const probe = fileURLToPath(new URL('./stdio-test.py', import.meta.url));
const tick = readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ')[19];
const pins = [process.pid, tick, process.getuid(), process.getgid()].map(String);

function run(args, stdio = ['pipe', 'ignore', 'pipe']) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-B', probe, ...args], {
      stdio, signal: AbortSignal.timeout(12000), env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    let error = '';
    child.stdin.on('error', () => {});
    child.stdout?.resume();
    child.stderr.on('data', data => { error += data; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      try {
        assert.equal(signal, null);
        assert.equal(code, 0);
        resolve(JSON.parse(error));
      } catch (failure) { reject(failure); }
    });
    child.stdin.end();
  });
}

const shape = ['ANONYMOUS_UNIX_STREAM', 'DEV_NULL', 'ANONYMOUS_UNIX_STREAM'];
const cases = [
  ['NODE_STDIO_SOCKETPAIR', ['probe','normal', ...pins], undefined, shape],
  ['ADDITIONAL_DESCRIPTOR', ['probe','normal', ...pins], ['pipe','ignore','pipe','pipe'], 'STDIO_FD_SET'],
  ['INCORRECT_NULL_OBJECT', ['probe','normal', ...pins], ['pipe','pipe','pipe'], 'STDIO_NULL'],
  ['STALE_PARENT_TICK', ['probe','normal', pins[0], String(BigInt(tick) + 1n), ...pins.slice(2)], undefined, 'STDIO_PARENT_IDENTITY'],
  ['KERNEL_PEER_UNAVAILABLE', ['probe','missing-peer', ...pins], undefined, 'STDIO_PEER_UNVERIFIED'],
  ['NAMED_SOCKET', ['fixture','named'], undefined, 'STDIO_SOCKET_KIND'],
  ['WRONG_SOCKET_CREATOR', ['fixture','wrong-peer'], undefined, 'STDIO_PEER_IDENTITY'],
];

for (const [name, args, stdio, expected] of cases) {
  const actual = await run(args, stdio);
  const passed = Array.isArray(expected)
    ? actual.verdict === 'PASS' && JSON.stringify(Object.values(actual.fds)) === JSON.stringify(expected)
    : actual.verdict === 'HOLD' && actual.code === expected;
  console.log('ACM_R3_STDIO_CASE=' + JSON.stringify({ name, passed, actual }));
  assert.ok(passed, name);
}
console.log('ACM_R3_STDIO=' + JSON.stringify({ verdict:'PASS', cases:cases.length, runtime:process.versions.node, arch:process.arch,
  engineStarted:false, generationRequests:0 }));
