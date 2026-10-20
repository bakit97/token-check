const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');const R=require('../server/observation-recovery'),{featuresAt,classifyActivity}=require('../server/research-v2');
const M=60000,T=Date.UTC(2026,9,20),mint='A'.repeat(32);
function response(bars){return {meta:{base:{address:mint}},data:{attributes:{ohlcv_list:bars}}};}
function temp(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('sparse candles do not invent zero minutes; foreign token and still-open bars are rejected',()=>{
 const rows=R.candlesOf(response([[T/1000,1,2,1,2,3]]),mint,T,T+60*M,T+60*M);a.equal(rows.length,1);const minutes=Array.from({length:60},(_,i)=>[T+(i+1)*M,null,null,null]);a.equal(R.minuteStats(R.applyMinutes(minutes,[{candles:rows}])).coverage,1/60);
 a.throws(()=>R.candlesOf(response([]),'foreign',T,T+M,T+M));a.equal(R.candlesOf(response([[T/1000,1,1,1,1,0]]),mint,T,T+M,T+M-1).length,0);a.throws(()=>R.signaturesOf([],T,T+M,T+M));
});
test('no successful pool transaction proves inactivity only inside the covered signature interval',()=>{
 const signatures=R.signaturesOf([{signature:'create',blockTime:T/1000,err:null},{signature:'trade',blockTime:(T+2*M)/1000,err:null},{signature:'failed',blockTime:(T+4*M)/1000,err:{failed:true}}],T,T+5*M,T+6*M),minutes=Array.from({length:5},(_,i)=>[T+(i+1)*M,null,null,null]),next=R.applyMinutes(minutes,[{signatures}]);
 a.deepEqual(next.map(r=>r[1]),[null,1,null,1,1]);a.equal(next[4][2],0);a.equal(next[4][4].backfilled,true);a.equal(next[4][4].receivedAt,T+6*M);const partial={...signatures,from:T+M};a.equal(R.applyMinutes(minutes,[{signatures:partial}])[0][1],null);
});
test('recovery relabels an actual collector gap without changing frozen decision features or inventing wallets',()=>{
 const minutes=Array.from({length:60},(_,i)=>[T+(i+1)*M,null,null,null]),row={mint,phase:'after',acceptedAt:T,eventAt:T,windowStart:T,windowEnd:T+60*M,decisionAt:T+10*M,features:{quoteSol:17.7},coverage:0,maxGap:60,outcomeVersion:2,featureAnchor:'eventAt',outcomePacked:zlib.deflateSync(Buffer.from(JSON.stringify(minutes))).toString('base64'),lastHourWallets:null,uniqueBuyers:null},sig={from:T-M,through:T+60*M,receivedAt:T+61*M,txTimes:[],source:'chain-pool-signatures'};
 const next=R.relabel(row,[{signatures:sig}],{});a.equal(next.label,'dead');a.equal(next.why,'last-hour-inactive');a.equal(next.backfilledMinutes,60);a.equal(next.backfilledIntervals,1);a.equal(next.uniqueBuyers,null);a.deepEqual(next.features,row.features);a.equal(next.decisionAt,row.decisionAt);a.equal(next.coverage,1);
 a.equal(classifyActivity({...row,recoveryPending:true}).label,'pending');
});
test('recovered historical prices help outcomes but cannot leak into decision features',()=>{
 const history=[{candles:[{start:T,end:T+M,activity:1,price:99,receivedAt:T+10*M,backfilled:true}]}],coin={a:mint,t:T,recoveryEvidence:history};a.equal(featuresAt(coin,T+2*M).mc,null);a.equal(featuresAt(coin,T+2*M).volume,null);a.equal(require('../server/research-v2').candles(coin).length,0);
});
test('budget deferral stays pending across restart, reuses downloaded candles, then persists verified recovery',async t=>{
 const dir=temp(t),updates=[];let now=T+61*M,gets=0,calls=0,deny=true;const options={dir,now:()=>now,gt:async()=>{gets++;return response([])},rpc:async()=>{calls++;if(deny)throw Object.assign(Error('budget'),{code:'BUDGET_DEFERRED'});return [{signature:'first',blockTime:T/1000-1,err:null}]},onUpdated:(j,p)=>updates.push(j.state)};
 let manager=new R.ObservationRecovery(options),job=manager.enqueue({mint,pool:'pool',start:T,end:T+60*M});await manager.run(job);a.equal(job.state,'waiting-budget');
 manager=new R.ObservationRecovery(options);job=manager.jobs.get(job.id);now+=16000;deny=false;await manager.run(job);a.equal(gets,1);a.equal(calls,2);a.equal(job.state,'recovered');a.equal(manager.attach({a:mint,p:'pool'}).recoveryEvidence.length,1);a.deepEqual(updates,['recovered']);
});

test('unavailable OHLCV still permits exact chain inactivity recovery',async t=>{
 const manager=new R.ObservationRecovery({dir:temp(t),now:()=>T+61*M,gt:async()=>{throw Error('404')},rpc:async()=>[{signature:'created',blockTime:T/1000-1,err:null}],onUpdated:()=>{}}),j=manager.enqueue({mint,pool:'pool',start:T,end:T+60*M});await manager.run(j);a.equal(j.state,'recovered');a.equal(j.recoveredMinutes,60);a.equal(manager.payload(j).candlesError,'ohlcv-unavailable');
});
test('signature pagination resumes with the oldest cursor and never claims uncovered older minutes',async t=>{
 const params=[],options={dir:temp(t),now:()=>T+6*M,gt:async()=>response([]),rpc:async(m,p)=>{params.push(p);return params.length===1?Array.from({length:1000},(_,i)=>({signature:'sig'+i,blockTime:(T+M)/1000,err:null})):[{signature:'created',blockTime:T/1000-1,err:null}]},onUpdated:()=>{}},manager=new R.ObservationRecovery(options),j=manager.enqueue({mint,pool:'pool',start:T,end:T+5*M});await manager.run(j);a.equal(j.state,'queued');a.equal(j.reason,'signature-pagination');await manager.run(j);a.equal(params[1][1].before,'sig999');a.equal(j.state,'recovered');a.equal(manager.payload(j).signatures.txTimes.length,1);
});

test('empty latest-24h trade endpoint cannot prove completeness of an older research window',()=>{
 const evidence=require('../server/research-v2').tradeOutcomeEvidence([],T,T+5*60*M,T+30*60*M);a.equal(evidence.complete,false);a.ok(evidence.lowerBounds.includes('last-hour-trades'));a.ok(evidence.lowerBounds.includes('unique-buyers'));
});
