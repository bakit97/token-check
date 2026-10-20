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
  const cfg={missPenalty:raw.missPenalty??3,minAbove:raw.minAbove??70,minCoverage:raw.minCoverage??.9,decisionMinutes:raw.decisionMinutes??5,targetStrong:raw.targetStrong??40,targetWeak:raw.targetWeak??40};
  if(typeof cfg.minAbove!=='number'||cfg.minAbove<0||cfg.minAbove>100||
     typeof cfg.minCoverage!=='number'||cfg.minCoverage<.5||cfg.minCoverage>1)
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
  if(!Array.isArray(values)||values.length!==300)return null;
  // 300 * float32 = 1200 bytes, compared with thousands of JSON numbers.
  // NaN is only an internal missing-value marker and never exported as a price.
  const bytes=Buffer.allocUnsafe(1200);
  for(let i=0;i<300;i++){
    const value=values[i];
    bytes.writeFloatLE(Number.isFinite(value)?value:NaN,i*4);
  }
  return bytes.toString('base64');
}
function eachMinutePoint(row,visit){
  if(typeof row.minuteCurvePacked==='string'){
    const bytes=Buffer.from(row.minuteCurvePacked,'base64');
    if(bytes.length!==1200)throw Error('Corrupted compact minute curve');
    for(let i=0;i<300;i++){
      const v=bytes.readFloatLE(i*4);
      if(Number.isFinite(v))visit(i+1,v);
    }
    return;
  }
  if(Array.isArray(row.minuteCurve)&&row.minuteCurve.length===300){
    for(let i=0;i<300;i++){
      const v=row.minuteCurve[i];
      if(Number.isFinite(v))visit(i+1,v);
    }
    return;
  }
  for(const point of row.curve||[])
    if(Array.isArray(point)&&Number.isInteger(point[0])&&Number.isFinite(point[1]))
      visit(point[0],point[1]);
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
             (typeof row.minuteCurvePacked!=='string'||Buffer.from(row.minuteCurvePacked,'base64').length!==1200)))
          throw Error('Corrupted second-level research row');
      }
      this.rows=capPhases(data.rows);
      for(const pair of data.processed||[])
        if(Array.isArray(pair)&&typeof pair[0]==='string'&&Number.isSafeInteger(pair[1]))
          this.processed.set(pair[0],pair[1]);
      for(const row of this.rows)this.processed.set(row.mint,row.zeroAt);
    }
    this._replayJournal();
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
        if(this.processed.get(row.mint)!==row.zeroAt)
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
    const fd=fs.openSync(this.journalFile,'a+');
    try{fs.ftruncateSync(fd,0);fs.fsyncSync(fd)}
    finally{fs.closeSync(fd)}
    this.journalCount=0;this.compactedAt=now;
  }
  update({passes,coins,now=Date.now()}={}){
    if(!passes?.records||!coins?.get)throw TypeError('Need verified pass journal and candidate map');
    let added=0,attempted=0,considered=0;
    const pending={},newRows=[];
    for(const pass of passes.records.values()){
      if(!pass||pass.firstSeenAt<this.cohortStart||pass.firstSeenAt>=this.cohortEnd||this.processed.has(pass.mint)||now-pass.zeroAt>FRESH||
         now<pass.zeroAt)continue;
      considered++;
      if(now<pass.zeroAt+5*HOUR+MIN){
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
      const cfg=this.config.phases?.[pass.phase]||this.config;
      const result=strengthOutcome(coin,pass.zeroAt,cfg,now);
      if(result.label==='pending'){
        this.retry.set(pass.mint,{at:now,zeroAt:pass.zeroAt,reason:result.why});
        pending[result.why]=(pending[result.why]||0)+1;
        continue;
      }
      this.retry.delete(pass.mint);
      // Level-two conditions and versions were frozen at first Passed.
      // Their metrics use only observations up to the fixed zeroAt.
      const featureAt=eventAnchor(pass)+cfg.decisionMinutes*MIN;
      const F=levelTwoFeaturesAt(coin,featureAt,{entryAt:eventAnchor(pass),acceptedAt:eventAnchor(pass),phase:pass.phase});
      const secondLevelMatches=(pass.secondLevelRules||[])
        .filter(f=>evaluation(F,f)==='pass').map(f=>({...f}));
      newRows.push({
        mint:pass.mint,phase:pass.phase,p:pass.p||coin.p||null,pair:pass.pair||coin.p||null,phaseEpoch:pass.phaseEpoch||null,acceptedAt:pass.acceptedAt,
        firstSeenAt:pass.firstSeenAt,zeroAt:pass.zeroAt,decisionAt:featureAt,outcomeAt:now,windowEnd:pass.zeroAt+300*MIN,earlyWallets:require('./early-intelligence').frozenWallets(coin,featureAt),featureAnchor:'eventAt',eventAt:eventAnchor(pass),featureTimesPacked:require('./module-library').freezeFeatureTimes(coin,eventAnchor(pass),'2',pass.phase),sourceFilterRules:pass.matches.map(f=>({...f})),
        configHash:pass.configHash,sourceFilterVersions:pass.matches.map(f=>({
          id:f.id,version:f.version,level:f.level
        })),
        label:result.label,secondLevelMatches,
        pctAbove:result.pctAbove,covered:result.covered,
        p0:result.p0,curve:[[0,0],...result.curve],minuteCurvePacked:packMinuteCurve(result.minuteCurve),features:F,
        firstPassFeatures:{...pass.features},
        threshold:cfg.minAbove,coverageThreshold:cfg.minCoverage,
        time:pass.zeroAt
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
  summary(){
    const counts={strong:0,weak:0,preStrong:0,preWeak:0,postStrong:0,postWeak:0};
    for(const r of this.rows){
      counts[r.label]++;
      const key=(r.phase==='before'?'pre':'post')+(r.label==='strong'?'Strong':'Weak');
      counts[key]++;
    }
    return {schema:1,updated:this.lastAt,cohortStart:this.cohortStart,status:'observational',
      origin:'server-verified-passed-only',
      settings:{...this.config,hours:5},
      counts,pending:{...this.pending},bankCapacityPerClass:MAX_PER_CLASS};
  }
  aggregateCurves(){
    const result={before:[],after:[]},buckets={before:new Map(),after:new Map()};
    for(const row of this.rows){
      const grid=buckets[row.phase];
      if(!grid)continue;
      eachMinutePoint(row,(m,value)=>{
        if(m<1||m>300)return;
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
module.exports={ResearchTwoRuntime,configOf};
