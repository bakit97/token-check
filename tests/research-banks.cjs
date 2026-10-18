'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ResearchBanks,storageConfig}=require('../server/research-banks');
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'banks-eight-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}
function settings(){return {schema:1,before:{live:50,dead:50,strong:50,weak:50},after:{live:50,dead:50,strong:50,weak:50}}}
const opts={config:settings(),one:{targetLive:50,targetDead:50},two:{targetStrong:50,targetWeak:50}};
test('eight banks rotate independently, preserve labeled features/curve, and restart without resurrecting old rows',t=>{
 const d=dir(t),b=new ResearchBanks({dir:d,...opts}),rows=[];for(const phase of ['before','after'])for(const label of ['live','dead','strong','weak'])for(let i=0;i<65;i++)rows.push({mint:phase+label+i,phase,label,acceptedAt:1000+i,features:{buys:i},curve:[[0,null],[5,1.23456789123]],time:1000+i});
 assert.equal(b.upsert(rows),520);for(const phase of ['before','after'])for(const label of ['live','dead','strong','weak'])assert.equal(b.summary().counts[phase][label],50);
 const r=b.select({level:'1',phase:'before',label:'live',curves:true});assert.equal(r.length,50);assert.equal(r[0].mint,'beforelive15');assert.deepEqual(r[0].curve,rows[0].curve);assert.equal(r[0].features.buys,15);
 const restarted=new ResearchBanks({dir:d,...opts});assert.equal(restarted.select().length,400);assert.equal(restarted.upsert(rows),0);assert.ok(restarted.select().every(x=>!Object.hasOwn(x,'curvePacked')));
});
test('storage goals are clamped separately above study requirements and reject invalid ranges',()=>{
 const c=storageConfig(settings(),{phases:{before:{targetLive:400},after:{targetDead:300}}},{phases:{before:{targetStrong:150},after:{targetWeak:200}}});assert.equal(c.before.live,400);assert.equal(c.after.live,100);assert.equal(c.after.dead,300);assert.equal(c.before.strong,150);assert.equal(c.after.weak,200);
 assert.throws(()=>storageConfig({...settings(),before:{live:49}}));assert.throws(()=>storageConfig({...settings(),after:{weak:5001}}));
});
test('malformed storage is rejected, while unknown observations never enter labeled banks',t=>{
 const d=dir(t),b=new ResearchBanks({dir:d,...opts});assert.equal(b.upsert([{mint:'x',phase:'before',acceptedAt:1,label:'pending',features:{buys:null}}]),0);fs.writeFileSync(b.file('before-live'),'[{"label":"dead"}]');assert.throws(()=>new ResearchBanks({dir:d,...opts}),/Corrupt/);
});
