"use strict";
const test=require('node:test'),a=require('node:assert/strict'),{OpeningEvidence}=require('../server/opening-evidence');
test('opening RPC and batch release even if the provider ignores abort and never finishes the body',async()=>{const api=new OpeningEvidence({timeoutMs:10,fetch:async()=>({ok:true,body:{async *[Symbol.asyncIterator](){await new Promise(()=>{});}}})});await a.rejects(api.rpc('getTransaction',[]),/deadline/);await a.rejects(api.rpcBatch([{method:'getTransaction',params:[]}]),/deadline/);});
