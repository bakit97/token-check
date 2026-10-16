/* SOL·СКАН — общее ядро расчёта для сайта и сервера (один и тот же код, чтобы цифры совпадали).
   Признаки на момент решения T: берётся только то, что сервер получил не позже T (поле at у наблюдений).
   Результат «живая/мёртвая»: вход по цене первой точки после T, цель +up%, стоп −dn% (стоп считается только до цели),
   касания по телу свечи; монета с пустым пулом (< $200) — слив; если цена известна только по снимкам и цель не достигнута — «неясно». */
(function(root){
const WSOL='So11111111111111111111111111111111111111112';
function lastBefore(arr,T,tsIdx=0,mul=1000){let r=null;for(const x of arr||[]){if(x[tsIdx]*mul<=T)r=x;else break}return r}
function k10feats(c,T){const k=c.k10;if(!k||k.at>T||!k.c?.length)return null;const t0=c.t,end=t0+10*60e3;
  const f=k.c.filter(x=>x[0]*1000>=Math.floor(t0/60e3)*60e3&&x[0]*1000+60e3<=end);if(!f.length)return null;
  const p0=f[0][1],p10=f[f.length-1][4];let hi=0,dd=0;f.forEach(x=>{hi=Math.max(hi,x[2]);dd=Math.max(dd,1-x[3]/hi)});
  const m=x=>Math.floor((x[0]*1000-t0)/60e3);const v=(a,b)=>f.filter(x=>m(x)>=a&&m(x)<b).reduce((s,x)=>s+x[5],0);
  return{x10:p0?p10/p0:null,dd10:dd*100,v1:v(-1,1),v05:v(-1,5),v510:v(5,10),trend:v(-1,5)?v(5,10)/v(-1,5):null,green:f.filter(x=>x[4]>x[1]).length,act:f.length,p10}}
const provedAt=c=>{let t=c.mSeen||Infinity;for(const h of c.mH||[])if(h[2]==='ok'&&h[1]===c.mk)t=Math.min(t,h[0]);return t};
function featsAt(c,T){const F={};const ok=x=>x!=null&&isFinite(x);
  F.known=c.seen<=T&&provedAt(c)<=T;
  F.fam=c.mk;F.hour=new Date(c.t+5*3600e3).getUTCHours();F.clone=(c.clone||0)>0;
  if(c.tk&&c.tkAt&&c.tkAt<=T)F.premig=(c.t-c.tk)/60000;
  const ct=c.ct;if(ct&&(c.ctAt??ct.at??Infinity)<=T){F.danger=!!(ct.mint||ct.freeze||ct.fee>0||ct.hook||ct.deleg||ct.pause||ct.nontr||ct.defFrozen);F.metaMut=ct.metaMut;F.t22=ct.prog==='token2022'}
  const k=k10feats(c,T);if(k)Object.assign(F,{x10:k.x10,dd10:k.dd10,v1:k.v1,v05:k.v05,v510:k.v510,trend:k.trend,green:k.green,act:k.act});
  const d=lastBefore(c.ds,T);if(d){F.liq=d[2];F.mc=d[3];F.b5=d[4];F.s5=d[5];F.v5=d[6];if(ok(d[4])&&ok(d[5]))F.bs=d[5]?d[4]/d[5]:d[4];if(ok(d[2])&&ok(d[3])&&d[3])F.liqmc=d[2]/d[3]*100;F.pxT=d[1];F.dsAge=(T/1000-d[0])}
  let h=null;for(const m of ['10','5','3']){const x=c.hold?.[m];if(x&&!x.miss&&x.at<=T){h=x;break}}if(h){F.top1=h.top1*100;F.top10=h.top10*100;F.pda=h.pda*100}
  const g=lastBefore(c.gx,T);if(g){F.buyers15=g[7];F.sellers15=g[8];F.tx15=(g[5]??0)+(g[6]??0);if(g[7]!=null&&g[8]!=null)F.bsU=g[8]?g[7]/g[8]:g[7];F.vol15=g[10]}
  const b=c.bx;if(b&&!b.miss&&b.cov&&b.at<=T){F.payers=b.payers;F.trades=b.n;F.repeat=b.payers?b.repeat/b.payers*100:null;F.btop1=b.top1!=null?b.top1*100:null;F.bsUsd=b.sellUsd?b.buyUsd/b.sellUsd:null;F.trCov=b.cov}
  const l=lastBefore(c.lq,T);if(l&&c.vmint&&c.vdec){const qi=c.vmint[0]===c.a?1:0;const q=l[2+qi]/10**(c.vdec[qi]||0);if(c.vmint[qi]===WSOL)F.liqSol=q}
  return F}
// ключи признаков, которые можно использовать в фильтрах: [ключ, тип (n — число, b — да/нет)]
const FKEYS=[['danger','b'],['clone','b'],['metaMut','b'],['t22','b'],['premig','n'],['hour','n'],['x10','n'],['dd10','n'],['v1','n'],['v05','n'],['v510','n'],['trend','n'],['green','n'],['act','n'],
  ['b5','n'],['s5','n'],['bs','n'],['v5','n'],['liq','n'],['liqSol','n'],['mc','n'],['liqmc','n'],['buyers15','n'],['sellers15','n'],['bsU','n'],['tx15','n'],['vol15','n'],
  ['payers','n'],['trades','n'],['repeat','n'],['btop1','n'],['bsUsd','n'],['top1','n'],['top10','n'],['pda','n']];
// слив по блокчейну: SOL/валюта в хранилище пула упала ниже 5% от своего максимума
function chainRugAt(c){if(!c.lq||!c.vmint)return null;const qi=c.vmint[0]===c.a?1:0;let mx=0;for(const l of c.lq){const q=l[2+qi];if(q>mx)mx=q;else if(mx>0&&q<mx*0.05)return l[0]*1000}return null}
function pathAfter(c,T,G){const out=[];let nK=0,nD=0;const rugAt=chainRugAt(c);
  if(c.path?.c?.length){for(const x of c.path.c){if(x[0]*1000>=T&&!(rugAt&&x[0]*1000>=rugAt)){out.push([x[0]*1000,x[1],x[2],x[3],x[4]]);nK++}}}
  const lastP=out.length?out[out.length-1][0]:T;
  // снимок DEX Screener считается сливом, только если раньше в пуле были деньги (≥ $2000), а стало < $200:
  // у пулов Meteora DEX Screener часто показывает $0 — это не слив, а отсутствие данных
  let dsMax=0;for(const d of c.ds||[]){const ts=d[0]*1000;if(d[2]!=null)dsMax=Math.max(dsMax,d[2]);if(ts>=T&&ts>lastP&&d[1]){
    const rug=(d[2]!=null&&d[2]<200&&dsMax>=2000)||(rugAt!=null&&ts>=rugAt);const v=rug?1e-12:d[1];out.push([ts,v,v,v,v,rug?1:0]);if(ts<=T+G.win*60e3)nD++}}
  if(rugAt&&rugAt>=T&&!out.some(x=>x[5])){out.push([rugAt,1e-12,1e-12,1e-12,1e-12,1]);out.sort((a,b)=>a[0]-b[0])}
  const exact=nK>0&&nD===0;return{pts:out,exact,mixed:nK>0&&nD>0,coverEnd:out.length?out[out.length-1][0]:null}}
function labEntry(c,T,G){const p=pathAfter(c,T,G);if(!p.pts.length)return null;const e=p.pts[0];if(e[5])return null;if(e[0]-T>6*60e3)return null;return{price:e[1],at:e[0],p}}
function outcome(c,G,now){const T=c.t+G.dec*60e3;const F=featsAt(c,T);
  if(c.legacy)return{st:'legacy',T,F};if(!F.known)return{st:'late',T,F};
  const e=labEntry(c,T,G);
  if(!e){const p=pathAfter(c,T,G);const f0=p.pts[0];
    // пул слили ещё до входа — купить было невозможно, монета мёртвая
    if(f0&&f0[5])return{st:'dead',T,F,why:'слив до входа',rugBefore:1};
    return{st:now<T+15*60e3?'early':'nodata',T,F}}
  const up=e.price*(1+G.up/100),dn=e.price*(1-G.dn/100),end=T+G.win*60e3;let res=null,amb=false,peak=0,low=Infinity;
  for(const x of e.p.pts){if(x[0]>end)break;const bt=Math.max(x[1],x[4]),bb=Math.min(x[1],x[4]);peak=Math.max(peak,bt);low=Math.min(low,bb);if(res)continue;const hu=bt>=up,hd=bb<=dn;
    if(hu&&hd){amb=true;res={win:x[0]}}else if(hu)res={win:x[0]};else if(hd)res={stop:x[0]}}
  const covered=e.p.coverEnd!=null&&e.p.coverEnd>=Math.min(end,now)-10*60e3;
  let st,why2=null;if(res&&res.win)st=amb?'amb':'live';else if(res&&res.stop)st='dead';else if(now<end)st='early';else if(!covered)st='nodata';else if(e.p.exact)st='dead';else{st='amb';why2='снимки'}
  return{st,T,F,entry:e.price,entryAt:e.at,exact:e.p.exact,mixed:e.p.mixed,peak:peak/e.price,low:low/e.price,hitAt:res?(res.win||res.stop):null,why:res?.stop?'stop':(st==='dead'?'flat':null),why2}}
// цена через m минут после входа (закрытие последней точки не позже), относительно входа
function xAfter(o,m){if(!o.entry)return null;const tt=o.T+m*60e3;let v=null,last=null;for(const x of o.pts||[]){if(x[0]<=tt){v=x[4];last=x[0]}else break}return v!=null&&tt-last<12*60e3?v/o.entry:null}
// клоны: сколько монет с тем же именем вышло раньше в этот день
function markClones(coins){const nm=x=>(x.n||'').trim().toLowerCase();const first={};coins.slice().sort((a,b)=>a.t-b.t).forEach(c=>{const k=nm(c);if(!k){c.clone=0;return}c.clone=first[k]||0;first[k]=(first[k]||0)+1})}
function passes(F,rules){for(const [k,op,v] of rules){const x=F[k];if(x==null)return false;if(op==='='&&x!==v)return false;if(op==='>='&&!(x>=v))return false;if(op==='<='&&!(x<=v))return false}return true}
root.LC={chainRugAt,lastBefore,k10feats,provedAt,featsAt,FKEYS,pathAfter,labEntry,outcome,xAfter,markClones,passes};
})(typeof window!=='undefined'?window:globalThis);
