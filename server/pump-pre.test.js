'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {PUMP,parsePumpLaunch,isTradeableCurve,isPumpCreateLog}=require('./pump-pre');
const M='So11111111111111111111111111111111111111112';
const C='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OTHER='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encode58(bytes) {
 let n=0n;for(const b of bytes)n=n*256n+BigInt(b);let s='';
 while(n){s=B58[Number(n%58n)]+s;n/=58n}
 for(const b of bytes){if(b===0)s='1'+s;else break}
 return s;
}
function decode58(s){
 let n=0n;for(const c of s)n=n*58n+BigInt(B58.indexOf(c));
 const bytes=[];while(n){bytes.push(Number(n&255n));n>>=8n}
 for(const c of s){if(c==='1')bytes.push(0);else break}
 return Uint8Array.from(bytes.reverse());
}
function sample({version=2,error=null,curve=C,mint=M,program=PUMP,origin=10}={}){
 const name=Buffer.from('Launch TOKEN','utf8'),symbol=Buffer.from('LT');
 const discriminator=crypto.createHash('sha256').update('global:'+(version===2?'create_v2':'create')).digest().subarray(0,8);
 const meta=Buffer.concat([discriminator,Buffer.from([name.length,0,0,0]),name,Buffer.from([symbol.length,0,0,0]),symbol]);
 return {blockTime:origin,slot:111,meta:{err:error,innerInstructions:[]},transaction:{message:{
   accountKeys:[program,mint,OTHER,curve],
   instructions:[{programIdIndex:0,accounts:[1,2,3],data:encode58(meta)}]
 }}};
}
function reserves({complete=false,valid=true}={}) {
 const b=Buffer.alloc(82);
 for(const off of [8,16,24,40])b.writeBigUInt64LE(1000000n,off);
 b[48]=complete?1:0;
 if(!valid)b.writeBigUInt64LE(0n,40);
 return {owner:PUMP,data:[b.toString('base64'),'base64']};
}
test('create_v2: mint+curve PDA, signature and launch time verified',async()=>{
 const r=await parsePumpLaunch(sample(),{decode58,deriveCurve:async mint=>(assert.equal(mint,M),C),signature:'signatureX',observedAt:14000});
 assert.equal(r.mint,M);assert.equal(r.curve,C);assert.equal(r.blockAt,10000);assert.equal(r.observedAt,14000);
 assert.equal(r.name,'Launch TOKEN');assert.equal(r.symbol,'LT');
});
test('legacy create has identical account PDA positions',async()=>{
 const r=await parsePumpLaunch(sample({version:1}),{decode58,deriveCurve:async()=>C,signature:'legacy',observedAt:11000});
 assert.ok(r);
});
test('invalid curve PDA, program and failed transaction rejected',async()=>{
 const args={decode58,deriveCurve:async()=>OTHER,signature:'s',observedAt:10000};
 assert.equal(await parsePumpLaunch(sample(),args),null);
 assert.equal(await parsePumpLaunch(sample({error:{InstructionError:[0,'Error']}}),{...args,deriveCurve:async()=>C}),null);
 assert.equal(await parsePumpLaunch(sample({program:OTHER}),{...args,deriveCurve:async()=>C}),null);
});
test('delayed/invalid observed clock cannot be changed to block creation time',async()=>{
 const tx=sample();
 assert.equal(await parsePumpLaunch(tx,{decode58,deriveCurve:async()=>C,observedAt:9000}),null);
});
test('the bonding curve must be open, program owned, with reserves',()=>{
 assert.equal(isTradeableCurve(reserves()),true);
 assert.equal(isTradeableCurve(reserves({complete:true})),false);
 assert.equal(isTradeableCurve(reserves({valid:false})),false);
 assert.equal(isTradeableCurve({...reserves(),owner:OTHER}),false);
 assert.equal(isTradeableCurve({owner:PUMP,data:[Buffer.alloc(30).toString('base64'),'base64']}),false);
});
test('only successful Pump Create/CreateV2 log signals are processed',()=>{
 assert.equal(isPumpCreateLog({signature:'sig',logs:['Program log: Instruction: CreateV2']}),true);
 assert.equal(isPumpCreateLog({signature:'sig',logs:['Program log: Instruction: Buy']}),false);
 assert.equal(isPumpCreateLog({signature:'sig',err:{message:'failed'},logs:['Program log: Instruction: Create']}),false);
});
