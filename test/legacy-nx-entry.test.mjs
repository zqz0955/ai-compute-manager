import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkNxDispatch,nxInstalled} from '../tools/nx-legacy/layout.mjs';

test('NX dispatch accepts exact window and available-memory boundaries',()=>{
  const approval=JSON.stringify({notBefore:1000,expires:2800});
  assert.equal(nxInstalled,false);
  assert.doesNotThrow(()=>checkNxDispatch(approval,2500000,()=> 'MemAvailable: 6291456 kB'));
  for(const time of [999999,2500001]){
    assert.throws(()=>checkNxDispatch(approval,time,()=> 'MemAvailable: 6291456 kB'),/NX_DISPATCH_WINDOW/);
  }
  assert.throws(()=>checkNxDispatch(JSON.stringify({notBefore:1000,expires:2801}),2500000,
    ()=> 'MemAvailable: 6291456 kB'),/NX_DISPATCH_WINDOW/);
  for(const mem of ['MemAvailable: 6291455 kB','MemFree: 9999999 kB']){
    assert.throws(()=>checkNxDispatch(approval,2500000,()=>mem),/NX_MEMORY_HEADROOM/);
  }
});
