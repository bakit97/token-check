'use strict';
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',T22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
function measure(rows,{mint,program,supplyRaw,vaults=[],decode58,encode58,at,slot,creator}){
 if(![TOKEN,T22].includes(program)||!Array.isArray(rows)||!rows.length||rows.length>5000||!/^\d+$/.test(String(supplyRaw))||BigInt(supplyRaw)<=0n||vaults.length!==2)throw Error('holder-census-unavailable');const expected=Buffer.from(decode58(mint)),skip=new Set(vaults),owners=new Map();
 for(const r of rows){const account=r.account,b=Buffer.from(account?.data?.[0]||'','base64');if(account?.owner!==program||account.data?.[1]!=='base64'||b.length!==165||!b.subarray(0,32).equals(expected)||![1,2].includes(b[108]))throw Error('holder-census-malformed');if(skip.has(r.pubkey))continue;const amount=b.readBigUInt64LE(64);if(amount>0n){const owner=encode58(b.subarray(32,64));owners.set(owner,(owners.get(owner)||0n)+amount);}}
 const amounts=[...owners.values()].sort((a,b)=>a>b?-1:a<b?1:0),sum=amounts.reduce((a,b)=>a+b,0n),supply=BigInt(supplyRaw);if(sum>supply)throw Error('holder-census-supply-mismatch');const share=n=>Number(amounts.slice(0,n).reduce((a,b)=>a+b,0n))*1/Number(supply);
 return {at,slot,holders:owners.size,holdersComplete:true,top1:share(1),top5:share(5),top10:share(10),vaultsKnown:true,scope:'all-positive-token-account-owners-excluding-pool-vaults',source:'public-solana-filtered-gpa',creatorBalanceRaw:creator?(owners.get(creator)||0n).toString():null,creatorHoldPct:creator?Number(owners.get(creator)||0n)*100/Number(supply):null};
}
class HolderCensus{
 constructor({fetch:read=globalThis.fetch,now=Date.now}){this.fetch=read;this.now=now;this.busy=false;this.stats={attempts:0,success:0,errors:0,deferred:0,lastAt:0,lastError:null,heliusCredits:0};}
 async query(options){if(this.busy||this.now()-this.stats.lastAt<10000){this.stats.deferred++;return null;}this.busy=true;this.stats.lastAt=this.now();this.stats.attempts++;
 try{const r=await this.fetch('https://api.mainnet-beta.solana.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getProgramAccounts',params:[options.program,{commitment:'confirmed',encoding:'base64',withContext:true,dataSlice:{offset:0,length:165},filters:[{memcmp:{offset:0,bytes:options.mint}}]}]}),signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error('holder-provider-unavailable');const result=await require('./early-intelligence').readBoundedJSON(r,2*1024*1024);if(result.error)throw Error('holder-provider-unavailable');const sample=measure(result.result?.value,{...options,at:this.now(),slot:result.result?.context?.slot});this.stats.success++;this.stats.lastError=null;return sample;
 }catch(e){this.stats.errors++;this.stats.lastError=/^holder-census-/.test(e.message)?e.message:'holder-provider-unavailable';return null;}finally{this.busy=false;}}
}
function curveCreator(account,{mint,decode58,encode58}){const bytes=Buffer.from(account?.data?.[0]||'','base64'),owner=account?.owner,disc=bytes.subarray(0,8).toString('hex');let offset=null,mintOffset=null;
 if(owner==='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'&&disc==='17b7f83760d8ac60'){offset=49;}
 if(owner==='dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'&&['d5e005d16245775c','eddbb8172abda923'].includes(disc)){offset=104;mintOffset=136;}
 if(owner==='LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj'&&disc==='f7ede3f5d7c3de46'){offset=333;mintOffset=205;}
 if(offset===null||bytes.length<offset+32||mintOffset!==null&&!bytes.subarray(mintOffset,mintOffset+32).equals(Buffer.from(decode58(mint))))return null;const key=bytes.subarray(offset,offset+32);return key.some(x=>x!==0)?encode58(key):null;
}
async function identityPlan(coins,{getRecord,now,curveOf,metadataOf,limit=100}){
 const tasks=[],addresses=[],index=new Map(),add=address=>{if(!index.has(address)){index.set(address,addresses.length);addresses.push(address);}return index.get(address);};
 const candidates=[...coins].filter(c=>{const r=getRecord(c.a);return r&&now-r.acceptedAt<2*3600000&&now-(c.identityAttemptAt||0)>=60000;}).sort((a,b)=>Number(now-getRecord(a.a).acceptedAt>20*60000)-Number(now-getRecord(b.a).acceptedAt>20*60000)||(a.identityAttemptAt||0)-(b.identityAttemptAt||0)||getRecord(b.a).acceptedAt-getRecord(a.a).acceptedAt);
 for(const c of candidates){const row=getRecord(c.a),mint=!c.ct||!c.supplyRaw||!c.tokenProgram,curve=!c.creatorAddress&&(row.proof?.curve||c.mg?.watch||c.creatorCurveCandidate||c.mg?.k==='pump'),metadata=(!c.n||!c.s||!c.i&&!c.uri)&&now-(c.metadataAttemptAt||0)>=5*60000;
  if(!mint&&!curve&&!metadata)continue;const wanted=[];if(mint)wanted.push(['mint',c.a]);if(curve)wanted.push(['curve',row.proof?.curve||c.mg?.watch||c.creatorCurveCandidate||await curveOf(c.a)]);if(metadata)wanted.push(['metadata',await metadataOf(c.a)]);
  const needed=new Set(wanted.map(x=>x[1]).filter(a=>!index.has(a)));if(addresses.length+needed.size>limit)continue;const task={coin:c};for(const [key,address] of wanted)task[key]=add(address);tasks.push(task);
 }return {addresses,tasks};
}
module.exports={identityPlan,measure,HolderCensus,TOKEN,T22,curveCreator};
