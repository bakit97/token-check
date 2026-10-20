'use strict';
const {eventAnchor}=require('./event-clock');
// Level 2 starts ONLY from durable server Passed events after their zeroAt.
// Price is observational; incomplete periods have no strong/weak label.
const fs=require('node:fs');
const path=require('node:path');
const {strengthOutcome,capBank,evaluation,featuresAt,levelTwoFeaturesAt}=require('./research-v2');

const MIN=60000,HOUR=60*MIN,FRESH=48*HOUR,RETRY=15*MIN;
const MAX_PER_CLASS=5000,MAX_CHECKS=200;
function configOf(raw={}){
  const cfg={lineVersion:2,passWindowMinutes:raw.passWindowMinutes??5,minAboveMarginPct:raw.minAboveMarginPct??10,hours:raw.hours??5,missPenalty:raw.missPenalty??3,minAbove:raw.minAbove??70,minCoverage:raw.minCoverage??.9,decisionMinutes:raw.decisionMinutes??5,targetStrong:raw.targetStrong??40,targetWeak:raw.targetWeak??40};
  if(!Number.isInteger(cfg.passWindowMinutes)||cfg.passWindowMinutes<1||cfg.passWindowMinutes>30||!Number.isFinite(cfg.minAboveMarginPct)||cfg.minAboveMarginPct<0||cfg.minAboveMarginPct>100||!Number.isInteger(cfg.hours)||cfg.hours<1||cfg.hours>12)throw RangeError('Invalid level-two line settings');
  if(!Number.isFinite(cfg.minAbove)||cfg.minAbove<0||cfg.minAbove>100||
     !Number.isFinite(cfg.minCoverage)||cfg.minCoverage<.5||cfg.minCoverage>1)
    throw RangeError('Invalid level-two research config');
  if(!Number.isFinite(cfg.missPenalty)||cfg.missPenalty<1||cfg.missPenalty>5)throw RangeError('Invalid miss penalty');
  if(!Number.isInteger(cfg.decisionMinutes)||cfg.decisionMinutes<1||cfg.decisionMinutes>15)throw RangeError('Invalid similarity time');
  for(const k of ['targetStrong','targetWeak'])if(!Number.isInteger(cfg[k])||cfg[k]<10||cfg[k]>5000)throw RangeError('Invalid research target');
  if(raw.phases){cfg.phases={};for(const phase of ['before','after'])cfg.phases[phase]=configOf({...cfg,...raw.phases[phase],phases:null})}
  return cfg;
}
function durableJSON(file,value){
  const temporary=file+'.tmp',buf=Buffer.from(JSON.stringify(value));
  const fd=fs.openSync(temporary,'w',0o600);
  try{let n=0;while(n<buf.length)n+=fs.writeSync(fd,buf,n,buf.length-n);fs.fsyncSync(fd)}
  finally{fs.closeSync(fd)}
  fs.renameSync(temporary,file);
  require('./durable-json').syncDirectory(path.dirname(file));
}
function packMinuteCurve(values){
  if(!Array.isArray(values)||values.length<60||values.length>720)return null;
  // 300 * float32 = 1200 bytes, compared with thousands of JSON numbers.
  // NaN is only an internal missing-value marker and never exported as a price.
  const bytes=Buffer.allocUnsafe(values.length*8);
  for(let i=0;i<values.length;i++){
    const value=values[i];
    bytes.writeDoubleLE(Number.isFinite(value)?value:NaN,i*8);
  }
  return bytes.toString('base64');
}
function eachMinutePoint(row,visit){
  if(typeof row.minuteCurvePacked==='string'){
    const bytes=Buffer.from(row.minuteCurvePacked,'base64');
    const size=row.minuteCurveEncoding==='float64'?8:4;
    if(bytes.length<60*size||bytes.length>720*size||bytes.length%size)throw Error('Corrupted compact minute curve');
    for(let i=0;i<bytes.length/size;i++){
      const v=size===8?bytes.readDoubleLE(i*size):bytes.readFloatLE(i*size);
      if(Number.isFinite(v))visit(i+1,v);
    }
    return;
  }
  if(Array.isArray(row.minuteCurve)&&row.minuteCurve.length>=60&&row.minuteCurve.length<=720){
    for(let i=0;i<row.minuteCurve.length;i++){
      const v=row.minuteCurve[i];
      if(Number.isFinite(v))visit(i+1,v);
    }
    return;
  }
  for(const point of row.curve||[])
    if(Array.isArray(point)&&Number.isInteger(point[0])&&Number.isFinite(point[1]))
      visit(point[0],point[1]);
}
function lineClock(pass,cfg={}){
 const verdictAt=Math.max(pass.verdictAt||0,pass.firstSeenAt||0,pass.zeroAt||0);
 const lineAt=verdictAt+(cfg.passWindowMinutes??5)*MIN;
 return {verdictAt,lineAt,windowEnd:lineAt+(cfg.hours??5)*HOUR};
}
function relabelStrength(row,cfg={}){
 if(row.lineVersion!==2||row.hours!==(cfg.hours??5)||row.passWindowMinutes!==(cfg.passWindowMinutes??5))return null;
 const total=row.hours*60,margin=cfg.minAboveMarginPct??10;
 if(!row.minuteCurvePacked&&!Array.isArray(row.minuteCurve))return null;
 let above=0,covered=0,gap=0,maxGap=0,previous=0;
 eachMinutePoint(row,(m,v)=>{if(m<1||m>total)return;gap+=m-previous-1;maxGap=Math.max(maxGap,gap);gap=0;previous=m;covered++;if(v+1e-9>=margin)above++;});
 maxGap=Math.max(maxGap,total-previous);
 if(covered<total*(cfg.minCoverage??.9)||maxGap>10)return null;
 return {...row,label:above/total*100>=(cfg.minAbove??70)?'strong':'weak',above,covered,pctAbove:above/total*100,threshold:cfg.minAbove??70,minAboveMarginPct:margin,coverageThreshold:cfg.minCoverage??.9};
}
class ResearchTwoRuntime {
  constructor({dir,config,bankName='research-v2-bank-two.json',cohortStart=0,cohortEnd=Infinity}={}){
    if(!dir)throw TypeError('Research-two directory required');
    fs.mkdirSync(dir,{recursive:true});
    this.file=path.join(dir,bankName);
    this.journalFile=this.file+'.journal';
    this.journalCount=0;
    this.compactedAt=Date.now();
    this.cohortStart=cohortStart;this.cohortEnd=cohortEnd;
    this.config=configOf(config);
    this.rows=[];
    this.processed=new Map();
    this.retry=new Map();
    this.lastAt=null;
    this.pending={};
    if(fs.existsSync(this.file)){
      const data=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(data.schema!==1||!Array.isArray(data.rows))throw Error('Unknown stored second-level research format');
      for(const row of data.rows){
        if(!row||typeof row.mint!=='string'||!Number.isSafeInteger(row.zeroAt)||
           !['strong','weak'].includes(row.label)||!Number.isFinite(row.pctAbove)||
           !Number.isFinite(row.covered)||!row.features||typeof row.features!=='object'||
           (row.minuteCurvePacked!=null&&
             (typeof row.minuteCurvePacked!=='string'||![...Array(12)].some((_,i)=>Buffer.from(row.minuteCurvePacked,'base64').length===(i+1)*60*(row.minuteCurveEncoding==='float64'?8:4)))))
          throw Error('Corrupted second-level research row');
      }
      this.rows=capPhases(data.rows);
      for(const pair of data.processed||[])
        if(Array.isArray(pair)&&typeof pair[0]==='string'&&Number.isSafeInteger(pair[1]))
          this.processed.set(pair[0],pair[1]);
      for(const row of this.rows)this.processed.set(row.mint,row.zeroAt);
    }
    this._replayJournal();const revFile=path.join(dir,'manual-pool-revocations-v1.json');if(fs.existsSync(revFile))this.pruneRevoked(new Map(JSON.parse(fs.readFileSync(revFile,'utf8')).entries));
  }
  _replayJournal(){
    if(!fs.existsSync(this.journalFile))return;
    const buf=fs.readFileSync(this.journalFile);
    if(!buf.length)return;
    const last=buf.lastIndexOf(10),complete=last<0?Buffer.alloc(0):buf.subarray(0,last+1);
    if(last<buf.length-1){
      // A torn final record is not committed. Keep a forensic backup.
      const fragment=buf.subarray(last+1),backup=this.journalFile+'.partial-'+Date.now();
      const backupFd=fs.openSync(backup,'wx',0o600);
      try{fs.writeSync(backupFd,fragment);fs.fsyncSync(backupFd)}
      finally{fs.closeSync(backupFd)}
      const fd=fs.openSync(this.journalFile,'r+');
      try{fs.ftruncateSync(fd,complete.length);fs.fsyncSync(fd)}
      finally{fs.closeSync(fd)}
      require('./durable-json').syncDirectory(path.dirname(this.journalFile));
    }
    const additions=[];
    for(const line of complete.toString('utf8').split('\n')){
      if(!line)continue;
      let row;
      try{row=JSON.parse(line)}catch{throw Error('Invalid committed second-level journal JSON')}
      if(!row||typeof row.mint!=='string'||!Number.isSafeInteger(row.zeroAt)||
         !['strong','weak'].includes(row.label)||!Number.isFinite(row.pctAbove)||
         !row.features||typeof row.features!=='object')
        throw Error('Malformed committed second-level journal row');
      if(this.processed.has(row.mint)){
        if(this.processed.get(row.mint)!==row.zeroAt&&!this.rows.some(saved=>saved.mint===row.mint&&saved.previousZeroAt===row.zeroAt))
          throw Error('Conflicting duplicate second-level mint');
        continue;
      }
      this.processed.set(row.mint,row.zeroAt);
      additions.push(row);
    }
    if(additions.length)
      this.rows=capPhases(this.rows.concat(additions));
    this.journalCount=complete.toString('utf8').split('\n').length-1;
  }
  _appendJournal(rows){
    if(!rows.length)return;
    const buf=Buffer.from(rows.map(row=>JSON.stringify(row)+'\n').join(''));
    const fd=fs.openSync(this.journalFile,'a',0o600);
    try{
      let offset=0;
      while(offset<buf.length)offset+=fs.writeSync(fd,buf,offset,buf.length-offset);
      fs.fsyncSync(fd);
    }finally{fs.closeSync(fd)}
  }
  _compact(now){
    durableJSON(this.file,{
      schema:1,rows:this.rows,processed:[...this.processed],updated:now
    });
    // Snapshot contains the entire durable journal. A crash between rename
    // and truncate is safe: replay skips rows already in processed.
    const fd=fs.openSync(this.journalFile,fs.existsSync(this.journalFile)?'r+':'w+',0o600);
    try{fs.ftruncateSync(fd,0);fs.fsyncSync(fd)}
    finally{fs.closeSync(fd)}
    this.journalCount=0;this.compactedAt=now;
  }
  pruneRevoked(revoked){for(const r of this.rows)if(r.phase==='before'&&revoked?.has(r.mint)){this.processed.delete(r.mint);this.retry.delete(r.mint);}this.rows=this.rows.filter(r=>r.phase!=='before'||!revoked?.has(r.mint));}
  reanchor({source,coins,now,limit=32}){
    if(!source?.records)return;
    const todo=this.rows.filter(r=>{const a=source.records.get(r.mint);return a&&a.phase===r.phase&&Number.isSafeInteger(a.eventAt)&&a.eventAt>0&&a.eventAt<=a.acceptedAt&&(r.featureSnapshotVersion!==1||r.eventAt!==a.eventAt||r.marketScopeVersion!==2);});
    this.eventMigration={remaining:todo.length,rawMissing:0,changed:this.eventMigration?.changed||0};let changed=false;
    const cursor=(this.eventMigrationCursor||0)%Math.max(1,todo.length);
    for(let i=0;i<Math.min(todo.length,limit);i++){
      const old=todo[(cursor+i)%todo.length],admission=source.records.get(old.mint),coin=coins.get(old.mint),pool=admission.proof?.pool||old.p;
      if(!Array.isArray(old.secondLevelRules)&&old.secondLevelMatches?.length){this.eventMigration.rulesMissing=(this.eventMigration.rulesMissing||0)+1;continue;}
      if(!coin||(pool&&coin.p!==pool)){this.eventMigration.rawMissing++;continue;}
      const cfg=this.config.phases?.[old.phase]||this.config,anchor=admission.eventAt,zeroAt=old.lineVersion===2?old.lineAt:anchor+(old.zeroAt-eventAnchor(old));
      if(!Number.isSafeInteger(zeroAt)||zeroAt<anchor)continue;
      const result=strengthOutcome(coin,zeroAt,cfg,now);if(result.label==='pending')continue;
      const at=admission.acceptedAt+cfg.decisionMinutes*MIN,F=require('./feature-snapshots').read(coin,admission.acceptedAt,cfg.decisionMinutes,old.phase,'2');
      const fresh={...old,...result,eventAt:anchor,featureAnchor:'acceptedAt',featureSnapshotVersion:1,marketScopeVersion:2,zeroAt,decisionAt:at,features:F,
        featureTimesPacked:require('./module-library').freezeFeatureTimes(coin,admission.acceptedAt,'2',old.phase),
        earlyWallets:require('./early-intelligence').frozenWallets(coin,at),
        secondLevelMatches:(old.secondLevelRules||[]).filter(f=>evaluation(F,f)==='pass'),
        firstPassFeatures:featuresAt(coin,zeroAt,{eventAt:anchor,phase:old.phase}),previousZeroAt:old.previousZeroAt??old.zeroAt,previousAnchor:old.previousAnchor??eventAnchor(old),eventReanchoredAt:now,
        windowEnd:zeroAt+cfg.hours*HOUR,p0:result.p0,curve:[[0,0],...result.curve],
        minuteCurve:undefined,minuteCurveEncoding:'float64',minuteCurvePacked:packMinuteCurve(result.minuteCurve),outcomeAt:now,time:zeroAt};
      this.rows[this.rows.indexOf(old)]=fresh;this.processed.set(old.mint,zeroAt);this.eventMigration.remaining--;this.eventMigration.changed++;changed=true;
    }
    this.eventMigrationCursor=cursor+limit;if(changed)this._compact(now);
  }
  update({passes,coins,source=null,now=Date.now()}={}){
    if(!passes?.records||!coins?.get)throw TypeError('Need verified pass journal and candidate map');
    this.reanchor({source,coins,now});
    this.relabel();
    let added=0,attempted=0,considered=0;
    const pending={},newRows=[];
    for(const pass of passes.records.values()){
      if(!pass||pass.firstSeenAt<this.cohortStart||pass.firstSeenAt>=this.cohortEnd||this.processed.has(pass.mint)||now-pass.zeroAt>FRESH||
         now<pass.zeroAt)continue;
      const cfg=this.config.phases?.[pass.phase]||this.config,{verdictAt,lineAt,windowEnd}=lineClock(pass,cfg);
      considered++;
      if(now<windowEnd+MIN){
        pending['not-yet-finished']=(pending['not-yet-finished']||0)+1;
        continue;
      }
      const last=this.retry.get(pass.mint);
      if(last&&now-last.at<RETRY){
        pending[last.reason]=(pending[last.reason]||0)+1;
        continue;
      }
      if(attempted>=MAX_CHECKS){
        pending['deferred-by-batch']=(pending['deferred-by-batch']||0)+1;
        continue;
      }
      attempted++;
      const coin=coins.get(pass.mint);
      if(!coin){
        this.retry.set(pass.mint,{at:now,zeroAt:pass.zeroAt,reason:'candidate-missing'});
        pending['candidate-missing']=(pending['candidate-missing']||0)+1;
        continue;
      }
      const result=strengthOutcome(coin,lineAt,cfg,now);
      if(result.label==='pending'){
        this.retry.set(pass.mint,{at:now,zeroAt:pass.zeroAt,reason:result.why});
        pending[result.why]=(pending[result.why]||0)+1;
        continue;
      }
      this.retry.delete(pass.mint);
      // Level-two conditions and versions were frozen at first Passed.
      // Their metrics use only observations up to the fixed zeroAt.
      const featureAt=pass.acceptedAt+cfg.decisionMinutes*MIN;
      const F=require('./feature-snapshots').read(coin,pass.acceptedAt,cfg.decisionMinutes,pass.phase,'2');
      const secondLevelMatches=(pass.secondLevelRules||[])
        .filter(f=>evaluation(F,f)==='pass').map(f=>({...f}));
      newRows.push({
        mint:pass.mint,phase:pass.phase,p:pass.p||coin.p||null,pair:pass.pair||coin.p||null,phaseEpoch:pass.phaseEpoch||null,acceptedAt:pass.acceptedAt,
        firstSeenAt:pass.firstSeenAt,passZeroAt:pass.zeroAt,verdictAt,lineAt,linePrice:result.p0,lineVersion:2,hours:cfg.hours,passWindowMinutes:cfg.passWindowMinutes,minAboveMarginPct:cfg.minAboveMarginPct,zeroAt:lineAt,decisionAt:featureAt,outcomeAt:now,windowEnd,earlyWallets:require('./early-intelligence').frozenWallets(coin,featureAt),featureAnchor:'acceptedAt',featureSnapshotVersion:1,marketScopeVersion:2,eventAt:eventAnchor(pass),featureTimesPacked:require('./module-library').freezeFeatureTimes(coin,pass.acceptedAt,'2',pass.phase),sourceFilterRules:pass.matches.map(f=>({...f})),
        configHash:pass.configHash,sourceFilterVersions:pass.matches.map(f=>({
          id:f.id,version:f.version,level:f.level
        })),
        label:result.label,secondLevelMatches,secondLevelRules:(pass.secondLevelRules||[]).map(f=>({...f})),
        pctAbove:result.pctAbove,covered:result.covered,
        p0:result.p0,curve:[[0,0],...result.curve],minuteCurveEncoding:'float64',minuteCurvePacked:packMinuteCurve(result.minuteCurve),features:F,
        firstPassFeatures:{...pass.features},
        threshold:cfg.minAbove,coverageThreshold:cfg.minCoverage,
        time:lineAt
      });
      // Processed is updated only after the complete batch is fsynced.
      added++;
    }
    for(const [mint,zeroAt] of this.processed)
      if(now-zeroAt>FRESH)this.processed.delete(mint);
    for(const [mint,last] of this.retry)
      if(now-last.zeroAt>FRESH)this.retry.delete(mint);
    if(added){
      this._appendJournal(newRows);
      for(const row of newRows)this.processed.set(row.mint,row.zeroAt);
      this.rows=capPhases(this.rows.concat(newRows));
      this.journalCount+=newRows.length;
      // Persist expensive full snapshots rarely instead of writing several
      // megabytes every two-minute heartbeat.
      if(this.journalCount>=250||now-this.compactedAt>=6*HOUR)
        this._compact(now);
    }
    this.pending=pending;this.lastAt=now;
    return {added,considered,attempted,maxChecksPerRun:MAX_CHECKS,...this.summary()};
  }
  relabel(){
    const sig=JSON.stringify(this.config);if(this.labelSig===sig)return;
    let changed=false;
    this.rows=this.rows.map(row=>{const next=relabelStrength(row,this.config.phases?.[row.phase]||this.config);if(next&&JSON.stringify(next)!==JSON.stringify(row)){changed=true;return next;}return row;});
    if(changed)this._compact(Date.now());this.labelSig=sig;
  }
  summary(){
    const counts={strong:0,weak:0,preStrong:0,preWeak:0,postStrong:0,postWeak:0};
    for(const r of this.rows){
      counts[r.label]++;
      const key=(r.phase==='before'?'pre':'post')+(r.label==='strong'?'Strong':'Weak');
      counts[key]++;
    }
    return {schema:1,updated:this.lastAt,eventMigration:this.eventMigration||null,cohortStart:this.cohortStart,status:'observational',
      origin:'server-verified-passed-only',
      settings:{...this.config},
      counts,pending:{...this.pending},bankCapacityPerClass:MAX_PER_CLASS};
  }
  aggregateCurves(){
    const result={before:[],after:[]},buckets={before:new Map(),after:new Map()};
    for(const row of this.rows){
      const grid=buckets[row.phase];
      if(!grid)continue;
      eachMinutePoint(row,(m,value)=>{
        if(m<1||m>(row.hours??5)*60)return;
        let x=grid.get(m);
        if(!x){x={sum:0,n:0};grid.set(m,x)}
        x.sum+=value;x.n++;
      });
    }
    for(const phase of ['before','after']){
      result[phase]=[...buckets[phase]].sort((a,b)=>a[0]-b[0])
        .map(([m,x])=>({min:m,pct:Math.round(x.sum/x.n*1000)/1000,n:x.n}));
    }
    return result;
  }
  select({phase,label,limit=10000}={}){
    if(phase&&!['before','after'].includes(phase))throw TypeError('bad phase');
    if(label&&!['strong','weak'].includes(label))throw TypeError('bad label');
    if(!Number.isInteger(limit)||limit<1||limit>20000)throw RangeError('bad limit');
    return this.rows.filter(x=>(!phase||x.phase===phase)&&(!label||x.label===label))
      .sort((a,b)=>b.zeroAt-a.zeroAt).slice(0,limit).map(r=>({...r,features:require('./research-v2').verifiedFeatures(r.features)}));
  }
}
function capPhases(rows){return ['before','after'].flatMap(phase=>capBank(rows.filter(r=>r.phase===phase),r=>r.label,'strong','weak',MAX_PER_CLASS))}
module.exports={ResearchTwoRuntime,configOf,lineClock,relabelStrength};
