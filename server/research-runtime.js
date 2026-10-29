'use strict';
const {eventAnchor}=require('./event-clock');
// SOL·СКАН server research, observational only. No trading or external actions.
// The stable ledger is authoritative. Unknown coverage is never relabeled 'dead'.
const fs = require('node:fs');
const path = require('node:path');
const {
  featuresAt, verifiedFeatures, activityOutcome, activityEvidence, classifyActivity, capBank, candles
} = require('./research-v2');

const MIN=60_000;
const HOURS=3_600_000;
const MAX_BANK_PER_CLASS=5000;
const FRESH_WINDOW=48*HOURS;
const RETRY_INCOMPLETE_MS=15*MIN;
const MAX_CLASSIFICATION_CHECKS=16; // per two-minute collector export

/* Вход в Исследование 1: два пути, каждый можно включить/выключить.
   manual — немедленный входной фильтр (поток, стартовый SOL в пуле, случайная доля) — каждый параметр со своим переключателем;
   modules — монеты, прошедшие модули окна возможностей («Прошли»).
   Нет конфигурации intake → прежнее поведение (все монеты «Все»). */
function intakeSettings(x){
  if(x==null)return null;
  const num=(v,lo,hi)=>Number.isFinite(+v)&&+v>=lo&&+v<=hi?+v:null;
  const m=x.manual||{},on=v=>v===true;
  const out={manual:{enabled:on(m.enabled),phase:['before','after','both'].includes(m.phase)?m.phase:'both',
      quoteSol:{on:on(m.quoteSol?.on),min:num(m.quoteSol?.min,0,100000)??0.5},
      sample:{on:on(m.sample?.on),pct:num(m.sample?.pct,1,100)??100}},
    modules:{enabled:on(x.modules?.enabled)}};
  return out}
function sampled(mint,pct){if(pct>=100)return true;let h=2166136261;for(const ch of mint){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)>>>0}return (h%10000)/100<pct}
// Решение о входе; null-признак при включённом параметре = монета не входит (причина «нет данных»).
function intakeDecision(intake,row,features,passes){
  if(!intake)return {ok:true,via:'all'};
  const via=[];let manualWhy=null;
  const m=intake.manual;
  if(m.enabled){let ok=true,why=null;
    if(m.phase!=='both'&&row.phase!==m.phase){ok=false;why='phase'}
    if(ok&&m.quoteSol.on){const v=features?.quoteSol??features?.quoteSolEquivalent;if(v==null){ok=false;why='no-quoteSol'}else if(v<m.quoteSol.min){ok=false;why='quoteSol'}}
    if(ok&&m.sample.on&&!sampled(row.mint,m.sample.pct)){ok=false;why='sample'}
    if(ok)via.push('manual');else {manualWhy=why;if(!intake.modules.enabled)return {ok:false,why};}
  }
  if(intake.modules.enabled){const rec=passes?.records?.get?.(row.mint);
    if(rec){const all=passes.config?.r1?.[row.phase]===true,ids=new Set((passes.config?.modules||[]).filter(x=>x.toR1&&x.level==='1'&&x.phase===row.phase).map(x=>x.filterId));
      if(all||(rec.matches||[]).some(x=>ids.has(x.id)))via.push('modules')}}
  return via.length?{ok:true,via:via.join('+')}:{ok:false,why:manualWhy||'modules-only-not-passed'};
}
function settings(cfg={}) {
  const result={
    outcomeVersion:2,missPenalty:cfg.missPenalty??3,
    outcomeMethod:cfg.outcomeMethod??'legacy-trade-v3',minSliceVolumeSol:cfg.minSliceVolumeSol??.5,sliceRuleVersion:cfg.sliceRuleVersion??1,minSliceRangePct:cfg.minSliceRangePct??3,minGreenCandles:cfg.minGreenCandles??2,minRedCandles:cfg.minRedCandles??2,
    activityRuleVersion:cfg.outcomeMethod==='gt-ohlcv-20m-v1'?4:3,minTradeSol:cfg.minTradeSol??.05,minWallets:cfg.minWallets??2,
    hours:cfg.hours??5,
    decisionMinutes:cfg.decisionMinutes??10,
    minActive:cfg.minActive??60,
    minCoverage:cfg.minCoverage??.8,
    targetLive:cfg.targetLive??100,targetDead:cfg.targetDead??40,
    ...(cfg.intake!=null?{intake:intakeSettings(cfg.intake)}:{})
  };
  if(!Number.isInteger(result.hours)||result.hours<1||result.hours>12 ||
     !Number.isInteger(result.decisionMinutes)||result.decisionMinutes<1||result.decisionMinutes>20 ||
     !Number.isFinite(result.minActive)||result.minActive<0||result.minActive>100 ||
     !Number.isFinite(result.minCoverage)||result.minCoverage<.5||result.minCoverage>1) {
    throw new RangeError('Invalid first-level observation settings');
  }
  if(!Number.isFinite(result.minSliceVolumeSol)||result.minSliceVolumeSol<.1||result.minSliceVolumeSol>5)throw RangeError('Invalid slice volume');
  if(![1,2].includes(result.sliceRuleVersion)||!Number.isFinite(result.minSliceRangePct)||result.minSliceRangePct<.5||result.minSliceRangePct>20||['minGreenCandles','minRedCandles'].some(k=>!Number.isInteger(result[k])||result[k]<1||result[k]>10))throw RangeError('Invalid slice turbulence settings');
  for(const key of ['targetLive','targetDead'])if(!Number.isInteger(result[key])||result[key]<10||result[key]>5000)throw RangeError('Invalid research target');
  if(!Number.isFinite(result.missPenalty)||result.missPenalty<1||result.missPenalty>5)throw RangeError('Invalid miss penalty');
  if(!Number.isFinite(result.minTradeSol)||result.minTradeSol<.01||result.minTradeSol>1||!Number.isInteger(result.minWallets)||result.minWallets<2||result.minWallets>10)throw RangeError('Invalid single-swap activity settings');
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
  cfg=phaseSettings(cfg,row.phase);if(row.outcomeVersion===2)return classifyActivity(row,cfg).label;return 'unknown';
}

class ResearchRuntime {
  constructor({dir,config={},bankName='research-v2-bank.json',cohortStart=0,cohortEnd=Infinity,carry=null}={}) {
    if(!dir)throw new TypeError('Research directory is required');
    this.dir=dir;
    this.file=path.join(dir,bankName);
    this.cohortStart=cohortStart;this.cohortEnd=cohortEnd;
    fs.mkdirSync(dir,{recursive:true});
    this.config=settings(config);this.intakeRejected={};this.intakeAccepted={};this.intakeDecisions=new Map();
    this.rows=[];this.admitted=new Map();this.admissionUpgradeAt=Date.now();
    this.lookup=new Set();
    this.processed=new Map();
    this.lastAttemptAt=new Map();
    this.lastAt=null;this.featureRepair={repaired:0,missing:0,errors:0,bySource:{},busy:false,lastAt:0};
    this.pending={};
    if(fs.existsSync(this.file)){
      const state=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(state.schema!==1||!Array.isArray(state.rows))throw Error('Unknown stored research format');
      for(const r of state.rows){
        if(typeof r.mint!=='string'||!Number.isSafeInteger(r.acceptedAt)||
           (r.activePct!=null&&!Number.isFinite(r.activePct))||(r.maxIdleObserved!=null&&!Number.isFinite(r.maxIdleObserved))||
           !r.features||typeof r.features!=='object')
          throw Error('Malformed saved research sample');
      }
      this.admissionUpgradeAt=state.admissionUpgradeAt||this.admissionUpgradeAt;this.intakeDecisions=new Map(state.intakeDecisions||[]);this.intakeAccepted=state.intakeAccepted||{};this.intakeRejected=state.intakeRejected||{};
      this.featureRepair={...this.featureRepair,...state.featureRepair,busy:false};this.rows=state.rows;this.admitted=new Map((state.admitted||state.rows).map(r=>[r.mint,r]));
      this.lookup=new Set(this.rows.map(r=>r.mint));
      for(const pair of state.processed||[]) {
        if(Array.isArray(pair)&&typeof pair[0]==='string'&&Number.isSafeInteger(pair[1]))
          this.processed.set(pair[0],pair[1]);
      }
      if(!state.admissionVersion){this.processed.clear();}
      if((state.admissionVersion||0)<3){const completed=new Set(this.rows.map(r=>r.mint));for(const [mint] of this.processed)if(!completed.has(mint))this.processed.delete(mint);for(const row of this.admitted.values())if(!row.intakePending)this.intakeDecisions.set(row.mint,{ok:true,via:row.via||'preserved-observed-cohort',at:state.savedAt||row.acceptedAt,acceptedAt:row.acceptedAt});this.intakeAccepted={};this.intakeRejected={};for(const d of this.intakeDecisions.values()){const bank=d.ok?this.intakeAccepted:this.intakeRejected,key=d.ok?d.via:d.why;bank[key]=(bank[key]||0)+1;}}
      // Compatible with older snapshots that did not store the processed index.
      for(const r of this.rows)if(r.outcomeVersion===2)this.processed.set(r.mint,r.acceptedAt);else this.processed.delete(r.mint);
    }
    if(this.config.outcomeMethod==='gt-ohlcv-20m-v1')for(const r of this.rows)if(r.label==='unknown'&&!r.terminalCandlesPacked)this.processed.delete(r.mint);
    this.carryFrom(carry);
  }
  sealDecisionFeatures({coins,passes=null,now=Date.now(),limit=16}={}){
    if(this.config.outcomeMethod!=='gt-ohlcv-20m-v1')return 0;const phases={before:phaseSettings(this.config,'before'),after:phaseSettings(this.config,'after')};let changed=0;
    for(const admission of this.admitted.values()){
      if(changed>=limit)break;if(admission.intakePending||now-admission.acceptedAt>=21*MIN)continue;const cfg=phases[admission.phase],at=admission.acceptedAt+cfg.decisionMinutes*MIN;
      if(now<at||admission.featureReceiptVersion===2&&admission.decisionAt===at)continue;const coin=coins.get(admission.mint);if(!coin)continue;const f=require('./feature-snapshots').decision(coin,admission,cfg.decisionMinutes,passes);if(f.snapshotSealed){Object.assign(admission,f);changed++;}
    }return changed;
  }
  async repairFrozenFeatures({coins,passes=null,now=Date.now(),limit=4,canRun=()=>true}={}){
    if(this.featureRepair.busy||this.config.outcomeMethod!=='gt-ohlcv-20m-v1'||!canRun())return this.featureRepair;
    this.featureRepair.busy=true;try{
      const backup=this.file+'.before-feature-receipts-v2.json';if(fs.existsSync(this.file)&&!fs.existsSync(backup)){const temporary=backup+'.tmp';await fs.promises.copyFile(this.file,temporary);if(!(await fs.promises.stat(temporary)).size)throw Error('Empty receipt repair backup');if(!fs.existsSync(backup))await fs.promises.rename(temporary,backup);else await fs.promises.unlink(temporary);}
      const phases={before:phaseSettings(this.config,'before'),after:phaseSettings(this.config,'after')};let checked=0;for(const admission of this.admitted.values()){
        if(!canRun()||checked>=limit)break;const cfg=phases[admission.phase];
        if(admission.intakePending||now-admission.acceptedAt<21*MIN||admission.featureReceiptVersion===2&&admission.featureCoverageMinute===cfg.decisionMinutes||admission.featureRepairRetryAt>now)continue;
        checked++;const coinStart=Date.now();try{const coin=coins.get(admission.mint);if(!coin){this.featureRepair.missing++;admission.featureRepairRetryAt=now+HOURS;continue;}
          const receipt=require('./feature-snapshots').decision(coin,admission,cfg.decisionMinutes,passes);if(!receipt.snapshotSealed){this.featureRepair.missing++;admission.featureRepairRetryAt=now+HOURS;continue;}
          const verdicts=passes?.records?.get(admission.mint)?.moduleVerdicts,times=require('./module-library').freezeFeatureTimes(coin,admission.acceptedAt,'1',admission.phase,verdicts);
          Object.assign(admission,receipt);delete admission.featureRepairRetryAt;const row=this.rows.find(r=>r.mint===admission.mint);if(row)Object.assign(row,receipt,{featureTimesPacked:times});
          this.featureRepair.repaired++;this.featureRepair.bySource[receipt.featureCoverageSource]=(this.featureRepair.bySource[receipt.featureCoverageSource]||0)+1;
        }catch(e){this.featureRepair.errors++;const reason=/^[A-Z0-9_]{1,32}$/.test(e.code||'')?e.code:'receipt-replay-invalid';this.featureRepair.errorReasons=this.featureRepair.errorReasons||{};this.featureRepair.errorReasons[reason]=(this.featureRepair.errorReasons[reason]||0)+1;admission.featureRepairRetryAt=now+HOURS;}finally{this.featureRepair.maxCoinMs=Math.max(this.featureRepair.maxCoinMs||0,Date.now()-coinStart);}
        await new Promise(resolve=>setImmediate(resolve));
      }
      this.featureRepair.remaining=[...this.admitted.values()].filter(a=>!a.intakePending&&now-a.acceptedAt>=21*MIN&&(a.featureReceiptVersion!==2||a.featureCoverageMinute!==phases[a.phase].decisionMinutes)).length;this.featureRepair.lastAt=now;return this.featureRepair;
    }finally{this.featureRepair.busy=false;}
  }
  carryFrom(previous){if(!previous)return;for(const row of previous.admitted.values())if(!this.admitted.has(row.mint))this.admitted.set(row.mint,{...row,intakePending:true,transferred:true});}
  admit(row,coin,passes=null,now=Date.now()){
    const existing=this.admitted.get(row.mint);
    if((row.acceptedAt<this.cohortStart&&!existing?.transferred)||row.acceptedAt>=this.cohortEnd)return null;if(existing&&!existing.intakePending)return existing;
    const cfg=phaseSettings(this.config,row.phase),pool=row.proof?.pool||coin?.p||null;
    const opening=require('./opening-liquidity').intakeOpening(row,coin,now);
    let quoteSol=opening.quoteSol;
    if(quoteSol==null&&opening.quoteSolEquivalent==null&&coin){const first=[...(coin.lq||[])].sort((a,b)=>a[0]-b[0]).find(r=>r[0]*1000<=row.acceptedAt);if(first){const qi=coin.vmint?.indexOf('So11111111111111111111111111111111111111112');if(qi>=0&&coin.vmint[1-qi]===coin.a&&Number.isFinite(first[2+qi])&&first[2+qi]>=0)quoteSol=first[2+qi]/1e9;}}
    const features={...opening,quoteSol},gate=intakeDecision(cfg.intake,row,features,passes),previous=this.intakeDecisions.get(row.mint);
    if(!previous||previous.ok!==gate.ok||previous.why!==gate.why||previous.via!==gate.via){if(previous){const bank=previous.ok?this.intakeAccepted:this.intakeRejected,key=previous.ok?previous.via:previous.why;if(bank[key]>0)bank[key]--;if(!bank[key])delete bank[key];}const bank=gate.ok?this.intakeAccepted:this.intakeRejected,key=gate.ok?gate.via:gate.why;bank[key]=(bank[key]||0)+1;this.intakeDecisions.set(row.mint,{...gate,at:now,acceptedAt:row.acceptedAt,...features});}
    if(!gate.ok){this.admitted.delete(row.mint);if(!cfg.intake?.modules.enabled)this.processed.set(row.mint,row.acceptedAt);return null;}
    this.processed.delete(row.mint);const admission={mint:row.mint,phase:row.phase,p:pool,pair:pool,phaseEpoch:row.proof?.poolEpoch?.id||null,eventAt:eventAnchor(row),acceptedAt:row.acceptedAt,admittedAt:now,intakeFeatures:features,intakeMode:'discovery-v3',features:{},via:gate.via};this.admitted.set(row.mint,admission);return admission;
  }
  pruneRevoked(revoked,phase='before'){let n=0;for(const [mint,row] of this.admitted)if(row.phase===phase&&revoked?.has(mint)){this.admitted.delete(mint);this.processed.delete(mint);this.lastAttemptAt.delete(mint);const d=this.intakeDecisions.get(mint);if(d){const bank=d.ok?this.intakeAccepted:this.intakeRejected,key=d.ok?d.via:d.why;if(bank[key]>0)bank[key]--;if(!bank[key])delete bank[key];this.intakeDecisions.delete(mint);}n++;}this.rows=this.rows.filter(r=>r.phase!==phase||!revoked?.has(r.mint));return n;}
  *reanchorSteps({source,coins,now,limit=4}) {
    const candidates=this.rows.filter(r=>{const admission=source.get?.(r.mint)||source.records.get(r.mint);return admission&&admission.phase===r.phase&&Number.isSafeInteger(admission.eventAt)&&admission.eventAt>0&&admission.eventAt<=admission.acceptedAt&&(r.featureSnapshotVersion!==1||r.eventAt!==admission.eventAt||r.windowStart!==admission.eventAt||r.marketScopeVersion!==2);});
    this.eventMigration={remaining:candidates.length,rawMissing:0,changed:this.eventMigration?.changed||0};
    if(!candidates.length)return;
    const cursor=(this.eventMigrationCursor||0)%candidates.length;
    for(let i=0;i<Math.min(limit,candidates.length);i++){
      yield;
      const old=candidates[(cursor+i)%candidates.length],admission=source.get?.(old.mint)||source.records.get(old.mint),coin=coins.get(old.mint),pool=admission.proof?.pool||old.p;
      if(!coin||(pool&&coin.p!==pool)){this.eventMigration.rawMissing++;continue;}
      const cfg=phaseSettings(this.config,old.phase),at=admission.eventAt,decisionAt=admission.acceptedAt+cfg.decisionMinutes*MIN;
      const result=activityOutcome(coin,at,cfg,now);if(result.label==='pending')continue;
      // Recompute from original receipt cutoffs. Relabelling old frozen values
      // with an earlier timestamp would leak observations from after the decision.
      const fresh={...old,...result,activitySlices:undefined,activitySlicesPacked:result.activitySlices?require('./activity-slices').pack(result.activitySlices):undefined,eventAt:at,featureAnchor:'acceptedAt',featureSnapshotVersion:1,marketScopeVersion:2,decisionAt,
        features:require('./feature-snapshots').read(coin,admission.acceptedAt,cfg.decisionMinutes,old.phase),
        featureTimesPacked:require('./module-library').freezeFeatureTimes(coin,admission.acceptedAt,'1',old.phase),
        earlyWallets:require('./early-intelligence').frozenWallets(coin,decisionAt),
        curve:observationCurve(coin,at,cfg.hours),minutes:undefined,
        outcomePacked:require('node:zlib').deflateSync(Buffer.from(JSON.stringify(result.minutes||[]))).toString('base64'),
        recoveryPending:false,recoveryJobId:undefined,recoveryVersion:undefined,recoveryWhy:undefined,
        previousAnchor:old.previousAnchor??old.eventAt??old.acceptedAt,eventReanchoredAt:now,outcomeAt:now};
      this.rows[this.rows.indexOf(old)]=fresh;
      const intake=this.admitted.get(old.mint);if(intake)this.admitted.set(old.mint,{...intake,eventAt:at,features:fresh.features});
      this.eventMigration.changed++;this.eventMigration.remaining--;
    }
    this.eventMigrationCursor=cursor+limit;
  }
  reanchor(options){const work=this.reanchorSteps(options);let step;do{step=work.next();}while(!step.done);return step.value;}
  update(options){const work=this.updateSteps(options);let step;do{step=work.next();}while(!step.done);return step.value;}
  async updateAsync(options){const work=this.updateSteps(options);let step,at=Date.now();for(;;){step=work.next();if(step.done)return step.value;if(Date.now()-at>=8){await new Promise(resolve=>setImmediate(resolve));at=Date.now();}}}
  *updateSteps({source,coins,passes=null,now=Date.now()}={}) {
    this.pruneRevoked(source?.revokedManual);this.pruneRevoked(new Map([...(source?.revokedMigrations||[])].filter(([mint])=>!source.records.has(mint))),'after');
    if(!source?.records || !coins?.get)throw new TypeError('Need source ledger and coin map');
    if(this.config.outcomeMethod!=='gt-ohlcv-20m-v1')yield* this.reanchorSteps({source,coins,now});
    let added=0,considered=0,attempted=0,gateChecks=0;
    const pending={},byPhase={before:{live:0,dead:0},after:{live:0,dead:0}};
    // Newest first, avoid scanning the entire multi-month ledger.
    const recent=Array.from(typeof source.recentAdmissions==='function'?
      source.recentAdmissions(now-FRESH_WINDOW,now):source.records.values());
    // Unclassified windows still inside their deadline precede old repeat work.
    const terminal=new Map(this.rows.map(r=>[r.mint,r])),phaseRanks={},ranks=new Map();
    for(const row of recent){const cfg=phaseRanks[row.phase]||(phaseRanks[row.phase]=phaseSettings(this.config,row.phase)),age=now-eventAnchor(row);ranks.set(row.mint,age>=cfg.hours*HOURS+3*MIN&&age<(cfg.hours+1)*HOURS&&!terminal.has(row.mint)?0:!terminal.has(row.mint)?1:2);}
    const rank=row=>ranks.get(row.mint);
    recent.sort((a,b)=>rank(a)-rank(b)||(this.lastAttemptAt.get(a.mint)?.at||terminal.get(a.mint)?.outcomeAt||0)-(this.lastAttemptAt.get(b.mint)?.at||terminal.get(b.mint)?.outcomeAt||0)||a.acceptedAt-b.acceptedAt);
    const diag={recent:0,beforeCohort:0,afterEnd:0,tooOld:0,future:0,processed:0,processedSize:this.processed.size};
    for(const row of recent){
      yield;
      const age=now-(this.config.outcomeMethod==='gt-ohlcv-20m-v1'?row.acceptedAt:eventAnchor(row));
      if(this.processed.has(row.mint)&&!this.admitted.has(row.mint)&&row.acceptedAt<this.admissionUpgradeAt)this.processed.delete(row.mint);
      diag.recent++;if(row.acceptedAt<this.cohortStart)diag.beforeCohort++;else if(row.acceptedAt>=this.cohortEnd)diag.afterEnd++;else if(age<0)diag.future++;else if(age>FRESH_WINDOW)diag.tooOld++;else if(this.processed.has(row.mint))diag.processed++;
      if((row.acceptedAt<this.cohortStart&&!this.admitted.has(row.mint))||row.acceptedAt>=this.cohortEnd||age<0||age>FRESH_WINDOW||this.processed.has(row.mint))continue;
      considered++;
      const cfg=phaseSettings(this.config,row.phase);
      let admission=this.admitted.get(row.mint);
      if(!admission||admission.intakePending)admission=this.admit(row,coins.get(row.mint),passes,now);
      if(!admission)continue;
      const featureAt=row.acceptedAt+cfg.decisionMinutes*MIN;
      if(now>=featureAt&&(admission.decisionAt!==featureAt||this.config.outcomeMethod==='gt-ohlcv-20m-v1'&&admission.featureReceiptVersion!==2)){const coin=coins.get(row.mint);if(coin){const snap=require('./feature-snapshots'),f=snap.decision(coin,row,cfg.decisionMinutes,passes);if(this.config.outcomeMethod!=='gt-ohlcv-20m-v1'||f.snapshotSealed)Object.assign(admission,f);}}


      if(admission.intakePending||age<cfg.hours*HOURS+3*MIN){
        const why=age<cfg.hours*HOURS+3*MIN?'not-yet-finished':'deferred-by-batch';pending[why]=(pending[why]||0)+1;
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
      const result=activityOutcome(coin,cfg.outcomeMethod==='gt-ohlcv-20m-v1'?row.acceptedAt:eventAnchor(row),cfg,now);
      if(result.label==='pending'){
        this.lastAttemptAt.set(row.mint,{at:now,acceptedAt:row.acceptedAt,why:result.why});
        pending[result.why]=(pending[result.why]||0)+1;
        continue;
      }
      this.lastAttemptAt.delete(row.mint);
      const receipt=require('./feature-snapshots').decision(coin,row,cfg.decisionMinutes,passes),features=receipt.features;Object.assign(admission,receipt);
      const gate={via:admission.via||'all'};
      this.rows=this.rows.filter(x=>x.mint!==row.mint);
      this.rows.push({via:gate.via,
        mint:row.mint,phase:row.phase,p:row.proof?.pool||null,pair:row.proof?.pool||null,phaseEpoch:row.proof?.poolEpoch?.id||null,featureAnchor:'acceptedAt',featureSnapshotVersion:1,marketScopeVersion:2,eventAt:eventAnchor(row),...receipt,featureTimesPacked:require('./module-library').freezeFeatureTimes(coin,row.acceptedAt,'1',row.phase,passes?.records?.get(row.mint)?.moduleVerdicts),curve:observationCurve(coin,eventAnchor(row),cfg.hours),curveUnit:'price-usd',
        acceptedAt:row.acceptedAt,decisionAt,earlyWallets:require('./early-intelligence').frozenWallets(coin,decisionAt),
        ...result,activitySlices:undefined,activitySlicesPacked:result.activitySlices?require('./activity-slices').pack(result.activitySlices):undefined,outcomeAt:now,minutes:undefined,outcomePacked:require('node:zlib').deflateSync(Buffer.from(JSON.stringify(result.minutes||[]))).toString('base64'),
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
    if(this.config.outcomeMethod==='gt-ohlcv-20m-v1'){this.rows=this.rows.filter(r=>now-r.acceptedAt<=FRESH_WINDOW);for(const [mint,r] of this.admitted)if(now-r.acceptedAt>FRESH_WINDOW)this.admitted.delete(mint);}
    for(const [mint,acceptedAt] of this.processed){
      if(now-acceptedAt>FRESH_WINDOW)this.processed.delete(mint);
    }
    for(const [mint,decision] of this.intakeDecisions)if(now-decision.acceptedAt>FRESH_WINDOW)this.intakeDecisions.delete(mint);
    for(const [mint,retry] of this.lastAttemptAt)
      if(now-retry.acceptedAt>FRESH_WINDOW)this.lastAttemptAt.delete(mint);
    {
      this.rows=this.rows.sort((a,b)=>a.time-b.time);
      this.lookup=new Set(this.rows.map(r=>r.mint));
      atomicJSON(this.file,{schema:1,rows:this.rows,
        featureRepair:{...this.featureRepair,busy:false},admissionVersion:3,intakeDecisions:[...this.intakeDecisions],intakeAccepted:this.intakeAccepted,intakeRejected:this.intakeRejected,admissionUpgradeAt:this.admissionUpgradeAt,admitted:[...this.admitted.values()],processed:[...this.processed],savedAt:now});
    }
    for(const row of this.rows){
      const name=classOf(row,this.config);
      if(byPhase[row.phase]&&name in byPhase[row.phase])byPhase[row.phase][name]++;
    }
    this.pending=pending;
    this.lastAt=now;
    return {added,considered,attempted,diag:{...diag,cohortStart:this.cohortStart,cohortEnd:String(this.cohortEnd),now},
      maxChecksPerRun:MAX_CLASSIFICATION_CHECKS,intake:this.config.intake,intakeAccepted:this.intakeAccepted,intakeRejected:this.intakeRejected,...this.summary()};
  }
  summary(){
    const unknownReasons={};let recovering=0;
    const counts={live:0,dead:0,pending:0,unknown:0,entered:0,preLive:0,preDead:0,postLive:0,postDead:0},byPhase={before:{entered:0,live:0,dead:0,pending:0,unknown:0},after:{entered:0,live:0,dead:0,pending:0,unknown:0}};
    const view=this.view();for(const row of view){if(row.why==='backfill-pending')recovering++;if(row.label==='unknown')unknownReasons[row.why||'collector-gap']=(unknownReasons[row.why||'collector-gap']||0)+1;counts.entered++;counts[row.label]++;const p=byPhase[row.phase];if(p){p.entered++;p[row.label]++;}if(['live','dead'].includes(row.label))counts[row.phase==='before'?(row.label==='live'?'preLive':'preDead'):(row.label==='live'?'postLive':'postDead')]++;}
    return {schema:2,updated:this.lastAt,eventMigration:this.eventMigration||null,cohortStart:this.cohortStart,settings:{...this.config},intakeMode:'discovery-v3',intakeAccepted:this.intakeAccepted,intakeRejected:this.intakeRejected,intakePending:[...this.admitted.values()].filter(a=>a.intakePending).length,counts,byPhase,unknownReasons,distributions:this.distributions(view),pending:{...this.pending,'not-yet-finished':counts.pending-recovering,'backfill-pending':recovering,'collector-gap':counts.unknown},bankCapacityPerClass:MAX_BANK_PER_CLASS,status:'observational',secondLevel:'separate-server-verified-pass-stream'};
  }
  view(){const complete=new Map(this.rows.map(r=>[r.mint,r]));return [...this.admitted.values()].filter(a=>!a.intakePending).map(a=>{const r=complete.get(a.mint);if(r){const v=r.outcomeVersion===2?classifyActivity(r,{...phaseSettings(this.config,r.phase),now:this.lastAt}):{label:'unknown',why:'legacy-observation-awaiting-recheck'};return {...r,...v,features:verifiedFeatures(r.features)};};const cfg=phaseSettings(this.config,a.phase),ended=this.lastAt>=(this.config.outcomeMethod==='gt-ohlcv-20m-v1'?a.acceptedAt:eventAnchor(a))+cfg.hours*HOURS+3*MIN,expired=this.lastAt>=(this.config.outcomeMethod==='gt-ohlcv-20m-v1'?a.acceptedAt:eventAnchor(a))+(cfg.hours+1)*HOURS,why=this.lastAttemptAt.get(a.mint)?.why;return {...a,label:expired||ended&&why&&why!=='deferred-by-batch'?'unknown':'pending',why:expired&&(!why||why==='deferred-by-batch')?'classification-deadline-exceeded':ended?why||'deferred-by-batch':'not-yet-finished'};}).sort((a,b)=>a.acceptedAt-b.acceptedAt);}
  distributions(view=this.view()){const histogram=(rows,key,edges)=>{const bins=edges.map((lo,i)=>({from:lo,to:edges[i+1]??(key==='activePct'?100:null),count:0}));let unknown=0;for(const r of rows){const x=r[key];if(typeof x!=='number'||!Number.isFinite(x)){unknown++;continue;}let i=edges.findLastIndex(n=>x>=n);if(i<0)i=0;bins[i].count++;}return {bins,known:rows.length-unknown,unknown};};return Object.fromEntries(['before','after'].map(phase=>{const rows=view.filter(r=>r.phase===phase&&r.label!=='pending').map(r=>({...r,priceChangePct:r.priceKeep==null?null:r.priceKeep-100}));return [phase,{completed:rows.length,activePct:histogram(rows,'activePct',Array.from({length:10},(_,i)=>i*10)),maxIdleObserved:histogram(rows,'maxIdleObserved',[0,15,30,60,120]),priceChangePct:histogram(rows,'priceChangePct',[-100,-90,-70,-50,-30,-10,0,10,50,100]),uniqueBuyers:histogram(rows,'uniqueBuyers',[0,10,30,50,100,200]),lowerBounds:rows.filter(r=>r.lowerBounds?.includes('unique-buyers')).length}];}));}
  debugSample(limit=20,{coins=null,now=this.lastAt,pinnedMints=[]}={}){if(this.config.outcomeMethod==='gt-ohlcv-20m-v1')return this.view().slice(0,limit).map(r=>({mint:r.mint,phase:r.phase,acceptedAt:r.acceptedAt,windowStart:r.windowStart,windowEnd:r.windowEnd,label:r.label,why:r.why,audit:{method:this.config.outcomeMethod,thresholds:{minActive:phaseSettings(this.config,r.phase).minActive,minSliceVolumeSol:phaseSettings(this.config,r.phase).minSliceVolumeSol},classification:classifyActivity(r,phaseSettings(this.config,r.phase))}}));const crypto=require('node:crypto'),zlib=require('node:zlib');return this.view().map(r=>({r,rank:crypto.createHash('sha256').update(String(this.cohortStart)+r.mint).digest('hex')})).sort((a,b)=>{const ai=pinnedMints.indexOf(a.r.mint),bi=pinnedMints.indexOf(b.r.mint);return (ai<0?Infinity:ai)-(bi<0?Infinity:bi)||a.rank.localeCompare(b.rank)}).slice(0,limit).map(({r})=>{const cfg={...phaseSettings(this.config,r.phase),now},plannedWindowEnd=eventAnchor(r)+cfg.hours*HOURS,observedUntil=Math.min(now,plannedWindowEnd);if(!r.outcomePacked&&coins?.get&&observedUntil>eventAnchor(r)){const c=coins.get(r.mint);if(c)r={...activityEvidence(c,eventAnchor(r),observedUntil,cfg.decisionMinutes),...r};}let minutes=r.minutes||[];try{if(r.outcomePacked)minutes=JSON.parse(zlib.inflateSync(Buffer.from(r.outcomePacked,'base64'),{maxOutputLength:2000000}).toString())}catch{}const sliceAPI=require('./activity-slices'),raw=r.activitySlices||sliceAPI.unpack(r.activitySlicesPacked),verdict=classifyActivity(r,cfg),c=coins?.get?.(r.mint);const audit={thresholds:{minActive:cfg.minActive,minWallets:cfg.minWallets,minTradeSol:cfg.minTradeSol,minCoverage:cfg.minCoverage},requiredActiveSlices:Math.ceil((verdict.totalSlices||0)*cfg.minActive/100),classification:verdict,slices:(raw?.slices||[]).map(s=>({at:s.at,end:s.end,wallets:Object.keys(s.walletMax||{}).length,qualifyingWallets:Object.values(s.walletMax||{}).filter(v=>typeof v==='number'&&v>=cfg.minTradeSol).length,complete:s.complete===true,silent:s.silent===true,hasTrades:s.hasTrades===true})),collectorMinutes:minutes.filter(r=>r[1]===1).length,activityMinutes:minutes.filter(r=>r[2]===1).length};return {audit,name:c?.n||null,pool:c?.p||r.proof?.pool||null,plannedWindowEnd,observedUntil,metricsProvisional:r.label==='pending',mint:r.mint,phase:r.phase,acceptedAt:r.acceptedAt,windowStart:r.windowStart,windowEnd:r.windowEnd,label:r.label,why:r.why,coverage:r.coverage,activePct:r.activePct,activeSlices:classifyActivity(r,cfg).activeSlices,totalSlices:classifyActivity(r,cfg).totalSlices,maxIdleObserved:r.maxIdleObserved,priceAtDecision:r.priceAtDecision,priceAtEnd:r.priceAtEnd,priceKeep:r.priceKeep,lastHourTrades:r.lastHourTrades,lastHourWallets:r.lastHourWallets,uniqueBuyers:r.uniqueBuyers,backfilledMinutes:r.backfilledMinutes||0,recoveryWhy:r.recoveryWhy||null,minuteColumns:['at','collectorObserved','activityObserved','price','recovery'],minutes};});}
  select({phase,label,limit=100}={}) {
    if(phase&&!['before','after'].includes(phase))throw TypeError('bad phase');
    if(label&&!['live','dead','pending','unknown'].includes(label))throw TypeError('bad label');
    if(!Number.isInteger(limit)||limit<1||limit>20000)throw RangeError('bad limit');
    return this.rows.filter(r=>(!phase||r.phase===phase) && (!label||classOf(r,this.config)===label))
      .sort((a,b)=>b.acceptedAt-a.acceptedAt).slice(0,limit)
      .map(r=>({...r,...(this.config.outcomeMethod==='gt-ohlcv-20m-v1'?classifyActivity(r,phaseSettings(this.config,r.phase)):{label:classOf(r,this.config)}),features:verifiedFeatures(r.features)}));
  }
}
function observationCurve(coin,at,hours){const points=candles(coin);let j=-1;const curve=[];for(let m=0;m<=hours*60;m+=5){const t=at+m*MIN;while(j+1<points.length&&points[j+1][0]<=t)j++;curve.push([m,j>=0&&t-points[j][0]<=7*MIN?points[j][1]:null])}return curve}
function capPhases(rows,cfg){return ['before','after'].flatMap(phase=>capBank(rows.filter(r=>r.phase===phase),r=>classOf(r,cfg),'live','dead',MAX_BANK_PER_CLASS)).sort((a,b)=>a.time-b.time)}
module.exports={phaseSettings,intakeDecision,intakeSettings,ResearchRuntime,settings,classOf};
