import assert from 'node:assert/strict';
import {test} from 'node:test';
import {finalizeDashboard} from '../tools/h2-dashboard.mjs';

test('browser close failure still signals service cleanup and saves sanitized HOLD',async()=>{
  const calls=[],receipt={status:'PASS_LOCAL_CHROME_LIVE_READONLY'};
  await finalizeDashboard({receipt,close:async()=>{calls.push('close');throw Error('private credential detail');},
    complete:()=>calls.push('complete'),writeReceipt:value=>{
      calls.push('write');assert.equal(value.status,'HOLD');assert.equal(value.browserClosed,false);
      assert.deepEqual(value.cleanupErrors,[{stage:'BROWSER_CLOSE',code:'H2_BROWSER_CLOSE_FAILED'}]);
      assert.ok(!JSON.stringify(value).includes('private credential'));
    }});
  assert.deepEqual(calls,['close','complete','write']);
});

test('completion signal failure is recorded after successful browser close',async()=>{
  let saved;
  await finalizeDashboard({receipt:{status:'PASS_LOCAL_CHROME_LIVE_READONLY'},close:async()=>{},
    complete:()=>{throw Error('private path');},writeReceipt:value=>{saved=value;}});
  assert.equal(saved.status,'HOLD');assert.equal(saved.browserClosed,true);
  assert.deepEqual(saved.cleanupErrors,[{stage:'COMPLETION_SIGNAL',code:'H2_COMPLETION_SIGNAL_FAILED'}]);
});

test('receipt failure remains explicit after completion signal; normal close preserves PASS',async()=>{
  let completed=false;
  await assert.rejects(finalizeDashboard({receipt:{status:'HOLD'},close:async()=>{},
    complete:()=>{completed=true;},writeReceipt:()=>{throw Error('private path');}}),
    /^Error: H2_DASHBOARD_RECEIPT_WRITE_FAILED$/);
  assert.equal(completed,true);
  let saved;
  await finalizeDashboard({receipt:{status:'PASS_LOCAL_CHROME_LIVE_READONLY'},close:async()=>{},
    complete:()=>{},writeReceipt:value=>{saved=value;}});
  assert.equal(saved.status,'PASS_LOCAL_CHROME_LIVE_READONLY');assert.equal(saved.browserClosed,true);
  assert.deepEqual(saved.cleanupErrors,[]);assert.ok(Number.isFinite(Date.parse(saved.stoppedAt)));
});
