'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'..','server','collector.js'),'utf8');
test('source, first research and verified Passed path start independently and preserve errors',()=>{
  assert.match(src,/try\{await initSource\(\);await reloadSourceAgeConfig\(\)\}catch/);
  assert.match(src,/try\{await initResearchV2\(\)\}catch/);
  assert.match(src,/try\{await initPathsV2\(\)\}catch/);
  assert.match(src,/RESEARCH_V2_ERR/);
  assert.match(src,/PASS_ERR/);
});
test('research labels are computed only from the admitted source ledger',()=>{
  assert.match(src,/(?:RESEARCH_V2|runtime)\.update\(\{source:SOURCE,coins:researchCoins\(\),passes:PASS_V2,now\}\)/);
});
test('server second-level research is computed only from durable Passed stream',()=>{
  assert.match(src,/RESEARCH_TWO\.update\(\{passes:PASS_V2,source:SOURCE,coins:researchCoins\(\),now\}\)/);
  assert.match(src,/PASS_V2\.update\(\{source:SOURCE,coins:researchCoins\(\),now\}\)/);
  assert.match(src,/research-v2\/status-two\.json/);
  assert.match(src,/research-v2\/polygon-2\.json/);
  assert.match(src,/passed-v2\/day\//);
});
test('server exports separate polygon cohorts with epoch boundaries',()=>{
  assert.match(src,/research-v2\/status\.json/);
  assert.match(src,/research-v2\/polygon-1\.json/);
  assert.match(src,/epochStart:result\.cohortStart/);
  assert.match(src,/research-v2\/epochs\.json/);
});
