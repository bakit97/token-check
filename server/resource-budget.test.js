'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ResourceBudget,PublicationQueue,rpcCost}=require('./resource-budget');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sol-budget-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let clock=Date.parse('2026-10-17T00:00:00Z');return {dir,now:()=>clock,advance:ms=>clock+=ms};}
test('archival and program scans cost ten; normal account reads cost one',()=>{
  for(const m of ['getTransaction','getSignaturesForAddress','getProgramAccounts','getBlock'])assert.equal(rpcCost(m),10);
  assert.equal(rpcCost('getMultipleAccounts'),1);
});
test('rolling minute releases credits after sixty seconds, not two minutes; restart retains charges',t=>{
  const f=fixture(t),b=new ResourceBudget(f);b.stream(1000,'migrations');b.reserveRPC('getTransaction','migration');
  assert.throws(()=>b.reserveRPC('getTransaction','migration'),{code:'BUDGET_DEFERRED'});
  for(let i=0;i<6;i++)b.reserveRPC('getMultipleAccounts','pools');
  const before=b.state.used,fresh=new ResourceBudget(f);assert.equal(fresh.state.used,before);
  f.advance(59999);assert.throws(()=>fresh.reserveRPC('getTransaction','migration'),{code:'BUDGET_DEFERRED'});
  f.advance(1);fresh.reserveRPC('getTransaction','migration');
});

test('proof traffic leaves pool capacity, while holder and pre quotas cannot consume it',t=>{
  const f=fixture(t),b=new ResourceBudget(f);b.reserveRPC('getTransaction','migration');
  for(let i=0;i<3;i++)b.reserveRPC('getMultipleAccounts','holders');
  assert.throws(()=>b.reserveRPC('getAccountInfo','pre'),{code:'BUDGET_DEFERRED'});
  for(let i=0;i<4;i++)b.reserveRPC('getMultipleAccounts','pools');
  assert.throws(()=>b.reserveRPC('getMultipleAccounts','pools'),{code:'BUDGET_DEFERRED'});
  assert.equal(b.summary().creditsMinute,17);
});

test('migration WS stays enabled at exhausted RPC/pre budgets; only own pre stream share pauses pre',t=>{
  const f=fixture(t),b=new ResourceBudget(f);b.reserveRPC('getTransaction','migration');
  assert.equal(b.streamAllowed('pre'),true);
  assert.equal(b.stream(80000,'pre'),false);
  assert.equal(b.streamAllowed('migrations'),true);assert.equal(b.stream(1000,'migrations'),true);
  assert.ok(b.summary().sources.pre.wsCredits>1.5);
  assert.ok(b.summary().sources.migrations.wsCredits>0);
  f.advance(60001);assert.equal(b.streamAllowed('pre'),true);
});

test('hourly reconciliation can complete five scans plus slot and account batches',t=>{
  const f=fixture(t),b=new ResourceBudget(f);
  for(let i=0;i<5;i++){b.reserveRPC('getProgramAccounts','reconcile');f.advance(60001)}
  b.reserveRPC('getSlot','reconcile');b.reserveRPC('getMultipleAccounts','reconcile');
  assert.equal(b.laneTotal('reconcile'),52);
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
