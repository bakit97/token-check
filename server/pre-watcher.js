'use strict';
const {PUMP,parsePumpLaunch,isTradeableCurve,isPumpCreateLog,parsePumpCreateEvents}=require('./pump-pre');

// Pump's official IDL: CreateEvent = discriminator, name, symbol, uri, mint.
// Discovery only; this never establishes public trading or admits a coin.
// https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
function mintFromCreateLog(value){
  if(!isPumpCreateLog(value))return null;
  const discriminator=Buffer.from([27,114,169,77,222,235,99,118]);
  const stack=[];
  for(const line of value.logs){
    const invoke=/^Program (\w+) invoke \[\d+\]$/.exec(line);
    if(invoke){stack.push(invoke[1]);continue}
    if(/^Program \w+ (?:success|failed:)/.test(line)){stack.pop();continue}
    if(stack.at(-1)!==PUMP||!line.startsWith('Program data: ')||line.length>16384)continue;
    const bytes=Buffer.from(line.slice(14),'base64');
    if(!bytes.subarray(0,8).equals(discriminator))continue;
    let offset=8,valid=true;
    for(let i=0;i<3;i++){
      if(offset+4>bytes.length){valid=false;break}
      const n=bytes.readUInt32LE(offset);offset+=4;
      if(n>4096||offset+n>bytes.length){valid=false;break}offset+=n;
    }
    if(!valid||offset+32>bytes.length)continue;
    const key=bytes.subarray(offset,offset+32),alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let n=BigInt('0x'+key.toString('hex')),result='';
    while(n){result=alphabet[Number(n%58n)]+result;n/=58n}
    for(const b of key){if(b!==0)break;result='1'+result}
    return result;
  }
  return null;
}

/**
 * Network-backed, read-only first public trading detector for Pump.fun.
 * The curve is created with liquidity, so public buys are possible immediately.
 * No mint-only events are accepted. No history scans: missed live signals
 * DO NOT enter the main source retroactively.
 */
class PumpPreWatcher {
  constructor({rpc,decode58,deriveCurve,source,onAdmitted,log=()=>{},queueLimit=600,retryDelays=[700,2200,5000],canObserve=()=>true,slotClock=null,telemetry=null,allowRPCFallback=false}){
    if(typeof rpc!=='function'||typeof decode58!=='function'||typeof deriveCurve!=='function'||!source)throw TypeError('Incomplete adapter dependencies');
    this.canObserve=canObserve;this.rpc=rpc;this.decode58=decode58;this.deriveCurve=deriveCurve;
    this.telemetry=telemetry;this.slotClock=slotClock;this.allowRPCFallback=allowRPCFallback;
    this.source=source;this.onAdmitted=onAdmitted||(()=>{});this.log=log;
    this.queueLimit=queueLimit;this.retryDelays=retryDelays;
    this.queue=[];this.busy=false;this.started=false;this.pending=new Set();
    this.stats={logs:0,createLogs:0,processed:0,accepted:0,late:0,invalid:0,
      untradeable:0,errors:0,budgetDeferred:0,dropped:0,unidentifiedMint:0,queuePeak:0,lastAt:0,logProofs:0,rpcCalls:0};
    this.seenSignatures=new Map();
  }
  onLog(value,observedAt=Date.now(),slot){
    this.stats.logs++;
    if(!isPumpCreateLog(value))return false;
    this.stats.createLogs++;this.telemetry?.received(slot,observedAt);
    const mint=mintFromCreateLog(value);
    if(mint)this.source.observe?.({mint,phase:'before'});
    else this.stats.unidentifiedMint++;
    const events=parsePumpCreateEvents(value,{slot,observedAt});
    for(const event of events)this.telemetry?.event(event.mint,'create',observedAt);
    if(!this.canObserve()){this.stats.dropped++;return false}
    if(!events.length&&!this.allowRPCFallback){this.stats.invalid++;return false}
    const signature=value.signature;
    if(this.seenSignatures.has(signature)||this.pending.has(signature))return false;
    if(this.queue.length+(events.length||1)>this.queueLimit){this.stats.dropped+=events.length||1;return false}
    while(this.seenSignatures.size>=10000)this.seenSignatures.delete(this.seenSignatures.keys().next().value);
    this.seenSignatures.set(signature,observedAt);
    // Keep 30 minute dedup horizon; prevents reconnect replays.
    if(this.seenSignatures.size>10000)for(const [sig,time] of this.seenSignatures){
      if(observedAt-time>30*60000)this.seenSignatures.delete(sig);
    }
    for(const event of events.length?events:[null]){
      const key=signature+':'+(event?.mint||'legacy');this.pending.add(key);
      this.queue.push({signature,observedAt,event,key});
      if(event)this.source.observe?.({mint:event.mint,phase:'before'});
    }
    this.stats.queuePeak=Math.max(this.stats.queuePeak,this.queue.length);
    if(!this.busy)this.consume().catch(e=>this.log('pre-worker '+e.message));
    return true;
  }
  async transaction(signature){
    if(!this.allowRPCFallback)throw Error('RPC fallback disabled for Pump pre');
    for(let n=0;n<=this.retryDelays.length;n++){
      try{
        this.stats.rpcCalls++;const tx=await this.rpc('getTransaction',[signature,{encoding:'json',maxSupportedTransactionVersion:1,commitment:'confirmed'}]);
        if(tx)return tx;
      }catch(e){
        if(e.code==='BUDGET_DEFERRED'||n===this.retryDelays.length)throw e;
      }
      if(n<this.retryDelays.length)await new Promise(r=>setTimeout(r,this.retryDelays[n]));
    }
    return null;
  }
  async examine({signature,observedAt,event}){
    if(!this.canObserve()){this.stats.dropped++;return {admitted:false,reason:'resource-capacity'}}
    this.stats.processed++;
    if(!this.allowRPCFallback||event)return this.examineLog(event,observedAt);
    let tx,launch;
    try{
      tx=await this.transaction(signature);
      if(!tx){this.stats.invalid++;return {admitted:false,reason:'missing-tx'}}
      launch=await parsePumpLaunch(tx,{
        decode58:this.decode58,deriveCurve:this.deriveCurve,signature,observedAt
      });
      if(!launch){this.stats.invalid++;return {admitted:false,reason:'not-public-launch'}}
      this.source.observe?.({mint:launch.mint,phase:'before'});
      if(this.source.has(launch.mint))return {admitted:false,reason:'already-admitted'};
      if(observedAt-launch.blockAt>this.source.settings().beforeMinutes*60000){
        this.source.observe?.({mint:launch.mint,phase:'before',outcome:'tooOld',lateMs:observedAt-launch.blockAt-this.source.settings().beforeMinutes*60000});
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
  async examineLog(event,observedAt){
    if(!event){this.stats.invalid++;return {admitted:false,reason:'missing-create-event'}}
    try{
      const slotTime=this.slotClock?.estimate(event.slot,observedAt),blockAt=slotTime?.at||event.blockAt;
      const allowed=this.source.settings().beforeMinutes*60000;
      if((slotTime&&slotTime.ageMs>allowed+30000)||(event.blockAt&&observedAt-event.blockAt>allowed)){
        const age=Math.max(slotTime?.ageMs||0,event.blockAt?observedAt-event.blockAt:0);
        this.source.observe?.({mint:event.mint,phase:'before',outcome:'tooOld',lateMs:age-allowed});this.stats.late++;
        return {admitted:false,reason:'too-old'};
      }
      if(!Number.isSafeInteger(blockAt)||blockAt>observedAt||await this.deriveCurve(event.mint)!==event.curve){this.stats.invalid++;return {admitted:false,reason:'invalid-create-proof'}}
      const launch={...event,blockAt},accepted=this.source.before({mint:event.mint,publicTradingAt:blockAt,observedAt,verified:true,
        proof:{family:'pump',signature:event.signature,curve:event.curve,slot:event.slot,quote:event.quote,name:event.name,symbol:event.symbol,kind:'pump-create-event',timeSource:slotTime?'slot-estimate':'pump-event-timestamp',reportedEventAt:event.blockAt||null}});
      if(accepted.admitted){this.telemetry?.event(event.mint,'accepted',observedAt);this.stats.accepted++;this.stats.logProofs++;this.stats.lastAt=Date.now();await this.onAdmitted(launch,accepted.record)}
      return accepted;
    }catch(e){this.stats.errors++;this.log('pump-pre log '+String(e.message||e));return {admitted:false,reason:'error'}}
  }
  async consume(){
    if(this.busy)return;
    this.busy=true;
    try{
      while(this.queue.length){
        const task=this.queue.shift();
        try{await this.examine(task)}
        finally{this.pending.delete(task.key||task.signature)}
      }
    }finally{this.busy=false}
  }
  summary(){return {...this.stats,daily:this.telemetry?.summary()||null,mode:this.allowRPCFallback?'legacy-rpc-test':'create-event-no-rpc',queue:this.queue.length,pending:this.pending.size};}
}
module.exports={PUMP,PumpPreWatcher};
