'use strict';
// Read-only reconciliation. Never infers receipt time from market time.
const {isDeepStrictEqual:eq}=require('node:util');
const day=at=>new Date(at+5*3600000).toISOString().slice(0,10);
const fetches=f=>(f||[]).map(x=>({at:x[0],count:x[1],marketMinAt:x[2]==null?null:x[2]*1000,marketMaxAt:x[3]==null?null:x[3]*1000}));
function validateArchive(row,pool,kind,name,body){
 const suffix=kind==='rawStates'?'state':'trades';
 const legacy=`raw/${day(pool.marketAt)}/${row.a}-${suffix}.json`,current=`observations-v2/raw/${day(pool.marketAt)}/${row.a}/${pool.address}-${pool.marketAt}-${suffix}.json`;
 if(!Number.isFinite(pool.marketAt)||![legacy,'archive/legacy/'+legacy,current].includes(name)||!body||body.a!==row.a||body.p!==pool.address||body.t!==pool.marketAt)return {status:'identity-mismatch'};
 if(kind==='rawStates'){
  if(!body.raw||typeof body.raw!=='object'||Array.isArray(body.raw))return {status:'invalid-payload'};
  let bytes=0;
  for(const [minute,sample] of Object.entries(body.raw)){
   if(!Number.isFinite(sample?.at)||sample.at<=0)return {status:'missing-receipt'};
   const inline=pool.rawStates?.[minute];
   if(inline)for(const key of ['at','slot','b','vaultAt','vaultSlot'])if(inline[key]!=null&&sample[key]!=null&&!eq(inline[key],sample[key]))return {status:'observation-conflict'};
   for(const b of sample.b||[])if(typeof b==='string')bytes+=Buffer.byteLength(b,'base64');
  }
  return {status:'verified',rawSamples:Object.keys(body.raw).length,rawDecodedBytes:bytes};
 }
 if(!Array.isArray(body.f)||!body.x||typeof body.x!=='object'||Array.isArray(body.x))return {status:'invalid-payload'};
 if(body.f.some(f=>!Array.isArray(f)||!Number.isFinite(f[0])||f[0]<=0))return {status:'missing-receipt'};
 const batches=fetches(body.f);
 if((pool.tradeFetches||[]).some(f=>!batches.some(b=>eq(b,f))))return {status:'observation-conflict'};
 for(const [id,trade] of Object.entries(pool.tradeRows||{}))if(!eq(body.x[id],trade))return {status:'observation-conflict'};
 if(Object.keys(body.x).length&&!body.f.length)return {status:'missing-receipt'};
 return {status:'verified',tradeRows:Object.keys(body.x).length,tradeFetches:body.f.length};
}
async function hydrateArchives(row,load){
 if(row?.schema!==2||row.observations?.schema!==2)throw Error('Unsupported observation contract');
 const checks=[],pools=[];
 for(const original of row.observations.pools){let pool={...original,archives:{...original.archives}};
  for(const kind of ['rawStates','trades']){const name=pool.archives[kind];if(!name)continue;
   let body,result;try{body=await load(name);result=body?validateArchive(row,pool,kind,name,body):{status:'missing'};}catch(e){result={status:'unavailable'};}
   checks.push({mint:row.a,pool:pool.address,marketAt:pool.marketAt,kind,name,...result});
   if(result.status!=='verified')continue;
   if(kind==='rawStates'){const raw={...body.raw};for(const [m,x] of Object.entries(pool.rawStates||{}))raw[m]={...raw[m],...x};pool.rawStates=raw;}
   else{pool.tradeFetches=fetches(body.f);pool.tradeRows=body.x;}
   pool.archives[kind+'Verification']='identity-and-observations-verified';
  }
  pools.push(pool);
 }
 return {row:{...row,observations:{...row.observations,pools}},checks,okay:checks.every(c=>c.status==='verified')};
}
function archiveCandidates(name){return name.startsWith('raw/')?[name,'archive/legacy/'+name]:[name];}
module.exports={validateArchive,hydrateArchives,archiveCandidates};
