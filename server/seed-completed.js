'use strict';
const fs=require('node:fs');
const {readRows}=require('./stream-json');
const FIELDS=['a','n','s','i','p','d','q','t','tSrc','t0','seen','disc','rcSeen','wsSeen','firstPostSeenAt','preCurve','preTradingAt','ct','soc','tk','tkAt','lastTrade',
 'ds','lq','path','k10','hold','bx','gx','vdec','vmint','vaults','raw','tr','rawUp','trDone','movedAt','pools'];
function legacyCoin(row){const c={legacy:1};for(const key of FIELDS)if(row[key]!=null)c[key]=row[key];
 c.mg={st:row.mst||'unk',k:row.mk||null,why:row.mw||'',mT:row.mT||null,sig:row.mSig||null,seenAt:row.mSeen||null,creator:row.mCr??null};
 c.origs=(row.origs||[]).map(o=>{const p={};for(const key of FIELDS)if(o[key]!=null)p[key]=o[key];return p});
 if(row.preObs){const p={};for(const key of FIELDS)if(row.preObs[key]!=null)p[key]=row.preObs[key];const i=c.origs.findIndex(o=>o.p===p.p&&o.t===p.t);if(i<0)c.origs.push(p);else c.origs[i]=p}
 return c;
}
function unionRows(a=[],b=[]){a=a||[];b=b||[];if(!b.length)return a;const seen=new Set(a.map(r=>JSON.stringify(r))),extra=[];for(const r of b){const key=JSON.stringify(r);if(!seen.has(key)){seen.add(key);extra.push(r)}}return extra.length?[...a,...extra].sort((x,y)=>x[0]-y[0]):a}
async function seedDay({store,day,hot,download,archive}){
 if(store.seeded.has(day)||store.sealed.has(day))return;
 const stats={dayRows:0,obsRows:0,rawLoaded:0,tradesLoaded:0,rawMissing:0,tradesMissing:0,unknownPool:0,hotRowsRecovered:0};
 const dayFile=await download('day',day),obsFile=await download('obs',day);
 const dayPools=new Map();
 const isHot=r=>{const c=hot.get(r.a),pool=r.p||dayPools.get(r.a)?.p;return c&&c.t===r.t&&(!pool||c.p===pool)?c:null};
 const preserve=(c,row)=>{
  for(const key of ['ds','lq','gx']){const old=c[key]||[],merged=unionRows(old,row[key]);stats.hotRowsRecovered+=merged.length-old.length;if(merged!==old)c[key]=merged}
  for(const key of ['k10','path','bx','ct','vmint','vdec','vaults'])if(!c[key]&&row[key])c[key]=row[key];
  for(const key of ['raw','hold'])if(row[key]){c[key]=c[key]||{};for(const [k,v] of Object.entries(row[key]))if(!c[key][k])c[key][k]=v}
  if(row.preObs){c.origs=c.origs||[];const prior=legacyCoin({a:row.a,t:row.t,preObs:row.preObs}).origs[0],old=c.origs.find(o=>o.p===prior.p&&o.t===prior.t);if(old)preserve(old,prior);else c.origs.push(prior)}
 };
 async function enrich(c){if(c.legacyArchiveChecked)return c;
  const attach=(r,kind)=>{if(r.a!==c.a||!Number.isFinite(r.t)||!r.p)throw Error('Legacy archive identity mismatch');let target=[c,...c.origs].find(p=>p.p===r.p&&p.t===r.t);
   if(!target){if(!c.p&&r.t===c.t){c.p=r.p;target=c}else{target={p:r.p,t:r.t};c.origs.push(target)}}
   if(kind==='state'){target.raw={...(target.raw||{}),...(r.raw||{})};target.vaults=r.vaults||target.vaults;target.rawUp=1}
   else {target.tr={f:r.f||[],x:r.x||{}};target.trDone=1}
  };
  if(Object.keys(c.raw||{}).length&&!Object.values(c.raw).some(r=>r.b?.length)){
   const r=await archive(`raw/${day}/${c.a}-state.json`);if(r){attach(r,'state');stats.rawLoaded++}else stats.rawMissing++;
  }
  if(c.bx?.at||c.k10?.src==='trades'){
   const r=await archive(`raw/${day}/${c.a}-trades.json`);if(r){attach(r,'trades');stats.tradesLoaded++}else stats.tradesMissing++;
  }
  if(!c.p)stats.unknownPool++;c.legacyArchiveChecked=1;return c;
 }
 async function* batches(rows,convert,observed=false){let batch=[],read=0;
  for(const row of rows){if(!observed)dayPools.set(row.a,{p:row.p,t:row.t});const c=isHot(row);if(c){preserve(c,row);if(observed)c.completedLegacyObserved=1}else batch.push(convert(row));
   if(++read%32===0)await new Promise(r=>setImmediate(r));if(batch.length===8){yield*await Promise.all(batch.map(enrich));batch=[]}}
  if(batch.length)yield*await Promise.all(batch.map(enrich));
 }
 if(dayFile)await store.stage(batches(readRows(dayFile,null,{field:'coins'}),row=>{stats.dayRows++;return legacyCoin(row)}));
 if(obsFile)await store.stage(batches(readRows(obsFile,null,{field:'coins'}),row=>{
  stats.obsRows++;const c=store.readCoin(row.a)||legacyCoin(row);c.completedLegacyObserved=1;c.ds=unionRows(c.ds,row.ds);c.lq=unionRows(c.lq,row.lq);if(row.path)c.path=row.path;
  if(row.preObs){const prior=legacyCoin({a:row.a,t:row.t,preObs:row.preObs}).origs[0],old=c.origs.find(o=>o.p===prior.p&&o.t===prior.t);if(old){old.ds=unionRows(old.ds,prior.ds);old.lq=unionRows(old.lq,prior.lq);for(const key of ['raw','tr','hold','k10','bx'])if(prior[key])old[key]=prior[key]}else c.origs.push(prior)}
  return c;
 },true));
 store.markSeeded(day,stats);for(const file of [dayFile,obsFile])if(file)fs.unlinkSync(file);return stats;
}
// Canonical recovery never depends on the retired day/obs formats.
async function seedObservationDay({store,day,hot,download}){
 if(store.seeded.has(day)||store.sealed.has(day))return;
 const file=await download('observations-v2',day),stats={contractRows:0,coldRows:0,hotRowsRecovered:0,archiveReferences:0};
 const {toLegacy}=require('./observation-contract');
 function preserve(current,old){
  for(const key of ['ds','lq','gx']){const rows=current[key]||[],merged=unionRows(rows,old[key]);stats.hotRowsRecovered+=merged.length-rows.length;current[key]=merged;}
  for(const key of ['ct','bx','k10','path','vmint','vdec','vaults','vaultIdentityAt','archiveRefs'])if(current[key]==null&&old[key]!=null)current[key]=old[key];
  for(const key of ['hold','raw']){current[key]=current[key]||{};for(const [minute,value] of Object.entries(old[key]||{})){const existing=current[key][minute];if(!existing)current[key][minute]=value;else if(existing.at===value.at&&existing.slot===value.slot)current[key][minute]={...value,...existing};}}
  current.origs=current.origs||[];for(const prior of old.origs||[]){const found=current.origs.find(o=>o.p===prior.p&&o.t===prior.t);if(found)preserve(found,prior);else current.origs.push(prior);}
 }
 async function* rows(){let count=0;for(const row of readRows(file,null,{field:'coins'})){
  stats.contractRows++;const c=toLegacy(row),current=hot.get(c.a);for(const p of row.observations.pools)for(const kind of ['rawStates','trades'])if(p.archives?.[kind])stats.archiveReferences++;
  if(current&&current.p===c.p&&current.t===c.t)preserve(current,c);else{stats.coldRows++;yield c;}
  if(++count%32===0)await new Promise(r=>setImmediate(r));
 }}
 if(file){await store.stage(rows());fs.unlinkSync(file);}store.markSeeded(day,stats);return stats;
}
module.exports={seedDay,seedObservationDay,legacyCoin,unionRows};
