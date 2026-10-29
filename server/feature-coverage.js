'use strict';
const {RULE_KEYS}=require('./research-v2');
const SOURCES={},snapshotCache=new Map(),MAX_SNAPSHOT_CACHE=10000;
function snapshotCoverage(coin,anchor,minute,pool,hydrate=x=>x){if(!coin)return null;const fingerprint=coin.featureSnapshotsPacked?require('node:crypto').createHash('sha256').update(coin.featureSnapshotsPacked).digest('hex'):(coin.archiveRefs?.activeHistory||[]).map(r=>r.hash).join(','),key=[anchor,minute,pool,fingerprint].join('|'),previous=snapshotCache.get(coin.a);if(previous?.key===key)return previous.value;const raw=require('./feature-snapshots').rawAt(hydrate(coin),anchor,minute,pool),value=raw?{knownMask:RULE_KEYS.map(k=>known(raw[k])?'1':'0').join('')}:null;snapshotCache.set(coin.a,{key,value});while(snapshotCache.size>MAX_SNAPSHOT_CACHE)snapshotCache.delete(snapshotCache.keys().next().value);return value;}

function group(keys,source,requestsPerCoin,reason){for(const k of keys.split(' '))SOURCES[k]={source,requestsPerCoin,unavailableReason:reason};}
group('buyers buyers10 uniqBuyersPerMin buyerAccel bigBuyShare repeatBuys avgBuy sellShare1m','GT trades; received pool trades',1,'early-trade-quota-or-incomplete-history');
group('trades volume liq mc buys sells buySellRatio tradesPerMin sellShare averageTrade chg1m chg3m chg5m fromPeak drawdown volAccel','DexScreener exact pool; minute observations','batched, up to 20/30','pool-market-data-not-received-by-deadline');
group('safeContract mintRevoked freezeRevoked token2022 t22Safe metaImmutable','public RPC mint/metadata batch','shared batch up to 100','mint-or-metadata-unavailable-by-deadline');
group('launchpad dex ageAtMigrationMin ageMin hourOfDay','verified discovery and event clock',0,'discovery-field-not-proven');
group('quoteSol postPoolSol poolGrowth solTrend','pool vault balances; opening liquidity','shared getMultipleAccounts batch','vault-or-native-valuation-unavailable');
group('holders top1 top10 holderGrowth top10Drift','full token-account wallet census',1,'free-rpc-census-unavailable-or-resource-pressure');
group('lpBurned','verified LP mint and lock proof','1-7, task quota','lp-lock-or-burn-not-proven');
group('devBuySol devSold sniperShare bundleShare bundledWallets','one opening block at verdict',1,'opening-block-missing-or-insufficient-for-wallet-attribution');
group('devHold devHoldPct bigHolderSell','wallet census and timestamped wallet deltas',1,'wallet-balance-or-delta-unavailable');
group('devLaunches devRugShare smartBuyers smartShare','our timestamped launch/outcome/wallet history',0,'local-history-or-early-wallets-incomplete');
group('hasImage hasDescription hasTwitter hasTelegram hasWebsite','token metadata and DexScreener profile','0-1 metadata document','metadata-not-received-by-deadline');
group('isFirstOfName cloneCount cloneRank','our discovery name index',0,'name-or-index-coverage-unavailable');
group('botShare','no verified bot attribution',0,'bot-identity-cannot-be-proven');
group('toMigration launchRate','our timestamped migration/discovery history',0,'history-unavailable-by-deadline');
function known(v){return v!=null&&(typeof v!=='number'||Number.isFinite(v));}
async function coverage(rows,{settings={},cohortStart=0,now=Date.now(),probe=null,snapshot=null,unavailableReasons={}}={}){
 const features=Object.fromEntries(RULE_KEYS.map(k=>[k,{...SOURCES[k],known:0,usableAtDecisionKnown:0,total:0,percent:null,available:false,reason:null}])),byPhase={before:{eligible:0,minute:null},after:{eligible:0,minute:null}};
 let eligible=0,missingDecisionSnapshot=0,rawSnapshotCoins=0,rawSnapshotErrors=0,n=0;for(const row of rows){const cfg=settings.phases?.[row.phase]||settings,N=cfg.decisionMinutes||12,at=row.acceptedAt+N*60000;if(row.acceptedAt<cohortStart||at>now)continue;eligible++;const phase=byPhase[row.phase];if(phase){phase.eligible++;phase.minute=N;}let raw=null;try{raw=snapshot?.(row,N)||null;}catch{rawSnapshotErrors++;}const valid=row.decisionAt===at;if(raw)rawSnapshotCoins++;if(!raw&&!valid)missingDecisionSnapshot++;
 for(const key of RULE_KEYS){const f=features[key];f.total++;if(raw?(raw.knownMask?raw.knownMask[RULE_KEYS.indexOf(key)]==='1':known(raw[key])):valid&&known(row.features?.[key]))f.known++;if(valid&&known(row.features?.[key]))f.usableAtDecisionKnown++;}
 if(++n%4===0)await new Promise(r=>setImmediate(r));
 }
 for(const [key,f] of Object.entries(features)){f.percent=f.total?100*f.known/f.total:null;f.usableAtDecisionPercent=f.total?100*f.usableAtDecisionKnown/f.total:null;f.coverageMet=f.total>=50&&f.percent>=90;f.available=f.coverageMet&&!unavailableReasons[key];f.reason=unavailableReasons[key]||(!f.total?'no-matured-epoch-coins':f.total<50?'needs-50-matured-epoch-coins':f.percent<90?f.unavailableReason:null);f.nullMeans='unavailable, never zero';f.probe=probe?.features?.[key]?{rawPercent:probe.features[key].percent,enabled:probe.features[key].enabled,reason:probe.features[key].reason}:null;}
 return {schema:1,updated:now,cohortStart,anchor:'acceptedAt',receiptTimeOnly:true,denominator:'all-matured-I1-epoch-coins-including-missing-snapshots',eligible,missingDecisionSnapshot,rawSnapshotCoins,rawSnapshotErrors,cache:{entries:snapshotCache.size,maxEntries:MAX_SNAPSHOT_CACHE},measurement:'saved-receivedAt-N-snapshot; frozen-approved-features-fallback',byPhase,minimumCoins:50,targetPercent:90,features};
}
function moduleVerification(passes,rows){const byMint=new Map(rows.map(r=>[r.mint,r])),out={passed:0,completed:0,pending:0,missingResearch:0,compared:0,mismatches:0,earlyVerdicts:0,maxDelayMs:0,samples:[]};for(const pass of passes){if(pass.schema!==2)continue;out.passed++;const row=byMint.get(pass.mint);if(pass.firstSeenAt<pass.zeroAt)out.earlyVerdicts++;out.maxDelayMs=Math.max(out.maxDelayMs,pass.firstSeenAt-pass.zeroAt);if(!row){out.missingResearch++;continue;}if(['live','dead'].includes(row.label))out.completed++;else out.pending++;for(const v of pass.moduleVerdicts||[]){if(v.level!=='1'||v.at!==row.decisionAt)continue;out.compared++;const different=RULE_KEYS.filter(k=>(v.features?.[k]??null)!==(row.features?.[k]??null));out.mismatches+=different.length?1:0;if(out.samples.length<10)out.samples.push({mint:pass.mint,module:v.id,verdictAt:v.at,delayMs:pass.firstSeenAt-v.at,label:row.label,identical:different.length===0,differentKeys:different});}}
 out.complete=out.completed>0&&out.compared===out.passed&&out.mismatches===0&&out.earlyVerdicts===0;return out;}
module.exports={snapshotCoverage,SOURCES,coverage,moduleVerification};
