import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, renameSync, rmdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createWorkspaceFixture } from '../tools/fixtures/workspace-fixture.mjs';
import { assertPinned, pinPath } from '../tools/lock.mjs';

const cli = fileURLToPath(new URL('../tools/rc.mjs', import.meta.url));

function denied(environment, code, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding:'utf8', env:environment, windowsHide:true, timeout:30_000 });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(JSON.parse(result.stderr).code, code);
}

test('安全安裝拒絕可被其他帳號更名的上層目錄', async t => {
  const fixture = await createWorkspaceFixture('jcm-acm-acl-', ['config.json', 'tokens.json', 'install-manifest.json'].map(name => join('ancestor', 'stable-parent', 'install', name)));
  t.after(() => fixture.clean());
  const ancestor = join(fixture.root, 'ancestor');
  const parent = join(ancestor, 'stable-parent');
  mkdirSync(ancestor);
  await fixture.recordDirectory(ancestor);
  mkdirSync(parent);
  await fixture.recordDirectory(parent);
  if (process.platform === 'win32') {
    const program = join(process.env.SystemRoot, 'System32', 'icacls.exe');
    const acl = spawnSync(program, [ancestor, '/grant', '*S-1-1-0:(DE)'], { encoding:'utf8', windowsHide:true });
    assert.equal(acl.status, 0, acl.stderr);
  } else {
    const { chmodSync } = await import('node:fs');
    chmodSync(ancestor, 0o777);
  }
  const candidate = join(parent, 'install');
  const env = { ...process.env };
  delete env.ACM_INSTALL_WORKSPACE_FIXTURE;
  try {
    denied(env, /PRIVATE_ROOT_CREATE_FAILED|UNSAFE_PARENT_PERMISSIONS|WINDOWS_STORAGE_ACL_UNSAFE/, 'setup', candidate);
    assert.equal(existsSync(candidate), false);
  } finally {
    if (existsSync(candidate)) {
      await fixture.recordDirectory(candidate);
      await fixture.recordDirectory(join(candidate, 'data'));
    }
  }
});

test('Junction 或符號連結不通過安裝，已替換的祖先與原本檔案分開驗證', async t => {
  const fixture = await createWorkspaceFixture('jcm-acm-path-', []);
  t.after(() => fixture.clean());
  const parent = join(fixture.root, 'parent');
  const substitute = join(fixture.root, 'substitute');
  const alias = join(fixture.root, 'link');
  mkdirSync(parent);
  await fixture.recordDirectory(parent);
  symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await fixture.recordLink(alias);
  denied(process.env, /UNSAFE_PHYSICAL_PATH/, 'setup', join(alias, 'install'));
  assert.equal(existsSync(join(parent, 'install')), false);

  const original = pinPath(parent, 'directory');
  assertPinned(original);
  renameSync(parent, substitute);
  const moved = pinPath(substitute, 'directory');
  assert.equal(moved.id.ino, original.id.ino);
  try {
    mkdirSync(parent);
    const replacement = pinPath(parent, 'directory');
    try { assert.throws(() => assertPinned(original), /PATH_IDENTITY_CHANGED/); }
    finally {
      assertPinned(replacement);
      assert.equal(lstatSync(parent).isDirectory(), true);
      rmdirSync(parent);
    }
  } finally {
    assertPinned(moved);
    assert.equal(existsSync(parent), false);
    renameSync(substitute, parent);
  }
  assertPinned(original);
});

test('相同的目錄尾段無法冒用隔離安裝邊界',{skip:process.platform!=='win32'},async t=>{
  const fixture=await createWorkspaceFixture('jcm-acm-unrelated-',[]);
  t.after(()=>fixture.clean());
  let boundary=fixture.root;
  for (const name of ['tools','fixtures','work']){
    boundary=join(boundary,name);
    mkdirSync(boundary);
    await fixture.recordDirectory(boundary);
  }
  const install=join(boundary,'install');
  const env={...process.env,ACM_TEST_ROOT:boundary,ACM_INSTALL_WORKSPACE_FIXTURE:boundary};
  denied(env,/INVALID_INSTALLATION_FIXTURE_SCOPE/,'setup',install);
  assert.equal(existsSync(install),false);
});
