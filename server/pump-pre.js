'use strict';
const crypto=require('node:crypto');
// SOL·СКАН: open-public-trading event on Pump.fun, not an arbitrary SPL mint creation.
// Source: Pump public protocol docs, create/create_v2 transaction initializes
// its bonding-curve PDA with reserves. Public swaps are possible immediately.
const PUMP='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const sig8=name=>crypto.createHash('sha256').update('global:'+name).digest().subarray(0,8);
const DISCRIMINATORS=[sig8('create'),sig8('create_v2')];
const mintPattern=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function keysOf(tx){
  const msg=tx?.transaction?.message;
  if(!msg||!Array.isArray(msg.accountKeys))return [];
  return [...msg.accountKeys.map(k=>typeof k==='string'?k:k.pubkey),
    ...(tx.meta?.loadedAddresses?.writable||[]),
    ...(tx.meta?.loadedAddresses?.readonly||[])];
}
function pubkey(ix,index,keys){
  const x=ix.accounts?.[index];
  return Number.isInteger(x)?keys[x]:typeof x==='string'?x:null;
}
function tokenMetadata(data){
  // Name and symbol in Anchor create/create_v2 Borsh. Parse defensively.
  let i=8;
  function str(max){
    if(i+4>data.length)throw Error('string length');
    const length=data.readUInt32LE(i);i+=4;
    if(length>max||i+length>data.length)throw Error('bad string');
    const result=data.subarray(i,i+length).toString('utf8');i+=length;
    return result;
  }
  try{return {name:str(64).slice(0,40),symbol:str(32).slice(0,16)}}
  catch{return {name:'',symbol:''}}
}
/**
 * Decode trustworthy launch from successful confirmed transaction.
 * Uses PDA proof and fixed account positions shared by create and create_v2.
 */
async function parsePumpLaunch(tx, {decode58,deriveCurve,signature,observedAt}){
  if(!tx||tx.meta?.err||!tx.transaction?.message||!Number.isInteger(tx.blockTime)||tx.blockTime<=0)return null;
  if(typeof decode58!=='function'||typeof deriveCurve!=='function')throw TypeError('Missing crypto primitives');
  const keys=keysOf(tx);
  if(!keys.includes(PUMP))return null;
  const instructions=[...(tx.transaction.message.instructions||[])];
  for(const i of tx.meta?.innerInstructions||[])instructions.push(...(i.instructions||[]));
  for(const ix of instructions){
    const program=typeof ix.programId==='string'?ix.programId:keys[ix.programIdIndex];
    if(program!==PUMP||!ix.data||!Array.isArray(ix.accounts)||ix.accounts.length<3)continue;
    let data;
    try{data=Buffer.from(decode58(ix.data))}catch{continue}
    if(data.length<12||!DISCRIMINATORS.some(x=>data.subarray(0,8).equals(x)))continue;
    const mint=pubkey(ix,0,keys),curve=pubkey(ix,2,keys);
    if(!mintPattern.test(mint||'')||!mintPattern.test(curve||''))continue;
    if(await deriveCurve(mint)!==curve)continue;
    const blockAt=tx.blockTime*1000;
    if(!Number.isSafeInteger(observedAt)||observedAt<blockAt)return null;
    const metadata=tokenMetadata(data);
    // create_v2 supports custom quote mints in optional remaining accounts.
    const quote=pubkey(ix,16,keys)||'So11111111111111111111111111111111111111112';
    return {mint,curve,quote,blockAt,observedAt,signature,slot:tx.slot||null,...metadata};
  }
  return null;
}
function isTradeableCurve(acc){
  if(!acc||acc.owner!==PUMP||!Array.isArray(acc.data)||!acc.data[0])return false;
  let bytes;
  try{bytes=Buffer.from(acc.data[0],'base64')}catch{return false}
  // 8 discriminator + 5 u64 + 1 complete, new version 82+ bytes.
  if(bytes.length<49||bytes[48]!==0)return false;
  try{
    return bytes.readBigUInt64LE(8)>0n&&bytes.readBigUInt64LE(16)>0n&&
      bytes.readBigUInt64LE(24)>0n&&bytes.readBigUInt64LE(40)>0n;
  }catch{return false}
}
function isPumpCreateLog(value){
  return !value?.err&&typeof value.signature==='string'&&Array.isArray(value.logs)&&
    value.logs.some(log=>/^Program log: Instruction: Create(?:V2)?\s*$/.test(log));
}
module.exports={PUMP,parsePumpLaunch,isTradeableCurve,isPumpCreateLog};
