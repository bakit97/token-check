'use strict';
// SOL·СКАН server research, observational only. No trading or external actions.
// The stable ledger is authoritative. Unknown coverage is never relabeled 'dead'.
const fs = require('node:fs');
const path = require('node:path');
const {
  featuresAt, activityOutcome, capBank, candles
} = require('./research-v2');

const MIN=60_000;
const HOURS=3_600_000;
const MAX_BANK_PER_CLASS=5000;
const FRESH_WINDOW=48*HOURS;
const RETRY_INCOMPLETE_MS=15*MIN;
const MAX_CLASSIFICATION_CHECKS=250; // per two-minute collector export

/* Вход в Исследование 1: два пути, каждый можно включить/выключить.
   manual — ручной входной фильтр (поток, покупатели за 10 мин, SOL в пуле, случайная доля) — каждый параметр со своим переключателем;
   modules — монеты, прошедшие модули окна возможностей («Прошли»).
   Нет конфигурации intake → прежнее поведение (все монеты «Все»). */
function intakeSettings(x){
  if(x==null)return null;
  const num=(v,lo,hi)=>Number.isFinite(+v)&&+v>=lo&&+v<=hi?+v:null;
  const m=x.manual||{},on=v=>v===true;
  const out={manual:{enabled:on(m.enabled),phase:['before','after','both'].includes(m.phase)?m.phase:'both',
      buyers10:{on:on(m.buyers10?.on),min:num(m.buyers10?.min,0,10000)??3},
      quoteSol:{on:on(m.quoteSol?.on),min:num(m.quoteSol?.min,0,100000)??0.5},
      sample:{on:on(m.sample?.on),pct:num(m.sample?.pct,1,100)??100}},
    modules:{enabled:on(x.modules?.enabled)}};
  return out}
function sampled(mint,pct){if(pct>=100)return true;let h=2166136261;for(const ch of mint){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)>>>0}return (h%10000)/100<pct}
// Решение о входе; null-признак при включённом параметре = монета не входит (причина «нет данных»).
function intakeDecision(intake,row,features,passes){
  if(!intake)return {ok:true,via:'all'};
  const via=[];
  const m=intake.manual;
  if(m.enabled){let ok=true,why=null;
    if(m.phase!=='both'&&row.phase!==m.phase){ok=false;why='phase'}
    if(ok&&m.buyers10.on){const v=features?.buyers10;if(v==null){ok=false;why='no-buyers10'}else if(v<m.buyers10.min){ok=false;why='buyers10'}}
    if(ok&&m.quoteSol.on){const v=features?.quoteSol;if(v==null){ok=false;why='no-quoteSol'}else if(v<m.quoteSol.min){ok=false;why='quoteSol'}}
    if(ok&&m.sample.on&&!sampled(row.mint,m.sample.pct)){ok=false;why='sample'}
    if(ok)via.push('manual');else if(!intake.modules.enabled)return {ok:false,why};
  }
  if(intake.modules.enabled){const rec=passes?.records?.get?.(row.mint);
    if(rec){const all=passes.config?.r1?.[row.phase]===true,ids=new Set((passes.config?.modules||[]).filter(x=>x.toR1&&x.level==='1'&&x.phase===row.phase).map(x=>x.filterId));
      if(all||(rec.matches||[]).some(x=>ids.has(x.id)))via.push('modules')}}
  return via.length?{ok:true,via:via.join('+')}:{ok:false,why:m.enabled?'not-matched':'modules-only-not-passed'};
}
function settings(cfg={}) {
  const result={
    hours:cfg.hours??5,
    decisionMinutes:cfg.decisionMinutes??10,
    minActive:cfg.minActive??70,
    maxIdle:cfg.maxIdle??60,
    minCoverage:cfg.minCoverage??.8,
    targetLive:cfg.targetLive??100,targetDead:cfg.targetDead??40,
    ...(cfg.intake!=null?{intake:intakeSettings(cfg.intake)}:{})
  };
  if(!Number.isInteger(result.hours)||result.hours<1||result.hours>12 ||
     !Number.isInteger(result.decisionMinutes)||result.decisionMinutes<2||result.decisionMinutes>15 ||
     !Number.isFinite(result.minActive)||result.minActive<0||result.minActive>100 ||
     !Number.isInteger(result.maxIdle)||result.maxIdle<5||result.maxIdle>1440||
     !Number.isFinite(result.minCoverage)||result.minCoverage<.5||result.minCoverage>1) {
    throw new RangeError('Invalid first-level observation settings');
  }
  for(const key of ['targetLive','targetDead'])if(!Number.isInteger(result[key])||result[key]<10||result[key]>5000)throw RangeError('Invalid research target');
  if(cfg.phases){result.phases={};for(const phase of ['before','after'])result.phases[phase]=settings({...result,...cfg.phases[phase],phases:null})}
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
  require('./durable-json').syncDirectory(path.dirname(filepath));
}
function phaseSettings(cfg,phase){return cfg.phases?.[phase]||cfg}
function classOf(row,cfg) {
  cfg=phaseSettings(cfg,row.phase);return row.activePct>=cfg.minActive && row.maxIdleObserved<=cfg.maxIdle ? 'live':'dead';
}

class ResearchRuntime {
  constructor({dir,config={},bankName='research-v2-bank.json',cohortStart=0,cohortEnd=Infinity}={}) {
    if(!dir)throw new TypeError('Research directory is required');
    this.dir=dir;
    this.file=path.join(dir,bankName);
    this.cohortStart=cohortStart;this.cohortEnd=cohortEnd;
    fs.mkdirSync(dir,{recursive:true});
    this.config=settings(config);this.intakeRejected={};this.intakeAccepted={};
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
      this.rows=capPhases(state.rows,this.config);
      this.lookup=new Set(this.rows.map(r=>r.mint));
      for(const pair of state.processed||[]) {
        if(Array.isArray(pair)&&typeof pair[0]==='string'&&Number.isSafeInteger(pair[1]))
          this.processed.set(pair[0],pair[1]);
      }
      // Compatible with older snapshots that did not store the processed index.
      for(const r of this.rows)this.processed.set(r.mint,r.acceptedAt);
    }
  }
  update({source,coins,passes=null,now=Date.now()}={}) {
    if(!source?.records || !coins?.get)throw new TypeError('Need source ledger and coin map');
    let added=0,considered=0,attempted=0;
    const pending={},byPhase={before:{live:0,dead:0},after:{live:0,dead:0}};
    // Newest first, avoid scanning the entire multi-month ledger.
    const recent=typeof source.recentAdmissions==='function'?
      source.recentAdmissions(now-FRESH_WINDOW,now):source.records.values();
    for(const row of recent){
      const age=now-row.acceptedAt;
      if(row.acceptedAt<this.cohortStart||row.acceptedAt>=this.cohortEnd||age<0||age>FRESH_WINDOW||this.processed.has(row.mint))continue;
      considered++;
      const cfg=phaseSettings(this.config,row.phase);
      if(age<cfg.hours*HOURS+3*MIN){
        pending['not-yet-finished']=(pending['not-yet-finished']||0)+1;
        continue;
      }
      const previous=this.lastAttemptAt.get(row.mint);
      if(previous&&now-previous.at<RETRY_INCOMPLETE_MS){
        pending[previous.why]=(pending[previous.why]||0)+1;
        continue;
      }
      if(attempted>=MAX_CLASSIFICATION_CHECKS){
        pending['deferred-by-batch']=(pending['deferred-by-batch']||0)+1;
        continue;
      }
      attempted++;
      const coin=coins.get(row.mint);
      if(!coin){
        this.lastAttemptAt.set(row.mint,{at:now,acceptedAt:row.acceptedAt,why:'candidate-missing'});
        pending['candidate-missing']=(pending['candidate-missing']||0)+1;
        continue;
      }
      const decisionAt=row.acceptedAt+cfg.decisionMinutes*MIN;
      const result=activityOutcome(coin,row.acceptedAt,cfg,now);
      if(result.label==='pending'){
        this.lastAttemptAt.set(row.mint,{at:now,acceptedAt:row.acceptedAt,why:result.why});
        pending[result.why]=(pending[result.why]||0)+1;
        continue;
      }
      this.lastAttemptAt.delete(row.mint);
      const features=featuresAt(coin,decisionAt,{eventAt:row.acceptedAt,phase:row.phase});
      const gate=intakeDecision(cfg.intake,row,features,passes);
      if(!gate.ok){this.processed.set(row.mint,row.acceptedAt);this.intakeRejected[gate.why]=(this.intakeRejected[gate.why]||0)+1;continue}
      this.intakeAccepted[gate.via]=(this.intakeAccepted[gate.via]||0)+1;
      this.rows.push({via:gate.via,
        mint:row.mint,phase:row.phase,featureAnchor:'acceptedAt',featureTimesPacked:require('./module-library').freezeFeatureTimes(coin,row.acceptedAt,'1',row.phase),curve:observationCurve(coin,row.acceptedAt,cfg.hours),curveUnit:'price-usd',
        acceptedAt:row.acceptedAt,decisionAt,
        hours:cfg.hours,label:result.label,
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
    for(const [mint,retry] of this.lastAttemptAt)
      if(now-retry.acceptedAt>FRESH_WINDOW)this.lastAttemptAt.delete(mint);
    if(added){
      this.rows=capPhases(this.rows,this.config);
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
      maxChecksPerRun:MAX_CLASSIFICATION_CHECKS,intake:this.config.intake,intakeAccepted:this.intakeAccepted,intakeRejected:this.intakeRejected,...this.summary()};
  }
  summary(){
    const counts={live:0,dead:0,preLive:0,preDead:0,postLive:0,postDead:0};
    for(const row of this.rows){
      const label=classOf(row,this.config);
      counts[label]++;
      counts[row.phase==='before'?(label==='live'?'preLive':'preDead'):(label==='live'?'postLive':'postDead')]++;
    }
    return {schema:1,updated:this.lastAt,cohortStart:this.cohortStart,
      settings:{...this.config},counts,pending:{...this.pending},
      bankCapacityPerClass:MAX_BANK_PER_CLASS,
      status:'observational',
      secondLevel:'separate-server-verified-pass-stream'};
  }
  select({phase,label,limit=100}={}) {
    if(phase&&!['before','after'].includes(phase))throw TypeError('bad phase');
    if(label&&!['live','dead'].includes(label))throw TypeError('bad label');
    if(!Number.isInteger(limit)||limit<1||limit>20000)throw RangeError('bad limit');
    return this.rows.filter(r=>(!phase||r.phase===phase) && (!label||classOf(r,this.config)===label))
      .sort((a,b)=>b.acceptedAt-a.acceptedAt).slice(0,limit)
      .map(r=>({...r,label:classOf(r,this.config)}));
  }
}
function observationCurve(coin,at,hours){const points=candles(coin);let j=-1;const curve=[];for(let m=0;m<=hours*60;m+=5){const t=at+m*MIN;while(j+1<points.length&&points[j+1][0]<=t)j++;curve.push([m,j>=0&&t-points[j][0]<=7*MIN?points[j][1]:null])}return curve}
function capPhases(rows,cfg){return ['before','after'].flatMap(phase=>capBank(rows.filter(r=>r.phase===phase),r=>classOf(r,cfg),'live','dead',MAX_BANK_PER_CLASS)).sort((a,b)=>a.time-b.time)}
module.exports={phaseSettings,intakeDecision,intakeSettings,ResearchRuntime,settings,classOf};
