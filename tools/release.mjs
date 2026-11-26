import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHA256 } from './config.mjs';
import { digest, jsonBytes, readBytes, snapshotFile, writeFresh } from './files.mjs';
import { absoluteLocalPath, assertPinned, containedIn, pinPath } from './lock.mjs';

const product = fileURLToPath(new URL('..', import.meta.url));
const folders = new Set(['.github', 'docs', 'public', 'src', 'test', 'tools', 'agent']);
const files = new Set(['.gitattributes', '.gitignore', 'LICENSE', 'NOTICE', 'README.md', 'README.en.md',
  'KNOWN_LIMITATIONS.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'package.json', 'package-lock.json', 'server.mjs', 'start.cmd', 'start.sh']);
const localOnly = new Set(['.git', 'node_modules', 'MASTER_PROGRESS.md', 'RESUME.md', 'RELEASE_GATE.json', 'source-manifest.json']);
const required = ['package.json', 'server.mjs', 'start.cmd', 'start.sh', 'tools/rc.mjs','agent/cli.mjs','docs/sbom.cdx.json'];
const previewFiles = new Set(['docs/screenshots/dashboard-preview.png','docs/screenshots/simulation-job.png']);
const work = 'tools/fixtures/work';
const regularName = /^[A-Za-z0-9_.-]+$/u;
const publicSuffix = /\.(?:mjs|js|json|html|css|md|txt|svg|sh|cmd|ps1|ya?ml|py)$/u;
const maxBytes = 64 * 1024 ** 2;

const secretPatterns = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u,
  /\bBearer [A-Za-z0-9_-]{43}\b/u,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{25,})\b/u,
  /\b(?:password|api[_-]?key|access[_-]?token|secret)["']?\s*[:=]\s*["'][A-Za-z0-9_./+=-]{16,}["']/iu,
  /["'][A-Za-z0-9_-]{43}["']/u,
  /\bssh-(?:ed25519|rsa) AAA[A-Za-z0-9+/=]{24,}/u,
  /[A-Za-z]:[\\/]+(?:Users|Codex|Documents-Snapshot)[\\/]/iu,
  /\b(?:192\.168\.\d{1,3}|10\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3})\.\d{1,3}\b/u,
];

function members() {
  const paths = [];
  function walk(relative = '') {
    const path = relative ? join(product, relative) : product;
    const names = readdirSync(pinPath(path, 'directory').path, { withFileTypes: true });
    for (const entry of names) {
      const name = entry.name;
      if (!relative && localOnly.has(name)) continue;
      if (!relative && !folders.has(name) && !files.has(name)) throw new Error('UNEXPECTED_SOURCE_ENTRY');
      if (relative === work && name !== '.gitkeep') continue;
      if (!regularName.test(name) || /^(?:tokens\.json|config\.json|.*\.sqlite(?:-.*)?|\.env(?:\..*)?)$/iu.test(name)) {
        throw new Error('PRIVATE_OR_UNSUPPORTED_SOURCE_ENTRY');
      }
      const member = relative ? relative + '/' + name : name;
      if (entry.isDirectory() && (relative || folders.has(name))) {
        walk(member);
      } else if (entry.isFile() && (files.has(member) || publicSuffix.test(name) || previewFiles.has(member) || member === work + '/.gitkeep')) {
        paths.push(member);
      } else {
        throw new Error('PRIVATE_OR_UNSUPPORTED_SOURCE_ENTRY');
      }
    }
  }
  walk();
  paths.sort();
  if (!required.every(path => paths.includes(path))) throw new Error('RELEASE_INPUT_INCOMPLETE');
  if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length) throw new Error('RELEASE_PATH_COLLISION');
  return paths;
}

function verifyPreview(contents) {
  if (contents.length>2*1024*1024 || contents.length<45 || contents.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')
    throw Error('UNAPPROVED_PREVIEW_IMAGE');
  const allowed=new Set(['IHDR','IDAT','IEND','sRGB','gAMA','cHRM','pHYs','sBIT','PLTE','tRNS']);
  let hasImage=false,offset=8;
  while (offset+12<=contents.length){
    const size=contents.readUInt32BE(offset),name=contents.toString('ascii',offset+4,offset+8);
    const next=offset+12+size;
    if (next>contents.length||!allowed.has(name)) break;
    if (offset===8&&(name!=='IHDR'||size!==13||contents.readUInt32BE(offset+8)!==1440||
        contents.readUInt32BE(offset+12)!==1050)) break;
    if (name==='IDAT') hasImage=true;
    if (name==='IEND'&&size===0&&hasImage&&next===contents.length) return;
    offset=next;
  }
  throw Error('UNAPPROVED_PREVIEW_IMAGE');
}

function collect() {
  const paths = members();
  let total = 0;
  const records = paths.map(path => {
    const { pin, contents } = readBytes(join(product, path), maxBytes - total);
    total += contents.length;
    if (previewFiles.has(path)){
      verifyPreview(contents);
      return {path,pin,contents,mode:0o644};
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(contents); }
    catch { throw new Error('NON_TEXT_RELEASE_SOURCE'); }
    if (text.includes('\u0000') || secretPatterns.some(pattern => pattern.test(text))) throw new Error('SECRET_SCAN_REFUSED');
    return { path, pin, contents, mode: path === 'start.sh' ? 0o755 : 0o644 };
  });
  if (JSON.stringify(members()) !== JSON.stringify(paths)) throw new Error('RELEASE_INPUT_CHANGED');
  for (const { pin } of records) {
    const current = assertPinned(pin);
    if (current.size !== pin.id.size || current.mtimeNs !== pin.id.mtimeNs || current.ctimeNs !== pin.id.ctimeNs) {
      throw new Error('RELEASE_INPUT_CHANGED');
    }
  }
  return records;
}

function octal(header, start, width, value) {
  const encoded = value.toString(8);
  if (encoded.length >= width) throw new Error('TAR_FIELD_OVERFLOW');
  header.write(encoded.padStart(width - 1, '0'), start, width - 1, 'ascii');
}

function tarEntry({ path, contents, mode }) {
  const block = Buffer.alloc(512);
  const slash = path.lastIndexOf('/');
  const prefix = path.length <= 100 ? '' : path.slice(0, slash);
  const name = prefix ? path.slice(slash + 1) : path;
  if (name.length > 100 || prefix.length > 155) throw new Error('TAR_PATH_LIMIT');
  block.write(name, 0, 100, 'ascii');
  octal(block, 100, 8, mode);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, contents.length);
  octal(block, 136, 12, 0);
  block.fill(32, 148, 156);
  block.write('0', 156, 1, 'ascii');
  block.write('ustar', 257, 5, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write(prefix, 345, 155, 'ascii');
  octal(block, 148, 7, block.reduce((sum, byte) => sum + byte, 0));
  return [block, contents, Buffer.alloc((512 - contents.length % 512) % 512)];
}

function tarball(records) {
  const manifest = jsonBytes({
    version: 1, kind: 'ACM_INSTALL_SOURCE',
    files: records.map(({ path, contents, mode }) => ({ path, bytes: contents.length, mode, sha256: digest(contents) })),
  });
  const entries = [...records, { path: 'source-manifest.json', contents: manifest, mode: 0o644 }];
  return Buffer.concat([...entries.flatMap(tarEntry), Buffer.alloc(1024)]);
}

function main([command, input, expected, ...extra]) {
  if (extra.length > 0 || !['scan', 'build', 'verify'].includes(command) ||
      (command === 'scan' ? input !== undefined : input === undefined) ||
      (expected !== undefined && (command !== 'verify' || !SHA256.test(expected)))) throw new Error('USAGE');
  const records = collect();
  if (command === 'scan') return { status: 'SOURCE_SCAN_PASS', files: records.length };
  const artifact = absoluteLocalPath(input);
  if (command === 'build' && containedIn(product, artifact) && !containedIn(join(product, work), artifact)) {
    throw new Error('RELEASE_ARTIFACT_OUTSIDE_SOURCE_REQUIRED');
  }
  const contents = tarball(records);
  const sha256 = digest(contents);
  if (command === 'build') {
    writeFresh(artifact, fd => writeFileSync(fd, contents));
  } else {
    const candidate = snapshotFile(artifact, contents.length);
    if (candidate.bytes !== contents.length || candidate.sha256 !== sha256 || (expected !== undefined && expected !== sha256)) {
      throw new Error('RELEASE_ARTIFACT_MISMATCH');
    }
  }
  return { status: command === 'build' ? 'INSTALL_TAR_BUILT' : 'INSTALL_TAR_VERIFIED',
    sha256, files: records.length, bytes: contents.length };
}

try {
  console.log(JSON.stringify(main(process.argv.slice(2))));
} catch (error) {
  // 拒絕回顯命中字串、檔案內容或可能含憑證的檔名。
  const safe = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/u.test(value);
  const code = safe(error.message) ? error.message : safe(error.code) ? error.code : 'RELEASE_CHECK_FAILED';
  console.error(JSON.stringify(code === 'USAGE' ? {
    status: 'REFUSED', code,
    usage: ['scan', 'build <absolute-new-tar>', 'verify <absolute-tar> [expected-sha256]'],
  } : { status: 'REFUSED', code }));
  process.exitCode = 1;
}
