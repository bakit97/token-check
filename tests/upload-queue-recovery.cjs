'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../server/collector.js'),'utf8');
const body=src.slice(src.indexOf('async function flushUploads()'),src.indexOf('function coinMetadata(c)'));
function setup(upload){const q=Array.from({length:12},(_,i)=>['raw/'+i,{i}]),errors=[];
  const ctx={UPQ:q,upload,err:e=>errors.push(e),Date};vm.createContext(ctx);vm.runInContext(body+';this.flush=flushUploads;',ctx);return {ctx,q,errors};}
test('raw backlog yields after a bounded number of sends and retains every unsent observation',async()=>{
  const sent=[],{ctx,q}=setup(async n=>sent.push(n));await ctx.flush();
  assert.equal(sent.length,6);assert.equal(q.length,6);assert.equal(q[0][0],'raw/6');
});
test('failed archive stays queued and does not prevent a later heartbeat phase',async()=>{
  const {ctx,q,errors}=setup(async()=>{throw Error('offline')});await ctx.flush();
  assert.equal(q.length,12);assert.equal(errors.length,1);assert.ok(q.some(x=>x[0]==='raw/0'));
});
test('new archive producers cannot extend the current flush indefinitely',async()=>{
  let state;state=setup(async()=>state.q.push(['raw/new',{}]));await state.ctx.flush();assert.equal(state.q.length,12);
});
