'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {starterFeaturesAt,evaluation}=require('./research-v2'),{configOf}=require('./pass-runtime');
const cfg=require('./pass-filters.json'),T=2000000,M=60000,WSOL='So11111111111111111111111111111111111111112';
function coin(){return {a:'mint',t:T-12*M,ct:{at:T-2*M,prog:'token',safetyVersion:1,unknownExtensions:[],feeAuthority:false,mint:false,freeze:false,hook:false,deleg:false,nontr:false,defFrozen:false,pause:false,fee:0},
 bx:{at:T-M,cov:true,payers:15},vmint:['mint',WSOL],vaultIdentityAt:T-2*M,lq:[[(T-M)/1000,1,1e9,6e9]]};}
test('starter filters require contract AND ten-minute unique buyers AND real SOL',()=>{
 const c=coin(),F=starterFeaturesAt(c,T),config=configOf(cfg),basic=config.filters[0],strong=config.filters[1];
 assert.deepEqual(F,{safeContract:1,quoteSol:6,buyers10:15});assert.equal(evaluation(F,basic),'pass');assert.equal(evaluation(F,strong),'reject');
 for(const key of ['mint','freeze','hook','deleg','nontr','defFrozen','pause','feeAuthority']){const x=coin();x.ct[key]=true;assert.equal(evaluation(starterFeaturesAt(x,T),basic),'reject',key)}
 const fee=coin();fee.ct.fee=.1;assert.equal(evaluation(starterFeaturesAt(fee,T),basic),'reject');
});
test('USD liquidity, stale or future data, incomplete trades and virtual reserves do not satisfy SOL/buyer guards',()=>{
 for(const modify of [c=>c.vmint[1]='USDC',c=>c.vaultIdentityAt=T+1,c=>c.lq[0][0]=(T+1000)/1000,c=>c.bx.cov=false,c=>c.bx.at=T+1,c=>c.ct.at=T+1,c=>delete c.ct.freeze,c=>delete c.lq]){
  const c=coin();modify(c);const F=starterFeaturesAt(c,T);assert.equal(evaluation(F,configOf(cfg).filters[0]),'unknown');
 }
 const c=coin();c.lq[0][3]=4e9;assert.equal(evaluation(starterFeaturesAt(c,T),cfg.filters[0]),'reject');
});
test('compound configuration preserves all guards and rejects nested or unknown conditions',()=>{
 const x=configOf(cfg);assert.equal(x.enabled,true);assert.equal(x.decisionMinutes,15);assert.equal(x.filters[0].conditions.length,2);
 const bad=JSON.parse(JSON.stringify(cfg));bad.filters[0].conditions[0].key='madeUp';assert.throws(()=>configOf(bad));
 const nested=JSON.parse(JSON.stringify(cfg));nested.filters[0].conditions[0].conditions=[];assert.throws(()=>configOf(nested));
});

test('a proven buyer lower bound qualifies only thresholds it actually proves',()=>{
 const c=coin();delete c.bx;c.gx=[[(c.t+6*M)/1000,10,1,8,1,18,2,12,2]];
 const F=starterFeaturesAt(c,T);assert.equal(F.buyers10,12);assert.equal(F.buyers10LowerBound,true);assert.equal(evaluation(F,cfg.filters[0]),'pass');assert.equal(evaluation(F,{key:'buyers10',op:'>=',value:25}),'unknown');
 assert.equal(evaluation(F,{key:'buyers10',op:'<=',value:10}),'reject');assert.equal(evaluation(F,{key:'buyers10',op:'<=',value:20}),'unknown');
 c.gx.push([(c.t+8*M)/1000,5,0,5,0,7,1,7,1]);assert.equal(starterFeaturesAt(c,T).buyers10,12,'overlapping buyer windows must never be summed');
});
test('buyer evidence excludes future receipts and buyers of a later migrated pool',()=>{
 const c=coin();delete c.bx;c.gx=[[(c.t+11*M)/1000,30,1,30,1,30,1,30,1]];assert.equal(starterFeaturesAt(c,T).buyers10,null);
 c.gx=[[(c.t+6*M)/1000,12,1,12,1,12,1,12,1]];assert.equal(starterFeaturesAt(c,c.t+5*M).buyers10,null);
 assert.equal(starterFeaturesAt(c,T,{eventAt:c.t-60*M,phase:'before'}).buyers10,null);
 const prior={t:c.t-60*M,gx:[[(c.t-55*M)/1000,11,0,11,0,11,0,11,0]]};c.origs=[prior];assert.equal(starterFeaturesAt(c,T,{eventAt:prior.t,phase:'before'}).buyers10,11);
});
test('an early migration can prove a buyer subset only inside the original mint window',()=>{
 const c=coin(),eventAt=c.t-4*M;delete c.bx;c.gx=[[(eventAt+6*M)/1000,12,1,12,1,18,1,18,1]];c.origs=[{p:'curve',t:eventAt,gx:[[(eventAt+3*M)/1000,14,0,14,0,14,0,14,0]]}];
 const f=starterFeaturesAt(c,T,{eventAt,phase:'before'});assert.equal(f.buyers10,18);assert.equal(f.buyers10LowerBound,true,'18 and 14 must not be summed');
 c.gx=[[(eventAt+11*M)/1000,99,0,99,0,99,0,99,0]];assert.equal(starterFeaturesAt(c,T,{eventAt}).buyers10,14,'late migration buyers cannot leak into the original ten minutes');
});
