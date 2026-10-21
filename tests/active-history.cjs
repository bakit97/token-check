'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ActiveHistory}=require('../server/active-history'),{jsonChunks,saveRows,loadRows}=require('../server/stream-json'),{CompletedCoins}=require('../server/completed-coins'),{packRows}=require('../server/packed-observations');
const H=3600000,M=60000,T=Date.UTC(2026,9,19),now=T+3*H;
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'active-prefix-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}
function coin(a='mint'){return {a,p:'pool',t:T,n:'Монета',mg:{st:'ok'},vmint:[a,'So11111111111111111111111111111111111111112'],ds:Array.from({length:301},(_,i)=>[(T+i*M/2)/1000,0.123456789123+i/10000,100,300,i,1,50]),lq:[[T/1000,1,5,900],[(T+M)/1000,2,5,40],[(now-M)/1000,3,5,10]],raw:{10:{at:T+10*M,slot:2,b:['AQID'.repeat(2000)]}},k10:{at:T+15*M,c:[[T/1000,1,2,1,2,10]]}}}
function network(){const objects=new Map();return {objects,publish:async(name,value)=>{let text='';for await(const s of jsonChunks(value))text+=s;objects.set(name,JSON.parse(text))},read:async name=>structuredClone(objects.get(name))}}
test('active prefixes are trimmed only after verified mirror, hydrate losslessly, and survive restart/restore',async t=>{
 const d=dir(t),a=new ActiveHistory(d),c=coin(),original=structuredClone(c),coins=new Map([[c.a,c]]),net=network();c.ds=packRows(c.ds);assert.equal(await a.compact({coins,...net,now}),true);assert.ok(c.ds.length<10);assert.equal(c.raw[10].b,undefined);assert.ok(c.archiveRefs.activeHistory.length);
 let full=a.hydrate(c);assert.deepEqual(full.ds,original.ds);assert.deepEqual(full.lq,original.lq);assert.deepEqual(full.raw[10].b,original.raw[10].b);assert.deepEqual(full.k10.c,original.k10.c);assert.equal(c.lq[0][3],900,'retain the historical maximum in hot vault observations');
 const state=path.join(d,'state.json');saveRows(state,coins.values());const restored=new Map();loadRows(state,row=>restored.set(row.a,row));let b=new ActiveHistory(d);assert.deepEqual(b.hydrate(restored.get(c.a)).ds,original.ds);
 const ref=c.archiveRefs.activeHistory[0];fs.unlinkSync(b.file(ref.base));b=new ActiveHistory(d);await b.restore(restored,net.read);assert.deepEqual(b.hydrate(restored.get(c.a)).ds,original.ds);
});
test('failed mirror cannot discard data; persisted pending chunk resumes while concurrent observations survive',async t=>{
 const d=dir(t),c=coin(),original=JSON.stringify(c),coins=new Map([[c.a,c]]),net=network();let a=new ActiveHistory(d);await assert.rejects(a.compact({coins,publish:net.publish,read:async()=>({schema:1,rows:[]}),now}),/incomplete/);assert.equal(JSON.stringify(c),original);assert.equal(a.summary().pending,true);
 c.ds.push([now/1000,2,100,100,3,1,10]);const expected=structuredClone(c.ds);a=new ActiveHistory(d);await a.compact({coins,...net,now:now+M+1});assert.deepEqual(a.hydrate(c).ds,expected);assert.equal(a.summary().pending,false);
});
test('completed archive confirmation reads hydrated prefixes before retiring a hot coin',async t=>{
 const d=dir(t),a=new ActiveHistory(d),c=coin(),coins=new Map([[c.a,c]]),net=network();await a.compact({coins,...net,now});const completed=new CompletedCoins(d);await completed.stage([a.hydrate(c)]);const view=completed.view(new Date(T+5*H).toISOString().slice(0,10),[c],x=>a.hydrate(x));assert.equal(view.proof.length,1);assert.equal([...view][0].ds.length,301);completed.confirm(view.day,view);assert.equal(completed.isConfirmed(a.hydrate(c)),true);
});
test('bounded active state stays small without deleting the canonical observation history',async t=>{
 const d=dir(t),a=new ActiveHistory(d),coins=new Map(Array.from({length:300},(_,i)=>{const c=coin('mint'+i);return [c.a,c]})),before=Buffer.byteLength(JSON.stringify([...coins.values()])),net=network();await a.compact({coins,...net,now});const after=Buffer.byteLength(JSON.stringify([...coins.values()]));assert.ok(after<before*.2,{before,after});for(const c of coins.values())assert.equal(a.hydrate(c).ds.length,301);assert.ok(net.objects.size<=3,'batch immutable mirrors rather than one object per mint');
});

test('cold frozen features release hot state only after mirror and hydrate exactly',async t=>{
 const a=new ActiveHistory(dir(t)),c=coin(),frozen='abc'.repeat(5000);c.featureSnapshotsPacked=frozen;c.intelligenceSnapshots=[{at:T,features:{holders:30}}];c.earlyWallets=['wallet'];const coins=new Map([[c.a,c]]),net=network();await a.compact({coins,...net,now});assert.equal(c.featureSnapshotsPacked,undefined);assert.equal(c.intelligenceSnapshots,undefined);assert.equal(a.hydrate(c).featureSnapshotsPacked,frozen);assert.deepEqual(a.hydrate(c).earlyWallets,['wallet']);
});
