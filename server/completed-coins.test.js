'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CompletedCoins,researchPins,retirementDue,cancelRetiredGT}=require('./completed-coins');
const H=3600000,now=200000000,day=t=>new Date(t+5*H).toISOString().slice(0,10);
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'completed-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir}
function coin(a='mint'){return {a,t:now-27*H,mg:{st:'ok'},ds:[[1000,1,null],[1001,2,0]],raw:{1:{at:123,slot:1,b:['Привет 🌞']}}}}
test('retirement thresholds preserve active research, genuine fresh migration tasks and observation windows',()=>{
 assert.equal(retirementDue(coin(),{now}),true);assert.equal(retirementDue({...coin(),t:now-25*H},{now}),false);
 assert.equal(retirementDue({...coin(),mg:{st:'unk'},t:now-3*H},{now}),true);assert.equal(retirementDue({...coin(),mg:{st:'unk'},proofEnqueuedAt:now-H},{now}),false);
 assert.equal(retirementDue(coin(),{now,pins:new Map([['mint',now+H]])}),false);
 const source={records:new Map([['mint',{mint:'mint',acceptedAt:now-H}]])},passes={records:new Map([['mint',{mint:'mint',zeroAt:now-H,firstSeenAt:now-H}]])};
 const pins=researchPins({source,passes,one:[{config:{hours:5},processed:new Map()}],two:[{processed:new Map()}],now});assert.ok(pins.get('mint')>now);
 assert.equal(researchPins({source,one:[{processed:new Map([['mint',1]])}],now}).size,0);
 assert.equal(researchPins({source:{records:new Map([['mint',{mint:'mint',acceptedAt:now-6*H}]])},one:[{}],now}).size,0);
});
test('restart retains unconfirmed snapshots and eviction proof requires the exact confirmed snapshot',async t=>{
 const dir=fixture(t),c=coin(),d=day(c.t);let store=new CompletedCoins(dir);await store.stage([c]);assert.equal(store.isConfirmed(c),false);
 store=new CompletedCoins(dir);assert.equal(store.isConfirmed(c),false);const view=store.view(d,[]);assert.deepEqual([...view],[c]);store.confirm(d,view);assert.equal(store.isConfirmed(c),true);
 store=new CompletedCoins(dir);assert.equal(store.isConfirmed(c),true);c.ds.push([1002,3,4]);assert.equal(store.isConfirmed(c),false);await store.stage([c]);assert.equal(store.isConfirmed(c),false);store.confirm(d,store.view(d,[]));assert.equal(store.isConfirmed(c),true);
 assert.deepEqual([...store.view(d,[])],[c]);
});
test('next daily export merges cold and hot rows without truncating archived history or duplicating a mint',async t=>{
 const store=new CompletedCoins(fixture(t)),a=coin('a'),b=coin('b'),d=day(a.t);await store.stage([a,b]);const newer={...a,n:'newer',ds:[[123,5,null]]};
 const view=store.view(d,[newer]);assert.equal(view.length,2);assert.deepEqual([...view].map(x=>x.a).sort(),['a','b']);assert.deepEqual([...view].find(x=>x.a==='a'),newer);
 const snap=store.view(d,[]);await store.stage([{...b,n:'later'}]);assert.equal([...snap].find(x=>x.a==='b').n,undefined);assert.equal([...store.view(d,[])].find(x=>x.a==='b').n,'later');
});
test('an incomplete unconfirmed journal tail is removed on replay, while a completed day is sealed durably',async t=>{
 const dir=fixture(t),c=coin(),d=day(c.t);let store=new CompletedCoins(dir);await store.stage([c]);fs.appendFileSync(store.file(d),'{"partial":');store=new CompletedCoins(dir);assert.deepEqual([...store.view(d,[])],[c]);
 assert.equal(store.seal(d),false);store.confirm(d,store.view(d,[]));assert.equal(store.seal(d),true);store=new CompletedCoins(dir);assert.equal(store.sealed.has(d),true);assert.deepEqual(store.days(),[]);assert.equal(fs.existsSync(store.file(d)),false);
});
test('raw archive upload is durable across restart and removed only after upload acknowledgement',t=>{
 const dir=fixture(t),name='raw/day/mint-state.json',payload={raw:{1:{at:123,b:['base64']}}};let store=new CompletedCoins(dir);store.enqueueRaw(name,payload);store=new CompletedCoins(dir);
 assert.deepEqual(store.rawQueue(),[[name,null]]);assert.deepEqual(store.readRaw(name),payload);store.completeRaw(name);assert.deepEqual(new CompletedCoins(dir).rawQueue(),[]);
});
test('a migration/late response during upload cannot acknowledge an unexported mutable snapshot',async t=>{
 const store=new CompletedCoins(fixture(t)),c=coin(),d=day(c.t);await store.stage([c]);const frozen=store.view(d,[c]);c.ds.push([1002,3,4]);
 assert.equal([...frozen][0].ds.length,2);store.confirm(d,frozen);assert.equal(store.isConfirmed(c),false);
 await store.stage([c]);const changed={...c,n:'changed-after-stage'},shadowed=store.view(d,[changed]);assert.equal(shadowed.proof.length,0);store.confirm(d,shadowed);assert.equal(store.isConfirmed(c),false);assert.equal(store.needsConfirmation(d),true);
});
test('completed GT work is cancelled explicitly while fresh/research cohorts and discovery remain queued',()=>{
 const expired={...coin('old'),p:'oldpool'},pinned={...coin('research'),p:'researchpool'},fresh={...coin('fresh'),p:'freshpool',t:now-H};const errors=[];
 const queue=['p24a:oldpool','k10:oldpool','p5:researchpool','tr:freshpool','new'].map(key=>({key,rej:e=>errors.push(e)}));
 assert.equal(cancelRetiredGT(queue,new Map([['old',expired],['research',pinned],['fresh',fresh]]),{now,pins:new Map([['research',now+H]])}),2);
 assert.deepEqual(queue.map(x=>x.key),['p5:researchpool','tr:freshpool','new']);assert.ok(errors.every(e=>e.code==='OBSERVATION_COMPLETE'));
});


test('admitted Pump pre observations retain the full 26-hour window instead of the unadmitted two-hour window',()=>{
 const now=Date.now(),c={a:'pre',t:now-6*3600000,preCurve:1,preTradingAt:now-6*3600000,mg:{st:'curve'}};
 assert.equal(retirementDue(c,{now}),false);assert.equal(retirementDue({...c,t:now-27*3600000},{now}),true);
});


test('closed hot duplicates can retire only when every actual observation and proof is already confirmed in the archive',async t=>{
 const dir=fixture(t),store=new CompletedCoins(dir),c=coin('closed');c.p='pool';c.raw={1:{at:1000000,slot:5,b:['original'],vaultAt:1000001}};c.mg={st:'ok',sig:'proof',v:3};
 await store.stage([c]);assert.equal(store.coversHot(c),false);store.confirm(day(c.t),store.view(day(c.t),[]));
 const hot=JSON.parse(JSON.stringify(c));hot.preTradingAt=123;hot.raw[1]={at:1000000,slot:5};hot.archiveRefs={rawStates:'new/physical/location'};hot.tr={f:[],x:{}};hot.bx={miss:'no requests'};
 assert.equal(store.coversHot(hot),true);assert.deepEqual(store.readCoin(c.a).raw[1].b,['original']);
 for(const change of [x=>x.ds.push([9999,5,6]),x=>x.raw[1].at++,x=>x.mg.sig='new-proof',x=>x.mg=null,x=>x.wsMigrationSnapshot={at:2000000,slot:42,data:'new'},x=>x.bx={at:2000000,payers:1,n:1},x=>x.ct={at:2000000,mint:false},x=>x.origs=[{p:'another',t:c.t,ds:[[1,2]]}]]){
  const x=JSON.parse(JSON.stringify(hot));change(x);assert.equal(store.coversHot(x),false);
 }
});
