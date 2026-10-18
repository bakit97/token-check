'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventClock}=require('./event-clock');
test('slot anchor is cached for 10 seconds, rejects stale reference and never treats estimates as proof',async()=>{
 let now=100000,calls=0;const c=new EventClock({now:()=>now,rpc:async()=>{calls++;return 1000}});
 await c.refresh();await c.refresh();assert.equal(calls,1);
 assert.equal(c.estimate(600).ageMs,160000);
 now+=10000;await c.refresh();assert.equal(calls,2);
 c.observe(1001);assert.equal(c.summary().anchor.source,'ws');
 now+=31000;assert.equal(c.estimate(1000),null);
 assert.equal(c.estimate(null),null);
});
