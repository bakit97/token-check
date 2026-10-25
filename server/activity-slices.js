'use strict';
const MIN=60000,SLICE=10*MIN,WSOL='So11111111111111111111111111111111111111112';
const wallet=s=>typeof s==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
function tradeRows(data,mint,receivedAt){
 if(!Array.isArray(data))throw Error('trade-response-malformed');
 return data.flatMap(d=>{const x=d?.attributes||{},at=Date.parse(x.block_timestamp),buy=x.from_token_address===WSOL&&x.to_token_address===mint,sell=x.to_token_address===WSOL&&x.from_token_address===mint;
  if(!Number.isFinite(at)||!Number.isFinite(receivedAt)||at>receivedAt||!(buy&&x.kind==='buy'||sell&&x.kind==='sell'))return [];
  const raw=buy?x.from_token_amount:x.to_token_amount,n=typeof raw==='string'&&raw.trim()!==''||typeof raw==='number'?Number(raw):NaN;
  const sol=Number.isFinite(n)&&n>=0?n:null,price=Number(buy?x.price_to_in_usd:x.price_from_in_usd),usd=x.volume_in_usd==null?NaN:Number(x.volume_in_usd);
  return [[at/1000,buy?1:0,Number.isFinite(usd)?usd:null,wallet(x.tx_from_address)?x.tx_from_address:null,Number.isFinite(price)&&price>0?price:null,sol,receivedAt,d.id||x.tx_hash||null]];
 });
}
function evidence({start,end,minutes=[],trades=[],completeWindows=[]}){
 const slices=Array.from({length:Math.ceil((end-start)/SLICE)},(_,i)=>({at:start+i*SLICE,end:Math.min(end,start+(i+1)*SLICE),walletMax:{},buyerWallets:[],buyersComplete:false,buyerIdentityMissing:false,silent:false,complete:false,identityMissing:false,hasTrades:false}));
 for(const row of trades){if(!Array.isArray(row)||!Number.isFinite(row[0]))continue;const at=row[0]*1000;if(at<start||at>=end)continue;const s=slices[Math.floor((at-start)/SLICE)];s.hasTrades=true;if(row[1]){if(wallet(row[3])){if(!s.buyerWallets.includes(row[3]))s.buyerWallets.push(row[3]);}else s.buyerIdentityMissing=true;}
  if(!wallet(row[3])||typeof row[5]!=='number'||!Number.isFinite(row[5])||row[5]<0){s.identityMissing=true;continue;}
  s.walletMax[row[3]]=Math.max(s.walletMax[row[3]]??0,row[5]);
 }
 for(const s of slices){const rows=minutes.filter(r=>r[0]>s.at&&r[0]<=s.end);s.silent=!s.hasTrades&&rows.length===Math.ceil((s.end-s.at)/MIN)&&rows.every(r=>r[1]===1&&r[2]===0&&r[4]?.source==='chain-pool-signatures');
  s.buyersComplete=!s.buyerIdentityMissing&&completeWindows.some(w=>w.complete===true&&w.start<=s.at&&w.end>=s.end);
  s.coverageProof='pool-trades-range-v2';s.complete=s.silent||!s.identityMissing&&completeWindows.some(w=>w.complete===true&&w.start<=s.at&&w.end>=s.end);
 }
 const minuteActivity=Array.from({length:Math.ceil((end-start)/MIN)},(_,i)=>[start+(i+1)*MIN,null,null]);
 for(const r of minuteActivity)if(completeWindows.some(w=>w.complete&&w.start<=r[0]-MIN&&w.end>=r[0])){r[1]=1;r[2]=0;}
 for(const r of trades){const at=r[0]*1000;if(at<start||at>=end)continue;const minute=minuteActivity[Math.floor((at-start)/MIN)];minute[1]=1;minute[2]=1;}
 return {activitySlicesVersion:1,buyersEvidenceVersion:1,sliceMinutes:10,slices,minuteActivity:minuteActivity.filter(r=>r[1]===1)};
}
function classify(row,{minActive=60,minTradeSol=.05,minWallets=2,minCoverage=.8}={}){
 if(row.recoveryPending)return {label:'pending',why:'backfill-pending'};
 const slices=row.activitySlices?.slices||row.slices;
 if(!Array.isArray(slices)||!slices.length)return {label:'unknown',why:'activity-slices-unavailable',activeSlices:null,totalSlices:null};
 let active=0,observed=0;for(const s of slices){const enough=Object.values(s.walletMax||{}).filter(v=>typeof v==='number'&&v>=minTradeSol).length>=minWallets;if(enough){active++;observed++;}else if(s.coverageProof==='pool-trades-range-v2'&&(s.complete||s.silent))observed++;}
 const total=slices.length,coverage=observed/total,pct=active/total*100,unknown=total-observed;
 const metrics={activeSlices:active,totalSlices:total,activityCoverage:coverage,activePct:pct};
 if(coverage<minCoverage)return {...metrics,label:'unknown',why:row.recoveryWhy==='backfill-deadline-exceeded'?'backfill-deadline-exceeded':'trade-coverage-gap'};
 if(pct>=minActive)return {...metrics,label:'live',why:null};
 if((active+unknown)/total*100<minActive)return {...metrics,label:'dead',why:'inactive-slices'};
 return {...metrics,label:'unknown',why:row.recoveryWhy==='backfill-deadline-exceeded'?'backfill-deadline-exceeded':'trade-coverage-gap'};
}
function merge(a,b){if(!a?.slices)return b;if(!b?.slices)return a;const minuteActivity=new Map((a.minuteActivity||[]).map(r=>[r[0],r]));for(const r of b.minuteActivity||[]){const old=minuteActivity.get(r[0]);minuteActivity.set(r[0],old?.[2]===1?old:r);}return {...b,minuteActivity:[...minuteActivity.values()].sort((a,b)=>a[0]-b[0]),slices:b.slices.map(s=>{const old=a.slices.find(x=>x.at===s.at&&x.end===s.end);if(!old)return s;const walletMax={...old.walletMax};for(const [w,n] of Object.entries(s.walletMax||{}))walletMax[w]=Math.max(walletMax[w]??0,n);const hasTrades=old.hasTrades||s.hasTrades;return {...s,walletMax,buyerWallets:[...new Set([...(old.buyerWallets||[]),...(s.buyerWallets||[])])],buyersComplete:old.buyersComplete||s.buyersComplete,buyerIdentityMissing:old.buyerIdentityMissing||s.buyerIdentityMissing,hasTrades,silent:!hasTrades&&(old.coverageProof==='pool-trades-range-v2'&&old.silent||s.silent),coverageProof:'pool-trades-range-v2',complete:old.coverageProof==='pool-trades-range-v2'&&old.complete&&!old.silent||s.complete&&!s.silent||!hasTrades&&(old.coverageProof==='pool-trades-range-v2'&&old.complete||s.complete),identityMissing:old.identityMissing||s.identityMissing};})};}
function unpack(value){if(!value)return null;return JSON.parse(require('node:zlib').inflateSync(Buffer.from(value,'base64'),{maxOutputLength:2*1024*1024}).toString());}
function pack(value){return require('node:zlib').deflateSync(Buffer.from(JSON.stringify(value)),{level:1}).toString('base64');}
function observe(previous,data,mint,start,end,receivedAt){const rows=tradeRows(data,mint,receivedAt),oldest=Math.min(...rows.map(r=>r[0]*1000)),windows=[];if(rows.length&&rows.length===data.length)windows.push({start:Math.max(start,data.length<300?receivedAt-24*3600000:oldest),end:Math.min(end,receivedAt),complete:true});const next=merge(previous,evidence({start,end,trades:rows,completeWindows:windows}));let wallets=0,buyers=0;for(const s of next.slices){const list=s.buyerWallets||[];buyers+=list.length;if(buyers>5000){s.buyerWallets=list.slice(0,Math.max(0,5000-(buyers-list.length)));s.buyersComplete=false;s.buyerIdentityMissing=true;}wallets+=Object.keys(s.walletMax).length;if(wallets>5000){const keys=Object.keys(s.walletMax);for(const key of keys.slice(Math.max(0,5000-(wallets-keys.length))))delete s.walletMax[key];s.complete=false;s.identityMissing=true;}}return next;}
function buyerMetrics(evidence){const slices=evidence?.slices||[],buyers=[...new Set(slices.flatMap(s=>s.buyerWallets||[]))],complete=slices.length>0&&slices.every(s=>s.buyersComplete||s.silent&&!s.hasTrades);return {uniqueBuyers:buyers.length||complete?buyers.length:null,uniqueBuyersComplete:complete,lowerBounds:complete?[]:['unique-buyers']};}
module.exports={buyerMetrics,tradeRows,evidence,classify,merge,pack,unpack,observe};
