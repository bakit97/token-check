'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const body=fs.readFileSync(path.join(__dirname,'..','server','collector.js'),'utf8');
test('server launches authoritative source after restoring candidate collection',()=>{
 const boot=body.slice(body.indexOf('const STARTED=')),restore=boot.indexOf('load();'),source=boot.indexOf('await initSource();');
 assert.ok(restore>=0&&source>restore,'durable candidates are restored before source admission starts');
 assert.match(body,/source-accepted-v1\.jsonl|SourceRuntime/);
});
test('source migration path runs only after confirmed migration',()=>{
 const markers=body.match(/admitVerifiedMigration\(c\)/g)||[];
 assert.ok(markers.length>=3,'admission helper + both proven migration paths');
 assert.match(body,/setMg\(c,'ok',MIG_OK\[fam\]/);
 assert.match(body,/sig:r\.sig,mT:r\.t/);
});
test('candidate seen time is preserved separately from token or migration createdAt',()=>{
 assert.match(body,/firstPostSeenAt/);
 assert.match(body,/c\.wsSeen=c\.wsSeen\|\|now/);
});
test('collector exports separate source status, live and day data',()=>{
 assert.match(body,/source\/status\.json/);
 assert.match(body,/source\/live\.json/);
 assert.match(body,/source\/day\//);
 assert.match(body,/preConnected:!!PRE&&WS.preOn&&WS.preSub/);
});


test('slow discovery bootstrap does not block live processing after startup',async()=>{
 const vm=require('node:vm');let release,requested=0,added=0;const pending=new Promise(r=>release=r),ctx={gt:()=>{requested++;return pending},addFromGT:async()=>{added++},err:()=>{}};
 vm.createContext(ctx);vm.runInContext(body.slice(body.indexOf('function startDiscoveryBootstrap()'),body.indexOf('const STARTED='))+';this.start=startDiscoveryBootstrap;',ctx);
 assert.equal(ctx.start(),undefined);assert.equal(requested,1);assert.equal(added,0);
 release({});await new Promise(r=>setImmediate(r));assert.equal(added,3);
});

test('canonical collector retains the shared authenticated configuration loader',async()=>{
 const vm=require('node:vm'),requests=[],ctx={BUCKET:'test',token:async()=>'<mock>',AbortSignal,fetch:async(url,options)=>{requests.push({url,options});return {status:200,ok:true,json:async()=>({enabled:true})}}};vm.createContext(ctx);
 vm.runInContext(body.slice(body.indexOf('async function getObj('),body.indexOf('async function upload('))+';this.read=getObj;',ctx);
 assert.equal((await ctx.read('config/pass-filters.json')).enabled,true);assert.match(requests[0].url,/config%2Fpass-filters.json/);assert.ok(requests[0].options.signal);
 ctx.fetch=async()=>({status:404});assert.equal(await ctx.read('config/missing.json'),null);
 ctx.fetch=async()=>({status:503,ok:false});await assert.rejects(ctx.read('config/source-age.json'),/503/);
});
