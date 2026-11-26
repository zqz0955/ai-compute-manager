import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import pkg from '../package.json' with {type:'json'};
import {fail,publicError} from './api-error.mjs';
import {isQualificationController} from './controller.mjs';
import {bodyLimit,complete,createCompletionStream,jobView,readJson,requestFor} from './inference-http.mjs';
import {createManagementApi,createTokenAuthenticator} from './management.mjs';
import {dashboardView,legacyViews} from './management-view.mjs';

const staticFiles=new Map([
  ['/',['index.html','text/html']],
  ['/style.css',['style.css','text/css']],
  ['/v06.css',['v06.css','text/css']],
  ['/workbench.css',['workbench.css','text/css']],
  ['/dashboard.js',['dashboard.js','text/javascript']]
]);
const managementPath=/^\/acm\/v1\/(?:health|history|tasks|duals|nodes(?:\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}(?:\/(?:models|resident))?)?)$/;
const ingressPaths=new Set(['/acm/v1/telemetry/challenge','/acm/v1/telemetry/snapshot']);
const jobPath=/^\/acm\/v1\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/cancel)?$/;
const singletonHeaders=['host','authorization','origin','sec-fetch-site','content-length','content-type','idempotency-key'];
const headers={
  'Cache-Control':'no-store',
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer'
};
const requireScope=(token,scope)=>{if (!token.scopes.has(scope)) throw fail('SCOPE_REQUIRED');};
const requireMethod=(req,res,method)=>{
  if (req.method===method) return;
  res.setHeader('Allow',method);
  throw fail('METHOD_NOT_ALLOWED');
};
const requireNoBody=req=>{
  if (req.headers['content-length']!==undefined && req.headers['content-length']!=='0') throw fail('BODY_LIMIT');
};

export function createHttpApp({controller,mode,tokens,verifyRegistry=()=>true,telemetry,legacy=null,observations,
  telemetryIngress,audit=()=>{},qualificationMode,
  now=Date.now,clock=()=>performance.now(),waitMs=90000}){
  const qualification=mode==='engine-qualification';
  if ((!['read-only','simulation'].includes(mode) && !qualification) ||
      qualification!==isQualificationController(controller) ||
      (qualificationMode!==undefined&&(!qualification||!['legacy-json','legacy-sse'].includes(qualificationMode))) ||
      !Number.isSafeInteger(waitMs) || waitMs<1 || waitMs>90000)
    throw Error('HTTP_CONFIGURATION_INVALID');
  const assets=new Map([...staticFiles].map(([path,[name,type]])=>
    [path,{body:readFileSync(new URL('../public/'+name,import.meta.url)),type:type+'; charset=utf-8'}]));
  const authenticate=createTokenAuthenticator(tokens,now);
  const management=createManagementApi({tokens,audit,now,clock,verifyRegistry});
  const buckets=new Map();
  let waiting=0;
  let active=0;
  function rateLimit(key,limit) {
    const index=Math.floor(clock()/60000);
    if (buckets.get(key)?.index!==index) buckets.set(key,{index,used:0});
    if (++buckets.get(key).used>limit) throw fail('RATE_LIMIT');
  }
  function trustedRegistry(){
    if (!verifyRegistry()) throw fail('TOKEN_REGISTRY_UNAVAILABLE');
  }

  const server=createServer({maxHeaderSize:8192,requestTimeout:10000,headersTimeout:5000,keepAliveTimeout:5000,
    connectionsCheckingInterval:1000},async (req,res)=>{
    const id=randomUUID(),start=clock();
    for (const [key,value] of Object.entries(headers)) res.setHeader(key,value);
    res.setHeader('X-Request-Id',id);
    let token,stream,route='unknown',status=500,code='INTERNAL',counted=false,delegated=false;
    const json=(http,value)=>{
      const payload=JSON.stringify(value);
      if (Buffer.byteLength(payload)>262144) throw fail('RESPONSE_LIMIT');
      if (res.destroyed) return;
      res.writeHead(http,{'Content-Type':'application/json; charset=utf-8'});
      res.end(payload);
    };
    try {
      rateLimit('local',320);
      const host='127.0.0.1:'+server.address()?.port;
      if (req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==host ||
          (req.headers.origin!==undefined && req.headers.origin!=='http://'+host) ||
          ![undefined,'none','same-origin'].includes(req.headers['sec-fetch-site'])) throw fail('ORIGIN_DENIED');
      if (singletonHeaders.some(key=>(req.headersDistinct[key]?.length ?? 0)>1)) throw fail('BAD_REQUEST');
      if (typeof req.url!=='string' || req.url.length>2048 || !req.url.startsWith('/') ||
          req.url.startsWith('//') || /[\\#\u0000-\u0020\u007f]/.test(req.url)) throw fail('BAD_REQUEST');
      if ('transfer-encoding' in req.headers || Number(req.headers['content-length'] ?? 0)>bodyLimit)
        throw fail('BODY_LIMIT');
      const question=req.url.indexOf('?');
      const path=question<0?req.url:req.url.slice(0,question);
      const search=question<0?'':req.url.slice(question+1);
      const asset=assets.get(path);
      if (asset){
        requireNoBody(req);
        if (req.method!=='HEAD') requireMethod(req,res,'GET');
        route='static';
        status=200;code=null;
        res.writeHead(200,{'Content-Type':asset.type,'Content-Length':asset.body.length});
        return res.end(req.method==='HEAD'?undefined:asset.body);
      }
      if (active>=16) throw fail('BUSY');
      counted=true;
      active++;
      if (managementPath.test(path)){
        delegated=true;
        return await management(req,res,{expectedHost:host,ready:true,...legacyViews(controller,telemetry,mode,now(),legacy,observations)});
      }
      trustedRegistry();
      token=authenticate(req.headers.authorization);
      rateLimit('token:'+token.id,90);

      if (ingressPaths.has(path)){
        route=path;
        if (!telemetryIngress) throw fail('NOT_FOUND');
        requireScope(token,'telemetry:publish');
        requireMethod(req,res,'POST');
        if (search) throw fail('BAD_REQUEST');
        const body=await readJson(req);
        trustedRegistry();
        token=authenticate(req.headers.authorization);
        if (res.destroyed) return;
        const receipt=await telemetryIngress({path,token,body});
        trustedRegistry();
        authenticate(req.headers.authorization);
        json(200,receipt);
      } else if (path==='/acm/v1/dashboard' || path==='/acm/v1/dashboard/history'){
        route=path;
        requireScope(token,'manage:read');
        requireMethod(req,res,'GET');
        requireNoBody(req);
        if (path.endsWith('/history')){
          const query=new URLSearchParams(search),nodeId=query.get('nodeId');
          if (query.size!==1 || !nodeId || !/^[A-Za-z0-9._:-]{1,128}$/.test(nodeId)) throw fail('BAD_REQUEST');
          if (!controller.nodes().some(row=>row.id===nodeId) &&
              !observations?.().some(row=>row.id===nodeId)) throw fail('NOT_FOUND');
          json(200,{samples:telemetry.history({nodeId,limit:120})});
        } else {
          if (search) throw fail('BAD_REQUEST');
          json(200,dashboardView(controller,mode,pkg.version,now(),legacy,observations));
        }
      } else if (path==='/v1/models'){
        route=path;
        requireScope(token,'models:run');
        requireMethod(req,res,'GET');
        requireNoBody(req);
        if (search) throw fail('BAD_REQUEST');
        json(200,{object:'list',data:(mode==='read-only'?[]:controller.models({eligibleOnly:true})).map(model=>
          ({id:model.id,object:'model',created:0,owned_by:qualification?'acm-isolated-qualification':'acm-simulation'}))});
      } else if (path==='/acm/v1/jobs' || path==='/v1/chat/completions' || path==='/v1/completions'){
        route=path;
        requireScope(token,'models:run');
        requireMethod(req,res,'POST');
        if (mode==='read-only') throw fail('INFERENCE_DISABLED');
        if (search) throw fail('BAD_REQUEST');
        const kind=path==='/acm/v1/jobs'?'job':path.includes('/chat/')?'chat':'completion';
        const body=await readJson(req);
        trustedRegistry();
        token=authenticate(req.headers.authorization);
        if (res.destroyed) return;
        if (qualificationMode!==undefined&&(kind!=='completion'||(body?.stream===true)!==(qualificationMode==='legacy-sse')))
          throw fail('INFERENCE_DISABLED');
        if (kind!=='job' && waiting>=8) throw fail('BUSY');
        const request=requestFor(body,kind,controller.models(),token,req.headers['idempotency-key']);
        const job=controller.submit(request);
        res.setHeader('X-ACM-Job-Id',job.id);
        if (kind==='job'){
          status=202;code=null;
          return json(202,{job:jobView(job,true)});
        }
        const client=new AbortController(),expiry=new AbortController();
        const disconnected=()=>client.abort(fail('CLIENT_DISCONNECTED'));
        const validity=token.expiresAt-now();
        const expiration=validity<=waitMs?
          setTimeout(()=>expiry.abort(fail('UNAUTHENTICATED')),Math.max(0,validity)):null;
        if (body.stream) stream=createCompletionStream(res,job,kind,body.stream_options?.include_usage);
        res.once('close',disconnected);
        waiting++;
        let result;
        try {
          const signal=AbortSignal.any([client.signal,expiry.signal,AbortSignal.timeout(waitMs)]);
          result=await controller.wait(job.id,{signal,onDelta:stream?fragment=>{
            signal.throwIfAborted();
            trustedRegistry();
            authenticate(req.headers.authorization);
            stream.delta(fragment);
          }:undefined});
        } finally {
          clearTimeout(expiration);
          res.off('close',disconnected);
          waiting--;
        }
        if (res.destroyed) return;
        trustedRegistry();
        authenticate(req.headers.authorization);
        if (stream) stream.finish(result);
        else json(200,complete(result,kind));
      } else {
        const match=jobPath.exec(path);
        if (!match) throw fail('NOT_FOUND');
        route='/acm/v1/jobs/:id'+(match[2]??'');
        if (search) throw fail('BAD_REQUEST');
        requireNoBody(req);
        if (match[2]){
          requireScope(token,'models:run');
          requireMethod(req,res,'POST');
          if (mode==='read-only') throw fail('INFERENCE_DISABLED');
        } else {
          requireMethod(req,res,'GET');
          if (!token.scopes.has('manage:read')) requireScope(token,'models:run');
        }
        const job=controller.get(match[1]);
        if (!job) throw fail('NOT_FOUND');
        const mine=job.clientId===token.id && token.scopes.has('models:run');
        if (!mine && (match[2]||!token.scopes.has('manage:read'))) throw fail('NOT_FOUND');
        json(200,{job:jobView(match[2]?controller.cancel(job.id):job,mine)});
      }
      status=200;code=null;
    } catch (cause) {
      const fault=publicError(cause);
      status=fault.status;code=fault.code;
      if (res.destroyed) return;
      if (res.headersSent){
        if (stream) return stream.error(fault,id);
        return res.destroy();
      }
      if (status===401) res.setHeader('WWW-Authenticate','Bearer realm="ACM"');
      if (status===429) res.setHeader('Retry-After','60');
      if (!req.complete) res.setHeader('Connection','close');
      json(status,{error:{code,message:fault.message},requestId:id});
    } finally {
      if (counted) active--;
      if (!delegated){
        // 審計保留固定路由模板與驗證結果，排除未驗證的請求欄位。
        try {audit({at:new Date(now()).toISOString(),requestId:id,route,tokenId:token?.id??null,
          status,code,durationMs:Math.max(0,Math.round(clock()-start))});} catch { /* 審計介面以外的錯誤不輸出請求資料。 */ }
      }
    }
  });
  server.maxConnections=64;
  server.maxRequestsPerSocket=100;
  server.on('checkContinue',(_req,res)=>{
    res.writeHead(417,{...headers,'Connection':'close'});
    res.end();
  });
  return server;
}
