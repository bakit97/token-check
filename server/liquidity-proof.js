'use strict';
// Official layouts: MeteoraAg/damm-v2 programs/cp-amm/src/state/{pool,position,vesting}.rs
const DAMM2='cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',PUMP='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',CPMM='CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',T22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const data=a=>Buffer.from(a?.data?.[0]||'','base64'),u128=(b,o)=>b.readBigUInt64LE(o)+(b.readBigUInt64LE(o+8)<<64n),MAX=Number.MAX_SAFE_INTEGER;
function poolState(account,{mint,pool,decode58,encode58,at,slot}){
 const b=data(account),owner=account?.owner,match=(a,z)=>b.subarray(a,a+32).equals(Buffer.from(decode58(mint)))&&b.subarray(z,z+32).some(x=>x!==0)||b.subarray(z,z+32).equals(Buffer.from(decode58(mint)))&&b.subarray(a,a+32).some(x=>x!==0);
 if(owner===DAMM2&&b.length>=680&&b.subarray(0,8).toString('hex')==='f19a6d0411b16dbc'&&match(168,200))return {pool,mint,owner,at,slot,kind:'position',liquidity:u128(b,360),permanent:u128(b,552),positions:Number(b.readBigUInt64LE(632)),activationType:b[480]};
 const spec=owner===PUMP?{disc:'f19a6d0411b16dbc',a:43,z:75,lp:107,supply:203}:owner===CPMM?{disc:'f7ede3f5d7c3de46',a:168,z:200,lp:136,supply:333}:null;
 if(spec&&b.length>=spec.supply+8&&b.subarray(0,8).toString('hex')===spec.disc&&match(spec.a,spec.z))return {pool,mint,owner,at,slot,kind:'fungible',lpMint:encode58(b.subarray(spec.lp,spec.lp+32)),issued:b.readBigUInt64LE(spec.supply)};
 return null;
}
function positions(rows,state,{decode58,encode58,at,slot}){
 if(!state||state.kind!=='position'||!Array.isArray(rows)||!rows.length||rows.length>100)throw Error('lp-position-unavailable');
 return rows.map(r=>{const b=data(r.account);if(r.account?.owner!==DAMM2||b.length!==408||b.subarray(0,8).toString('hex')!=='aabc8fe47a40f7d0'||!b.subarray(8,40).equals(Buffer.from(decode58(state.pool))))throw Error('lp-position-identity');
  const unlocked=u128(b,152),vested=u128(b,168),permanent=u128(b,184),cliff=b.readBigUInt64LE(312),frequency=b.readBigUInt64LE(320),cliffAmount=u128(b,328),perPeriod=u128(b,344),released=u128(b,360),periods=BigInt(b.readUInt16LE(376));
  const point=state.activationType===1?BigInt(Math.floor(at/1000)):Number.isSafeInteger(slot)?BigInt(slot):null,total=cliffAmount+perPeriod*periods;
  let available=0n,next=null,innerKnown=total>=released&&total-released===vested;
  if(point!==null&&innerKnown){const steps=point<cliff?0n:frequency>0n?((point-cliff)/frequency>periods?periods:(point-cliff)/frequency):periods;const unlockedTotal=point<cliff?0n:cliffAmount+perPeriod*steps;available=unlockedTotal>released?unlockedTotal-released:0n;if(vested>available){next=point<cliff?cliff:frequency>0n?cliff+(steps+1n)*frequency:null;}}
  return {address:r.pubkey,nftMint:encode58(b.subarray(40,72)),unlocked:unlocked+available,vested:vested-available,permanent,total:unlocked+vested+permanent,vestingKnown:innerKnown,nextUnlock:next};
 });
}
function verdict(state,rows=[],nfts={},at=Date.now()){
 const base={at,pool:state?.pool||null,verified:false,state:'unknown',source:'onchain-lp',reason:'lp-unavailable'};if(!state)return base;
 if(state.kind==='fungible'){const m=nfts[state.lpMint]?.mint;if(!m||![TOKEN,T22].includes(m.owner)||m.data?.parsed?.type!=='mint')return base;const info=m.data.parsed.info;if(!/^\d+$/.test(info.supply||'')||info.isInitialized!==true)return base;
  if(BigInt(info.supply)>0n&&nfts[state.lpMint]?.walletOwns===true)return {...base,verified:true,state:'unlocked',reason:null,lpMint:state.lpMint,scope:'circulating-lp-held-by-wallet'};
  return state.issued>0n&&BigInt(info.supply)===0n?{...base,verified:true,state:'burned',lockUntil:MAX,reason:null,lpMint:state.lpMint,scope:'all-issued-fungible-lp-burned'}:{...base,reason:'circulating-lp-owner-lock-unverified'};}
 if(!(state.liquidity>0n)||state.permanent>state.liquidity)return base;
 if(state.permanent===state.liquidity)return {...base,verified:true,state:'locked',lockUntil:MAX,reason:null,scope:'entire-pool-permanently-locked'};
 let sum=0n,permanent=0n,allLocked=rows.length===state.positions,until=MAX;
 for(const p of rows){sum+=p.total;permanent+=p.permanent;const nft=nfts[p.nftMint];const burnt=nft?.mint?.data?.parsed?.type==='mint'&&nft.mint.data.parsed.info.isInitialized===true&&nft.mint.data.parsed.info.supply==='0'&&nft.mint.data.parsed.info.mintAuthority===null&&[TOKEN,T22].includes(nft.mint.owner);
  if(p.unlocked>0n&&!burnt){if(nft?.walletOwns===true)return {...base,verified:true,state:'unlocked',reason:null,scope:'withdrawable-position-nft-held-by-wallet'};allLocked=false;}
  if(p.vested>0n&&!burnt){if(!p.vestingKnown||p.nextUnlock===null){allLocked=false;continue;}if(state.activationType!==1){allLocked=false;continue;}if(p.nextUnlock>BigInt(Math.floor(MAX/1000))){allLocked=false;continue;}until=Math.min(until,Number(p.nextUnlock)*1000);}
 }
 if(allLocked&&sum===state.liquidity&&permanent===state.permanent&&until>at)return {...base,verified:true,state:'locked',lockUntil:until,reason:null,scope:'all-positions-permanent-burned-or-timelocked'};
 return {...base,reason:'position-lock-coverage-incomplete'};
}
class LiquidityProofs{
 constructor({fetch:read=globalThis.fetch,now=Date.now}={}){this.fetch=read;this.now=now;this.busy=false;this.stats={attempts:0,success:0,errors:0,lastAt:0,nextAt:0,heliusCredits:0};}
 async rpc(method,params){const r=await this.fetch('https://api.mainnet-beta.solana.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(8000)});if(!r.ok){this.stats.nextAt=this.now()+30000;throw Error('lp-provider-unavailable');}const d=await require('./early-intelligence').readBoundedJSON(r,512*1024);if(d.error)throw Error('lp-provider-unavailable');return d.result;}
 async query({pool,mint,decode58,encode58,onCurve}){if(this.busy||this.now()<this.stats.nextAt)return null;this.busy=true;this.stats.lastAt=this.now();this.stats.nextAt=this.now()+10000;this.stats.attempts++;
  try{let r=await this.rpc('getAccountInfo',[pool,{encoding:'base64',commitment:'confirmed'}]);let state=poolState(r?.value,{pool,mint,decode58,encode58,at:this.now(),slot:r?.context?.slot});if(!state)return null;let rows=[],nfts={};
   if(state.kind==='position'&&state.permanent!==state.liquidity){const result=await this.rpc('getProgramAccounts',[DAMM2,{encoding:'base64',withContext:true,commitment:'confirmed',filters:[{dataSize:408},{memcmp:{offset:0,bytes:encode58(Buffer.from('aabc8fe47a40f7d0','hex'))}},{memcmp:{offset:8,bytes:pool}}]}]);rows=positions(result?.value,state,{decode58,encode58,at:this.now(),slot:result?.context?.slot});}
   const keys=state.kind==='fungible'?[state.lpMint]:[...new Set(rows.filter(p=>p.unlocked>0n).map(p=>p.nftMint))].slice(0,4);
   if(keys.length){const m=await this.rpc('getMultipleAccounts',[keys,{encoding:'jsonParsed',commitment:'confirmed'}]);keys.forEach((k,i)=>nfts[k]={mint:m?.value?.[i]});for(const k of keys){const mintAccount=nfts[k].mint;if(![TOKEN,T22].includes(mintAccount?.owner)||mintAccount.data?.parsed?.type!=='mint'||state.kind==='position'&&mintAccount.data.parsed.info.supply!=='1'||state.kind==='fungible'&&mintAccount.data.parsed.info.supply==='0')continue;
     const owned=await this.rpc('getProgramAccounts',[mintAccount.owner,{encoding:'base64',withContext:true,dataSlice:{offset:0,length:165},filters:[{memcmp:{offset:0,bytes:k}}]}]);if(!Array.isArray(owned?.value)||owned.value.length>500)continue;let positive=0n,walletOwns=false,okay=true;for(const row of owned.value){const b=data(row.account);if(row.account?.owner!==mintAccount.owner||b.length!==165||!b.subarray(0,32).equals(Buffer.from(decode58(k)))){okay=false;break;}const amount=b.readBigUInt64LE(64);if(amount){positive+=amount;const owner=encode58(b.subarray(32,64));if(b[108]===1&&!['11111111111111111111111111111111','1nc1nerator11111111111111111111111111111111'].includes(owner)&&onCurve(Buffer.from(decode58(owner)))===true)walletOwns=true;}}
     nfts[k].walletOwns=okay&&positive>0n&&(state.kind==='fungible'||positive===1n)&&walletOwns;
   }}
   const out=verdict(state,rows,nfts,this.now());if(out.verified)this.stats.success++;return out;
  }catch(e){this.stats.errors++;this.stats.lastError=/^lp-/.test(e.message)?e.message:'lp-proof-unavailable';return null;}finally{this.busy=false;}
 }
}
module.exports={poolState,positions,verdict,LiquidityProofs,DAMM2,PUMP,CPMM};
