const age=(at,now)=>Number.isSafeInteger(at)&&at>0&&at<=now+1000&&now-at<=15000;
const capped=(value,min,max)=>Number.isFinite(value)&&value>=min&&value<=max?value:null;
const size=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const kib=value=>Number.isSafeInteger(value)&&value>=0?size(1024*value):null;
const name=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_.:/-]{0,127}$/i.test(value);
const digest=value=>typeof value==='string'&&/^(?:sha256:)?[0-9a-f]{64}$/i.test(value);
const fault=()=>Error('LEGACY_TELEMETRY_SOURCE_UNVERIFIED');

function modelList(rows){
  if (!Array.isArray(rows)||rows.length>128||rows.some(row=>!name(row?.name)||
      !digest(row.digest)||size(row.sizeBytes??row.size)===null)) return null;
  const names=new Set(rows.map(row=>row.name));
  return names.size===rows.length?rows.map(row=>({name:row.name,digest:row.digest.replace(/^sha256:/i,'').toLowerCase(),
    sizeBytes:row.sizeBytes??row.size})):null;
}
function residency(rows,installed){
  if (!Array.isArray(rows)||rows.length>128||new Set(rows).size!==rows.length||!rows.every(name)) return null;
  const indexed=new Map((installed??[]).map(model=>[model.name,model]));
  return rows.every(value=>indexed.has(value))?rows.map(value=>indexed.get(value)):null;
}

// 只接受既有受信觀測器的讀取投影。簽署者仍須確認原來源與設備身分。
export function projectLegacyTelemetry(frame,sourceNodeId,now=Date.now()){
  if (typeof sourceNodeId!=='string'||!age(frame?.capturedAt,now)) throw fault();
  let node,models,resident;
  if (frame.source==='V06_LOOPBACK_VERIFIED'){
    // V0.7 可信 V0.6 觀測器的跨帳號 frame。
    if (!Array.isArray(frame.nodes)||frame.nodes.length>32) throw fault();
    const matches=frame.nodes.filter(row=>row?.node?.id===sourceNodeId);
    if (matches.length!==1) throw fault();
    ({node,models,resident}=matches[0]);
    models=models?.ok===true?models.data:null;
    resident=resident?.ok===true?resident.data:null;
  } else if (frame.source==='V07_MANAGEMENT_CAPTURE'){
    // 同次既有管理 API 的 health、node、models、resident 四個 data 投影。
    const health=frame.health?.data;
    if (health?.apiVersion!=='1'||health.mode!=='READ_ONLY'||health.dataSource!=='V06_LOOPBACK_VERIFIED'||
        health.inference!=='DISABLED') throw fault();
    node=frame.node?.data;
    models=frame.models?.data?.nodeId===sourceNodeId?frame.models.data.models:null;
    resident=frame.resident?.data?.nodeId===sourceNodeId?frame.resident.data:null;
  } else throw fault();

  const monitoring=node?.monitoring;
  const sampledAt=typeof monitoring?.lastSampleAt==='string'?Date.parse(monitoring.lastSampleAt):
    monitoring?.lastSampleAt??monitoring?.sampledAt;
  const freshness=monitoring?.stale===false||monitoring?.freshness==='FRESH';
  if (node?.id!==sourceNodeId||node.identityVerified!==true||node.status!=='ONLINE'||
      monitoring?.status!=='ACTIVE'||!freshness||!age(sampledAt,now)||sampledAt>frame.capturedAt+1000) throw fault();

  const t=node.telemetry;
  const temperature=Array.isArray(t?.temperatures)&&t.temperatures.length<=32?
    t.temperatures.map(row=>capped(row?.celsius,-40,150)).filter(value=>value!==null):[];
  const ramBytes=kib(t?.ram?.totalKiB),ramUsedBytes=kib(t?.ram?.usedKiB);
  const diskBytes=kib(t?.disk?.totalKiB),diskUsedBytes=kib(t?.disk?.usedKiB);
  const swap=t?.swap??{usedKiB:t?.ram?.swapUsedKiB};
  const swapBytes=kib(swap.totalKiB),swapUsedBytes=kib(swap.usedKiB);
  const installed=modelList(models);
  return {sampledAt,metrics:{
    cpuPercent:capped(t?.cpuPercent,0,100),gpuPercent:capped(t?.gpuPercent,0,100),gpuUsedBytes:null,
    ramUsedBytes:ramBytes!==null&&ramUsedBytes>ramBytes?null:ramUsedBytes,ramBytes,
    swapUsedBytes:swapBytes!==null&&swapUsedBytes>swapBytes?null:swapUsedBytes,swapBytes,
    diskUsedBytes:diskBytes!==null&&diskUsedBytes>diskBytes?null:diskUsedBytes,diskBytes,
    temperatureC:temperature.length?Math.max(...temperature):null},
    models:installed,resident:age(resident?.sampledAt,now)?residency(resident.models,installed):null};
}
