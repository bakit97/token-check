'use strict';
const WSOL='So11111111111111111111111111111111111111112',MIN=60000;
function nativeOpening(c,at=Date.now()){
 if(!c||c.mg?.st!=='ok'||c.mg.pool!==c.p||c.vmint?.length!==2)return false;
 const qi=c.vmint.indexOf(WSOL);if(qi<0||c.vmint[1-qi]!==c.a)return false;
 if(Number.isFinite(c.openingMetrics?.liquiditySol)&&c.openingMetrics.pool===c.p)return false;
 const row=(c.lq||[]).find(r=>r[0]*1000<=at&&Number.isFinite(r[2+qi])&&r[2+qi]>=0);if(!row)return false;
 c.q=WSOL;c.openingMetrics={...(c.openingMetrics||{}),pool:c.p,quoteMint:WSOL,eventAt:c.mg.mT||c.t,at:row[0]*1000,scope:'first-observed-vault-balance',liquiditySol:row[2+qi]/1e9};return true;
}
class QuoteValuation{
 constructor(){this.sol=null;this.stats={nativeRepaired:0,nonNativeValued:0,nonNativePending:0};}
 observe(c,p,at){
  if(!c||p?.pairAddress!==c.p||p.baseToken?.address!==c.a)return false;
  const usd=Number(p.priceUsd),native=Number(p.priceNative),quote=p.quoteToken?.address;
  if(quote===WSOL&&usd>0&&native>0){const value=usd/native;if(Number.isFinite(value)&&value>.01&&value<100000)this.sol={usd:value,at,pool:c.p};}
  if(nativeOpening(c,at)){this.stats.nativeRepaired++;return true;}
  if(!quote||quote===WSOL||c.mg?.st!=='ok'||c.mg.pool!==c.p)return false;
  if(Number.isFinite(c.openingMetrics?.liquiditySolEquivalent)&&c.openingMetrics.pool===c.p)return false;
  const reserve=typeof p.liquidity?.quote==='number'?p.liquidity.quote:NaN,quoteUsd=usd>0&&native>0?reserve*usd/native:NaN,total=p.liquidity?.usd;
  if(!this.sol||at-this.sol.at>5*MIN||at<this.sol.at||!Number.isFinite(quoteUsd)||quoteUsd<0||!Number.isFinite(total)||total<=0||quoteUsd>total*1.25){this.stats.nonNativePending++;c.openingLiquidityReason='non-native-quote-valuation-unavailable';return false;}
  c.q=quote;c.openingMetrics={...(c.openingMetrics||{}),pool:c.p,quoteMint:quote,eventAt:c.mg.mT||c.t,at,scope:'first-observed-quote-valuation',liquiditySol:null,liquidityQuote:reserve,liquidityUsd:quoteUsd,liquiditySolEquivalent:quoteUsd/this.sol.usd,quotePriceUsd:usd/native,solPriceUsd:this.sol.usd,solPriceObservedAt:this.sol.at,valuationSource:'dexscreener-exact-pool-quote-reserve',solPricePool:this.sol.pool};delete c.openingLiquidityReason;this.stats.nonNativeValued++;return true;
 }
 summary(){return {...this.stats,solPrice:this.sol};}
}
function intakeOpening(row,coin,now=Date.now()){const pool=row.proof?.pool||coin?.p,items=[row.proof?.openingMetrics,coin?.openingMetrics].filter(x=>x&&x.pool===pool&&Number.isFinite(x.at)&&x.at<=now),native=items.find(x=>x.quoteMint===WSOL&&Number.isFinite(x.liquiditySol)&&x.liquiditySol>=0),equiv=items.find(x=>x.quoteMint!==WSOL&&Number.isFinite(x.liquiditySolEquivalent)&&x.liquiditySolEquivalent>=0&&x.scope==='first-observed-quote-valuation');return {quoteSol:native?.liquiditySol??null,quoteSolEquivalent:equiv?.liquiditySolEquivalent??null,quoteSolBasis:native?'native-vault':equiv?'quote-side-usd-equivalent':null,liquidityObservedAt:(native||equiv)?.at??null};}
module.exports={nativeOpening,QuoteValuation,intakeOpening};
