import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {IDENTIFIER,validateTokens} from '../tools/config.mjs';

const scope = {read:'manage:read', run:'models:run', admin:'manage:write'};
const nodeId = IDENTIFIER;
const digest = /^[a-f0-9]{64}$/i;
const errors = {
  BAD_REQUEST:'查詢格式不符', UNAUTHENTICATED:'需要有效的 API Token', SCOPE_REQUIRED:'Token 權限不足',
  ORIGIN_DENIED:'只接受本機同源請求', NOT_FOUND:'查無接口或節點', METHOD_NOT_ALLOWED:'接口只開放 GET',
  BODY_LIMIT:'此接口不接受請求內容', RATE_LIMIT:'請求頻率已超出上限', BUSY:'讀取請求已滿',
  READ_TIMEOUT:'讀取超過時間上限', NODE_UNAVAILABLE:'節點或身分目前無法確認',
  SSH_FAILED:'受保護 SSH 查詢失敗', MODEL_QUERY_FAILED:'模型查詢失敗', HISTORY_UNAVAILABLE:'監控歷史無法讀取',
  STARTING:'控制程序尚未就緒', INFERENCE_DISABLED:'模型推論尚未開放', RESPONSE_LIMIT:'回應超過大小上限',
  TOKEN_REGISTRY_UNAVAILABLE:'Token 登錄檔的完整性需要重新驗證',
  UPSTREAM_UNAVAILABLE:'已核對的 V0.6 資料來源目前無法讀取',
  INTERNAL:'作業失敗',
};
const fail = (status, code) => Object.assign(Error(errors[code]), {status, code});
const finite = (n, min=0, max=Number.MAX_SAFE_INTEGER) => typeof n==='number' && Number.isFinite(n) && n>=min && n<=max ? n : null;
const text = (s,limit=128) => typeof s==='string' ? s.slice(0,limit) : null;
const at = value => typeof value==='string' ? finite(Date.parse(value)) : finite(value);

function storage(value) {
  return Object.fromEntries(['usedKiB','totalKiB','availableKiB'].map(key=>[key,finite(value?.[key])]));
}
function nodeView(row, now) {
  const sampledAt=at(row.monitoring?.lastSampleAt);
  const ageMs=sampledAt===null ? null : Math.max(0,now-sampledAt);
  const stale=ageMs===null || ageMs>15000 || row.monitoring?.stale!==false || row.status!=='ONLINE';
  const fresh=!stale && sampledAt<=now+1000 && row.identityVerified===true && row.monitoring?.status==='ACTIVE';
  const t=fresh ? row.telemetry : null;
  return {
    id:row.id,name:text(row.name),...(row.source?{source:row.source}:{}),status:text(row.status) ?? 'UNKNOWN',ollamaStatus:fresh ? text(row.ollamaStatus) ?? 'UNKNOWN' : 'UNKNOWN',
    identityVerified:row.identityVerified===true,
    monitoring:{status:text(row.monitoring?.status) ?? 'UNKNOWN',freshness:sampledAt===null?'UNKNOWN':stale?'STALE':fresh?'FRESH':'UNKNOWN',
      sampledAt,ageMs,errorCode:fresh?null:row.status==='OFFLINE'?'NODE_OFFLINE':row.status==='ERROR'?'MONITOR_FAILED':stale?'SAMPLE_UNAVAILABLE':'SAMPLE_UNVERIFIED'},
    telemetry:{cpuPercent:finite(t?.cpuPercent,0,100),gpuPercent:finite(t?.gpuPercent,0,100),ram:storage(t?.ram),
      swap:storage(t?.swap ?? {usedKiB:t?.ram?.swapUsedKiB}),disk:storage(t?.disk),
      temperatures:(t?.temperatures ?? []).slice(0,32).map(x=>({name:text(x.name),celsius:finite(x.celsius,-40,150)})).filter(x=>x.celsius!==null)},
  };
}
function taskView(t) {
  return {id:text(t.id),nodeId:text(t.nodeId),kind:text(t.kind),state:text(t.state),createdAt:at(t.createdAt),
    ...(t.source?{source:t.source}:{}),
    startedAt:at(t.startedAt),finishedAt:at(t.finishedAt),model:text(t.model,512),
    errorCode:/^[A-Z0-9_]{1,64}$/.test(t.errorCode ?? '') ? t.errorCode : null};
}
const historyKeys=['cpuPercent','gpuPercent','ramUsedKiB','ramAvailableKiB','swapUsedKiB','temperatureC','powerWatts'];

function query(raw, allowed) {
  const params=new URLSearchParams(raw);
  const seen=new Set();
  for (const [key] of params) {
    if (!allowed.includes(key) || seen.has(key)) throw fail(400,'BAD_REQUEST');
    seen.add(key);
  }
  return params;
}
function integer(params,key,fallback,min,max) {
  if (!params.has(key)) return fallback;
  const raw=params.get(key);
  const value=Number(raw);
  if (!/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(value) || value<min || value>max) throw fail(400,'BAD_REQUEST');
  return value;
}
function credentials(rows) {
  return validateTokens({version:1,tokens:rows}).tokens.map(row=>
    ({id:row.id,hash:Buffer.from(row.sha256,'hex'),scopes:new Set(row.scopes),expiresAt:row.expiresAt}));
}

export function createTokenAuthenticator(tokens, now = Date.now) {
  const registry=credentials(tokens);
  return function authenticate(header) {
    const token=/^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? '');
    if (!token) throw fail(401,'UNAUTHENTICATED');
    const hash=createHash('sha256').update(token[1]).digest();
    let match;
    for (const candidate of registry) if (timingSafeEqual(hash,candidate.hash)) match=candidate;
    if (!match || match.expiresAt<=now()) throw fail(401,'UNAUTHENTICATED');
    return match;
  };
}

export function createManagementApi({tokens,audit=()=>{},now=Date.now,clock=()=>performance.now(),timeoutMs=9000,maxConcurrent=4,verifyRegistry}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>9000 ||
      !Number.isInteger(maxConcurrent) || maxConcurrent<1 || maxConcurrent>4) throw Error('API limits invalid');
  const authenticate=createTokenAuthenticator(tokens,now);
  const windows=new Map();
  let inFlight=0;
  function allow(key,count) {
    const index=Math.floor(clock()/60000);
    let bucket=windows.get(key);
    if (bucket?.index!==index) {bucket={index,used:0};windows.set(key,bucket);}
    return ++bucket.used<=count;
  }
  function projectError(cause) {
    if (cause?.status && Object.hasOwn(errors,cause.code) && cause.message===errors[cause.code]) return cause;
    if (cause?.code==='NODE_CHANGED' || cause?.code==='SCHEDULING_BLOCKED' || cause?.code==='MONITOR_UNAVAILABLE' ||
        cause?.code==='NODE_UNAVAILABLE' || cause?.code==='NODE_BUSY') return fail(503,'NODE_UNAVAILABLE');
    if (typeof cause?.code==='string' && cause.code.includes('TIMEOUT')) return fail(504,'READ_TIMEOUT');
    if (cause?.code==='UPSTREAM_UNAVAILABLE') return fail(503,'UPSTREAM_UNAVAILABLE');
    if (cause?.code==='MODEL_QUERY_FAILED') return fail(502,'MODEL_QUERY_FAILED');
    if (typeof cause?.code==='string' && cause.code.startsWith('SSH_')) return fail(502,'SSH_FAILED');
    if (typeof cause?.code==='string' && cause.code.startsWith('OLLAMA_')) return fail(502,'MODEL_QUERY_FAILED');
    return fail(500,'INTERNAL');
  }
  async function data(path,search,services) {
    const {manager,history,work}=services;
    if (path==='/acm/v1/health') {
      query(search,[]);
      return {status:'READY',apiVersion:'1',mode:'READ_ONLY',dataSource:services.source??'SIMULATION',inference:services.inference??(services.source==='SIMULATION'?'SIMULATION_ONLY':'DISABLED'),
        ...(services.sourceStatus?{sourceStatus:services.sourceStatus(),historySource:'BRIDGE_SESSION'}:{})};
    }
    if (path==='/acm/v1/nodes') {
      query(search,[]);
      return {nodes:manager.list().map(row=>nodeView(row,now()))};
    }
    const match=/^\/acm\/v1\/nodes\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})(?:\/(models|resident))?$/.exec(path);
    if (match) {
      query(search,[]);
      const node=manager.find(match[1]);
      if (!node) throw fail(404,'NOT_FOUND');
      if (!match[2]) return nodeView(manager.view(node),now());
      if (match[2]==='models') {
        const rows=await manager.listModels(node,{strictNames:true});
        if (!Array.isArray(rows) || rows.length>512) throw fail(502,'MODEL_QUERY_FAILED');
        return {nodeId:node.id,...(node.source?{source:node.source}:{}),models:rows.map(row=>({name:text(row.name,512),digest:digest.test(row.digest ?? '')?row.digest:null,sizeBytes:finite(row.size)}))};
      }
      const row=await manager.residentSnapshot(node);
      const sampledAt=at(row.sampledAt);
      if (sampledAt===null || now()-sampledAt>15000 || sampledAt>now()+1000) throw fail(503,'NODE_UNAVAILABLE');
      if (!Array.isArray(row.models) || row.models.length>512 || row.models.some(n=>typeof n!=='string' || !n || n.length>512))
        throw fail(502,'MODEL_QUERY_FAILED');
      return {nodeId:node.id,...(node.source?{source:node.source}:{}),models:row.models,sampledAt,freshness:'FRESH'};
    }
    if (path==='/acm/v1/history') {
      const q=query(search,['nodeId','from','to','limit']);
      const id=q.get('nodeId'), to=integer(q,'to',now(),0,Number.MAX_SAFE_INTEGER);
      const from=integer(q,'from',Math.max(0,to-3600000),0,to);
      const limit=integer(q,'limit',50,1,200);
      if (id!==null && !nodeId.test(id)) throw fail(400,'BAD_REQUEST');
      if (id!==null && !manager.find(id)) throw fail(404,'NOT_FOUND');
      if (history.status().error) throw fail(503,'HISTORY_UNAVAILABLE');
      const rows=history.query({nodeIds:id?[id]:[],from,to,limit,pruneOnRead:false});
      return {samples:rows.map(row=>({nodeId:row.nodeId,sampledAt:row.sampledAt,observedAt:row.observedAt,
        source:row.source,valid:row.valid,status:row.status,
        metrics:Object.fromEntries(historyKeys.map(k=>[k,row.valid?finite(row.metrics?.[k],k==='temperatureC'?-40:0):null]))}))};
    }
    const q=query(search,['before']);
    const before=integer(q,'before',Number.MAX_SAFE_INTEGER,1,Number.MAX_SAFE_INTEGER);
    const db=work().db;
    if(db.snapshotOnly && q.has('before')) throw fail(400,'BAD_REQUEST');
    const coverage=db.snapshotOnly?{coverage:db.coverage??'LATEST_UPSTREAM_PAGE'}:{};
    if (path==='/acm/v1/tasks') {
      const page=db.taskPage({before});
      return {tasks:page.tasks.map(taskView),nextBefore:page.nextBefore,...coverage};
    }
    const groups=db.duals(before);
    return {duals:groups.map(g=>({id:text(g.id),createdAt:at(g.createdAt),parallel:text(g.parallel),
      ...(g.source?{source:g.source}:{}),lanes:g.lanes.map(taskView)})),
      nextBefore:!db.snapshotOnly&&groups.length===50?groups.at(-1).cursor:null,...coverage};
  }
  const routes = new Set(['/acm/v1/health','/acm/v1/nodes','/acm/v1/history','/acm/v1/tasks','/acm/v1/duals']);
  return async function route(req,res,{expectedHost,ready,manager,history,work,source,sourceStatus,inference}) {
    const requestId=randomUUID(), start=clock();
    let token, routeName='unknown', status=500, code='INTERNAL';
    const response=(http,value)=>{
      const payload=JSON.stringify({requestId,...value});
      if (Buffer.byteLength(payload)>262144) throw fail(502,'RESPONSE_LIMIT');
      if (res.destroyed) return;
      res.writeHead(http,{'Content-Type':'application/json; charset=utf-8','X-Request-Id':requestId,'Cache-Control':'no-store'});
      res.end(payload);
    };
    try {
      if (!allow('loopback',240)) throw fail(429,'RATE_LIMIT');
      if (req.socket.remoteAddress!=='127.0.0.1' || req.headers.host!==expectedHost ||
          (req.headers.origin!==undefined && req.headers.origin!=='http://'+expectedHost) ||
          ![undefined,'none','same-origin'].includes(req.headers['sec-fetch-site'])) throw fail(403,'ORIGIN_DENIED');
      if (req.url.length>2048 || req.headers['transfer-encoding']!==undefined ||
          (req.headers['content-length']!==undefined && req.headers['content-length']!=='0')) throw fail(413,'BODY_LIMIT');
      if (verifyRegistry && !verifyRegistry()) throw fail(503,'TOKEN_REGISTRY_UNAVAILABLE');
      token=authenticate(req.headers.authorization);
      if (!allow('token:'+token.id,60)) throw fail(429,'RATE_LIMIT');
      const index=req.url.indexOf('?');
      const path=index<0 ? req.url : req.url.slice(0,index);
      const search=index<0 ? '' : req.url.slice(index+1);
      if (path==='/v1/models' || path==='/v1/chat/completions') {
        routeName='inference';
        if (!token.scopes.has(scope.run)) throw fail(403,'SCOPE_REQUIRED');
        throw fail(403,'INFERENCE_DISABLED');
      }
      if (!routes.has(path) && !/^\/acm\/v1\/nodes\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}(?:\/(?:models|resident))?$/.test(path)) throw fail(404,'NOT_FOUND');
      routeName=routes.has(path)?path:'/acm/v1/nodes/:id'+(path.endsWith('/resident')?'/resident':path.endsWith('/models')?'/models':'');
      if (!token.scopes.has(scope.read)) throw fail(403,'SCOPE_REQUIRED');
      if (req.method!=='GET') throw fail(405,'METHOD_NOT_ALLOWED');
      if (!ready) throw fail(503,'STARTING');
      if (inFlight>=maxConcurrent) throw fail(429,'BUSY');
      inFlight++;
      const operation=data(path,search,{manager,history,work,source,sourceStatus,inference}).finally(()=>{inFlight--;});
      let timer;
      try {
        const value=await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail(504,'READ_TIMEOUT')),timeoutMs);})]);
        if (verifyRegistry && !verifyRegistry()) throw fail(503,'TOKEN_REGISTRY_UNAVAILABLE');
        response(200,{data:value});
      } finally {clearTimeout(timer);}
      status=200;code=null;
    } catch (cause) {
      const fault=projectError(cause);
      status=fault.status;code=fault.code;
      if (status===401) res.setHeader('WWW-Authenticate','Bearer realm="ACM"');
      if (status===405) res.setHeader('Allow','GET');
      if (status===413) res.setHeader('Connection','close');
      if (status===429) res.setHeader('Retry-After','60');
      response(status,{error:{code,message:errors[code]}});
    } finally {
      // 審計只保留固定路由模板與 Token 識別碼，HTTP 請求不得提供審計欄位。
      try {audit({at:new Date(now()).toISOString(),requestId,tokenId:token?.id ?? null,route:routeName,
        status,code,durationMs:Math.max(0,Math.round(clock()-start))});} catch { /* 作業不依賴外部審計輸出。 */ }
    }
  };
}
