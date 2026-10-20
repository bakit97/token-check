'use strict';
// Synthetic, read-only correctness tests for the new server data paths.
// No network, private credentials, token purchases or trades.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {PassRuntime}=require('./pass-runtime');
const {ResearchTwoRuntime}=require('./research-two-runtime');
const {ResearchEpoch}=require('./research-config');
const {settings}=require('./research-runtime');
const {discover}=require('./auto-research-v2');
const {FilterAudit}=require('./filter-audit');
const MIN=60000,HOUR=60*MIN;
const MINT='So11111111111111111111111111111111111111112';
const MINT2='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function dir(t){
  const p=fs.mkdtempSync(path.join(os.tmpdir(),'solscan-v2path-'));
  t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;
}
function passConfig({enabled=true,value=10,version=1}={}){
  return {schema:1,enabled,activatedAt:0,decisionMinutes:10,
    filters:[
      {id:'001',name:'Сделки ≥10',level:'1',key:'trades',op:'>=',value,version},
      {id:'002',name:'Объём ≥100',level:'2',key:'volume',op:'>=',value:100,version:1}
    ],modules:[
      {filterId:'001',phase:'after',level:'1',enabled:true},
      {filterId:'002',phase:'after',level:'2',enabled:true}
    ]};
}
function dataAt(millis,price=1,buys=10,sells=5){
  return [Math.floor(millis/1000),price,5000,10000,buys,sells,2000];
}
function createPassed(runtime,mint=MINT){
  const at=runtime.config.activatedAt+1000,seen=at+2*MIN;
  const coin={a:mint,n:'Исследуемая монета',ds:[dataAt(seen)]};
  const source={records:new Map([[mint,{mint,phase:'after',acceptedAt:at}]])};
  const result=runtime.update({source,coins:new Map([[mint,coin]]),now:seen});
  return {coin,at,seen,result,record:runtime.records.get(mint)};
}
function chart(zeroAt,strong=true){
  const c=[];
  for(let m=0;m<=300;m++){
    const value=m===0?1:(m<=(strong?240:150)?1.5:.5);
    c.push([Math.floor((zeroAt+m*MIN)/1000),value,value,value,value,500]);
  }
  return {path:{c,upto:5,at:zeroAt+6*HOUR},
    ds:[dataAt(zeroAt-MIN,1,10,5)]};
}
test('Passed server: only accepted fresh events, immutable versions and post-Passed rule snapshot',t=>{
  const p=new PassRuntime({dir:dir(t),config:passConfig()});
  const x=createPassed(p);
  assert.equal(x.result.added,1);
  assert.equal(p.records.size,1);
  assert.equal(x.record.zeroAt,x.at+10*MIN);
  assert.equal(x.record.matches[0].version,1);
  assert.equal(x.record.secondLevelRules[0].id,'002');
  assert.equal(p.update({source:{records:new Map([[MINT,{mint:MINT,phase:'after',acceptedAt:x.at}]])},
    coins:new Map([[MINT,x.coin]]),now:x.seen+MIN}).added,0);
  const after=p.config.activatedAt;
  p.applyConfig(passConfig({value:20,version:2}));
  assert.ok(p.config.activatedAt>=after);
  assert.equal(x.record.matches[0].version,1);
  const lateAt=p.config.activatedAt+1000;
  const source={records:new Map([[MINT2,{mint:MINT2,phase:'after',acceptedAt:lateAt}]])};
  const late={a:MINT2,ds:[dataAt(lateAt+MIN)]};
  assert.equal(p.update({source,coins:new Map([[MINT2,late]]),now:lateAt+20*MIN}).added,0,
    'old admissions must not become new signals after the original deadline');
});
test('Passed journal survives restart and recovers only an incomplete tail',t=>{
  const d=dir(t),cfg=passConfig();
  const first=new PassRuntime({dir:d,config:cfg});
  const sample=createPassed(first);
  assert.equal(sample.result.added,1);
  const file=path.join(d,'pass-v2-journal',fs.readdirSync(path.join(d,'pass-v2-journal'))[0]);
  fs.appendFileSync(file,'{"partially-written":');
  const reload=new PassRuntime({dir:d,config:cfg});
  assert.equal(reload.records.get(MINT).firstSeenAt,sample.seen);
  assert.equal(fs.readFileSync(file,'utf8').endsWith('\n'),true);
  assert.ok(fs.readdirSync(path.dirname(file)).some(x=>x.includes('.partial-')));
  fs.appendFileSync(file,'{"bad":true}\n');
  assert.throws(()=>new PassRuntime({dir:d,config:cfg}),/Malformed committed/);
});
test('Level two: only verified Passed cohort after fixed zero and full five-hour coverage',t=>{
  const d=dir(t),zeroAt=Date.now()-7*HOUR;
  const passed={mint:MINT,phase:'after',acceptedAt:zeroAt-10*MIN,
    firstSeenAt:zeroAt-8*MIN,zeroAt,configHash:'first',
    matches:[{id:'001',level:'1',version:1}],
    secondLevelRules:[{id:'002',level:'2',version:1,
      name:'Объём',key:'volume',op:'>=',value:100}]};
  const runtime=new ResearchTwoRuntime({dir:d});
  const passes={records:new Map([[MINT,passed]])};
  assert.equal(runtime.update({passes,coins:new Map([[MINT,{ds:[]}]]),
    now:zeroAt+6*HOUR}).added,0,'incomplete price history is unknown, not weak');
  const result=runtime.update({passes,coins:new Map([[MINT,chart(zeroAt)]]),
    now:zeroAt+6*HOUR+16*MIN});
  assert.equal(result.added,1);
  assert.equal(runtime.select()[0].label,'weak','a flat price after the timer does not clear the default 10% margin');
  assert.equal(runtime.select()[0].secondLevelMatches.length,0,'snapshot at minute 9 is later than acceptedAt + 5 min');
  assert.equal(runtime.select()[0].features.volume,null);
  assert.equal(runtime.select()[0].decisionAt,passed.acceptedAt+5*MIN);
  assert.equal(runtime.select()[0].minuteCurvePacked.length,3200);
  assert.equal(runtime.aggregateCurves().after.length,300);
  assert.equal(runtime.aggregateCurves().after[120].n,1);
  const restarted=new ResearchTwoRuntime({dir:d});
  assert.equal(restarted.select().length,1);
  assert.equal(restarted.update({passes,coins:new Map([[MINT,chart(zeroAt)]]),
    now:zeroAt+7*HOUR}).added,0);
  assert.equal(restarted.aggregateCurves().after.length,300);
});
test('Level two respects research activation and archived cohort end',t=>{
  const zeroAt=Date.now()-7*HOUR,passes={records:new Map([
    [MINT,{mint:MINT,phase:'after',zeroAt,firstSeenAt:zeroAt-10*MIN,
      acceptedAt:zeroAt-15*MIN,matches:[],features:{}}]
  ])};
  const later=new ResearchTwoRuntime({dir:dir(t),cohortStart:zeroAt});
  assert.equal(later.update({passes,coins:new Map([[MINT,chart(zeroAt)]]),
    now:zeroAt+6*HOUR}).added,0);
  const earlier=new ResearchTwoRuntime({dir:dir(t),cohortStart:0,cohortEnd:zeroAt-20*MIN});
  assert.equal(earlier.update({passes,coins:new Map([[MINT,chart(zeroAt)]]),
    now:zeroAt+6*HOUR}).added,0);
});
test('Research epoch persists history and never reuses an old bank after a changed setting',t=>{
  const d=dir(t),initial=settings();
  const e=new ResearchEpoch({dir:d,key:'one',validate:settings,
    config:initial,adoptLegacy:true});
  assert.equal(e.current.activeAt,0);
  assert.equal(e.apply({...initial,hours:6}),true);
  assert.equal(e.history.length,1);
  const middle=e.current.activeAt;
  assert.equal(e.apply(initial),true);
  assert.equal(e.history.length,2);
  assert.notEqual(e.current.activeAt,0);
  const restarted=new ResearchEpoch({dir:d,key:'one',validate:settings,config:initial});
  assert.equal(restarted.history.length,2);
  assert.equal(restarted.current.activeAt,e.current.activeAt);
  assert.ok(restarted.history.some(x=>x.activeAt===middle));
});
test('Auto-study isolates a later calendar day for out-of-time checking',()=>{
  const start=Date.UTC(2026,9,17,7,0),rows=[];
  for(let i=0;i<110;i++)rows.push({
    time:start+i*MIN,mint:'train-live-'+i,label:'live',
    features:{trades:30+i,volume:5000+i}});
  for(let i=0;i<70;i++)rows.push({
    time:start+(110+i)*MIN,mint:'train-dead-'+i,label:'dead',
    features:{trades:1,volume:2}});
  const next=start+24*HOUR;
  for(let i=0;i<120;i++)rows.push({
    time:next+i*MIN,mint:'holdout-'+i,label:i%2?'live':'dead',
    features:{trades:i%2?35:2,volume:i%2?500:1}});
  const res=discover(rows,{level:'1'});
  assert.equal(res.status,'rolling-holdout-ready');
  assert.equal(res.validation.total,120);
  assert.deepEqual(res.validationDays,[new Date(next+5*HOUR).toISOString().slice(0,10)]);
  assert.notDeepEqual(res.trainingDays,res.validationDays);
});
test('Server filter audit retains earlier versions instead of rewriting originals',t=>{
  const d=dir(t),audit=new FilterAudit({dir:d}),activatedAt=Date.now()-HOUR;
  const config={
    enabled:true,activatedAt,
    filters:[{id:'01',name:'Сделки',level:'1',version:1,
      key:'trades',op:'>=',value:10}],
    modules:[{filterId:'01',phase:'after',level:'1',enabled:true}]
  };
  const bank=[];
  for(let i=0;i<25;i++){
    bank.push({phase:'after',acceptedAt:activatedAt-7*HOUR-i*MIN,
      label:'live',features:{trades:20},time:activatedAt-7*HOUR-i*MIN});
    bank.push({phase:'after',acceptedAt:activatedAt-7*HOUR-i*MIN,
      label:'dead',features:{trades:1},time:activatedAt-7*HOUR-i*MIN});
  }
  let report=audit.report({config,one:bank,now:Date.now()});
  assert.equal(report.rules[0].original.positivePercent,100);
  const captured=report.rules[0].original.capturedAt;
  const changed={...config,activatedAt:Date.now(),filters:[
    {...config.filters[0],version:2,value:30}]};
  report=audit.report({config:changed,one:bank,now:Date.now()+1000});
  assert.equal(report.totalRules,2);
  assert.equal(report.archivedRules,1);
  assert.equal(report.rules.find(x=>x.version===1).original.capturedAt,captured);
  const restored=new FilterAudit({dir:d});
  assert.equal(restored.versions.size,2);
});
