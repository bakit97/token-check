'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const analytics=require('../server/research-v2'),lib=require('../server/module-library'),{PassRuntime,configOf}=require('../server/pass-runtime'),{identity}=require('../server/venue-identity'),{AutoStudies,discover}=require('../server/auto-research-v2');
const T=Date.UTC(2026,9,20),M=60000,def={id:'venue',name:'Площадка',phase:'after',level:'1',verdictMinutes:2,conds:[{key:'dex',op:'in',values:['PumpSwap','Raydium CPMM']}]};
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'category-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
function coin(dex='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',family='pump'){return {p:'p',admissionVerifiedAt:T+M,mg:{st:'ok',k:family,owner:dex,seenAt:T+M}};}
test('verified venue uses pool program and migration family, never guesses bonk from generic LaunchLab',()=>{
 assert.deepEqual(identity(coin(),'after',T+M),{launchpad:'pump.fun',dex:'PumpSwap',venue:'pump.fun → PumpSwap',venueObservedAt:T+M});
 assert.equal(identity(coin(),'after',T).dex,null);
 assert.equal(identity(coin('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C','launch'),'after',T+M).launchpad,'Raydium LaunchLab');
 const manual=identity({...coin(),mg:{st:'ok',k:'manual-pool',owner:'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'}},'before',T+M);assert.equal(manual.launchpad,null);assert.equal(manual.venue,'PumpSwap');
 const f=analytics.levelTwoFeaturesAt(coin(),T+2*M,{acceptedAt:T,entryAt:T,phase:'after'});assert.equal(f.dex,'PumpSwap');assert.equal(f.launchpad,'pump.fun');
});
test('category conditions validate separately from numbers and signatures include sorted actual choices',()=>{
 const m=lib.definition(def);assert.equal(analytics.evaluation({dex:'PumpSwap'},{conds:m.conds}),'pass');assert.equal(analytics.evaluation({dex:'Meteora DAMM v2'},{conds:m.conds}),'reject');assert.equal(analytics.evaluation({dex:null},{conds:m.conds}),'unknown');
 assert.equal(lib.moduleSignature(m),lib.moduleSignature({...m,conds:[{...m.conds[0],values:[...m.conds[0].values].reverse()}]}));
 assert.notEqual(lib.moduleSignature(m),lib.moduleSignature({...m,conds:[{key:'dex',op:'in',values:['Orca']}]}));
 for(const c of [{key:'dex',op:'>=',value:0},{key:'buyers',op:'in',values:['PumpSwap']},{key:'dex',op:'in',values:[]},{key:'dex',op:'in',values:[2]},{key:'dex',op:'in',values:['PumpSwap','PumpSwap']}])assert.throws(()=>lib.definition({...def,conds:[c]}));
 const cfg=configOf({schema:1,enabled:true,activatedAt:0,decisionMinutes:2,passMode:'1',filters:[{...def,version:1}],modules:[{filterId:'venue',phase:'after',level:'1',enabled:true}]});assert.equal(cfg.filters[0].conds[0].op,'in');
});
test('categorical Window, manual test and silent live all evaluate the same immutable early snapshot',async t=>{
 const pass=new PassRuntime({dir:dir(t),config:{schema:1,enabled:true,activatedAt:0,decisionMinutes:2,passMode:'1',filters:[{...def,version:1}],modules:[{filterId:'venue',phase:'after',level:'1',enabled:true}]}});
 const at=pass.config.activatedAt+M,c=coin();c.admissionVerifiedAt=at+M;const source={records:new Map([['m',{mint:'m',phase:'after',acceptedAt:at,eventAt:at-30*M}]])};require('../server/feature-snapshots').capture(c,source.records.get('m'),at+2*M);
 assert.equal(pass.update({source,coins:new Map([['m',c]]),now:at+2*M}).added,1);assert.deepEqual(pass.config.filters[0].conds[0].values,def.conds[0].values);
 const rows=['live','dead'].map((label,i)=>({mint:'m'+i,phase:'after',label,acceptedAt:T,featureAnchor:'acceptedAt',decisionAt:T+2*M,features:{dex:i?'Orca':'PumpSwap'}}));
 const m={...lib.definition(def),liveFrom:0};const manual=lib.manualTest([m],rows,{ids:['venue'],phase:'after',level:'1',positiveCount:1,negativeCount:1});assert.equal(manual[0].pl,1);assert.equal(manual[0].pd,0);
 const live=(await lib.liveStats([m],rows)).get('venue');assert.equal(live.passedPositive,1);assert.equal(live.rejectedNegative,1);
});
test('category search uses later-day holdout, Wilson support and creates readable in modules',t=>{
 const rows=Array.from({length:400},(_,i)=>{const at=T+(i>=200?86400000:0)+i*1000,positive=i%2===0;return {mint:'m'+i,phase:'after',label:positive?'live':'dead',acceptedAt:at,eventAt:at-30000,featureAnchor:'acceptedAt',time:at,decisionAt:at+2*M,outcomeAt:at+60*M,features:{dex:positive?'PumpSwap':'Orca',launchpad:'pump.fun'}};});
 const report=discover(rows,{minTrainPositive:20,minTrainNegative:20});assert.equal(report.status,'rolling-holdout-ready');assert.ok(report.rules.some(r=>r.passesHoldout&&r.rule.op==='in'));assert.ok(report.categories.train.dex.every(r=>r.positiveLower95!==null));
 const a=new AutoStudies({dir:dir(t)}),result=a.report(rows,{settings:{decisionMinutes:2,targetLive:20,targetDead:20},now:T+3*86400000});assert.ok(result.rules.some(r=>r.conds.some(c=>c.op==='in')));for(const rule of result.rules)assert.doesNotThrow(()=>lib.definition(rule));
});
