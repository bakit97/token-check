'use strict';
// Local estimates, not provider billing. Fail closed on damaged accounting.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const MIN=60000;
const RPC_COST={getProgramAccounts:10,getTransaction:10,getSignaturesForAddress:10,
  getBlock:10,getBlocks:10,getBlocksWithLimit:10,getInflationReward:10};
const rpcCost=method=>RPC_COST[method]||1;
class BudgetDeferred extends Error{constructor(){super('Helius budget: observation deferred');this.code='BUDGET_DEFERRED'}}
function atomic(file,obj){const fd=fs.openSync(file+'.tmp','w');try{fs.writeFileSync(fd,JSON.stringify(obj));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(file+'.tmp',file);if(process.platform!=='win32'){const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}}}
class ResourceBudget{
  constructor({dir,now=Date.now,env=process.env}={}){
    this.now=now;this.file=path.join(dir,'resource-budget.json');
    this.limit=1000000;this.perMinute=Math.min(20,Number(env.HELIUS_CREDITS_PER_MINUTE||20));
    this.wsPerMB=20;this.wsAllowance=0;
    const at=now();this.state={schema:1,used:Number(env.HELIUS_USED_CREDITS||174302),
      resetAt:Date.parse(env.HELIUS_RESET_AT||'2026-11-14T00:00:00Z'),
      baselineCredits:Number(env.HELIUS_USED_CREDITS||174302),since:at,buckets:[],gcsMonth:new Date(at).toISOString().slice(0,7),
      gcsUsed:Number(env.GCS_CLASS_A_USED||0),gcsNext:at,gcsHour:[],gcsSuccessHour:[],deferred:0};
    if(fs.existsSync(this.file)){this.state=JSON.parse(fs.readFileSync(this.file,'utf8'));}
    const s=this.state;s.gcsSuccessHour=s.gcsSuccessHour||[];
    if(s.schema!==1||!Number.isFinite(s.used)||s.used<0||!Number.isFinite(s.resetAt)||
       !Array.isArray(s.buckets)||!Array.isArray(s.gcsHour)||!Number.isFinite(s.gcsUsed)||
       !Number.isFinite(s.gcsNext)||!Number.isFinite(s.since)||!Number.isFinite(this.perMinute)||this.perMinute<=0||
       s.buckets.some(b=>!Number.isFinite(b.at)||!Number.isFinite(b.rpc)||!Number.isFinite(b.ws)||b.rpc<0||b.ws<0))throw Error('Invalid resource budget ledger');
    this.persist();
  }
  persist(){atomic(this.file,this.state)}
  trim(){const t=this.now();this.state.buckets=this.state.buckets.filter(b=>b.at>=Math.floor(t/MIN)*MIN-60*MIN);
    this.state.gcsHour=this.state.gcsHour.filter(x=>x>t-60*MIN);
    this.state.gcsSuccessHour=this.state.gcsSuccessHour.filter(x=>x>t-60*MIN);
    const month=new Date(t).toISOString().slice(0,7);
    if(month!==this.state.gcsMonth){this.state.gcsMonth=month;this.state.gcsUsed=0;this.state.gcsNext=t;}}
  totals(window){this.trim();const cutoff=Math.floor(this.now()/MIN)*MIN-window;
    return this.state.buckets.filter(b=>b.at>=cutoff).reduce((a,b)=>({rpc:a.rpc+b.rpc,ws:a.ws+b.ws}),{rpc:0,ws:0});}
  rate(){const remaining=Math.max(0,this.limit-this.state.used),minutes=(this.state.resetAt-this.now())/MIN;
    return minutes>0?Math.max(0,Math.min(this.perMinute,remaining/minutes*.97)):0;}
  summary(){const h=this.totals(59*MIN),m=this.totals(MIN),minutes=Math.max(1,Math.min(60,(this.now()-this.state.since)/MIN));
    const observed=(h.rpc+h.ws)/minutes,remainingMinutes=Math.max(0,(this.state.resetAt-this.now())/MIN);
    return {estimate:true,baselineCredits:this.state.baselineCredits??174302,limit:this.limit,usedEstimated:this.state.used,
      resetAt:this.state.resetAt,remainingDays:remainingMinutes/1440,creditsMinute:m.rpc+m.ws,
      rpcCreditsHour:h.rpc,wsCreditsHour:h.ws,targetCreditsMinute:this.rate(),
      projectedAtReset:Math.ceil(this.state.used+observed*remainingMinutes),
      overForecast:this.state.used+observed*remainingMinutes>this.limit,
      resetRequired:this.now()>=this.state.resetAt,deferred:this.state.deferred};}
  allow(cost,priority=0){const m=this.totals(MIN),h=this.totals(59*MIN),rate=this.rate();
    // Preserve room for stream delivery and new proofs; background is shed first.
    const ceiling=Math.min(this.perMinute,rate),rpcCeiling=Math.max(0,ceiling-1);
    const s=this.summary(),share=priority===0?1:priority===1?.65:.3;
    if(this.state.used+cost>this.limit||rate===0||m.rpc+m.ws+cost>rpcCeiling||
       h.rpc+h.ws+cost>rate*60||
       (priority>0&&(m.rpc+m.ws+cost>rpcCeiling*share||s.overForecast))){this.state.deferred++;return false}
    return true;
  }
  charge(cost,type){this.trim();const at=Math.floor(this.now()/MIN)*MIN;let b=this.state.buckets.find(b=>b.at===at);
    if(!b)this.state.buckets.push(b={at,rpc:0,ws:0});b[type]+=cost;this.state.used+=cost;this.persist();}
  reserveRPC(method,priority){const cost=rpcCost(method);if(!this.allow(cost,priority))throw new BudgetDeferred();this.charge(cost,'rpc');return cost;}
  stream(bytes){
    this.wsAllowance-=bytes;
    if(this.wsAllowance<0){const reserve=Math.ceil(-this.wsAllowance/32768)*32768;this.wsAllowance+=reserve;this.charge(reserve/1e6*this.wsPerMB,'ws');}
    const m=this.totals(MIN);return this.rate()>0&&this.state.used<this.limit&&m.rpc+m.ws<this.perMinute;
  }
  streamAllowed(){const m=this.totals(MIN);return this.rate()>0&&this.state.used<this.limit&&m.rpc+m.ws<this.rate()-1;}
  reserveWrite(){this.trim();const t=this.now(),d=new Date(t),end=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);
    // Keep 1,000 operations for deployments/control/other clients; no borrowing.
    if(this.state.gcsUsed>=4000||t<this.state.gcsNext)return false;
    const gap=Math.max(60000,(end-t)/Math.max(1,4000-this.state.gcsUsed));
    this.state.gcsUsed++;this.state.gcsNext=t+gap;this.state.gcsHour.push(t);this.persist();return true;
  }
  storageSummary(){this.trim();return {estimate:true,month:this.state.gcsMonth,classAAttempts:this.state.gcsUsed,
    collectorMonthlyCap:4000,reservedForOtherClients:1000,writeAttemptsHour:this.state.gcsHour.length,uploadsHour:this.state.gcsSuccessHour.length,nextWriteAt:this.state.gcsNext,
    billingVerified:false};}
}

class PublicationQueue{
  constructor({dir,budget,send,now=Date.now,maxBytes=128*1024*1024,maxFiles=1000}){
    this.dir=path.join(dir,'publish-spool');fs.mkdirSync(this.dir,{recursive:true});
    this.manifest=path.join(this.dir,'index.json');this.budget=budget;this.send=send;this.now=now;
    this.maxBytes=maxBytes;this.maxFiles=maxFiles;this.busy=false;this.skipped=0;this.rejected=0;
    this.items=fs.existsSync(this.manifest)?JSON.parse(fs.readFileSync(this.manifest,'utf8')):{};
    this.sent={};this.serial=Promise.resolve();
  }
  enqueue(name,body,hash,contentType='application/json'){
    const run=()=>{const old=this.items[name];
      if(old?.hash===hash||this.sent[name]?.hash===hash){this.skipped++;return false}
      const size=Object.values(this.items).reduce((s,x)=>s+x.bytes,0)-(old?.bytes||0)+body.length;
      if(size>this.maxBytes||(!old&&Object.keys(this.items).length>=this.maxFiles)){this.rejected++;throw Error('Publication spool full: local journals retained')}
      const id=crypto.createHash('sha256').update(name).digest('hex');
      const fd=fs.openSync(path.join(this.dir,id+'.tmp'),'w');try{fs.writeFileSync(fd,body);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(path.join(this.dir,id+'.tmp'),path.join(this.dir,id));
      this.items[name]={id,hash,bytes:body.length,queuedAt:old?.queuedAt??this.now(),contentType};atomic(this.manifest,this.items);return true;};
    const p=this.serial.then(run);this.serial=p.catch(()=>{});return p;
  }
  async flush(){if(this.busy)return;this.busy=true;try{
    await this.serial;const names=Object.keys(this.items).sort((a,b)=>this.items[a].queuedAt-this.items[b].queuedAt);
    // Heartbeat receives one in every five slots; the rest rotate fairly.
    const status=names.includes('status.json')&&this.budget.state.gcsUsed%5===0;
    const name=status?'status.json':names[0];if(!name||!this.budget.reserveWrite())return;
    const item=this.items[name],body=fs.readFileSync(path.join(this.dir,item.id));
    await this.send(name,body,item.contentType);
    this.budget.state.gcsSuccessHour.push(this.now());this.budget.persist();
    this.sent[name]={hash:item.hash,at:this.now()};
    // An enqueue may replace an object while the network request is in flight.
    if(this.items[name]===item){delete this.items[name];atomic(this.manifest,this.items);fs.unlinkSync(path.join(this.dir,item.id));}
    if(Object.keys(this.sent).length>1000)delete this.sent[Object.keys(this.sent)[0]];
  }finally{this.busy=false}}
  summary(){return {pending:Object.keys(this.items).length,bytes:Object.values(this.items).reduce((s,x)=>s+x.bytes,0),
    unchangedSkipped:this.skipped,rejected:this.rejected,latestPublished:Object.fromEntries(Object.entries(this.sent).map(([n,x])=>[n,x.at]))};}
}
function researchJob({dir,kind,rows,options}){
  const {Worker}=require('node:worker_threads');
  return new Promise((resolve,reject)=>{
    const worker=new Worker(`
      const {parentPort,workerData:d}=require('node:worker_threads');
      try{
        const result=d.kind==='audit'
          ?new (require(d.dir+'/filter-audit.js').FilterAudit)({dir:d.dir}).report(d.options)
          :require(d.dir+'/auto-research-v2.js').discover(d.rows,d.options);
        parentPort.postMessage({result});
      }catch(e){parentPort.postMessage({error:e.message})}
    `,{eval:true,workerData:{dir,kind,rows,options},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:48,maxYoungGenerationSizeMb:8}});
    const timer=setTimeout(()=>{worker.terminate();reject(Error('Hourly research time budget exceeded'))},120000);
    worker.once('message',m=>{clearTimeout(timer);worker.terminate();m.error?reject(Error(m.error)):resolve(m.result)});
    worker.once('error',e=>{clearTimeout(timer);reject(e)});
    worker.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error('Research worker exited '+code))});
  });
}
module.exports={ResourceBudget,PublicationQueue,BudgetDeferred,rpcCost,researchJob};
