'use strict';
const test=require('node:test'),a=require('node:assert/strict'),api=require('../server/activity-slices');
const T=Date.UTC(2026,9,20),M=60000,A='A'.repeat(32),B='B'.repeat(32),mint='C'.repeat(32),SOL='So11111111111111111111111111111111111111112';
test('native SOL comes from the exact single trade side, missing SOL stays null',()=>{
 const x={block_timestamp:new Date(T).toISOString(),kind:'buy',from_token_address:SOL,to_token_address:mint,from_token_amount:'0.07',to_token_amount:'1234',volume_in_usd:'999',tx_from_address:A};
 const row=api.tradeRows([{attributes:x}],mint,T+M)[0];a.equal(row[5],.07);a.equal(row[6],T+M);a.equal(api.tradeRows([{attributes:{...x,from_token_amount:null}}],mint,T+M)[0][5],null);a.equal(api.tradeRows([{attributes:{...x,from_token_address:'foreign'}}],mint,T+M).length,0);
});
test('wallet maximum is one swap, never the sum of small swaps or number of trades',()=>{
 const trades=[[T/1000,1,1,A,1,.03],[T/1000+1,0,1,A,1,.03],[T/1000+2,1,1,B,1,.06]],e=api.evidence({start:T,end:T+10*M,trades,completeWindows:[{start:T,end:T+10*M,complete:true}]});a.equal(e.slices[0].walletMax[A],.03);a.equal(api.classify(e).label,'dead');a.equal(api.classify(e,{minTradeSol:.02}).label,'live');
});
test('threshold changes relabel the same saved raw wallet maxima without reset',()=>{
 const e=api.evidence({start:T,end:T+20*M,trades:[[T/1000,1,1,A,1,.1],[T/1000+1,0,1,B,1,.2]],completeWindows:[{start:T,end:T+20*M,complete:true}]});a.equal(api.classify(e).activeSlices,1);a.equal(api.classify(e,{minActive:50}).label,'live');a.equal(api.classify(e,{minActive:60}).label,'dead');a.equal(api.classify(e,{minActive:50,minWallets:3}).label,'dead');
});
test('verified silence is observed inactivity, positive unknown identities do not become zero',()=>{
 const minutes=Array.from({length:60},(_,i)=>[T+(i+1)*M,1,0,null]),silent=api.evidence({start:T,end:T+60*M,minutes});a.equal(api.classify(silent).label,'dead');
 const e=api.evidence({start:T,end:T+10*M,trades:[[T/1000,1,1,A,1,null]],completeWindows:[{start:T,end:T+10*M,complete:true}]});a.equal(api.classify(e).label,'unknown');a.equal(api.classify(e).why,'trade-coverage-gap');
});


test('positive raw swap overrides a contradictory zero snapshot and does not prove a silent slice',()=>{
 const minutes=Array.from({length:10},(_,i)=>[T+(i+1)*M,1,0,null]),e=api.evidence({start:T,end:T+10*M,minutes,trades:[[T/1000,1,1,A,1,.1]]});a.equal(e.slices[0].silent,false);a.equal(e.slices[0].complete,false);a.equal(api.classify(e).label,'unknown');
});


test('compressed raw evidence survives restart and receipt metadata is not inferred from USD',()=>{
 const e=api.evidence({start:T,end:T+10*M,trades:[[T/1000,1,999,A,1,.06],[T/1000+1,0,999,B,1,.07]]});a.equal(api.classify(api.unpack(api.pack(e))).label,'live');a.equal(api.classify(api.unpack(api.pack(e)),{minTradeSol:.08}).label,'unknown');
});

test('high last-hour activity and old green label cannot substitute native swaps from two wallets',()=>{
 const {classifyActivity}=require('../server/research-v2');const minutes=Array.from({length:60},(_,i)=>[T+(i+1)*M,1,1,100]);const old={label:'live',coverage:1,maxGap:0,lastHourTrades:999,lastHourWallets:999,priceKeep:100,uniqueBuyers:999,windowStart:T,windowEnd:T+60*M,minutes};a.equal(classifyActivity(old,{activityRuleVersion:3}).label,'unknown');
});

test('activity thresholds change no epoch and old label settings disappear',()=>{
 const {settings}=require('../server/research-runtime'),{ResearchEpoch}=require('../server/research-config'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'slices-epoch-'));
 try{const c=settings({lastHourTrades:123,minPriceKeep:99});a.equal(c.minTradeSol,.05);a.equal(c.minWallets,2);a.equal(c.minActive,60);a.equal(c.lastHourTrades,undefined);a.equal(c.minPriceKeep,undefined);const e=new ResearchEpoch({dir,key:'one',validate:settings,config:c});a.equal(e.apply({...c,minTradeSol:.1,minWallets:3,minActive:80}),false);a.throws(()=>settings({minTradeSol:0}));a.throws(()=>settings({minWallets:1}));}finally{fs.rmSync(dir,{recursive:true,force:true})}
});
