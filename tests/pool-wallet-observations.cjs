'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),api=require('../server/activity-slices'),{activityEvidence}=require('../server/research-v2'),intel=require('../server/early-intelligence');
const T=Date.UTC(2026,9,20),M=60000,A='A'.repeat(32),B='B'.repeat(32),mint='C'.repeat(32),WSOL='So11111111111111111111111111111111111111112';
const trade=(minute,buy,wallet,sol=.1)=>({id:minute+':'+wallet+':'+buy,attributes:{block_timestamp:new Date(T+minute*M).toISOString(),kind:buy?'buy':'sell',from_token_address:buy?WSOL:mint,to_token_address:buy?mint:WSOL,from_token_amount:buy?String(sol):'100',to_token_amount:buy?'100':String(sol),tx_from_address:wallet,volume_in_usd:'10',price_to_in_usd:'.1',price_from_in_usd:'.1'}});
test('DEX and manual-pool receipts retain distinct buyers, excluding sellers and repeated wallet purchases',()=>{
 const xs=[trade(1,true,A),trade(2,true,A),trade(3,false,B),trade(4,true,B)],raw=api.observe(null,xs,mint,T,T+10*M,T+11*M),metrics=api.buyerMetrics(raw);assert.equal(metrics.uniqueBuyers,2);assert.equal(metrics.uniqueBuyersComplete,true);assert.deepEqual(metrics.lowerBounds,[]);
 const replay=api.unpack(api.pack(raw));assert.equal(api.buyerMetrics(replay).uniqueBuyers,2);const coin={activityTapePacked:api.pack(raw)},out=activityEvidence(coin,T,T+10*M,1);assert.equal(out.uniqueBuyers,2);assert.equal(out.uniqueBuyersComplete,true);assert.equal(out.minutes.filter(r=>r[2]===1).length,4);assert.equal(out.minutes.filter(r=>r[2]===0).length,6);
});
test('partial history returns a buyer lower bound and an empty or invalid response cannot invent zero',()=>{
 const raw=api.evidence({start:T,end:T+10*M,trades:api.tradeRows([trade(1,true,A)],mint,T+5*M)});assert.equal(api.buyerMetrics(raw).uniqueBuyers,1);assert.equal(api.buyerMetrics(raw).uniqueBuyersComplete,false);assert.deepEqual(api.buyerMetrics(raw).lowerBounds,['unique-buyers']);
 assert.equal(api.buyerMetrics(api.observe(null,[],mint,T,T+10*M,T+11*M)).uniqueBuyers,null);
 const bad=api.observe(null,[trade(1,true,'missing')],mint,T,T+10*M,T+11*M);assert.equal(api.buyerMetrics(bad).uniqueBuyersComplete,false);
});
test('observed silence means zero buyers; conflicting unknown swap invalidates the silent confidence',()=>{
 const silent=api.evidence({start:T,end:T+10*M,minutes:Array.from({length:10},(_,i)=>[T+(i+1)*M,1,0])});assert.equal(api.buyerMetrics(silent).uniqueBuyers,0);
 const swap=api.evidence({start:T,end:T+10*M,trades:[[T/1000+60,1,1,null,1,null,T+2*M]]}),merged=api.merge(silent,swap);assert.equal(merged.slices[0].silent,false);assert.equal(merged.slices[0].complete,false);assert.equal(api.buyerMetrics(merged).uniqueBuyers,null);assert.equal(api.classify(merged).label,'unknown');
});
test('rolling nonzero m5 does not invent five active minutes; a raw swap proves its actual minute',()=>{
 const c={ds:[[(T+5*M)/1000,1,1,1,1,0,1]],tr:{x:{one:[(T+2*M)/1000,1,1,A,1,.1,T+3*M]}}},out=activityEvidence(c,T,T+10*M,1);assert.equal(out.minutes.filter(r=>r[2]===1).length,1);assert.equal(out.minutes[2][2],1);assert.equal(out.uniqueBuyers,1);assert.ok(out.lowerBounds.includes('unique-buyers'),'legacy tape supports only an observed lower bound');
});
test('early native pool buyers become smart-registry inputs only by receipt deadline',()=>{
 const snap=intel.poolWallets([trade(1,true,A),trade(2,false,B)],{mint,start:T,at:T+3*M}),coin={intelligenceSnapshots:[snap]};assert.deepEqual(snap.earlyWallets,[A]);assert.equal(snap.earlyWalletsComplete,true);assert.deepEqual(intel.frozenWallets(coin,T+2*M),[]);assert.deepEqual(intel.frozenWallets(coin,T+3*M),[A]);
});
