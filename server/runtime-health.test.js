'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {RuntimeHealth,structureCounts}=require('./runtime-health');
test('peak telemetry retains a serialization spike after memory falls and resets only the minute window',()=>{
 let rss=100000000,clock=0;const health=new RuntimeHealth({now:()=>clock,memory:()=>({rss,heapUsed:rss/2,heapTotal:rss*.7,external:100,arrayBuffers:50})});
 rss=620000000;clock=1000;health.capture('upload:json',{name:'obs/day.json',jsonChars:50000000});rss=310000000;
 const first=health.summary({C:{size:12000}});assert.equal(first.rssMB,310);assert.equal(first.rssPeakMinuteMB,620);assert.equal(first.phases['upload:json'].jsonChars,50000000);
 rss=320000000;const second=health.summary({});assert.equal(second.rssPeakMinuteMB,320);assert.equal(second.rssPeakMB,620);
});
test('collection diagnostics count stored observations without serializing or mutating them',()=>{
 const c={t:0,ds:[[],[]],lq:[[]],tr:{x:{a:[],b:[]}},raw:{1:{b:['aaaa',null]}},origs:[{}]};
 const out=structureCounts({C:new Map([['mint',c]]),wsSeen:new Map([['curve',1]]),RPC_CACHE:new Map(),gtQ:[1],UPQ:[],SOURCE:{records:new Map([['mint',{}]]),gate:{accepted:new Map([['mint',{}]])}},RESEARCH_V2:{rows:[{}],processed:new Map([['mint',{}]])},now:190000000});
 assert.equal(out.C.size,1);assert.equal(out.C.ageOver50h,1);assert.equal(out.C.dsRows,2);assert.equal(out.C.tradeRows,2);assert.equal(out.C.rawBase64Chars,4);assert.equal(out.banks.one.rows,1);assert.equal(out.journals.sourceGateAccepted,1);assert.equal(c.raw[1].b[0],'aaaa');
});
