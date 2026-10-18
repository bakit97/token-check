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
