'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const body=fs.readFileSync(require('node:path').join(__dirname,'collector.js'),'utf8'),M=60000;
function setup(coins){let now=30*M;const calls=[],rows=new Map(coins.map(c=>[c.a,{acceptedAt:now-12*M}]));const ctx={C:new Map(coins.map(c=>[c.a,c])),SOURCE:{get:a=>rows.get(a)},PASS_V2:{config:{decisionMinutes:15}},Date:{now:()=>now},Map,Math,isOk:c=>c.d!=='pump-fun',observedEligible:()=>true,ageMin:(c,n)=>(n-c.t)/M,gtPending:()=>false,gtBackgroundBusy:()=>false,collectionPins:()=>new Map(),collectionActive:()=>true,err:()=>{},finishTrades:(c,why)=>{c.trDone=1;c.why=why},gt:(url,priority,key,windowEnd)=>{let resolve;const promise=new Promise(r=>resolve=r);calls.push({url,priority,key,windowEnd,resolve});return promise}};
vm.createContext(ctx);vm.runInContext(body.slice(body.indexOf('function sourceDecisionEnd('),body.indexOf('function rawArchiveName('))+';this.activity=gxTasks;this.trades=tradeTasks;',ctx);return {ctx,calls,rows,setNow:x=>now=x};}
test('GT activity batches prioritize admitted post-migration pools and discard a pool changed in flight',async()=>{
 const pre={a:'pre',p:'curve',d:'pump-fun',t:17*M},post={a:'post',p:'pool',d:'damm',t:18*M},x=setup([pre,post]);x.ctx.activity(30*M);assert.match(x.calls[0].url,/multi\/pool,curve/);post.p='new-pool';x.calls[0].resolve({data:[{attributes:{address:'pool',transactions:{m15:{buyers:99}}}},{attributes:{address:'curve',transactions:{m15:{buyers:11}}}}]});await new Promise(r=>setImmediate(r));assert.equal(post.gx,undefined);assert.equal(pre.gx[0][7],11);
});
test('unlisted pools back off; unknown pre pools never bury fresh migration trade evidence',async()=>{
 const pre={a:'pre',p:'curve',d:'pump-fun',t:18*M},post={a:'post',p:'pool',d:'damm',t:18*M},x=setup([pre,post]);x.ctx.trades(30*M);const trade=x.calls.find(c=>c.key==='tr:pool');assert.equal(trade.priority,1);assert.equal(trade.windowEnd,33*M);assert.equal(x.calls.some(c=>c.key==='tr:curve'),false);
 x.calls.find(c=>c.key==='gx').resolve({data:[]});await new Promise(r=>setImmediate(r));assert.equal(pre.gxMiss,1);x.calls.length=0;x.setNow(31*M);x.ctx.activity(31*M);assert.equal(x.calls.length,0,'no retry after only one minute');
});
test('expired trades yield to a bounded background queue',()=>{const c={a:'post',p:'pool',d:'damm',t:18*M},x=setup([c]);x.rows.set(c.a,{acceptedAt:10*M});x.ctx.gtBackgroundBusy=()=>true;x.ctx.trades(30*M);assert.equal(x.calls.some(c=>c.key==='tr:pool'),false);});
