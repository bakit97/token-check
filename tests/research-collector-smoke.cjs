'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'..','server','collector.js'),'utf8');
test('continuous research starts independently of main source and preserves its errors',()=>{
 assert.match(src,/try\{await initSource\(\)\}catch/);
 assert.match(src,/try\{await initResearchV2\(\)\}catch/);
 assert.match(src,/RESEARCH_V2_ERR/);
});
test('research labels are computed only from accepted source ledger',()=>{
 assert.match(src,/RESEARCH_V2\.update\(\{source:SOURCE,coins:C,now\}\)/);
});
test('server exports research status and research bank, never invents a strong/weak result',()=>{
 assert.match(src,/research-v2\/status\.json/);
 assert.match(src,/research-v2\/polygon-1\.json/);
 assert.doesNotMatch(src,/upload\('research-v2\/polygon-2/);
});
