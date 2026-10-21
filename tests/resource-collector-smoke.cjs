'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(process.env.SOLSCAN_TEST_COLLECTOR||path.join(__dirname,'../server/collector.js'),'utf8');
const {ResourceBudget}=require('../server/resource-budget');
function setup(t){const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'collector-budget-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const now=Date.parse('2026-10-17T00:00:00Z');const resource=new ResourceBudget({dir,now:()=>now});
  const requests=[],ctx={require,Date,JSON,Map,Promise,AbortSignal,DIR:path.resolve(__dirname,'../server'),RESOURCE:resource,
    resourcePressure:()=>false,heliusKey:async()=>'<mock-key>',sleep:async()=>{},fetch:async(...args)=>{requests.push(args);return {status:200,ok:true,json:async()=>({result:{slot:42}})}}};
  vm.createContext(ctx);vm.runInContext(code.slice(code.indexOf('let rpcN='),code.indexOf('const b64='))+'\nthis.call=rpc;',ctx);
  return {ctx,resource,requests};
}
test('collector charges before network; cached immutable proof avoids another billed call',async t=>{
  const {ctx,resource,requests}=setup(t),start=resource.state.used;
  await ctx.call('getTransaction',['proof'],{priority:0,context:'proof'});
  assert.equal(resource.state.used-start,1);assert.equal(requests.length,1);
  await ctx.call('getTransaction',['proof'],{priority:0});assert.equal(requests.length,1);
  for(let i=0;i<7;i++)resource.reserveRPC('getAccountInfo','migration');
  await assert.rejects(ctx.call('getSignaturesForAddress',['pool'],{priority:0}),{code:'BUDGET_DEFERRED'});
  assert.equal(requests.length,1);
});
test('failed fetch is still accounted, while a deferred request does not touch network',async t=>{
  const {ctx,resource,requests}=setup(t),start=resource.state.used;
  ctx.fetch=async()=>{throw Error('offline')};
  await assert.rejects(ctx.call('getTransaction',['proof'],{priority:0}),/offline/);
  assert.equal(resource.state.used-start,1);
  for(let i=0;i<7;i++)resource.reserveRPC('getAccountInfo','migration');
  await assert.rejects(ctx.call('getTransaction',['other'],{priority:0}),{code:'BUDGET_DEFERRED'});
  assert.equal(requests.length,0);
});

test('a stalled metadata response cannot hold the recovery FIFO', {timeout:2000}, async t=>{const {ctx}=setup(t);let release,started;const blocked=new Promise(r=>release=r),seen=new Promise(r=>started=r);t.after(()=>release());ctx.fetch=async(url,o)=>{if(JSON.parse(o.body).params[0]==='blocked'){started();await blocked;}return {ok:true,status:200,json:async()=>({result:{okay:true}})};};const pending=ctx.call('getAccountInfo',['blocked'],{priority:'metadata'});await seen;const recovered=await ctx.call('getAccountInfo',['ready'],{priority:'recovery'});assert.equal(recovered.okay,true);release();await pending;});

test('fresh RPC can use the free winner while charging exactly one failed paid attempt',async t=>{const {ctx,resource}=setup(t),start=resource.state.used;let calls=0;ctx.fetch=async url=>{calls++;if(url.includes('helius-rpc'))throw TypeError('fetch failed');return {ok:true,status:200,json:async()=>({result:{slot:42}})};};const result=await ctx.call('getTransaction',['fresh'],{priority:'migration-fast',urgent:true});assert.equal(result.slot,42);assert.equal(calls,2);assert.equal(resource.state.used-start,1);assert.equal(vm.runInContext('RPC_NETWORK.hedge.publicWins',ctx),1);});
test('an empty paid response cannot beat a valid public migration result',async t=>{const {ctx,resource}=setup(t),start=resource.state.used;ctx.fetch=async url=>({ok:true,status:200,json:async()=>({result:url.includes('helius-rpc')?null:{slot:42}})});const result=await ctx.call('getTransaction',['fresh'],{priority:'migration-fast',urgent:true});assert.equal(result.slot,42);assert.equal(resource.state.used-start,1);});

test('an exhausted paid migration quota still permits free confirmed reads without another charge',async t=>{const {ctx,resource}=setup(t);for(let i=0;i<8;i++)resource.reserveRPC('getTransaction','migration-fast');const before=resource.state.used;let calls=0;ctx.fetch=async url=>{calls++;assert.equal(url,'https://api.mainnet-beta.solana.com');return {ok:true,json:async()=>({result:{slot:42}})};};const result=await ctx.call('getTransaction',['free-fresh'],{priority:'migration-fast',urgent:true});assert.equal(result.slot,42);assert.equal(calls,1);assert.equal(resource.state.used,before);assert.equal(vm.runInContext('RPC_NETWORK.free.success',ctx),1);});
test('an unavailable free provider remains retryable and never bills another lane',async t=>{const {ctx,resource}=setup(t);for(let i=0;i<8;i++)resource.reserveRPC('getTransaction','migration-fast');const before=resource.state.used;ctx.fetch=async url=>{assert.equal(url,'https://api.mainnet-beta.solana.com');return {ok:false,status:429};};await assert.rejects(ctx.call('getTransaction',['free-pending'],{priority:'migration-fast',urgent:true}),{code:'RPC_TRANSIENT'});assert.equal(resource.state.used,before);assert.equal(resource.allow(1,'pools'),true);assert.equal(resource.allow(1,'identity'),true);});

test('sequential free signature and transaction reads wait within the same proof instead of restarting it',async t=>{const {ctx,resource}=setup(t);for(let i=0;i<8;i++)resource.reserveRPC('getTransaction','migration-fast');const used=resource.state.used,waits=[];ctx.sleep=async ms=>waits.push(ms);ctx.fetch=async(url,options)=>({ok:true,json:async()=>({result:JSON.parse(options.body).method==='getSignaturesForAddress'?[{signature:'proof'}]:{slot:42}})});const signatures=await ctx.call('getSignaturesForAddress',['curve'],{priority:'migration-fast',urgent:true,cache:false});const tx=await ctx.call('getTransaction',[signatures[0].signature],{priority:'migration-fast',urgent:true});assert.equal(tx.slot,42);assert.equal(resource.state.used,used);assert.equal(waits.length,1);assert.ok(waits[0]>0&&waits[0]<=500);assert.equal(vm.runInContext('RPC_NETWORK.free.rateDeferred',ctx),0);});
