'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const body=fs.readFileSync(path.join(__dirname,'..','server','collector.js'),'utf8');
test('server launches authoritative source after restoring candidate collection',()=>{
 assert.match(body,/load\(\);(?:HEALTH\.capture\('load:complete'\);)?log\('старт, версия',VERSION\);\s*try\{await initSource\(\);await reloadSourceAgeConfig\(\)\}/);
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
