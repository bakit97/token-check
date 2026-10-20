const test=require('node:test'),a=require('node:assert/strict'),{activeCurve,earlierPair}=require('../server/side-pools'),{applyIdentity,applyMintIdentity,metadataImage}=require('../server/coin-profile');
const P='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',L='LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
test('manual side-pool guard distinguishes active pump and LaunchLab curves from completed and missing states',()=>{
 const account=(program,index,value)=>{const b=Buffer.alloc(424);b[index]=value;return {owner:program,data:[b.toString('base64'),'base64']}};
 a.equal(activeCurve(account(P,48,0),P),true);a.equal(activeCurve(account(P,48,1),P),false);a.equal(activeCurve(account(L,17,1),L),true);a.equal(activeCurve(account(L,17,2),L),false);a.equal(activeCurve(null,P),false);a.equal(activeCurve({owner:P,data:['x','jsonParsed']},P),null);
});
test('earlier pool veto is scoped to the actual mint, chain and earlier creation block',()=>{
 const v={mint:'mint',pool:'new',eventAt:2000},row={chainId:'solana',baseToken:{address:'mint'},pairAddress:'old',pairCreatedAt:1000};
 a.equal(earlierPair([row],v),row);for(const change of [{chainId:'ethereum'},{baseToken:{address:'other'}},{pairAddress:'new'},{pairCreatedAt:3000}])a.equal(earlierPair([{...row,...change}],v),null);
 a.throws(()=>earlierPair(null,v));
});
test('mint and JSON metadata fill empty names and symbols at receipt time without overwriting known identity',async()=>{
 const c={n:'',s:''};applyMintIdentity(c,{data:{parsed:{info:{extensions:[{extension:'tokenMetadata',state:{name:'Google AI',symbol:'GAI',uri:'ipfs://cid'}}]}}}},123);
 a.equal(c.n,'Google AI');a.equal(c.s,'GAI');a.equal(c.nameObservedAt,123);applyIdentity(c,{name:'different',symbol:'BAD'},124);a.equal(c.n,'Google AI');
 const result=await metadataImage('https://ipfs.io/ipfs/test',{fetch:async()=>({ok:true,headers:{get:()=>null},body:[Buffer.from(JSON.stringify({name:'Google AI',symbol:'GAI',image:'https://ipfs.io/ipfs/image'}))]})});a.equal(result.name,'Google AI');a.equal(result.symbol,'GAI');a.ok(result.image);
});

test('revoked side pool cannot reappear after restart and does not prevent a later real migration',t=>{
 const {SourceRuntime}=require('../server/source-runtime'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),d=fs.mkdtempSync(path.join(os.tmpdir(),'side-revoke-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));const mint='A'.repeat(32),now=Date.now(),s=new SourceRuntime({dir:d,fsync:false});
 a.equal(s.before({mint,publicTradingAt:now-1000,observedAt:now,verified:true,proof:{kind:'manual-pool-open-v1',pool:'side'}}).admitted,true);a.equal(s.revokeManualPool(mint,'earlier-pool',now),true);a.equal(s.has(mint),false);a.equal(s.dailySummary(now).before.accepted,0);
 const restored=new SourceRuntime({dir:d,fsync:false});a.equal(restored.has(mint),false);a.equal(restored.get(mint),null);a.equal(restored.before({mint,publicTradingAt:now,observedAt:now,verified:true}).reason,'rejected-side-pool');
 const result=restored._admit({mint,phase:'after',migrationAt:now,migrationVerified:true},now,{pool:'official',kind:'migration'});a.equal(result.admitted,true);a.equal(new SourceRuntime({dir:d,fsync:false}).get(mint).phase,'after');
});

test('empty early token catalogue is retried for missing identity, while complete cards do not poll it again',()=>{
 const {tokenInfoDue}=require('../server/coin-profile');a.equal(tokenInfoDue({n:'',s:'',i:'',tokAt:1000},1000+5*60000),true);a.equal(tokenInfoDue({n:'name',s:'SYM',i:'image',tokAt:1000},1000+30*60000),false);a.equal(tokenInfoDue({n:'',s:'',i:'',tokAt:1000},1000+60000),false);
});
