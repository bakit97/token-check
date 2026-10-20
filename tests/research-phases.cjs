'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ResearchRuntime,settings}=require('../server/research-runtime');
const {ResearchEpoch}=require('../server/research-config');
const {AutoStudies}=require('../server/auto-research-v2');
const M=60000,H=60*M,T=Date.UTC(2026,9,19),mint='So11111111111111111111111111111111111111112';
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'phase-study-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}
test('research phases observe their own hours and thresholds from detection',t=>{
 const runtime=new ResearchRuntime({dir:dir(t),config:{lastHourWallets:0,minUniqueBuyers:0,phases:{before:{hours:1,minActive:70},after:{hours:2,minActive:90}}}});
 const source={records:new Map([['a',{mint:'a',phase:'before',acceptedAt:T,eventAt:T}],['b',{mint:'b',phase:'after',acceptedAt:T,eventAt:T}]])};
 const ds=Array.from({length:121},(_,i)=>[(T+i*M)/1000,1,100,100,3,1,20]);
 const x={};for(let m=1;m<120;m++)for(let i=0;i<2;i++)x[m+'-'+i]=[(T+m*M+i*1000)/1000,1,1,i?'A'.repeat(32):'B'.repeat(32),1,.1,T+m*M+2000];
 const coins=new Map([['a',{ds,tr:{x}}],['b',{ds,tr:{x}}]]);let r=runtime.update({source,coins,now:T+H+5*M});assert.equal(r.added,1);assert.equal(r.counts.preLive,1);assert.equal(r.pending['not-yet-finished'],1);
 r=runtime.update({source,coins,now:T+2*H+5*M});assert.equal(r.added,1);assert.equal(r.counts.postLive,1);assert.equal(runtime.select({phase:'before'})[0].decisionAt,T+10*M);
});
test('changing only targets preserves epoch, observations and activation across restart',t=>{
 const d=dir(t),cfg=settings(),epoch=new ResearchEpoch({dir:d,key:'one',validate:settings,config:cfg}),at=epoch.current.activeAt,hash=epoch.current.hash;
 assert.equal(epoch.apply({...cfg,targetLive:200}),false);assert.equal(epoch.current.hash,hash);assert.equal(epoch.current.activeAt,at);assert.equal(epoch.current.config.targetLive,200);assert.equal(epoch.history.length,0);
 const withPhases={...cfg,phases:{before:{...cfg,targetLive:300},after:{...cfg,targetDead:200}}};assert.equal(epoch.apply(withPhases),false);
 const restarted=new ResearchEpoch({dir:d,key:'one',validate:settings,config:withPhases});assert.equal(restarted.current.hash,hash);assert.equal(restarted.current.activeAt,at);assert.equal(restarted.history.length,0);
 assert.equal(restarted.apply({...withPhases,phases:{before:{hours:2},after:{hours:5}}}),true);
});
test('auto modules have stable server birth, phase, time, compound conditions and genuinely future live cohorts',t=>{
 const d=dir(t),a=new AutoStudies({dir:d}),now=T+40*H;
 const rows=Array.from({length:40},(_,i)=>({mint:mint+i,phase:'before',label:i<20?'live':'dead',acceptedAt:T+i*M,time:T+i*M,features:{buys:i<20?100+i:1+i/100,quoteSol:i<20?10:1}}));
 const cfg={targetLive:10,targetDead:10,decisionMinutes:10};let report=a.report(rows,{settings:cfg,now});assert.equal(report.rules.length,0,'training-only proposals must not be born');rows.push(...Array.from({length:120},(_,i)=>({mint:'holdout'+i,phase:'before',label:i%2?'live':'dead',acceptedAt:T+24*H+i*M,time:T+24*H+i*M,features:{buys:i%2?150:1,quoteSol:i%2?10:1}})));report=a.report(rows,{settings:cfg,now});assert.ok(report.rules.length);const first=report.rules[0];assert.equal(first.phase,'before');assert.equal(first.verdictMinutes,10);assert.equal(first.createdAt,now);assert.equal(first.eval.live,null);assert.ok(first.conds.length>=1&&first.conds.length<=3);
 const b=new AutoStudies({dir:d});report=b.report(rows.concat([{mint:'future',phase:'before',label:'live',acceptedAt:now+M,time:now+M,features:{buys:200,quoteSol:10}}]),{settings:cfg,now:now+2*M});const old=report.rules.find(x=>x.id===first.id);assert.equal(old.createdAt,now);assert.equal(old.eval.live.totalPositive,1);assert.equal(old.eval.live.totalNegative,0);assert.deepEqual(old.eval.train,first.eval.train);
});
