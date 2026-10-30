'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const {catalogue}=require('../server/side-pools');
test('manual-pool catalogue times out if fetch ignores AbortSignal and never produces headers',async()=>{await a.rejects(catalogue({mint:'mint'},{timeoutMs:10,fetch:()=>new Promise(()=>{})}),/pool-public-deadline/);});
test('manual proof and audit cannot hang forever on a body that ignores fetch cancellation',async()=>{await a.rejects(catalogue({mint:'mint'},{timeoutMs:10,fetch:async()=>({ok:true,body:{async *[Symbol.asyncIterator](){await new Promise(()=>{});yield Buffer.from('[]')}}})}),/pool-public-deadline/);});
test('a successful bounded catalogue still identifies only earlier pools for the same mint',async()=>{const rows=[{chainId:'solana',pairAddress:'old',pairCreatedAt:1,baseToken:{address:'mint'}}],result=await catalogue({mint:'mint',pool:'new',eventAt:2},{timeoutMs:1000,fetch:async()=>({ok:true,body:{async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(rows))}}})});a.equal(result.pairAddress,'old');});
