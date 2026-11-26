import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {startService} from '../server.mjs';
import {assertPinned,pinPath} from '../tools/lock.mjs';
import {importHistory} from '../tools/import-history.mjs';
import {createWorkspaceFixture} from '../tools/fixtures/workspace-fixture.mjs';

const rc=fileURLToPath(new URL('../tools/rc.mjs',import.meta.url));
const cmd=(...args)=>spawnSync(process.execPath,[rc,...args],{windowsHide:true,encoding:'utf8',timeout:45000});
function run(...args){
  const result=cmd(...args);
  assert.equal(result.status,0,result.stderr.trim());
  return JSON.parse(result.stdout);
}

test('實際本機服務保留 SQLite、兩種 Token 與舊歷史隔離，來源換檔拒絕',async t=>{
  const names=['config.json','tokens.json','tokens-old.json','install-manifest.json','maintenance.lock','storage-seal.json',
    'data/controller.sqlite','data/telemetry.sqlite','data/legacy-history.json','data/controller.sqlite-wal',
    'data/controller.sqlite-shm','data/telemetry.sqlite-wal','data/telemetry.sqlite-shm'];
  const fixture=await createWorkspaceFixture('jcm-service-',names.map(name=>join('install',name)));
  const install=join(fixture.root,'install');
  let service;
  t.after(async()=>{
    await service?.close();
    await fixture.clean();
  });
  run('setup',install,'--simulation');
  await fixture.recordDirectory(install);
  await fixture.recordDirectory(join(install,'data'));
  const config=join(install,'config.json');
  const registry=join(install,'tokens.json');
  const values=JSON.parse(readFileSync(config));
  writeFileSync(config,JSON.stringify({...values,port:0}));
  const reader=run('token','issue',install,'reader','manage:read').token;
  const runner=run('token','issue',install,'runner','models:run').token;
  const capturedAt=Date.now()-3600000;
  const lane={nodeId:'archived-node',kind:'generate',state:'INTERRUPTED',createdAt:capturedAt,
    startedAt:capturedAt,finishedAt:capturedAt,model:'archived:model',errorCode:null};
  const snapshot={version:1,source:'V0.6_SNAPSHOT',capturedAt,requestsCount:2,holdsCount:1,
    tasks:[{...lane,id:'archive-job-a'},{...lane,id:'archive-job-b'}],
    duals:[{id:'archive-pair',createdAt:capturedAt,parallel:'unknown',ids:['archive-job-a','archive-job-b']}]};
  const legacyText=JSON.stringify(snapshot);
  const legacyFile=await fixture.createFile('legacy-input.json',legacyText);
  const sha=createHash('sha256').update(legacyText).digest('hex');
  assert.throws(()=>importHistory(install,legacyFile,'0'.repeat(64)),/HASH_MISMATCH/);
  assert.equal(importHistory(install,legacyFile,sha).duals,1);
  assert.throws(()=>importHistory(install,legacyFile,sha),{code:'EEXIST'});
  const auditors=[];
  const start=async()=>{service=await startService(config,{audit:row=>auditors.push(row)});};
  const request=(path,token,body)=>{
    const headers={...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})};
    return fetch('http://127.0.0.1:'+service.info.port+path,
      {headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  };
  await start();
  assert.equal(service.info.host,'127.0.0.1');
  assert.notEqual(service.info.port,8875);
  assert.notEqual(service.info.port,8897);
  assert.equal((await request('/')).status,200);
  assert.equal((await request('/acm/v1/nodes')).status,401);
  assert.match(cmd('doctor',install).stderr,/INSTALLATION_LOCKED/);
  const nodeList=(await (await request('/acm/v1/nodes',reader)).json()).data.nodes;
  assert.equal(nodeList.length,3);
  const nodeId=nodeList[0].id;
  assert.equal(nodeList[0].source,'SIMULATION');
  assert.equal(nodeList[0].telemetry.gpuPercent,0);
  assert.equal((await (await request('/acm/v1/health',reader)).json()).data.inference,'SIMULATION_ONLY');
  assert.equal((await (await request('/acm/v1/nodes/'+nodeId,reader)).json()).data.id,nodeId);
  assert.equal((await (await request('/acm/v1/nodes/'+nodeId+'/models',reader)).json()).data.source,'SIMULATION');
  assert.ok((await (await request('/acm/v1/history?nodeId='+nodeId,reader)).json()).data.samples.length);
  assert.equal((await (await request('/acm/v1/tasks',reader)).json()).data.tasks.length,2);
  assert.deepEqual((await (await request('/acm/v1/nodes/'+nodeId+'/resident',reader)).json()).data.models,[]);
  assert.ok((await (await request('/acm/v1/dashboard/history?nodeId='+nodeId,reader)).json()).samples.length);
  assert.equal((await (await request('/acm/v1/duals',reader)).json()).data.duals[0].id,'archive-pair');
  assert.equal((await request('/acm/v1/duals',runner)).status,403);

  for(const route of ['/acm/v1/install','/acm/v1/power','/acm/v1/terminal']){
    assert.equal((await request(route,runner,{target:nodeId})).status,404);
  }
  const response=await request('/v1/chat/completions',runner,
    {model:'fixture:demo',messages:[{role:'user',content:'sensitive-synthetic-prompt'}],max_tokens:1});
  assert.equal(response.status,200);
  const jobId=response.headers.get('x-acm-job-id');
  assert.ok(jobId);
  const completion=await response.json();
  assert.equal(completion.acm_source,'SIMULATION');
  assert.equal(completion.choices[0].finish_reason,'length');
  const before=(await (await request('/acm/v1/dashboard',reader)).json());
  assert.equal(before.jobs.length,1);
  assert.equal(before.events.filter(row=>row.event==='INTENT').length,1);
  assert.equal(before.locks.length,0);
  assert.equal(before.archive.holdsCount,1);
  assert.equal(Object.hasOwn(before.jobs[0],'output'),false);

  await service.close();
  assert.equal(existsSync(join(install,'maintenance.lock')),false);
  await start();
  const after=(await (await request('/acm/v1/dashboard',reader)).json());
  assert.deepEqual(after.jobs,before.jobs);
  assert.equal(after.archive.tasks.length,2);
  assert.equal(after.archive.tasks[0].state,'INTERRUPTED');
  assert.equal(after.events.filter(row=>row.event==='INTENT').length,
    before.events.filter(row=>row.event==='INTENT').length);
  renameSync(registry,join(install,'tokens-old.json'));
  writeFileSync(registry,readFileSync(join(install,'tokens-old.json')),{mode:0o600});
  assert.equal((await request('/acm/v1/dashboard',reader)).status,503);
  const log=JSON.stringify(auditors);
  assert.ok(![reader,runner,'sensitive-synthetic-prompt'].some(text=>log.includes(text)));
  await service.close();
  const stores=['controller.sqlite','telemetry.sqlite'].map(name=>pinPath(join(install,'data',name),'file'));
  for (const store of stores) {assertPinned(store);unlinkSync(store.path);}
  await assert.rejects(startService(config),/INITIALIZED_STORE_MISSING/);
  assert.ok(stores.every(store=>!existsSync(store.path)));
});
