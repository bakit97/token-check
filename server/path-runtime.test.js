'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {PassRuntime,configOf}=require('./pass-runtime');
const {ResearchTwoRuntime}=require('./research-two-runtime');
const {ResearchEpoch}=require('./research-config');
const {discover}=require('./auto-research-v2');
const MIN=60000;
const mint='SoL2'.padEnd(44,'q');

function folder(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'solscan-verified-v2-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return dir;
}
function filterConfig(){
  return {schema:1,enabled:true,activatedAt:0,decisionMinutes:10,
    filters:[
      {id:'one',name:'buyers',level:'1',key:'buyers',op:'>=',value:20,version:1},
      {id:'two',name:'trades',level:'2',key:'trades',op:'>=',value:8,version:3}
    ],
    modules:[
      {filterId:'one',phase:'before',level:'1',enabled:true},
      {filterId:'two',phase:'before',level:'2',enabled:true}
    ]};
}
function candidate(accepted){
  const zero=accepted+10*MIN;
  const entry=accepted+MIN;
  const final=zero-MIN;
  const sample=(at,buys,sells)=>[Math.round(at/1000),1,250,500,buys,sells,100];
  return {a:mint,n:'Synthetic token',s:'SYN',
    ds:[sample(entry,5,5),sample(final,5,5)],
    gx:[[Math.round(entry/1000),20,10,30,15]],
    path:{c:Array.from({length:301},(_,i)=>{
      const price=i===0?1:2;
      return [Math.round((zero+i*MIN)/1000),price,price,price,price,1]
    })}};
}
function setupPass(t){
  const dir=folder(t);
  const cfg=filterConfig();
  const runtime=new PassRuntime({dir,config:cfg});
  const accepted=Date.now()+3000;
  const src={records:new Map([[mint,{mint,phase:'before',acceptedAt:accepted}]])};
  const coin=candidate(accepted),coins=new Map([[mint,coin]]);
  return {dir,cfg,runtime,accepted,coin,coins,src};
}

test('new Passed event is fsynced with frozen config, only once and never backfilled',t=>{
  const x=setupPass(t);
  const admissionNow=x.accepted+2*MIN;
  const r=x.runtime.update({source:x.src,coins:x.coins,now:admissionNow});
  assert.equal(r.added,1);
  const event=x.runtime.records.get(mint);
  assert.equal(event.matches[0].version,1);
  assert.equal(event.secondLevelRules[0].version,3);
  assert.equal(event.zeroAt,x.accepted+10*MIN);
  assert.equal(event.firstSeenAt,admissionNow);
  assert.equal(event.features.buyers,30);
  assert.equal(x.runtime.update({source:x.src,coins:x.coins,now:admissionNow+1}).added,0);
  const file=path.join(x.dir,'pass-v2-journal');
  assert.equal(fs.readdirSync(file).filter(v=>v.endsWith('.jsonl')).length,1);
  const restarted=new PassRuntime({dir:x.dir,config:x.cfg});
  assert.equal(restarted.records.size,1);
  assert.equal(restarted.records.get(mint).zeroAt,event.zeroAt);
  x.cfg.filters[0].version=2;x.cfg.filters[0].value=9999;
  restarted.applyConfig(x.cfg);
  assert.equal(restarted.records.get(mint).matches[0].version,1);
  assert.equal(restarted.records.get(mint).matches[0].value,20);
});

test('partial final journal line is never accepted and is preserved for diagnostics',t=>{
  const x=setupPass(t);
  x.runtime.update({source:x.src,coins:x.coins,now:x.accepted+2*MIN});
  const journal=path.join(x.dir,'pass-v2-journal',fs.readdirSync(path.join(x.dir,'pass-v2-journal')).find(v=>v.endsWith('.jsonl')));
  fs.appendFileSync(journal,'{"half":');
  const restarted=new PassRuntime({dir:x.dir,config:x.cfg});
  assert.equal(restarted.records.size,1);
  assert.ok(fs.readFileSync(journal,'utf8').endsWith('\n'));
  assert.equal(fs.readdirSync(path.dirname(journal)).filter(v=>v.includes('.partial-')).length,1);
});

test('no Passed signal for missing features, expired decision window or pre-activation',t=>{
  const dir=folder(t);
  const config=filterConfig();
  const p=new PassRuntime({dir,config});
  const accepted=Date.now()+3000;
  const noFeatures={a:mint,ds:[],gx:[]};
  const src={records:new Map([[mint,{mint,phase:'before',acceptedAt:accepted}]])};
  assert.equal(p.update({source:src,coins:new Map([[mint,noFeatures]]),now:accepted+MIN}).added,0);
  assert.ok(p.update({source:src,coins:new Map([[mint,noFeatures]]),now:accepted+MIN}).missingFeatures>0);
  assert.equal(p.update({source:src,coins:new Map([[mint,candidate(accepted)]]),now:accepted+11*MIN}).added,0);
  const prior=Date.now()-MIN;
  const other='OldToken'.padEnd(44,'r');
  assert.equal(p.update({source:{records:new Map([[other,{mint:other,phase:'before',acceptedAt:prior}]])},
    coins:new Map([[other,{...candidate(prior),a:other}]]),now:Date.now()}).added,0);
});

test('second level uses immutable Passed cohort and real five-hour price coverage',t=>{
  const x=setupPass(t);
  x.runtime.update({source:x.src,coins:x.coins,now:x.accepted+2*MIN});
  const event=x.runtime.records.get(mint);
  const r2=new ResearchTwoRuntime({dir:x.dir,config:{minAbove:70,minCoverage:.9}});
  assert.equal(r2.update({passes:x.runtime,coins:x.coins,now:event.zeroAt+4*60*MIN}).added,0);
  const results=r2.update({passes:x.runtime,coins:x.coins,now:event.zeroAt+301*MIN});
  assert.equal(results.added,1);
  const row=r2.rows[0];
  assert.equal(row.label,'strong');
  assert.equal(row.zeroAt,event.zeroAt);
  assert.equal(row.secondLevelMatches[0].version,3);
  assert.ok(row.pctAbove>=99);
  assert.equal(r2.aggregateCurves().before.find(v=>v.min===1).n,1);
  assert.equal(r2.aggregateCurves().before.find(v=>v.min===1).pct,100);
  const restored=new ResearchTwoRuntime({dir:x.dir});
  assert.equal(restored.rows.length,1);
  assert.equal(restored.update({passes:x.runtime,coins:x.coins,now:event.zeroAt+302*MIN}).added,0);
  const withGap={...x.coin,path:{c:[[Math.round(event.zeroAt/1000),1,1,1,1,0]]}};
  assert.equal(require('./research-v2').strengthOutcome(withGap,event.zeroAt,{},event.zeroAt+301*MIN).label,'pending');
});

test('research epochs preserve earlier version when an observation threshold changes',t=>{
  const dir=folder(t);
  const v=c=>({minAbove:c.minAbove??70,minCoverage:c.minCoverage??.9});
  const manager=new ResearchEpoch({dir,key:'two',validate:v,config:{minAbove:70}});
  const old=manager.current;
  assert.equal(manager.apply({minAbove:75}),true);
  assert.equal(manager.history.length,1);
  assert.equal(manager.history[0].hash,old.hash);
  const restored=new ResearchEpoch({dir,key:'two',validate:v,config:{minAbove:75}});
  assert.equal(restored.history.length,1);
  assert.equal(restored.current.hash,manager.current.hash);
});

test('automatic research keeps calendar days separate between training and holdout',()=>{
  const t=Date.UTC(2026,9,12,12,0);
  const rows=[];
  for(let i=0;i<84;i++){
    const train=i<60;
    const label=i%2?'live':'dead';
    rows.push({mint:'SYN'+i,time:t+(train?0:86400000)+i*1000,
      label,features:{buyers:label==='live'?100:1}});
  }
  const r=discover(rows,{level:'1',minTrainPositive:20,minTrainNegative:20,minValidation:20});
  assert.equal(r.status,'rolling-holdout-ready');
  assert.equal(r.training.total,60);
  assert.equal(r.validation.total,24);
  assert.equal(new Set(r.trainingDays.concat(r.validationDays)).size,2);
  assert.ok(r.rules.length>0);
  assert.ok(r.rules.every(f=>f.holdout&&f.holdout.totalPositive===12));
});

test('reject unknown level-two filter modules and duplicate filter IDs',()=>{
  const cfg=filterConfig();
  cfg.modules[1].level='1';
  assert.throws(()=>configOf(cfg),/Invalid module/);
  cfg.modules[1].level='2';
  cfg.filters[1].id='one';
  assert.throws(()=>configOf(cfg),/Invalid filter/);
});
