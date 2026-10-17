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
 const worker=new PumpPreWatcher({source,decode58:dec,deriveCurve:async()=>CURVE,retryDelays:[],
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
});
test('token mint alone or completed curve does not prove public trading',async t=>{
 const x=setup(t,{tradeable:false});
 assert.equal((await x.worker.examine({signature:'sig',observedAt:at+5000})).reason,'curve-not-tradeable');
 assert.equal(x.source.records.size,0);
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
