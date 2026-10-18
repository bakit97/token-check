'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const crypto=require('node:crypto');
const {PumpPreWatcher}=require('./pre-watcher');
const {SourceRuntime}=require('./source-runtime');
const {PUMP}=require('./pump-pre');
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const M='So11111111111111111111111111111111111111112';
const CURVE='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const at=Date.UTC(2026,9,17,10,0);
function enc(bytes){let n=0n;for(const v of bytes)n=(n<<8n)+BigInt(v);let s='';while(n){s=B58[Number(n%58n)]+s;n/=58n}for(const v of bytes){if(v===0)s='1'+s;else break}return s}
function dec(s){let n=0n;for(const v of s)n=n*58n+BigInt(B58.indexOf(v));let a=[];while(n){a.push(Number(n&255n));n>>=8n}for(const v of s){if(v==='1')a.push(0);else break}return Uint8Array.from(a.reverse())}
function launchTx(blockAt){
 const d=crypto.createHash('sha256').update('global:create_v2').digest().subarray(0,8);
 const data=Buffer.concat([d,Buffer.from([3,0,0,0]),Buffer.from('Cat'),Buffer.from([3,0,0,0]),Buffer.from('CAT')]);
 return {blockTime:blockAt/1000,slot:100,meta:{err:null},transaction:{message:{
   accountKeys:[PUMP,M,'11111111111111111111111111111111',CURVE],
   instructions:[{programIdIndex:0,accounts:[1,2,3],data:enc(data)}]
 }}};
}
function curve(tradeable=true){
 const b=Buffer.alloc(82);
 for(const i of [8,16,24,40])b.writeBigUInt64LE(1_000_000n,i);
 if(!tradeable)b[48]=1;
 return {value:{owner:PUMP,data:[b.toString('base64'),'base64']}};
}
function setup(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sol-pump-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const source=new SourceRuntime({dir}),accepted=[];
 let proofCalls=0;
 const worker=new PumpPreWatcher({source,allowRPCFallback:true,decode58:dec,deriveCurve:async()=>CURVE,retryDelays:[],
   rpc:async(method)=>{proofCalls++;return method==='getTransaction'?launchTx(at):curve(options.tradeable!==false)},
   onAdmitted:(x,r)=>accepted.push({x,r}),queueLimit:2});
 return {worker,source,accepted,get proofCalls(){return proofCalls}};
}
test('first public tradable curve is persisted under pre-migration',async t=>{
 const x=setup(t);
 const d=await x.worker.examine({signature:'sig-good',observedAt:at+5000});
 assert.equal(d.admitted,true);assert.equal(x.source.get(M).phase,'before');
 assert.equal(x.accepted[0].x.name,'Cat');
 const duplicate=await x.worker.examine({signature:'sig-replay',observedAt:at+8000});
 assert.equal(duplicate.reason,'already-admitted');
});
test('older than age window is never written',async t=>{
 const x=setup(t);
 const d=await x.worker.examine({signature:'sig-late',observedAt:at+120001});
 assert.equal(d.reason,'too-old');assert.equal(x.source.records.size,0);
 assert.equal(x.source.dailySummary().before.tooOld,1);
});
test('token mint alone or completed curve does not prove public trading',async t=>{
 const x=setup(t,{tradeable:false});
 assert.equal((await x.worker.examine({signature:'sig',observedAt:at+5000})).reason,'curve-not-tradeable');
 assert.equal(x.source.records.size,0);
 assert.equal(x.source.dailySummary().before.unverified,1);
});

test('Count unique create-event mint before budget/queue rejection, never admit it from logs',async t=>{
 const x=setup(t),part=s=>{const b=Buffer.from(s),n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b])};
 const data=Buffer.concat([Buffer.from([27,114,169,77,222,235,99,118]),part('Кот'),part('CAT'),part('uri'),Buffer.from(dec(M))]);
 const log={signature:'create-dropped',err:null,logs:['Program '+PUMP+' invoke [1]','Program log: Instruction: CreateV2','Program data: '+data.toString('base64'),'Program '+PUMP+' success']};
 x.worker.canObserve=()=>false;
 x.worker.onLog(log);x.worker.onLog(log);
 assert.equal(x.source.dailySummary().before.seen,1);assert.equal(x.source.dailySummary().before.unverified,1);
 assert.equal(x.source.records.size,0);assert.equal(x.proofCalls,0);
});
test('websocket only forwards successful create logs, not trades or failed tx',async t=>{
 const x=setup(t);
 assert.equal(x.worker.onLog({signature:'s1',logs:['Program log: Instruction: Buy']},at+1000),false);
 assert.equal(x.worker.onLog({signature:'s1',err:{},logs:['Program log: Instruction: CreateV2']},at+1000),false);
 assert.equal(x.worker.stats.createLogs,0);
});
test('queue overflow counted so lost launches are not silently backfilled',async t=>{
 const x=setup(t);x.worker.busy=true;
 for(let i=0;i<3;i++)x.worker.onLog({signature:'s'+i,logs:['Program log: Instruction: CreateV2']},at+1000);
 assert.equal(x.worker.queue.length,2);assert.equal(x.worker.stats.dropped,1);
});

function logLaunch(signature,blockAt=at,program=PUMP,kind='CreateV2'){
 const str=s=>{const b=Buffer.from(s),n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b])};
 const time=Buffer.alloc(8);time.writeBigInt64LE(BigInt(blockAt/1000));
 const payload=Buffer.concat([Buffer.from([27,114,169,77,222,235,99,118]),str('Кот'),str('CAT'),str('uri'),Buffer.from(dec(M)),Buffer.from(dec(CURVE)),Buffer.alloc(64),time]);
 return {err:null,signature,logs:['Program '+program+' invoke [1]','Program log: Instruction: '+kind,'Program data: '+payload.toString('base64'),'Program '+program+' success']};
}
test('Production Pump pre admits create and create_v2 from scoped successful event, slot and PDA with zero RPC',async t=>{
 const x=setup(t);x.worker.allowRPCFallback=false;
 x.worker.rpc=async()=>{throw Error('Unexpected network call')};
 const d=logLaunch('log-proof');x.worker.onLog(d,at+1000,1234);
 while(x.worker.busy)await new Promise(r=>setImmediate(r));
 assert.equal(x.source.get(M).phase,'before');assert.equal(x.source.get(M).proof.slot,1234);
 assert.equal(x.source.get(M).proof.kind,'pump-create-event');assert.equal(x.worker.stats.rpcCalls,0);
 assert.equal(x.worker.stats.logProofs,1);
 x.worker.onLog(d,at+2000,1234);assert.equal(x.worker.stats.logProofs,1);
});
test('Production Pump pre never falls back to RPC for stale, malformed, failed, foreign or missing-slot log events',async t=>{
 for(const kind of ['late','foreign','failed','slot','curve']){
  const x=setup(t);x.worker.allowRPCFallback=false;x.worker.rpc=async()=>{throw Error('Unexpected RPC')};
  const d=logLaunch(kind,at,kind==='foreign'?CURVE:PUMP,'Create');
  if(kind==='failed')d.err={InstructionError:[0,'Custom']};
  if(kind==='curve')x.worker.deriveCurve=async()=>M;
  x.worker.onLog(d,kind==='late'?at+121000:at+1000,kind==='slot'?undefined:1234);
  while(x.worker.busy)await new Promise(r=>setImmediate(r));
  assert.equal(x.source.records.size,0,kind);assert.equal(x.worker.stats.rpcCalls,0,kind);
 }
});

test('Slot clock remains the public event clock when Pump timestamp is slightly ahead; original timestamp is preserved',async t=>{
 const x=setup(t);x.worker.allowRPCFallback=false;x.worker.slotClock={estimate:()=>({at:at+900,ageMs:100})};
 x.worker.rpc=async()=>{throw Error('Unexpected RPC')};
 x.worker.onLog(logLaunch('clock-skew',at+2000),at+1000,1234);
 while(x.worker.busy)await new Promise(r=>setImmediate(r));
 assert.equal(x.source.get(M).eventAt,at+900);assert.equal(x.source.get(M).proof.timeSource,'slot-estimate');
 assert.equal(x.source.get(M).proof.reportedEventAt,at+2000);assert.equal(x.worker.stats.rpcCalls,0);
});
