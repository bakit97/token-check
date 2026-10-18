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
test('GCS multipart sender sets metadata in the same counted request',{skip:!!process.env.SOLSCAN_TEST_COLLECTOR},async()=>{
  const calls=[],ctx={require,Buffer,JSON,AbortSignal,BUCKET:'fake',token:async()=>'<mock-token>',fetch:async(...a)=>{calls.push(a);return {ok:true}}};
  vm.createContext(ctx);vm.runInContext(code.slice(code.indexOf('async function sendPublication('),code.indexOf('async function upload(name,obj)'))+'\nthis.send=sendPublication;',ctx);
  await ctx.send('live.json',Buffer.from('compressed'),'application/json');
  assert.equal(calls.length,1);assert.match(calls[0][0],/uploadType=multipart/);
  assert.match(calls[0][1].body.toString(),/"cacheControl":"no-cache, max-age=0"/);
  assert.match(calls[0][1].body.toString(),/"contentEncoding":"gzip"/);
});
