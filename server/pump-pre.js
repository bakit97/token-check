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
function encodeKey(bytes){
 const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=BigInt('0x'+bytes.toString('hex')),s='';
 while(n){s=alphabet[Number(n%58n)]+s;n/=58n}for(const b of bytes){if(b!==0)break;s='1'+s}return s;
}
function createEvent(bytes,slot,observedAt){
 if(!bytes.subarray(0,8).equals(Buffer.from([27,114,169,77,222,235,99,118])))return null;
 let offset=8;const strings=[];
 for(let i=0;i<3;i++){if(offset+4>bytes.length)return null;const n=bytes.readUInt32LE(offset);offset+=4;
  if(n>4096||offset+n>bytes.length)return null;strings.push(bytes.subarray(offset,offset+n).toString('utf8'));offset+=n}
 if(offset+96>bytes.length)return null;
 const mint=encodeKey(bytes.subarray(offset,offset+32)),curve=encodeKey(bytes.subarray(offset+32,offset+64));
 let blockAt=null;
 // Modern CreateEvent has creator before timestamp; original layout ended
 // immediately after user/timestamp. Never interpret the creator as a time.
 const remaining=bytes.length-offset,timeOffset=remaining>=136?offset+128:remaining===104?offset+96:null;
 if(timeOffset!==null){const seconds=Number(bytes.readBigInt64LE(timeOffset));
  if(Number.isSafeInteger(seconds)&&seconds>=1577836800&&seconds*1000<=observedAt+30000)blockAt=seconds*1000;
  else return null;
 }
 let quote='So11111111111111111111111111111111111111112';
 if(remaining>=234&&bytes.subarray(offset+202,offset+234).some(b=>b!==0))quote=encodeKey(bytes.subarray(offset+202,offset+234));
 return {mint,curve,quote,slot,blockAt,observedAt,name:strings[0].slice(0,40),symbol:strings[1].slice(0,16),uri:/^(https:\/\/|ipfs:\/\/)[^\s"'<>]{4,290}$/.test(strings[2]||'')?strings[2]:null};
}
function parsePumpCreateEvents(value,{slot,observedAt}={}){
 if(value?.err!==null||!isPumpCreateLog(value)||!Number.isSafeInteger(slot)||slot<=0||!Number.isSafeInteger(observedAt))return [];
 const stack=[],events=[];
 for(const line of value.logs){
  const invoke=/^Program (\w+) invoke \[\d+\]$/.exec(line);
  if(invoke){stack.push({program:invoke[1],create:false,events:[]});continue}
  const done=/^Program (\w+) (success|failed:)/.exec(line);
  if(done){const frame=stack.pop();if(frame?.program===done[1]&&done[2]==='success'&&frame.program===PUMP&&frame.create)events.push(...frame.events);continue}
  const frame=stack.at(-1);if(frame?.program!==PUMP)continue;
  if(/^Program log: Instruction: Create(?:V2)?\s*$/.test(line))frame.create=true;
  if(frame.create&&line.startsWith('Program data: ')&&line.length<=16384){
   const payload=line.slice(14);if(!/^[A-Za-z0-9+/]+={0,2}$/.test(payload))continue;
   const event=createEvent(Buffer.from(payload,'base64'),slot,observedAt);
   if(event)frame.events.push({...event,signature:value.signature});
  }
 }
 return events;
}
module.exports={PUMP,parsePumpLaunch,isTradeableCurve,isPumpCreateLog,parsePumpCreateEvents};
