import { spawnSync } from 'node:child_process';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const stat = path => lstatSync(path, { bigint: true });
export const sameIdentity = (a, b) => a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
export const fileIdentity = value => String(value.dev) + ':' + String(value.ino);
export const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export function absoluteLocalPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || !isAbsolute(value) ||
      /[\u0000-\u001f]/u.test(value)) throw new Error('ABSOLUTE_LOCAL_PATH_REQUIRED');
  if (windows && !/^[a-z]:[\\/]/iu.test(value)) throw new Error('ABSOLUTE_LOCAL_PATH_REQUIRED');
  const parts = value.slice(parse(value).root.length).split(windows ? /[\\/]/u : '/');
  if (parts.some(part => part === '.' || part === '..' || (windows && (
    /[<>:"|?*]|[ .]$/u.test(part) || /^(?:con|conin\$|conout\$|prn|aux|nul|com[\d¹²³]|lpt[\d¹²³])(?:\.|$)/iu.test(part)
  )))) throw new Error('UNSAFE_PATH_COMPONENT');
  return resolve(value);
}

export function pinPath(input, kind) {
  const path = absoluteLocalPath(input);
  const drive = parse(path).root;
  const chain = [];
  let current = drive;
  for (const part of ['', ...relative(drive, path).split(sep).filter(Boolean)]) {
    current = join(current, part);
    const id = stat(current);
    const regular = current === path && kind === 'file';
    const physical = realpathSync.native(current);
    if (id.isSymbolicLink() || id.ino === 0n ||
        (regular ? !id.isFile() || id.nlink !== 1n : !id.isDirectory()) ||
        (windows ? physical.toLowerCase() !== current.toLowerCase() : physical !== current)) {
      throw new Error('UNSAFE_PHYSICAL_PATH');
    }
    chain.push({ path: current, id });
  }
  return { path, kind, chain, id: chain.at(-1).id };
}

export function assertPinned(pin) {
  const current = pinPath(pin.path, pin.kind);
  if (!pin.chain.every((entry, index) => sameIdentity(entry.id, current.chain[index].id))) {
    throw new Error('PATH_IDENTITY_CHANGED');
  }
  return current.id;
}

export function containedIn(root, path) {
  const remainder = relative(root, path);
  return remainder === '' || (remainder !== '..' && !remainder.startsWith('..' + sep) && !isAbsolute(remainder));
}

function fixtureBoundary(path) {
  const requested = process.env.ACM_INSTALL_WORKSPACE_FIXTURE;
  if (!windows || !requested) return null;
  const boundary = absoluteLocalPath(requested);
  const product = pinPath(fileURLToPath(new URL('..', import.meta.url)), 'directory').path;
  const anchors = [product];
  if (basename(dirname(product)).toLowerCase() === 'candidates') anchors.push(dirname(dirname(product)));
  const key = value => value.toLowerCase();
  if (!process.env.ACM_TEST_ROOT || key(absoluteLocalPath(process.env.ACM_TEST_ROOT)) !== key(boundary) ||
      !anchors.some(root => key(join(root, 'tools', 'fixtures', 'work')) === key(boundary)))
    throw new Error('INVALID_INSTALLATION_FIXTURE_SCOPE');
  if (path === boundary || !containedIn(boundary, path)) return null;
  return pinPath(boundary, 'directory');
}

export function installationStorageScope(path) {
  return fixtureBoundary(absoluteLocalPath(path)) ? 'WORKSPACE_FIXTURE' : 'PRIVATE_ANCESTORS';
}

function windowsSecurity(operation, paths, fixture) {
  const input = Buffer.from(JSON.stringify({ operation, paths, fixture: !!fixture }), 'utf8').toString('base64');
  const script = windowsSecurityScript.replace('__ACM_INPUT__', input);
  const command = Buffer.from(script, 'utf16le').toString('base64');
  if (command.length > 28_000) {
    if (operation !== 'check' || paths.length <= 2) throw new Error('WINDOWS_STORAGE_PATH_TOO_LONG');
    const split = Math.ceil(paths.length / 2);
    windowsSecurity('check', paths.slice(0, split), fixture);
    windowsSecurity('check', [paths[0], ...paths.slice(split)], fixture);
    return;
  }
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
    windowsHide: true, encoding: 'utf8', timeout: 15_000,
  });
  if (result.status !== 0 || result.stdout?.trim() !== 'ACM_OK') {
    throw new Error(operation === 'create' ? 'PRIVATE_ROOT_CREATE_FAILED' : 'WINDOWS_STORAGE_ACL_UNSAFE');
  }
}

const windowsSecurityScript = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__ACM_INPUT__')) | ConvertFrom-Json
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
$trustedOwners = @($trusted) + 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$paths = @($request.paths)
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($paths[0]))
if ($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -ne 'NTFS') { throw 'Unsupported storage' }
$checked = @{}

function Read-Acl([string] $target, [Security.AccessControl.AccessControlSections] $sections) {
  if ([IO.Directory]::Exists($target)) { return [IO.Directory]::GetAccessControl($target, $sections) }
  return [IO.File]::GetAccessControl($target, $sections)
}

function Confirm-Physical([string] $target) {
  $item = $target
  while ($item -and !$checked.ContainsKey($item)) {
    if (([IO.File]::GetAttributes($item) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
    $owner = (Read-Acl $item ([Security.AccessControl.AccessControlSections]::Owner)).GetOwner([Security.Principal.SecurityIdentifier])
    if ($trustedOwners -notcontains $owner.Value) { throw 'Untrusted path owner' }
    $checked[$item] = $true
    $item = [IO.Path]::GetDirectoryName($item)
  }
}

function Confirm-Access([string] $target, [int] $policy) {
  Confirm-Physical $target
  $sections = [Security.AccessControl.AccessControlSections]'Access, Owner'
  $acl = Read-Acl $target $sections
  $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $raw.DiscretionaryAcl) { throw 'No DACL' }
  if ($policy -eq 0 -and ($trusted -notcontains $raw.Owner.Value)) { throw 'Untrusted owner' }
  foreach ($ace in $raw.DiscretionaryAcl) {
    if (([int]$ace.AceFlags -band 8) -or
        [int]$ace.AceQualifier -eq 1 -or
        $trusted -contains $ace.SecurityIdentifier.Value) { continue }
    # 允許新物件的建立權不會授予刪除既有路徑或修改安全描述元的權限。
    $mask = if ($policy -eq 1) { 0x100C0040 } else { 0x500D0150 }
    if ($policy -eq 0 -or ($ace.AccessMask -band $mask) -ne 0) { throw 'Untrusted access' }
  }
}

function Confirm-Ancestors([string] $parent) {
  if ($request.fixture) {
    Confirm-Access $parent 1
    return
  }
  for ($item = $parent; $item; $item = [IO.Path]::GetDirectoryName($item)) {
    Confirm-Access $item 2
  }
}

if ($request.operation -eq 'create') {
  $target = $paths[0]
  Confirm-Ancestors ([IO.Path]::GetDirectoryName($target))
  $security = [Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($user)
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sid in $trusted) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      [Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $security.AddAccessRule($rule)
  }
  # 使用排他建立原語避免先 mkdir 再 Set-Acl 時套到同名替換物件。
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
    [Reflection.AssemblyName]::new('AcmLocalDirectory'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $type = $assembly.DefineDynamicModule('Local').DefineType('AcmNative', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
  $method = $type.DefinePInvokeMethod('CreateDirectoryW', 'kernel32.dll',
    [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard,
    [int], [type[]]@([string], [IntPtr]), [Runtime.InteropServices.CallingConvention]::Winapi,
    [Runtime.InteropServices.CharSet]::Unicode)
  $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  $native = $type.CreateType()
  $descriptor = $security.GetSecurityDescriptorBinaryForm()
  $pinned = [Runtime.InteropServices.GCHandle]::Alloc($descriptor, [Runtime.InteropServices.GCHandleType]::Pinned)
  $pointerSize = [IntPtr]::Size
  $attributes = [Runtime.InteropServices.Marshal]::AllocHGlobal(3 * $pointerSize)
  try {
    [Runtime.InteropServices.Marshal]::WriteInt32($attributes, 0, 3 * $pointerSize)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($attributes, $pointerSize, $pinned.AddrOfPinnedObject())
    [Runtime.InteropServices.Marshal]::WriteInt32($attributes, 2 * $pointerSize, 0)
    if ($native::CreateDirectoryW($target, $attributes) -eq 0) { throw 'Directory creation failed' }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($attributes)
    $pinned.Free()
  }
} else {
  Confirm-Ancestors ([IO.Path]::GetDirectoryName($paths[0]))
  foreach ($target in $paths) {
    for ($item = $target; $item; $item = [IO.Path]::GetDirectoryName($item)) {
      Confirm-Access $item 0
      if ([String]::Equals($item, $paths[0], [StringComparison]::OrdinalIgnoreCase)) { break }
    }
  }
}
'ACM_OK'
`;

function assertPosixParent(parent) {
  const user = BigInt(process.getuid());
  if (parent.chain.some(({ id }) => (id.mode & 0o022n) !== 0n || (id.uid !== 0n && id.uid !== user))) {
    throw new Error('UNSAFE_PARENT_PERMISSIONS');
  }
}

export function assertPrivateInstallation(input, children = []) {
  const root = pinPath(input, 'directory');
  if (dirname(root.path) === root.path) throw new Error('DRIVE_ROOT_FORBIDDEN');
  const entries = children.map(input => {
    const path = absoluteLocalPath(input);
    if (!containedIn(root.path, path) || path === root.path) throw new Error('INSTALLATION_PATH_OUTSIDE_ROOT');
    return pinPath(path, stat(path).isDirectory() ? 'directory' : 'file');
  });
  if (windows) {
    const fixture = fixtureBoundary(root.path);
    windowsSecurity('check', [root.path, ...entries.map(entry => entry.path)], fixture);
    if (fixture) assertPinned(fixture);
  } else {
    assertPosixParent(pinPath(dirname(root.path), 'directory'));
  }
  for (const entry of [root, ...entries]) {
    assertPinned(entry);
    if (!windows && entry.chain.slice(root.chain.length - 1).some(({ id }) =>
      id.uid !== BigInt(process.getuid()) || (id.mode & 0o077n) !== 0n)) {
      throw new Error('PRIVATE_PERMISSIONS_REQUIRED');
    }
  }
  return root.path;
}

export function createPrivateRoot(input) {
  const path = absoluteLocalPath(input);
  if (dirname(path) === path) throw new Error('DRIVE_ROOT_FORBIDDEN');
  const parent = pinPath(dirname(path), 'directory');
  if (windows) {
    const fixture = fixtureBoundary(path);
    windowsSecurity('create', [path], fixture);
    if (fixture) assertPinned(fixture);
  } else {
    assertPosixParent(parent);
    mkdirSync(path, { mode: 0o700 });
  }
  assertPinned(parent);
  return assertPrivateInstallation(path);
}

export const lockFileName = 'maintenance.lock';
export const recoveryLockName = 'maintenance.recovery-lock';

function optionalPin(path, kind) {
  try { return pinPath(path, kind); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function refuseRecoveryInProgress(root) {
  try {
    stat(join(root, recoveryLockName));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('INSTALLATION_LOCKED');
}

function acquireLock(configPath, filename) {
  const config = pinPath(configPath, 'file');
  const root = pinPath(dirname(config.path), 'directory');
  const recovery = filename === recoveryLockName;
  if (!recovery) refuseRecoveryInProgress(root.path);
  const data = optionalPin(join(root.path, 'data'), 'directory');
  const manifest = optionalPin(join(root.path, 'install-manifest.json'), 'file');
  const lock = join(root.path, filename);
  let fd;
  try {
    fd = openSync(lock, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('INSTALLATION_LOCKED');
    throw error;
  }
  const id = fstatSync(fd, { bigint: true });
  let active = true;
  const release = () => {
    if (!active) return;
    active = false;
    try {
      assertPinned(root);
      if (!sameIdentity(id, pinPath(lock, 'file').id)) throw new Error('INSTALLATION_LOCK_IDENTITY_CHANGED');
      unlinkSync(lock);
    } finally {
      closeSync(fd);
    }
  };
  try {
    assertPinned(config);
    if (data) assertPinned(data);
    if (manifest) assertPinned(manifest);
    if (!recovery) refuseRecoveryInProgress(root.path);
    if (!sameIdentity(id, pinPath(lock, 'file').id)) throw new Error('INSTALLATION_LOCK_IDENTITY_CHANGED');
    writeFileSync(fd, JSON.stringify({
      version: 1, kind: recovery ? 'RECOVERY' : 'INSTALLATION', pid: process.pid,
      rootIdentity: fileIdentity(root.id), configIdentity: fileIdentity(config.id),
      dataIdentity: data ? fileIdentity(data.id) : null,
      manifestIdentity: manifest ? fileIdentity(manifest.id) : null,
      lockIdentity: fileIdentity(id),
    }));
    fsyncSync(fd);
  } catch (error) {
    release();
    throw error;
  }
  return release;
}

export const acquireInstallationLock = configPath => acquireLock(configPath, lockFileName);
export const acquireRecoveryLock = configPath => acquireLock(configPath, recoveryLockName);
