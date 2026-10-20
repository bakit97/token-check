'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ResearchTwoRuntime,configOf,lineClock,relabelStrength}=require('../server/research-two-runtime');
const {ResearchEpoch}=require('../server/research-config');
const {ResearchBanks}=require('../server/research-banks');
const {strengthOutcome}=require('../server/research-v2');
const M=60000,T=Date.UTC(2026,9,20),mint='So11111111111111111111111111111111111111112';
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'line-two-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
function data(line,prices){return {p:'pool',ds:prices.map((p,i)=>[(line+i*M)/1000,p,100,100,10,2,100])};}
test('line clock uses actual late verdict receipt plus phase timer and configured observation hours',()=>{
 const pass={firstSeenAt:T+12*M,zeroAt:T+10*M};assert.deepEqual(lineClock(pass,{passWindowMinutes:3,hours:2}),{verdictAt:T+12*M,lineAt:T+15*M,windowEnd:T+135*M});
 assert.equal(lineClock({firstSeenAt:T+2*M,zeroAt:T+10*M},{passWindowMinutes:5}).lineAt,T+15*M,'legacy early Passed cannot start before its verdict');
});
test('line comparison includes the exact margin; every minute of the whole window is denominator',()=>{
 const prices=[100,...Array(42).fill(110),...Array(18).fill(109)];
 const r=strengthOutcome(data(T,prices),T,{hours:1,minAbove:70,minAboveMarginPct:10},T+61*M);assert.equal(r.label,'strong');assert.equal(r.above,42);assert.equal(r.covered,60);
 assert.equal(strengthOutcome(data(T,prices),T,{hours:1,minAbove:71,minAboveMarginPct:10},T+61*M).label,'weak');
 assert.equal(strengthOutcome(data(T,prices),T,{hours:1},T+60*M).label,'pending');
 assert.equal(strengthOutcome(data(T+5*M,prices.slice(5)),T,{hours:1},T+61*M).why,'no-price-at-zero');
});
test('raw minute curve reclassifies across restart and bank labels move without losing rows',t=>{
 const d=dir(t),pass={mint,phase:'after',acceptedAt:T,eventAt:T,firstSeenAt:T+12*M,zeroAt:T+10*M,matches:[],features:{}},passes={records:new Map([[mint,pass]])};
 const cfg=configOf({hours:1,passWindowMinutes:3,minAboveMarginPct:10,minAbove:70}),line=T+15*M;
 const coins=new Map([[mint,data(line,[100,...Array(42).fill(110),...Array(18).fill(105)])]]);
 const rt=new ResearchTwoRuntime({dir:d,config:cfg});assert.equal(rt.update({passes,coins,now:line+61*M}).added,1);const row=rt.rows[0];assert.equal(row.lineAt,line);assert.equal(row.zeroAt,line);assert.equal(row.linePrice,100);assert.equal(row.label,'strong');assert.equal(row.windowEnd,line+60*M);
 const banks=new ResearchBanks({dir:d});banks.upsert(rt.rows);assert.equal(banks.summary().counts.after.strong,1);
 const changed=configOf({...cfg,minAboveMarginPct:11});rt.config=changed;rt.update({passes,coins:new Map(),now:line+62*M});assert.equal(rt.rows[0].label,'weak');assert.equal(rt.rows[0].pctAbove,0);
 banks.relabelTwo(changed);assert.equal(banks.summary().counts.after.strong,0);assert.equal(banks.summary().counts.after.weak,1);assert.ok(banks.select({level:'2'})[0].minuteCurvePacked);
 const reopened=new ResearchTwoRuntime({dir:d,config:changed});assert.equal(reopened.rows.length,1);assert.equal(reopened.rows[0].label,'weak');
 banks.relabelTwo(cfg);assert.equal(banks.summary().counts.after.strong,1);assert.equal(banks.summary().counts.after.weak,0);assert.equal(relabelStrength(row,{...cfg,passWindowMinutes:4}),null,'cannot shift an already normalized price curve to another line');
});
test('margin and minAbove edits retain epoch; timer/hours edits create a new epoch',t=>{
 const e=new ResearchEpoch({dir:dir(t),key:'two',validate:configOf,config:{passWindowMinutes:3,hours:1}}),first={...e.current};
 assert.equal(e.apply({passWindowMinutes:3,hours:1,minAbove:90,minAboveMarginPct:20}),false);assert.equal(e.current.activeAt,first.activeAt);assert.equal(e.current.hash,first.hash);assert.equal(e.history.length,0);
 assert.equal(e.apply({passWindowMinutes:4,hours:1}),true);assert.equal(e.history.length,1);assert.equal(e.apply({passWindowMinutes:4,hours:2}),true);
});
test('line configuration validates at control API boundary including phase overrides',()=>{
 for(const invalid of [{hours:0},{hours:13},{passWindowMinutes:0},{passWindowMinutes:31},{minAboveMarginPct:-1},{minAboveMarginPct:NaN},{minAbove:NaN}])assert.throws(()=>configOf(invalid));
 const cfg=configOf({phases:{after:{passWindowMinutes:3,minAboveMarginPct:15,hours:2}}});assert.equal(cfg.phases.after.passWindowMinutes,3);assert.equal(cfg.phases.before.passWindowMinutes,5);
});
