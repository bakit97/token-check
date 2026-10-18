'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(process.env.SOLSCAN_TEST_COLLECTOR||path.join(__dirname,'../server/collector.js'),'utf8');
function setup(rpc){
 const ctx={Map,Buffer,Date,Promise,setImmediate,MIG_PROG:{dbc:'program'},MIG_IX:{program:new Set(['0102030405060708'])},b58dec:s=>Buffer.from(s,'hex')};
 vm.createContext(ctx);vm.runInContext(code.slice(code.indexOf('const MIG_BLOCKS='),code.indexOf('function pair2('))+'\nthis.prove=proveMig;this.stats=PROOF_FAST;',ctx);
 return (slot,pool='pool',curve='curve')=>ctx.prove(pool,'dbc',curve,rpc,slot);
}
function tx({created=true,curve=true,validInstruction=true}={}){return {meta:{err:null,preBalances:[created?0:1,100,100],postBalances:[10,100,100]},transaction:{signatures:['sig'],message:{accountKeys:['pool',curve?'curve':'wrong','program'],instructions:[{programIdIndex:2,accounts:[0,1],data:validInstruction?'0102030405060708':'0000000000000000'}]}}};}
test('Known migration slot needs one block RPC, keeps original signature/block time, and reuses only filtered transactions',async()=>{
 const calls=[],prove=setup(async(method,params)=>{calls.push([method,params]);return {blockTime:1792289000,transactions:[tx()]}});
 const a=await prove(123);assert.equal(a.ok,1);assert.equal(a.sig,'sig');assert.equal(a.t,1792289000000);assert.equal(a.slot,123);
 const b=await prove(123);assert.equal(b.ok,1);assert.equal(calls.length,1);assert.equal(calls[0][0],'getBlock');
});
test('Migration proof rejects existing pools, wrong curves and nonmigration instructions in a signal slot',async()=>{
 for(const config of [{created:false},{curve:false},{validInstruction:false}]){
  const prove=setup(async()=>({blockTime:1792289000,transactions:[tx(config)]}));assert.equal((await prove(123)).ok,undefined);
 }
});
test('Without a slot, only one signature page and one creation transaction are read; truncated history is not paginated',async()=>{
 const calls=[],prove=setup(async(method,params)=>{calls.push(method);return method==='getSignaturesForAddress'?[{signature:'sig',blockTime:1792289000,slot:123,err:null}]:tx()});
 assert.equal((await prove(null)).ok,1);assert.deepEqual(calls,['getSignaturesForAddress','getTransaction']);
 let pages=0;const truncated=setup(async method=>{assert.equal(method,'getSignaturesForAddress');pages++;return Array.from({length:1000},()=>({signature:'sig'}))});
 assert.equal((await truncated(null)).tooLong,1);assert.equal(pages,1);
});
