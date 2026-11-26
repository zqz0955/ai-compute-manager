import { DatabaseSync } from 'node:sqlite';

export const finished = state => ['SUCCEEDED','FAILED','CANCELLED','INTERRUPTED'].includes(state);

export class TaskStore {
  constructor(path,{recover=true,durable=false}={}) {
    this.db = new DatabaseSync(path);
    try {
      // 同一資料目錄僅允許一個控制程序。第二個實例不能將仍在執行的工作誤標為中斷。
      this.db.exec(`
        PRAGMA locking_mode=EXCLUSIVE;
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS job_state ON jobs(json_extract(data,'$.state'));
        CREATE TABLE IF NOT EXISTS duals(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, signature TEXT NOT NULL, result TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS holds(resource TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operation_records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
        CREATE TABLE IF NOT EXISTS operation_events(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL);
      `);
      if (!durable && this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='v08_schema'").get())
        throw Error('V0.8 工作庫必須使用耐久保護復原');
      if (recover && !durable) this.transaction(()=>{
        for (const task of this.active().filter(t=>t.state!=='QUEUED')) {
          if (task.sentAt) this.hold(task);
          this.save({...task,state:'INTERRUPTED',error:'控制程序重新啟動；須核對節點上的實際結果',finishedAt:Date.now()});
        }
      });
    } catch (err) { this.db.close(); throw err; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {const value=fn();this.db.exec('COMMIT');return value;}
    catch (err) {
      if(this.db.isTransaction)try{this.db.exec('ROLLBACK');}catch { /* 保留原儲存錯誤，派送器停止。 */ }
      throw err;
    }
  }
  insert(t) {this.db.prepare('INSERT INTO jobs VALUES (?,?)').run(t.id,JSON.stringify(t));}
  save(t) {this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(t),t.id);}
  get(id) {const row=this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id);return row && JSON.parse(row.data);}
  active() {
    return this.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.state') IN ('QUEUED','RUNNING','STOPPING') ORDER BY rowid").all().map(r=>JSON.parse(r.data));
  }
  recent(before=Number.MAX_SAFE_INTEGER,kind=null) {
    return this.db.prepare("SELECT rowid AS cursor,data FROM jobs WHERE rowid<? AND (? IS NULL OR json_extract(data,'$.kind')=?) ORDER BY rowid DESC LIMIT 50").all(before,kind,kind)
      .map(r=>({...JSON.parse(r.data),cursor:r.cursor}));
  }
  taskPage({before=Number.MAX_SAFE_INTEGER,nodeId=null,state=null,kind=null,watch=[]}={}) {
    if(!Array.isArray(watch)||watch.length>64||watch.some(id=>typeof id!=='string'||!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id)))throw new TypeError('工作更新識別碼無效');
    const rows=this.db.prepare(`SELECT rowid AS cursor,data FROM jobs WHERE rowid<?
      AND (? IS NULL OR json_extract(data,'$.nodeId')=?) AND (? IS NULL OR json_extract(data,'$.state')=?)
      AND (? IS NULL OR json_extract(data,'$.kind')=?) ORDER BY rowid DESC LIMIT 50`)
      .all(before,nodeId,nodeId,state,state,kind,kind).map(r=>({...JSON.parse(r.data),cursor:r.cursor}));
    const counts=this.db.prepare("SELECT json_extract(data,'$.state') AS state,count(*) AS count FROM jobs GROUP BY state").all();
    const updates=watch.length?this.db.prepare('SELECT rowid AS cursor,data FROM jobs WHERE id IN ('+watch.map(()=>'?').join(',')+')').all(...watch).map(r=>({...JSON.parse(r.data),cursor:r.cursor})):[];
    return {tasks:rows,updates,counts:Object.fromEntries(counts.map(r=>[r.state,r.count])),nextBefore:rows.length===50?rows.at(-1).cursor:null};
  }
  request(id) {return this.db.prepare('SELECT signature,result FROM requests WHERE id=?').get(id);}
  remember(id,signature,result) {this.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(id,signature,result);}
  insertDual(group) {this.db.prepare('INSERT INTO duals VALUES (?,?)').run(group.id,JSON.stringify(group));}
  dual(id) {
    const raw=this.db.prepare('SELECT data FROM duals WHERE id=?').get(id);
    if (!raw) return null;
    const g=JSON.parse(raw.data);
    const lanes=g.ids.map(id=>this.get(id));
    // 用收到上游輸出至末筆輸出的交集。只有派送／等待時段重疊，不能宣告兩邊同時推論。
    const overlap=lanes.every(t=>t.firstOutputAt && t.lastOutputAt) &&
      Math.max(...lanes.map(t=>t.firstOutputAt)) < Math.min(...lanes.map(t=>t.lastOutputAt));
    let parallel='pending';
    if (overlap && lanes[0].resource!==lanes[1].resource) parallel='observed';
    else if (lanes.every(t=>finished(t.state))) {
      const [a,b]=lanes;
      const serialized=a.sentAt && b.sentAt && ((a.upstreamEndAt && a.upstreamEndAt<=b.sentAt) ||
        (b.upstreamEndAt && b.upstreamEndAt<=a.sentAt));
      parallel=serialized?'sequential':'unknown';
    }
    return {id:g.id,prompt:g.prompt,createdAt:g.createdAt,lanes,parallel};
  }
  duals(before=Number.MAX_SAFE_INTEGER) {
    return this.db.prepare('SELECT rowid AS cursor,id FROM duals WHERE rowid<? ORDER BY rowid DESC LIMIT 50').all(before)
      .map(r=>({...this.dual(r.id),cursor:r.cursor}));
  }
  hold(task) {
    const data={taskId:task.id,nodeId:task.nodeId,kind:task.kind,model:task.model,digest:task.digest,targetKey:task.targetKey,
      resource:task.resource,hostKey:task.hostKey,until:Math.max(Date.now()+65000,(task.deadlineAt || 0)+15000)};
    this.db.prepare('INSERT OR REPLACE INTO holds VALUES (?,?)').run(data.resource,JSON.stringify(data));
  }
  holds() {return this.db.prepare('SELECT data FROM holds').all().map(r=>JSON.parse(r.data));}
  release(resource) {this.db.prepare('DELETE FROM holds WHERE resource=?').run(resource);}
  operationKind(kind) {
    if (!['power','benchmark'].includes(kind)) throw new TypeError('未知的操作紀錄類別');
  }
  getRecord(kind,id) {
    this.operationKind(kind);
    const row=this.db.prepare('SELECT data FROM operation_records WHERE kind=? AND id=?').get(kind,id);
    return row ? JSON.parse(row.data) : null;
  }
  putRecord(kind,record) {
    this.operationKind(kind);
    if (!record || typeof record.id!=='string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(record.id)) throw new TypeError('操作紀錄須有 UUID');
    const data=JSON.stringify(record);
    if (Buffer.byteLength(data)>524288) throw new RangeError('操作紀錄過大');
    const old=this.db.prepare('SELECT length(CAST(data AS BLOB)) AS bytes FROM operation_records WHERE kind=? AND id=?').get(kind,record.id);
    const totals=this.db.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM operation_records').get();
    // 達上限時拒絕新操作；不能為騰出空間而刪除不明工作或關機稽核。
    if ((!old && totals.count>=1000) || totals.bytes-(old?.bytes||0)+Buffer.byteLength(data)>32*1024**2) throw new RangeError('操作紀錄容量已滿，請先封存並由管理員處理');
    this.db.prepare('INSERT OR REPLACE INTO operation_records VALUES (?,?,?)').run(kind,record.id,data);
    return record;
  }
  records(kind) {
    this.operationKind(kind);
    return this.db.prepare('SELECT data FROM operation_records WHERE kind=? ORDER BY rowid DESC').all(kind).map(r=>JSON.parse(r.data));
  }
  appendEvent(kind,id,event) {
    this.operationKind(kind);
    const data=JSON.stringify(event);
    const totals=this.db.prepare('SELECT count(*) AS count,coalesce(sum(length(CAST(data AS BLOB))),0) AS bytes FROM operation_events').get();
    if (Buffer.byteLength(data)>8192 || totals.count>=20000 || totals.bytes+Buffer.byteLength(data)>16*1024**2) throw new RangeError('操作稽核容量已滿，拒絕新的副作用');
    this.db.prepare('INSERT INTO operation_events VALUES (?,?,?)').run(kind,id,data);
  }
  events(kind,id) {
    this.operationKind(kind);
    return this.db.prepare('SELECT data FROM operation_events WHERE kind=? AND id=? ORDER BY rowid').all(kind,id).map(r=>JSON.parse(r.data));
  }
  close() {this.db.close();}
}
