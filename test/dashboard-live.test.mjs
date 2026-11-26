import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {startService} from '../server.mjs';
import {createWorkspaceFixture} from '../tools/fixtures/workspace-fixture.mjs';

test('Chrome 真正連到隔離服務，試用、工作權限與手機版操作',{skip:process.env.ACM_DASHBOARD_BROWSER!=='1'},async t=>{
  const project=fileURLToPath(new URL('../',import.meta.url));
  const require=createRequire(import.meta.url);
  const {chromium}=require(require.resolve('playwright',{paths:[resolve(dirname(process.execPath),'../node_modules')]}));
  const known=['config.json','tokens.json','install-manifest.json','storage-seal.json','maintenance.lock',
    ...['controller.sqlite','telemetry.sqlite'].flatMap(db=>['','-wal','-shm','-journal'].map(suffix=>'data/'+db+suffix))];
  const dir=await createWorkspaceFixture('jcm-live-dashboard-',known.map(name=>join('preview',name)));
  const profile=await createWorkspaceFixture('jcm-live-chrome-',[]);
  const install=join(dir.root,'preview'),config=join(install,'config.json');
  let app,browser;
  t.after(async()=>{
    await browser?.close();
    await app?.close();
    await dir.clean();
    try{await profile.clean();}catch{t.diagnostic('保留 Chrome 隔離設定檔以便目錄身分核對');}
  });
  const command=(...args)=>{
    const result=spawnSync(process.execPath,[join(project,'tools','rc.mjs'),...args],{
      cwd:project,encoding:'utf8',windowsHide:true,timeout:45000
    });
    assert.equal(result.status,0,result.stderr.trim());
    return JSON.parse(result.stdout);
  };
  command('setup',install,'--simulation');
  await dir.recordDirectory(install);
  await dir.recordDirectory(join(install,'data'));
  writeFileSync(config,JSON.stringify({...JSON.parse(readFileSync(config)),port:0}));
  const reader=command('token','issue',install,'preview-reader','manage:read').token;
  const runner=command('token','issue',install,'preview-runner','models:run').token;
  app=await startService(config,{audit:()=>{}});
  const origin='http://127.0.0.1:'+app.info.port;
  browser=await chromium.launchPersistentContext(profile.root,{channel:'chrome',headless:true,
    viewport:{width:1440,height:1050},locale:'zh-TW',args:['--disable-background-networking','--disable-component-update','--no-first-run']});
  await browser.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=browser.pages()[0];
  const errors=[];
  page.on('pageerror',cause=>errors.push(cause.message));
  const find=id=>page.locator('#'+id);
  const includes=(id,text)=>page.waitForFunction(([key,expected])=>
    document.getElementById(key)?.textContent.includes(expected),[id,text]);
  const connect=async run=>{
    await find('read-token').fill(reader);
    if(run) await find('run-token').fill(runner);
    await page.locator('#access button[type="submit"]').click();
    await includes('access-status','已讀取工作區');
  };
  const image=async filename=>{
    const path=join(project,'docs','screenshots',filename);
    if(process.env.ACM_CAPTURE_PREVIEW==='1'&&!existsSync(path))
      writeFileSync(path,await page.screenshot(),{flag:'wx'});
  };
  await page.goto(origin+'/');
  assert.ok(await find('run-submit').isDisabled());
  await connect(true);
  await includes('nodes','模擬 Windows');
  assert.equal(await page.locator('#nodes article').count(),3);
  assert.ok(!(await page.locator('body').innerText()).includes(reader));
  await image('dashboard-preview.png');

  await page.locator('nav a[href="#setup"]').click();
  await find('enroll-id').fill('preview-node');
  await find('enroll-publisher').fill('preview-collector');
  await find('enroll-key').fill('a'.repeat(59));
  await page.locator('#enrollment button[type="submit"]').click();
  assert.equal(JSON.parse(await find('enroll-output').inputValue()).nodeId,'preview-node');
  await find('run-input').fill('展示合成工作流程');
  await find('run-submit').click();
  await includes('task-answer','模擬回應');
  await includes('task-state','SUCCEEDED');
  await find('run-result-link').click();
  // 錨點變更的 hashchange 另行派送；等候實際導覽狀態，不把 click 完成當成事件已處理。
  await page.waitForFunction(()=>location.hash==='#task-detail'&&
    document.querySelector('nav a[href="#tasks"]').getAttribute('aria-current')==='location');
  assert.equal(await page.locator('nav a[href="#tasks"]').getAttribute('aria-current'),'location');
  await find('task-detail').scrollIntoViewIfNeeded();
  await image('simulation-job.png');

  await find('clear-credentials').click();
  await connect(false);
  await page.locator('#task-list button').first().click();
  await includes('task-answer','僅提供給工作建立者');
  assert.deepEqual(await page.evaluate(()=>[localStorage.length,sessionStorage.length]),[0,0]);
  await page.setViewportSize({width:390,height:780});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);
});
