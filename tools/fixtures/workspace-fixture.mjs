import assert from 'node:assert/strict';
import { lstat, mkdtemp, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const parent = process.env.ACM_TEST_ROOT ?? fileURLToPath(new URL('./work', import.meta.url));
assert.ok(resolve(parent)===parent && basename(parent)==='work' &&
  basename(dirname(parent))==='fixtures' && basename(dirname(dirname(parent)))==='tools');
const stat = path => lstat(path, { bigint: true });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;

export async function createWorkspaceFixture(prefix, allowedFiles) {
  assert.match(prefix, /^jcm-[a-z-]+-$/);
  assert.equal(await realpath(parent), parent);
  const parentId = await stat(parent);
  const root = await mkdtemp(join(parent, prefix));
  const directories = new Map([[root, await stat(root)]]);
  const files = new Set(allowedFiles);
  const createdFiles = new Map();
  const links = new Map();
  function member(name) {
    const p = resolve(root, name);
    assert.ok(relative(root, p) === name && !name.split(/[\\/]/).includes('..') && dirname(root) === parent);
    return p;
  }
  async function verifyDirs() {
    assert.equal(await realpath(parent), parent);
    assert.ok(same(parentId, await stat(parent)));
    for (const [path, id] of directories) {
      assert.equal(await realpath(path), path);
      const now = await stat(path);
      assert.ok(now.isDirectory() && same(id, now), '測試目錄物件身分已改變');
    }
  }
  return {
    root,
    async createFile(name, contents = '') {
      // 保留檔名、資料流及帶尾點的名稱在 Windows 可能另指其他物件。
      assert.ok(name.split(/[\\/]/).every(part =>
        /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(part) &&
        !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)), '不允許的測試檔名');
      const path = member(name);
      assert.ok(directories.has(dirname(path)));
      await verifyDirs();
      const file = await open(path, 'wx');
      try {
        // 從排他建立時的把手記錄身分，清理時不能採認新的同名檔。
        createdFiles.set(path, await file.stat({bigint: true}));
        await file.writeFile(contents);
      } finally { await file.close(); }
      return path;
    },
    async recordDirectory(path) {
      assert.equal(member(relative(root, path)), path);
      assert.ok(directories.has(dirname(path)));
      const id = await stat(path);
      assert.ok(id.isDirectory() && !id.isSymbolicLink());
      directories.set(path, id);
    },
    async recordLink(path) {
      assert.ok(directories.has(dirname(path)) && (await stat(path)).isSymbolicLink());
      links.set(path, await stat(path));
    },
    async clean() {
      await verifyDirs();
      // 先核對整棵已知目錄；留下任何新增或替換的物件供核對。
      const removals = [];
      for (const dir of directories.keys()) {
        for (const name of await readdir(dir)) {
          const path = join(dir, name);
          if (directories.has(path)) continue;
          const id = await stat(path);
          if (createdFiles.has(path)) assert.ok(id.isFile() && id.nlink === 1n && same(createdFiles.get(path), id), '檔案物件身分已改變');
          else if (links.has(path)) assert.ok(id.isSymbolicLink() && same(links.get(path), id));
          else assert.ok(files.has(relative(root, path)) && id.isFile(), '未知測試物件 ' + basename(path));
          removals.push([path, id]);
        }
      }
      for (const [path, id] of removals) {
        await verifyDirs();
        assert.ok(same(id, await stat(path)));
        await unlink(path);
      }
      for (const path of [...directories.keys()].reverse()) {
        await verifyDirs();
        await rmdir(path);
        directories.delete(path);
      }
    },
  };
}
