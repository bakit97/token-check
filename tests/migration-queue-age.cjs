'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(process.env.SOLSCAN_TEST_COLLECTOR||path.join(__dirname,'../server/collector.js'),'utf8');
const clock=200000000;
function setup(coins){const C=new Map(coins.map((c,i)=>[i,c])),ctx={EVENT_CLOCK:null,C,SOURCE:{settings:()=>({afterMinutes:2})},MGV:3,RC:{},Date:{now:()=>clock},setMg:(c,st,k,why,x)=>c.mg={st,k,why,final:x.final,v:3}};
 vm.createContext(ctx);vm.runInContext(code.slice(code.indexOf('function queueMigrationSignal('),code.indexOf('async function chainLoop()'))+'\nthis.signal=queueMigrationSignal;this.expire=expireProofs;this.summary=migrationQueueSummary;this.compare=(a,b)=>compareProofTasks(a,b,'+clock+');',ctx);return ctx;}
test('fresh pending proofs precede old partially-paid work; queue reports oldest age',()=>{
 const fresh={t:clock-60000},old={t:clock-3600000,proofProgressAt:clock-1000},ctx=setup([old,fresh]);
 assert.ok(ctx.compare(fresh,old)<0);const summary=ctx.summary(clock);assert.equal(summary.length,2);assert.equal(summary.freshUnder15m,1);assert.equal(summary.oldestAgeSec,3600);
});
test('unconfirmed proofs older than two hours become terminal expired unknown, while verified and pre coins survive',()=>{
 const expired={t:clock-7200001,proofBudgetDeferredAt:1},verified={t:1,mg:{st:'ok',v:3}},pre={t:1,preCurve:true,mg:{st:'curve',v:3,final:1}},ctx=setup([expired,verified,pre]);
 ctx.expire(clock);assert.equal(expired.mg.st,'unk');assert.equal(expired.mg.why,'не подтверждена (просрочено)');assert.equal(expired.mg.final,1);assert.equal(expired.proofBudgetDeferredAt,undefined);assert.equal(verified.mg.st,'ok');assert.equal(pre.proofExpiredAt,undefined);assert.equal(ctx.summary(clock).expired,1);
});

test('a genuinely new migration signal on an old token starts a fresh proof task instead of inheriting the token age',()=>{
 const coin={t:1,proofExpiredAt:100,mg:{st:'unk',v:3,final:1,k:'unk-expired'}},ctx=setup([coin]);ctx.signal(coin,clock);assert.equal(coin.proofExpiredAt,undefined);assert.equal(coin.proofEnqueuedAt,clock);assert.equal(coin.mg.force,1);assert.equal(ctx.summary(clock).freshUnder15m,1);
});

test('an open buying window outranks an older fresh partial proof, without allowing retroactive late admission',async()=>{
 const open={t:clock-30000},late={t:clock-180000,proofProgressAt:clock-1},ctx=setup([late,open]);assert.ok(ctx.compare(open,late)<0);const q=ctx.summary(clock);assert.equal(q.buyWindowOpen,1);assert.equal(q.buyWindowMissedPending,1);
 const admitted=[],observed=[],scope={Date:{now:()=>clock},SOURCE:{settings:()=>({afterMinutes:2}),has:()=>false,observe:x=>observed.push(x),afterVerifiedMigration:c=>{admitted.push(c.a);return {admitted:false}}},Number,Math,log:()=>{},err:()=>{},SOURCE_ERR:'',readCurveGraduation:async()=>({known:true,graduated:true})};vm.createContext(scope);
 vm.runInContext(code.slice(code.indexOf('async function admitVerifiedMigration(c)'),code.indexOf('const OBS_KEYS='))+'\nthis.admit=admitVerifiedMigration;',scope);
 const tooLate={a:'late',mg:{mT:clock-180000}},timely={a:'fresh',mg:{mT:clock-30000,watch:'curve',k:'pump'}};await scope.admit(tooLate);await scope.admit(timely);assert.equal(tooLate.buyWindowMissedAt,clock);assert.deepEqual(admitted,['fresh']);
 assert.equal(observed[0].outcome,'tooOld');assert.equal(observed[0].lateMs,60000);assert.equal(scope.SOURCE_ERR,'');
});
