'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {project,toLegacy}=require('./observation-contract'),{hydrateArchives,validateArchive}=require('./observation-archives');
function fixture(){const c={a:'mint',p:'pool',t:1000000,rawUp:1,raw:{1:{at:1060000,slot:3}},trDone:1,tr:{f:[[1600000,1,1001,1001]]}};
 const row=project(c),raw={a:c.a,p:c.p,t:c.t,raw:{1:{at:1060000,slot:3,b:['YWJj'],vaultAt:1060010,vaultSlot:4}}},trades={a:c.a,p:c.p,t:c.t,f:c.tr.f,x:{sig:[1001,1,2,'wallet',3]}};
 return {row,raw,trades,pool:row.observations.pools[0]};}
test('verified archives hydrate bytes and trade receipts without mutating the mirror or leaking into an early decision',async()=>{
 const f=fixture(),snapshot=JSON.stringify(f.row),r=await hydrateArchives(f.row,async name=>name.endsWith('-state.json')?f.raw:f.trades);
 assert.equal(r.okay,true);assert.equal(JSON.stringify(f.row),snapshot);const all=toLegacy(r.row),early=toLegacy(r.row,1200000);
 assert.deepEqual(all.raw[1].b,['YWJj']);assert.equal(all.raw[1].vaultAt,1060010);assert.equal(Object.keys(all.tr.x).length,1);
 assert.deepEqual(early.tr.x,{});assert.equal(all.tr.f[0][0],1600000);assert.equal(all.tr.x.sig[0],1001);
 assert.deepEqual(toLegacy(r.row,1050000).raw,{});
});
test('same mint and day do not authorize another pool, curve or market generation',()=>{
 const f=fixture(),name=f.pool.archives.rawStates;
 for(const change of [{a:'other'},{p:'previous-pool'},{t:999999}])assert.equal(validateArchive(f.row,f.pool,'rawStates',name,{...f.raw,...change}).status,'identity-mismatch');
 assert.equal(validateArchive(f.row,f.pool,'rawStates','raw/../mint-state.json',f.raw).status,'identity-mismatch');
});
test('conflicting receipts, slots or bytes are rejected instead of overwriting evidence',async()=>{
 const f=fixture();f.row.observations.pools[0].rawStates[1].at++;
 const r=await hydrateArchives(f.row,async()=>f.raw);assert.equal(r.okay,false);assert.equal(r.checks[0].status,'observation-conflict');assert.equal(r.row.observations.pools[0].rawStates[1].b,undefined);
});
test('missing archives and market-only trade timestamps remain unavailable, not fabricated',async()=>{
 const f=fixture(),r=await hydrateArchives(f.row,async()=>null);assert.equal(r.okay,false);assert.equal(r.checks[0].status,'missing');
 assert.equal(validateArchive(f.row,f.pool,'trades',f.pool.archives.trades,{...f.trades,f:[]}).status,'observation-conflict');
 assert.equal(validateArchive(f.row,f.pool,'trades',f.pool.archives.trades,{...f.trades,f:[[null,1,1001,1001]]}).status,'missing-receipt');
});
