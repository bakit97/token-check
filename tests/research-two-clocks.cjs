'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {levelTwoFeaturesAt,LEVEL2_KEYS}=require('../server/research-v2');
const {ResearchTwoRuntime,configOf}=require('../server/research-two-runtime');
const {AutoStudies}=require('../server/auto-research-v2');
const {configOf:passConfig}=require('../server/pass-runtime');
const M=60000,T=Date.UTC(2026,9,19);
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'two-clock-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}
test('level 2 early metrics respect receipt cutoff and leave unsupported flow and wallets unknown',()=>{
 const coin={createdAt:T-M,createdAtObservedAt:T,ds:Array.from({length:16},(_,m)=>[(T+m*M)/1000,100+m,100,100,10,2,100]),path:{at:T+100*M,c:[[(T+6*M)/1000,999,999,999,999,10]]}};
 const f=levelTwoFeaturesAt(coin,T+7*M,{entryAt:T+2*M,acceptedAt:T,phase:'after'});
 assert.equal(f.chg5m,(107/102-1)*100);assert.equal(f.ageMin,8);assert.equal(f.drawdown,0);assert.equal(f.fromPeak,0);assert.equal(f.bigBuyShare,null);assert.equal(f.repeatBuys,null);assert.equal(f.devSold,null);assert.equal(f.sellShare1m,null);assert.equal(f.buyerAccel,null);assert.ok(LEVEL2_KEYS.every(k=>Object.hasOwn(f,k)));
});
test('second research saves feature time from detection despite later Passed and publishes full 0..300 curves',t=>{
 const at=T,zero=T+10*M,seen=T+2*M,pass={mint:'m',phase:'after',acceptedAt:at,firstSeenAt:seen,zeroAt:zero,matches:[{id:'p',version:1,level:'1',key:'buys',op:'>=',value:3}],features:{buys:3}};
 const ds=Array.from({length:312},(_,m)=>[(T+m*M)/1000,100+m,100,100,10,2,100]);
 const r=new ResearchTwoRuntime({dir:dir(t),config:{decisionMinutes:5,phases:{after:{minAbove:80,decisionMinutes:3}}}});assert.equal(r.update({passes:{records:new Map([['m',pass]])},coins:new Map([['m',{ds}]]),now:zero+301*M}).added,1);
 assert.equal(r.rows[0].decisionAt,at+3*M);assert.equal(r.rows[0].featureAnchor,'acceptedAt');assert.equal(r.rows[0].features.chg1m,(103/102-1)*100);assert.equal(r.rows[0].threshold,80);assert.deepEqual(r.rows[0].curve[0],[0,0]);assert.equal(r.rows[0].curve.at(-1)[0],300);assert.equal(r.rows[0].curve.length,61);assert.equal(r.rows[0].sourceFilterRules[0].id,'p');
});
test('second-level discovery separates parent versions and never repeats a weaker inherited bound',t=>{
 const a=new AutoStudies({dir:dir(t)}),rows=[];for(const id of ['a','b'])for(let i=0;i<160;i++){const at=T+(i<40?0:24*60*M)+i*M,positive=i%2===0;rows.push({mint:id+i,phase:'after',label:positive?'strong':'weak',acceptedAt:at,firstSeenAt:at+5*M,time:at,decisionAt:at+5*M,features:{buys:positive?150:20,chg1m:positive?20:1},sourceFilterVersions:[{id,version:1}],sourceFilterRules:[{id,version:1,key:'buys',op:'>=',value:10}]});}
 const r=a.reportParents(rows,{settings:{targetStrong:10,targetWeak:10,decisionMinutes:5},now:T+40*60*M});assert.deepEqual(Object.keys(r.cohorts).sort(),['a@1','b@1']);assert.ok(r.rules.length);for(const x of r.rules)for(const c of x.conds)if(c.key==='buys'&&c.op==='>=')assert.ok(c.value>10);
});
test('signed momentum thresholds and phase similarity times survive control validation',()=>{
 const cfg=configOf({phases:{before:{decisionMinutes:1,targetStrong:50},after:{decisionMinutes:15}}});assert.equal(cfg.phases.before.decisionMinutes,1);assert.equal(cfg.phases.after.decisionMinutes,15);
 const p=passConfig({schema:1,enabled:false,activatedAt:0,decisionMinutes:5,passMode:'12',filters:[{id:'mom',name:'Импульс',level:'2',version:1,verdictMinutes:1,conds:[{key:'chg1m',op:'>=',value:-5}]}],modules:[]});assert.equal(p.filters[0].value,-5);
});
