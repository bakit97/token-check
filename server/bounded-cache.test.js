"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
const {BoundedCache}=require('./bounded-cache');
test('idle entries expire together and release retained estimates',()=>{let at=0;const c=new BoundedCache({now:()=>at,ttl:10});c.set('a',{x:'a'});c.set('b',{x:'b'});assert.ok(c.bytes>0);at=11;c.sweep();assert.equal(c.size,0);assert.equal(c.bytes,0);assert.equal(c.expired,2);});
test('LRU, byte limits and oversized replies cannot grow retained cache',()=>{const c=new BoundedCache({entries:2,bytes:1000,itemBytes:500});c.set('a','x');c.set('b','y');c.get('a');c.set('c','z');assert.equal(c.get('b'),undefined);c.set('large','x'.repeat(1000));assert.equal(c.get('large'),undefined);assert.equal(c.oversized,1);assert.ok(c.bytes<=1000);assert.equal(c.size,2);});
test('per-response RPC expiry is respected and cyclic objects are bounded',()=>{let at=1;const c=new BoundedCache({now:()=>at});const v={until:3};v.self=v;c.set('x',v);at=4;assert.equal(c.get('x'),undefined);assert.equal(c.bytes,0);});
