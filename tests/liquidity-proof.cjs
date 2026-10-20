'use strict';
const test=require('node:test'),a=require('node:assert/strict'),lp=require('../server/liquidity-proof');
const at=1792525000000,base={pool:'pool',kind:'position',liquidity:100n,permanent:0n,positions:1,activationType:1};
const row={total:100n,unlocked:100n,vested:0n,permanent:0n,nftMint:'nft',vestingKnown:true,nextUnlock:null};
test('DAMM position liquidity alone never proves unlocked: NFT ownership or burn is verified',()=>{
 a.equal(lp.verdict(base,[row],{},at).verified,false);
 a.equal(lp.verdict(base,[row],{nft:{walletOwns:true}},at).state,'unlocked');
 const burned={nft:{mint:{owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',data:{parsed:{type:'mint',info:{supply:'0',mintAuthority:null,isInitialized:true}}}}}};
 a.equal(lp.verdict(base,[row],burned,at).state,'locked');burned.nft.mint.data.parsed.info.mintAuthority='authority';a.equal(lp.verdict(base,[row],burned,at).verified,false);
});
test('all-position permanent and time locks need exact complete liquidity totals and an unexpired deadline',()=>{
 a.equal(lp.verdict({...base,permanent:100n},[],{},at).lockUntil,Number.MAX_SAFE_INTEGER);
 const p={...row,unlocked:0n,vested:100n,nextUnlock:BigInt(at/1000+3600)};
 a.equal(lp.verdict(base,[p],{},at).state,'locked');a.equal(lp.verdict(base,[p],{},at).lockUntil,at+3600000);
 a.equal(lp.verdict({...base,positions:2},[p],{},at).verified,false);
 a.equal(lp.verdict(base,[{...p,vestingKnown:false}],{},at).verified,false);
 a.equal(lp.verdict({...base,liquidity:101n},[p],{},at).verified,false);
 a.equal(lp.verdict({...base,activationType:0},[p],{},at).verified,false,'slot locks are not guessed from 0.4-second wall time');
});
test('fungible LP mint zero is burn proof only for the verified issued and initialized mint',()=>{
 const state={kind:'fungible',pool:'p',issued:100n,lpMint:'lp'},mint={owner:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',data:{parsed:{type:'mint',info:{supply:'0',isInitialized:true}}}};
 a.equal(lp.verdict(state,[],{lp:{mint}},at).state,'burned');mint.data.parsed.info.supply='1';a.equal(lp.verdict(state,[],{lp:{mint}},at).verified,false,'circulation may belong to a locker');
});
test('LP evidence cannot leak from another pool or a receipt after the feature deadline',()=>{
 const f=require('../server/research-v2').featuresAt,c={p:'p',mg:{st:'ok',k:'dbc'},lpEvidence:{pool:'p',verified:true,state:'locked',at,lockUntil:at+3600000}};
 a.equal(f(c,at,{phase:'after'}).lpBurned,1);a.equal(f({...c,p:'other'},at,{phase:'after'}).lpBurned,null);a.equal(f(c,at-1,{phase:'after'}).lpBurned,null);
});


test('official DAMM pool and Position offsets require discriminator, owner and matching pool/mint',()=>{
 const mint=Buffer.alloc(32,1),pool=Buffer.alloc(32,2),nft=Buffer.alloc(32,3),decode58=s=>s==='mint'?mint:pool,encode58=b=>b.toString('hex'),b=Buffer.alloc(1112);Buffer.from('f19a6d0411b16dbc','hex').copy(b);mint.copy(b,168);pool.copy(b,200);b.writeBigUInt64LE(100n,360);b.writeBigUInt64LE(1n,632);b[480]=1;
 const state=lp.poolState({owner:lp.DAMM2,data:[b.toString('base64'),'base64']},{mint:'mint',pool:'pool',decode58,encode58,at,slot:1});a.equal(state.liquidity,100n);a.equal(state.positions,1);
 const pos=Buffer.alloc(408);Buffer.from('aabc8fe47a40f7d0','hex').copy(pos);pool.copy(pos,8);nft.copy(pos,40);pos.writeBigUInt64LE(100n,152);
 const account={owner:lp.DAMM2,data:[pos.toString('base64'),'base64']};a.equal(lp.positions([{pubkey:'position',account}],state,{decode58,encode58,at,slot:1})[0].unlocked,100n);
 a.throws(()=>lp.positions([{pubkey:'position',account:{...account,owner:'other'}}],state,{decode58,encode58,at,slot:1}));
 a.equal(lp.poolState({owner:lp.DAMM2,data:[b.toString('base64'),'base64']},{mint:'mint',pool:'pool',decode58:()=>Buffer.alloc(32,9),encode58,at}),null);
});
