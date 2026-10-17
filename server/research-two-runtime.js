'use strict';
// Level 2 starts ONLY from durable server Passed events after their zeroAt.
// Price is observational; incomplete periods have no strong/weak label.
const fs=require('node:fs');
const path=require('node:path');
const {strengthOutcome,capBank,evaluation}=require('./research-v2');

const MIN=60000,HOUR=60*MIN,FRESH=48*HOUR,RETRY=15*MIN;
const MAX_PER_CLASS=5000,MAX_CHECKS=200;
function configOf(raw={}){
  const cfg={minAbove:raw.minAbove??70,minCoverage:raw.minCoverage??.9};
  if(typeof cfg.minAbove!=='number'||cfg.minAbove<0||cfg.minAbove>100||
     typeof cfg.minCoverage!=='number'||cfg.minCoverage<.5||cfg.minCoverage>1)
    throw RangeError('Invalid level-two research config');
  return cfg;
}
function durableJSON(file,value){
  const temporary=file+'.tmp',buf=Buffer.from(JSON.stringify(value));
  const fd=fs.openSync(temporary,'w',0o600);
  try{let n=0;while(n<buf.length)n+=fs.writeSync(fd,buf,n,buf.length-n);fs.fsyncSync(fd)}
  finally{fs.closeSync(fd)}
  fs.renameSync(temporary,file);
  const d=fs.openSync(path.dirname(file),'r');
  try{fs.fsyncSync(d)}finally{fs.closeSync(d)}
}
class ResearchTwoRuntime {
  constructor({dir,config}={}){
    if(!dir)throw TypeError('Research-two directory required');
    fs.mkdirSync(dir,{recursive:true});
    this.file=path.join(dir,'research-v2-bank-two.json');
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
           !Number.isFinite(row.covered)||!row.features||typeof row.features!=='object')
          throw Error('Corrupted second-level research row');
      }
      this.rows=capBank(data.rows,r=>r.label,'strong','weak',MAX_PER_CLASS);
      for(const pair of data.processed||[])
        if(Array.isArray(pair)&&typeof pair[0]==='string'&&Number.isSafeInteger(pair[1]))
          this.processed.set(pair[0],pair[1]);
      for(const row of this.rows)this.processed.set(row.mint,row.zeroAt);
    }
  }
  update({passes,coins,now=Date.now()}={}){
    if(!passes?.records||!coins?.get)throw TypeError('Need verified pass journal and candidate map');
    let added=0,attempted=0,considered=0;
    const pending={};
    for(const pass of passes.records.values()){
      if(!pass||this.processed.has(pass.mint)||now-pass.zeroAt>FRESH||
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
      const result=strengthOutcome(coin,pass.zeroAt,this.config,now);
      if(result.label==='pending'){
        this.retry.set(pass.mint,{at:now,zeroAt:pass.zeroAt,reason:result.why});
        pending[result.why]=(pending[result.why]||0)+1;
        continue;
      }
      this.retry.delete(pass.mint);
      // Level-two modules are applied ONLY to a completed, verified
      // Passed cohort. They cannot manufacture a fresh first-level signal.
      const settings=passes.config,available=new Map(
        (settings?.filters||[]).filter(f=>f.level==='2').map(f=>[f.id,f]));
      const secondLevelMatches=(settings?.modules||[])
        .filter(m=>m.enabled&&m.level==='2'&&m.phase===pass.phase)
        .map(m=>available.get(m.filterId)).filter(Boolean)
        .filter(f=>evaluation(pass.features,f)==='pass')
        .map(f=>({...f}));
      this.rows.push({
        mint:pass.mint,phase:pass.phase,acceptedAt:pass.acceptedAt,
        firstSeenAt:pass.firstSeenAt,zeroAt:pass.zeroAt,
        configHash:pass.configHash,sourceFilterVersions:pass.matches.map(f=>({
          id:f.id,version:f.version,level:f.level
        })),
        label:result.label,secondLevelMatches,
        pctAbove:result.pctAbove,covered:result.covered,
        p0:result.p0,curve:result.curve,features:{...pass.features},
        threshold:this.config.minAbove,coverageThreshold:this.config.minCoverage,
        time:pass.zeroAt
      });
      this.processed.set(pass.mint,pass.zeroAt);
      added++;
    }
    for(const [mint,zeroAt] of this.processed)
      if(now-zeroAt>FRESH)this.processed.delete(mint);
    for(const [mint,last] of this.retry)
      if(now-last.zeroAt>FRESH)this.retry.delete(mint);
    if(added){
      this.rows=capBank(this.rows,r=>r.label,'strong','weak',MAX_PER_CLASS);
      durableJSON(this.file,{schema:1,rows:this.rows,processed:[...this.processed],updated:now});
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
    return {schema:1,updated:this.lastAt,status:'observational',
      origin:'server-verified-passed-only',
      settings:{...this.config,hours:5},
      counts,pending:{...this.pending},bankCapacityPerClass:MAX_PER_CLASS};
  }
  select({phase,label,limit=10000}={}){
    if(phase&&!['before','after'].includes(phase))throw TypeError('bad phase');
    if(label&&!['strong','weak'].includes(label))throw TypeError('bad label');
    if(!Number.isInteger(limit)||limit<1||limit>10000)throw RangeError('bad limit');
    return this.rows.filter(x=>(!phase||x.phase===phase)&&(!label||x.label===label))
      .sort((a,b)=>b.zeroAt-a.zeroAt).slice(0,limit);
  }
}
module.exports={ResearchTwoRuntime,configOf};
