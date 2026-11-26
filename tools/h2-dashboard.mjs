import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {pinPath,createPrivateRoot} from './lock.mjs';
import {readJson,writeNewJson} from './files.mjs';

export async function finalizeDashboard({receipt,close,complete,writeReceipt}){
  receipt.browserClosed=false;
  receipt.cleanupErrors=[];
  // 瀏覽器收尾失敗仍通知隔離服務停機並保存回條，不以先前畫面成功掩蓋失敗。
  if(close) try{await close();receipt.browserClosed=true;}
  catch{receipt.cleanupErrors.push({stage:'BROWSER_CLOSE',code:'H2_BROWSER_CLOSE_FAILED'});}
  try{complete();}
  catch{receipt.cleanupErrors.push({stage:'COMPLETION_SIGNAL',code:'H2_COMPLETION_SIGNAL_FAILED'});}
  if(receipt.cleanupErrors.length) receipt.status='HOLD';
  receipt.stoppedAt=new Date().toISOString();
  try{writeReceipt(receipt);}
  catch{throw Error('H2_DASHBOARD_RECEIPT_WRITE_FAILED');}
}

async function main(){
  const [workspace,receiptPath,screenshotPath,...extra]=process.argv.slice(2);
  if(extra.length||!workspace||!receiptPath||!screenshotPath) throw Error('H2_EXPECTED_WORKSPACE_RECEIPT_SCREENSHOT');
  const scope=pinPath(workspace,'directory');
  const access=join(scope.path,'ui-access.json');
  const startedAt=new Date().toISOString();
  for(let count=0;count<120&&!existsSync(access);count++) await delay(1000);
  const {value}=readJson(access);
  const address=new URL(value.url);
  assert.equal(address.protocol,'http:');assert.equal(address.hostname,'127.0.0.1');
  assert.ok(address.port&&!['8875','8897','11434'].includes(address.port));
  assert.equal(address.href,address.origin+'/');
  assert.equal(typeof value.token,'string');
  const require=createRequire(import.meta.url);
  const {chromium}=require(require.resolve('playwright',{paths:[resolve(dirname(process.execPath),'../node_modules')]}));
  const profile=createPrivateRoot(join(scope.path,'chrome-profile'));
  const receipt={startedAt,endpoint:address.origin,browser:'LOCAL_CHROME_HEADLESS',checks:[],externalRequestsBlocked:0};
  let browser;
  try{
    browser=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true,
      viewport:{width:1440,height:1050},locale:'zh-TW',
      args:['--disable-background-networking','--disable-component-update','--no-first-run']});
    await browser.route('**/*',route=>{
      if(new URL(route.request().url()).origin===address.origin) return route.continue();
      receipt.externalRequestsBlocked++;
      return route.abort();
    });
    const page=browser.pages()[0];
    const faults=[];
    page.on('pageerror',error=>faults.push(error.name));
    await page.goto(address.origin+'/',{waitUntil:'domcontentloaded'});
    assert.ok(await page.locator('#run-submit').isDisabled());
    await page.locator('#read-token').fill(value.token);
    await page.locator('#access button[type="submit"]').click();
    await page.waitForFunction(()=>document.getElementById('access-status').textContent.includes('已讀取工作區'));
    assert.equal(await page.locator('#nodes article').count(),3);
    const nodeText=await page.locator('#nodes').innerText();
    assert.match(nodeText,/Windows 本機採樣/u);
    assert.match(nodeText,/既有唯讀監控轉接/u);
    assert.equal((nodeText.match(/FRESH/g)??[]).length,3);
    assert.ok(!nodeText.includes('SIMULATED'));
    receipt.checks.push('THREE_REAL_NODES','EXPLICIT_SOURCE_LABELS','FRESH_DATA');
    const inventory=await page.locator('#model-inventory article').allTextContents();
    assert.equal(inventory.length,3);
    assert.equal(inventory.filter(text=>text.includes('駐留模型 · 清單為空')).length,2);
    assert.equal(await page.locator('#model-inventory .model-row').count(),7);
    receipt.checks.push('SEVEN_INSTALLED_MODELS','TWO_VALID_EMPTY_RESIDENT_LISTS');
    const decisions=await page.locator('#gate-facts').innerText();
    assert.match(decisions,/唯讀准入判斷/u);
    assert.match(decisions,/拒絕派送 · 唯讀模式/u);
    assert.match(decisions,/無選取節點/u);
    assert.match(decisions,/本診斷未執行資源預留或派送/u);
    for(const name of await page.locator('#nodes article h3').allTextContents()) assert.ok(decisions.includes(name+' · 不可派送'));
    assert.equal((decisions.match(/READ_ONLY_MODE/g)??[]).length,3);
    assert.equal((decisions.match(/OBSERVATION_NOT_EXECUTION_QUALIFICATION/g)??[]).length,3);
    receipt.checks.push('THREE_REAL_NODE_PLACEMENT_REASONS','EMPTY_SELECTION','NO_RESERVATION_OR_DISPATCH');
    assert.ok(await page.locator('#run-submit').isDisabled());
    assert.equal(await page.locator('#read-token').inputValue(),'');
    assert.ok(!(await page.locator('body').innerText()).includes(value.token));
    assert.deepEqual(faults,[]);
    receipt.checks.push('INFERENCE_DISABLED','TOKEN_NOT_IN_DOM','NO_BROWSER_ERRORS');
    await page.screenshot({path:screenshotPath,fullPage:true});
    receipt.nodes=await page.locator('#nodes article h3').allTextContents();
    receipt.readonly=true;
    receipt.status='PASS_LOCAL_CHROME_LIVE_READONLY';
    await page.locator('#clear-credentials').click();
    assert.ok(await page.locator('#run-submit').isDisabled());
    receipt.checks.push('BROWSER_CREDENTIALS_CLEARED');
  }catch(cause){
    receipt.status='HOLD';
    receipt.failure={code:cause.code??cause.name,actual:typeof cause.actual==='number'?cause.actual:null,
      expected:typeof cause.expected==='number'?cause.expected:null,
      location:cause.stack?.match(/h2-dashboard\.mjs:\d+:\d+/)?.[0]??null};
    process.exitCode=1;
  }finally{
    await finalizeDashboard({receipt,close:browser?()=>browser.close():null,
      complete:()=>writeNewJson(join(scope.path,'ui-done.json'),{done:true}),
      writeReceipt:value=>writeNewJson(receiptPath,value)});
    if(receipt.status==='HOLD') process.exitCode=1;
  }
  console.log(JSON.stringify({status:receipt.status,checks:receipt.checks.length}));
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  try{await main();}
  catch(cause){
    console.error(/^H2_[A-Z_]+$/.test(cause?.message??'')?cause.message:'H2_DASHBOARD_FAILED');
    process.exitCode=1;
  }
}
