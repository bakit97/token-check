'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {ResearchRuntime,classOf}=require('./research-runtime');
const H=3_600_000,M=60_000;
const T=Date.UTC(2026,9,17,9,0);
const A='So11111111111111111111111111111111111111112';
const B='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const C='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
function workingDir(t){
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'research-test-'));
 t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;
}
function stream(active) {
 const ds=[];
 for(let m=1;m<=300;m++)ds.push([
   Math.floor((T+m*M)/1000),1-m/800,3000,5000,
   active(m)?3:0,active(m)?2:0,active(m)?200:0
 ]);
 const x={};for(let m=1;m<300;m++)if(active(m))for(const [i,w] of [A,B].entries())x[m+'-'+i]=[(T+m*M+i*1000)/1000,1,1,w,1,.1,T+m*M+2000];
 return {ds,tr:{x}};
}
function mockSource(){
 return {records:new Map([
   [A,{mint:A,phase:'before',acceptedAt:T}],
   [B,{mint:B,phase:'after',acceptedAt:T+2*M}],
   [C,{mint:C,phase:'before',acceptedAt:T+3*M}]
 ])};
}
test('research only observes the admitted source, stores live and dead separately',t=>{
 const dir=workingDir(t);
 const runtime=new ResearchRuntime({dir,config:{hours:5,lastHourWallets:0,minUniqueBuyers:0}});
 const source=mockSource();
 const coins=new Map([[A,stream(()=>true)],[B,stream(m=>m<20)],[C,{ds:[]}]]);
 const result=runtime.update({source,coins,now:T+6*H});
 assert.equal(result.added,3);
 assert.equal(result.counts.live,1);
 assert.equal(result.counts.dead,1);
 assert.equal(runtime.select({label:'live'})[0].mint,A);
 assert.equal(runtime.select({label:'dead'})[0].mint,B);
 assert.equal(result.counts.unknown,1);
 assert.ok(runtime.select()[0].features?.trades!==undefined);
 assert.equal(runtime.update({source,coins,now:T+6*H+M}).added,0,'do not count same mint again');
 const restarted=new ResearchRuntime({dir});
 assert.equal(restarted.rows.length,3);
 assert.equal(restarted.update({source,coins,now:T+6*H+2*M}).added,0);
});
test('never label young coins before observation finishes',t=>{
 const runtime=new ResearchRuntime({dir:workingDir(t),config:{lastHourWallets:0,minUniqueBuyers:0}});
 const coins=new Map([[A,stream(()=>true)]]);
 const source={records:new Map([[A,{mint:A,phase:'before',acceptedAt:T}]])};
 assert.equal(runtime.update({source,coins,now:T+4*H}).added,0);
 assert.equal(runtime.summary().counts.live,0);
 assert.equal(runtime.summary().pending['not-yet-finished'],1);
});
test('reclassify stored observations without discarding raw outcomes',t=>{
 const dir=workingDir(t),source={records:new Map([[A,{mint:A,phase:'before',acceptedAt:T}]])};
 const coins=new Map([[A,stream(m=>m<250)]]);
 new ResearchRuntime({dir,config:{lastHourTrades:0,lastHourWallets:0,minUniqueBuyers:0}}).update({source,coins,now:T+6*H});
 const strict=new ResearchRuntime({dir,config:{minActive:95,useActivity:true,lastHourTrades:0,lastHourWallets:0,minUniqueBuyers:0}});
 assert.equal(strict.summary().counts.dead,1);
 const relaxed=new ResearchRuntime({dir,config:{minActive:70,useActivity:true,lastHourTrades:0,lastHourWallets:0,minUniqueBuyers:0}});
 assert.equal(relaxed.summary().counts.live,1);
});
test('processed bank excludes old pruned tokens when they are still in the 48h source window',t=>{
 const dir=workingDir(t),runtime=new ResearchRuntime({dir});
 const source={records:new Map([[A,{mint:A,phase:'before',acceptedAt:T}]])};
 const coins=new Map([[A,stream(()=>true)]]);
 runtime.update({source,coins,now:T+6*H});
 // Simulate rotating the coin out of the 5000-per-class active bank.
 runtime.rows=[];runtime.lookup.clear();
 const once=runtime.update({source,coins,now:T+7*H});
 assert.equal(once.added,0);
});
test('source age is not inferred from token creation or latest screen time',t=>{
 const runtime=new ResearchRuntime({dir:workingDir(t),config:{lastHourWallets:0,minUniqueBuyers:0}});
 const source={records:new Map([[A,{mint:A,phase:'after',acceptedAt:T}]])};
 const coins=new Map([[A,stream(()=>true)]]);
 const r=runtime.update({source,coins,now:T+6*H});
 assert.equal(r.counts.live,1);
 assert.equal(runtime.select()[0].acceptedAt,T);
});
test('damaged persistent data fails closed, never resets memory silently',t=>{
 const dir=workingDir(t);
 fs.writeFileSync(path.join(dir,'research-v2-bank.json'),'{bad');
 assert.throws(()=>new ResearchRuntime({dir}),SyntaxError);
});
test('requires 5000-per-class maximum and validates configuration',t=>{
 assert.throws(()=>new ResearchRuntime({dir:workingDir(t),config:{hours:25}}),RangeError);
 assert.equal(classOf({activePct:95,maxIdleObserved:0},{minActive:70,maxIdle:60}),'unknown');
});


test('continuous research limits CPU work and retries missing data every fifteen minutes',t=>{
 const dir=workingDir(t),runtime=new ResearchRuntime({dir});
 const entries=[];
 for(let i=0;i<600;i++)entries.push(['mint-'+i,
   {mint:'mint-'+i,phase:'before',acceptedAt:T}]);
 const source={records:new Map(entries)};
 const coins=new Map(entries.map(([mint])=>[mint,{ds:[]}]));
 const first=runtime.update({source,coins,now:T+6*H});
 assert.equal(first.attempted,250);
 assert.equal(first.pending['deferred-by-batch'],350);
 assert.equal(first.counts.unknown,250);
 const second=runtime.update({source,coins,now:T+6*H+M});
 assert.equal(second.attempted,250);
 assert.equal(second.pending['deferred-by-batch'],100);
 assert.equal(second.counts.unknown,500);
 const third=runtime.update({source,coins,now:T+6*H+2*M});
 assert.equal(third.attempted,100);
 assert.equal(third.counts.unknown,600);
 assert.equal(third.pending['deferred-by-batch']||0,0);
 const soon=runtime.update({source,coins,now:T+6*H+3*M});
 assert.equal(soon.attempted,0);
 const later=runtime.update({source,coins,now:T+6*H+16*M});
 assert.equal(later.attempted,0);
});


test('historic event reanchor recomputes receipt cutoffs, keeps cohort and survives restart',t=>{
 const dir=workingDir(t),r=new ResearchRuntime({dir,config:{hours:1,lastHourWallets:0,minUniqueBuyers:0}});
 const source={records:new Map([[A,{mint:A,phase:'after',acceptedAt:T+2*M,proof:{pool:'pool'}}]])};
 const coin={p:'pool',ds:Array.from({length:66},(_,i)=>[(T+i*M)/1000,1,3000,5000,2,1,100]),intelligenceSnapshots:[{at:T+11*M,evidenceVersion:2,features:{devBuySol:99}}]};
 r.update({source,coins:new Map([[A,coin]]),now:T+70*M});
 assert.equal(r.rows[0].features.devBuySol,99);
 source.records.get(A).eventAt=T;
 const out=r.update({source,coins:new Map([[A,coin]]),now:T+71*M});
 const row=r.rows[0];assert.equal(row.acceptedAt,T+2*M);assert.equal(row.eventAt,T);assert.equal(row.windowStart,T);assert.equal(row.windowEnd,T+60*M);assert.equal(row.decisionAt,T+10*M);assert.equal(row.features.devBuySol,null);assert.equal(out.eventMigration.changed,1);assert.equal(out.counts.entered,1);
 const restarted=new ResearchRuntime({dir,config:{hours:1,lastHourWallets:0,minUniqueBuyers:0}});restarted.update({source,coins:new Map([[A,coin]]),now:T+72*M});assert.equal(restarted.rows[0].eventAt,T);assert.equal(restarted.rows[0].features.devBuySol,null);assert.equal(restarted.rows.length,1);assert.equal(restarted.eventMigration.remaining,0);
});

test('event migration retains original sample when raw observations or pool identity are missing',t=>{
 const r=new ResearchRuntime({dir:workingDir(t),config:{hours:1}}),source={records:new Map([[A,{mint:A,phase:'after',eventAt:T,acceptedAt:T+M,proof:{pool:'new'}}]])};
 const old={mint:A,phase:'after',acceptedAt:T+M,featureAnchor:'acceptedAt',features:{buys:2},windowStart:T+M};r.rows=[old];
 r.reanchor({source,coins:new Map(),now:T+2*H});assert.equal(r.rows[0],old);assert.equal(r.eventMigration.rawMissing,1);
 r.reanchor({source,coins:new Map([[A,{p:'old',ds:[]}]]),now:T+2*H});assert.equal(r.rows[0],old);assert.equal(r.eventMigration.remaining,1);
});
