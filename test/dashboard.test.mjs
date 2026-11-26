import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';

test('Dashboard 瀏覽器驗收：分權、模擬工作、取消保留、歷史比較與唯讀快照', {
  skip: process.env.ACM_DASHBOARD_BROWSER !== '1',
}, async t => {
  const { createWorkspaceFixture } = await import('../tools/fixtures/workspace-fixture.mjs');
  const require = createRequire(import.meta.url);
  const { chromium } = require(require.resolve('playwright', { paths: [resolve(dirname(process.execPath), '../node_modules')] }));
  const profile = await createWorkspaceFixture('jcm-dashboard-', []);
  const browser = await chromium.launchPersistentContext(profile.root, {
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    locale: 'zh-TW',
    args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'],
  });
  t.after(async () => {
    await browser.close();
    try { await profile.clean(); }
    catch { t.diagnostic('保留瀏覽器設定檔供工作區身分核對：' + profile.root); }
  });
  const origin = 'http://127.0.0.1';
  const reader = 'r'.repeat(43), runner = 'w'.repeat(43);
  const now = Date.now();
  const model = { id: 'fixture:demo', digest: 'a'.repeat(64), context: 128, maxTokens: 16, device: 'cpu' };
  const nodes = ['first', 'second'].map(id => ({
    id, name: '測試節點 ' + id, platform: 'windows', status: 'SIMULATED', source: 'SIMULATION',
    freshness: 'FRESH', cpuCores: 4, gpuBytes: 0,
    metrics: { sampledAt: now, cpuPercent: 0, gpuPercent: null }, resident: [], models: [model],
  }));
  const assets = new Map([
    ['/', ['index.html', 'text/html']], ['/dashboard.js', ['dashboard.js', 'text/javascript']],
    ...['style.css', 'workbench.css', 'v06.css'].map(file => ['/' + file, [file, 'text/css']]),
  ]);
  const jobs = new Map();
  const errors = [];
  let readOnly = false;
  let observedAt = null, dashboardReads = 0;
  const archivedTasks = ['running', 'finished'].map((suffix, index) => ({
    id: 'archive-' + suffix, nodeId: 'archived-node', kind: 'generate', model: 'snapshot:model',
    state: index === 0 ? 'RUNNING' : 'SUCCEEDED', createdAt: now - 5000, startedAt: now - 4000,
    finishedAt: index === 0 ? null : now - 3000, errorCode: null,
  }));
  const snapshot = () => ({
    version: '1.0.0-rc.1', mode: readOnly ? 'read-only' : 'simulation', source: readOnly ? observedAt ? 'OBSERVED' : 'CONFIGURED_ONLY' : 'SIMULATION',
    nodes: readOnly ? nodes.map((node,index) => observedAt && index===0 ? {
      ...node, status:'ONLINE',source:'WINDOWS_LOCAL',metrics:{...node.metrics,sampledAt:observedAt},resident:[model.id],
    } : { ...node, status: 'LOCKED', source: 'CONFIGURED_ONLY', metrics: null, resident: null }) : nodes,
    jobs: [...jobs.values()].map(({ output, ...job }) => ({ ...job, canCancel: false })),
    locks: [...jobs.values()].filter(job => job.cleanup?.confirmed === false).map(job => ({
      resource: 'shared-cpu', state: 'HOLD', jobId: job.id, nodeId: 'first', reason: job.cleanup.reason,
    })),
    events: [], gates: { inference: readOnly ? 'BLOCKED' : 'SIMULATION', cleanup: 'HOLD' },
    archive: readOnly ? { source: 'V0.6_SNAPSHOT', capturedAt: now - 2000, requestsCount: 21, holdsCount: 7,
      tasks: archivedTasks, duals: [{ id: 'archive-dual', createdAt: now - 5000, parallel: 'observed', lanes: archivedTasks }] } : null,
  });
  await browser.route('**/*', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const token = req.headers().authorization;
    const reply = (json, status = 200) => route.fulfill({ status, json });
    try {
      assert.equal(url.origin, origin);
      assert.ok(!req.url().includes(reader) && !req.url().includes(runner));
      assert.ok(!req.postData()?.includes(reader) && !req.postData()?.includes(runner));
      const asset = assets.get(url.pathname);
      if (asset) {
        assert.equal(token, undefined);
        const [name, type] = asset;
        return await route.fulfill({
          contentType: type + '; charset=utf-8', body: await readFile(new URL('../public/' + name, import.meta.url)),
          headers: { 'content-security-policy': "default-src 'none'; form-action 'none'; script-src 'self'; style-src 'self'; connect-src 'self'" },
        });
      }
      if (url.pathname === '/favicon.ico') return await route.fulfill({ status: 404 });
      if (url.pathname.startsWith('/acm/v1/dashboard')) {
        assert.equal(token, 'Bearer ' + reader);
        if (url.pathname === '/acm/v1/dashboard') {
          dashboardReads++;
          return await reply(snapshot());
        }
        const nodeId = url.searchParams.get('nodeId');
        assert.ok(nodes.some(node => node.id === nodeId));
        return await reply({ samples: readOnly ? [] : [0, null, 12].map((cpuPercent, i) => ({
          nodeId, sampledAt: now + i * 1000, source: 'SIMULATION', cpuPercent,
        })) });
      }
      if (url.pathname === '/acm/v1/jobs') {
        assert.equal(token, 'Bearer ' + runner);
        assert.equal(req.method(), 'POST');
        assert.equal(readOnly, false);
        assert.deepEqual(req.postDataJSON(), { model: model.id, input: '測試文字', max_tokens: 16, priority: 0 });
        const id = 'job-' + (jobs.size + 1);
        const job = { id, model: model.id, state: 'RUNNING', nodeId: 'first', createdAt: now, canCancel: true };
        jobs.set(id, job);
        return await reply({ job }, 202);
      }
      const [, id, action] = /^\/acm\/v1\/jobs\/([^/]+)(\/cancel)?$/.exec(url.pathname);
      const job = jobs.get(id);
      assert.ok(job);
      if (action) {
        assert.equal(token, 'Bearer ' + runner);
        assert.equal(req.method(), 'POST');
        assert.equal(req.postData(), null);
        Object.assign(job, { state: 'INTERRUPTED', canCancel: false, cleanup: { confirmed: false, reason: 'CLEANUP_UNCONFIRMED' } });
      } else if (id === 'job-1') {
        Object.assign(job, { state: 'SUCCEEDED', canCancel: false, output: '離線模擬回答', cleanup: { confirmed: true },
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
      }
      if (token === 'Bearer ' + runner) return await reply({ job });
      assert.equal(token, 'Bearer ' + reader);
      const { output, ...publicJob } = job;
      return await reply({ job: { ...publicJob, canCancel: false } });
    } catch (error) {
      errors.push(error.message);
      await route.abort();
    }
  });
  const page = browser.pages()[0];
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  const find = id => page.locator('#' + id);
  const includes = (id, text) => page.waitForFunction(([key, expected]) =>
    document.getElementById(key)?.textContent.includes(expected), [id, text]);
  const connect = async run => {
    await find('read-token').fill(reader);
    if (run) await find('run-token').fill(runner);
    await page.locator('#access button[type="submit"]').click();
    await includes('access-status', '已讀取工作區');
  };
  await page.goto(origin + '/');
  assert.ok(await find('run-submit').isDisabled());
  await find('enroll-id').fill('fixture-device');
  await find('enroll-publisher').fill('fixture-publisher');
  await find('enroll-key').fill('a'.repeat(59));
  await page.locator('#enrollment button[type="submit"]').click();
  const pin = JSON.parse(await find('enroll-output').inputValue());
  assert.equal(pin.nodeId, 'fixture-device');
  assert.equal(pin.tokenId, 'fixture-publisher');
  assert.equal(pin.kind, 'JETSON_AGENT');
  assert.equal(await find('run-token').inputValue(), '');
  await connect(true);
  assert.equal(await find('run-token').inputValue(), '');
  await includes('archive-status', '尚未導入');
  await includes('nodes', '0 %');
  await includes('nodes', 'GPU 使用率UNKNOWN');
  await find('history-compare').selectOption('second');
  await includes('history-status', '測試節點 second · 3 筆採樣 · 離線模擬');
  assert.equal(await page.locator('.chart-line').count(), 2);
  assert.match(await page.locator('.chart-line').first().getAttribute('d'), /^M[^L]+M[^L]+$/);

  await find('run-input').fill('測試文字');
  await find('run-submit').click();
  await includes('task-answer', '離線模擬回答');
  await includes('task-facts', '共 5');
  await find('run-input').fill('測試文字');
  await find('run-submit').click();
  await find('task-cancel').click();
  await includes('task-cleanup', 'CLEANUP_UNCONFIRMED');
  await includes('locks', 'CLEANUP_UNCONFIRMED');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await find('clear-credentials').click();
  assert.equal(await find('task-answer').textContent(), '');
  await connect(false);
  await page.locator('#task-list button[data-job-id="job-1"]').click();
  await includes('task-answer', '僅提供給工作建立者');
  assert.ok(await find('run-submit').isDisabled());
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);

  readOnly = true;
  await page.reload();
  await includes('mode', '尚未連線');
  await connect(true);
  await includes('mode', '唯讀管理');
  await includes('history-status', '目前未導入可讀取的採樣');
  await includes('archive-facts', 'V0.6_SNAPSHOT');
  await page.getByText('雙模型對話歷史', { exact: true }).click();
  await includes('archive-duals', '觀測到重疊');
  await includes('archive-duals', '擷取時狀態執行中 · RUNNING');
  assert.equal(await page.locator('#archive-records button').count(), 0);
  assert.equal(await page.locator('#locks li').count(), 1);
  assert.ok(await find('run-submit').isDisabled());
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.clock.install({time:new Date()});
  observedAt=await page.evaluate(()=>Date.now());
  await find('dashboard-refresh').click();
  await includes('nodes','Windows 本機採樣');
  await includes('nodes','0 %');
  await includes('model-inventory','駐留模型 · '+model.id);
  const reads=dashboardReads;
  await page.clock.fastForward(15100);
  await includes('nodes','採樣過期 · STALE');
  await includes('model-inventory','駐留模型 · UNKNOWN');
  await includes('gate-facts','僅配置資料');
  assert.equal(await page.locator('#nodes').getByText('0 %',{exact:true}).count(),0);
  assert.equal(dashboardReads,reads);
  assert.deepEqual(errors, []);
});
