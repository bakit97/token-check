'use strict';
const fs=require('node:fs'),path=require('node:path');
// Independent, small replay ledger. A failed read/proof never advances a cursor.
class MigrationCatchup{
 constructor({dir,addresses,rpc,process,decode58,knownSignature=()=>false,processManual=null,seeds=[],now=Date.now}){
  this.file=path.join(dir,'migration-catchup.json');this.rpc=rpc;this.process=process;this.processManual=processManual;this.decode58=decode58;this.now=now;this.knownSignature=knownSignature;this.busy=false;this.turn=0;
  let saved;try{saved=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const at=now();this.startedAt=at;this.stats={pages:0,transactions:0,candidates:0,caughtUp:0,alreadyKnown:0,errors:0,lastError:null,lastAt:null,manualPages:0,manualAccepted:0,manualErrors:0,manualCapacityDeferred:0};
  this.state={schema:1,pools:Array.isArray(saved?.pools)?saved.pools.slice(-64):[],lastOnlineAt:at,lanes:addresses.map(({kind,address})=>{const old=saved?.lanes?.find(x=>x.kind===kind&&x.address===address);return old&&!old.done?{...old,nextFrom:Math.min(old.nextFrom||Infinity,Math.max(1,(saved.lastOnlineAt||old.to)-60000)),nextTo:at}:{kind,address,from:Math.max(1,(saved?.lastOnlineAt||at-12*3600000)-60000),to:at,before:null,rows:[],done:false};})};for(const seed of seeds)this.offerPool({...seed,requested:true});this.save();
 }
 save(){const tmp=this.file+'.tmp',fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(this.state));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,this.file);}
 heartbeat(){this.state.lastOnlineAt=this.now();this.save();}
 offerPool({pool,signature=null,createdAt=null,requested=false}={}){if(typeof pool!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool)||signature&&!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature))return false;if(createdAt!=null&&(!Number.isFinite(createdAt)||createdAt>this.now()||!requested&&this.now()-createdAt>24*3600000))return false;const old=this.state.pools.find(x=>x.pool===pool);if(old)return true;if(this.state.pools.length>=64){const done=this.state.pools.findIndex(x=>x.done);if(done>=0)this.state.pools.splice(done,1);else{this.stats.manualCapacityDeferred++;return false;}}this.state.pools.push({pool,createdAt,requested,signatures:signature?[signature]:[],proofReady:!!signature,pages:0,before:null,at:this.now(),nextAt:0,attempts:0,done:false});this.save();return true;}
 async tickPool(job){this.busy=true;try{
  if(!job.proofReady){const rows=await this.rpc('getSignaturesForAddress',[job.pool,{limit:1000,commitment:'confirmed',...(job.before?{before:job.before}:{})}]);if(!Array.isArray(rows)||rows.some(r=>!r.signature||!Number.isSafeInteger(r.blockTime)))throw Object.assign(Error('manual history unavailable'),{code:'HISTORY_UNAVAILABLE'});if(!rows.length&&!job.pages)throw Object.assign(Error('manual history unavailable'),{code:'HISTORY_UNAVAILABLE'});const earliest=rows.filter(r=>r.err===null).reverse().slice(0,8).map(r=>r.signature);job.signatures=[...earliest,...job.signatures].slice(0,8);job.pages++;this.stats.manualPages++;if(rows.length&&job.before===rows.at(-1).signature)throw Object.assign(Error('manual history cursor repeated'),{code:'HISTORY_NOT_ADVANCING'});if(rows.length)job.before=rows.at(-1).signature;job.proofReady=rows.length<1000;job.nextAt=this.now()+2000;this.save();return;}
  if(!job.signatures.length){job.done=true;job.reason='creation-proof-unavailable';this.save();return;}
  const result=await this.processManual({kind:'manual-catchup',signature:job.signatures[0],expectedPool:job.pool,explicitRecovery:job.requested===true,receivedAt:this.now(),caughtUpAfterDowntime:true,catchupFrom:this.startedAt});const outcome=result?.outcome;
  if(outcome==='accepted'){this.stats.manualAccepted++;job.done=true;job.reason='accepted';}else if(['already-admitted','rejected-side-pool','migration-excluded','outside-catchup-window','creation-not-funded'].includes(outcome)){job.done=true;job.reason=outcome;}else if(outcome==='not-direct-sol-pool'){job.signatures.shift();job.reason='creation-proof-pending';}else throw Object.assign(Error('manual proof incomplete'),{code:'PROOF_PENDING'});job.nextAt=this.now()+2000;job.attempts=0;this.stats.lastAt=this.now();this.save();
 }catch(e){this.stats.manualErrors++;job.attempts++;job.reason=/^[A-Z0-9_]{1,48}$/.test(e.code||'')?e.code:'MANUAL_REPLAY_READ_FAILED';job.nextAt=this.now()+Math.min(300000,15000*2**Math.min(job.attempts,4));this.save();}finally{this.busy=false;}}
 async tick(){if(this.busy)return;const manual=this.processManual&&this.state.pools.filter(x=>!x.done&&x.nextAt<=this.now()).sort((a,b)=>a.nextAt-b.nextAt)[0];if(manual&&(this.turn%3===0||this.state.lanes.every(x=>x.done))){this.turn++;return this.tickPool(manual);}const lane=this.state.lanes.filter(x=>!x.done)[this.turn++%Math.max(1,this.state.lanes.filter(x=>!x.done).length)];if(!lane)return;this.busy=true;
  try{
   if(!lane.rows.length){const rows=await this.rpc('getSignaturesForAddress',[lane.address,{limit:100,commitment:'confirmed',...(lane.before?{before:lane.before}:{})}]);if(!Array.isArray(rows))throw Object.assign(Error('invalid signatures'),{code:'INVALID_SIGNATURES'});
    // Empty history is not proof that the requested interval was scanned.
    if(!rows.length)throw Object.assign(Error('history unavailable'),{code:'HISTORY_UNAVAILABLE'});
    if(rows.some(x=>!x.signature||!Number.isSafeInteger(x.slot)||!Number.isSafeInteger(x.blockTime)))throw Object.assign(Error('history time missing'),{code:'HISTORY_TIME_MISSING'});
    lane.rows=rows;this.stats.pages++;this.save();
   }
   for(let n=0;n<20&&lane.rows.length&&lane.rows[0].blockTime*1000>=lane.from&&(lane.rows[0].blockTime*1000>lane.to||lane.rows[0].err!==null||this.knownSignature(lane.rows[0].signature));n++){const known=lane.rows.shift();lane.before=known.signature;lane.lastSlot=known.slot;lane.lastEventAt=known.blockTime*1000;if(this.knownSignature(known.signature))this.stats.alreadyKnown++;}if(!lane.rows.length){this.save();return;}
   const row=lane.rows[0];
   if(row.blockTime*1000<lane.from){if(lane.nextFrom){lane.from=lane.nextFrom;lane.to=lane.nextTo;lane.before=null;lane.rows=[];delete lane.nextFrom;delete lane.nextTo;}else{lane.done=true;lane.rows=[];}this.save();return;}
   if(row.err===null&&row.blockTime*1000<=lane.to){
    const tx=await this.rpc('getTransaction',[row.signature,{encoding:'json',maxSupportedTransactionVersion:1,commitment:'confirmed'}]);if(!tx)throw Object.assign(Error('transaction pending'),{code:'TX_PENDING'});
    this.stats.transactions++;const candidates=require('./migration-fast').migrationCandidates(tx,this.decode58);this.stats.candidates+=candidates.length;
    if(candidates.length){const result=await this.process({kind:lane.kind,signature:row.signature,slot:row.slot,receivedAt:this.now(),caughtUpAfterDowntime:true,catchupFrom:this.startedAt,proofs:{[row.signature]:candidates}});if(result?.outcome==='accepted')this.stats.caughtUp++;else if(result?.outcome==='already-admitted')this.stats.alreadyKnown++;else if(result?.outcome!=='rejected-not-graduated')throw Object.assign(Error('proof incomplete'),{code:'PROOF_PENDING'});}
   }
   lane.before=row.signature;lane.lastSlot=row.slot;lane.lastEventAt=row.blockTime*1000;lane.rows.shift();this.stats.lastError=null;this.stats.lastAt=this.now();this.save();
  }catch(e){this.stats.errors++;this.stats.lastError=/^[A-Z0-9_]{1,48}$/.test(e.code||'')?e.code:'REPLAY_READ_FAILED';}finally{this.busy=false;}
 }
 summary(){return {startedAt:this.startedAt,...this.stats,busy:this.busy,manual:{queued:this.state.pools.filter(x=>!x.done).length,completed:this.state.pools.filter(x=>x.done).length,oldestAgeMs:Math.max(0,...this.state.pools.filter(x=>!x.done).map(x=>this.now()-x.at)),recent:this.state.pools.slice(-8).map(({pool,done,reason,pages,nextAt})=>({pool,done,reason,pages,nextAt}))},lanes:this.state.lanes.map(({kind,from,to,done,rows,before,lastSlot,lastEventAt})=>({kind,from,to,done,pendingPage:rows.length,lastSignature:before,lastSlot,lastEventAt})),complete:this.state.lanes.every(x=>x.done)};}
}
module.exports={MigrationCatchup};
