"use strict";
class PoolBalanceReader{
 constructor({fallback,fetch:read=globalThis.fetch,now=Date.now}){this.fallback=fallback;this.fetch=read;this.now=now;this.stats={publicCalls:0,publicSuccess:0,publicErrors:0,fallbackCalls:0,lastAt:0,lastSuccessAt:0,lastError:null};}
 async call(keys){if(!Array.isArray(keys)||!keys.length||keys.length>100)throw Error('pool-balance-batch-bound');this.stats.publicCalls++;this.stats.lastAt=this.now();try{const r=await this.fetch('https://api.mainnet-beta.solana.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getMultipleAccounts',params:[keys,{encoding:'base64',commitment:'confirmed'}]}),signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('public-provider-unavailable');const d=await require('./early-intelligence').readBoundedJSON(r,1024*1024);if(d.error||!Number.isSafeInteger(d.result?.context?.slot)||!Array.isArray(d.result?.value)||d.result.value.length!==keys.length)throw Error('public-balance-malformed');this.stats.publicSuccess++;this.stats.lastSuccessAt=this.now();this.stats.lastError=null;return d.result;}catch{this.stats.publicErrors++;this.stats.lastError='public-provider-unavailable';this.stats.fallbackCalls++;return this.fallback(keys);}}
 summary(){return {...this.stats,publicHeliusCredits:0};}
}
module.exports={PoolBalanceReader};
