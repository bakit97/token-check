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
  constructor({dir, beforeMinutes = 2, afterMinutes = 2, fsync = true, maxRecords = 100000, maxJournalBytes = 64*1024*1024, clock = Date.now} = {}) {
    if (!dir) throw new TypeError('Нужна директория данных');
    this.dir = dir;
    this.maxRecords=maxRecords;this.maxJournalBytes=maxJournalBytes;this.capacityRejected=0;
    fs.mkdirSync(dir, {recursive:true});
    this.revokedPath=path.join(dir,'manual-pool-revocations-v1.json');this.revokedManual=new Map(fs.existsSync(this.revokedPath)?JSON.parse(fs.readFileSync(this.revokedPath,'utf8')).entries:[]);
    this.migrationRevokedPath=path.join(dir,'migration-revocations-v1.json');this.revokedMigrations=new Map(fs.existsSync(this.migrationRevokedPath)?JSON.parse(fs.readFileSync(this.migrationRevokedPath,'utf8')).entries:[]);
    this.graduationPath=path.join(dir,'graduation-receipts-v1.json');this.graduationReceipts=new Map(fs.existsSync(this.graduationPath)?JSON.parse(fs.readFileSync(this.graduationPath,'utf8')).entries:[]);
    this.logPath = path.join(dir, 'source-accepted-v1.jsonl');
    const settingsFile = path.join(dir, 'source-settings-v1.json');
    this.settingsPath = settingsFile;
    const saved = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile,'utf8')) : null;
    const settings=validateSettings(saved || {beforeMinutes, afterMinutes});
    this.fsync=fsync;
    this.clock=clock;
    this.dailyPath=path.join(dir,'source-daily-v1.json');
    this.dailyLogPath=path.join(dir,'source-daily-v1.jsonl');
    this.dailyStartedAt=clock();this.dailyDirty=false;this.dailySavedAt=0;
    this.dailyRows=new Map();this.dailyOverflow=false;
    if(fs.existsSync(this.dailyPath)){
      const saved=JSON.parse(fs.readFileSync(this.dailyPath,'utf8'));
      if(saved.schema!==1||!Array.isArray(saved.rows)||saved.rows.length>maxRecords*2)throw Error('Invalid source daily counters');
      this.dailyStartedAt=saved.startedAt;this.dailyOverflow=saved.overflow||false;
      this.dailyRows=new Map(saved.rows);
    }
    if(fs.existsSync(this.dailyLogPath)){
      if(fs.statSync(this.dailyLogPath).size>maxJournalBytes)throw Error('Daily source journal exceeds replay limit');
      const contents=fs.readFileSync(this.dailyLogPath,'utf8'),end=contents.lastIndexOf('\n')+1;
      for(const line of contents.slice(0,end).split('\n'))if(line){const [key,row]=JSON.parse(line);this.dailyRows.set(key,row);this.dailyStartedAt=Math.min(this.dailyStartedAt,row.startedAt)}
      fs.truncateSync(this.dailyLogPath,Buffer.byteLength(contents.slice(0,end)));this.dailyDirty=true;
    }
    this.gate = new AdmissionGate(settings);
    this.records = new Map();
    // A small rolling index avoids scanning the full lifetime ledger every
    // eight seconds while the foreground signal evaluator is active.
    this.recent = new Map();
    this.lastRecentTrim=0;
    this.stats={acceptedBefore:0,acceptedAfter:0,tooOldBefore:0,tooOldAfter:0,rejectedUnverified:0,rejectedBadTime:0,duplicate:0};
    if(fs.existsSync(this.logPath)) this._replay();
    // Recover admissions committed after the last counter checkpoint.
    for(const row of this.records.values())if(row.acceptedAt>=this.dailyStartedAt)
      this.observe({mint:row.mint,phase:row.phase,at:row.acceptedAt,outcome:'accepted'});
  }

  observe({mint,phase,at=this.clock(),outcome='unverified',lateMs=0,origin=null,reason=null,lateKind=null,eventAt=null}={}) {
    if(!['before','after'].includes(phase)||typeof mint!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)||!goodTime(at))return;
    const today=kzDay(this.clock()),date=kzDay(at);
    // Keep only today's and yesterday's detection identities, never lifetime sets.
    const yesterday=kzDay(this.clock()-86400000);
    if(date!==today&&date!==yesterday)return;
    if(this.dailyTrimDay!==today){
      for(const [key,row] of this.dailyRows)if(row.day!==today&&row.day!==yesterday){this.dailyRows.delete(key);this.dailyDirty=true}
      this.dailyTrimDay=today;
    }
    const key=date+':'+phase+':'+mint,old=this.dailyRows.get(key);
    if(old?.outcome==='accepted'||(old?.outcome==='tooOld'&&outcome!=='accepted'))return;
    if(outcome==='unverified'&&this.records?.has(mint))outcome='alreadyAdmitted';
    if(!old&&this.dailyRows.size>=this.maxRecords*2){this.dailyOverflow=date;this.dailyDirty=true;return}
    const row={day:date,phase,outcome,origin:origin||old?.origin||'legacy-unattributed',reason:reason||(outcome==='unverified'?old?.reason||'awaiting-proof':outcome),lateMs:outcome==='tooOld'?Math.max(0,lateMs):0,...(lateKind?{lateKind}:old?.lateKind?{lateKind:old.lateKind}:{}),...(goodTime(eventAt)?{eventAt}:{}),observedAt:old?.observedAt||at,startedAt:this.dailyStartedAt};
    if(old&&JSON.stringify(old)===JSON.stringify(row))return;
    const fd=fs.openSync(this.dailyLogPath,'a');
    try{
      if(fs.fstatSync(fd).size>this.maxJournalBytes)throw Error('Daily source journal at replay limit');
      fs.writeFileSync(fd,JSON.stringify([key,row])+'\n');if(this.fsync)fs.fsyncSync(fd);
    }finally{fs.closeSync(fd)}
    this.dailyRows.set(key,row);this.dailyDirty=true;
  }
  dailySummary(at=this.clock()) {
    const day=kzDay(at),empty=()=>({seen:0,accepted:0,tooOld:0,unverified:0,unverifiedByOrigin:{},unverifiedByReason:{},alreadyAdmitted:0,other:0,otherByReason:{},rejectedByReason:{},tooOldReal:0,tooOldNotNew:0,tooOldUnclassified:0,withoutReason:0,lateTotalMs:0,averageLateMs:null});
    const phases={before:empty(),after:empty()};
    for(const row of this.dailyRows.values())if(row.day===day){const p=phases[row.phase];p.seen++;if(row.outcome!=='accepted'){const why=row.reason||'legacy-unattributed';p.rejectedByReason[why]=(p.rejectedByReason[why]||0)+1;if(!row.reason)p.withoutReason++;}
      if(row.outcome==='accepted')p.accepted++;
      else if(row.outcome==='tooOld'){p.tooOld++;p.lateTotalMs+=row.lateMs;p[row.lateKind==='real'?'tooOldReal':row.lateKind==='not-new'?'tooOldNotNew':'tooOldUnclassified']++}
      else if(row.outcome==='unverified'){p.unverified++;const origin=row.origin||'legacy-unattributed',reason=row.reason||'legacy-unattributed';p.unverifiedByOrigin[origin]=(p.unverifiedByOrigin[origin]||0)+1;p.unverifiedByReason[reason]=(p.unverifiedByReason[reason]||0)+1;}
      else if(row.outcome==='alreadyAdmitted')p.alreadyAdmitted++;
      else {p.other++;const why=row.reason||row.outcome||'legacy-unattributed';p.otherByReason[why]=(p.otherByReason[why]||0)+1;}
    }
    for(const p of Object.values(phases)){p.averageLateMs=p.tooOld?p.lateTotalMs/p.tooOld:null;delete p.lateTotalMs}
    if(this.dailyDirty&&at-this.dailySavedAt>=60000){
      const tmp=this.dailyPath+'.tmp',fd=fs.openSync(tmp,'w');
      try{fs.writeFileSync(fd,JSON.stringify({schema:1,startedAt:this.dailyStartedAt,overflow:this.dailyOverflow,rows:[...this.dailyRows]}));if(this.fsync)fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
      fs.renameSync(tmp,this.dailyPath);fs.writeFileSync(this.dailyLogPath,'');this.dailyDirty=false;this.dailySavedAt=at;
    }
    return {schema:1,day,timezone:'UTC+5',startedAt:this.dailyStartedAt,partialDay:kzDay(this.dailyStartedAt)===day,complete:this.dailyOverflow!==day,...phases,pool:{...phases.before}};
  }

  async classifyLate(coins,{readCoin=()=>null,limit=256}={}) {
    let checked=0;const pending=[...this.dailyRows].filter(([,row])=>row.outcome==='tooOld'&&row.lateEvidenceVersion!==2),offset=this.lateAuditCursor||0;
    for(let i=0;i<Math.min(limit,pending.length);i++){const [key,row]=pending[(offset+i)%pending.length];const mint=key.split(':').at(-1);if(++checked>limit)break;const c=coins.get(mint)||readCoin(mint);if(checked%4===0)await new Promise(r=>setImmediate(r));if(!c){row.lateAuditReason='candidate-not-retained';row.reason='late-kind-not-retained';row.lateEvidenceVersion=2;delete row.lateKind;this.dailyDirty=true;continue;}
      const source=c.proofAgeEstimate?.source,real=!!(c.mg?.st==='ok'&&c.mg.sig&&c.graduation?.graduated)||row.origin==='verified-admission'||goodTime(row.eventAt)&&row.reason==='late-confirmed-migration'&&['fast-pump','fast-dbc','fast-ll','fast-launch'].includes(row.origin),notNew=!real&&(source==='gt-pool-created'||c.tSrc==='gt'||['manual','other'].includes(c.mg?.st));row.lateEvidenceVersion=2;row.lateEvidence={ageSource:source||null,pool:c.mg?.pool||c.p,signature:c.mg?.sig||null,verifiedGraduation:c.graduation?.graduated===true,signalSlot:c.migrationSlot||null,discoverySource:c.discoverySource||c.disc||null};
      if(!real&&!notNew){delete row.lateKind;row.reason='late-unverified-event';row.lateAuditReason='event-kind-not-proven';this.dailyDirty=true;continue;}this.dailyRows.set(key,{...row,lateKind:real?'real':'not-new',reason:real?'late-confirmed-migration':'old-catalogue-pool',origin:row.origin==='legacy-unattributed'?(real?'migration-signal':'catalogue'):row.origin});this.dailyDirty=true;
    }this.lateAuditCursor=pending.length?(offset+checked)%pending.length:0;
  }
  dailyDecisions(at=this.clock()){const day=kzDay(at);return [...this.dailyRows].filter(([,r])=>r.day===day&&r.outcome!=='accepted').map(([k,r])=>({mint:k.split(':').at(-1),...r}));}

  _replay() {
    if(fs.statSync(this.logPath).size>this.maxJournalBytes)throw Error('Source journal exceeds memory-safe replay limit; disk index required');
    const contents=fs.readFileSync(this.logPath, 'utf8');
    const completed=contents.lastIndexOf('\n');
    if(completed===-1 && contents.length) throw new Error('Повреждённый журнал: нет завершённых записей');
    const data=contents.slice(0,completed+1);
    for(const line of data.split('\n')) {
      if(!line)continue;
      if(this.records.size>=this.maxRecords)throw Error('Source journal exceeds memory-safe index capacity');
      const record=JSON.parse(line);if(record.phase==='before'&&this.revokedManual.has(record.mint)&&this.revokedManual.get(record.mint)?.pool===record.proof?.pool)continue;
      if(record.phase==='after'&&this.revokedMigrations.has(record.mint)&&this.revokedMigrations.get(record.mint)?.signature===record.proof?.signature)continue;
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

  removeLegacyBirths() {
    const removed=[...this.records.values()].filter(r=>r.phase==='before'&&r.proof?.kind!=='manual-pool-open-v1').map(r=>r.mint);
    if(!removed.length)return [];
    const ids=new Set(removed),tmp=this.logPath+'.transition-tmp',fd=fs.openSync(tmp,'w',0o600);
    try{for(const row of this.records.values())if(!ids.has(row.mint))fs.writeSync(fd,JSON.stringify(row)+'\n');if(this.fsync)fs.fsyncSync(fd);}finally{fs.closeSync(fd)}
    fs.renameSync(tmp,this.logPath);
    for(const mint of removed){this.records.delete(mint);this.recent.delete(mint);this.gate.accepted.delete(mint);}
    for(const [key,row] of this.dailyRows)if(row.phase==='before')this.dailyRows.delete(key);
    fs.writeFileSync(this.dailyPath,JSON.stringify({schema:1,startedAt:this.dailyStartedAt,overflow:this.dailyOverflow,rows:[...this.dailyRows]}));fs.writeFileSync(this.dailyLogPath,'');this.dailyDirty=false;
    this.stats.acceptedBefore=[...this.records.values()].filter(r=>r.phase==='before').length;this.stats.tooOldBefore=0;
    return removed;
  }

  revokeManualPool(mint,why,at=this.clock()){
    const row=this.records.get(mint);if(row?.phase!=='before'||row.proof?.kind!=='manual-pool-open-v1')return false;
    const next=new Map(this.revokedManual);next.set(mint,{pool:row.proof.pool,why,at,acceptedAt:row.acceptedAt});if(next.size>10000)throw Error('Manual revocation capacity reached');
    const temp=this.revokedPath+'.tmp',fd=fs.openSync(temp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify({schema:1,entries:[...next]}));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(temp,this.revokedPath);require('./durable-json').syncDirectory(this.dir);this.revokedManual=next;
    this.records.delete(mint);this.recent.delete(mint);this.gate.accepted.delete(mint);this.stats.acceptedBefore=Math.max(0,this.stats.acceptedBefore-1);
    const key=kzDay(row.acceptedAt)+':before:'+mint;this.dailyRows.delete(key);this.observe({mint,phase:'before',at:row.acceptedAt,outcome:'rejectedSidePool',origin:'manual-pool-audit',reason:why});return true;
  }

  _saveMigrationMap(file,map){const temp=file+'.tmp',fd=fs.openSync(temp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify({schema:1,entries:[...map]}));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(temp,file);require('./durable-json').syncDirectory(this.dir);}
  recordGraduation(mint,receipt){const row=this.records.get(mint);if(row?.phase!=='after'||!receipt?.known||receipt.graduated!==true)return false;const next=new Map(this.graduationReceipts);next.set(mint,{pool:row.proof.pool,signature:row.proof.signature,receipt});for(const [key,value] of next)if(this.clock()-value.receipt.at>48*3600000)next.delete(key);if(next.size>10000)throw Error('Graduation receipt index limit');this._saveMigrationMap(this.graduationPath,next);this.graduationReceipts=next;return true;}
  revokeMigration(mint,why,at=this.clock()){const row=this.records.get(mint);if(row?.phase!=='after')return false;const next=new Map(this.revokedMigrations);next.set(mint,{pool:row.proof?.pool,signature:row.proof?.signature,why,at,acceptedAt:row.acceptedAt});if(next.size>10000)throw Error('Migration revocation index limit');this._saveMigrationMap(this.migrationRevokedPath,next);this.revokedMigrations=next;this.records.delete(mint);this.recent.delete(mint);this.gate.accepted.delete(mint);this.stats.acceptedAfter=Math.max(0,this.stats.acceptedAfter-1);this.dailyRows.delete(kzDay(row.acceptedAt)+':after:'+mint);this.observe({mint,phase:'after',at:row.acceptedAt,outcome:'unverified',origin:'graduation-audit',reason:'rejectedNotGraduated'});return true;}
  graduationSummary(at=this.clock()){const day=kzDay(at),byLaunchpad={};let pendingRecheck=0;for(const row of this.records.values())if(row.phase==='after'&&kzDay(row.acceptedAt)===day){const stored=this.graduationReceipts.get(row.mint),receipt=row.proof?.graduation||(stored&&stored.signature===row.proof?.signature?stored.receipt:null);if(receipt?.graduated===true){const family=row.proof?.launchpad||row.proof?.family||'unknown';byLaunchpad[family]=(byLaunchpad[family]||0)+1;}else pendingRecheck++;}const rejectedNotGraduated=this.dailySummary(at).after.unverifiedByReason.rejectedNotGraduated||0;return {day,byLaunchpad,pendingRecheck,rejectedNotGraduated,revoked:this.revokedMigrations.size,proof:'official-migration-instruction-and-completed-curve'};}
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
    if(event.phase==='after'&&this.revokedMigrations.has(event.mint)&&this.revokedMigrations.get(event.mint)?.signature===proof?.signature)return {admitted:false,reason:'rejected-not-graduated'};
    if(event.phase==='before'&&this.revokedManual.has(event.mint))return {admitted:false,reason:'rejected-side-pool'};
    if(!this.has(event.mint)&&this.records.size>=this.maxRecords){this.capacityRejected++;return {admitted:false,reason:'resource-capacity'}}
    const decision=this.gate.offer(event, detectedAt);
    if(!decision.admitted){
      this.observe({mint:event.mint,phase:event.phase,outcome:decision.reason==='too-old'?'tooOld':decision.reason==='already-admitted'?'alreadyAdmitted':decision.reason==='not-verified'?'unverified':'other',lateMs:(decision.ageMs||0)-(decision.allowedMs||0),reason:decision.reason,origin:'verified-admission',lateKind:decision.reason==='too-old'?'real':null,eventAt:event.migrationAt||event.publicTradingAt});
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
    this.observe({mint:item.mint,phase:item.phase,outcome:'accepted'});
    this.recent.set(item.mint,item);
    if(item.acceptedAt-this.lastRecentTrim>30*60_000)this._trimRecent(item.acceptedAt);
    if(item.phase==='before')this.stats.acceptedBefore++;
    else this.stats.acceptedAfter++;
    this.onAdmitted?.(item);
    return {admitted:true,reason:'accepted',record:item};
  }

  /**
   * before-adapter обязан заранее ДОКАЗАТЬ:
   * tradingAt — момент появления в публичной покупке, а не создания mint.
   * observedAt — момент, когда НАШ сканер впервые заметил публичную торговлю.
   */
  before({mint,publicTradingAt,observedAt,verified=false,proof=null,caughtUpAfterDowntime=false}) {
    return this._admit({
      mint,phase:'before',publicTradingAt,
      publicTradingVerified:verified===true,caughtUpAfterDowntime:caughtUpAfterDowntime===true,manualPoolCatchupVerified:caughtUpAfterDowntime===true&&proof?.kind==='manual-pool-open-v1'&&!!proof.pool&&!!proof.signature
    },observedAt,proof);
  }

  /**
   * Используются только реальные on-chain миграции, подтверждённые
   * server/collector.js: инструкция программы + официальный пул + tx signature.
   * c.mg.seenAt — время подтверждения; в возрасте используем первое
   * ОБНАРУЖЕНИЕ события, если оно раньше проверки (но не раньше блока).
   */
  afterVerifiedMigration(c) {
    if(c?.a)this.observe({mint:c.a,phase:'after'});
    if(!c||!c.a||c.mg?.st!=='ok'||!c.mg.sig||!c.mg.pool||!goodTime(c.mg.mT)){
      return {admitted:false,reason:'not-verified'};
    }
    const seenAt=c.caughtUpAfterDowntime===true?this.clock():joinUniqueTimes(c,c.mg.mT);
    if(!seenAt)return {admitted:false,reason:'no-post-observation'};
    return this._admit({
      mint:c.a,phase:'after',migrationAt:c.mg.mT,migrationVerified:true,caughtUpAfterDowntime:c.caughtUpAfterDowntime===true
    },seenAt,{...require('./venue-identity').identity(c,'after',Date.now()),dexProgram:c.mg.owner||null,family:c.mg.k,signature:c.mg.sig,pool:c.mg.pool,caughtUpAfterDowntime:c.caughtUpAfterDowntime===true,catchupStartedAt:c.catchupStartedAt||null,creator:c.creatorAddress||null,creatorObservedAt:c.creatorObservedAt||null,graduation:c.graduation||null,curve:c.mg.watch||null,slot:c.migrationSlot||null,verifiedAt:c.admissionVerifiedAt||null,openingMetrics:c.openingMetrics||null});
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
  catchupSummary(at=this.clock()) {const starts=new Map(),byPhase={before:0,after:0};let total=0,today=0;for(const r of this.records.values())if(r.caughtUpAfterDowntime===true){total++;byPhase[r.phase]++;if(kzDay(r.acceptedAt)===kzDay(at))today++;const start=r.proof?.catchupStartedAt;if(goodTime(start))starts.set(start,(starts.get(start)||0)+1);}return {total,today,byPhase,starts:[...starts].sort((a,b)=>b[0]-a[0]).slice(0,16).map(([startedAt,accepted])=>({startedAt,accepted}))};}
  summary(at=Date.now()) {
    const d=kzDay(at),today=this.day(d),before=today.filter(x=>x.phase==='before').length;
    return {updated:at,catchup:this.catchupSummary(at),graduations:this.graduationSummary(at),day:d,total:this.records.size,
      today:today.length,todayBefore:before,todayAfter:today.length-before,
      capacity:{maxRecords:this.maxRecords,rejected:this.capacityRejected,full:this.records.size>=this.maxRecords},settings:this.settings(),stats:{...this.stats,acceptedPool:this.stats.acceptedBefore,tooOldPool:this.stats.tooOldBefore},daily:this.dailySummary(at)};
  }
}
module.exports={SourceRuntime};
