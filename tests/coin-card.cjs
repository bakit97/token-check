'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {cardAt,findCreation,metadataImage,parseMetadata}=require('../server/coin-profile');
const T=Date.UTC(2026,9,19),M=60000,WSOL='So11111111111111111111111111111111111111112',TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
function coin(){return {a:'mint',t:T-10*M,q:WSOL,ct:{at:T-M,prog:'token',safetyVersion:1,unknownExtensions:[],mint:false,freeze:false,hook:false,deleg:false,nontr:false,defFrozen:false,pause:false,feeAuthority:false,fee:0},vmint:['mint',WSOL],vaultIdentityAt:T-2*M,lq:[[(T-M)/1000,7,1,6e9]],ds:[[(T-M)/1000,1,0,1,0,2,3]],hold:{10:{at:T-M,top10:.2}}};}
test('source card reports real measured values with units and does not invent a birth from migration',()=>{
 const c=coin(),r=cardAt(c,T);assert.equal(r.sol,6);assert.equal(r.b5,0);assert.equal(r.s5,2);assert.equal(r.top10,20);assert.equal(r.safeContract,true);assert.equal(r.createdAt,null);
 c.ct.at=T+1;c.lq[0][0]=(T+1)/1000;c.ds[0][0]=(T+1)/1000;c.hold[10].at=T+1;const early=cardAt(c,T);for(const k of ['sol','b5','s5','top10','safeContract'])assert.equal(early[k],null,k);
 const pre=coin();delete pre.vmint;pre.d='pump-fun';pre.curveSol=[[T-1000,3e9,0]];assert.equal(cardAt(pre,T).sol,3);
});
test('birth lookup verifies the mint initialization and resumes a deferred transaction without re-reading history',async()=>{
 const c=coin(),calls=[],tx={blockTime:Math.floor((T-30*M)/1000),meta:{err:null,innerInstructions:[{instructions:[{programId:TOKEN,parsed:{type:'initializeMint2',info:{mint:c.a}}}]}]},transaction:{message:{instructions:[]}}};let deferred=true;
 const rpc=async(m,p)=>{calls.push(m);if(m==='getSignaturesForAddress')return [{signature:'last',err:null},{signature:'birth',err:null}];if(deferred)throw Object.assign(Error('budget'),{code:'BUDGET_DEFERRED'});assert.equal(p[0],'birth');return tx};
 await assert.rejects(findCreation(c,rpc,T),{code:'BUDGET_DEFERRED'});deferred=false;const r=await findCreation(c,rpc,T);assert.equal(r.createdAt,tx.blockTime*1000);assert.equal(calls.filter(m=>m==='getSignaturesForAddress').length,1);
 tx.meta.innerInstructions[0].instructions[0].parsed.info.mint='other';assert.equal((await findCreation(c,rpc,T)).createdAt,null);
});
test('a full signature page saves a bounded pagination cursor and never invents a birth',async()=>{
 let n=0;const result=await findCreation(coin(),async(m)=>{n++;assert.equal(m,'getSignaturesForAddress');return Array.from({length:1000},()=>({err:null,signature:'x'}))},T);assert.equal(result.createdAt,null);assert.equal(result.reason,'history-page-pending');assert.equal(n,1);
});
test('metadata images reject internal/untrusted fetches, enforce a byte bound and keep the URI immutable',async()=>{
 let calls=0;const read=async()=>{calls++;return {ok:true,headers:{get:()=>null},body:[Buffer.from(JSON.stringify({image:'ipfs://bafyimage',description:'text'}))]}};
 for(const uri of ['http://metadata.google.internal/','https://127.0.0.1/token','https://evil.example/redirect'])assert.equal((await metadataImage(uri,{fetch:read})).image,null);assert.equal(calls,0);
 const r=await metadataImage('ipfs://bafymetadata',{fetch:read});assert.equal(r.image,'https://ipfs.io/ipfs/bafyimage');
 await assert.rejects(metadataImage('https://ipfs.io/ipfs/bafy',{fetch:async(u,o)=>{assert.equal(o.redirect,'error');return {ok:true,headers:{get:()=>null},body:[Buffer.alloc(262145)]}}}),/too-large/);
 const parts=[Buffer.alloc(65),...['Coin','C','https://ipfs.io/ipfs/bafy'].flatMap(s=>{const b=Buffer.from(s),n=Buffer.alloc(4);n.writeUInt32LE(b.length);return [n,b]})];assert.equal(parseMetadata(Buffer.concat(parts)).uri,'https://ipfs.io/ipfs/bafy');assert.throws(()=>parseMetadata(Buffer.alloc(66)));
});
test('existing UI data adapters preserve server zero/unknown values and real age without external substitution',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../v2.js'),'utf8'),ctx={liveOf:()=>({b5:999,s5:999}),now:()=>T};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function sourceCard('),source.indexOf('function admitted('))+';this.card=sourceCard;this.market=cardMarket;this.age=cardAgeAt;',ctx);
 const c=ctx.card({sol:0,b5:0,s5:null,top10:20,safeContract:false,createdAt:T-30*M});assert.equal(ctx.market(c).b5,0);assert.equal(ctx.market(c).s5,null);assert.equal(ctx.age({...c,_entry:{phase:'after',eventAt:T-M}}),T-30*M);assert.equal(ctx.age({_entry:{phase:'after',eventAt:T-M}}),0);
});

test('birth pagination resumes behind the previous oldest signature and verifies the true initialization',async()=>{const c=coin(),calls=[];let page=0;const rpc=async(m,p)=>{calls.push([m,p]);if(m==='getSignaturesForAddress'){if(page++===0)return Array.from({length:1000},(_,i)=>({signature:'recent'+i,err:null}));assert.equal(p[1].before,'recent999');return [{signature:'birth',err:null}];}assert.equal(p[0],'birth');return {blockTime:Math.floor((T-100*M)/1000),meta:{err:null},transaction:{message:{instructions:[{programId:TOKEN,parsed:{type:'initializeMint',info:{mint:c.a}}}]}}};};assert.equal((await findCreation(c,rpc,T)).createdAt,null);assert.equal((await findCreation(c,rpc,T)).createdAt,T-100*M);assert.equal(calls.length,3);});

test('source uses immutable server clone metadata and marks the age of last measured native reserves',()=>{const c=coin();c.discoveryFeatures={at:T-1000,cloneCount:3,cloneRank:4,isFirstOfName:0};c.lq[0][0]=(T-20*M)/1000;let card=cardAt(c,T);assert.equal(card.sol,6);assert.equal(card.solAgeMs,20*M);assert.equal(card.cloneCount,3);assert.equal(card.cloneRank,4);assert.equal(cardAt(c,T-2000).cloneCount,null);assert.equal(cardAt(c,T+20*M).sol,null);});


test('IPFS rate limit retries the identical CID through one known gateway without following redirects',async()=>{
 const api=require('../server/coin-profile'),cid='Qm'+'a'.repeat(44),urls=[];
 const result=await api.metadataImage('https://ipfs.io/ipfs/'+cid,{fetch:async(url,opt)=>{urls.push(url);assert.equal(opt.redirect,'error');if(urls.length===1)return {ok:false,status:429,headers:{get:()=>null}};return {ok:true,headers:{get:()=>null},body:[Buffer.from(JSON.stringify({name:'Coin',image:'ipfs://'+cid}))]};}});
 assert.equal(urls.length,2);assert.equal(urls[1],'https://gateway.pinata.cloud/ipfs/'+cid);assert.ok(result.image);
});


test('profile queue reaches older unattempted admitted coins before retrying recent failures',async()=>{
 const {CoinProfiles}=require('../server/coin-profile'),now=Date.UTC(2026,9,20),coins=new Map(),records=new Map();
 for(let i=0;i<8;i++){const a='m'+i;records.set(a,{mint:a,phase:'before',eventAt:now-(i+1)*3600000,acceptedAt:now-(i+1)*3600000});coins.set(a,{a,uri:'https://ipfs.io/ipfs/'+'Qm'+'a'.repeat(44),...(i<4?{profileAttemptAt:now-11*60000}:{})});}
 const profiles=new CoinProfiles();await profiles.update({coins,source:{get:a=>records.get(a)},now,fetch:async()=>({ok:true,headers:{get:()=>null},body:[Buffer.from(JSON.stringify({image:'https://example.com/a.png'}))]})});
 assert.equal(profiles.stats.imageAttempts,4);for(let i=4;i<8;i++)assert.ok(coins.get('m'+i).i);for(let i=0;i<4;i++)assert.equal(coins.get('m'+i).i,undefined);
});


test('free birth time uses the old launch curve and preserves migration/event time',()=>{const api=require('../server/coin-profile'),c={a:'mint',p:'new',t:T,mg:{st:'ok',mT:T,pool:'new'}},row={phase:'after',eventAt:T,acceptedAt:T+1000};const a=assert;a.equal(api.birthFromPairs(c,[{chainId:'solana',baseToken:{address:'mint'},dexId:'meteoradbc',pairAddress:'curve',pairCreatedAt:T-30*M}],row,T+M),true);a.equal(c.createdAt,T-30*M);a.equal(c.t,T);a.equal(c.createdAtSource,'dexscreener-launch-curve-pair');const f=require('../server/research-v2').featuresAt(c,T+2*M,{eventAt:T+1000,phase:'after'});a.equal(f.ageAtMigrationMin,30);a.equal(require('../server/research-v2').featuresAt(c,T,{eventAt:T,phase:'after'}).ageAtMigrationMin,null);});
test('manual pool birth is opening time and wrong-token GT history cannot fill birth',()=>{const api=require('../server/coin-profile'),c={a:'mint',t:T},row={phase:'before',eventAt:T,acceptedAt:T,proof:{kind:'manual-pool-open-v1'}};assert.equal(api.birthFromPairs(c,[],row,T),true);assert.equal(c.createdAt,T);assert.equal(api.birthFromGT({a:'mint'},{data:{relationships:{base_token:{data:{id:'solana_foreign'}}},attributes:{pool_created_at:new Date(T-M).toISOString()}}},row,T),false);});


test('profile update never invokes paid RPC for missing birth time',async()=>{let calls=0;const {CoinProfiles}=require('../server/coin-profile'),c={a:'mint',p:'new'},now=T+M;await new CoinProfiles().update({coins:new Map([['mint',c]]),source:{get:()=>({phase:'after',eventAt:T,acceptedAt:T})},now,rpc:async()=>{calls++;throw Error('must not call')}});assert.equal(calls,0);assert.equal(c.createdAt,undefined);});
