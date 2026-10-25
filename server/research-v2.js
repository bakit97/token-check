'use strict';
// SOL·СКАН: deterministic analytics — no bought/sold assets, no signal execution.
// Features use ONLY information observed before the decision deadline.
// Outcomes are measured LATER; incomplete/missing coverage remains "pending".
const MIN=60_000, FIVE=5*MIN;
const KEYS=['buyers','trades','volume','liq','mc','buys','sells','buySellRatio'];
const CATEGORY_KEYS=['launchpad','dex'];
const LEVEL2_KEYS=['chg1m','chg3m','chg5m','fromPeak','drawdown','buyerAccel','volAccel','bigBuyShare','repeatBuys','avgBuy','sellShare1m','bigHolderSell','devSold','top10Drift','holderGrowth','poolGrowth','toMigration','ageMin','hourOfDay','solTrend','launchRate'];
const LEVEL1_KEYS=[...CATEGORY_KEYS,"ageAtMigrationMin","safeContract", "mintRevoked", "freezeRevoked", "metaImmutable", "token2022", "t22Safe", "lpBurned", "devBuySol", "devHoldPct", "devHold", "devSold", "devLaunches", "devRugShare", "sniperShare", "bundleShare", "bundledWallets", "top1", "top10", "holders", "holderGrowth", "buyers10", "buyers", "uniqBuyersPerMin", "botShare", "smartBuyers", "smartShare", "trades", "tradesPerMin", "buys", "sells", "buySellRatio", "sellShare", "averageTrade", "volume", "quoteSol", "postPoolSol", "poolGrowth", "mc", "hasImage", "hasDescription", "hasTwitter", "hasTelegram", "hasWebsite", "isFirstOfName", "cloneCount", "cloneRank"];
const RULE_KEYS=[...new Set([...KEYS,...LEVEL1_KEYS,...LEVEL2_KEYS])];
function validCondition(c){if(!c||!RULE_KEYS.includes(c.key))return false;if(CATEGORY_KEYS.includes(c.key))return c.op==='in'&&Array.isArray(c.values)&&c.values.length>0&&c.values.length<=32&&new Set(c.values).size===c.values.length&&c.values.every(v=>typeof v==='string'&&v.trim()===v&&/^[\p{L}\p{N} ._+()/-]{1,64}$/u.test(v));return ['>=','<=','between'].includes(c.op)&&Number.isFinite(c.value)&&c.value>=(LEVEL2_KEYS.includes(c.key)?-1e12:0)&&c.value<=1e12&&(c.op!=='between'||Number.isFinite(c.value2)&&c.value2>=c.value&&c.value2<=1e12);}
const inRange=(x,a,b)=>Number.isFinite(x)&&x>=a&&x<=b;
function marketPools(coin){
 const pools=[coin?.preObs,...(coin?.origs||[]),coin].filter(Boolean);
 // A graduated coin is measured on its new pool. Continued trading on its
 // old launch curve must not make an empty migration pool look alive.
 return coin?.p&&coin.mg?.st==='ok'&&coin.mg.pool===coin.p?pools.filter(p=>p.p===coin.p):pools;
}
function samples(coin) {
  const src=marketPools(coin);
  const obs=new Map();
  for(const c of src)for(const d of c.ds||[]){
    if(!Array.isArray(d))continue;
    const at=Number(d[0])*1000;
    if(!inRange(at,1,8e15))continue;
    if(!obs.has(at)||c===coin)obs.set(at,{
      at,price:+d[1]||null,liq:d[2]!=null?+d[2]:null,
      mc:d[3]!=null?+d[3]:null,buys:d[4]!=null?+d[4]:null,
      sells:d[5]!=null?+d[5]:null,volume:d[6]!=null?+d[6]:null
    });
  }
  return [...obs.values()].sort((a,b)=>a.at-b.at);
}
function candles(coin){
  const src=marketPools(coin);
  const map=new Map();
  for(const c of src)for(const group of [c.k10,c.path])for(const d of group?.c||[]){
    const at=+d[0]*1000,close=+d[4];
    if(inRange(at,1,8e15)&&close>0)map.set(at,close);
  }
  for(const d of samples(coin))if(d.price>0&&!map.has(d.at))map.set(d.at,d.price);
  return [...map.entries()].sort((a,b)=>a[0]-b[0]);
}
function latestBefore(list,t,maxAge,read) {
  let out=null;
  for(const x of list){const at=read(x);if(at>t)break;if(t-at<=maxAge)out=x}
  return out;
}
function featuresAt(coin,decisionAt,context={}){
  const d=latestBefore(samples(coin),decisionAt,7*MIN,x=>x.at);
  const gx=marketPools(coin).flatMap(p=>p.gx||[])
    .sort((a,b)=>a[0]-b[0]);
  const g=latestBefore(gx,decisionAt,7*MIN,x=>x[0]*1000);
  const bx=marketPools(coin).map(p=>p.bx)
    .filter(x=>x&&Number.isFinite(x.at)&&x.at<=decisionAt&&decisionAt-x.at<=7*MIN&&x.cov).sort((a,b)=>a.at-b.at).at(-1);
  const buys=d?.buys??null,sells=d?.sells??null;
  const ratio=buys!=null&&sells!=null?sells>0?buys/sells:buys:null;
  function finite(v){return typeof v==='number'&&Number.isFinite(v)?v:null}
  const F={buyers:finite(g?.[3]??bx?.payers??null),
    trades:finite(buys!=null&&sells!=null?buys+sells:null),
    volume:finite(d?.volume??null),liq:finite(d?.liq??null),
    mc:finite(d?.mc??null),buys:finite(buys),sells:finite(sells),
    buySellRatio:finite(ratio)};
  const ct=coin?.ct,metaAt=coin?.metadataAt,discovery=coin?.discoveryFeatures;
  const clone=discovery&&discovery.at<=decisionAt?{isFirstOfName:discovery.isFirstOfName,cloneCount:discovery.cloneCount,cloneRank:discovery.cloneRank,...(discovery.cloneCountLowerBound?{lowerBoundKeys:['cloneCount','cloneRank']}:{})}:{isFirstOfName:null,cloneCount:null,cloneRank:null};
  const extra=extendedFeaturesAt(coin,decisionAt,context,F);const migrationAt=coin?.mg?.mT??coin?.openingMetrics?.eventAt??context.eventAt;extra.ageAtMigrationMin=Number.isSafeInteger(coin?.createdAt)&&Number.isFinite(coin?.createdAtObservedAt)&&coin.createdAtObservedAt<=decisionAt&&Number.isSafeInteger(migrationAt)&&migrationAt>=coin.createdAt?(migrationAt-coin.createdAt)/MIN:null;
  const starter=starterFeaturesAt(coin,decisionAt,context);
  return {...Object.fromEntries(RULE_KEYS.map(k=>[k,null])),...extra,...F,...clone,...require('./venue-identity').features(coin,context.phase,decisionAt),...starter,lowerBoundKeys:[...new Set([...(extra.lowerBoundKeys||[]),...(clone.lowerBoundKeys||[]),...(starter.buyers10LowerBound?['buyers10']:[])])],
    token2022:ct&&ct.at<=decisionAt&&['token','token2022'].includes(ct.prog)?(ct.prog==='token2022'?1:0):null,
    hasImage:Number.isFinite(metaAt)&&metaAt<=decisionAt?(coin.img||coin.i?1:0):Number.isFinite(coin?.imageObservedAt)&&coin.imageObservedAt<=decisionAt&&(coin.img||coin.i)?1:null,
    hasDescription:Number.isFinite(metaAt)&&metaAt<=decisionAt?(coin.description?1:0):null,
    sellShare:buys!=null&&sells!=null&&buys+sells>0?sells/(buys+sells)*100:null,
    averageTrade:buys!=null&&sells!=null&&buys+sells>0&&F.volume!=null?F.volume/(buys+sells):null};
}
function legacyActivityOutcome(coin,entryAt,{hours=5,minActive=70,maxIdle=60,minCoverage=.8}={},now=Date.now()){
  if(!inRange(hours,1,24)||!inRange(minActive,0,100)||!inRange(maxIdle,5,1440))
    throw RangeError('Invalid level-one settings');
  const end=entryAt+hours*60*MIN;
  if(now<end+3*MIN)return {label:'pending',why:'observation-not-finished'};
  const history=samples(coin),blocks=hours*12;
  let seen=0,active=0,longest=0,current=0,missing=0,maxMissing=0;
  // DEX Screener: m5 is a ROLLING five-minute window, not a discrete trade tape.
  // Choose the closest observation to each bin-end (<=2.5 minutes either way).
  // Never reuse one snapshot for multiple bins or invent zero trades for gaps.
  const used=new Set();
  let nextIndex=0;
  for(let i=1;i<=blocks;i++){
    const T=entryAt+i*FIVE;
    while(nextIndex<history.length&&history[nextIndex].at<T-150000)nextIndex++;
    let d=null,bestDiff=Infinity;
    for(let j=nextIndex;j<history.length&&history[j].at<=T+150000;j++){
      const candidate=history[j],diff=Math.abs(candidate.at-T);
      if(!used.has(candidate.at)&&diff<bestDiff){d=candidate;bestDiff=diff}
    }
    if(!d||d.buys==null||d.sells==null||d.volume==null||
       d.buys<0||d.sells<0||d.volume<0){
      maxMissing=Math.max(maxMissing,++missing);current=0;continue;
    }
    used.add(d.at);
    missing=0;seen++;
    if(d.buys+d.sells>0&&d.volume>0){active++;current=0}
    else {current+=5;longest=Math.max(longest,current)}
  }
  const coverage=seen/blocks,activePct=active/blocks*100;
  if(coverage<minCoverage||maxMissing>2)
    return {label:'pending',why:'insufficient-activity-coverage',
      coverage,seen,blocks,maxMissing,activePct,maxIdleObserved:longest};
  const label=activePct>=minActive&&longest<=maxIdle?'live':'dead';
  return {label,coverage,activePct,maxIdleObserved:longest,seen,blocks};
}
function classifyActivity(m,cfg={}){
 if(m?.recoveryPending&&Number.isFinite(cfg.now)&&Number.isFinite(m.windowEnd)&&cfg.now>=m.windowEnd+3600000)m={...m,recoveryPending:false,recoveryWhy:'backfill-deadline-exceeded'};
 if(m?.recoveryPending&&Number.isFinite(cfg.now)&&Number.isFinite(m.windowEnd)&&cfg.now>=m.windowEnd+3600000)m={...m,recoveryPending:false,recoveryWhy:'backfill-deadline-exceeded'};
 if(cfg.activityRuleVersion===3){let evidence=m?.activitySlices||require('./activity-slices').unpack(m?.activitySlicesPacked);if(!evidence){let minutes=m?.minutes||[];try{if(!minutes.length&&m?.outcomePacked)minutes=JSON.parse(require('node:zlib').inflateSync(Buffer.from(m.outcomePacked,'base64'),{maxOutputLength:2000000}).toString())}catch{}evidence=require('./activity-slices').evidence({start:m?.windowStart??minutes[0]?.[0]-MIN,end:m?.windowEnd??minutes.at(-1)?.[0],minutes});}const result=require('./activity-slices').classify({...m,recoveryPending:false,activitySlices:evidence},cfg);if(m?.recoveryPending&&(result.label==='unknown'||!Number.isFinite(m.windowEnd)||!Number.isFinite(cfg.now)||cfg.now<m.windowEnd))return {label:'pending',why:'backfill-pending'};return result.label==='unknown'&&m?.recoveryWhy==='backfill-deadline-exceeded'?{...result,why:m.recoveryWhy}:result;}
 if(m?.recoveryPending)return {label:'pending',why:'backfill-pending'};
 if(!m||m.coverage<(cfg.minCoverage??.8)||m.maxGap>10)return {label:'unknown',why:m?.recoveryWhy||'collector-gap'};
 // Reclassify old completed rows from their original minute observations too.
 let minutes=m.minutes;try{if(!minutes&&m.outcomePacked)minutes=JSON.parse(require('node:zlib').inflateSync(Buffer.from(m.outcomePacked,'base64'),{maxOutputLength:2000000}).toString())}catch{return {label:'unknown',why:'collector-gap'}}
 const end=m.windowEnd??minutes?.at(-1)?.[0],hour=(minutes||[]).filter(r=>r.length>=4&&r[0]>end-60*MIN&&r[0]<=end),observed=hour.filter(r=>r[1]===1),active=observed.filter(r=>r[2]===1).length;
 let hourGap=0;for(const r of hour){hourGap=r[1]===1?0:hourGap+1;if(hourGap>10)return {label:'unknown',why:'collector-gap'};}
 if(hour.length&&!observed.length)return {label:'unknown',why:'collector-gap'};
 if(hour.length&&observed.length&&active===0&&observed.every(r=>r[2]===0))return {label:'dead',why:'last-hour-inactive'};
 // Activity minutes are an explicit fallback criterion, not an invented count
 // of trades or distinct wallets. Keep the original null metrics unchanged.
 const proxy=v=>v!=null?v:hour.length&&observed.length?active:null;
 const effective={...m,lastHourTrades:proxy(m.lastHourTrades),lastHourWallets:proxy(m.lastHourWallets),uniqueBuyers:m.uniqueBuyers??((minutes||[]).filter(r=>r[1]===1&&r[2]===1).length||null)};
 const tests=[['last-hour-trades',effective.lastHourTrades,cfg.lastHourTrades??1],['last-hour-wallets',effective.lastHourWallets,cfg.lastHourWallets??1],['price-retention',m.priceKeep,cfg.minPriceKeep??30],['unique-buyers',effective.uniqueBuyers,cfg.minUniqueBuyers??30]];
 if(cfg.useActivity)tests.push(['activity',m.activePct,cfg.minActive??70]);
 if(cfg.useIdle)tests.push(['idle',m.maxIdleObserved==null?null:-(m.maxIdleObserved),-(cfg.maxIdle??60)]);
 const failed=tests.find(([k,v,n])=>v!=null&&v<n&&!m.lowerBounds?.includes(k));if(failed)return {label:'dead',why:failed[0]};
 const missing=tests.find(([k,v,n])=>n>0&&(v==null||(m.lowerBounds?.includes(k)&&v<n)));return missing?{label:'dead',why:'insufficient-evidence-'+missing[0]}:{label:'live',why:null};
}
function extendedFeaturesAt(coin,t,context,F){
 const out={},ct=coin?.ct,known=ct?.at<=t&&ct.safetyVersion===1,bool=v=>typeof v==='boolean'?v?1:0:null;
 out.mintRevoked=known&&typeof ct.mint==='boolean'?ct.mint?0:1:null;out.freezeRevoked=known&&typeof ct.freeze==='boolean'?ct.freeze?0:1:null;
 const mutableAt=ct?.metaMutAt??(ct?.metaMutFromMint?ct.at:null);out.metaImmutable=known&&Number.isFinite(mutableAt)&&mutableAt<=t&&typeof ct.metaMut==='boolean'?ct.metaMut?0:1:null;
 out.t22Safe=known&&ct.prog==='token'?1:known&&ct.prog==='token2022'&&Array.isArray(ct.unknownExtensions)&&['hook','deleg','defFrozen','nontr','pause','feeAuthority'].every(k=>typeof ct[k]==='boolean')&&Number.isFinite(ct.fee)?ct.fee>0||ct.hook||ct.deleg||ct.defFrozen||ct.nontr||ct.pause||ct.feeAuthority||ct.unknownExtensions.length?0:1:null;
 const lp=coin?.lpEvidence;out.lpBurned=(context.phase==='after'||context.phase==='before'&&coin?.mg?.k==='manual-pool')&&lp?.pool===coin?.p&&lp?.verified===true&&lp.at<=t&&['burned','locked','unlocked'].includes(lp.state)?lp.state==='locked'&&!(lp.lockUntil>=t)?null:lp.state==='burned'||lp.state==='locked'?1:0:null;
 const holds=Object.values(coin?.hold||{}).filter(h=>h?.at<=t&&!h.miss&&Number.isInteger(h.holders)&&h.holdersComplete===true).sort((a,b)=>a.at-b.at),last=holds.at(-1),first=holds[0];out.holders=last?.holders??null;out.holderGrowth=first&&last.at>first.at?(last.holders-first.holders)/((last.at-first.at)/MIN):null;
 const eventAt=context.eventAt??coin?.t;out.tradesPerMin=Number.isFinite(eventAt)&&t-eventAt>=FIVE&&F.trades!=null?F.trades/5:null;out.uniqBuyersPerMin=Number.isFinite(eventAt)&&t-eventAt>=FIVE&&F.buyers!=null?F.buyers/5:null;
 if(Number.isFinite(eventAt)){const before=starterFeaturesAt(coin,eventAt,context),after=starterFeaturesAt(coin,t,context);out.poolGrowth=before.quoteSol>0&&after.quoteSol!=null?(after.quoteSol/before.quoteSol-1)*100:null;}
 const socials=coin?.socialFeatures;if(socials?.at<=t)for(const k of ['hasTwitter','hasTelegram','hasWebsite'])out[k]=bool(socials[k]);
 for(const snapshot of [...(coin?.intelligenceSnapshots||[])].filter(s=>s.at<=t).sort((a,b)=>a.at-b.at)){for(const [k,v] of Object.entries(snapshot.features||{}))if(RULE_KEYS.includes(k)&&typeof v==='number'&&Number.isFinite(v)){if(['smartBuyers','smartShare'].includes(k)&&(snapshot.evidenceVersion!==2||snapshot.smartRegistryReady!==true))continue;if(snapshot.evidenceVersion!==2&&v===0&&['devBuySol','devHold','devHoldPct','bundleShare','bundledWallets'].includes(k))continue;if(k==='devBuySol'&&coin.q&&coin.q!=='So11111111111111111111111111111111111111112')continue;out[k]=v;out.lowerBoundKeys=(out.lowerBoundKeys||[]).filter(x=>x!==k);if(snapshot.lowerBoundKeys?.includes(k))out.lowerBoundKeys.push(k);}}
 out.intelligenceEvidenceVersion=2;return out;
}
function activityOutcome(coin,entryAt,cfg={},now=Date.now()){
 if(cfg.outcomeVersion!==2)return legacyActivityOutcome(coin,entryAt,cfg,now);
 const end=entryAt+(cfg.hours??5)*60*MIN;
 if(now<end+3*MIN)return {label:'pending',why:'not-yet-finished'};
 const raw=activityEvidence(coin,entryAt,end,cfg.decisionMinutes??10),result=classifyActivity(raw,cfg);
 return {...raw,...result,outcomeVersion:2};
}
function activityEvidence(coin,start,end,decisionMinutes){
 const history=samples(coin).filter(x=>x.at>=start&&x.at<=end),tail=coin?.outcomeTape?.windowStart===start&&coin?.outcomeTape?.windowEnd===end?coin.outcomeTape:null,pools=marketPools(coin);
 const bins=Math.ceil((end-start)/MIN),minutes=Array.from({length:bins},(_,i)=>[start+(i+1)*MIN,null,null,null]);
 // A rolling m5 snapshot proves the preceding interval was observed. Never
 // multiply its transaction count by five or treat a missing pair as zero.
 for(const d of history)if(d.buys!=null&&d.sells!=null&&d.buys>=0&&d.sells>=0){for(let i=Math.max(0,Math.floor((d.at-start)/MIN)-5);i<Math.min(bins,Math.ceil((d.at-start)/MIN));i++){minutes[i][1]=1;if(d.buys+d.sells===0)minutes[i][2]=0;/* Nonzero rolling m5 does not identify which minute traded. */} }
 // Successful vault observations are collector coverage, not proof of trades.
 // Missing activity remains unknown unless a successful market sample exists.
 const tape=new Map();for(const p of pools)for(const [id,x] of Object.entries(p.tr?.x||{}))if(x[0]*1000>=start&&x[0]*1000<=end)tape.set(id,x);
 const buyers=new Set(),lastWallets=new Set();let lastTrades=0;
 for(const x of tape.values()){const at=x[0]*1000,i=Math.min(bins-1,Math.floor((at-start)/MIN));if(i>=0){minutes[i][1]=1;minutes[i][2]=1;}const wallet=x[3];if(x[1]&&typeof wallet==='string'&&wallet.length>=32)buyers.add(wallet);if(at>=end-60*MIN){lastTrades++;if(typeof wallet==='string'&&wallet.length>=32)lastWallets.add(wallet)}}
 // Full trade coverage must cover the entire requested interval. An early
 // ten-minute fetch cannot establish five-hour unique-wallet totals.
 const tapeCovered=pools.some(p=>p.tradeWindow?.start<=start&&p.tradeWindow?.end>=end&&p.tradeWindow?.complete===true);
 if(tail?.complete)for(const r of minutes){r[1]=1;if(r[2]==null)r[2]=0;}
 for(const row of tail?.minutes||[]){const i=Math.floor((row[0]-start)/MIN);if(minutes[i]){minutes[i][2]=row[1]>0?1:0;if(row[2]>0)minutes[i][3]=row[2];}}
 let seen=0,active=0,gap=0,maxGap=0,idle=0,maxIdleObserved=0;
 for(const r of minutes){if(r[1]){seen++;gap=0;if(r[2]===1){active++;idle=0}else if(r[2]===0){idle++;maxIdleObserved=Math.max(maxIdleObserved,idle)}else idle=0}else{maxGap=Math.max(maxGap,++gap);idle=0}}
 for(const r of require('./activity-slices').unpack(coin?.activityTapePacked)?.minuteActivity||[]){const i=Math.round((r[0]-start)/MIN)-1;if(i>=0&&i<minutes.length){minutes[i][1]=1;minutes[i][2]=minutes[i][2]===1?1:r[2];}}
 const recovered=require('./observation-recovery').applyMinutes(minutes,coin?.recoveryEvidence||[]);for(let i=0;i<minutes.length;i++)minutes[i]=recovered[i];({seen,active,maxGap,maxIdleObserved}=(()=>{const x=require('./observation-recovery').minuteStats(minutes);return {...x,seen:Math.round(x.coverage*bins),active:Math.round((x.activePct||0)*bins/100)};})());
 const priceAt=t=>latestBefore(history,t,7*MIN,x=>x.at)?.price??latestBefore(candles(coin),t,7*MIN,x=>x[0])?.[1]??null;
 for(const r of minutes)r[3]=r[3]??priceAt(r[0]);
 const p0=priceAt(start+decisionMinutes*MIN),pe=priceAt(end);
 let recent=history.filter(x=>x.at>end-60*MIN);let rolling=0,rollingSeen=0;for(let t=end;t>end-60*MIN;t-=FIVE){const d=latestBefore(recent,t,2*MIN,x=>x.at);if(d&&d.at>=t-2*MIN&&d.buys!=null&&d.sells!=null){rolling+=d.buys+d.sells;rollingSeen++}}
 // Zero trades in all twelve non-overlapping rolling windows is conclusive.
 const hourTrades=tapeCovered?lastTrades:rollingSeen===12?rolling:null;
 const swaps=[...tape.values(),...(tail?.trades||[])],completeWindows=[...(tail?.complete?[{start,end,complete:true}]:[]),...(coin?.activityTape?.windows||[])];
 for(const e of coin?.recoveryEvidence||[]){swaps.push(...(e.trades||[]));if(e.tradeWindow)completeWindows.push(e.tradeWindow);}
 const activityAPI=require('./activity-slices'),activitySlices=activityAPI.merge(activityAPI.unpack(coin?.activityTapePacked),activityAPI.evidence({start,end,minutes,trades:swaps,completeWindows}));
 const walletMetrics=activityAPI.buyerMetrics(activitySlices),tapeBuyersComplete=tapeCovered&&[...tape.values()].filter(r=>r[1]).every(r=>typeof r[3]==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r[3])),tailBuyersComplete=tail?.complete&&tail.uniqueBuyers!=null&&!tail.lowerBounds?.includes('unique-buyers'),uniqueBuyersComplete=walletMetrics.uniqueBuyersComplete||tapeBuyersComplete||tailBuyersComplete,knownBuyerCounts=[walletMetrics.uniqueBuyers,tail?.uniqueBuyers,...(buyers.size||tapeBuyersComplete?[buyers.size]:[])].filter(v=>Number.isInteger(v)&&v>=0),uniqueBuyers=knownBuyerCounts.length?Math.max(...knownBuyerCounts):null,lowerBounds=[...new Set([...(tail?.lowerBounds||[]).filter(k=>k!=='unique-buyers'),...(!uniqueBuyersComplete?['unique-buyers']:[])])];
 return {activitySlices,coverage:seen/bins,maxGap,activePct:seen?active/bins*100:null,maxIdleObserved:seen?maxIdleObserved:null,lastHourTrades:tail?.lastHourTrades??hourTrades,lastHourWallets:tail?.lastHourWallets??(tapeCovered?lastWallets.size:hourTrades===0?0:null),uniqueBuyers,uniqueBuyersComplete,lowerBounds,priceKeep:p0>0&&pe!=null?pe/p0*100:null,priceAtDecision:p0,priceAtEnd:pe,minutes,windowStart:start,windowEnd:end,tradeCoverage:tapeCovered};
}
function tradeOutcomeEvidence(rows,start,end,at){
 const clean=rows.filter(r=>Array.isArray(r)&&Number.isFinite(r[0])),oldest=Math.min(...clean.map(r=>r[0]*1000)),complete=clean.length>0&&((at-start<=24*60*MIN&&rows.length<300)||oldest<=start),tailComplete=(at-(end-60*MIN)<=24*60*MIN&&rows.length<300)||oldest<=end-60*MIN;
 const buyers=new Set(),wallets=new Set(),minute=new Map();let trades=0;
 for(const r of clean){const t=r[0]*1000;if(t<start||t>end)continue;const wallet=typeof r[3]==='string'&&r[3].length>=32?r[3]:null;if(r[1]&&wallet)buyers.add(wallet);if(t>=end-60*MIN){trades++;if(wallet)wallets.add(wallet);}const m=Math.floor(t/MIN)*MIN,old=minute.get(m)||[m,0,null];old[1]++;if(r[4]>0)old[2]=r[4];minute.set(m,old);}
 const identities=clean.every(r=>typeof r[3]==='string'&&r[3].length>=32);
 return {at,windowStart:start,windowEnd:end,complete,trades:clean,minutes:[...minute.values()].sort((a,b)=>a[0]-b[0]),lastHourTrades:trades,lastHourWallets:identities?wallets.size:null,uniqueBuyers:identities?buyers.size:null,lowerBounds:[...(!tailComplete?['last-hour-trades','last-hour-wallets']:[]),...(!complete?['unique-buyers']:[])]};
}
function strengthOutcome(coin,zeroAt,{minAbove=70,minCoverage=.9,minAboveMarginPct=10,hours=5}={},now=Date.now()){
  if(!inRange(minAbove,0,100)||!inRange(minAboveMarginPct,0,100)||!Number.isInteger(hours)||hours<1||hours>12)throw RangeError('Invalid level-two settings');
  const total=hours*60,end=zeroAt+total*MIN;
  if(now<end+MIN)return {label:'pending',why:'observation-window-not-finished'};
  const recovered=(coin?.recoveryEvidence||[]).flatMap(e=>(e.candles||[]).filter(b=>b.price>0).map(b=>[b.end,b.price]));const path=[...new Map([...recovered,...candles(coin)].map(p=>[p[0],p])).values()].sort((a,b)=>a[0]-b[0]);
  const p0=latestBefore(path,zeroAt,7*MIN,x=>x[0])?.[1];
  if(!(p0>0))return {label:'pending',why:'no-price-at-zero'};
  let covered=0,above=0,maxGap=0,gap=0;
  const curve=[],minuteCurve=[];
  for(let m=1;m<=total;m++){
    const x=latestBefore(path,zeroAt+m*MIN,7*MIN,y=>y[0]);
    if(!x){
      gap++;maxGap=Math.max(maxGap,gap);
      minuteCurve.push(null);continue;
    }
    gap=0;covered++;
    const rawPct=100*(x[1]/p0-1);if(rawPct+1e-9>=minAboveMarginPct)above++;
    // Minute rows use the latest observed price at or before that minute;
    // stale observations older than seven minutes are always missing.
    const pct=Math.round(100000*(x[1]/p0-1))/1000;
    minuteCurve.push(rawPct);
    if(m%5===0)curve.push([m,pct]);
  }
  // 70% is 210 minutes OF ALL 300, not of the observed subset.
  if(covered<total*minCoverage||maxGap>10)
    return {label:'pending',why:'insufficient-price-coverage',covered,maxGap};
  return {label:above/total*100>=minAbove?'strong':'weak',
    above,covered,pctAbove:above/total*100,p0,curve,minuteCurve};
}
// Starter rules use confirmed account rights and native on-chain balances, never USD proxies.
function recordedBuyerProof(coin,decisionAt,start){const wallets=new Map(),proofs=[],end=Math.min(start+10*MIN,decisionAt);
 for(const pool of marketPools(coin)){for(const prefix of pool.buyerPrefixes||[])if(prefix[1]===start&&prefix[0]<=decisionAt&&Number.isInteger(prefix[2])&&prefix[2]>0)proofs.push({n:prefix[2],at:prefix[0],source:'recorded-pool-wallet-prefix'});for(const row of Object.values(pool.tr?.x||{})){const at=row[0]*1000,receivedAt=row[8]??row[6],wallet=row[3];if(row[1]!==1||at<start||at>end||!Number.isFinite(receivedAt)||receivedAt>decisionAt||typeof wallet!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet))continue;if(wallets.has(wallet)||wallets.size<5000)wallets.set(wallet,Math.min(wallets.get(wallet)??Infinity,receivedAt));}}
 if(wallets.size)proofs.push({n:wallets.size,at:Math.max(...wallets.values()),source:'recorded-pool-wallet-prefix'});
 for(const snapshot of coin?.intelligenceSnapshots||[])if(snapshot.at<=decisionAt&&snapshot.buyerWindowStart===start&&Number.isInteger(snapshot.features?.buyers10)&&snapshot.features.buyers10>0)proofs.push({n:snapshot.features.buyers10,at:snapshot.at,source:'recorded-pool-wallet-snapshot'});
 return proofs.sort((a,b)=>b.n-a.n||a.at-b.at)[0]||null;
}
function recordedBuyerPrefixes(coin,start,now){const bins=new Map();const add=r=>{if(r[1]!==start||!Number.isFinite(r[0])||r[0]>now||r[0]>start+20*MIN||!Number.isInteger(r[2])||r[2]<=0)return;const key=Math.floor((r[0]-start)/MIN),old=bins.get(key);if(!old||r[2]>old[2]||r[2]===old[2]&&r[0]<old[0])bins.set(key,r);};for(const r of coin.buyerPrefixes||[])add(r);for(let m=1;m<=20;m++){const proof=recordedBuyerProof(coin,Math.min(now,start+m*MIN),start);if(proof)add([proof.at,start,proof.n]);}return [...bins.values()].sort((a,b)=>a[0]-b[0]).slice(-21);}
function starterFeaturesAt(coin,decisionAt,context={}){
 const WSOL='So11111111111111111111111111111111111111112',ct=coin?.ct;
 let safeContract=null,quoteSol=null,buyers10=null;
 if(ct&&ct.safetyVersion===1&&Array.isArray(ct.unknownExtensions)&&Number.isFinite(ct.at)&&ct.at<=decisionAt&&['token','token2022'].includes(ct.prog)){
  const flags=['mint','freeze','hook','deleg','nontr','defFrozen','pause','feeAuthority'];
  if(flags.every(k=>typeof ct[k]==='boolean')&&Number.isFinite(ct.fee))safeContract=flags.some(k=>ct[k])||ct.fee>0||ct.unknownExtensions.length>0?0:1;
 }
 let lower=false,buyerAt=null,buyerSource=null;
 if(context.withoutBuyers!==true){
 const eventAt=Number.isFinite(context.eventAt)?context.eventAt:coin.t,endAt=eventAt+10*MIN;
 // Every observation must belong to the mint's original ten-minute window.
 // Early migration may add a new pool inside that window; overlapping pools
 // yield a MAXIMUM lower bound, never a sum of potentially identical buyers.
 const pools=marketPools(coin).filter((p,i,all)=>p&&Number.isFinite(p.t)&&p.t<=endAt&&all.findIndex(x=>x&&x.p===p.p&&x.t===p.t)===i);
 const pool=pools.find(p=>p.t===eventAt),bx=pool?.bx;
 if(pools.length===1&&bx?.cov===true&&Number.isFinite(bx.at)&&bx.at<=decisionAt&&bx.at>=pool.t+10*MIN+5000&&Number.isFinite(bx.payers)&&decisionAt-bx.at<=7*MIN)buyers10=bx.payers;
 if(buyers10==null){
  const recorded=recordedBuyerProof(coin,decisionAt,eventAt),proofs=recorded?[recorded]:[];
  for(const p of pools){
   for(const g of p.gx||[]){const at=g[0]*1000;if(at<p.t||at>endAt||at>decisionAt||at<eventAt)continue;
    if(p.t<eventAt&&at-5*MIN<eventAt)continue;
    const n=p.t>=eventAt&&Number.isFinite(g[7])?g[7]:g[3];if(Number.isInteger(n)&&n>=0)proofs.push({n,at,source:'gt-unique-buyers-prefix'});}
   const b=p.bx;if(p.t===eventAt&&b&&Number.isFinite(b.at)&&b.at<=decisionAt&&b.at>=endAt&&Number.isInteger(b.payers)&&b.payers>=0&&b.n>=b.payers&&b.buys>=b.payers)proofs.push({n:b.payers,at:b.at,source:'recorded-first-ten-minute-trades'});
  }
  const best=proofs.sort((a,b)=>b.n-a.n||a.at-b.at)[0];if(best){buyers10=best.n;lower=true;buyerAt=best.at;buyerSource=best.source;}
 }
 }
 const qi=coin?.vmint?.indexOf(WSOL);
 if(qi>=0&&coin.vmint.length===2&&coin.vmint[1-qi]===coin.a&&Number.isFinite(coin.vaultIdentityAt)&&coin.vaultIdentityAt<=decisionAt){
  const row=latestBefore([...(coin.lq||[])].sort((a,b)=>a[0]-b[0]),decisionAt,7*MIN,x=>x[0]*1000);
  if(row&&Number.isFinite(row[2+qi])&&row[2+qi]>=0)quoteSol=row[2+qi]/1e9;
 }
 const opening=coin?.openingMetrics;if(quoteSol==null&&coin?.mg?.st==='ok'&&coin.mg.pool===coin.p&&opening?.pool===coin.p&&opening.quoteMint===WSOL&&opening.at<=decisionAt&&decisionAt-opening.at<=7*MIN&&Number.isFinite(opening.liquiditySol)&&opening.liquiditySol>=0)quoteSol=opening.liquiditySol;
 // До миграции: SOL в кривой pump (real_sol_reserves), замер не старше 7 мин и не позже момента решения.
 if(quoteSol==null&&coin?.mg?.st!=='ok'&&/pump-?fun/i.test(coin?.d||'')&&Array.isArray(coin?.curveSol)&&(!coin.q||coin.q===WSOL)){
  let best=null;for(const r of coin.curveSol)if(Array.isArray(r)&&r[0]<=decisionAt&&decisionAt-r[0]<=7*MIN&&Number.isFinite(r[1])&&r[1]>=0&&(!best||r[0]>best[0]))best=r;
  if(best)quoteSol=best[1]/1e9;
 }
 // Концентрация у крупнейших держателей (без хранилищ пула) — снимок не позже момента решения.
 let top1=null,top10=null;
 for(const [,h] of Object.entries(coin?.hold||{}))if(h&&!h.miss&&Number.isFinite(h.at)&&h.at<=decisionAt&&Number.isFinite(h.top10)&&h.top10>0&&(!top10||h.at>top10.at))top10={at:h.at,v:h.top10*100,v1:Number.isFinite(h.top1)?h.top1*100:null};
 if(top10){top1=top10.v1;top10=top10.v}
 return {safeContract,quoteSol,postPoolSol:coin?.mg?.st==='ok'?quoteSol:null,buyers10,top1,top10,...(lower?{buyers10LowerBound:true,buyers10At:buyerAt,buyers10Source:buyerSource}:{})};
}
function levelTwoFeaturesAt(coin,decisionAt,{entryAt,acceptedAt,phase}={}){
 const out=Object.fromEntries(LEVEL2_KEYS.map(k=>[k,null]));
 const history=samples(coin).filter(x=>x.at<=decisionAt),prices=history.filter(x=>x.price>0);
 const point=t=>latestBefore(prices,t,2*MIN,x=>x.at),last=point(decisionAt);
 for(const minutes of [1,3,5]){const prior=point(decisionAt-minutes*MIN);if(last&&prior)out['chg'+minutes+'m']=(last.price/prior.price-1)*100}
 const segment=prices.filter(x=>x.at>=entryAt);if(segment.length&&last){let peak=segment[0].price,worst=0;for(const x of segment){peak=Math.max(peak,x.price);worst=Math.max(worst,(peak-x.price)/peak*100)}out.fromPeak=(last.price/peak-1)*100;out.drawdown=worst}
 const volumes=t=>latestBefore(history,t,2*MIN,x=>x.at),v0=volumes(decisionAt-5*MIN),v1=volumes(decisionAt);
 if(v0&&v1&&v0.at-5*MIN>=entryAt&&v0.volume>0&&v1.volume!=null)out.volAccel=(v1.volume/v0.volume-1)*100;
 const gx=[...(coin.gx||[])].filter(x=>x[0]*1000<=decisionAt).sort((a,b)=>a[0]-b[0]);
 const g0=latestBefore(gx,decisionAt-5*MIN,2*MIN,x=>x[0]*1000),g1=latestBefore(gx,decisionAt,2*MIN,x=>x[0]*1000);
 if(g0&&g1&&g0[0]*1000-5*MIN>=entryAt&&g0[3]>0&&Number.isFinite(g1[3]))out.buyerAccel=(g1[3]/g0[3]-1)*100;
 const pool0=starterFeaturesAt(coin,entryAt,{eventAt:acceptedAt,phase}),pool1=starterFeaturesAt(coin,decisionAt,{eventAt:acceptedAt,phase});
 if(pool0.quoteSol>0&&pool1.quoteSol!=null)out.poolGrowth=(pool1.quoteSol/pool0.quoteSol-1)*100;
 if(pool0.top10!=null&&pool1.top10!=null)out.top10Drift=pool1.top10-pool0.top10;
 if(Number.isSafeInteger(coin.createdAt)&&coin.createdAt<=decisionAt&&Number.isFinite(coin.createdAtObservedAt)&&coin.createdAtObservedAt<=decisionAt)out.ageMin=(decisionAt-coin.createdAt)/MIN;
 if(Number.isSafeInteger(entryAt))out.hourOfDay=new Date(entryAt+5*3600000).getUTCHours();
 // Trade rows lack individual receipt times and full wallet identities. Do not
 // infer bot/repeat/developer sales or one-minute flow from rolling m5 counts.
 return {...featuresAt(coin,decisionAt,{eventAt:acceptedAt,phase}),...Object.fromEntries(Object.entries(out).filter(([,v])=>v!=null))};
}
const INTEL_ZERO_KEYS=new Set(['devBuySol','devHold','devHoldPct','bundleShare','bundledWallets']);
function verifiedFeatures(F={}){if(F.top10===0)F={...F,top10:null};if(F.intelligenceEvidenceVersion===2)return F;const out={...F};for(const k of ['smartBuyers','smartShare'])if(k in out)out[k]=null;for(const k of INTEL_ZERO_KEYS)if(out[k]===0)out[k]=null;return out;}
function evaluation(F,rule){
  if(rule?.conds){if(!Array.isArray(rule.conds)||!rule.conds.length||rule.conds.length>8)return 'unknown';const results=rule.conds.map(c=>evaluation(F,{key:c?.key,op:c?.op,value:c?.value,value2:c?.value2,values:c?.values}));return results.includes('reject')?'reject':results.includes('unknown')?'unknown':'pass'}
  if(!F||!validCondition(rule))return 'unknown';
  if(rule.conditions){if(!Array.isArray(rule.conditions)||rule.conditions.length>8)return 'unknown';const results=rule.conditions.map(c=>evaluation(F,c));
    if(results.includes('reject'))return 'reject';if(results.includes('unknown'))return 'unknown';}
  if(CATEGORY_KEYS.includes(rule.key)){const v=F[rule.key];return typeof v==='string'?(rule.values.includes(v)?'pass':'reject'):'unknown';}
  if(F.intelligenceEvidenceVersion!==2&&(['smartBuyers','smartShare'].includes(rule.key)||F[rule.key]===0&&INTEL_ZERO_KEYS.has(rule.key)))return 'unknown';
  const v=F[rule.key];
  if(typeof v!=='number'||!Number.isFinite(v))return 'unknown';
  if(F.lowerBoundKeys?.includes(rule.key)){if(rule.op==='>=')return v>=rule.value?'pass':'unknown';if(rule.op==='<=')return v>rule.value?'reject':'unknown';if(rule.op==='between')return v>rule.value2?'reject':'unknown';}
  if(rule.op==='between'){if(rule.key==='buyers10'&&F.buyers10LowerBound===true)return v>rule.value2?'reject':'unknown';return v>=rule.value&&v<=rule.value2?'pass':'reject';}
  if(rule.key==='buyers10'&&F.buyers10LowerBound===true)return rule.op==='>='?(v>=rule.value?'pass':'unknown'):(v>rule.value?'reject':'unknown');
  return rule.op==='>='?(v>=rule.value?'pass':'reject'):(v<=rule.value?'pass':'reject');
}
function passes(F,rule){return evaluation(F,rule)==='pass'}
function ruleKey(r){if(r.op==='in')return [r.key,'in',JSON.stringify([...(r.values||[])].sort())].join('|');return [r.key,r.op,Number(r.value).toPrecision(8),...(r.op==='between'?[Number(r.value2).toPrecision(8)]:[])].join('|')}
function wilsonInterval(k,n,z=1.959963984540054){if(!Number.isFinite(k)||!Number.isFinite(n)||n<=0||k<0||k>n)return {low:null,high:null};const p=k/n,q=z*z/n,center=(p+q/2)/(1+q),half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/(1+q);return {low:Math.max(0,center-half),high:Math.min(1,center+half)};}
function weightedScore(stats,penalty=3){const yes=wilsonInterval(stats.passedPositive,stats.totalPositive),no=wilsonInterval(stats.falsePositive,stats.totalNegative);return (yes.low*stats.totalPositive-penalty*no.high*stats.totalNegative)/(stats.totalPositive+penalty*stats.totalNegative);}
function ruleStats(rows,rule,positive,negative){
  const yes=rows.filter(r=>r.label===positive);
  const no=rows.filter(r=>r.label===negative);
  const y=yes.map(r=>evaluation(r.features,rule));
  const n=no.map(r=>evaluation(r.features,rule));
  const pass=y.filter(x=>x==='pass').length;
  const reject=n.filter(x=>x==='reject').length;
  const missingPositive=y.filter(x=>x==='unknown').length;
  const missingNegative=n.filter(x=>x==='unknown').length;
  const positiveCI=wilsonInterval(pass,yes.length),negativeCI=wilsonInterval(n.filter(x=>x==='pass').length,no.length),rejectionCI=wilsonInterval(reject,no.length);
  return {positiveRecallLower95:positiveCI.low,positiveRecallUpper95:positiveCI.high,negativePassLower95:negativeCI.low,negativePassUpper95:negativeCI.high,negativeRejectionLower95:rejectionCI.low,negativeRejectionUpper95:rejectionCI.high,confidenceMethod:'wilson-95',passedPositive:pass,totalPositive:yes.length,rejectedNegative:reject,
    totalNegative:no.length,positiveRecall:yes.length?pass/yes.length:null,
    negativeRejection:no.length?reject/no.length:null,
    // Unknown ≠ correctly rejected; denominators reflect ALL labeled coins.
    missingPositive,missingNegative,unknown:missingPositive+missingNegative,
    falsePositive:n.filter(x=>x==='pass').length,
    evaluablePositive:yes.length-missingPositive,
    evaluableNegative:no.length-missingNegative};
}
/** Train on the existing labeled observations only. Independently validate on
 *  later, unseen events; never feed future outcomes into early-time features. */
function proposeRules(rows,{positive='live',negative='dead',minPos=100,minNeg=20,maxRules=12,missPenalty=3,metrics={}}={}){
 if(!Number.isFinite(missPenalty)||missPenalty<1||missPenalty>5)throw RangeError('Invalid miss penalty');const pos=rows.filter(r=>r.label===positive),neg=rows.filter(r=>r.label===negative);metrics.rulesTried=0;if(pos.length<Math.max(20,minPos)||neg.length<Math.max(20,minNeg))return [];
 const seen=new Set(),leaves=[],out=[],rank=(a,b)=>b.score-a.score||(a.rule.conds?.length||1)-(b.rule.conds?.length||1)||b.train.positiveRecall-a.train.positiveRecall;
 const assess=rule=>{const sig=(rule.conds||[rule]).map(ruleKey).sort().join('&');if(seen.has(sig))return null;seen.add(sig);metrics.rulesTried++;const train=ruleStats(rows,rule,positive,negative);if(train.evaluablePositive<20||train.evaluableNegative<20||train.evaluablePositive/pos.length<.85||train.evaluableNegative/neg.length<.85||train.positiveRecall<.55)return null;return {rule,train,score:weightedScore(train,missPenalty)};};
 for(const key of CATEGORY_KEYS){const counts=new Map();for(const r of rows){const v=r.features?.[key];if(typeof v!=='string'||!validCondition({key,op:'in',values:[v]}))continue;const g=counts.get(v)||{positive:0,total:0};g.total++;if(r.label===positive)g.positive++;counts.set(v,g);}const ordered=[...counts].sort((a,b)=>b[1].positive/b[1].total-a[1].positive/a[1].total||a[0].localeCompare(b[0])).slice(0,32).map(x=>x[0]);const selections=ordered.map(v=>[v]);for(let i=2;i<=Math.min(8,ordered.length);i++)selections.push(ordered.slice(0,i));for(const values of selections){const item=assess({key,op:'in',values:values.sort()});if(item&&item.train.negativeRejection>=.05){leaves.push(item);if(item.train.negativeRejection>=.5)out.push(item);}}}
 for(const key of RULE_KEYS){const vals=rows.map(r=>r.features?.[key]).filter(v=>typeof v==='number'&&Number.isFinite(v)).sort((a,b)=>a-b);if(vals.length<Math.max(40,rows.length*.4))continue;for(let i=1;i<50;i++){const value=+vals[Math.floor((vals.length-1)*i/50)].toPrecision(8);for(const op of ['>=','<=']){const item=assess({key,op,value});if(item&&item.train.negativeRejection>=.05){leaves.push(item);if(item.train.negativeRejection>=.5)out.push(item);}}}
 const bounds=[...new Set(Array.from({length:21},(_,i)=>vals[Math.floor((vals.length-1)*i/20)]))];for(let i=0;i<bounds.length;i++)for(let j=i+1;j<bounds.length;j++){const item=assess({key,op:'between',value:bounds[i],value2:bounds[j]});if(item&&item.train.negativeRejection>=.05){leaves.push(item);if(item.train.negativeRejection>=.5)out.push(item);}}}
 leaves.sort(rank);const diverse=[],perKey=new Map();for(const l of leaves){const k=l.rule.key+'|'+l.rule.op;if((perKey.get(k)||0)>=2)continue;diverse.push(l);perKey.set(k,(perKey.get(k)||0)+1);if(diverse.length>=48)break;}let beam=diverse.slice(0,24);
 for(let depth=2;depth<=3;depth++){const next=[];for(const parent of beam)for(const leaf of diverse){const conds=[...(parent.rule.conds||[parent.rule]),leaf.rule];if(new Set(conds.map(c=>c.key)).size!==conds.length)continue;conds.sort((a,b)=>ruleKey(a).localeCompare(ruleKey(b)));const item=assess({...conds[0],conditions:conds.slice(1),conds});if(!item||item.score<=parent.score+1e-9)continue;if(item.train.positiveRecall>=parent.train.positiveRecall-1e-9&&item.train.negativeRejection-parent.train.negativeRejection>=.05-1e-9)item.improvementOf=JSON.stringify(parent.rule.conds||[parent.rule]);next.push(item);if(item.train.negativeRejection>=.5)out.push(item);}next.sort(rank);beam=next.slice(0,24);}
 out.sort(rank);const unique=[];for(const item of out){const cs=item.rule.conds||[item.rule],similar=(x,y)=>Math.abs(x.train.positiveRecall-y.train.positiveRecall)<.03&&Math.abs(x.train.negativeRejection-y.train.negativeRejection)<.03;if(out.some(simple=>(simple.rule.conds?.length||1)<cs.length&&similar(simple,item)&&(simple.rule.conds||[simple.rule]).every(c=>cs.some(d=>ruleKey(c)===ruleKey(d)))))continue;const shape=rule=>(rule.conds||[rule]).map(c=>c.key+'|'+c.op).sort().join('&');if(unique.some(x=>shape(x.rule)===shape(item.rule)&&similar(x,item)))continue;unique.push(item);if(unique.length>=maxRules)break;}
 return unique;
}
function capBank(rows,labelFn=it=>it.label,positive='live',negative='dead',max=5000){
  const seen=new Set();
  const dedup=[...rows].sort((a,b)=>b.time-a.time).filter(x=>{
    if(seen.has(x.mint))return false;seen.add(x.mint);return true;
  });
  const p=dedup.filter(x=>labelFn(x)===positive).slice(0,max);
  const n=dedup.filter(x=>labelFn(x)===negative).slice(0,max);
  return [...p,...n].sort((a,b)=>a.time-b.time);
}
module.exports={recordedBuyerPrefixes,recordedBuyerProof,CATEGORY_KEYS,validCondition,verifiedFeatures,KEYS,LEVEL1_KEYS,RULE_KEYS,LEVEL2_KEYS,levelTwoFeaturesAt,samples,candles,featuresAt,starterFeaturesAt,activityOutcome,
  classifyActivity,activityEvidence,tradeOutcomeEvidence,strengthOutcome,evaluation,passes,ruleKey,ruleStats,wilsonInterval,weightedScore,proposeRules,capBank};
