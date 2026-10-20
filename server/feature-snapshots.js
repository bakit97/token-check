'use strict';
const z=require('node:zlib'),MIN=60000;
function unpack(value){return value?JSON.parse(z.inflateSync(Buffer.from(value,'base64'),{maxOutputLength:512*1024}).toString()):null;}
function pack(value){return z.deflateSync(Buffer.from(JSON.stringify(value)),{level:1}).toString('base64');}
function receivedOnly(coin,at){if(!coin)return {};const out={...coin};delete out.recoveryEvidence;delete out.outcomeTape;delete out.activityTapePacked;
 for(const key of ['path','k10'])if(!(coin[key]?.at<=at))delete out[key];
 out.origs=(coin.origs||[]).map(c=>receivedOnly(c,at));if(coin.preObs)out.preObs=receivedOnly(coin.preObs,at);return out;
}
function compute(coin,at,context,level='1'){const api=require('./research-v2'),input=receivedOnly(coin,at);return level==='2'?api.levelTwoFeaturesAt(input,at,{...context,entryAt:context.eventAt,acceptedAt:context.eventAt}):api.featuresAt(input,at,context);}
function read(coin,acceptedAt,minute,phase,level='1'){
 if(!Number.isInteger(minute)||minute<1||minute>20)throw RangeError('Snapshot minute must be 1..20');
 const saved=unpack(coin?.featureSnapshotsPacked);if(saved?.acceptedAt===acceptedAt&&saved.pool===coin?.p&&saved.snapshots?.[minute])return saved.snapshots[minute][level];
 return compute(coin,acceptedAt+minute*MIN,{eventAt:acceptedAt,phase},level);
}
function receiptTimes(coin,at){const last=(xs,time)=>xs.filter(x=>time(x)<=at).sort((a,b)=>time(a)-time(b)).at(-1),times={};
 const pools=[coin,...(coin.origs||[])].filter(p=>!coin.mg||coin.mg.st!=='ok'||p.p===coin.p),ds=last(pools.flatMap(p=>p.ds||[]),r=>r[0]*1000),gx=last(pools.flatMap(p=>p.gx||[]),r=>r[0]*1000),hold=last(Object.values(coin.hold||{}).filter(h=>!h.miss),h=>h.at),lq=last(coin.lq||[],r=>r[0]*1000);
 for(const k of ['mc','liq','volume','trades','tradesPerMin','buys','sells','buySellRatio','sellShare','averageTrade'])times[k]=ds?.[0]*1000;
 times.buyers=gx?gx[0]*1000:coin.bx?.at;times.buyers10=coin.bx?.at;times.uniqBuyersPerMin=times.buyers;
 for(const k of ['safeContract','mintRevoked','freezeRevoked','token2022','t22Safe'])times[k]=coin.ct?.at;times.metaImmutable=coin.ct?.metaMutAt;
 for(const k of ['holders','holderGrowth','top1','top10'])times[k]=hold?.at;
 for(const k of ['quoteSol','postPoolSol','poolGrowth','solTrend'])times[k]=lq?.[0]*1000;
 times.hasImage=coin.imageObservedAt??coin.metadataAt;times.hasDescription=coin.metadataAt;
 for(const k of ['hasTwitter','hasTelegram','hasWebsite'])times[k]=coin.socialFeatures?.at;
 for(const k of ['isFirstOfName','cloneCount','cloneRank'])times[k]=coin.discoveryFeatures?.at;
 const venue=require('./venue-identity').identity(coin,coin.mg?.k==='manual-pool'?'before':'after',at);times.launchpad=venue.venueObservedAt;times.dex=venue.venueObservedAt;
 times.lpBurned=coin.lpEvidence?.at;times.ageAtMigrationMin=coin.createdAtObservedAt;times.ageMin=coin.createdAtObservedAt;
 for(const snap of (coin.intelligenceSnapshots||[]).filter(x=>x.at<=at).sort((a,b)=>a.at-b.at))for(const k of Object.keys(snap.features||{}))times[k]=snap.at;
 return Object.fromEntries(Object.entries(times).filter(([,v])=>Number.isFinite(v)&&v<=at));
}
function capture(coin,row,now){const anchor=row.acceptedAt;let state=unpack(coin.featureSnapshotsPacked);if(state?.acceptedAt!==anchor||state.pool!==coin.p)state={schema:1,acceptedAt:anchor,pool:coin.p,phase:row.phase,snapshots:{},firstReceivedAt:{}};let changed=false;
 for(let m=1;m<=Math.min(20,Math.floor((now-anchor)/MIN));m++)if(!state.snapshots[m]){const at=anchor+m*MIN;state.snapshots[m]={at,capturedAt:now,receiptCutoff:at,receivedAt:receiptTimes(coin,at),'1':compute(coin,at,{eventAt:anchor,phase:row.phase},'1'),'2':compute(coin,at,{eventAt:anchor,phase:row.phase},'2')};state.firstReceivedAt=state.firstReceivedAt||{};for(const [key,value] of Object.entries({...state.snapshots[m]['1'],...state.snapshots[m]['2']})){const receipt=state.snapshots[m].receivedAt[key];if(value!=null&&Number.isFinite(receipt))state.firstReceivedAt[key]=Math.min(state.firstReceivedAt[key]??Infinity,receipt);}changed=true;}
 if(changed)coin.featureSnapshotsPacked=pack(state);return state;
}
function coverage(coins){const phases={};for(const coin of coins){const s=unpack(coin.featureSnapshotsPacked);if(!s)continue;const p=phases[s.phase]||(phases[s.phase]={coins:0,snapshots:{},arrival:{}});p.coins++;for(const [key,receipt] of Object.entries(s.firstReceivedAt||{})){const m=p.arrival[key]||(p.arrival[key]={samples:0,totalDelayMs:0,averageDelayMs:null});m.samples++;m.totalDelayMs+=Math.max(0,receipt-s.acceptedAt);m.averageDelayMs=m.totalDelayMs/m.samples;}for(const [minute,row] of Object.entries(s.snapshots)){const bin=p.snapshots[minute]||(p.snapshots[minute]={coins:0,features:{}});bin.coins++;for(const [key,value] of Object.entries({...row['1'],...row['2']})){if(['lowerBoundKeys','intelligenceEvidenceVersion'].includes(key))continue;const metric=bin.features[key]||(bin.features[key]={known:0,total:0,percent:0});metric.total++;if(value!==null&&value!==undefined&&(typeof value!=='number'||Number.isFinite(value)))metric.known++;metric.percent=metric.known/metric.total*100;}}}return {anchor:'acceptedAt',minutes:20,receiptTimeOnly:true,backfillIncluded:false,phases};}
module.exports={unpack,pack,read,compute,capture,coverage,receivedOnly,receiptTimes};
