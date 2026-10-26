'use strict';
const fs=require('node:fs'),path=require('node:path');
// Independent, small replay ledger. A failed read/proof never advances a cursor.
class MigrationCatchup{
 constructor({dir,addresses,rpc,process,decode58,knownSignature=()=>false,now=Date.now}){
  this.file=path.join(dir,'migration-catchup.json');this.rpc=rpc;this.process=process;this.decode58=decode58;this.now=now;this.knownSignature=knownSignature;this.busy=false;this.turn=0;
  let saved;try{saved=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const at=now();this.startedAt=at;this.stats={pages:0,transactions:0,candidates:0,caughtUp:0,alreadyKnown:0,errors:0,lastError:null,lastAt:null};
  this.state={schema:1,lastOnlineAt:at,lanes:addresses.map(({kind,address})=>{const old=saved?.lanes?.find(x=>x.kind===kind&&x.address===address);return old&&!old.done?{...old,nextFrom:Math.min(old.nextFrom||Infinity,Math.max(1,(saved.lastOnlineAt||old.to)-60000)),nextTo:at}:{kind,address,from:Math.max(1,(saved?.lastOnlineAt||at-12*3600000)-60000),to:at,before:null,rows:[],done:false};})};this.save();
 }
 save(){const tmp=this.file+'.tmp',fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(this.state));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,this.file);}
 heartbeat(){this.state.lastOnlineAt=this.now();this.save();}
 async tick(){if(this.busy)return;const lane=this.state.lanes.filter(x=>!x.done)[this.turn++%Math.max(1,this.state.lanes.filter(x=>!x.done).length)];if(!lane)return;this.busy=true;
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
 summary(){return {startedAt:this.startedAt,...this.stats,busy:this.busy,lanes:this.state.lanes.map(({kind,from,to,done,rows,before,lastSlot,lastEventAt})=>({kind,from,to,done,pendingPage:rows.length,lastSignature:before,lastSlot,lastEventAt})),complete:this.state.lanes.every(x=>x.done)};}
}
module.exports={MigrationCatchup};
