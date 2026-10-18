'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {seedDay}=require('./seed-completed'),{CompletedCoins}=require('./completed-coins'),{project}=require('./observation-contract'),{packRows}=require('./packed-observations');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'seed-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir}
const at=100000000,day=new Date(at+5*3600000).toISOString().slice(0,10);
test('missing historical coins import full legacy observations/raw archives without old research labels',async t=>{
 const dir=fixture(t),store=new CompletedCoins(dir),d=path.join(dir,'day.json'),o=path.join(dir,'obs.json');
 fs.writeFileSync(d,JSON.stringify({day,coins:[{a:'m',p:'pool',t:at,mst:'ok',mk:'dbc',mT:at,mSig:'proof',ds:[[1,2]],raw:{1:{at:123,slot:1}},bx:{at:456},oldResearchResults:{bad:1},label:'live'}]}));
 fs.writeFileSync(o,JSON.stringify({coins:[{a:'m',t:at,ds:[[1,2],[2,3]],lq:[[2,1,2,3]]}]}));
 const stats=await seedDay({store,day,hot:new Map(),download:async p=>p==='day'?d:o,archive:async name=>name.endsWith('-state.json')?{a:'m',p:'pool',t:at,vaults:['a','b'],raw:{1:{at:123,slot:1,b:['original']}}}:{a:'m',p:'pool',t:at,f:[[456,1,1,1]],x:{sig:[1,1,2,'owner',3]}}});
 const c=store.readCoin('m'),row=project(c);assert.deepEqual(c.ds,[[1,2],[2,3]]);assert.equal(c.completedLegacyObserved,1);assert.deepEqual(c.raw[1].b,['original']);assert.equal(c.tr.f[0][0],456);
 assert.equal(c.oldResearchResults,undefined);assert.equal(c.label,undefined);assert.equal(stats.rawLoaded,1);assert.equal(stats.tradesLoaded,1);assert.equal(row.observations.pools[0].tradeFetches[0].at,456);
 assert.equal(new CompletedCoins(dir).seeded.has(day),true);
});
test('hot records retain richer legacy series, while unchanged packed rows stay packed',async t=>{
 const dir=fixture(t),store=new CompletedCoins(dir),d=path.join(dir,'day.json'),o=path.join(dir,'obs.json'),ds=packRows(Array.from({length:20},(_,i)=>[i,1,null])),c={a:'hot',p:'pool',t:at,ds,mg:{st:'unk'}};
 fs.writeFileSync(d,JSON.stringify({coins:[{a:'hot',p:'pool',t:at,mst:'ok',ds:[[0,1,null]],label:'live'}]}));fs.writeFileSync(o,JSON.stringify({coins:[{a:'hot',t:at,ds:[[0,1,null],[20,2,null]],lq:[[20,1,2,3]]}]}));
 await seedDay({store,day,hot:new Map([['hot',c]]),download:async p=>p==='day'?d:o,archive:async()=>{throw Error('hot rows must not read archives')}});
 assert.equal(c.ds.length,21);assert.equal(c.mg.st,'unk');assert.equal(c.label,undefined);assert.equal(c.completedLegacyObserved,1);assert.equal(store.index.size,0);
});
test('an interrupted seed never permits publishing a partial day as complete',async t=>{
 const dir=fixture(t),store=new CompletedCoins(dir),d=path.join(dir,'day.json');fs.writeFileSync(d,'{"coins":[{"a":"m","t":100000000},');
 await assert.rejects(seedDay({store,day,hot:new Map(),download:async p=>p==='day'?d:null,archive:async()=>null}),/Incomplete/);assert.equal(store.seeded.has(day),false);assert.equal(store.index.size,0);
});
