'use strict';
// SOL·СКАН server research, observational only. No trading or external actions.
// The stable ledger is authoritative. Unknown coverage is never relabeled 'dead'.
const fs = require('node:fs');
const path = require('node:path');
const {
  featuresAt, activityOutcome, capBank
} = require('./research-v2');

const MIN=60_000;
const HOURS=3_600_000;
const MAX_BANK_PER_CLASS=5000;
const FRESH_WINDOW=48*HOURS;
const RETRY_INCOMPLETE_MS=15*MIN;
const MAX_CLASSIFICATION_CHECKS=250; // per two-minute collector export

function settings(cfg={}) {
  const result={
    hours:cfg.hours??5,
    decisionMinutes:cfg.decisionMinutes??10,
    minActive:cfg.minActive??70,
    maxIdle:cfg.maxIdle??60,
    minCoverage:cfg.minCoverage??.8
  };
  if(!Number.isInteger(result.hours)||result.hours<1||result.hours>24 ||
     !Number.isInteger(result.decisionMinutes)||result.decisionMinutes<1||result.decisionMinutes>30 ||
     !Number.isFinite(result.minActive)||result.minActive<0||result.minActive>100 ||
     !Number.isInteger(result.maxIdle)||result.maxIdle<5||result.maxIdle>1440||
     !Number.isFinite(result.minCoverage)||result.minCoverage<.5||result.minCoverage>1) {
    throw new RangeError('Invalid first-level observation settings');
  }
  return result;
}
function atomicJSON(filepath,obj) {
  const temporary=filepath+'.tmp';
  const handle=fs.openSync(temporary,'w',0o600);
  try {
    const bytes=Buffer.from(JSON.stringify(obj));
    let offset=0;
    while(offset<bytes.length)offset+=fs.writeSync(handle,bytes,offset,bytes.length-offset);
    fs.fsyncSync(handle);
  }finally{fs.closeSync(handle)}
  fs.renameSync(temporary,filepath);
  // fsync the directory so rename is durable after a VM crash.
  const dir=fs.openSync(path.dirname(filepath),'r');
  try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}
}
function classOf(row,cfg) {
  return row.activePct>=cfg.minActive && row.maxIdleObserved<=cfg.maxIdle ? 'live':'dead';
}

class ResearchRuntime {
  constructor({dir,config={}}={}) {
    if(!dir)throw new TypeError('Research directory is required');
    this.dir=dir;
    this.file=path.join(dir,'research-v2-bank.json');
    fs.mkdirSync(dir,{recursive:true});
    this.config=settings(config);
    this.rows=[];
    this.lookup=new Set();
    this.processed=new Map();
    this.lastAttemptAt=new Map();
    this.lastAt=null;
    this.pending={};
    if(fs.existsSync(this.file)){
      const state=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(state.schema!==1||!Array.isArray(state.rows))throw Error('Unknown stored research format');
      for(const r of state.rows){
        if(typeof r.mint!=='string'||!Number.isSafeInteger(r.acceptedAt)||
           !Number.isFinite(r.activePct)||!Number.isFinite(r.maxIdleObserved)||
           !r.features||typeof r.features!=='object')
          throw Error('Malformed saved research sample');
      }
      this.rows=capBank(state.rows,r=>classOf(r,this.config),'live','dead',MAX_BANK_PER_CLASS);
      this.lookup=new Set(this.rows.map(r=>r.mint));
      for(const pair of state.processed||[]) {
        if(Array.isArray(pair)&&typeof pair[0]==='string'&&Number.isSafeInteger(pair[1]))
          this.processed.set(pair[0],pair[1]);
      }
      // Compatible with older snapshots that did not store the processed index.
      for(const r of this.rows)this.processed.set(r.mint,r.acceptedAt);
    }
  }
  update({source,coins,now=Date.now()}={}) {
    if(!source?.records || !coins?.get)throw new TypeError('Need source ledger and coin map');
    let added=0,considered=0,attempted=0;
    const pending={},byPhase={before:{live:0,dead:0},after:{live:0,dead:0}};
    // Newest first, avoid scanning the entire multi-month ledger.
    for(const row of source.records.values()){
      const age=now-row.acceptedAt;
      if(age<0||age>FRESH_WINDOW||this.processed.has(row.mint))continue;
      considered++;
      if(age<this.config.hours*HOURS+3*MIN){
        pending['not-yet-finished']=(pending['not-yet-finished']||0)+1;
        continue;
      }
      if(this.lastAttemptAt.has(row.mint) &&
         now-this.lastAttemptAt.get(row.mint)<RETRY_INCOMPLETE_MS){
        pending['retry-later']=(pending['retry-later']||0)+1;
        continue;
      }
      if(attempted>=MAX_CLASSIFICATION_CHECKS){
        pending['deferred-by-batch']=(pending['deferred-by-batch']||0)+1;
        continue;
      }
      attempted++;
      const coin=coins.get(row.mint);
      if(!coin){
        this.lastAttemptAt.set(row.mint,now);
        pending['candidate-missing']=(pending['candidate-missing']||0)+1;
        continue;
      }
      const decisionAt=row.acceptedAt+this.config.decisionMinutes*MIN;
      const result=activityOutcome(coin,row.acceptedAt,this.config,now);
      if(result.label==='pending'){
        this.lastAttemptAt.set(row.mint,now);
        pending[result.why]=(pending[result.why]||0)+1;
        continue;
      }
      this.lastAttemptAt.delete(row.mint);
      const features=featuresAt(coin,decisionAt);
      this.rows.push({
        mint:row.mint,phase:row.phase,
        acceptedAt:row.acceptedAt,decisionAt,
        hours:this.config.hours,
        activePct:result.activePct,
        maxIdleObserved:result.maxIdleObserved,
        coverage:result.coverage,
        features,
        time:row.acceptedAt // rolling bank ordered by admission, not reprocessing time
      });
      this.lookup.add(row.mint);
      this.processed.set(row.mint,row.acceptedAt);
      added++;
    }
    for(const [mint,acceptedAt] of this.processed){
      if(now-acceptedAt>FRESH_WINDOW)this.processed.delete(mint);
    }
    // Restrict the retry index to admitted mints that still exist in
    // the source's bounded research observation window.
    const fresh=new Set();
    for(const row of source.records.values())
      if(now-row.acceptedAt<=FRESH_WINDOW)fresh.add(row.mint);
    for(const mint of this.lastAttemptAt.keys())
      if(!fresh.has(mint))this.lastAttemptAt.delete(mint);
    if(added){
      this.rows=capBank(this.rows,r=>classOf(r,this.config),'live','dead',MAX_BANK_PER_CLASS);
      this.lookup=new Set(this.rows.map(r=>r.mint));
      atomicJSON(this.file,{schema:1,rows:this.rows,
        processed:[...this.processed],savedAt:now});
    }
    for(const row of this.rows){
      const name=classOf(row,this.config);
      if(byPhase[row.phase])byPhase[row.phase][name]++;
    }
    this.pending=pending;
    this.lastAt=now;
    return {added,considered,attempted,
      maxChecksPerRun:MAX_CLASSIFICATION_CHECKS,...this.summary()};
  }
  summary(){
    const counts={live:0,dead:0,preLive:0,preDead:0,postLive:0,postDead:0};
    for(const row of this.rows){
      const label=classOf(row,this.config);
      counts[label]++;
      counts[row.phase==='before'?(label==='live'?'preLive':'preDead'):(label==='live'?'postLive':'postDead')]++;
    }
    return {schema:1,updated:this.lastAt,
      settings:{...this.config},counts,pending:{...this.pending},
      bankCapacityPerClass:MAX_BANK_PER_CLASS,
      status:'observational',
      secondLevel:'waiting-for-server-verified-passed-stream'};
  }
  select({phase,label,limit=100}={}) {
    if(phase&&!['before','after'].includes(phase))throw TypeError('bad phase');
    if(label&&!['live','dead'].includes(label))throw TypeError('bad label');
    if(!Number.isInteger(limit)||limit<1||limit>10000)throw RangeError('bad limit');
    return this.rows.filter(r=>(!phase||r.phase===phase) && (!label||classOf(r,this.config)===label))
      .sort((a,b)=>b.acceptedAt-a.acceptedAt).slice(0,limit)
      .map(r=>({...r,label:classOf(r,this.config)}));
  }
}
module.exports={ResearchRuntime,settings,classOf};
