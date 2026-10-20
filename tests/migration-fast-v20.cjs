const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {migrationCandidates,specs,FastSignals}=require('../server/migration-fast'),{SourceRuntime}=require('../server/source-runtime');
const M='A'.repeat(32),N='B'.repeat(32),NOW=Date.now(),T=Math.floor(NOW/1000)*1000;
function temp(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'migration-v20-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
function tx(spec=specs[0],{created=true,failed=false}={}){const keys=Array.from({length:36},(_,i)=>'key'+i),accounts=Array.from({length:30},(_,i)=>i);keys[spec.mint]=M;if(spec.quote!=null)keys[spec.quote]='quote';keys[spec.curve]='curve';keys[spec.pool]='pool';keys[spec.dexIndex]=spec.dex;keys[35]=spec.program;const pre=keys.map(()=>10),post=keys.map(()=>10);pre[spec.pool]=created?0:10;return {slot:10,blockTime:T/1000-2,meta:{err:failed?{}:null,preBalances:pre,postBalances:post},transaction:{signatures:['sig'],message:{accountKeys:keys,instructions:[{programIdIndex:35,accounts,data:spec.discriminator}]}}};}
test('all official migration instruction layouts identify the newly created pool and curve',()=>{for(const spec of specs){const r=migrationCandidates(tx(spec),x=>Buffer.from(x,'hex'));a.equal(r.length,1,spec.name);a.equal(r[0].mint,M);a.equal(r[0].pool,'pool');a.equal(r[0].curve,'curve');a.equal(r[0].family,spec.family);}});
test('idempotent, failed, spoofed and wrong destination transactions never prove a migration',()=>{for(const options of [{created:false},{failed:true}])a.equal(migrationCandidates(tx(specs[0],options),x=>Buffer.from(x,'hex')).length,0);const t=tx();t.transaction.message.accountKeys[35]='wrong';a.equal(migrationCandidates(t,x=>Buffer.from(x,'hex')).length,0);});
test('legacy birth removal is durable, preserves after, and permits a later proven migration of that mint',t=>{const dir=temp(t),source=new SourceRuntime({dir,fsync:false,clock:()=>T});source.before({mint:M,publicTradingAt:T-1000,observedAt:T,verified:true,proof:{kind:'pump-create-event'}});source.afterVerifiedMigration({a:N,seen:T,mg:{st:'ok',mT:T-1000,sig:'existing-after',pool:'after-pool',k:'pump'}});a.deepEqual(source.removeLegacyBirths(),[M]);a.equal(source.get(N).phase,'after');a.equal(source.has(M),false);const restart=new SourceRuntime({dir,fsync:false,clock:()=>T});a.equal(restart.has(M),false);a.equal(restart.get(N).proof.signature,'existing-after');a.equal(restart.afterVerifiedMigration({a:M,seen:T,mg:{st:'ok',mT:T-500,sig:'new-migration',pool:'pool',k:'pump'}}).admitted,true);a.equal(restart.dailySummary(T).before.seen,0);});
test('latency samples are bounded and partitioned by phase, missing samples remain null',()=>{let at=T;const q=new FastSignals({process:async()=>{},now:()=>at});a.equal(q.summary().latency.pool.p90Ms,null);for(let i=1;i<=600;i++)q.accepted('after',T-i,'pump');a.equal(q.summary().latency.after.samples,500);a.equal(q.summary().latency.after.p50Ms,350);a.equal(q.summary().latency.after.p90Ms,550);at+=86400000;a.equal(q.summary().latency.after.samples,0);});
test('fresh signature queue is deduplicated and bounded while a proof is pending',async()=>{let release;const q=new FastSignals({process:()=>new Promise(r=>release=r),maxQueue:2,workers:1,now:()=>T});q.offer({signature:'one'});a.equal(q.offer({signature:'one'}),false);q.offer({signature:'two'});q.offer({signature:'three'});a.equal(q.offer({signature:'four'}),false);a.equal(q.summary().queue,2);a.equal(q.summary().counts.overflow,1);await Promise.resolve();release();});
test('real collector fast Pump proof needs one transaction RPC and bypasses background FIFO',async t=>{const source=new SourceRuntime({dir:temp(t),fsync:false}),calls=[],C=new Map(),accepted=[];const ctx={require,DIR:path.join(__dirname,'../server'),Buffer,Date,Map,Set,TextEncoder,SOURCE:source,C,FV:2,DEXOF:{pump:'pumpswap'},FAST_DISCOVERY:{accepted:(...x)=>accepted.push(x)},rpc:async(m,p,o)=>{calls.push({m,o});return tx()},b58dec:x=>Buffer.from(x,'hex'),bondingCurveOf:async()=> 'curve',canonicalPoolOf:async()=> 'pool',setMg:(c,st,k,why,x)=>{c.mg={st,k,...x}},moveTo:()=>{},b64:()=>[]};vm.createContext(ctx);const code=fs.readFileSync(path.join(__dirname,'../server/collector.js'),'utf8');vm.runInContext(code.slice(code.indexOf('async function processFastMigration('),code.indexOf('function offerFastMigration('))+'\nthis.run=processFastMigration;',ctx);await ctx.run({signature:'sig',receivedAt:Date.now(),slot:10});a.deepEqual(calls.map(x=>x.m),['getTransaction']);a.equal(calls[0].o.urgent,true);a.equal(calls[0].o.priority,'migration-fast');a.equal(source.get(M).phase,'after');a.equal(source.get(M).proof.pool,'pool');a.equal(accepted.length,1);});

test('opening SOL comes only from verified native quote vault balances; USD/cap are never invented',()=>{const t=tx();t.meta.postTokenBalances=[{owner:'pool',mint:'So11111111111111111111111111111111111111112',uiTokenAmount:{decimals:9,amount:'5000000000'}}];a.equal(migrationCandidates(t,x=>Buffer.from(x,'hex'))[0].openingQuoteSol,5);t.meta.postTokenBalances[0].mint='foreign';a.equal(migrationCandidates(t,x=>Buffer.from(x,'hex'))[0].openingQuoteSol,null);});

test('opening SOL is usable immediately but never before receipt or for another pool',()=>{const {starterFeaturesAt}=require('../server/research-v2'),{cardAt}=require('../server/coin-profile'),c={a:M,p:'pool',q:'So11111111111111111111111111111111111111112',mg:{st:'ok',pool:'pool'},openingMetrics:{pool:'pool',quoteMint:'So11111111111111111111111111111111111111112',at:T+1000,eventAt:T,liquiditySol:5}};a.equal(starterFeaturesAt(c,T+500).quoteSol,null);a.equal(cardAt(c,T+2000).sol,5);a.equal(cardAt(c,T+2000).solMeasuredAt,T);a.equal(starterFeaturesAt({...c,p:'different'},T+2000).quoteSol,null);});


test('fresh migration reserve survives legacy proof traffic within the shared cap',t=>{
 const {ResourceBudget}=require('../server/resource-budget');
 const b=new ResourceBudget({dir:temp(t),now:()=>T,env:{HELIUS_RESET_AT:new Date(T+86400000).toISOString(),HELIUS_USED_CREDITS:'0'}});
 b.freshMigrationReserve=3;
 let old=0;while(b.allow(1,'migration')){b.reserveRPC('getTransaction','migration');old++;}
 a.ok(old>0);a.equal(b.allow(1,'migration'),false);
 for(let i=0;i<3;i++)b.reserveRPC('getTransaction','migration-fast');
 a.equal(b.laneTotal('migration-fast',60000),3);
 a.ok(b.summary().creditsMinute<=17);
 a.equal(b.allow(1,'migration-fast'),false);
});


test('fresh proof capacity remains reserved when old migration queue is empty and pool polls are busy',t=>{
 const {ResourceBudget}=require('../server/resource-budget');
 const b=new ResourceBudget({dir:temp(t),now:()=>T,env:{HELIUS_RESET_AT:new Date(T+86400000).toISOString(),HELIUS_USED_CREDITS:'0'}});
 b.freshMigrationReserve=3;b.migrationPending=false;b.poolsPending=false;
 while(b.allow(1,'pools'))b.reserveRPC('getMultipleAccounts','pools');
 for(let i=0;i<3;i++)b.reserveRPC('getTransaction','migration-fast');
 a.ok(b.summary().creditsMinute<=17);a.equal(b.laneTotal('migration-fast',60000),3);
});


const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
test('budget wait survives a full accounting minute, with delayed work visible and no five-retry loss',async()=>{
 let at=T,timer=null,calls=0;const q=new FastSignals({now:()=>at,setTimer:(fn,ms)=>{timer={fn,at:at+ms};return timer;},clearTimer:()=>{timer=null;},process:async()=>{calls++;if(at<T+61000)throw Object.assign(Error('budget'),{code:'BUDGET_DEFERRED',retryAfterMs:10000});return {outcome:'accepted'};}});
 q.offer({signature:'later'});await flush();a.equal(q.summary().waitingBudget,1);
 while(timer&&at<T+80000){const next=timer;timer=null;at=next.at;next.fn();await flush();}
 a.ok(calls>5);a.equal(q.summary().counts.completed,1);a.equal(q.summary().counts.errors,0);a.equal(q.summary().queue,0);a.equal(q.summary().outcomes.accepted,1);
});
test('permanent proof rejection is counted explicitly, never as successful completion',async()=>{const q=new FastSignals({process:async()=>{throw Object.assign(Error('proof missing'),{code:'PROOF_NOT_FOUND'});}});q.offer({signature:'bad'});await flush();a.equal(q.summary().counts.completed,0);a.equal(q.summary().counts.errors,1);a.equal(q.summary().failureReasons.PROOF_NOT_FOUND,1);a.equal(q.summary().lastFailures[0].signature,'bad');a.equal(q.summary().lastFailures[0].code,'PROOF_NOT_FOUND');});
test('a new fresh proof runs while older proof waits for budget',async()=>{let at=T;const done=[];const q=new FastSignals({now:()=>at,setTimer:()=>({}),clearTimer:()=>{},process:async t=>{if(t.signature==='waiting')throw Object.assign(Error('budget'),{code:'BUDGET_DEFERRED',retryAfterMs:60000});done.push(t.signature);return {outcome:'accepted'};}});q.offer({signature:'waiting'});await flush();q.offer({signature:'fresh'});await flush();a.deepEqual(done,['fresh']);a.equal(q.summary().waitingBudget,1);});
test('decoded DBC proof survives budget wait and a not-yet-visible confirmed pool account',async t=>{
 const source=new SourceRuntime({dir:temp(t),fsync:false}),calls=[],C=new Map(),spec=specs.find(s=>s.family==='dbc'),transaction=tx(spec);transaction.transaction.message.accountKeys[spec.quote]='So11111111111111111111111111111111111111112';let attempts=0;
 const ctx={require,DIR:path.join(__dirname,'../server'),Buffer,Date,Map,Set,TextEncoder,SOURCE:source,C,FV:2,DEXOF:{dbc:'meteora'},FAST_DISCOVERY:{accepted:()=>{}},DAMM2:spec.dex,DBC_AUTH:'authority',officialPools:async()=>[],pk:()=> 'authority',pair2:()=> 'So11111111111111111111111111111111111111112',
 rpc:async(m,p,o)=>{calls.push(m);if(m==='getTransaction')return transaction;a.equal(p[1].commitment,'confirmed');if(++attempts===1)throw Object.assign(Error('budget'),{code:'BUDGET_DEFERRED'});if(attempts===2)return {value:null};return {value:{owner:spec.dex,data:['data']}};},b58dec:x=>Buffer.from(x,'hex'),setMg:(c,st,k,why,x)=>{c.mg={st,k,...x}},moveTo:()=>{},b64:()=>new Uint8Array(680)};
 vm.createContext(ctx);const code=fs.readFileSync(path.join(__dirname,'../server/collector.js'),'utf8');vm.runInContext(code.slice(code.indexOf('async function processFastMigration('),code.indexOf('function offerFastMigration('))+'\nthis.run=processFastMigration;',ctx);
 const task={signature:'sig',receivedAt:Date.now(),slot:10};await a.rejects(ctx.run(task),e=>e.code==='BUDGET_DEFERRED');await a.rejects(ctx.run(task),e=>e.code==='TX_PENDING');const result=await ctx.run(task);a.equal(result.outcome,'accepted');a.deepEqual(calls,['getTransaction','getAccountInfo','getAccountInfo','getAccountInfo']);a.equal(source.get(M).phase,'after');
});


test('six fresh credits remain available after old proofs and pool observations',t=>{const {ResourceBudget}=require('../server/resource-budget');const b=new ResourceBudget({dir:temp(t),now:()=>T,env:{HELIUS_RESET_AT:new Date(T+86400000).toISOString(),HELIUS_USED_CREDITS:'0'}});b.freshMigrationReserve=6;while(b.allow(1,'migration'))b.reserveRPC('getTransaction','migration');while(b.allow(1,'pools'))b.reserveRPC('getMultipleAccounts','pools');for(let i=0;i<6;i++)b.reserveRPC('getTransaction','migration-fast');a.ok(b.summary().creditsMinute<=17);a.equal(b.laneTotal('migration-fast',60000),6);});
test('daily unverified breakdown attributes known origins without inventing historical attribution',t=>{const s=new SourceRuntime({dir:temp(t),fsync:false,clock:()=>T});s.observe({mint:M,phase:'after',origin:'reconcile'});s.observe({mint:N,phase:'after',origin:'ws-dbc',reason:'BUDGET_DEFERRED'});const d=s.dailySummary(T).after;a.equal(d.unverified,2);a.equal(d.unverifiedByOrigin.reconcile,1);a.equal(d.unverifiedByReason.BUDGET_DEFERRED,1);});


test('curve signature indexing lag is retried without stale cache or repeated immutable transaction downloads',async t=>{
 const source=new SourceRuntime({dir:temp(t),fsync:false}),calls=[],C=new Map();let scans=0;
 const ctx={require,DIR:path.join(__dirname,'../server'),Buffer,Date,Map,Set,TextEncoder,SOURCE:source,C,FV:2,DEXOF:{pump:'pumpswap'},FAST_DISCOVERY:{accepted:()=>{}},
 rpc:async(m,p,o)=>{calls.push({m,o});if(m==='getSignaturesForAddress')return (++scans===1?['noise']:['noise','sig','must-not-fetch']).map(signature=>({signature,slot:10,err:null}));return p[0]==='noise'?tx(specs[0],{created:false}):tx();},b58dec:x=>Buffer.from(x,'hex'),bondingCurveOf:async()=> 'curve',canonicalPoolOf:async()=> 'pool',setMg:(c,st,k,why,x)=>{c.mg={st,k,...x}},moveTo:()=>{},b64:()=>[]};
 vm.createContext(ctx);const code=fs.readFileSync(path.join(__dirname,'../server/collector.js'),'utf8');vm.runInContext(code.slice(code.indexOf('async function processFastMigration('),code.indexOf('function offerFastMigration('))+'\nthis.run=processFastMigration;',ctx);
 const task={curve:'curve',kind:'pump',receivedAt:Date.now(),slot:10};await a.rejects(ctx.run(task),e=>e.code==='TX_PENDING');a.equal((await ctx.run(task)).outcome,'accepted');a.deepEqual(calls.map(x=>x.m),['getSignaturesForAddress','getTransaction','getSignaturesForAddress','getTransaction']);a.equal(calls[0].o.cache,false);a.equal(calls[2].o.cache,false);
});
