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
