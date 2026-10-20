'use strict';
const DEX_PROGRAMS={
 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA':'PumpSwap',
 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C':'Raydium CPMM',
 '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8':'Raydium AMM',
 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK':'Raydium CLMM',
 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo':'Meteora DLMM',
 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB':'Meteora DAMM',
 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG':'Meteora DAMM v2',
 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc':'Orca'
};
const LAUNCHPADS={pump:'pump.fun',dbc:'Meteora DBC','dbc-v1':'Meteora DBC',launch:'Raydium LaunchLab','launch-v4':'Raydium LaunchLab'};
function identity(c={},phase,at=Date.now(),admission=null){
 const proof=admission?.proof||{},mg=c.mg||{st:c.mst,k:c.mk,seenAt:c.mSeen},manual=phase==='before'&&(proof.kind==='manual-pool-open-v1'||mg.k==='manual-pool');
 const migrated=phase==='after'&&(mg.st==='ok'||proof.signature&&proof.pool);
 const receivedAt=c.venueObservedAt??c.admissionVerifiedAt??proof.verifiedAt??mg.seenAt??(admission?.acceptedAt||null);
 if(!Number.isFinite(receivedAt)||receivedAt>at||!manual&&!migrated)return {launchpad:null,dex:null,venue:null,venueObservedAt:null};
 const owner=proof.dexProgram||mg.owner,knownDex=DEX_PROGRAMS[owner]||null;
 // A generic LaunchLab migration does not establish bonk/LetsBonk identity.
 const launchpad=manual?null:LAUNCHPADS[proof.family||mg.k]||null;
 const cached=(manual||Number.isFinite(c.venueObservedAt))&&(proof.dex||c.dex);const dex=knownDex||(Object.values(DEX_PROGRAMS).includes(cached)?cached:null);
 return {launchpad,dex,venue:dex?(launchpad?launchpad+' → '+dex:dex):null,venueObservedAt:receivedAt};
}
function features(c,phase,at){const {launchpad,dex}=identity(c,phase,at);return {launchpad,dex};}
module.exports={identity,features,DEX_PROGRAMS,LAUNCHPADS};
