'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(process.env.SOLSCAN_TEST_COLLECTOR||path.join(__dirname,'../server/collector.js'),'utf8');
test('restart restores budget-deferred migration candidates without an abandoned in-flight lock',()=>{
 const coin={a:'mint',t:Date.now(),fv:2,disc:'ws',d:'meteora-dbc',chTry:1,proofRetryAt:60000,proofBudgetDeferredAt:1};
 const ctx={HEALTH:null,require:()=>({loadRows:(file,visit)=>[coin].forEach(visit)}),fs:{existsSync:()=>false,readFileSync:name=>JSON.stringify(name.endsWith('state.json')?[coin]:{})},DIR:'test',FV:2,C:new Map(),RC:{},log:()=>{},err:()=>{}};
 vm.createContext(ctx);vm.runInContext(code.slice(code.indexOf('function load(){'),code.indexOf('function save(){'))+'\nload();',ctx);
 const restored=ctx.C.get('mint');assert.ok(restored);assert.equal(restored.chTry,undefined);assert.equal(restored.proofBudgetDeferredAt,1);assert.equal(restored.proofRetryAt,60000);
});
test('successful migration RPC records partial progress for cache-preserving continuation, but failures do not',async()=>{
 const coin={d:'meteora-dbc'},ctx={Date:{now:()=>1234},rpc:async()=>({value:1})};vm.createContext(ctx);
 vm.runInContext(code.slice(code.indexOf('function budgetSource('),code.indexOf('const b64='))+'\nthis.adapter=rpcFor;',ctx);
 await ctx.adapter(coin,'миграция')('getAccountInfo',[]);assert.equal(coin.proofProgressAt,1234);
 ctx.rpc=async()=>{throw Object.assign(Error('quota'),{code:'BUDGET_DEFERRED'})};coin.proofProgressAt=0;
 await assert.rejects(ctx.adapter(coin,'миграция')('getTransaction',[]),{code:'BUDGET_DEFERRED'});assert.equal(coin.proofProgressAt,0);
});

test('hourly reconciliation retains unprocessed migration events when budget defers an account batch',async()=>{
 let fail=true;const ctx={Date,Set,RC:{ll:['old'],dbc:['old'],log:[]},RECON_RETRY:null,CTX:'',C:new Map([['mint',{mg:{st:'ok'}}]]),FV:2,
  snapshotSet:async key=>[key+'_new'],globalRPC:async()=>{if(fail)throw Object.assign(Error('quota'),{code:'BUDGET_DEFERRED'});return {value:[{data:['state']}]};},
  b64:x=>x,pk:()=> 'mint',isOk:()=>true,setTimeout:()=>1,err:()=>{}};
 vm.createContext(ctx);vm.runInContext(code.slice(code.indexOf('async function reconcileBody()'),code.indexOf('/* ---------- 5б.'))+'\nthis.run=reconcileBody;',ctx);
 await ctx.run();assert.deepEqual(Array.from(ctx.RC.pend.ll),['ll_new']);assert.deepEqual(Array.from(ctx.RC.pend.dbc),['dbc_new']);
 fail=false;await ctx.run();assert.equal(ctx.RC.pend.ll.length,0);assert.equal(ctx.RC.pend.dbc.length,0);
});
