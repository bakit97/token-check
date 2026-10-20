'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{identityPlan}=require('../server/holder-census'),{coverage,pack}=require('../server/feature-snapshots'),{CoinProfiles}=require('../server/coin-profile');
const M=60000,T=Date.UTC(2026,9,20);
test('one mixed identity request plans raw mint, curve and metadata across both phases within 100-account bound',async()=>{
 const coins=Array.from({length:70},(_,i)=>({a:'m'+i,mg:{watch:'curve'+i}})),records=new Map(coins.map((c,i)=>[c.a,{acceptedAt:T-i*1000,phase:i%2?'after':'before',proof:{curve:'curve'+i}}]));
 const p=await identityPlan(coins,{getRecord:a=>records.get(a),now:T+M,curveOf:async a=>'curve-'+a,metadataOf:async a=>'meta-'+a});assert.ok(p.addresses.length<=100);assert.equal(p.tasks.length,33);assert.equal(p.addresses.length,99);assert.equal(p.tasks[0].coin.a,'m0');for(const x of p.tasks){assert.equal(p.addresses[x.mint],x.coin.a);assert.equal(p.addresses[x.metadata],'meta-'+x.coin.a);assert.ok(p.addresses[x.curve]);}
});
test('identity plan repairs missing exact supply on old ct, keeps known creator, and prevents repeated calls within minute',async()=>{
 const c={a:'mint',ct:{prog:'token'},n:'Name',s:'N',i:'https://example.com/a',creatorAddress:'Creator'},row={acceptedAt:T,phase:'after'};
 const opts={getRecord:()=>row,now:T+M,curveOf:async()=>{throw Error('known creator must not query curve')},metadataOf:async()=>{throw Error('complete identity needs no metadata account')}};
 let p=await identityPlan([c],opts);assert.deepEqual(p.addresses,['mint']);c.identityAttemptAt=T+M;assert.equal((await identityPlan([c],{...opts,now:T+M+1})).tasks.length,0);
 c.supplyRaw='100';c.tokenProgram='Token';assert.equal((await identityPlan([c],{...opts,now:T+3*M})).tasks.length,0);
});
test('coverage includes missing old keys in denominator and a null level-two field cannot erase known level-one data',()=>{
 const c={featureSnapshotsPacked:pack({phase:'after',acceptedAt:T,snapshots:{5:{'1':{devSold:1},'2':{devSold:null}}}})},r=coverage([c]).phases.after.snapshots[5].features;
 assert.deepEqual(r.devSold,{known:1,total:1,percent:100});assert.deepEqual(r.top10,{known:0,total:1,percent:0});assert.deepEqual(r.ageAtMigrationMin,{known:0,total:1,percent:0});
});
test('metadata socials are fetched even when DexScreener already supplied an image, preserving that image',async()=>{
 const c={a:'mint',i:'https://example.com/existing.png',n:'Coin',s:'C',uri:'https://ipfs.io/ipfs/'+'Qm'+'a'.repeat(44)},source={get:()=>({phase:'after',eventAt:T,acceptedAt:T})};let calls=0;
 await new CoinProfiles().update({coins:new Map([['mint',c]]),source,now:T+M,fetch:async()=>{calls++;return {ok:true,headers:{get:()=>null},body:[Buffer.from(JSON.stringify({image:'https://example.com/new.png',description:'About',twitter:'https://x.com/example'}))]};}});
 assert.equal(calls,1);assert.equal(c.i,'https://example.com/existing.png');assert.equal(c.description,'About');assert.equal(c.socialFeatures.hasTwitter,true);assert.ok(c.metadataAt);
});
