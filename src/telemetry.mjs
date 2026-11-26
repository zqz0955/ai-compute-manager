import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pinPath} from '../tools/lock.mjs';
import {observedSources,publicNode} from './management-view.mjs';

const applicationId=0x41434d54;
export function openTelemetry(dataDir){
  const data=pinPath(dataDir,'directory');
  const file=join(data.path,'telemetry.sqlite');
  const suffixes=['','-wal','-shm','-journal'];
  const hadStore=existsSync(file);
  for(const suffix of suffixes){
    if (existsSync(file+suffix)) {
      if (!hadStore) throw Error('HISTORY_ORPHANED_SIDECAR');
      pinPath(file+suffix,'file');
    }
  }
  const db=new DatabaseSync(file);
  try {
    const identity=db.prepare('PRAGMA application_id').get().application_id;
    const version=db.prepare('PRAGMA user_version').get().user_version;
    if (!hadStore && identity===0 && version===0 && db.prepare('SELECT COUNT(*) AS count FROM sqlite_schema').get().count===0) {
      db.exec('BEGIN IMMEDIATE');
      db.exec('CREATE TABLE telemetry_samples(node TEXT NOT NULL, sampled INTEGER NOT NULL, observed INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(node,sampled)) STRICT');
      db.exec('PRAGMA application_id='+applicationId+'; PRAGMA user_version=1; COMMIT');
    } else if (identity!==applicationId || version!==1) throw Error('HISTORY_FORMAT_UNSUPPORTED');
    if (db.prepare('PRAGMA journal_mode=WAL').get().journal_mode!=='wal') throw Error('HISTORY_WAL_UNAVAILABLE');
    db.exec('PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF');
    db.exec('CREATE TABLE IF NOT EXISTS telemetry_heads(node TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0), sampled INTEGER NOT NULL) STRICT');
    const head=db.prepare('SELECT fingerprint,sequence,sampled FROM telemetry_heads WHERE node=?');
    const advance=db.prepare('INSERT INTO telemetry_heads VALUES (?,?,?,?) ON CONFLICT(node) DO UPDATE SET sequence=excluded.sequence,sampled=excluded.sampled');
    const put=db.prepare('INSERT OR IGNORE INTO telemetry_samples VALUES (?,?,?,?)');
    const all=db.prepare('SELECT * FROM telemetry_samples WHERE sampled>=? AND sampled<=? ORDER BY sampled DESC, node LIMIT ?');
    const forNode=db.prepare('SELECT * FROM telemetry_samples WHERE node=? AND sampled>=? AND sampled<=? ORDER BY sampled DESC LIMIT ?');
    const prune=db.prepare('DELETE FROM telemetry_samples WHERE (node,sampled) NOT IN (SELECT node,sampled FROM telemetry_samples ORDER BY sampled DESC LIMIT 20000)');
    function store(node,observedAt){
      const view=publicNode(node,observedAt);
      if ((view.source!=='SIMULATION'&&!observedSources.includes(view.source))||view.freshness!=='FRESH') return false;
      const {sampledAt,...metrics}=view.metrics;
      return put.run(view.id,sampledAt,observedAt,JSON.stringify({...metrics,ramBytes:view.ramBytes,swapBytes:view.swapBytes,
        diskBytes:view.diskBytes,source:view.source})).changes===1;
    }
    function transaction(write){
      db.exec('BEGIN IMMEDIATE');
      try{
        write();
        prune.run();
        db.exec('COMMIT');
      }catch(cause){
        db.exec('ROLLBACK');
        throw cause;
      }
    }
    function sequenceFloor(nodeId,fingerprint){
      const current=head.get(nodeId);
      if (current && current.fingerprint!==fingerprint)
        throw Object.assign(Error('Observation pin changed'),{code:'TELEMETRY_REJECTED',status:400});
      return current?.sequence??0;
    }
    function record(nodes,observedAt=Date.now()){
      transaction(()=>{for (const node of nodes) store(node,observedAt);});
    }
    function acceptObservation(node,observedAt,{fingerprint,sequence}){
      transaction(()=>{
        const current=head.get(node.id);
        if (sequence<=sequenceFloor(node.id,fingerprint) || current&&node.metrics.sampledAt<=current.sampled ||
            !store(node,observedAt))
          throw Object.assign(Error('Observation ordering rejected'),{code:'TELEMETRY_REJECTED',status:400});
        advance.run(node.id,fingerprint,sequence,node.metrics.sampledAt);
      });
    }
    function history({nodeId,from=0,to=Date.now(),limit=120}={}){
      const rows=nodeId?forNode.all(nodeId,from,to,limit):all.all(from,to,limit);
      return rows.reverse().map(row=>{
        const data=JSON.parse(row.data);
        const numeric=['cpuPercent','gpuPercent','gpuUsedBytes','ramUsedBytes','ramBytes','swapUsedBytes','swapBytes',
          'diskUsedBytes','diskBytes','temperatureC'];
        const safe=Object.fromEntries(numeric.map(key=>[key,Number.isFinite(data?.[key])?data[key]:null]));
        const source=['SIMULATION',...observedSources].includes(data?.source)?data.source:'UNKNOWN';
        return {...safe,source,nodeId:row.node,sampledAt:row.sampled,observedAt:row.observed};
      });
    }
    return {record,history,sequenceFloor,acceptObservation,close:()=>db.close()};
  } catch(cause){
    db.close();
    throw cause;
  }
}
