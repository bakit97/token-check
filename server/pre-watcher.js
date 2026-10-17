'use strict';
const {PUMP,parsePumpLaunch,isTradeableCurve,isPumpCreateLog}=require('./pump-pre');

/**
 * Network-backed, read-only first public trading detector for Pump.fun.
 * The curve is created with liquidity, so public buys are possible immediately.
 * No mint-only events are accepted. No history scans: missed live signals
 * DO NOT enter the main source retroactively.
 */
class PumpPreWatcher {
  constructor({rpc,decode58,deriveCurve,source,onAdmitted,log=()=>{},queueLimit=600,retryDelays=[700,2200,5000],canObserve=()=>true}){
    if(typeof rpc!=='function'||typeof decode58!=='function'||typeof deriveCurve!=='function'||!source)throw TypeError('Incomplete adapter dependencies');
    this.canObserve=canObserve;this.rpc=rpc;this.decode58=decode58;this.deriveCurve=deriveCurve;
    this.source=source;this.onAdmitted=onAdmitted||(()=>{});this.log=log;
    this.queueLimit=queueLimit;this.retryDelays=retryDelays;
    this.queue=[];this.busy=false;this.started=false;this.pending=new Set();
    this.stats={logs:0,createLogs:0,processed:0,accepted:0,late:0,invalid:0,
      untradeable:0,errors:0,budgetDeferred:0,dropped:0,queuePeak:0,lastAt:0};
    this.seenSignatures=new Map();
  }
  onLog(value,observedAt=Date.now()){
    this.stats.logs++;
    if(!isPumpCreateLog(value))return false;
    this.stats.createLogs++;
    if(!this.canObserve()){this.stats.dropped++;return false}
    const signature=value.signature;
    if(this.seenSignatures.has(signature)||this.pending.has(signature))return false;
    if(this.queue.length>=this.queueLimit){this.stats.dropped++;return false}
    while(this.seenSignatures.size>=10000)this.seenSignatures.delete(this.seenSignatures.keys().next().value);
    this.seenSignatures.set(signature,observedAt);
    // Keep 30 minute dedup horizon; prevents reconnect replays.
    if(this.seenSignatures.size>10000)for(const [sig,time] of this.seenSignatures){
      if(observedAt-time>30*60000)this.seenSignatures.delete(sig);
    }
    this.pending.add(signature);
    this.queue.push({signature,observedAt});
    this.stats.queuePeak=Math.max(this.stats.queuePeak,this.queue.length);
    if(!this.busy)this.consume().catch(e=>this.log('pre-worker '+e.message));
    return true;
  }
  async transaction(signature){
    for(let n=0;n<=this.retryDelays.length;n++){
      try{
        const tx=await this.rpc('getTransaction',[signature,{encoding:'json',maxSupportedTransactionVersion:1,commitment:'confirmed'}]);
        if(tx)return tx;
      }catch(e){
        if(e.code==='BUDGET_DEFERRED'||n===this.retryDelays.length)throw e;
      }
      if(n<this.retryDelays.length)await new Promise(r=>setTimeout(r,this.retryDelays[n]));
    }
    return null;
  }
  async examine({signature,observedAt}){
    if(!this.canObserve()){this.stats.dropped++;return {admitted:false,reason:'resource-capacity'}}
    this.stats.processed++;
    let tx,launch;
    try{
      tx=await this.transaction(signature);
      if(!tx){this.stats.invalid++;return {admitted:false,reason:'missing-tx'}}
      launch=await parsePumpLaunch(tx,{
        decode58:this.decode58,deriveCurve:this.deriveCurve,signature,observedAt
      });
      if(!launch){this.stats.invalid++;return {admitted:false,reason:'not-public-launch'}}
      if(this.source.has(launch.mint))return {admitted:false,reason:'already-admitted'};
      if(observedAt-launch.blockAt>this.source.settings().beforeMinutes*60000){
        this.stats.late++;return {admitted:false,reason:'too-old'}
      }
      // Network proof: curve exists, is owned by Pump, has nonzero reserves
      // and is not completed. This is what allows ANYONE to publicly buy.
      const account=await this.rpc('getAccountInfo',[launch.curve,{encoding:'base64',commitment:'confirmed'}]);
      if(!isTradeableCurve(account?.value)){
        this.stats.untradeable++;return {admitted:false,reason:'curve-not-tradeable'}
      }
      const accepted=this.source.before({
        mint:launch.mint,publicTradingAt:launch.blockAt,
        observedAt:launch.observedAt,verified:true,
        proof:{family:'pump',signature:launch.signature,curve:launch.curve,
          slot:launch.slot,quote:launch.quote,name:launch.name,symbol:launch.symbol,
          kind:'pump-bonding-curve'}
      });
      if(accepted.admitted){
        this.stats.accepted++;this.stats.lastAt=Date.now();
        await this.onAdmitted(launch,accepted.record);
      }
      return accepted;
    }catch(e){
      if(e.code==='BUDGET_DEFERRED'){this.stats.budgetDeferred++;return {admitted:false,reason:'budget-deferred'}}
      this.stats.errors++;
      this.log('pump-pre '+String(e.message||e));
      return {admitted:false,reason:'error'};
    }
  }
  async consume(){
    if(this.busy)return;
    this.busy=true;
    try{
      while(this.queue.length){
        const task=this.queue.shift();
        try{await this.examine(task)}
        finally{this.pending.delete(task.signature)}
      }
    }finally{this.busy=false}
  }
  summary(){return {...this.stats,queue:this.queue.length,pending:this.pending.size};}
}
module.exports={PUMP,PumpPreWatcher};
