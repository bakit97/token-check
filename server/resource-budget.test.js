'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ResourceBudget,PublicationQueue,rpcCost}=require('./resource-budget');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sol-budget-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let clock=Date.parse('2026-10-17T00:00:00Z');return {dir,now:()=>clock,advance:ms=>clock+=ms};}
test('official Helius standard history costs one; program scans and enhanced history cost ten',()=>{
 for(const m of ['getTransaction','getSignaturesForAddress','getSlot','getBlock','getBlocks','getInflationReward','getMultipleAccounts'])assert.equal(rpcCost(m),1);
 for(const m of ['getProgramAccounts','getTransactionsForAddress'])assert.equal(rpcCost(m),10);
});
test('rolling minute releases charges after sixty seconds; restart never erases them',t=>{
 const f=fixture(t),b=new ResourceBudget(f);b.reserveRPC('getProgramAccounts','migration');
 assert.throws(()=>b.reserveRPC('getTransaction','migration'),{code:'BUDGET_DEFERRED'});
 const before=b.state.used,restarted=new ResourceBudget(f);assert.equal(restarted.state.used,before);
 f.advance(59999);assert.throws(()=>restarted.reserveRPC('getTransaction','migration'),{code:'BUDGET_DEFERRED'});
 f.advance(1);restarted.reserveRPC('getTransaction','migration');
});
test('fresh proof retains ten calls and pools retain four, with headroom for pre WS inside seventeen',t=>{
 const f=fixture(t),b=new ResourceBudget(f);
 for(let i=0;i<4;i++)b.reserveRPC('getMultipleAccounts','pools');
 for(let i=0;i<10;i++)b.reserveRPC('getTransaction','migration');
 assert.throws(()=>b.reserveRPC('getAccountInfo','holders'),{code:'BUDGET_DEFERRED'});
 assert.throws(()=>b.reserveRPC('getTransaction','migration'),{code:'BUDGET_DEFERRED'});
 b.stream(140000,'pre');b.stream(1000,'migrations');
 assert.ok(b.summary().creditsMinute<=17);assert.equal(b.streamAllowed('migrations'),true);
});
test('two fresh signature and transaction proofs fit in one minute without blocking the pool reserve',t=>{
 const f=fixture(t),b=new ResourceBudget(f);
 for(let i=0;i<2;i++){b.reserveRPC('getSignaturesForAddress','migration');b.reserveRPC('getTransaction','migration')}
 for(let i=0;i<4;i++)b.reserveRPC('getMultipleAccounts','pools');
 assert.equal(b.summary().creditsMinute,8);
});
test('production pre has no RPC allocation; idle reserves remain available to ordinary metadata',t=>{
 const f=fixture(t),b=new ResourceBudget(f);b.migrationPending=false;b.poolsPending=false;
 assert.throws(()=>b.reserveRPC('getTransaction','pre'),{code:'BUDGET_DEFERRED'});
 b.reserveRPC('getAccountInfo','metadata');assert.equal(b.summary().sources.metadata.rpcCredits,1);
});
test('only pre exceeding its own WS share pauses; migration subscriptions remain live',t=>{
 const f=fixture(t),b=new ResourceBudget(f);b.reserveRPC('getTransaction','migration');
 assert.equal(b.stream(120000,'pre'),true);assert.equal(b.stream(40000,'pre'),false);
 assert.equal(b.streamAllowed('migrations'),true);b.stream(1000,'migrations');
 f.advance(60001);assert.equal(b.streamAllowed('pre'),true);
});
test('reconciliation yields to fresh proofs, then can complete five scans and account batches',t=>{
 const f=fixture(t),b=new ResourceBudget(f);
 assert.throws(()=>b.reserveRPC('getProgramAccounts','reconcile'),{code:'BUDGET_DEFERRED'});
 b.migrationPending=false;
 for(let i=0;i<5;i++){b.reserveRPC('getProgramAccounts','reconcile');f.advance(60001)}
 b.reserveRPC('getSlot','reconcile');b.reserveRPC('getMultipleAccounts','reconcile');
 assert.equal(new ResourceBudget(f).laneTotal('reconcile'),52);
});

test('expired credit period stops spending instead of inventing a renewal',t=>{
  const f=fixture(t),b=new ResourceBudget(f);f.advance(29*86400000);
  assert.equal(b.allow(1,0),false);assert.equal(b.streamAllowed(),false);assert.equal(b.summary().resetRequired,true);
});
test('invalid accounting never silently restarts from zero',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.dir,'resource-budget.json'),'broken');
  assert.throws(()=>new ResourceBudget(f));
});
test('GCS pacing, failed attempts, restart and month rollover retain correct limits',t=>{
  const f=fixture(t),b=new ResourceBudget(f);assert.equal(b.reserveWrite(),true);assert.equal(b.reserveWrite(),false);
  const again=new ResourceBudget(f);assert.equal(again.reserveWrite(),false);
  again.state.gcsUsed=4000;f.advance(86400000);assert.equal(again.reserveWrite(),false);
  f.advance(20*86400000);assert.equal(again.reserveWrite(),true);assert.equal(again.state.gcsUsed,1);
});
test('spool coalesces changes, recovers from disk and retains failures without extra immediate writes',async t=>{
  const f=fixture(t),budget=new ResourceBudget(f),calls=[];
  let fail=true;const send=async(name,body)=>{calls.push([name,body.toString()]);if(fail)throw Error('offline')};
  const q=new PublicationQueue({...f,budget,send});
  await q.enqueue('live.json',Buffer.from('old'),'h1');await q.enqueue('live.json',Buffer.from('new'),'h2');
  assert.equal(q.summary().pending,1);await assert.rejects(q.flush(),/offline/);
  await q.flush();assert.equal(calls.length,1);fail=false;f.advance(86400000);
  const restored=new PublicationQueue({...f,budget,send});await restored.flush();
  assert.deepEqual(calls[1],['live.json','new']);assert.equal(restored.summary().pending,0);
  assert.equal(await restored.enqueue('live.json',Buffer.from('new'),'h2'),false);
});
test('concurrent replacement while publishing is retained for next slot',async t=>{
  const f=fixture(t),budget=new ResourceBudget(f);let release;
  const q=new PublicationQueue({...f,budget,send:()=>new Promise(r=>release=r)});
  await q.enqueue('x.json',Buffer.from('a'),'a');const flushing=q.flush();
  await new Promise(r=>setImmediate(r));await q.enqueue('x.json',Buffer.from('b'),'b');release();await flushing;
  assert.equal(q.items['x.json'].hash,'b');assert.equal(q.summary().pending,1);
});
test('spool has hard limits and does not erase already queued data',async t=>{
  const f=fixture(t),budget=new ResourceBudget(f),q=new PublicationQueue({...f,budget,send:async()=>{},maxFiles:1,maxBytes:8});
  await q.enqueue('a',Buffer.from('data'),'a');await assert.rejects(q.enqueue('b',Buffer.from('x'),'b'),/full/);
  await assert.rejects(q.enqueue('a',Buffer.alloc(9),'c'),/full/);assert.equal(q.items.a.hash,'a');
});
test('hourly discovery worker produces observational results without blocking main event loop',async()=>{
  const {researchJob}=require('./resource-budget');let ticked=false;
  const work=researchJob({dir:__dirname,kind:'discover',rows:[],options:{level:'1'}});
  setImmediate(()=>{ticked=true});const result=await work;
  assert.equal(ticked,true);assert.equal(result.status,'waiting-training');
});
test('source capacity refuses new admission without forgetting historical deduplication',t=>{
  const f=fixture(t),{SourceRuntime}=require('./source-runtime');
  const source=new SourceRuntime({...f,maxRecords:1});
  const a='So11111111111111111111111111111111111111112',b='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const event=mint=>({mint,publicTradingAt:f.now(),observedAt:f.now(),verified:true});
  assert.equal(source.before(event(a)).admitted,true);
  assert.equal(source.before(event(b)).reason,'resource-capacity');
  assert.equal(source.before(event(a)).reason,'already-admitted');
  assert.equal(new SourceRuntime({...f,maxRecords:1}).has(a),true);
});


test('WS uses exact UTF-8 byte price without allocation rounding, across reconnect/restart',t=>{
 const f=fixture(t),b=new ResourceBudget(f);const bytes=Buffer.byteLength('coin \u041c');
 b.stream(bytes,'pre');b.stream(1,'migrations');
 assert.ok(Math.abs(b.summary().wsCreditsHour-(bytes+1)*20/1000000)<1e-12);
 assert.equal(b.summary().wsMetering.bytesHour,bytes+1);
 const restored=new ResourceBudget(f);assert.equal(restored.summary().wsCreditsHour,b.summary().wsCreditsHour);
 assert.equal(restored.summary().wsMetering.billingVerified,false);
});

test('idle migration/pool reserves release residual budget to pre, without a 150/hour cutoff',t=>{
 const f=fixture(t),b=new ResourceBudget(f);b.migrationPending=false;b.poolsPending=false;
 for(let i=0;i<12;i++){assert.equal(b.stream(700000,'pre'),true);f.advance(60001)}
 assert.ok(b.laneTotal('ws:pre')>150);assert.equal(b.streamAllowed('pre'),true);
 b.migrationPending=true;b.poolsPending=true;b.stream(200000,'pre');
 assert.equal(b.streamAllowed('pre'),false);assert.equal(b.streamAllowed('migrations'),true);
});

test('pre budget pause is bounded to ninety seconds with ten-second charged probes',t=>{
 const f=fixture(t),b=new ResourceBudget(f);b.stream(200000,'pre');assert.equal(b.streamAllowed('pre'),false);
 // Model sustained migration pressure even after old stream charges age out.
 f.advance(60001);b.charge(18,'rpc','migration');assert.equal(b.streamAllowed('pre'),false);
 f.advance(30000);assert.equal(b.streamAllowed('pre'),true);b.stream(1000,'pre');
 assert.ok(b.summary().sources.pre.wsCredits>4);assert.equal(b.streamAllowed('migrations'),true);
 f.advance(10001);assert.equal(b.streamAllowed('pre'),false);
});

test('daily Pump coverage deduplicates mints and estimates gaps from rate, never one mint per slot',t=>{
 const f=fixture(t),{PumpTelemetry}=require('./resource-budget'),p=new PumpTelemetry(f);
 p.connected(100);for(let i=0;i<10;i++){p.received(100+i*20);p.event('mint'+i,'create');p.event('mint'+i,'create')}
 p.event('mint0','accepted');p.event('mint0','accepted');f.advance(80000);p.disconnected('budget',300);
 f.advance(40000);p.connected(400);const s=p.summary(400);
 assert.equal(s.uniqueCreates,10);assert.equal(s.accepted,1);assert.equal(s.createReceived,10);
 assert.equal(s.budgetPausedSlots,100);assert.equal(s.lostDuringBudgetPauses.estimate,5);
 assert.equal(s.lostDuringBudgetPauses.exact,null);assert.equal(s.budgetPausedMs,40000);
 const r=new PumpTelemetry(f);assert.equal(r.summary().uniqueCreates,10);assert.equal(r.summary().restartGap,true);
 f.advance(19*3600000);const next=r.summary();assert.equal(next.day,'2026-10-18');assert.equal(next.uniqueCreates,0);
});

test('Pump gap with no observed baseline stays unknown and restart downtime is not budget loss',t=>{
 const f=fixture(t),{PumpTelemetry}=require('./resource-budget'),p=new PumpTelemetry(f);
 p.connected(100);p.summary();f.advance(60000);const r=new PumpTelemetry(f);r.connected(250);const s=r.summary();
 assert.equal(s.budgetPausedMs,0);assert.equal(s.otherGapMs,60000);assert.equal(s.lostDuringBudgetPauses.estimate,null);
});
