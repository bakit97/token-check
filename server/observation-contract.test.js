'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{project,toLegacy,chainDrain}=require('./observation-contract');
const mint='mint',at=2000000;
test('archiving retains program ownership, verifier version, watched curve and previous migration evidence',()=>{
 const c={a:'mint',p:'pool',t:1000,mg:{v:3,st:'ok',k:'launch-v4',owner:'AMM4_PROGRAM',pool:'pool',sig:'signature',mT:1000,ix:'migrate_to_amm',creator:true,watch:'curve',seenAt:2000,lastAt:3000,n:2,final:1},mg0:{v:2,st:'unk',k:'unk-launch',owner:'old-program',watch:'curve',lastAt:1000}};
 const proof=JSON.parse(JSON.stringify(project(c))).observations.migrationProof;assert.equal(proof.programOwner,'AMM4_PROGRAM');assert.equal(proof.verificationVersion,3);assert.equal(proof.watchCurve,'curve');assert.equal(proof.stateObservedAt,3000);assert.deepEqual(proof.sourceState,c.mg);assert.deepEqual(proof.previousState,c.mg0);
});
function coin(){return {a:mint,p:'pool',d:'meteora-damm-v2',t:1000000,ds:[[1001,2,0,40,5,6,7]],lq:[[1002,12,999,100],[1003,13,998,4]],vaults:['base','quote'],vmint:[mint,'quoteMint'],vdec:[6,9],vaultIdentityAt:1002000,
 k10:{at:1100000,src:'trades',c:[[1001,1,2,1,2,3]]},hold:{10:{at:1600000,top1:.2}},raw:{1:{at:1060000,slot:12,b:['pool','base','quote'],vaultAt:1060100,vaultSlot:13}},tr:{f:[[1100000,12,1001,1010]],x:{sig:[1001,'owner',2,true,1]}},gx:[[1100,2,3]],bx:{at:1100000,cov:true},path:{at:1200000,upto:3,c:[[1001,2,3,1,2]]},origs:[{p:'curve',d:'pump-fun',t:900000,ds:[[999,1,null]],raw:{1:{at:990000,slot:11,b:['curve']}}}]};}
test('all required observations and absolute receipt times survive the new contract round trip',()=>{
 const c=coin(),snapshot=JSON.stringify(c),row=project(c,{metadata:{a:mint,n:'Coin',oldResearchResults:{bad:1},ds:['do-not-copy']},admission:{phase:'after',acceptedAt:1100000}}),back=toLegacy(row);
 assert.equal(JSON.stringify(c),snapshot);assert.equal(row.oldResearchResults,undefined);assert.equal(row.ds,undefined);assert.equal(row.observations.pools[0].ds[0].at,1001000);
 for(const k of ['ds','lq','vaults','vmint','vdec','vaultIdentityAt','k10','hold','raw','tr','gx','bx','path'])assert.deepEqual(back[k],c[k],k);
 assert.deepEqual(back.origs[0].raw,c.origs[0].raw);assert.equal(back.preObs.p,'curve');assert.equal(row.observations.pools[0].rawStates[1].vaultAt,1060100);
});
test('early readers exclude observations received after the decision, including later-fetched candles and trade batches',()=>{
 const c=coin(),row=project(c,{metadata:{ct:{at:1600000,ma:false}}}),early=toLegacy(row,1050000);assert.equal(early.k10,null);assert.equal(early.ct,null);assert.deepEqual(early.hold,{});assert.deepEqual(early.raw,{});assert.deepEqual(early.tr.x,{});assert.equal(early.ds.length,1);assert.equal(early.preObs.raw[1].at,990000);
});
test('drain is below five percent of observed quote-vault maximum; Meteora USD zero and future maxima are not evidence',()=>{
 const c=coin(),row=project(c),e=chainDrain(row,at);assert.equal(e.at,1003000);assert.equal(e.quoteMint,'quoteMint');assert.equal(e.remaining,4);assert.equal(e.maximumObserved,100);
 assert.equal(chainDrain(row,1002500),null);c.lq=[[1001,1,9,5],[1002,2,9,10000]];assert.equal(chainDrain(project(c),1001500),null);
 c.lq=[[1001,1,9,100],[1002,2,9,5]];assert.equal(chainDrain(project(c)),null);c.lq=[];assert.equal(chainDrain(project(c)),null);
});


test('phone projection retains identity, receipt times and last values while full archives remain intact',()=>{
 const {projectSummary}=require('./observation-contract'),c=coin();c.ds.push([1004,3],[1005,4]);
 const before=JSON.stringify(c),summary=projectSummary(c,{metadata:{n:'Name'}}),full=project(c);
 assert.equal(JSON.stringify(c),before);assert.equal(summary.observations.readScope,'latest-observations-only');
 assert.equal(summary.n,'Name');assert.equal(summary.observations.pools[0].ds.length,2);assert.equal(full.observations.pools[0].ds.length,3);
 assert.equal(toLegacy(summary).ds.at(-1)[1],4);assert.deepEqual(summary.observations.pools[0].rawStates,{});assert.equal(summary.observations.pools[0].tradeRows,null);
});
