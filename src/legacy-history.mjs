import {hasKeys} from './inference-http.mjs';
import {IDENTIFIER} from '../tools/config.mjs';

const historyStates=['QUEUED','RUNNING','STOPPING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED','TIMED_OUT','REJECTED'];
const taskFields=['id','nodeId','kind','state','createdAt','startedAt','finishedAt','model','errorCode'];
const timestamp=value=>Number.isSafeInteger(value)&&value>=0;
const nullable=(value,check)=>value===null||check(value);
const identifier=value=>typeof value==='string'&&IDENTIFIER.test(value);
const latest=(a,b)=>b.createdAt-a.createdAt;

function task(value){
  if (!hasKeys(value,taskFields)||!identifier(value.id)||!nullable(value.nodeId,identifier)||
      !identifier(value.kind)||!historyStates.includes(value.state)||!timestamp(value.createdAt)||
      !nullable(value.startedAt,timestamp)||!nullable(value.finishedAt,timestamp)||
      !nullable(value.model,model=>typeof model==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(model))||
      !nullable(value.errorCode,code=>typeof code==='string'&&/^[A-Z0-9_]{1,64}$/.test(code))) throw Error('LEGACY_TASK_INVALID');
  return {...value};
}

export function parseLegacyHistory(value){
  if (!hasKeys(value,['version','source','capturedAt','tasks','duals','requestsCount','holdsCount']) ||
      value.version!==1||!['V0.6_SNAPSHOT','V0.7_SNAPSHOT'].includes(value.source)||!timestamp(value.capturedAt)||
      !Array.isArray(value.tasks)||value.tasks.length>2000||!Array.isArray(value.duals)||value.duals.length>500||
      !nullable(value.holdsCount,timestamp)||!nullable(value.requestsCount,timestamp)) throw Error('LEGACY_HISTORY_INVALID');
  const tasks=value.tasks.map(task).sort(latest);
  const byId=new Map(tasks.map(row=>[row.id,row]));
  if (byId.size!==tasks.length) throw Error('LEGACY_TASK_ID_DUPLICATE');
  const duals=value.duals.map(group=>{
    if (!hasKeys(group,['id','createdAt','parallel','ids'])||!identifier(group.id)||!timestamp(group.createdAt)||
        !['pending','unknown','observed','sequential'].includes(group.parallel)||!Array.isArray(group.ids)||
        group.ids.length!==2||new Set(group.ids).size!==2||group.ids.some(id=>!byId.has(id))) throw Error('LEGACY_DUAL_INVALID');
    return {id:group.id,createdAt:group.createdAt,parallel:group.parallel,lanes:group.ids.map(id=>byId.get(id))};
  }).sort(latest);
  if (new Set(duals.map(group=>group.id)).size!==duals.length) throw Error('LEGACY_DUAL_ID_DUPLICATE');
  return {...value,tasks,duals};
}
