'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),zlib=require('node:zlib');
const {jsonChunks,gzipJson,saveRows,loadRows,rowStream,readRows}=require('./stream-json');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sol-stream-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir}
test('wrapped legacy coin collections replay incrementally with escaped header text and a strict closing envelope',t=>{
 const dir=fixture(t),file=path.join(dir,'legacy.json'),coins=[{a:'m',name:'🌞'.repeat(30000),ds:[[1,2]]}];
 fs.writeFileSync(file,JSON.stringify({note:'quoted "coins": [',updated:123,coins}));assert.deepEqual([...readRows(file,null,{field:'coins'})],coins);
 fs.appendFileSync(file,'x');assert.throws(()=>[...readRows(file,null,{field:'coins'})],/Trailing/);
});
test('streamed wire JSON preserves observations, Unicode, nulls, omitted fields and receipt times',async t=>{
 const dir=fixture(t),value={at:123,missing:undefined,coins:[{name:'Монета 🌞',at:122,ds:[[121,3,null]],nan:NaN},{skip:undefined,raw:{b:['a','b']}}],x:{sig1:[1,2],sig2:null},empty:[],date:new Date(0)};
 const p=await gzipJson({dir,value});const decoded=zlib.gunzipSync(fs.readFileSync(p.file)).toString('utf8');assert.equal(decoded,JSON.stringify(value));assert.equal(fs.statSync(p.file).size,p.bytes);await p.dispose();assert.equal(fs.readdirSync(path.join(dir,'publish-tmp')).length,0);
});
test('large row collection is emitted in bounded chunks, and failed encoding leaves no publish temp',async t=>{
 const dir=fixture(t),row={at:12,ds:Array.from({length:300},(_,i)=>[i,1,2,3])},value={coins:Array(2000).fill(row)};let max=0,bytes=0;
 for await(const chunk of jsonChunks(value)){max=Math.max(max,Buffer.byteLength(chunk));bytes+=Buffer.byteLength(chunk)}
 assert.ok(max<65536);assert.ok(bytes>6000000);
 const bad={rows:[{bad:1n}]};await assert.rejects(gzipJson({dir,value:bad}),/BigInt/);assert.equal(fs.readdirSync(path.join(dir,'publish-tmp')).length,0);
});
test('row-wise atomic state preserves the previous snapshot if a row cannot be serialized',t=>{
 const dir=fixture(t),file=path.join(dir,'state.json'),rows=[{a:'one',at:1,ds:[[1,2]]},{a:'two',at:2}];saveRows(file,rows.values());assert.deepEqual(JSON.parse(fs.readFileSync(file)),rows);
 assert.throws(()=>saveRows(file,[{a:'bad',n:1n}]),/BigInt/);assert.deepEqual(JSON.parse(fs.readFileSync(file)),rows);
});

test('incremental state replay handles nested arrays, UTF-8 and escaped delimiters across read boundaries',t=>{
 const dir=fixture(t),file=path.join(dir,'state.json'),rows=[{a:'one',text:'🌞'.repeat(40000),ds:[[1,2],[3,4]],quoted:'"}\\]'}, {a:'two',raw:{b:['привет']}}];
 saveRows(file,rows);const read=[];assert.equal(loadRows(file,x=>read.push(x)),2);assert.deepEqual(read,rows);
 fs.writeFileSync(file,'[{"a":"bad"},]');assert.throws(()=>loadRows(file,()=>{}),/Invalid state row/);
 fs.writeFileSync(file,'[{"a":"bad"}');assert.throws(()=>loadRows(file,()=>{}),/Incomplete/);
});

test('lazy observation rows are produced as a JSON array without materializing the whole projection',async t=>{
 const dir=fixture(t);let generated=0;const p=await gzipJson({dir,value:{coins:rowStream(function*(){for(let i=0;i<1000;i++){generated++;yield {a:i,at:123}}})}});assert.equal(generated,1000);const value=JSON.parse(zlib.gunzipSync(fs.readFileSync(p.file)));assert.equal(value.coins.length,1000);assert.deepEqual(value.coins[999],{a:999,at:123});await p.dispose();
});

test('yielding checkpoint keeps the previous complete file until atomic replacement and permits event-loop work',async t=>{const dir=fixture(t),file=path.join(dir,'state.json'),old=[{a:'previous'}],rows=Array.from({length:100},(_,i)=>({a:String(i),data:'x'.repeat(1024)}));saveRows(file,old);let ran=false;const pending=require('./stream-json').saveRowsAsync(file,rows);await new Promise(r=>setImmediate(()=>{ran=true;assert.deepEqual(JSON.parse(fs.readFileSync(file)),old);r();}));assert.equal(await pending,100);assert.equal(ran,true);assert.deepEqual(JSON.parse(fs.readFileSync(file)),rows);await assert.rejects(require('./stream-json').saveRowsAsync(file,[{a:'broken',n:1n}]),/BigInt/);assert.deepEqual(JSON.parse(fs.readFileSync(file)),rows);assert.equal(fs.readdirSync(dir).filter(x=>x.includes('.async-')).length,0);});

test('observation publication cannot monopolize an entire census before pending event-loop work runs',async t=>{const dir=fixture(t);let produced=0,seen=null;const value={coins:rowStream(function*(){for(let i=0;i<100;i++){produced++;if(produced===1)setImmediate(()=>seen=produced);yield {a:String(i),at:i};}})};const out=await gzipJson({dir,value});assert.ok(seen!==null&&seen<=16,'WS/timers must run before a long batch of coin projections');assert.equal(JSON.parse(zlib.gunzipSync(fs.readFileSync(out.file))).coins.length,100);await out.dispose();});
