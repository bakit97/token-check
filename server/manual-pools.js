'use strict';
// Successful direct DEX initialization only. Unknown wrappers are not guessed manual.
const crypto=require('node:crypto'),{keysOf}=require('./migration-fast');
const WSOL='So11111111111111111111111111111111111111112';
const definitions=[
 ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA','create_pool','PumpSwap',0,2,3,4,9,10],
 ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK','create_pool','Raydium CLMM',2,0,3,4,5,6],
 ...['initialize_customizable_permissionless_lb_pair','initialize_customizable_permissionless_lb_pair2','initialize_lb_pair','initialize_lb_pair2'].map(name=>['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',name,'Meteora DLMM',0,8,2,3,4,5]),
 ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG','initialize_customizable_pool','Meteora DAMM v2',5,0,7,8,9,10],
 ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG','initialize_pool','Meteora DAMM v2',6,0,8,9,10,11],
 ['cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG','initialize_pool_with_dynamic_config','Meteora DAMM v2',7,0,9,10,11,12]
].map(([program,name,dex,pool,creator,mintA,mintB,vaultA,vaultB])=>({program,name,dex,pool,creator,mintA,mintB,vaultA,vaultB,discriminator:crypto.createHash('sha256').update('global:'+name).digest().subarray(0,8).toString('hex')}));
function manualPoolCandidates(tx,decode58){
 if(tx?.meta?.err!==null||!Number.isSafeInteger(tx?.blockTime)||tx.blockTime<=0)return [];
 const keys=keysOf(tx),message=tx.transaction?.message,signers=new Set(keys.slice(0,message?.header?.numRequiredSignatures||0)),out=[];
 for(const ix of message?.instructions||[]){const program=ix.programId||keys[ix.programIdIndex];let raw;try{raw=Buffer.from(decode58(ix.data||'1'));}catch{continue;}
  const spec=definitions.find(s=>s.program===program&&s.discriminator===raw.subarray(0,8).toString('hex'));if(!spec||!Array.isArray(ix.accounts))continue;
  const at=i=>typeof ix.accounts[i]==='number'?keys[ix.accounts[i]]:ix.accounts[i],pool=at(spec.pool),creator=at(spec.creator),a=at(spec.mintA),b=at(spec.mintB),index=keys.indexOf(pool);
  if(!pool||!creator||!signers.has(creator)||index<0||tx.meta.preBalances?.[index]!==0||!(tx.meta.postBalances?.[index]>0)||!a||!b||a===b||(a!==WSOL&&b!==WSOL))continue;
  const mint=a===WSOL?b:a,quoteVault=at(a===WSOL?spec.vaultA:spec.vaultB),baseVault=at(a===WSOL?spec.vaultB:spec.vaultA),balance=(vault,expected)=>{
   const rows=(tx.meta.postTokenBalances||[]).filter(x=>keys[x.accountIndex]===vault&&x.mint===expected);if(rows.length!==1)return null;const v=rows[0].uiTokenAmount;if(!v||!Number.isInteger(v.decimals)||v.decimals<0||v.decimals>18||!/^\d+$/.test(v.amount))return null;const amount=BigInt(v.amount);return amount<=BigInt(Number.MAX_SAFE_INTEGER)?Number(amount)/10**v.decimals:null;
  };
  const liquiditySol=balance(quoteVault,WSOL);
  out.push({mint,quote:WSOL,pool,creatorAddress:creator,dex:spec.dex,dexProgram:program,launchpad:null,venue:spec.dex,quoteVault,baseVault,liquiditySol,baseReserve:balance(baseVault,mint),liquidityUsd:null,marketCapUsd:null,liquidityToMarketCap:null,creatorDepositSol:null,lpEvidence:null,eventAt:tx.blockTime*1000,slot:tx.slot,signature:tx.transaction.signatures?.[0],instruction:spec.name,scope:'creation-transaction-end',funded:liquiditySol!==null&&liquiditySol>0});
 }
 return out;
}
module.exports={manualPoolCandidates,definitions};
