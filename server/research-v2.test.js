'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {featuresAt,activityOutcome,strengthOutcome,proposeRules,ruleStats,capBank}=require('./research-v2');
const M=60_000,START=Date.UTC(2026,9,17,9,0),T=START+10*M;
function snapshots(hours,activityFn,priceFn=()=>1){
  const ds=[];
  // 1-minute snapshots suffice; their m5 fields stand for trailing 5 minutes.
  for(let i=1;i<=hours*60;i++){
    const active=activityFn(i);
    ds.push([Math.floor((START+i*M)/1000),priceFn(i),10000,20000,
      active?2:0,active?1:0,active?400:0]);
  }
  return {ds};
}
function path({highMinutes=210,from=T,endMinutes=300,p0=1}={}){
  const c=[];
  for(let i=0;i<=endMinutes;i++) {
    const p=i===0?p0:i<=highMinutes?p0*1.2:p0*.6;
    c.push([Math.floor((from+i*M)/1000),p,p,p,p,100]);
  }
  return {path:{at:from+endMinutes*M+M,upto:5,c}};
}
test('Live label is about trading activity, not even a large price fall',()=>{
 const c=snapshots(5,()=>true,i=>1-i/(5*60)*.4);
 const r=activityOutcome(c,START,{hours:5,minActive:70,maxIdle:60},START+5*60*M+2*M);
 assert.equal(r.label,'live');assert.equal(r.activePct,100);
});
test('Dead means insufficient trading, even if price rises sharply',()=>{
 const c=snapshots(5,i=>i<20,i=>1+i/(5*60));
 const r=activityOutcome(c,START,{hours:5,minActive:70,maxIdle:60},START+5*60*M+2*M);
 assert.equal(r.label,'dead');assert.ok(r.activePct<20);
});
test('Missing observations are not magically zero transactions',()=>{
 const c=snapshots(5,()=>true);c.ds=c.ds.slice(0,30);
 const r=activityOutcome(c,START,{hours:5},START+5*60*M+2*M);
 assert.equal(r.label,'pending');assert.equal(r.why,'insufficient-activity-coverage');
});
test('Do not judge before full observation',()=>{
 const c=snapshots(5,()=>true);
 assert.equal(activityOutcome(c,START,{hours:5},START+4*60*M).label,'pending');
});
test('Second level: 210 of 300 minutes strictly above zero-price = strong',()=>{
 const c=path({highMinutes:210});
 const r=strengthOutcome(c,T,{minAbove:70},T+301*M);
 assert.equal(r.label,'strong');assert.equal(r.above,210);assert.equal(r.covered,300);
});
test('Second level: threshold 70% and 209 positive minutes = weak',()=>{
 const c=path({highMinutes:209});
 const r=strengthOutcome(c,T,{minAbove:70},T+301*M);
 assert.equal(r.label,'weak');assert.equal(r.above,209);
});
test('Low coverage or missing price at zero returns pending',()=>{
 assert.equal(strengthOutcome({},T,{},T+301*M).label,'pending');
 const c=path({highMinutes:250,endMinutes:80});
 assert.equal(strengthOutcome(c,T,{},T+301*M).label,'pending');
});
test('Green-area features do not see future price/volume data',()=>{
 const c={ds:[
  [Math.floor((START+5*M)/1000),1,8000,20000,3,2,100],
  [Math.floor((START+12*M)/1000),4,50000,40000,999,888,999999]]};
 const F=featuresAt(c,T);
 assert.equal(F.volume,100);assert.equal(F.liq,8000);assert.equal(F.trades,5);
});
test('Automatic rules require required positives and negatives and score both',()=>{
 const rows=[];
 for(let i=0;i<100;i++)rows.push({time:START+i*M,label:'live',features:{buyers:100+i,trades:10+i,volume:4000+i*10,liq:10000+i*10}});
 for(let i=0;i<80;i++)rows.push({time:START+(i+100)*M,label:'dead',features:{buyers:i,trades:i/10,volume:100+i,liq:1000+i}});
 const found=proposeRules(rows,{minPos:100,minNeg:1});
 assert.ok(found.length>0);
 const stat=ruleStats(rows,found[0].rule,'live','dead');
 assert.ok(stat.positiveRecall>=.55);assert.ok(stat.negativeRejection>=.5);
 assert.deepEqual(proposeRules(rows.slice(0,50),{minPos:100}),[]);
});
test('Polygon rolls newest 5000 positive and 5000 negative, no duplicates',()=>{
 const rows=[];
 for(let i=0;i<6000;i++)rows.push({time:i,mint:'L'+i,label:'live'});
 for(let i=0;i<6000;i++)rows.push({time:i+1,mint:'D'+i,label:'dead'});
 rows.push({...rows.at(-1),time:7000});
 const out=capBank(rows,it=>it.label,'live','dead',5000);
 assert.equal(out.length,10000);
 assert.equal(out.filter(x=>x.label==='live').length,5000);
 assert.equal(new Set(out.map(x=>x.mint)).size,10000);
});
