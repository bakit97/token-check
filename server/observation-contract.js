(function(root){
'use strict';
const META=new Set(['a','n','s','i','p','d','q','t','t0','tSrc','seen','disc','rcSeen','wsSeen','firstPostSeenAt','preCurve','preTradingAt','ty','mk','mst','mw','mT','mSig','mSeen','mCr','mH','mk0','ct','soc','tk','tkAt','lastTrade','live','legacy','createdAt','createdAtSource','uri','description','metadataAt','sol','b5','s5','top10','safeContract','img','cardAt','marketObservedAt']);
const day=t=>new Date(t+5*3600000).toISOString().slice(0,10);
function series(rows,kind){return (rows||[]).map(row=>kind==='vault'?{at:row[0]*1000,slot:row[1],balances:row.slice(2)}:{at:row[0]*1000,values:row.slice(1)})}
function poolRecord(c,mint){
 const archiveDay=day(c.t),raw=c.raw||{},tr=c.tr;
 return {address:c.p||null,marketAt:c.t,kind:c.d||null,quoteMint:c.q||null,movedAt:c.movedAt||null,
  ds:series(c.ds,'ds'),vaults:{addresses:c.vaults||null,mints:c.vmint||null,decimals:c.vdec||null,identityAt:c.vaultIdentityAt||null,samples:series(c.lq,'vault')},
  candles10:c.k10||null,holders10:c.hold?.['10']||null,holders:c.hold||{},rawStates:raw,
  curveSol:c.curveSol||null,tradeCoverage:c.bx||null,tradeFetches:(tr?.f||[]).map(f=>({at:f[0],count:f[1],marketMinAt:f[2]==null?null:f[2]*1000,marketMaxAt:f[3]==null?null:f[3]*1000})),tradeRows:tr?.x||null,tradeRowMarketTimeUnit:'unix-seconds',tradeRowReceiptTime:'fetch-coverage-only',
  activity:series(c.gx,'ds'),path:c.path||null,
  archives:c.archiveRefs?{...c.archiveRefs}:{rawStates:c.rawUp?'raw/'+archiveDay+'/'+mint+'-state.json':null,trades:c.trDone&&tr?.f?.length?'raw/'+archiveDay+'/'+mint+'-trades.json':null,verification:'legacy-reference-not-reconciled'}};
}
function project(c,{metadata={},admission=null}={}){
 const out={};for(const [key,value] of Object.entries(metadata))if(META.has(key))out[key]=value;
 out.a=c.a;out.schema=2;out.observations={schema:2,receiptTimeUnit:'unix-ms',seriesResolutionMs:1000,primaryPool:c.p||null,admission,
  migrationProof:c.mg?{status:c.mg.st,signature:c.mg.sig||null,pool:c.mg.pool||null,blockAt:c.mg.mT||null,instruction:c.mg.ix||null,creator:c.mg.creator??null,observedAt:c.mg.seenAt||null,reason:c.mg.why||null,
   family:c.mg.k||null,programOwner:c.mg.owner||null,watchCurve:c.mg.watch||null,verificationVersion:c.mg.v||null,stateObservedAt:c.mg.lastAt||c.mg.seenAt||null,sourceState:{...c.mg},previousState:c.mg0?{...c.mg0}:null}:null,
  pools:[poolRecord(c,c.a),...(c.origs||[]).map(o=>poolRecord(o,c.a))]};return out;
}
// Phone projection; complete histories remain in the daily schema-2 archive.
function projectSummary(c,options={}){
 const thin=p=>({...p,ds:(p.ds||[]).slice(-2),lq:(p.lq||[]).slice(-2),gx:(p.gx||[]).slice(-2),curveSol:(p.curveSol||[]).slice(-2),raw:{},tr:null,k10:null,path:null,origs:[]});
 const input={...thin(c),origs:(c.origs||[]).map(thin)},row=project(input,options);
 row.observations.readScope='latest-observations-only';return row;
}
function restorePool(p,cutoff){const valid=x=>Number.isFinite(x?.at)&&x.at<=cutoff;
 return {curveSol:(p.curveSol||[]).filter(r=>Number.isFinite(r[0])&&r[0]<=cutoff),p:p.address,t:p.marketAt,d:p.kind,q:p.quoteMint,movedAt:p.movedAt,archiveRefs:p.archives||null,rawUp:p.archives?.rawStates?1:0,trDone:p.archives?.trades?1:0,
  ds:(p.ds||[]).filter(valid).map(x=>[x.at/1000,...x.values]),lq:(p.vaults?.samples||[]).filter(valid).map(x=>[x.at/1000,x.slot,...x.balances]),
  vaults:p.vaults?.addresses,vmint:p.vaults?.mints,vdec:p.vaults?.decimals,vaultIdentityAt:p.vaults?.identityAt,
  k10:valid(p.candles10)?p.candles10:null,hold:Object.fromEntries(Object.entries(p.holders||{}).filter(([,x])=>valid(x))),
  raw:Object.fromEntries(Object.entries(p.rawStates||{}).filter(([,x])=>valid(x))),bx:valid(p.tradeCoverage)?p.tradeCoverage:null,
  gx:(p.activity||[]).filter(valid).map(x=>[x.at/1000,...x.values]),path:p.path&&p.path.at<=cutoff?p.path:null,
  tr:{f:(p.tradeFetches||[]).filter(valid).map(x=>[x.at,x.count,x.marketMinAt==null?null:x.marketMinAt/1000,x.marketMaxAt==null?null:x.marketMaxAt/1000]),x:(p.tradeFetches||[]).length>0&&(p.tradeFetches||[]).every(valid)?p.tradeRows||{}:{}}};
}
function toLegacy(row,cutoff=Infinity){if(row?.schema!==2||row.observations?.schema!==2)throw Error('Unsupported observation contract');
 const out={...row};const proof=row.observations.migrationProof;if(proof?.sourceState)out.mg={...proof.sourceState};if(proof?.previousState)out.mg0={...proof.previousState};delete out.observations;delete out.schema;const [current,...previous]=row.observations.pools.map(p=>restorePool(p,cutoff));
 Object.assign(out,current);if(out.ct&&(!Number.isFinite(out.ct.at)||out.ct.at>cutoff))out.ct=null;out.origs=previous;out.preObs=previous.find(p=>p.d==='pump-fun')||null;return out;
}
function chainDrain(row,cutoff=Infinity){
 const c=row?.observations?toLegacy(row,cutoff):row;if(!c||!Array.isArray(c.vmint)||c.vmint.length!==2||!c.vmint.includes(c.a))return null;
 const qi=c.vmint[0]===c.a?1:0;let max=0;
 for(const l of [...(c.lq||[])].sort((a,b)=>a[0]-b[0])){const at=l[0]*1000,q=l[2+qi];if(at>cutoff)continue;if(!Number.isFinite(q)||q<0)continue;
  if(q>max)max=q;else if(max>0&&q<max*.05)return {at,slot:l[1],quoteMint:c.vmint[qi],maximumObserved:max,remaining:q,ratio:q/max,source:'vault-balances'};
 }return null;
}
const api={project,projectSummary,toLegacy,chainDrain};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SolObservations=api;
})(typeof globalThis!=='undefined'?globalThis:this);
