'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(process.env.SOLSCAN_TEST_COLLECTOR||path.join(__dirname,'../server/collector.js'),'utf8');
function setup({count=33,failVault=false,missingVault=false}={}){
 const coins=Array.from({length:count},(_,i)=>({a:'1',p:'pool'+i,t:0,raw:{}})),calls=[];let time=100000;
 const enc=b=>[b.toString('base64'),'base64'];
 const ctx={Date:{now:()=>time},C:new Map(coins.map((c,i)=>[i,c])),ageMin:(c,n)=>(n-c.t)/60000,isOk:()=>true,
  b64:s=>Buffer.from(s||'','base64'),pk:(u,o)=>String(u[o]),VAULT_OFF:{program:[139,171]},u64:(u,o)=>Number(u.readBigUInt64LE(o)),
  rpc:async(method,[keys],options)=>{calls.push({keys,options});assert.equal(options.priority,'pools');assert.equal(options.context,'пулы');time+=1000;
   if(failVault&&calls.length===2)throw Object.assign(Error('quota'),{code:'BUDGET_DEFERRED'});
   return {context:{slot:calls.length},value:keys.map((key,i)=>{if(key.startsWith('pool')){const n=+key.slice(4),b=Buffer.alloc(203);b[139]=n*2+20;b[171]=n*2+21;return {owner:'program',data:enc(b)}}
    if(missingVault&&i===0)return null;const b=Buffer.alloc(165);b[0]=i%2===0?1:2;b.writeBigUInt64LE(123n,64);return {data:enc(b)}})}}};
 vm.createContext(ctx);
 vm.runInContext(code.slice(code.indexOf('function parseVaults('),code.indexOf('async function chainObsLoop()'))+'\nthis.collect=collectPoolBatch;this.coverage=poolCoverage;this.interval=poolInterval;',ctx);
 return {ctx,coins,calls};
}
test('33 pools discover 66 vaults in two bounded RPC batches and commit real timestamped balances',async()=>{
 const {ctx,coins,calls}=setup();await ctx.collect(coins.map(c=>[c,1]));
 assert.equal(calls.length,2);assert.equal(calls[0].keys.length,33);assert.equal(calls[1].keys.length,66);
 for(const c of coins){assert.equal(c.lq.length,1);assert.deepEqual(Array.from(c.lq[0].slice(2)),[123,123]);assert.equal(c.lqAt,102000);assert.equal(c.raw[1].at,101000);assert.equal(c.raw[1].vaultAt,102000);assert.equal(c.raw[1].slot,1);assert.equal(c.raw[1].vaultSlot,2)}
 assert.equal(ctx.coverage(102001).current,33);assert.equal(ctx.interval(coins[0],119*60000),300000);assert.equal(ctx.interval(coins[0],120*60000),1800000);
});
test('budget deferral after pool fetch preserves raw data without inventing a balance success',async()=>{
 const {ctx,coins}=setup({count:2,failVault:true});await assert.rejects(ctx.collect(coins.map(c=>[c,1])),{code:'BUDGET_DEFERRED'});
 for(const c of coins){assert.ok(c.raw[1].b[0]);assert.equal(c.lqAt,undefined);assert.equal(c.lq,undefined)}
 assert.equal(ctx.coverage(102001).due,2);
});
test('missing vault is reported due, rather than marking balances collected for five minutes',async()=>{
 const {ctx,coins}=setup({count:1,missingVault:true});await ctx.collect([[coins[0],1]]);
 assert.equal(coins[0].lqAt,undefined);assert.ok(coins[0].vaultMissingAt);assert.equal(ctx.coverage(102001).withBalances,0);
});
