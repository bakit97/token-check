'use strict';
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',T22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const {starterFeaturesAt}=require('./research-v2');
const MIN=60000;
function cardAt(c,at){
 const f=starterFeaturesAt(c||{},at),d=(c?.ds||[]).filter(x=>Number.isFinite(x?.[0])&&x[0]*1000<=at&&at-x[0]*1000<=7*MIN).at(-1),count=v=>Number.isInteger(v)&&v>=0?v:null;
 const WSOL='So11111111111111111111111111111111111111112',qi=c?.vmint?.indexOf(WSOL),vault=qi>=0&&c.vmint.length===2&&c.vmint[1-qi]===c.a&&c.vaultIdentityAt<=at;
 const native=vault?(c.lq||[]).filter(r=>r[0]*1000<=at&&at-r[0]*1000<=35*MIN).at(-1):null,curve=c?.mg?.st!=='ok'&&/pump-?fun/i.test(c?.d||'')&&(!c.q||c.q===WSOL)?(c.curveSol||[]).filter(r=>r[0]<=at&&at-r[0]<=35*MIN).at(-1):null;
 let sol=f.quoteSol,measuredAt=null;if(native&&Number.isFinite(native[2+qi])){sol=native[2+qi]/1e9;measuredAt=native[0]*1000;}else if(curve&&Number.isFinite(curve[1])){sol=curve[1]/1e9;measuredAt=curve[0];}
 const clone=c?.discoveryFeatures&&c.discoveryFeatures.at<=at?c.discoveryFeatures:{};
 return {cloneCount:clone.cloneCount??null,cloneRank:clone.cloneRank??null,isFirstOfName:clone.isFirstOfName??null,cloneCountLowerBound:clone.cloneCountLowerBound===true,sol,solMeasuredAt:measuredAt,solAgeMs:measuredAt!=null?at-measuredAt:null,b5:count(d?.[4]),s5:count(d?.[5]),top10:f.top10,safeContract:f.safeContract==null?null:f.safeContract===1,
  createdAt:Number.isSafeInteger(c?.createdAt)&&c.createdAt<=at?c.createdAt:null,createdAtSource:c?.createdAtSource||null,img:imageUrl(c?.i)||null,cardAt:at,marketObservedAt:d?d[0]*1000:null};
}
function imageUrl(raw){
 if(typeof raw!=='string'||raw.length>2048)return null;
 if(raw.startsWith('ipfs://'))raw='https://ipfs.io/ipfs/'+raw.slice(7).replace(/^ipfs\//,'');
 if(raw.startsWith('ar://'))raw='https://arweave.net/'+raw.slice(5);
 try{const u=new URL(raw),h=u.hostname.toLowerCase();if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||h==='localhost'||/\.(?:internal|local|localhost)$/.test(h)||require('node:net').isIP(h.replace(/^\[|\]$/g,'')))return null;return u.href}catch{return null}
}
function metadataUrl(raw){const value=imageUrl(raw);if(!value)return null;const u=new URL(value);
 return ['ipfs.io','arweave.net','gateway.pinata.cloud','pump.mypinata.cloud','nftstorage.link','cloudflare-ipfs.com'].includes(u.hostname)?u.href:null;
}
async function metadataImage(uri,{fetch:read=globalThis.fetch}={}){
 const url=metadataUrl(uri);if(!url)return {image:null,reason:'unsupported-metadata-host'};
 const control=new AbortController(),timer=setTimeout(()=>control.abort(),6000);timer.unref?.();
 try{const r=await read(url,{redirect:'error',signal:control.signal,headers:{accept:'application/json'}});
  if(!r.ok)throw Error('metadata-http');if(Number(r.headers?.get('content-length'))>262144)throw Error('metadata-too-large');
  let bytes=0;const chunks=[];for await(const b of r.body){bytes+=b.length;if(bytes>262144){control.abort();throw Error('metadata-too-large')}chunks.push(Buffer.from(b))}
  const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));const link=(raw,hosts)=>{const u=imageUrl(raw);if(!u)return false;return !hosts||hosts.includes(new URL(u).hostname.replace(/^www\./,''));};const social={at:Date.now(),hasTwitter:link(data.twitter||data.extensions?.twitter,['twitter.com','x.com']),hasTelegram:link(data.telegram||data.extensions?.telegram,['t.me','telegram.me','telegram.org']),hasWebsite:link(data.website||data.extensions?.website)};return {social,image:imageUrl(data.image),description:typeof data.description==='string'?data.description.slice(0,4096):null};
 }finally{clearTimeout(timer)}
}
function parseMetadata(bytes){const b=Buffer.from(bytes);let pos=65;const values=[];
 for(let i=0;i<3;i++){if(pos+4>b.length)throw Error('metadata-truncated');const n=b.readUInt32LE(pos);pos+=4;if(n>4096||pos+n>b.length)throw Error('metadata-length');values.push(b.subarray(pos,pos+n).toString('utf8').replace(/\0/g,'').trim());pos+=n}
 return {name:values[0],symbol:values[1],uri:values[2]};
}
function verifiesMintCreation(tx,mint){
 if(!tx||tx.meta?.err!==null||!Number.isSafeInteger(tx.blockTime)||tx.blockTime<=0)return false;
 const ix=[...(tx.transaction?.message?.instructions||[]),...(tx.meta.innerInstructions||[]).flatMap(x=>x.instructions||[])];
 return ix.some(i=>[TOKEN,T22].includes(i.programId)&&['initializeMint','initializeMint2'].includes(i.parsed?.type)&&i.parsed.info?.mint===mint);
}
async function findCreation(c,rpc,now){
 let first=c.creationCandidate;
 if(!first){if((c.creationSearch?.pages||0)>=32)return {createdAt:null,reason:'history-budget-bound'};const rows=await rpc('getSignaturesForAddress',[c.a,{limit:1000,commitment:'confirmed',...(c.creationSearch?.before?{before:c.creationSearch.before}:{})}]);
  if(!Array.isArray(rows))return {createdAt:null,reason:'history-unavailable'};
  if(rows.length>=1000){c.creationSearch={before:rows.at(-1).signature,pages:(c.creationSearch?.pages||0)+1,oldestSuccess:[...rows].reverse().find(x=>x.err===null&&typeof x.signature==='string')||c.creationSearch?.oldestSuccess||null};return {createdAt:null,reason:'history-page-pending'};}
  first=[...rows].reverse().find(x=>x.err===null&&typeof x.signature==='string')||c.creationSearch?.oldestSuccess;if(!first)return {createdAt:null,reason:'no-successful-history'};
  c.creationCandidate={signature:first.signature,blockTime:first.blockTime,slot:first.slot};
 }
 const tx=await rpc('getTransaction',[first.signature,{encoding:'jsonParsed',maxSupportedTransactionVersion:0,commitment:'confirmed'}]);
 if(!verifiesMintCreation(tx,c.a))return {createdAt:null,reason:'mint-initialization-unverified'};
 const at=tx.blockTime*1000;if(at>now||Number.isFinite(c.mg?.mT)&&at>c.mg.mT)return {createdAt:null,reason:'creation-after-migration'};
 return {createdAt:at,source:'verified-mint-initialization',signature:first.signature};
}
class CoinProfiles{
 constructor(){this.busy=false;this.lastRun=0;this.stats={images:0,created:0,deferred:0,unknown:0,errors:0}}
 async update({coins,source,rpc,now=Date.now(),fetch}={}){
  if(this.busy||now-this.lastRun<MIN)return;this.busy=true;this.lastRun=now;
  try{const rows=[...coins.values()].filter(c=>{const a=source?.get(c.a);return a&&now-a.acceptedAt<2*3600000});
   for(const c of rows)if(!c.createdAt&&Number.isSafeInteger(c.preTradingAt)){c.createdAt=c.preTradingAt;c.createdAtObservedAt=source.get(c.a)?.acceptedAt||now;c.createdAtSource='verified-create-log-slot-time'}
   const needs=rows.filter(c=>!c.i&&now-(c.profileAttemptAt||0)>10*MIN&& (c.uri||c.ct?.uri||source.get(c.a)?.proof?.uri)).sort((a,b)=>source.get(b.a).acceptedAt-source.get(a.a).acceptedAt).slice(0,4);
   for(const c of needs){c.profileAttemptAt=now;try{const m=await metadataImage(c.uri||c.ct?.uri||source.get(c.a).proof.uri,{fetch});if(!m.reason){c.metadataAt=Date.now();c.socialFeatures=m.social;}if(m.image){c.i=m.image;c.profileAt=Date.now();this.stats.images++}if(m.description!=null)c.description=m.description;c.profileReason=m.reason||null}catch{c.profileReason='metadata-unavailable';this.stats.errors++}}
   const c=rows.filter(c=>source.get(c.a).phase==='after'&&!c.createdAt&&now-(c.creationAttemptAt||0)>60*MIN).sort((a,b)=>source.get(b.a).acceptedAt-source.get(a.a).acceptedAt)[0];
   if(c){try{const result=await findCreation(c,rpc,now);c.creationAttemptAt=result.reason==='history-page-pending'?now-59*MIN:now;c.creationReason=result.reason||null;if(result.createdAt){c.createdAt=result.createdAt;c.createdAtObservedAt=Date.now();c.createdAtSource=result.source;c.creationSignature=result.signature;delete c.creationCandidate;this.stats.created++}else this.stats.unknown++}catch(e){if(e.code==='BUDGET_DEFERRED')this.stats.deferred++;else{c.creationAttemptAt=now;c.creationReason='creation-unavailable';this.stats.errors++}}}
  }finally{this.busy=false}
 }
}
module.exports={cardAt,imageUrl,metadataUrl,metadataImage,parseMetadata,verifiesMintCreation,findCreation,CoinProfiles};
