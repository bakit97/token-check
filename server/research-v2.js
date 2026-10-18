'use strict';
// SOL·СКАН: deterministic analytics — no bought/sold assets, no signal execution.
// Features use ONLY information observed before the decision deadline.
// Outcomes are measured LATER; incomplete/missing coverage remains "pending".
const MIN=60_000, FIVE=5*MIN;
const KEYS=['buyers','trades','volume','liq','mc','buys','sells','buySellRatio'];
const LEVEL2_KEYS=['chg1m','chg3m','chg5m','fromPeak','drawdown','buyerAccel','volAccel','bigBuyShare','repeatBuys','avgBuy','sellShare1m','bigHolderSell','devSold','top10Drift','holderGrowth','poolGrowth','toMigration','ageMin','hourOfDay','solTrend','launchRate'];
const RULE_KEYS=[...KEYS,'buyers10','quoteSol','safeContract','top1','top10','token2022','hasImage','hasDescription','sellShare','averageTrade',...LEVEL2_KEYS];
const inRange=(x,a,b)=>Number.isFinite(x)&&x>=a&&x<=b;
function samples(coin) {
  const src=[coin?.preObs,...(coin?.origs||[]),coin].filter(Boolean);
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
  const src=[coin?.preObs,...(coin?.origs||[]),coin].filter(Boolean);
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
  const gx=[...(coin?.preObs?.gx||[]),...(coin?.gx||[])]
    .sort((a,b)=>a[0]-b[0]);
  const g=latestBefore(gx,decisionAt,7*MIN,x=>x[0]*1000);
  const bx=[coin?.preObs?.bx,coin?.bx]
    .filter(x=>x&&Number.isFinite(x.at)&&x.at<=decisionAt&&decisionAt-x.at<=7*MIN&&x.cov).sort((a,b)=>a.at-b.at).at(-1);
  const buys=d?.buys??null,sells=d?.sells??null;
  const ratio=buys!=null&&sells!=null?sells>0?buys/sells:buys:null;
  function finite(v){return typeof v==='number'&&Number.isFinite(v)?v:null}
  const F={buyers:finite(g?.[3]??bx?.payers??null),
    trades:finite(buys!=null&&sells!=null?buys+sells:null),
    volume:finite(d?.volume??null),liq:finite(d?.liq??null),
    mc:finite(d?.mc??null),buys:finite(buys),sells:finite(sells),
    buySellRatio:finite(ratio)};
  const ct=coin?.ct,metaAt=coin?.metadataAt;
  return {...F,...starterFeaturesAt(coin,decisionAt,context),
    token2022:ct&&ct.at<=decisionAt&&['token','token2022'].includes(ct.prog)?(ct.prog==='token2022'?1:0):null,
    hasImage:Number.isFinite(metaAt)&&metaAt<=decisionAt?(coin.img||coin.i?1:0):null,
    hasDescription:Number.isFinite(metaAt)&&metaAt<=decisionAt?(coin.description?1:0):null,
    sellShare:buys!=null&&sells!=null&&buys+sells>0?sells/(buys+sells)*100:null,
    averageTrade:buys!=null&&sells!=null&&buys+sells>0&&F.volume!=null?F.volume/(buys+sells):null};
}
function activityOutcome(coin,entryAt,{hours=5,minActive=70,maxIdle=60,minCoverage=.8}={},now=Date.now()){
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
function strengthOutcome(coin,zeroAt,{minAbove=70,minCoverage=.9}={},now=Date.now()){
  if(!inRange(minAbove,0,100))throw RangeError('Invalid level-two settings');
  const end=zeroAt+300*MIN;
  if(now<end+MIN)return {label:'pending',why:'five-hours-not-finished'};
  const path=candles(coin);
  const p0=latestBefore(path,zeroAt,7*MIN,x=>x[0])?.[1];
  if(!(p0>0))return {label:'pending',why:'no-price-at-zero'};
  let covered=0,above=0,maxGap=0,gap=0;
  const curve=[],minuteCurve=[];
  for(let m=1;m<=300;m++){
    const x=latestBefore(path,zeroAt+m*MIN,7*MIN,y=>y[0]);
    if(!x){
      gap++;maxGap=Math.max(maxGap,gap);
      minuteCurve.push(null);continue;
    }
    gap=0;covered++;
    if(x[1]>p0)above++;
    // Minute rows use the latest observed price at or before that minute;
    // stale observations older than seven minutes are always missing.
    const pct=Math.round(100000*(x[1]/p0-1))/1000;
    minuteCurve.push(pct);
    if(m%5===0)curve.push([m,pct]);
  }
  // 70% is 210 minutes OF ALL 300, not of the observed subset.
  if(covered<300*minCoverage||maxGap>10)
    return {label:'pending',why:'insufficient-price-coverage',covered,maxGap};
  return {label:above/300*100>=minAbove?'strong':'weak',
    above,covered,pctAbove:above/300*100,p0,curve,minuteCurve};
}
// Starter rules use confirmed account rights and native on-chain balances, never USD proxies.
function starterFeaturesAt(coin,decisionAt,context={}){
 const WSOL='So11111111111111111111111111111111111111112',ct=coin?.ct;
 let safeContract=null,quoteSol=null,buyers10=null;
 if(ct&&ct.safetyVersion===1&&Array.isArray(ct.unknownExtensions)&&Number.isFinite(ct.at)&&ct.at<=decisionAt&&['token','token2022'].includes(ct.prog)){
  const flags=['mint','freeze','hook','deleg','nontr','defFrozen','pause','feeAuthority'];
  if(flags.every(k=>typeof ct[k]==='boolean')&&Number.isFinite(ct.fee))safeContract=flags.some(k=>ct[k])||ct.fee>0||ct.unknownExtensions.length>0?0:1;
 }
 const eventAt=Number.isFinite(context.eventAt)?context.eventAt:coin.t,endAt=eventAt+10*MIN;
 // Every observation must belong to the mint's original ten-minute window.
 // Early migration may add a new pool inside that window; overlapping pools
 // yield a MAXIMUM lower bound, never a sum of potentially identical buyers.
 const pools=[coin,...(coin.origs||[]),coin.preObs].filter((p,i,all)=>p&&Number.isFinite(p.t)&&p.t<=endAt&&all.findIndex(x=>x&&x.p===p.p&&x.t===p.t)===i);
 const pool=pools.find(p=>p.t===eventAt),bx=pool?.bx;
 let lower=false,buyerAt=null,buyerSource=null;
 if(pools.length===1&&bx?.cov===true&&Number.isFinite(bx.at)&&bx.at<=decisionAt&&bx.at>=pool.t+10*MIN+5000&&Number.isFinite(bx.payers)&&decisionAt-bx.at<=7*MIN)buyers10=bx.payers;
 if(buyers10==null){
  const proofs=[];
  for(const p of pools){
   for(const g of p.gx||[]){const at=g[0]*1000;if(at<p.t||at>endAt||at>decisionAt||at<eventAt)continue;
    if(p.t<eventAt&&at-5*MIN<eventAt)continue;
    const n=p.t>=eventAt&&Number.isFinite(g[7])?g[7]:g[3];if(Number.isInteger(n)&&n>=0)proofs.push({n,at,source:'gt-unique-buyers-prefix'});}
   const b=p.bx;if(p.t===eventAt&&b&&Number.isFinite(b.at)&&b.at<=decisionAt&&b.at>=endAt&&Number.isInteger(b.payers)&&b.payers>=0&&b.n>=b.payers&&b.buys>=b.payers)proofs.push({n:b.payers,at:b.at,source:'recorded-first-ten-minute-trades'});
  }
  const best=proofs.sort((a,b)=>b.n-a.n||a.at-b.at)[0];if(best){buyers10=best.n;lower=true;buyerAt=best.at;buyerSource=best.source;}
 }
 const qi=coin?.vmint?.indexOf(WSOL);
 if(qi>=0&&coin.vmint.length===2&&coin.vmint[1-qi]===coin.a&&Number.isFinite(coin.vaultIdentityAt)&&coin.vaultIdentityAt<=decisionAt){
  const row=latestBefore([...(coin.lq||[])].sort((a,b)=>a[0]-b[0]),decisionAt,7*MIN,x=>x[0]*1000);
  if(row&&Number.isFinite(row[2+qi])&&row[2+qi]>=0)quoteSol=row[2+qi]/1e9;
 }
 // До миграции: SOL в кривой pump (real_sol_reserves), замер не старше 7 мин и не позже момента решения.
 if(quoteSol==null&&coin?.mg?.st!=='ok'&&/pump-?fun/i.test(coin?.d||'')&&Array.isArray(coin?.curveSol)&&(!coin.q||coin.q===WSOL)){
  let best=null;for(const r of coin.curveSol)if(Array.isArray(r)&&r[0]<=decisionAt&&decisionAt-r[0]<=7*MIN&&Number.isFinite(r[1])&&r[1]>=0&&(!best||r[0]>best[0]))best=r;
  if(best)quoteSol=best[1]/1e9;
 }
 // Концентрация у крупнейших держателей (без хранилищ пула) — снимок не позже момента решения.
 let top1=null,top10=null;
 for(const [,h] of Object.entries(coin?.hold||{}))if(h&&!h.miss&&Number.isFinite(h.at)&&h.at<=decisionAt&&Number.isFinite(h.top10)&&(!top10||h.at>top10.at))top10={at:h.at,v:h.top10*100,v1:Number.isFinite(h.top1)?h.top1*100:null};
 if(top10){top1=top10.v1;top10=top10.v}
 return {safeContract,quoteSol,buyers10,top1,top10,...(lower?{buyers10LowerBound:true,buyers10At:buyerAt,buyers10Source:buyerSource}:{})};
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
 if(Number.isSafeInteger(coin.createdAt)&&coin.createdAt<=decisionAt)out.ageMin=(decisionAt-coin.createdAt)/MIN;
 if(Number.isSafeInteger(entryAt))out.hourOfDay=new Date(entryAt+5*3600000).getUTCHours();
 // Trade rows lack individual receipt times and full wallet identities. Do not
 // infer bot/repeat/developer sales or one-minute flow from rolling m5 counts.
 return {...featuresAt(coin,decisionAt,{eventAt:acceptedAt,phase}),...out};
}
function evaluation(F,rule){
  if(rule?.conds){if(!Array.isArray(rule.conds)||!rule.conds.length||rule.conds.length>8)return 'unknown';const results=rule.conds.map(c=>evaluation(F,{key:c?.key,op:c?.op,value:c?.value}));return results.includes('reject')?'reject':results.includes('unknown')?'unknown':'pass'}
  if(!F||!rule||!RULE_KEYS.includes(rule.key)||
      !['>=','<='].includes(rule.op)||!Number.isFinite(rule.value))return 'unknown';
  if(rule.conditions){if(!Array.isArray(rule.conditions)||rule.conditions.length>8)return 'unknown';const results=rule.conditions.map(c=>evaluation(F,c));
    if(results.includes('reject'))return 'reject';if(results.includes('unknown'))return 'unknown';}
  const v=F[rule.key];
  if(typeof v!=='number'||!Number.isFinite(v))return 'unknown';
  if(rule.key==='buyers10'&&F.buyers10LowerBound===true)return rule.op==='>='?(v>=rule.value?'pass':'unknown'):(v>rule.value?'reject':'unknown');
  return rule.op==='>='?(v>=rule.value?'pass':'reject'):(v<=rule.value?'pass':'reject');
}
function passes(F,rule){return evaluation(F,rule)==='pass'}
function ruleKey(r){return [r.key,r.op,Number(r.value).toPrecision(8)].join('|')}
function ruleStats(rows,rule,positive,negative){
  const yes=rows.filter(r=>r.label===positive);
  const no=rows.filter(r=>r.label===negative);
  const y=yes.map(r=>evaluation(r.features,rule));
  const n=no.map(r=>evaluation(r.features,rule));
  const pass=y.filter(x=>x==='pass').length;
  const reject=n.filter(x=>x==='reject').length;
  const missingPositive=y.filter(x=>x==='unknown').length;
  const missingNegative=n.filter(x=>x==='unknown').length;
  return {passedPositive:pass,totalPositive:yes.length,rejectedNegative:reject,
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
function proposeRules(rows,{positive='live',negative='dead',minPos=100,minNeg=1,maxRules=12}={}){
  const pos=rows.filter(r=>r.label===positive);
  const neg=rows.filter(r=>r.label===negative);
  if(pos.length<minPos||neg.length<minNeg)return [];
  const sorted=[...rows].sort((a,b)=>a.time-b.time);
  const out=[];
  const seenRules=new Set();
  // Перебираем и базовые, и стартовые признаки (покупатели 10 мин, SOL, контракт, держатели).
  for(const key of RULE_KEYS){
    const vals=sorted.map(r=>r.features?.[key]).filter(v=>typeof v==='number'&&Number.isFinite(v)).sort((a,b)=>a-b);
    if(vals.length<Math.max(12,Math.floor(rows.length*.4)))continue;
    for(const p of Array.from({length:49},(_,i)=>(i+1)/50)){
      const threshold=vals[Math.floor((vals.length-1)*p)];
      for(const op of ['>=','<=']){
        const rule={key,op,value:+threshold.toPrecision(8)};
        if(seenRules.has(ruleKey(rule)))continue;
        seenRules.add(ruleKey(rule));
        const stat=ruleStats(rows,rule,positive,negative);
        if(stat.positiveRecall===null||stat.negativeRejection===null)continue;
        if(stat.positiveRecall<.55||stat.negativeRejection<.5)continue;
        if(stat.evaluablePositive/pos.length<.85||stat.evaluableNegative/neg.length<.85)continue;
        const score=2*stat.positiveRecall*stat.negativeRejection/
          (stat.positiveRecall+stat.negativeRejection);
        out.push({rule,train:stat,score});
      }
    }
  }
  const rank=(a,b)=>b.score-a.score||b.train.positiveRecall-a.train.positiveRecall;
  out.sort(rank);
  const leaves=out.slice(0,24),beam=out.slice(0,16);
  for(let size=2;size<=3;size++){
    const next=[];
    for(const parent of beam.filter(x=>(x.rule.conds?.length||1)===size-1))for(const leaf of leaves){
      const conds=[...(parent.rule.conds||[parent.rule]),leaf.rule];
      if(new Set(conds.map(x=>x.key)).size!==size)continue;
      conds.sort((a,b)=>ruleKey(a).localeCompare(ruleKey(b)));
      const sig=conds.map(ruleKey).join('&');if(seenRules.has(sig))continue;seenRules.add(sig);
      const rule={...conds[0],conditions:conds.slice(1),conds},stat=ruleStats(rows,rule,positive,negative);
      if(stat.positiveRecall<.55||stat.negativeRejection<.5||stat.evaluablePositive/pos.length<.85||stat.evaluableNegative/neg.length<.85)continue;
      // An extra condition must improve rejection by >=5pp without losing positives.
      if(stat.positiveRecall+1e-9<parent.train.positiveRecall||stat.negativeRejection-parent.train.negativeRejection<.05-1e-9)continue;
      const score=2*stat.positiveRecall*stat.negativeRejection/(stat.positiveRecall+stat.negativeRejection);
      next.push({rule,train:stat,score});
    }
    next.sort(rank);beam.push(...next.slice(0,16));out.push(...next.slice(0,16));
  }
  out.sort(rank);const unique=[];
  for(const item of out){
    const keys=r=>(r.conds||[r]).map(c=>c.key+'|'+c.op).sort().join('&');
    if(unique.some(x=>keys(x.rule)===keys(item.rule)&&Math.abs(x.train.positiveRecall-item.train.positiveRecall)<.03&&Math.abs(x.train.negativeRejection-item.train.negativeRejection)<.03))continue;
    unique.push(item);if(unique.length>=maxRules)break;
  }
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
module.exports={KEYS,RULE_KEYS,LEVEL2_KEYS,levelTwoFeaturesAt,samples,candles,featuresAt,starterFeaturesAt,activityOutcome,
  strengthOutcome,evaluation,passes,ruleKey,ruleStats,proposeRules,capBank};
