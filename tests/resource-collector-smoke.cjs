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
  for(let i=0;i<9;i++)resource.reserveRPC('getAccountInfo','migration');
  await assert.rejects(ctx.call('getSignaturesForAddress',['pool'],{priority:0}),{code:'BUDGET_DEFERRED'});
  assert.equal(requests.length,1);
});
test('failed fetch is still accounted, while a deferred request does not touch network',async t=>{
  const {ctx,resource,requests}=setup(t),start=resource.state.used;
  ctx.fetch=async()=>{throw Error('offline')};
  await assert.rejects(ctx.call('getTransaction',['proof'],{priority:0}),/offline/);
  assert.equal(resource.state.used-start,1);
  for(let i=0;i<9;i++)resource.reserveRPC('getAccountInfo','migration');
  await assert.rejects(ctx.call('getTransaction',['other'],{priority:0}),{code:'BUDGET_DEFERRED'});
  assert.equal(requests.length,0);
});
