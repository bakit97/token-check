'use strict';

/**
 * SOL·СКАН — серверный главный источник.
 *
 * Входят ТОЛЬКО события с подтверждённым временем публичной торговли / миграции
 * и наблюдением в заданном возрастном окне. Монеты, не прошедшие оба окна,
 * НЕ попадают в исследования, на полигон или в «Прошли».
 *
 * Append-only journal обеспечивает защиту от дубликатов после рестарта.
 * Настройки применяются к будущим событиям (архив не переписывается).
 */
const fs = require('node:fs');
const path = require('node:path');
const {AdmissionGate, kzDay, validMinutes} = require('./admission');

function goodTime(t) { return Number.isSafeInteger(t) && t > 0; }
function validateSettings(cfg) {
  return {
    beforeMinutes: validMinutes(cfg.beforeMinutes),
    afterMinutes: validMinutes(cfg.afterMinutes)
  };
}
function joinUniqueTimes(c, minTime) {
  const ts = [
    c.firstPostSeenAt, c.wsSeen, c.rcSeen,
    c.seen, c.movedAt, c.mg && c.mg.seenAt
  ].filter(t => goodTime(t) && t >= minTime);
  return ts.length ? Math.min(...ts) : null;
}
class SourceRuntime {
  constructor({dir, beforeMinutes = 2, afterMinutes = 2, fsync = true, maxRecords = 100000, maxJournalBytes = 64*1024*1024} = {}) {
    if (!dir) throw new TypeError('Нужна директория данных');
    this.dir = dir;
    this.maxRecords=maxRecords;this.maxJournalBytes=maxJournalBytes;this.capacityRejected=0;
    fs.mkdirSync(dir, {recursive:true});
    this.logPath = path.join(dir, 'source-accepted-v1.jsonl');
    const settingsFile = path.join(dir, 'source-settings-v1.json');
    this.settingsPath = settingsFile;
    const saved = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile,'utf8')) : null;
    const settings=validateSettings(saved || {beforeMinutes, afterMinutes});
    this.fsync=fsync;
    this.gate = new AdmissionGate(settings);
    this.records = new Map();
    // A small rolling index avoids scanning the full lifetime ledger every
    // eight seconds while the foreground signal evaluator is active.
    this.recent = new Map();
    this.lastRecentTrim=0;
    this.stats={acceptedBefore:0,acceptedAfter:0,tooOldBefore:0,tooOldAfter:0,rejectedUnverified:0,rejectedBadTime:0,duplicate:0};
    if(fs.existsSync(this.logPath)) this._replay();
  }

  _replay() {
    if(fs.statSync(this.logPath).size>this.maxJournalBytes)throw Error('Source journal exceeds memory-safe replay limit; disk index required');
    const contents=fs.readFileSync(this.logPath, 'utf8');
    const completed=contents.lastIndexOf('\n');
    if(completed===-1 && contents.length) throw new Error('Повреждённый журнал: нет завершённых записей');
    const data=contents.slice(0,completed+1);
    for(const line of data.split('\n')) {
      if(!line)continue;
      if(this.records.size>=this.maxRecords)throw Error('Source journal exceeds memory-safe index capacity');
      const record=JSON.parse(line);
      if(record.v!==1)throw new Error('Неизвестная версия журнала источника');
      // Реплей защищён той же схемой валидации, но не запускает возрастной фильтр.
      const gate=new AdmissionGate({beforeMinutes:this.gate.beforeMinutes,
        afterMinutes:this.gate.afterMinutes,
        snapshot:{schema:1,coins:[{mint:record.mint,phase:record.phase,eventAt:record.eventAt,acceptedAt:record.acceptedAt}]}});
      if(this.records.has(record.mint))throw new Error('Дубликат mint в журнале источника');
      this.records.set(record.mint,Object.freeze({...record}));
      if(record.acceptedAt>=Date.now()-50*3600_000)this.recent.set(record.mint,this.records.get(record.mint));
      this.gate.accepted.set(record.mint,gate.get(record.mint));
      if(record.phase==='before')this.stats.acceptedBefore++;
      else this.stats.acceptedAfter++;
    }
    // После аварийного окончания неполная строка не становится принятым событием.
    // Убираем её, иначе будущая дописанная строка слилась бы с повреждённой.
    if(completed+1!==contents.length){
      fs.truncateSync(this.logPath, Buffer.byteLength(data,'utf8'));
    }
  }

  configure(options) {
    const next=validateSettings(options);
    const tmp=this.settingsPath+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(next));
    fs.renameSync(tmp,this.settingsPath);
    this.gate.configure(next);
    return next;
  }
  settings(){return {beforeMinutes:this.gate.beforeMinutes,afterMinutes:this.gate.afterMinutes};}
  has(mint){return this.gate.has(mint);}
  get(mint){return this.records.get(mint)||null;}

  _admit(event, detectedAt, proof) {
    if(!this.has(event.mint)&&this.records.size>=this.maxRecords){this.capacityRejected++;return {admitted:false,reason:'resource-capacity'}}
    const decision=this.gate.offer(event, detectedAt);
    if(!decision.admitted){
      if(decision.reason==='already-admitted')this.stats.duplicate++;
      else if(decision.reason==='too-old')this.stats[event.phase==='before'?'tooOldBefore':'tooOldAfter']++;
      else if(decision.reason==='not-verified')this.stats.rejectedUnverified++;
      else this.stats.rejectedBadTime++;
      return decision;
    }
    const item=Object.freeze({v:1,...decision.record,proof:proof||null});
    // Нельзя публиковать запись, пока она не зафиксирована на диске.
    try {
      const fd=fs.openSync(this.logPath,'a');
      try{
        const line=Buffer.from(JSON.stringify(item)+'\n');
        if(fs.fstatSync(fd).size+line.length>this.maxJournalBytes)throw Error('Source journal at memory-safe replay limit; admission paused');
        let written=0;
        while(written<line.length){
          written+=fs.writeSync(fd,line,written,line.length-written);
        }
        if(this.fsync)fs.fsyncSync(fd);
      }finally{fs.closeSync(fd);}
    }catch(e){
      this.gate.accepted.delete(item.mint);
      throw e;
    }
    this.records.set(item.mint,item);
    this.recent.set(item.mint,item);
    if(item.acceptedAt-this.lastRecentTrim>30*60_000)this._trimRecent(item.acceptedAt);
    if(item.phase==='before')this.stats.acceptedBefore++;
    else this.stats.acceptedAfter++;
    return {admitted:true,reason:'accepted',record:item};
  }

  /**
   * before-adapter обязан заранее ДОКАЗАТЬ:
   * tradingAt — момент появления в публичной покупке, а не создания mint.
   * observedAt — момент, когда НАШ сканер впервые заметил публичную торговлю.
   */
  before({mint,publicTradingAt,observedAt,verified=false,proof=null}) {
    return this._admit({
      mint,phase:'before',publicTradingAt,
      publicTradingVerified:verified===true
    },observedAt,proof);
  }

  /**
   * Используются только реальные on-chain миграции, подтверждённые
   * server/collector.js: инструкция программы + официальный пул + tx signature.
   * c.mg.seenAt — время подтверждения; в возрасте используем первое
   * ОБНАРУЖЕНИЕ события, если оно раньше проверки (но не раньше блока).
   */
  afterVerifiedMigration(c) {
    if(!c||!c.a||c.mg?.st!=='ok'||!c.mg.sig||!c.mg.pool||!goodTime(c.mg.mT)){
      return {admitted:false,reason:'not-verified'};
    }
    const seenAt=joinUniqueTimes(c,c.mg.mT);
    if(!seenAt)return {admitted:false,reason:'no-post-observation'};
    return this._admit({
      mint:c.a,phase:'after',migrationAt:c.mg.mT,migrationVerified:true
    },seenAt,{family:c.mg.k,signature:c.mg.sig,pool:c.mg.pool});
  }

  day(date) {
    return [...this.records.values()].filter(c=>kzDay(c.acceptedAt)===date).sort((a,b)=>a.acceptedAt-b.acceptedAt);
  }
  _trimRecent(at=Date.now()){
    this.lastRecentTrim=at;
    const cutoff=at-50*3600_000;
    for(const [mint,row] of this.recent)
      if(row.acceptedAt<cutoff)this.recent.delete(mint);
  }
  recentAdmissions(since=Date.now()-30*60_000,at=Date.now()){
    if(!Number.isSafeInteger(since)||!Number.isSafeInteger(at)||since>at)
      throw new RangeError('Invalid recent-admission range');
    if(at-this.lastRecentTrim>30*60_000)this._trimRecent(at);
    // Rolling source index is limited to 50h: reject wider requests instead
    // of presenting an incomplete scan as a complete research result.
    if(since<at-49*3600_000)throw new RangeError('Recent-admission request exceeds retention');
    return [...this.recent.values()].filter(row=>row.acceptedAt>=since&&row.acceptedAt<=at);
  }
  latest(n=100) {
    return [...this.records.values()].slice(-n).reverse();
  }
  path({phase,predicate=()=>true,at=Date.now()}={}) {
    if(typeof predicate!=='function')throw new TypeError('Нужен фильтр пути');
    return this.gate.selectPath(c=>(!at||c.acceptedAt<=at)&&predicate(c),{phase});
  }
  summary(at=Date.now()) {
    const d=kzDay(at),today=this.day(d),before=today.filter(x=>x.phase==='before').length;
    return {updated:at,day:d,total:this.records.size,
      today:today.length,todayBefore:before,todayAfter:today.length-before,
      capacity:{maxRecords:this.maxRecords,rejected:this.capacityRejected,full:this.records.size>=this.maxRecords},settings:this.settings(),stats:{...this.stats}};
  }
}
module.exports={SourceRuntime};
