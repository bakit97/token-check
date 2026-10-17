'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {packRows,compactCoin,packedStats}=require('./packed-observations');
const {project,toLegacy}=require('./observation-contract');
function rows(){return Array.from({length:64},(_,i)=>[1000+i,i/7,i%3?null:0,Number.MAX_SAFE_INTEGER-i])}
test('packed historical series preserves JSON, nulls, float precision, array reads and cutoff filtering',()=>{
 const original=rows(),p=packRows(original);assert.notEqual(p,original);assert.equal(Array.isArray(p),true);assert.equal(JSON.stringify(p),JSON.stringify(original));
 assert.deepEqual([...p],original);assert.deepEqual(p.filter(x=>x[0]<1010),original.filter(x=>x[0]<1010));assert.deepEqual(p.slice(-3),original.slice(-3));assert.deepEqual(Object.keys(p),Object.keys(original));assert.deepEqual(p.at(-1),original.at(-1));assert.equal(packRows(p),p);
 const extra=[2000,1,null,2];p.push(extra);original.push(extra);p.splice(10,1);original.splice(10,1);assert.deepEqual([...p],original);
 const again=packRows(p);assert.notEqual(again,p);assert.equal(JSON.stringify(again),JSON.stringify(original));
});
test('only finished cohorts compact; restart wire and migration-contract round trips retain every receipt',()=>{
 const now=200000000,c={a:'mint',p:'pool',t:now-26*3600000,ds:rows(),lq:rows(),origs:[{p:'curve',t:1,ds:rows()}]},before=JSON.stringify(c);
 compactCoin(c,now);assert.equal(JSON.stringify(c),before);const stats=packedStats(new Map([['mint',c]]));assert.equal(stats.series,3);assert.equal(stats.rows,192);
 const restored=toLegacy(project(c));assert.deepEqual(restored.ds,JSON.parse(before).ds);assert.deepEqual(restored.origs[0].ds,JSON.parse(before).origs[0].ds);
 const early={t:now-3600000,ds:rows()},ds=early.ds;compactCoin(early,now);assert.equal(early.ds,ds);
 const weird=rows();weird[3][2]='unknown';assert.equal(packRows(weird),weird);
});
test('active five-minute cohort can append and apply the existing 520-row retention boundary after compaction',()=>{
 const original=Array.from({length:520},(_,i)=>[1000+i,i/7,null]),c={t:0,ds:original.map(r=>r.slice())},now=3*3600000;
 compactCoin(c,now);assert.equal(packedStats(new Map([['m',c]])).series,1);
 for(const series of [c.ds,original]){series.push([2000,3,null]);if(series.length>520)series.splice(130,1)}
 assert.equal(JSON.stringify(c.ds),JSON.stringify(original));compactCoin(c,now);assert.equal(packedStats(new Map([['m',c]])).series,1);
});
