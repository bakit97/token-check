'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(process.env.SOLSCAN_TEST_COLLECTOR||path.join(__dirname,'../server/collector.js'),'utf8');
const clock=200000000;
function setup(coins){const C=new Map(coins.map((c,i)=>[i,c])),ctx={C,MGV:3,RC:{},Date:{now:()=>clock},setMg:(c,st,k,why,x)=>c.mg={st,k,why,final:x.final,v:3}};
 vm.createContext(ctx);vm.runInContext(code.slice(code.indexOf('function proofQueuedAt('),code.indexOf('async function chainLoop()'))+'\nthis.expire=expireProofs;this.summary=migrationQueueSummary;this.compare=(a,b)=>compareProofTasks(a,b,'+clock+');',ctx);return ctx;}
test('fresh pending proofs precede old partially-paid work; queue reports oldest age',()=>{
 const fresh={t:clock-60000},old={t:clock-3600000,proofProgressAt:clock-1000},ctx=setup([old,fresh]);
 assert.ok(ctx.compare(fresh,old)<0);const summary=ctx.summary(clock);assert.equal(summary.length,2);assert.equal(summary.freshUnder15m,1);assert.equal(summary.oldestAgeSec,3600);
});
test('unconfirmed proofs older than two hours become terminal expired unknown, while verified and pre coins survive',()=>{
 const expired={t:clock-7200001,proofBudgetDeferredAt:1},verified={t:1,mg:{st:'ok',v:3}},pre={t:1,preCurve:true,mg:{st:'curve',v:3,final:1}},ctx=setup([expired,verified,pre]);
 ctx.expire(clock);assert.equal(expired.mg.st,'unk');assert.equal(expired.mg.why,'не подтверждена (просрочено)');assert.equal(expired.mg.final,1);assert.equal(expired.proofBudgetDeferredAt,undefined);assert.equal(verified.mg.st,'ok');assert.equal(pre.proofExpiredAt,undefined);assert.equal(ctx.summary(clock).expired,1);
});
