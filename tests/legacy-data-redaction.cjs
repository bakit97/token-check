const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const api=require('../server/legacy-data-redaction'),{CompletedCoins}=require('../server/completed-coins'),{ActiveHistory}=require('../server/active-history');
const M='A'.repeat(32),index=api.indexOf([{coins:[{mint:M,phase:'before',eventAt:100,acceptedAt:110,proof:{curve:'curve'}},{mint:M,phase:'after',eventAt:200,acceptedAt:210,proof:{pool:'dex'}}]}],1000);
test('legacy deletion is scoped to pool and event, preserving the same mint after migration and new manual proof',()=>{
 a.equal(api.transform('source/day/old.json',{coins:[{mint:M,phase:'before',acceptedAt:110},{mint:M,phase:'after',acceptedAt:210},{mint:M,phase:'before',acceptedAt:120,proof:{kind:'manual-pool-open-v1'}}]},index).value.coins.length,2);
 const x=api.transform('archive/legacy/day/old.json',{count:2,coins:[{a:M,p:'curve',d:'pump-fun',t:100},{a:M,p:'dex',d:'pumpswap',t:200,origs:[{p:'curve',d:'pump-fun',t:100}]}]},index);
 a.equal(x.value.count,1);a.equal(x.value.coins[0].p,'dex');a.deepEqual(x.value.coins[0].origs,[]);
 a.equal(api.transform('archive/legacy/obs/old.json',{coins:[{a:M,t:100},{a:M,t:200}]},index).value.coins.length,1);
 a.equal(api.transform('observations-v2/raw/day/mint/curve-state.json',{a:M,p:'curve'},index).value,null);
 a.equal(api.transform('observations-v2/raw/day/mint/dex-state.json',{a:M,p:'dex'},index).value.p,'dex');
});
test('offset-preserving history redaction restores unchanged after rows and their checksums',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'history-redact-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const crypto=require('node:crypto'),row=(p)=>{const fields={ds:[[1,1.5],[2,4]],raw:{x:{b:'z'.repeat(200)}}};return {a:M,p,t:100,fields,hash:crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex')};},old=row('curve'),after=row('dex'),offset=Buffer.byteLength(JSON.stringify(old)+'\n'),bytes=JSON.stringify(after)+'\n';
 const doc=api.transform('observations-v2/active-history/day/base.json',{schema:1,base:'1000-1-abcdef123456',rows:[old,after]},index).value;
 a.equal(Buffer.byteLength(JSON.stringify(doc.rows[0])+'\n'),offset);a.equal(JSON.stringify(doc.rows[1])+'\n',bytes);a.equal(doc.rows[0].fields.raw,undefined);
 const ref={base:doc.base,remote:'test',hash:after.hash,offset,length:Buffer.byteLength(bytes)},coin={a:M,p:'dex',t:100,archiveRefs:{activeHistory:[ref]}},history=new ActiveHistory(dir);await history.restore(new Map([[M,coin]]),async()=>doc);a.equal(history.hydrate(coin).ds.length,2);
});
test('completed archive purge survives restart and keeps after identity and confirmation',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'completed-redact-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new CompletedCoins(dir),day='1970-01-01';
 await store.stage([{a:'birth',p:'curve',d:'pump-fun',t:100},{a:M,p:'dex',d:'pumpswap',mg:{st:'ok'},t:200,ds:[[1,2]],origs:[{p:'curve',d:'pump-fun',t:100}]}]);
 store.confirm(day,store.view(day,[]));const result=await store.eraseLegacyBirths(1000);a.equal(result.removed,1);a.equal(result.redacted,1);const restarted=new CompletedCoins(dir);a.equal(restarted.metadata('birth'),null);a.equal(restarted.readCoin(M).p,'dex');a.equal(restarted.readCoin(M).ds[0][1],2);a.deepEqual(restarted.readCoin(M).origs,[]);a.equal(restarted.needsConfirmation(day),true);
});

test('public source/day aliases build the same pool identity index and preserve manual records',()=>{
 const doc={coins:[{a:M,phase:'before',curve:'curve',acceptedAt:110,eventAt:100,proofKind:'pump-create-v1'},{a:M,phase:'after',migrationPool:'dex',acceptedAt:210,eventAt:200},{a:'manual',phase:'before',p:'manual-pool',acceptedAt:120,eventAt:100,proofKind:'manual-pool-open-v1'}]},idx=api.indexOf([doc],1000);
 a.deepEqual(idx.before,[M+'|curve']);a.ok(idx.after.includes(M+'|dex'));a.equal(api.transform('source/day/old.json',doc,idx).value.coins.length,2);
});


test('a historical remote cleanup receipt cannot clear pending for a different pool epoch or incomplete local erasure',()=>{
 const {cleanupReceipt,REMOTE_CLEANUP_RECEIPT:r}=require('../server/legacy-data-redaction');
 a.equal(cleanupReceipt({startedAt:r.cutoff},{complete:false}),null);
 a.equal(cleanupReceipt({startedAt:r.cutoff+1},{complete:true}),null);
 a.equal(cleanupReceipt({startedAt:r.cutoff},{complete:true}).scanComplete,true);
});
