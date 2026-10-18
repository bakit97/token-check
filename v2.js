(function(){
'use strict';
if(window.__SOLSCAN_V2__)return;
window.__SOLSCAN_V2__=true;
var BASE='https://storage.googleapis.com/sol-scan-511718-data/';
var STORE='solscan_v2_state_20261017';
var BANK='solscan_v2_polygons_20261017';
var PASS_LOG='solscan_v2_verified_passes_20261017';
var $=function(id){return document.getElementById(id)};
var now=function(){return Date.now()};
var fmt=function(n){return Number(n||0).toLocaleString('ru-RU')};
var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(x){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]})};
var defaultS={tab:'all',stream:'all',ageBefore:2,ageAfter:2,limit:20,decision:10,r1Hours:5,r1Activity:70,r1Idle:60,r2Strong:70,r2Stream:'after',r2Step:5,r2Page:0,level:'1',poly:{'1':[2000,2000],'2':[2000,2000]},filters:[],modules:[]};
function clone(o){return JSON.parse(JSON.stringify(o))}
function loadLocal(key,def){try{var x=JSON.parse(localStorage.getItem(key));return x&&typeof x==='object'?x:clone(def)}catch(e){return clone(def)}}
var s=Object.assign(clone(defaultS),loadLocal(STORE,defaultS));
s.poly=Object.assign(clone(defaultS.poly),s.poly||{});
if(!Array.isArray(s.filters))s.filters=[];
if(!Array.isArray(s.modules))s.modules=[];
// Signals are immutable local observations; no backfilled alerts after a deadline.
var signalLog=loadLocal(PASS_LOG,[]);
if(!Array.isArray(signalLog))signalLog=[];
signalLog=signalLog.filter(function(x){return x&&typeof x.mint==='string'&&Number.isSafeInteger(x.acceptedAt)&&Number.isSafeInteger(x.deadline)&&Array.isArray(x.matches)}).slice(-2000);
var bank=Object.assign({'1':[],'2':[]},loadLocal(BANK,{'1':[],'2':[]}));
for(var lv of ['1','2'])if(!Array.isArray(bank[lv]))bank[lv]=[];
var dataset=[],status=null,dataErr='',loadedAt=0,picker=null,editorId=null,lastPassed=[],lastR1=[],lastR2=[],lastAccepted=[],lastVisible=[],testHtml='',lastBankWrite=0,lastResearchBankRead=0,researchMeta=null,researchServerBank=false,fetching=false,sourceActive=false,sourceMeta=null,sourceRecords=[];
var serverPassActive=false,serverPassRows=[],passMeta=null,serverR2Active=false,serverR2Rows=[],twoMeta=null,autoOne=null,autoTwo=null,lastSecondBankRead=0;
var controlEndpoint=null,serverR2Curve=null,filterAuditMeta=null;
var moduleDraft=new Map();
function draftModuleKey(m){return m.phase+':'+m.level+':'+m.filterId}
var phaseNames={before:'🌱 До миграции',after:'🎓 После миграции'};
function save(){try{localStorage.setItem(STORE,JSON.stringify(s))}catch(e){note('Не удалось сохранить настройки на устройстве')}}
function saveSignals(){try{localStorage.setItem(PASS_LOG,JSON.stringify(signalLog))}catch(e){note('История сигналов не сохранилась на телефоне')}}
function saveBank(){try{localStorage.setItem(BANK,JSON.stringify(researchServerBank?{'1':[],'2':bank['2']}:bank));lastBankWrite=now()}catch(e){note('Локальная память телефона заполнена: проверьте сохранение данных')}}
function clamp(v,min,max,def){v=Number(v);return Number.isFinite(v)?Math.min(max,Math.max(min,v)):def}
function note(message){$('toast').textContent=message;clearTimeout(note.timer);note.timer=setTimeout(function(){$('toast').textContent=''},6000)}
function day(t){return new Date(t+5*3600e3).toISOString().slice(0,10)}
function mint(c){return c.a||c.mint||''}
function ts(v){v=Number(v);return Number.isFinite(v)&&v>0?v:null}
function price(p){var n=Number(p);if(!Number.isFinite(n)||n<=0)return '—';if(n<0.0001)return '$'+n.toExponential(2);if(n<1)return '$'+n.toPrecision(4);return '$'+fmt(+n.toFixed(3))}
function time(t){return t?new Date(t).toLocaleTimeString('ru-RU',{timeZone:'Asia/Almaty',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—'}
function ageM(t){return t?Math.max(0,Math.floor((now()-t)/60000))+' мин':'—'}
function safeImg(src){try{var u=new URL(src);return u.protocol==='https:'?u.href:null}catch(e){return null}}
function dataMetrics(c,cutoff){
  // Match the server's featuresAt: keep pre-migration observations even if
  // the same mint has already migrated to a new official pool.
  const sources=[c.preObs].concat(c.origs||[],[c]).filter(Boolean);
  let d=null,dAt=-Infinity;
  for(const src of sources){
    for(const row of src.ds||[]){
      if(!Array.isArray(row))continue;
      const t=Number(row[0])*1000;
      if(Number.isFinite(t)&&t<=cutoff&&cutoff-t<=7*60000&&t>=dAt){
        d=row;dAt=t;
      }
    }
  }
  let g=null,gAt=-Infinity;
  for(const src of [c.preObs,c]){
    if(!src)continue;
    for(const row of src.gx||[]){
      const t=Number(row[0])*1000;
      if(Number.isFinite(t)&&t<=cutoff&&cutoff-t<=7*60000&&t>=gAt){
        g=row;gAt=t;
      }
    }
  }
  let bx=null;
  for(const src of [c.preObs,c]){
    const v=src?.bx;
    if(v&&v.cov&&Number.isFinite(v.at)&&v.at<=cutoff&&
       cutoff-v.at<=7*60000&&(!bx||v.at>bx.at))bx=v;
  }
  function num(v){return typeof v==='number'&&Number.isFinite(v)?v:null}
  const buys=d?num(d[4]):null,sells=d?num(d[5]):null;
  const ratio=buys==null||sells==null?null:sells>0?buys/sells:buys;
  return {buyers:num(g?.[3]??bx?.payers??null),
    trades:buys==null||sells==null?null:buys+sells,
    volume:d?num(d[6]):null,liq:d?num(d[2]):null,mc:d?num(d[3]):null,
    buys,sells,buySellRatio:ratio};
}
function ruleStatus(features,f){
  if(f.conditions){const r=f.conditions.map(function(c){return ruleStatus(features,c)});if(r.includes('reject'))return 'reject';if(r.includes('unknown'))return 'unknown';}
  const v=features?.[f.key];
  if(typeof v!=='number'||!Number.isFinite(v))return 'unknown';
  if(f.key==='buyers10'&&features.buyers10LowerBound===true)return f.op==='>='?(v>=f.value?'pass':'unknown'):(v>f.value?'reject':'unknown');
  return f.op==='>='?(v>=f.value?'pass':'reject'):(v<=f.value?'pass':'reject');
}
function ruleMatch(features,f){return ruleStatus(features,f)==='pass'}
function freshAdmission(c) {
  // Основание для ДО = подтверждённое открытие публичной торговли, НЕ token creation / seen.
  var p=ts(c.publicTradingAt),pv=c.publicTradingVerified===true,ps=ts(c.publicTradingSeenAt);
  if(p&&pv&&ps&&ps>=p&&(ps-p)<=s.ageBefore*60000)return {phase:'before',eventAt:p,acceptedAt:ps};
  // Для ПОСЛЕ реальный сервер уже отдаёт время в цепи mT и первого подтверждения mSeen.
  var m=ts(c.mT),v=ts(c.mSeen);
  if(c.mst==='ok'&&m&&v&&v>=m&&(v-m)<=s.ageAfter*60000){
    return {phase:'after',eventAt:m,acceptedAt:v};
  }
  return null;
}
function admitted() {
  // FAIL CLOSED: if the authoritative server source is stale or missing,
  // historic third-party candidates must never be treated as admitted coins.
  if(!sourceActive)return [];
  const byMint=new Map(dataset.map(function(c){return [mint(c),c]}));
  return sourceRecords.map(function(record){
    var raw=byMint.get(record.a)||{};
    return Object.assign({},raw,{a:record.a,n:raw.n||record.n||'',
      s:raw.s||record.s||'',i:raw.i||record.i||'',
      _entry:{phase:record.phase,eventAt:record.eventAt,acceptedAt:record.acceptedAt},
      _sourceProof:record.proofSig||null,_uri:record.uri||null});
  }).sort(function(a,b){return b._entry.acceptedAt-a._entry.acceptedAt});
}
function visibleAll(coins) {
  // Возраст 1–10 минут — условие ВХОДА, не таймер исчезновения карточки.
  // Витрина показывает последние допущенные события, пока есть место в списке.
  return coins.filter(function(c){return s.stream==='all'||c._entry.phase===s.stream});
}
function labelOne(c) {
  var start=c._entry.acceptedAt,end=start+s.r1Hours*3600e3;
  if(now()<end)return {label:'pending',why:'Наблюдение ещё идёт'};
  var blocks=s.r1Hours*12,observed=0,active=0,maxIdle=0,idle=0,missingRun=0,maxMissing=0;
  var map=new Map();
  for(var x of c.ds||[]){
    var at=Number(x[0])*1000,idx=Math.floor((at-start)/300000);
    if(idx<0||idx>=blocks||!Number.isFinite(at))continue;
    var n=Number(x[4]||0)+Number(x[5]||0),vol=Number(x[6]||0);
    if(x[4]==null||x[5]==null||x[6]==null)continue;
    if(!map.has(idx)||n>map.get(idx))map.set(idx,(n>0&&vol>0)?n:0);
  }
  for(var i=0;i<blocks;i++){
    if(!map.has(i)){missingRun++;maxMissing=Math.max(maxMissing,missingRun);idle=0;continue}
    missingRun=0;observed++;if(map.get(i)>0){active++;idle=0}else{idle++;maxIdle=Math.max(maxIdle,idle*5)}
  }
  // Нельзя записывать отсутствие снимка как отсутствие торговли.
  if(observed<blocks*.7||maxMissing>3)return {label:'pending',why:'Недостаточно снимков сделок',observed:observed,total:blocks};
  var pct=active/blocks*100;
  return {label:pct>=s.r1Activity&&maxIdle<=s.r1Idle?'live':'dead',
    score:pct,maxIdle:maxIdle,observed:observed,total:blocks};
}
function series(c){
  var map=new Map();
  for(var x of c.ds||[]){var t=+x[0]*1000,p=+x[1];if(t>0&&p>0)map.set(t,p)}
  if(c.path&&Array.isArray(c.path.c))for(var x2 of c.path.c){
    var tp=+x2[0]*1000,pr=+x2[4];if(tp>0&&pr>0)map.set(tp,pr);
  }
  if(c.k10&&Array.isArray(c.k10.c))for(var x3 of c.k10.c){var tp2=+x3[0]*1000,pr2=+x3[4];if(tp2>0&&pr2>0)map.set(tp2,pr2)}
  return [...map.entries()].sort(function(a,b){return a[0]-b[0]});
}
function nearPrice(arr,t,lag){
  var lo=0,hi=arr.length-1,found=-1;
  while(lo<=hi){var mid=(lo+hi)>>1;if(arr[mid][0]<=t){found=mid;lo=mid+1}else hi=mid-1}
  return found>=0&&t-arr[found][0]<=lag?arr[found][1]:null;
}
function labTwo(c,passed) {
  var T=passed.deadline,end=T+300*60000;
  if(now()<end)return {label:'pending',why:'Ещё нет пяти часов после 0'};
  var arr=series(c),p0=nearPrice(arr,T,8*60000);
  if(!(p0>0))return {label:'pending',why:'Нет достоверной цены у точки 0'};
  var above=0,covered=0,curve=[];
  for(var i=1;i<=300;i++){
    var p=nearPrice(arr,T+i*60000,10*60000);
    if(p==null)continue;
    covered++;if(p>p0)above++;
    if(i%5===0)curve.push({min:i,pct:100*(p/p0-1)});
  }
  if(covered<210)return {label:'pending',why:'Недостаточное покрытие цены: '+covered+'/300',covered:covered};
  var ratio=above/300*100;
  return {label:ratio>=s.r2Strong?'strong':'weak',score:ratio,covered:covered,curve:curve,p0:p0};
}
function passedCoins(coins){
  if(serverPassActive){
    var lookup=new Map(coins.map(function(c){return [mint(c),c]}));
    return serverPassRows.map(function(p){
      var c=lookup.get(p.mint);
      if(!c){
        c={a:p.mint,n:p.name||'',s:'',ds:[],i:'',_entry:{
          phase:p.phase,acceptedAt:p.acceptedAt,eventAt:p.acceptedAt}};
      }
      return {coin:c,deadline:p.zeroAt,matches:p.matches,
        features:p.features,firstSeenAt:p.firstSeenAt,source:'server'};
    }).sort(function(a,b){return b.firstSeenAt-a.firstSeenAt});
  }
  // A filter change must never rewrite an earlier signal. Old admissions are
  // never backfilled into "Passed" after their original decision window.
  var previous=new Map(signalLog.map(function(x){return [x.mint,x]}));
  var enabled=s.modules.filter(function(m){return m.enabled});
  var out=[],dirty=false,seenAt=now();
  for(var c of coins){
    var key=mint(c),entry=c._entry,record=previous.get(key);
    if(record&&(record.acceptedAt!==entry.acceptedAt||record.phase!==entry.phase))record=null;
    if(!record&&enabled.length&&seenAt>=entry.acceptedAt){
      var deadline=entry.acceptedAt+s.decision*60000;
      if(seenAt<=deadline){
        var available=dataMetrics(c,seenAt);
        var matches=[];
        for(var m of enabled){
          if(m.phase!==entry.phase||m.level!=='1')continue;
          var f=s.filters.find(function(x){return x.id===m.filterId&&x.level===m.level});
          if(f&&ruleMatch(available,f))matches.push({
            id:f.id,name:f.name,level:f.level,version:f.version,
            key:f.key,op:f.op,value:f.value
          });
        }
        if(matches.length){
          // Freeze match criteria, decision deadline and pre-decision features.
          record={mint:key,phase:entry.phase,acceptedAt:entry.acceptedAt,
            firstSeenAt:seenAt,deadline:deadline,name:c.n||c.s||key,
            features:available,matches:matches};
          signalLog.push(record);previous.set(key,record);dirty=true;
        }
      }
    }
    if(record)out.push({coin:c,deadline:record.deadline,
      matches:record.matches,features:record.features,firstSeenAt:record.firstSeenAt});
  }
  if(dirty){signalLog=signalLog.slice(-2000);saveSignals()}
  return out.sort(function(a,b){return b.coin._entry.acceptedAt-a.coin._entry.acceptedAt});
}
function storeBank(level,rows){
  var arr=bank[level],seen=new Set(arr.map(function(x){return x.mint})),added=0;
  for(var row of rows){
    if(seen.has(row.mint))continue;
    seen.add(row.mint);arr.push(row);added++;
  }
  if(arr.length>10000)arr.splice(0,arr.length-10000);
  // Память поддерживает до 5000 каждой группы, учитывая текущую разметку.
  var live=[],dead=[];
  for(var x of arr){var type=bankLabel(level,x);(type==='live'||type==='strong'?live:dead).push(x)}
  var group1=live.slice(-5000),group2=dead.slice(-5000);
  bank[level]=group1.concat(group2).sort(function(a,b){return a.t-b.t});
  if(added)saveBank();
}
function bankLabel(level,row){
  if(level==='1')return row.activity>=s.r1Activity&&row.idle<=s.r1Idle?'live':'dead';
  if(serverR2Active&&['strong','weak'].includes(row.label))return row.label;
  return row.above>=s.r2Strong?'strong':'weak';
}
function analyze(){
  lastAccepted=admitted();
  lastVisible=visibleAll(lastAccepted);
  lastPassed=passedCoins(lastAccepted);
  lastR1=[];
  for(var c of lastAccepted){
    var k=labelOne(c);
    if(k.label!=='pending'){
      lastR1.push({coin:c,result:k});
    }
  }
  lastR2=[];
  for(var q of lastPassed){
    var r=labTwo(q.coin,q);
    if(r.label!=='pending')lastR2.push({passed:q,result:r});
  }
  // Polygons contain ONLY server-labeled cohorts. Local estimates are never
  // promoted to confirmed research-bank members.
}

// ---- Живые рыночные данные в браузере (DexScreener, без расхода сервера) ----
var LIVE={},LIVE_HIST={},liveBusy=false;
function liveOf(c){return LIVE[mint(c)]||null}
function agoText(t){if(!t)return '—';var sec=Math.max(0,Math.floor((now()-t)/1000));
  if(sec<3600)return Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0')+' назад';
  var h=Math.floor(sec/3600),m=Math.floor(sec%3600/60);return h+' ч '+m+' мин назад'}
function tickAges(){document.querySelectorAll('.ago[data-t]').forEach(function(el){el.textContent=agoText(+el.dataset.t)})}
function usd(v){var n=Number(v);if(!Number.isFinite(n)||n<=0)return '—';if(n>=1e6)return '$'+(n/1e6).toFixed(2)+'M';if(n>=1e3)return '$'+(n/1e3).toFixed(1)+'K';return '$'+n.toFixed(0)}
function visibleMints(){var out=[];document.querySelectorAll('[data-coin]').forEach(function(b){var m=b.dataset.coin;if(m&&out.indexOf(m)<0)out.push(m)});
  var d=document.getElementById('openCoinDetail');if(d&&d.dataset.mint&&out.indexOf(d.dataset.mint)<0)out.unshift(d.dataset.mint);return out.slice(0,60)}
async function pollMarket(){if(liveBusy||document.hidden)return;var mints=visibleMints();if(!mints.length)return;liveBusy=true;
  try{for(var i=0;i<mints.length;i+=30){var part=mints.slice(i,i+30);
      var r=await fetch('https://api.dexscreener.com/tokens/v1/solana/'+part.join(','),{cache:'no-store'});if(!r.ok)continue;
      var arr=await r.json();if(!Array.isArray(arr))continue;var best={};
      arr.forEach(function(p){var m=p&&p.baseToken&&p.baseToken.address;if(!m||part.indexOf(m)<0)return;var l=(p.liquidity&&p.liquidity.usd)||0;
        if(!best[m]||l>((best[m].liquidity&&best[m].liquidity.usd)||0))best[m]=p});
      Object.keys(best).forEach(function(m){var p=best[m],t5=(p.txns&&p.txns.m5)||{};
        LIVE[m]={price:+p.priceUsd||null,mc:p.marketCap||p.fdv||null,liq:p.liquidity&&p.liquidity.usd,v5:p.volume&&p.volume.m5,
          b5:t5.buys,s5:t5.sells,ch5:p.priceChange&&p.priceChange.m5,ch1h:p.priceChange&&p.priceChange.h1,pair:p.pairAddress,dex:p.dexId,url:p.url,
          img:p.info&&p.info.imageUrl,at:now()};
        var h=LIVE_HIST[m]=LIVE_HIST[m]||[];if(LIVE[m].price)h.push(LIVE[m].price);if(h.length>40)h.shift()})}
    patchCards();updateDetailStats()}catch(e){}finally{liveBusy=false}}
function marketLine(c){var L=liveOf(c),p=(c.ds||[]).at(-1);
  if(L)return 'MC '+usd(L.mc)+' · ликв. '+usd(L.liq)+' · 5м '+usd(L.v5)+' · '+(L.b5==null?'—':L.b5)+'/'+(L.s5==null?'—':L.s5)+' сд.';
  if(p)return 'L '+observedMoney(p[2])+' · 5м '+observedMoney(p[6]);var e=c._entry;return e&&now()-e.eventAt<120000?'ждём DexScreener…':'нет данных DexScreener'}
function patchCards(){document.querySelectorAll('[data-coin]').forEach(function(b){var m=b.dataset.coin,L=LIVE[m];if(!L)return;
  var ml=b.querySelector('.mline');if(ml)ml.textContent=marketLine({a:m});
  var pr=b.querySelector('.price');if(pr&&L.price)pr.textContent=price(L.price);
  var sp=b.querySelector('.sparkbox');if(sp)sp.innerHTML=spark({a:m});
  var gb=b.querySelector('.growbox');if(gb){var cc=lastAccepted.find(function(x){return mint(x)===m})||{a:m};gb.innerHTML=growthHtml(cc)}
  var av=b.querySelector('.avatar.empty');if(av&&L.img)av.outerHTML='<img class="avatar" src="'+esc(L.img)+'" alt="" loading="lazy">'})}
function spark(c){
  var points=(c.ds||[]).slice(-12).map(function(x){return Number(x[1])}).filter(function(x){return x>0});
  if(points.length<2)points=(LIVE_HIST[mint(c)]||[]).slice(-20);
  if(points.length<2)return '';
  var low=Math.min.apply(null,points),high=Math.max.apply(null,points),span=high-low||high*.01||1;
  var d=points.map(function(p,i){return (i===0?'M':'L')+(i/(points.length-1)*59).toFixed(1)+' '+(24-20*(p-low)/span).toFixed(1)}).join(' ');
  var up=points.at(-1)>=points[0];
  return '<svg viewBox="0 0 62 28" class="spark" role="img" aria-label="График цены"><path d="'+d+'" fill="none" stroke="'+(up?'#38d996':'#fc6b83')+'" stroke-width="2.3" stroke-linecap="round"/></svg>';
}
function observedMoney(value){return typeof value==='number'&&Number.isFinite(value)&&value>0?'$'+fmt(value):'—'}

// База для роста: первая известная цена монеты (снимок сервера после появления, иначе первая цена DexScreener в этой сессии).
var LIVE_BASE={};
function basePrice(c){var m=mint(c);if(LIVE_BASE[m])return LIVE_BASE[m];var e=c._entry||{},t=(e.eventAt||0)/1000;
  var r=(c.ds||[]).find(function(x){return x[0]>=t&&+x[1]>0});if(r){LIVE_BASE[m]=+r[1];return LIVE_BASE[m]}
  var h=LIVE_HIST[m];if(h&&h.length){LIVE_BASE[m]=h[0];return h[0]}return null}
function growthHtml(c){var L=liveOf(c),p=(c.ds||[]).at(-1),cur=L&&L.price||p&&+p[1],b=basePrice(c);
  if(!cur||!b)return '';var g=(cur/b-1)*100;return '<span class="grow '+(g>=0?'up':'down')+'">'+(g>=0?'+':'')+(Math.abs(g)>=1000?Math.round(g):g.toFixed(Math.abs(g)<10?1:0))+'%</span>'}
// Список без мигания: существующие карточки обновляются на месте, новые плавно появляются, ушедшие плавно исчезают.
function updateList(box,items,keyFn,htmlFn,emptyHtml){if(!box)return;
  if(!items.length){box.innerHTML=emptyHtml;return}
  if(!box.children||typeof document.createElement!=='function'||typeof requestAnimationFrame!=='function'){box.innerHTML=items.map(htmlFn).join('');return}
  var old={};Array.prototype.forEach.call(box.children,function(el){if(el.dataset&&el.dataset.key)old[el.dataset.key]=el});
  var keep={},frag=[];items.forEach(function(it){var k=keyFn(it);keep[k]=1;var tmp=document.createElement('div');tmp.innerHTML=htmlFn(it).trim();var el=tmp.firstChild;el.dataset.key=k;
    if(old[k]){old[k].innerHTML=el.innerHTML;old[k].className=el.className;frag.push(old[k])}else{el.classList.add('enter');frag.push(el)}});
  Object.keys(old).forEach(function(k){if(!keep[k]){var el=old[k];el.classList.add('leave');setTimeout(function(){if(el.parentNode)el.parentNode.removeChild(el)},320)}});
  Array.prototype.forEach.call(box.querySelectorAll('.empty-state'),function(e){e.remove()});
  var ref=null;for(var i=frag.length-1;i>=0;i--){var el=frag[i];if(el.nextSibling!==ref||el.parentNode!==box)box.insertBefore(el,ref);ref=el}
  requestAnimationFrame(function(){box.querySelectorAll('.enter').forEach(function(el){el.classList.add('shown')})})}

// Логотипы: DexScreener (если у монеты есть профиль) или картинка из метаданных pump.fun (uri из события создания).
var IMG={},IMG_BUSY=0,IMG_TRIED={};
function ipfsHttp(u){return /^ipfs:\/\//.test(u)?'https://ipfs.io/ipfs/'+u.slice(7):u}
function imgOf(c){var m=mint(c);return IMG[m]||safeImg(c.i)||(LIVE[m]&&LIVE[m].img?safeImg(LIVE[m].img):'')}
function loadLogos(){document.querySelectorAll('.avatar.empty[data-uri]').forEach(function(el){var m=el.closest('[data-coin]');m=m&&m.dataset.coin;var u=el.dataset.uri;
  if(!m||IMG_TRIED[m]||IMG_BUSY>=4)return;IMG_TRIED[m]=1;IMG_BUSY++;
  fetch(ipfsHttp(u),{cache:'force-cache'}).then(function(r){return r.ok?r.json():null}).then(function(j){var im=j&&typeof j.image==='string'?ipfsHttp(j.image):'';
    if(im&&/^https:\/\//.test(im)){IMG[m]=im;document.querySelectorAll('[data-coin="'+m+'"] .avatar.empty').forEach(function(a){a.outerHTML='<img class="avatar" src="'+esc(im)+'" alt="" loading="lazy">'})}})
  .catch(function(){}).finally(function(){IMG_BUSY--})})}
function coinHtml(c,extra){
  var e=c._entry,p=(c.ds||[]).at(-1),L=liveOf(c),img=imgOf(c);
  var name=esc(c.n||c.s||'Токен'),symbol=esc(c.s||'');
  return '<button type="button" class="coin '+(e.phase==='before'?'pre':'post')+'" data-coin="'+esc(mint(c))+'">'+
    (img?'<img class="avatar" src="'+esc(img)+'" alt="" loading="lazy">':'<span class="avatar empty"'+(c._uri?' data-uri="'+esc(c._uri)+'"':'')+'>'+esc((c.s||'?').slice(0,2))+'</span>')+
    '<span class="body"><span class="name">'+name+' <small>'+symbol+'</small></span><span class="detail"><b class="ago" data-t="'+(+e.eventAt||0)+'">'+agoText(e.eventAt)+'</b> · '+(e.phase==='before'?'🌱 до миграции':'🎓 после миграции')+'</span><span class="detail mline">'+esc(marketLine(c))+'</span>'+
    (extra?'<span class="detail">'+esc(extra)+'</span>':'')+'</span><span class="right"><span class="price">'+price(L&&L.price||p&&p[1])+'</span><span class="growbox">'+growthHtml(c)+'</span><span class="sparkbox">'+spark(c)+'</span></span></button>';
}
function pc(v){return v==null||!Number.isFinite(+v)?'—':(v>0?'+':'')+Number(v).toFixed(Math.abs(v)>=10?0:1)+'%'}
function solInPool(c){if(!Array.isArray(c.lq)||!Array.isArray(c.vmint))return null;var qi=c.vmint.indexOf('So11111111111111111111111111111111111111112');if(qi<0)return null;
  var r=c.lq.at(-1);return r&&Number.isFinite(r[2+qi])?r[2+qi]/1e9:null}
function topHold(c){var best=null;Object.values(c.hold||{}).forEach(function(h){if(h&&!h.miss&&Number.isFinite(h.top10)&&(!best||h.at>best.at))best=h});return best}
function detailStats(m){var L=LIVE[m]||{},c=DETAIL_COIN||{},sol=solInPool(c),h=topHold(c),ct=c.ct;
  var safe=ct?!(ct.mint||ct.freeze||ct.fee>0||ct.hook||ct.deleg||ct.pause||ct.nontr||ct.defFrozen):null;
  var cells=[['Цена',price(L.price)],['MC',usd(L.mc)],['Ликв.',usd(L.liq)],
    ['SOL в пуле',sol==null?'—':sol.toFixed(sol<10?2:0)],['Объём 5м',usd(L.v5)],['Пок/прод 5м',(L.b5==null?'—':L.b5)+'/'+(L.s5==null?'—':L.s5)],
    ['5м / 1ч',pc(L.ch5)+' / '+pc(L.ch1h)],['Топ-10',h?(h.top10*100).toFixed(0)+'%':'—'],['Контракт',safe==null?'—':safe?'<span class="good">чистый</span>':'<span class="bad">опасный</span>']];
  return cells.map(function(x){return '<div class="mini"><span>'+x[0]+'</span><b>'+x[1]+'</b></div>'}).join('')}
function chartSrc(m){var L=LIVE[m]||{};return 'https://dexscreener.com/solana/'+(L.pair||m)+'?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=1'}
// ---- Путь монеты по нашей системе: базовый фильтр → 1 уровень → исследование 1 → 2 уровень → исследование 2 ----
function stepRow(icon,title,text){return '<div class="step"><span class="si">'+icon+'</span><span class="st"><b>'+title+'</b> '+text+'</span></div>'}
function left(ms){if(ms<=0)return 'сейчас';var m=Math.round(ms/60000);return m<60?m+' мин':Math.floor(m/60)+' ч '+(m%60)+' мин'}
function pathHtml(c){var e=c._entry||{},m=mint(c),t=now(),chain=[],det=[];
  var lim=sourceMeta&&sourceMeta.settings?(e.phase==='before'?sourceMeta.settings.beforeMinutes:sourceMeta.settings.afterMinutes):null;
  var age=e.acceptedAt&&e.eventAt?(e.acceptedAt-e.eventAt)/1000:null;
  chain.push(['Время','✅']);
  det.push(stepRow('✅','Время:',(e.phase==='before'?'до миграции':'после миграции')+' · вошла '+(age==null?'—':age<1?'сразу':age<60?'через '+Math.round(age)+' с':'через '+(age/60).toFixed(1)+' мин')+(lim?' (лимит '+lim+' мин)':'')));
  var cfg=passMeta&&passMeta.serverConfig,row=serverPassRows.find(function(r){return r.mint===m});
  var f1=[];if(cfg&&cfg.enabled){var byId={};(cfg.filters||[]).forEach(function(f){byId[f.id]=f});var dec=(cfg.decisionMinutes||10)*60000,deadline=(e.acceptedAt||0)+dec;
    var early=e.acceptedAt<(cfg.activatedAt||0);
    (cfg.modules||[]).filter(function(x){return x.enabled&&x.level==='1'&&x.phase===e.phase}).forEach(function(md){var f=byId[md.filterId];if(!f)return;
      var hit=row&&(row.matches||[]).some(function(x){return x.id===f.id});
      f1.push({name:f.name,st:early?'skip':hit?'ok':t<deadline?'wait':'no',left:deadline-t})})}
  var n={ok:0,no:0,wait:0,skip:0};f1.forEach(function(x){n[x.st]++});
  var icon1=!f1.length?'—':n.ok?'✅':n.wait?'⏳':n.skip===f1.length?'⚪':'❌';
  chain.push(['Ур.1',icon1+(f1.length&&n.ok?' '+n.ok+'/'+f1.length:'')]);
  if(!f1.length)det.push(stepRow('⚪','Фильтры 1 ур.:',cfg&&cfg.enabled?'для этого потока не подключены':'выключены'));
  else{var sum=(n.ok?'✅ '+n.ok+' ':'')+(n.no?'❌ '+n.no+' ':'')+(n.wait?'⏳ '+n.wait+' ':'')+(n.skip?'⚪ '+n.skip:'');
    var wait=f1.find(function(x){return x.st==='wait'});
    det.push('<details class="step fold"><summary><span class="si">'+icon1+'</span><b>Фильтры 1 ур.:</b> '+sum+(wait?'· решение через '+left(wait.left):'')+'</summary>'+
      f1.map(function(x){return '<div class="sub">'+({ok:'✅',no:'❌',wait:'⏳',skip:'⚪'})[x.st]+' '+esc(x.name)+'</div>'}).join('')+'</details>')}
  var hrs=researchMeta&&researchMeta.settings?researchMeta.settings.hours:5,b1=(bank['1']||[]).find(function(x){return x.mint===m});
  if(b1){var st=researchMeta.settings,live=b1.activity>=st.minActive&&b1.idle<=st.maxIdle;chain.push(['Иссл.1',live?'🟢':'🔴']);det.push(stepRow(live?'🟢':'🔴','Исследование 1:',(live?'живая':'мёртвая')+' · активность '+b1.activity.toFixed(0)+'%, простой '+b1.idle+' мин'))}
  else{var end1=(e.acceptedAt||0)+hrs*3600e3;chain.push(['Иссл.1',t<end1?'⏳':'—']);det.push(stepRow('⏳','Исследование 1:',t<end1?'итог через '+left(end1-t):'нет итога (мало данных)'))}
  if(row){var r2=serverR2Rows.find(function(x){return x.mint===m}),sl=row.secondLevelRules||[];
    chain.push(['Ур.2',sl.length?'🔹 '+sl.length:'—']);
    if(sl.length)det.push(stepRow('🔹','Фильтры 2 ур.:',sl.length+' правил записано при входе'));
    if(r2){chain.push(['Иссл.2',r2.label==='strong'?'🟢':'🔴']);det.push(stepRow(r2.label==='strong'?'🟢':'🔴','Исследование 2:',(r2.label==='strong'?'сильная':'слабая')+' · выше точки 0 '+Number(r2.pctAbove||0).toFixed(0)+'% времени'))}
    else{var end2=(row.zeroAt||0)+300*60000;chain.push(['Иссл.2',t<end2?'⏳':'—']);det.push(stepRow('⏳','Исследование 2:',t<end2?'итог через '+left(end2-t):'нет итога (мало данных)'))}}
  else{chain.push(['Ур.2','—']);chain.push(['Иссл.2','—'])}
  return '<div class="chain">'+chain.map(function(x){return '<span class="ch"><small>'+x[0]+'</small>'+x[1]+'</span>'}).join('<span class="arr">›</span>')+'</div>'+det.join('')}
// ---- Сделки в реальном времени (GeckoTerminal, только пока окно открыто) ----
var TRADES_AT=0;
async function loadTrades(){var d=document.getElementById('openCoinDetail');if(!d)return;var m=d.dataset.mint,L=LIVE[m]||{},box=document.getElementById('coinTrades');if(!box)return;
  if(!L.pair){box.innerHTML='<p class="hint">Пул ещё не найден.</p>';return}
  try{var r=await fetch('https://api.geckoterminal.com/api/v2/networks/solana/pools/'+L.pair+'/trades',{headers:{accept:'application/json'}});
    if(!r.ok)throw Error('HTTP '+r.status);var j=await r.json(),rows=(j.data||[]).slice(0,14).map(function(x){return x.attributes||{}});
    if(!rows.length){box.innerHTML='<p class="hint">Сделок пока нет.</p>';return}
    box.innerHTML=rows.map(function(a){var buy=a.kind==='buy',ts=Date.parse(a.block_timestamp),w=String(a.tx_from_address||'');
      return '<div class="tr '+(buy?'b':'s')+'"><span>'+(buy?'▲':'▼')+'</span><span>'+usd(+a.volume_in_usd)+'</span><span class="w">'+esc(w.slice(0,4)+'…'+w.slice(-3))+'</span><span class="ag">'+(ts?Math.max(0,Math.round((now()-ts)/1000))+'с':'')+'</span></div>'}).join('');TRADES_AT=now()}
  catch(e){box.innerHTML='<p class="hint">Сделки недоступны ('+esc(String(e.message||e))+')</p>'}}
var DETAIL_COIN=null;
function detail(c){
  var e=c._entry,m=mint(c),L=LIVE[m]||{};DETAIL_COIN=c;
  return '<div id="openCoinDetail" class="sheet" data-mint="'+esc(m)+'"><div class="sheetbox">'+
    '<div class="row"><h2>'+esc(c.n||c.s||'Монета')+' <small class="muted">'+esc(c.s||'')+'</small></h2><button id="closeCoin">✕</button></div>'+
    '<div class="muted small"><b class="ago" data-t="'+(+e.eventAt||0)+'">'+agoText(e.eventAt)+'</b> · '+(e.phase==='before'?'🌱 до миграции':'🎓 после миграции')+' · вход '+time(e.acceptedAt)+'</div>'+
    '<div class="chartbox"><iframe id="coinChart" src="'+esc(chartSrc(m))+'" loading="lazy" title="График"></iframe></div>'+
    '<div class="minigrid" id="coinStats">'+detailStats(m)+'</div>'+
    '<div class="sec">Сделки</div><div id="coinTrades" class="trades"><p class="hint">загрузка…</p></div>'+
    '<div class="sec">Наша система</div><div class="path" id="coinPath">'+pathHtml(c)+'</div>'+
    '<div class="action-bar"><a class="btn" target="_blank" rel="noopener" href="https://dexscreener.com/solana/'+esc(L.pair||m)+'">DexScreener</a>'+
    '<a class="btn" target="_blank" rel="noopener" href="https://gmgn.ai/sol/token/'+esc(m)+'">GMGN</a>'+
    '<a class="btn" target="_blank" rel="noopener" href="https://solscan.io/token/'+esc(m)+'">Solscan</a>'+
    '<button type="button" id="copyMint">Копировать</button></div>'+
    '<div class="mono small" style="overflow-wrap:anywhere;color:var(--muted)">'+esc(m)+'</div></div></div>';
}
function updateDetailStats(){var d=document.getElementById('openCoinDetail');if(!d)return;var m=d.dataset.mint;
  var st=document.getElementById('coinStats');if(st)st.innerHTML=detailStats(m);
  var pt=document.getElementById('coinPath');if(pt&&DETAIL_COIN){var op=pt.querySelector('details.fold[open]');pt.innerHTML=pathHtml(DETAIL_COIN);if(op){var f=pt.querySelector('details.fold');if(f)f.open=true}}
  var fr=document.getElementById('coinChart');if(fr&&LIVE[m]&&LIVE[m].pair&&fr.src.indexOf(LIVE[m].pair)<0)fr.src=chartSrc(m);
  if(now()-TRADES_AT>10000)loadTrades()}
function showCoinDetail(c,anchorId){
  if(!c||!c._entry)return;
  const old=$('openCoinDetail');if(old)old.remove();
  document.body.insertAdjacentHTML('beforeend',detail(c));document.body.style.overflow='hidden';
  function close(){const cur=$('openCoinDetail');if(cur)cur.remove();document.body.style.overflow='';DETAIL_COIN=null}
  $('closeCoin').addEventListener('click',close);
  $('openCoinDetail').addEventListener('click',function(ev){if(ev.target.id==='openCoinDetail')close()});
  $('copyMint').addEventListener('click',function(){try{navigator.clipboard.writeText(mint(c));this.textContent='Скопировано ✓'}catch(e){}});
  pollMarket();setTimeout(loadTrades,1200);
}
function renderAll(){
  var today=day(now());
  renderDailySource();
  var count=sourceActive?sourceMeta.today:0;
  $('admitCount').textContent=sourceActive?fmt(count):'—';
  $('visibleCount').textContent=sourceActive&&Number.isSafeInteger(sourceMeta?.total)?fmt(sourceMeta.total):'—';
  renderSpeedCounters();
  var st=sourceMeta&&sourceMeta.settings;if($('ageSummary'))$('ageSummary').textContent=st?'до '+st.beforeMinutes+' мин · после '+st.afterMinutes+' мин':'—';
  setTimeout(function(){var n=$('sourceNote');if(n)n.classList.toggle('hide',/^✓/.test(n.textContent))},0);
  $('sourceNote').textContent=sourceActive?
    (sourceMeta?.preConnected?'✓ Главный источник: журнал сервера. До миграции — публичные торговые кривые Pump.fun; после — подтверждённые миграции. Дублей нет.':'⚠ Источник до миграции пока не подтвердил связь с сетью. Постмиграционные события продолжают проверяться.')+' Возраст проверяется при ВХОДЕ, карточка не исчезает через 2 минуты.':
    '⛔ Главный источник сервера недоступен или устарел. Вход новых монет приостановлен. Непроверенные кандидаты из старых данных сюда не подставляются.';
  var list=lastVisible.slice(0,s.limit);
  updateList($('coinList'),list,function(c){return mint(c)},function(c){return coinHtml(c)},'<div class="empty-state">Пока нет подтверждённых записей в этом потоке. Монеты, не успевшие пройти фильтр возраста на входе, не добавляются позже задним числом.</div>');
}
// Наглядная скорость: белое — сколько обнаружили за сутки, зелёное — сколько успели по нашему фильтру возраста.
function speedHtml(seen,passed){if(!Number.isSafeInteger(seen))return '';return fmt(seen)+(Number.isSafeInteger(passed)?' · <b class="pass">'+fmt(passed)+'</b>':'')}
function renderSpeedCounters(){var d=sourceMeta&&sourceMeta.daily,ok=sourceActive&&d&&d.day===day(now()),b=ok&&d.before||{},a=ok&&d.after||{};
  function sum(k){return Number.isSafeInteger(b[k])&&Number.isSafeInteger(a[k])?b[k]+a[k]:null}
  $('todayTab').innerHTML=ok?' '+speedHtml(sum('seen'),sum('accepted')):'';
  $('cntAll').innerHTML=ok?speedHtml(sum('seen'),sum('accepted')):'';
  $('cntBefore').innerHTML=ok?speedHtml(b.seen,b.accepted):'';
  $('cntAfter').innerHTML=ok?speedHtml(a.seen,a.accepted):'';}
function dailySourceText(label,row,available){
  if(!available||!row||!['seen','accepted','tooOld','unverified'].every(function(k){return Number.isSafeInteger(row[k])&&row[k]>=0}))return label+': нет данных';
  var late=row.tooOld&&Number.isFinite(row.averageLateMs)?' (в среднем на '+(row.averageLateMs/(row.averageLateMs<60000?1000:60000)).toLocaleString('ru-RU',{maximumFractionDigits:1})+(row.averageLateMs<60000?' сек':' мин')+')': '';
  return label+': увидели '+fmt(row.seen)+' · прошли '+fmt(row.accepted)+' · опоздали '+fmt(row.tooOld)+late+' · не подтв. '+fmt(row.unverified)+
    (row.alreadyAdmitted?' · уже в «Все» '+fmt(row.alreadyAdmitted):'')+(row.other?' · другие отказы '+fmt(row.other):'');
}
function renderDailySource(){
  var daily=sourceMeta?.daily;
  var valid=sourceActive&&Number.isFinite(sourceMeta?.updated)&&now()-sourceMeta.updated<=7*60000&&daily?.schema===1&&daily.day===day(now())&&daily.complete===true;
  var availability=sourceMeta?.dailyAvailability;
  $('dailyBefore').textContent=dailySourceText('До миграции',daily?.before,valid&&availability?.before===true);
  $('dailyAfter').textContent=dailySourceText('После миграции',daily?.after,valid&&availability?.after===true);
  $('dailySourceNote').textContent=valid?
    'Уникальные mint в каждом потоке. Опоздание — превышение порога возраста.'+(daily.partialDay?' Сегодня учёт с '+time(daily.startedAt)+' (UTC+5), день неполный.':'')+
    ((!availability?.before||!availability?.after)?' Недоступный поток: нет данных.':''):
    'Нет свежих полных данных сервера за текущие сутки. Сброс в 00:00 UTC+5.';
}
function renderLocalPreview(){
  if(!$('localPreview'))return;
  const active=s.modules.filter(function(m){return m.enabled&&m.level==='1'});
  if(!active.length){
    $('localPreview').textContent='Включи и примени хотя бы один локальный модуль 1-го уровня.';
    return;
  }
  if(!sourceActive){
    $('localPreview').textContent='Главный источник недоступен. Локальный предварительный просмотр приостановлен.';
    return;
  }
  const t=now(),limit=Math.min(1000,lastAccepted.length);
  const results=[];
  for(const coin of lastAccepted.slice(0,limit)){
    const e=coin._entry;
    const deadline=e.acceptedAt+s.decision*60000;
    if(e.acceptedAt>t||deadline<t)continue;
    const metrics=dataMetrics(coin,t);
    const matches=active.filter(function(m){return m.phase===e.phase})
      .map(function(m){return s.filters.find(function(f){return f.id===m.filterId&&f.level==='1'})})
      .filter(function(f){return f&&ruleMatch(metrics,f)});
    if(matches.length)results.push({coin,deadline,matches});
  }
  $('localPreview').innerHTML=results.length?
    '<p class="muted">Локально совпали '+fmt(results.length)+' монет. Эти карточки НЕ являются фоновыми сигналами сервера.</p>'+
    results.slice(0,20).map(function(p){
      return '<div class="filter-row"><b>'+esc(p.coin.n||p.coin.s||mint(p.coin).slice(0,13))+'</b>'+
        '<span class="badge mono">'+time(p.deadline)+'</span><p class="muted">'+
        p.matches.map(function(f){return esc(f.name)+' · v'+esc(f.version)}).join(', ')+'</p></div>';
    }).join(''):
    '<p class="muted">Сейчас нет совпадений. Старые монеты не пересчитываются задним числом.</p>';
}
function ruleLabel(f){
  const labels={top1:'Топ-1 держатель, % (без пула)',top10:'Топ-10 держателей, % (без пула)',buyers:'Покупатели 5м',buyers10:'Покупатели за первые 10 мин',safeContract:'Контракт без опасных прав',quoteSol:'Реальные SOL в пуле',trades:'Сделки 5м',volume:'Объём $',liq:'Ликвидность $',mc:'Капитализация $',buys:'Покупки 5м',sells:'Продажи 5м',buySellRatio:'Покупки/продажи'};
  const one=function(r){return (labels[r.key]||r.key)+' '+r.op+' '+fmt(r.value)};
  return [one(f)].concat((f.conditions||[]).map(one)).join(' · и ');
}
var MINE_STREAM='before',MOD_DRAFT=null,MOD_DIRTY=false,PICK_LEVEL='1';
var TAGK={buyers10:'пок.10м',quoteSol:'SOL',top10:'топ-10%',top1:'топ-1%',buyers:'пок.5м',trades:'сделки',volume:'объём',liq:'ликв.',mc:'MC',buySellRatio:'пок/прод',buys:'покупки',sells:'продажи'};
function ruleTags(f){return [f].concat(f.conditions||[]).map(function(r){if(r.key==='safeContract')return '<span class="tag">контракт ✓</span>';
  return '<span class="tag">'+esc(TAGK[r.key]||r.key)+' '+(r.op==='>='?'≥':'≤')+' '+esc(fmt(r.value))+'</span>'}).join('')}
function serverCfg(){return serverPassActive&&passMeta&&passMeta.serverConfig||null}
function draft(){if(!MOD_DIRTY||!MOD_DRAFT){var c=serverCfg();MOD_DRAFT=c?JSON.parse(JSON.stringify({schema:1,enabled:c.enabled,activatedAt:c.activatedAt||0,decisionMinutes:c.decisionMinutes,filters:c.filters||[],modules:c.modules||[]})):null}return MOD_DRAFT}
function modRow(m,i,byId,today){var f=byId[m.filterId];if(!f)return '';
  var n=serverPassRows.filter(function(r){return r.phase===m.phase&&day(r.acceptedAt)===today&&(r.matches||[]).some(function(x){return x.id===f.id})}).length;
  return '<details class="frow"><summary><span class="fname">'+esc(f.name)+'</span><span class="fcnt">'+n+'</span>'+
    (m.level==='1'?'<span class="r1b'+(m.toR1?' on':'')+'" data-r1="'+i+'" title="в Исследование 1">→И1</span>':'')+
    '<span class="tg'+(m.enabled?' on':'')+'" data-tg="'+i+'"></span></summary><div class="tags">'+ruleTags(f)+'</div>'+
    '<div class="row" style="margin-top:6px"><span class="hint">v'+esc(f.version)+' · сегодня '+n+'</span><button type="button" class="pbtn del" data-del="'+i+'">убрать</button></div></details>'}
function renderServerModules(){var d=draft();if(!$('mods1'))return;
  if(!d){$('mods1').innerHTML=$('mods2').innerHTML='<p class="hint">нет данных сервера</p>';return}
  var byId={};d.filters.forEach(function(f){byId[f.id]=f});var today=day(now());
  ['1','2'].forEach(function(l){var h='';d.modules.forEach(function(m,i){if(m.level===l&&m.phase===MINE_STREAM)h+=modRow(m,i,byId,today)});$('mods'+l).innerHTML=h||'<p class="hint">пусто</p>'});
  $('modApplyRow').hidden=!MOD_DIRTY}
function showModPicker(level){PICK_LEVEL=level;var d=draft();if(!d)return;var have={};d.modules.forEach(function(m){if(m.phase===MINE_STREAM&&m.level===level)have[m.filterId]=1});
  var pool={};d.filters.concat(s.filters||[]).forEach(function(f){if(String(f.level)===level&&!have[f.id])pool[f.id]=f});
  var list=Object.values(pool);$('modPickerT').textContent='Добавить · '+level+' ур. · '+(MINE_STREAM==='before'?'до':'после');
  $('modPickerList').innerHTML=list.length?list.map(function(f){return '<button type="button" class="frow pick" data-pick="'+esc(f.id)+'"><span class="fname">'+esc(f.name)+'</span><div class="tags">'+ruleTags(f)+'</div></button>'}).join(''):'<p class="hint">В Библиотеке нет подходящих фильтров.</p>';
  $('modPicker').hidden=false}
function pickFilter(id){var d=draft(),f=d.filters.find(function(x){return x.id===id});
  if(!f){var lf=(s.filters||[]).find(function(x){return x.id===id});if(!lf)return;
    f={id:String(lf.id),name:String(lf.name).slice(0,64),level:String(lf.level),key:lf.key,op:lf.op,value:Number(lf.value),version:Number(lf.version)||1,...(lf.conditions?{conditions:lf.conditions.map(function(c){return {key:c.key,op:c.op,value:c.value}})}:{})};d.filters.push(f)}
  d.modules.push({filterId:f.id,phase:MINE_STREAM,level:PICK_LEVEL,enabled:true});MOD_DIRTY=true;$('modPicker').hidden=true;renderServerModules()}
function modClick(e){var t=e.target,d=draft();if(!d)return;
  if(t.dataset.tg!=null){e.preventDefault();var m=d.modules[+t.dataset.tg];m.enabled=!m.enabled;MOD_DIRTY=true;renderServerModules()}
  else if(t.dataset.r1!=null){e.preventDefault();var m2=d.modules[+t.dataset.r1];if(m2.toR1)delete m2.toR1;else m2.toR1=true;MOD_DIRTY=true;renderServerModules()}
  else if(t.dataset.del!=null){d.modules.splice(+t.dataset.del,1);MOD_DIRTY=true;renderServerModules()}}
async function applyModules(){var key=$('modKey').value.trim(),d=draft();
  if(!controlEndpoint){$('modMsg').textContent='Сервер управления недоступен';return}
  if(!/^[a-zA-Z0-9_-]{32,256}$/.test(key)){$('modMsg').textContent='Введи пароль';return}
  $('modApply').disabled=true;$('modMsg').textContent='Отправка…';
  try{var r=await fetch(controlEndpoint+'/api/filter-config',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(d)});
    $('modKey').value='';if(r.ok){MOD_DIRTY=false;$('modMsg').textContent='✓ Принято, сервер применит за пару минут'}else $('modMsg').textContent='Отклонено: HTTP '+r.status+(r.status===401?' (пароль)':'')}
  catch(e){$('modMsg').textContent='Ошибка связи'}finally{$('modApply').disabled=false}}
// ---- Вход в Исследование 1 ----
function intakeFromUI(){return {manual:{enabled:$('inManual').checked,phase:$('inPhaseOn').checked?$('inPhase').value:'both',
    buyers10:{on:$('inBuyOn').checked,min:Number($('inBuy').value)},quoteSol:{on:$('inSolOn').checked,min:Number($('inSol').value)},
    sample:{on:$('inSampleOn').checked,pct:Number($('inSample').value)}},modules:{enabled:$('inModules').checked}}}
var INTAKE_DIRTY=false;
function renderIntake(){if(!$('intakeBox'))return;var st=researchMeta&&researchMeta.settings,x=st&&st.intake;
  $('intakeState').textContent=!researchMeta?'нет данных':x?'вкл.':'все из «Все»';
  if(!INTAKE_DIRTY){var m=x?x.manual:{enabled:true,phase:'both',buyers10:{on:true,min:3},quoteSol:{on:true,min:0.5},sample:{on:false,pct:100}};
    $('inManual').checked=!!m.enabled;$('inModules').checked=x?!!x.modules.enabled:true;
    $('inPhaseOn').checked=m.phase!=='both';$('inPhase').value=m.phase;
    $('inBuyOn').checked=m.buyers10.on;$('inBuy').value=m.buyers10.min;$('inSolOn').checked=m.quoteSol.on;$('inSol').value=m.quoteSol.min;
    $('inSampleOn').checked=m.sample.on;$('inSample').value=m.sample.pct}
  $('inBuyV').textContent=$('inBuy').value;$('inSolV').textContent=$('inSol').value;$('inSampleV').textContent=$('inSample').value;
  $('inManualBox').classList.toggle('dim',!$('inManual').checked);
  var parts=[];if($('inPhaseOn').checked)parts.push({before:'до',after:'после',both:'оба'}[$('inPhase').value]);if($('inBuyOn').checked)parts.push('пок. ≥ '+$('inBuy').value);if($('inSolOn').checked)parts.push('SOL ≥ '+$('inSol').value);if($('inSampleOn').checked)parts.push($('inSample').value+'%');
  $('inManualSum').textContent=$('inManual').checked?(parts.join(' · ')||'без условий'):'выкл.';
  var c=serverCfg(),byId={};(c&&c.filters||[]).forEach(function(f){byId[f.id]=f});var marked=(c&&c.modules||[]).filter(function(m){return m.toR1&&m.level==='1'});
  $('inModSum').textContent=marked.length?marked.map(function(m){return (m.phase==='before'?'🌱 ':'🎓 ')+(byId[m.filterId]?byId[m.filterId].name:m.filterId)}).join(' · '):'Нет отмеченных. Отметь значком И1 в «Окне возможностей».';
  var acc=researchMeta&&researchMeta.intakeAccepted||{},rej=researchMeta&&researchMeta.intakeRejected||{};
  var a=Object.values(acc).reduce(function(p,v){return p+v},0),r=Object.values(rej).reduce(function(p,v){return p+v},0);
  $('intakeStats').textContent=x?'вошло '+a+' · не вошло '+r+(r?' ('+Object.keys(rej).map(function(k){return ({phase:'поток','no-buyers10':'нет данных о покупателях',buyers10:'мало покупателей','no-quoteSol':'нет данных SOL',quoteSol:'мало SOL',sample:'жребий','not-matched':'не прошли','modules-only-not-passed':'не в «Прошли»'})[k]+' '+rej[k]}).join(', ')+')':''):''}
async function applyIntake(){var key=$('intakeKey').value.trim(),msg=$('intakeMsg');
  if(!controlEndpoint){msg.textContent='Сервер управления недоступен';return}if(!researchMeta){msg.textContent='Сервер ещё загружается, попробуй через минуту';return}
  if(!/^[a-zA-Z0-9_-]{32,256}$/.test(key)){msg.textContent='Введи пароль';return}
  var it=intakeFromUI();if(!it.manual.enabled&&!it.modules.enabled&&!window.confirm('Оба входа выключены — исследование перестанет набирать монеты. Продолжить?'))return;
  var st=researchMeta.settings,cfg={hours:st.hours,decisionMinutes:st.decisionMinutes,minActive:st.minActive,maxIdle:st.maxIdle,minCoverage:st.minCoverage,intake:it};
  $('intakeApply').disabled=true;msg.textContent='Отправка…';
  try{var r=await fetch(controlEndpoint+'/api/research-one',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(cfg)});
    $('intakeKey').value='';msg.textContent=r.ok?'✓ Принято':'Сервер отклонил: HTTP '+r.status+(r.status===401?' (неверный пароль)':'');if(r.ok)INTAKE_DIRTY=false}
  catch(e){msg.textContent='Ошибка связи: '+String(e.message||e)}finally{$('intakeApply').disabled=false}}
function renderModules(){
  var html='';
  for(var phase of ['before','after']){
    html+='<div class="card"><div class="stream-title">'+phaseNames[phase]+'</div>';
    for(var lev of ['1','2']){
      var modules=s.modules.filter(function(x){return x.phase===phase&&x.level===lev&&s.filters.some(function(f){return f.id===x.filterId})});
      html+='<div class="module-area"><div class="row"><b>'+(lev==='1'?'1-й уровень · Исследование':'2-й уровень · История')+'</b><button type="button" class="add" data-pick-source="'+phase+'" data-pick-level="'+lev+'" aria-label="Добавить модуль">+</button></div>';
      if(!modules.length)html+='<p class="muted small">Нет модулей</p>';
      for(var m of modules){
        var f=s.filters.find(function(x){return x.id===m.filterId});
        var key=draftModuleKey(m),state=moduleDraft.has(key)?moduleDraft.get(key):m.enabled;
        html+='<div class="module"><input type="checkbox" data-toggle="'+esc(m.filterId)+'" data-phase="'+phase+'" '+(state?'checked':'')+' aria-label="Изменить модуль (потребуется применение)"><span>'+esc(f.name)+'</span><button data-remove="'+esc(m.filterId)+'" data-phase="'+phase+'" aria-label="Удалить модуль">×</button></div>';
      }
      html+='</div>';
    }
    html+='</div>';
  }
  html+='<div class="card"><p class="hint">'+
    (moduleDraft.size?'Есть несохранённые изменения: '+fmt(moduleDraft.size)+'.':'Изменения переключателей применяются только после подтверждения.')+
    '</p><div class="action-bar"><button type="button" class="primary" data-apply-modules '+(!moduleDraft.size?'disabled':'')+
    '>Применить изменения</button><button type="button" data-cancel-modules '+(!moduleDraft.size?'disabled':'')+
    '>Отменить</button></div></div>';
  $('moduleGrid').innerHTML='<p class="hint">'+(serverPassActive?
    '⚠ Здесь локальные черновики модулей. Серверные активные правила имеют отдельную версию и не изменяются нажатием на телефоне.':
    '⚠ Модули сейчас действуют только на этом телефоне. Для фонового серверного режима требуется отдельная публикация настроек.')+
    '</p>'+html;
  $('activeModules').textContent=fmt(s.modules.filter(function(m){return m.enabled}).length);
}
function showPicker(phase,lev){
  picker={phase:phase,level:lev};
  $('pickerTitle').textContent='Добавить · '+phaseNames[phase]+' · '+lev+'-й уровень';
  var items=s.filters.filter(function(f){return f.level===lev&&!s.modules.some(function(m){return m.filterId===f.id&&m.phase===phase})});
  $('pickerItems').innerHTML=items.length?items.map(function(f){return '<button type="button" style="width:100%;margin-top:7px;text-align:left" data-use="'+esc(f.id)+'">'+esc(f.name)+' · №'+esc(f.id)+' ＋</button>'}).join(''):'<div class="empty-state">Новых фильтров нет. Создай их в «Библиотеке».</div>';
  $('filterPicker').hidden=false;
}
function renderPassed(){
  var list=lastPassed.filter(function(x){return x.deadline>now()});
  $('passedTab').textContent=list.length?' '+fmt(list.length):'';
  $('passedStats').textContent=serverPassActive?
    '✓ Серверный журнал: '+fmt(serverPassRows.length)+' записей в доступной выгрузке · активных: '+fmt(list.length)+
    (passMeta.enabled?'. Новые совпадения продолжают записываться сервером.':'. Серверные правила временно выключены, история сохранена.'): 
    '⚠ Предварительный режим на телефоне: '+fmt(lastPassed.length)+' сигналов. '+
    'Правила этого устройства пока НЕ отправляются на сервер; при закрытом сайте новые сигналы не фиксируются.';
  $('passedList').innerHTML=list.length?list.map(function(q){
    var left=Math.max(0,q.deadline-now()),sec=Math.ceil(left/1000),mins=Math.floor(sec/60);
    return '<div class="card"><div class="row"><b>'+esc(q.coin.n||q.coin.s||'Токен')+'</b><span class="badge warn mono">⏳ '+mins+':'+String(sec%60).padStart(2,'0')+'</span></div><p class="muted">'+
      (serverPassActive?'Серверный журнал: ':'Локальный предварительный: ')+
      q.matches.map(function(f){return esc(f.name)+' · v'+esc(f.version)}).join(', ')+'</p>'+coinHtml(q.coin)+'</div>';
  }).join(''):'<div class="empty-state">Нет активных сигналов. Исторические записи не превращаются в новые сигналы.</div>';
  var history=(serverPassActive?serverPassRows:signalLog).slice(0);
  if(!serverPassActive)history=history.reverse();
  history=history.slice(0,40);
  $('passedArchiveCount').textContent=fmt(serverPassActive?serverPassRows.length:signalLog.length);
  $('passedArchiveList').innerHTML=history.length?history.map(function(x){
    var stamp=new Date(x.firstSeenAt).toLocaleString('ru-RU',{timeZone:'Asia/Almaty',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
    return '<div class="vrow"><div class="row"><b>'+esc(x.name||x.mint)+'</b><span class="badge">'+esc(stamp)+'</span></div>'+
      '<p class="muted">'+esc(x.phase==='before'?'🌱 До':'🎓 После')+' · '+esc(x.mint.slice(0,12))+'… · точка 0 '+time(x.zeroAt||x.deadline)+'</p>'+
      '<p class="muted">'+x.matches.map(function(f){return esc(f.name)+' · v'+esc(f.version)+' ('+esc(f.key)+' '+esc(f.op)+' '+fmt(f.value)+')'}).join(', ')+'</p></div>';
  }).join(''):'<p class="muted">Журнал пуст. Источником являются только признанные главным сервером монеты.</p>';
}
function renderAutoSuggestions(report){
  if(!report||!Array.isArray(report.rules)||!report.rules.length)
    return '<p class="hint">Недостаточно размеченных наблюдений для предложений.</p>';
  const labels={buyers:'Покупатели',trades:'Сделки',volume:'Объём $',
    liq:'Ликвидность $',mc:'Капитализация $',buys:'Покупки',
    sells:'Продажи',buySellRatio:'Покупки/продажи'};
  return '<p class="hint">Кандидаты из ранних наблюдений. Поздняя выборка используется только для отдельной оценки.</p>'+
    report.rules.slice(0,8).map(function(x,i){
      const v=x.holdout;
      const stats=v&&v.positiveRecall!=null&&v.negativeRejection!=null?
        'Поздняя выборка: 🟢 '+(v.positiveRecall*100).toFixed(1)+'% ('+v.passedPositive+'/'+v.totalPositive+
        ') · 🔴 '+(v.negativeRejection*100).toFixed(1)+'% ('+v.rejectedNegative+'/'+v.totalNegative+
        ') · неизвестно '+fmt(v.unknown):
        'Отдельная проверка пока не готова';
      return '<div class="filter-row"><b>'+esc(labels[x.rule.key]||x.rule.key)+' '+
        esc(x.rule.op)+' '+fmt(x.rule.value)+'</b><p class="muted">'+
        'Обучение: 🟢 '+(x.train.positiveRecall*100).toFixed(1)+'% · 🔴 '+
        (x.train.negativeRejection*100).toFixed(1)+'%. '+esc(stats)+
        (x.passesHoldout===true?' · ✅ порог пройден':
         x.passesHoldout===false?' · ⚠ порог не пройден':'')+
        '</p><button type="button" class="pbtn" data-stage-auto="'+esc(report.level)+
        ':'+i+'">Открыть в редакторе</button></div>';
    }).join('');
}
function renderR1(){
  if($('r1Suggestions'))$('r1Suggestions').innerHTML=renderAutoSuggestions(autoOne);
  if(researchMeta){
    const cfg=researchMeta.settings||{},counts=researchMeta.counts||{},p=researchMeta.pending||{};
    const a=counts.live||0,b=counts.dead||0;
    $('r1Live').textContent=fmt(a);$('r1Dead').textContent=fmt(b);
    $('r1Meter').style.width=Math.min(100,a)+'%';
    $('r1Auto').textContent='Серверные наблюдения · '+cfg.hours+' ч · активность ≥'+cfg.minActive+
      '% · простой ≤'+cfg.maxIdle+' мин. Размечено живых: '+a+
      '/100. Ожидают окончания наблюдения: '+(p['not-yet-finished']||0)+
      ', недостаточно данных: '+(p['insufficient-activity-coverage']||0)+
      '. Автоподбор: требуется не меньше 100 живых и 40 мёртвых в обучении, затем отдельные 100 на поздней проверке.';
    if(autoOne){
      const text=autoOne.status==='rolling-holdout-ready'?
        'Есть отдельная проверочная выборка '+fmt(autoOne.validation.total)+' монет.':
        autoOne.status==='training-only'?'Подбор правил готовится; проверочная выборка ещё не накоплена.':
        'Накопление обучающих живых и мёртвых.';
      $('r1Auto').textContent+=' '+text+' Предложено условий: '+fmt(autoOne.rules.length)+'.';
    }
    const rows=bank['1'].slice(-10).reverse();
    $('r1Rows').innerHTML=rows.length?'<h2>Размечено на сервере</h2>'+rows.map(function(x){
      const positive=x.activity>=cfg.minActive&&x.idle<=cfg.maxIdle;
      return '<div class="vrow"><div class="row"><b class="mono">'+esc(x.mint.slice(0,11))+'…</b>'+
        '<span class="badge '+(positive?'good':'bad')+'">'+(positive?'🟢 Живая':'🔴 Мёртвая')+'</span></div>'+
        '<p class="muted">Активность '+x.activity.toFixed(1)+'% · пауза '+x.idle+' мин · данные сохранены на сервере</p></div>';
    }).join(''):'<div class="muted">Пока нет монет с завершённым и достаточно полным наблюдением. Сервер продолжает сбор.</div>';
    return;
  }
  const provisionalLive=lastR1.filter(function(x){return x.result.label==='live'}).length;
  const provisionalDead=lastR1.filter(function(x){return x.result.label==='dead'}).length;
  $('r1Live').textContent='—';$('r1Dead').textContent='—';
  $('r1Meter').style.width='0%';
  $('r1Auto').textContent='⛔ Авторитетная серверная разметка сейчас недоступна. '+
    'Локальные предварительные оценки (живых '+fmt(provisionalLive)+
    ', мёртвых '+fmt(provisionalDead)+') не считаются подтверждёнными и не входят в полигон.';
  $('r1Rows').innerHTML='<div class="muted">Подтверждённые наблюдения сервера отсутствуют или не загружены. Не подменяем их расчётами телефона.</div>';
}
function lineGraph(rows){
  if(!rows.length)return '<div class="empty-state">Нет монет с полной историей от точки 0. Будущие цены не подставляем.</div>';
  var max=20,min=-20;
  for(var p of rows){max=Math.max(max,p.pct);min=Math.min(min,p.pct)}
  max=Math.min(500,max+10);min=Math.max(-100,min-10);
  function y(v){return 185-(v-min)/Math.max(1,max-min)*155}
  function x(t){return 114+t/300*426}
  var path=rows.map(function(p,i){return (i?'L':'M')+x(p.min).toFixed(1)+' '+y(p.pct).toFixed(1)}).join(' ');
  return '<svg viewBox="0 0 560 235" role="img" aria-label="Средняя цена монет: зона до решения выделена зелёным, 300 минут после точки ноль"><rect x="16" y="20" width="98" height="165" fill="#143e2f"/><line x1="114" y1="20" x2="114" y2="185" stroke="#9568fa" stroke-width="2"/>'+
  '<path d="M16 185H542 M16 102H542 M16 20H542" fill="none" stroke="#343a4b" stroke-width="1"/>'+
  '<path d="'+path+'" fill="none" stroke="#38d996" stroke-width="2.8" stroke-linecap="round"/>'+
  '<g fill="#acb5c8" font-size="12"><text x="18" y="37">До решения</text><text x="108" y="211">0</text><text x="185" y="211">60</text><text x="307" y="211">150</text><text x="465" y="211">270</text><text x="514" y="211">300</text></g></svg>';
}
function researchTwoDataset(){
  if(serverR2Active){
    const lines=serverR2Rows.filter(function(x){return x.phase===s.r2Stream});
    const valid=lines.length;
    const strong=lines.filter(function(x){return x.label==='strong'}).length;
    const weak=lines.filter(function(x){return x.label==='weak'}).length;
    const aggregate=serverR2Curve&&serverR2Curve[s.r2Stream]||[];
    const curve=valid?[{min:0,pct:0,n:valid}].concat(aggregate):[];
    const waiting=twoMeta&&twoMeta.pending||{};
    const pending=Object.values(waiting).reduce(function(a,b){return a+(Number(b)||0)},0);
    return {curve,valid,pending,strong,weak,lines,fromServer:true};
  }
  var coins=lastPassed.filter(function(x){return x.coin._entry.phase===s.r2Stream});
  var lines=[],valid=0,pending=0,strong=0,weak=0;
  for(var q of coins){
    var outcome=labTwo(q.coin,q);if(outcome.label==='pending'){pending++;continue}
    valid++;if(outcome.label==='strong')strong++;else weak++;
    lines.push(outcome);
  }
  var curve=[];
  for(var m=0;m<=300;m+=5){
    if(m===0){curve.push({min:0,pct:0,n:valid});continue}
    var vals=lines.map(function(r){var p=r.curve.find(function(v){return v.min===m});return p?p.pct:null}).filter(function(v){return v!=null});
    if(vals.length)curve.push({min:m,pct:vals.reduce(function(a,b){return a+b},0)/vals.length,n:vals.length});
  }
  return {curve:curve,valid:valid,pending:pending,strong:strong,weak:weak,lines:lines,fromServer:false};
}
function renderR2(){
  if($('r2Suggestions'))$('r2Suggestions').innerHTML=renderAutoSuggestions(autoTwo);
  var r=researchTwoDataset();
  if($('r2Matched')){
    if(!serverR2Active)$('r2Matched').textContent=
      '⚠ Предварительный режим. Подтверждённых совпадений 2-го уровня с сервера пока нет.';
    else{
      const matches=serverR2Rows.filter(function(x){
        return x.phase===s.r2Stream&&Array.isArray(x.secondLevelMatches)&&x.secondLevelMatches.length;
      });
      $('r2Matched').innerHTML='<p class="muted">Совпало после завершённого наблюдения: '+
        fmt(matches.length)+' монет. Нет подходящих данных — не засчитываем.</p>'+
        matches.slice(0,15).map(function(x){
          return '<div class="filter-row"><b class="mono">'+esc(x.mint.slice(0,14))+'…</b>'+
            '<span class="badge '+(x.label==='strong'?'good':'bad')+'">'+
            (x.label==='strong'?'Сильная':'Слабая')+'</span><p class="muted">'+
            x.secondLevelMatches.map(function(f){return esc(f.name)+' · v'+esc(f.version)}).join(' · ')+
            '</p></div>';
        }).join('');
    }
  }
  $('r2Graph').innerHTML=lineGraph(r.curve.length>1?r.curve:[]);
  $('r2Stats').textContent=(r.fromServer?'✓ Серверные наблюдения. ':'⚠ Предварительный режим телефона. ')+
    'Размечено: 🟢 сильных '+r.strong+' · 🔴 слабых '+r.weak+' · ожидание/пробелы '+r.pending+'.';
  if($('r2AutoText'))$('r2AutoText').textContent=autoTwo?
    'Автоподбор на сервере: '+fmt(autoTwo.rules.length)+' кандидатов · статус: '+
    ({'waiting-training':'нужны 40 сильных и 40 слабых',
      'training-only':'нужна отдельная поздняя проверочная выборка',
      'waiting-both-holdout-classes':'нужны оба класса в проверочной группе',
      'rolling-holdout-ready':'проверено на отдельной поздней выборке'}[autoTwo.status]||'сбор данных')+
    '. Выводы предварительные.':
    'Серверный подбор ещё не опубликован. Локальные графики не считаются независимой проверкой.';
  var out=[];
  for(var m=0;m<=300;m+=s.r2Step){
    var found=r.curve.find(function(p){return p.min===m});
    // A 1-minute row must have real minute evidence; never copy a 5m
    // observation forward and present it as independently measured.
    out.push({m:m,p:found});
  }
  var pages=Math.max(1,Math.ceil(out.length/8));
  s.r2Page=Math.min(s.r2Page,pages-1);
  $('r2Table').innerHTML=out.slice(s.r2Page*8,s.r2Page*8+8).map(function(item){
    return '<tr><td>'+item.m+'</td><td>'+(!item.p?'—':(item.p.pct>=0?'+':'')+item.p.pct.toFixed(1)+'%')+'</td><td>'+(!item.p?'0':item.p.n)+'</td></tr>';
  }).join('');
  $('r2Paging').textContent=(s.r2Page+1)+' / '+pages;
  $('r2Prev').disabled=s.r2Page===0;$('r2Next').disabled=s.r2Page>=pages-1;
}
function classified(level){
  var a=[],b=[];
  for(var x of bank[level]){
    if(!x||!x.mint||!x.features)continue;
    var label=bankLabel(level,x);
    if(label==='live'||label==='strong')a.push(x);
    else b.push(x);
  }
  return [a.slice(-5000),b.slice(-5000)];
}
function renderServerRuleHistory(){
  if(!$('serverRuleHistoryRows'))return;
  const rows=filterAuditMeta?.rules?.filter(function(x){
    return x.level===s.level&&(x.archived||!s.filters.some(function(f){
      return f.id===x.id&&f.level===x.level&&f.version===x.version&&
        f.key===x.rule.key&&f.op===x.rule.op&&f.value===x.rule.value;
    }));
  })||[];
  $('serverRuleHistoryCount').textContent=fmt(rows.length);
  $('serverRuleHistoryRows').innerHTML=rows.length?rows.slice(0,100).map(function(x){
    const stats=function(v){return v&&v.positivePercent!=null&&v.negativePercent!=null?
      '🟢 '+v.positivePercent.toFixed(1)+'% · 🔴 '+v.negativePercent.toFixed(1)+
      '% · неизвестно '+fmt(v.missing):'Недостаточно обеих размеченных групп';};
    return '<div class="filter-row"><b>'+esc(x.name)+' · v'+fmt(x.version)+'</b>'+
      '<span class="badge">'+esc(x.phase==='before'?'🌱 До':'🎓 После')+'</span>'+
      '<p class="muted">'+esc(x.rule.key)+' '+esc(x.rule.op)+' '+fmt(x.rule.value)+
      ' · '+(x.archived?'Архив':'Серверная версия')+'</p>'+
      '<p class="muted">Исходная проверка: '+stats(x.original)+'</p>'+
      '<p class="muted">Новые данные: '+stats(x.background)+'</p></div>';
  }).join(''):'<p class="muted">Нет архивных версий для выбранного уровня.</p>';
}
function renderLibrary(){
  renderServerRuleHistory();
  var names=s.level==='1'?['Живые','Мёртвые']:['Сильные','Слабые'],target=s.poly[s.level],groups=classified(s.level),lenA=groups[0].length,lenB=groups[1].length;
  $('polyTitle').textContent=names.join(' / ');
  $('polyNameA').textContent=names[0];$('polyNameB').textContent=names[1];
  $('polyA').value=target[0];$('polyB').value=target[1];
  $('polyAValue').textContent=fmt(target[0]);$('polyBValue').textContent=fmt(target[1]);
  var ready=lenA>=target[0]&&lenB>=target[1];
  $('polyProgress').innerHTML='<div class="pbar"><span class="muted">'+names[0]+' '+fmt(lenA)+' / '+fmt(target[0])+'</span><div class="meter"><div style="width:'+Math.min(100,100*lenA/target[0])+'%"></div></div></div>'+
    '<div class="pbar"><span class="muted">'+names[1]+' '+fmt(lenB)+' / '+fmt(target[1])+'</span><div class="meter"><div style="width:'+Math.min(100,100*lenB/target[1])+'%"></div></div></div><div class="badge '+(ready?'good':'warn')+'">'+(ready?'Готов к проверке':'Ожидание накопления')+'</div>';
  $('testAll').disabled=!ready;
  $('testResults').innerHTML=testHtml;
  var f=s.filters.filter(function(x){return x.level===s.level});
  $('libraryList').innerHTML=f.length?f.map(function(x){
    var orig=x.original?x.original.livePercent.toFixed(1)+'% / '+x.original.deadPercent.toFixed(1)+'%':'локально не проверен';
    var records=filterAuditMeta&&Array.isArray(filterAuditMeta.rules)?
      filterAuditMeta.rules.filter(function(p){return p.id===x.id&&p.version===x.version&&
        p.level===x.level&&p.rule.key===x.key&&p.rule.op===x.op&&p.rule.value===x.value}):[];
    var audits=records.map(function(p){
      var start=p.original&&p.original.positivePercent!=null&&p.original.negativePercent!=null?
        '🟢 '+p.original.positivePercent.toFixed(1)+'% · 🔴 '+p.original.negativePercent.toFixed(1)+'%':
        'недостаточно завершённых наблюдений';
      var later=p.background&&p.background.positivePercent!=null&&p.background.negativePercent!=null?
        '🟢 '+p.background.positivePercent.toFixed(1)+'% · 🔴 '+p.background.negativePercent.toFixed(1)+'%':
        'ещё нет обеих групп';
      return '<p class="muted">'+esc(p.phase==='before'?'🌱 До':'🎓 После')+
        ' · начальные: '+start+' · новые: '+later+
        ' · пропуски '+fmt(p.background?.missing||0)+'</p>';
    }).join('');
    return '<div class="filter-row"><div class="row"><b>№'+esc(x.id)+' · '+esc(x.name)+'</b><button type="button" class="pbtn" data-edit="'+esc(x.id)+'">Открыть</button></div>'+
      '<p class="muted">'+esc(ruleLabel(x))+' · версия '+fmt(x.version)+'</p>'+
      (audits?'<p class="hint">Серверная история сравнения по версиям:</p>'+audits:
      '<div class="numbers"><span class="badge">На телефоне: '+orig+'</span>'+
      '<span class="badge">Серверная фоновая проверка: ожидает настройки</span></div>')+'</div>';
  }).join(''):'<div class="empty-state">Фильтров этого уровня пока нет. Нажми «+ Создать» — можно сделать собственное правило.</div>';
}
function testAll(){
  var f=s.filters.filter(function(x){return x.level===s.level});
  var groups=classified(s.level),targets=s.poly[s.level];
  if(groups[0].length<targets[0]||groups[1].length<targets[1]){note('Сначала нужно накопить выбранное количество обоих классов');return}
  var positives=groups[0].slice(-targets[0]),negatives=groups[1].slice(-targets[1]);
  var results=[];
  for(var x of f){
    var good=positives.filter(function(c){return ruleStatus(c.features,x)==='pass'}).length;
    var blocked=negatives.filter(function(c){return ruleStatus(c.features,x)==='reject'}).length;
    var unknownPositive=positives.filter(function(c){return ruleStatus(c.features,x)==='unknown'}).length;
    var unknownNegative=negatives.filter(function(c){return ruleStatus(c.features,x)==='unknown'}).length;
    var a=good/positives.length*100,b=blocked/negatives.length*100;
    if(!x.original)x.original={livePercent:a,deadPercent:b,liveCount:good,liveTotal:positives.length,deadCount:blocked,deadTotal:negatives.length,at:now()};
    results.push({f:x,a:a,b:b,good:good,blocked:blocked,unknownPositive,unknownNegative});
  }
  results.sort(function(a,b){return (b.a+b.b)-(a.a+a.b)});
  testHtml='<h3 style="margin-top:12px">Результаты на '+fmt(positives.length+negatives.length)+' монетах</h3>'+
    '<p class="muted">🟢 Доля правильно пропущенных · 🔴 доля правильно отклонённых. Обучавшиеся монеты не исключаются; это не независимая проверка.</p>'+
    (results.length?results.map(function(r,i){return '<div class="result"><div class="row"><b>'+(i+1)+'. №'+esc(r.f.id)+' · '+esc(r.f.name)+'</b><span class="badge">v'+r.f.version+'</span></div>'+
      '<div class="numbers" style="margin-top:8px"><span class="good">🟢 '+r.a.toFixed(1)+'% ('+r.good+'/'+positives.length+')</span> · <span class="bad">🔴 '+r.b.toFixed(1)+'% ('+r.blocked+'/'+negatives.length+')</span></div>'+
        '<p class="muted">Нет показателя: живые '+r.unknownPositive+', мёртвые '+r.unknownNegative+'. Не засчитываем их как успешно отклонённые.</p></div>'}).join(''):'<p class="muted">В этом уровне ещё нет фильтров.</p>');
  save();renderLibrary();
}
function openEditor(id){
  editorId=id||null;var f=s.filters.find(function(x){return x.id===editorId});
  $('editor').hidden=false;
  $('editorTitle').textContent=f?'Редактор №'+f.id+' · v'+f.version:'Новый фильтр · '+s.level+'-й уровень';
  $('filterName').value=f?f.name:'';
  $('filterKey').value=f?f.key:'buyers';$('filterOp').value=f?f.op:'>=';
  $('filterValue').value=f?f.value:20;
  $('deleteFilter').hidden=!f;
  $('editorNote').textContent='Изменение условия создаёт новую версию. '+(f?.conditions?.length?'Дополнительные условия сохраняются: '+f.conditions.map(ruleLabel).join(' · '):'');
  $('editor').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function saveEditor(e){
  e.preventDefault();
  var name=$('filterName').value.trim(),key=$('filterKey').value,op=$('filterOp').value,value=Number($('filterValue').value);
  if(!name||!['buyers','trades','volume','liq','mc','buys','sells','buySellRatio','buyers10','safeContract','quoteSol','top1','top10'].includes(key)||!['>=','<='].includes(op)||!Number.isFinite(value)||value<0||value>1e12){note('Проверь название и значение');return}
  var same=s.filters.find(function(f){return f.id!==editorId&&f.level===s.level&&f.key===key&&f.op===op&&f.value===value});
  if(same){note('Такие же правила уже есть: №'+same.id);return}
  if(editorId){
    var f=s.filters.find(function(x){return x.id===editorId});
    if(!f)return;
    if(f.key!==key||f.op!==op||f.value!==value){
      f.version++;f.original=null;f.history=f.history||[];f.history.push({version:f.version-1,changedAt:now()});
    }
    Object.assign(f,{name:name,key:key,op:op,value:value});
  }else{
    var id=String(Math.max(0,...s.filters.map(function(f){return Number(f.id)||0}))+1).padStart(3,'0');
    s.filters.push({id:id,level:s.level,name:name,key:key,op:op,value:value,version:1,original:null,history:[],createdAt:now()});
  }
  $('editor').hidden=true;testHtml='';save();refresh();note('Фильтр сохранён');
}
function removeEditor(){
  if(!editorId||!window.confirm('Удалить фильтр №'+editorId+' из библиотеки и активных модулей?'))return;
  s.filters=s.filters.filter(function(x){return x.id!==editorId});
  s.modules=s.modules.filter(function(x){return x.filterId!==editorId});
  editorId=null;$('editor').hidden=true;testHtml='';save();refresh();note('Фильтр удалён');
}
function refresh(){
  analyze();
  renderAll();renderServerModules();renderIntake();renderModules();renderLocalPreview();renderPassed();renderR1();renderR2();renderLibrary();
}
function preparedServerConfig(){
  // Include all library definitions so the server can evaluate background
  // performance of disabled but configured modules. Only enabled level-1
  // modules are permitted to add new first-level Passed records.
  if(s.filters.length>200||s.modules.length>200){
    note('Слишком много модулей/фильтров: максимум 200 в серверной версии');
    return null;
  }
  const filters=s.filters.map(function(f){
    return {id:String(f.id),name:String(f.name),level:String(f.level),
      key:f.key,op:f.op,value:Number(f.value),version:Number(f.version),...(f.conditions?{conditions:f.conditions.map(function(c){return {key:c.key,op:c.op,value:c.value}})}:{})};
  });
  const ids=new Set(filters.map(function(f){return f.id}));
  const modules=s.modules.filter(function(m){return ids.has(m.filterId)})
    .map(function(m){return {
      filterId:m.filterId,phase:m.phase,level:m.level,enabled:!!m.enabled
    }});
  if(!modules.some(function(m){return m.level==='1'&&m.enabled})){
    note('Нужен хотя бы один подтверждённый активный модуль 1-го уровня');
    return null;
  }
  return {schema:1,enabled:true,activatedAt:0,
    decisionMinutes:s.decision,filters,modules};
}
function exportServerConfig(){
  const config=preparedServerConfig();if(!config)return;
  const blob=new Blob([JSON.stringify(config,null,2)+'\n'],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='pass-filters.json';
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(url)},30000);
  note('Конфигурация подготовлена. Для фоновой работы её надо опубликовать на сервере.');
}
function validControlEndpoint(value){
  if(!value||value.enabled!==true||typeof value.url!=='string')return null;
  try{
    const u=new URL(value.url);
    return u.protocol==='https:'&&u.hostname.endsWith('.run.app')&&!u.username&&!u.password?
      u.origin:null;
  }catch(e){return null}
}
async function publishResearchLevel(level){
  const one=level==='1',keyField=one?'ownerResearchOneKey':'ownerResearchTwoKey';
  const checkField=one?'confirmResearchOne':'confirmResearchTwo';
  const statusField=one?'researchOneControlState':'researchTwoControlState';
  const buttonField=one?'publishResearchOne':'publishResearchTwo';
  const endpoint=one?'/api/research-one':'/api/research-two';
  const current=one?researchMeta:twoMeta;
  if(!controlEndpoint||!current){note('Серверное исследование ещё недоступно');return}
  if(!$(checkField).checked){note('Подтверди изменение серверного исследования');return}
  const key=$(keyField).value.trim();
  if(!/^[a-zA-Z0-9_-]{32,256}$/.test(key)){
    note('Требуется отдельный ключ владельца');return;
  }
  let cfg;
  if(one){
    cfg={hours:Number($('r1Hours').value),
      decisionMinutes:researchMeta.settings.decisionMinutes,
      minActive:Number($('r1Activity').value),
      maxIdle:Number($('r1Idle').value),
      minCoverage:researchMeta.settings.minCoverage,...(researchMeta.settings.intake?{intake:researchMeta.settings.intake}:{})};
    if(!Number.isInteger(cfg.hours)||cfg.hours<1||cfg.hours>24||
       !Number.isInteger(cfg.maxIdle)||cfg.maxIdle<5||cfg.maxIdle>1440||
       !Number.isFinite(cfg.minActive)||cfg.minActive<0||cfg.minActive>100){
      note('Неверные параметры первого исследования');return;
    }
  }else{
    cfg={minAbove:Number($('r2Strong').value),
      minCoverage:twoMeta.settings.minCoverage};
    if(!Number.isFinite(cfg.minAbove)||cfg.minAbove<0||cfg.minAbove>100){
      note('Неверный порог второго исследования');return;
    }
  }
  $(buttonField).disabled=true;
  $(statusField).textContent='Отправка серверной версии…';
  const abort=new AbortController(),timer=setTimeout(function(){abort.abort()},20000);
  try{
    const r=await fetch(controlEndpoint+endpoint,{
      method:'POST',cache:'no-store',signal:abort.signal,
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body:JSON.stringify(cfg)
    });
    if(!r.ok){
      $(statusField).textContent='Сервер отклонил изменения. HTTP '+r.status;
      note(r.status===401?'Ключ владельца не принят':'Публикация не удалась: '+r.status);
      return;
    }
    $(keyField).value='';$(checkField).checked=false;
    $(statusField).textContent='Версия принята. Для неё сервер создаст отдельную группу наблюдений.';
    note('Сервер переключится на новые правила без переписывания старой истории.');
  }catch(e){
    $(statusField).textContent='Ошибка связи: '+String(e.message||e);
  }finally{
    clearTimeout(timer);$(buttonField).disabled=!controlEndpoint||!current;
  }
}
async function publishSourceAge(){
  if(!controlEndpoint||!sourceActive){
    note('Нет защищённого сервера управления или главного источника');return;
  }
  if(!$('confirmAgePublish').checked){
    note('Подтверди изменение двух возрастных фильтров');return;
  }
  const cfg={schema:1,beforeMinutes:Number($('ageBefore').value),
    afterMinutes:Number($('ageAfter').value)};
  if(![cfg.beforeMinutes,cfg.afterMinutes].every(function(v){
    return Number.isInteger(v)&&v>=1&&v<=10;
  })){
    note('Возраст до и после миграции должен быть от 1 до 10 минут');return;
  }
  const key=$('ageOwnerKey').value.trim();
  if(!/^[a-zA-Z0-9_-]{32,256}$/.test(key)){
    note('Для изменения порога нужен отдельный ключ владельца');return;
  }
  const button=$('publishSourceAge');
  button.disabled=true;
  $('sourceAgeControlState').textContent='Отправка новых возрастных порогов…';
  const abort=new AbortController(),timer=setTimeout(function(){abort.abort()},20000);
  try{
    const r=await fetch(controlEndpoint+'/api/source-age',{
      method:'POST',cache:'no-store',signal:abort.signal,
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body:JSON.stringify(cfg)
    });
    if(!r.ok){
      $('sourceAgeControlState').textContent='Сервер отклонил изменение: HTTP '+r.status;
      note(r.status===401?'Ключ владельца не принят':'Ошибка изменения возраста: '+r.status);
      return;
    }
    $('ageOwnerKey').value='';$('confirmAgePublish').checked=false;
    $('sourceAgeControlState').textContent='Пороги получены сервером управления. Ждём подтверждения новых значений главным источником.';
    note('Серверные пороги обновляются только для новых входящих событий.');
  }catch(e){
    $('sourceAgeControlState').textContent='Ошибка связи: '+String(e.message||e);
  }finally{
    clearTimeout(timer);
    button.disabled=!controlEndpoint||!sourceActive;
  }
}
async function publishServerConfig(){
  if(!controlEndpoint){note('Защищённый сервер управления ещё не подключён');return}
  if(!$('confirmControlPublish').checked){
    note('Отметь подтверждение публикации серверной версии');return;
  }
  const config=preparedServerConfig();if(!config)return;
  const key=$('ownerControlKey').value.trim();
  if(!/^[a-zA-Z0-9_-]{32,256}$/.test(key)){
    note('Нужен действительный ключ владельца, не пароль от GitHub');return;
  }
  const button=$('publishServerConfig');
  button.disabled=true;$('controlState').textContent='Отправка настроек на сервер…';
  const abort=new AbortController(),timer=setTimeout(function(){abort.abort()},20000);
  try{
    const r=await fetch(controlEndpoint+'/api/filter-config',{
      method:'POST',cache:'no-store',signal:abort.signal,
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body:JSON.stringify(config)
    });
    if(!r.ok){
      $('controlState').textContent='Не удалось применить серверную конфигурацию. HTTP '+r.status;
      note(r.status===401?'Ключ владельца не принят':'Ошибка публикации: HTTP '+r.status);
      return;
    }
    $('ownerControlKey').value='';
    $('confirmControlPublish').checked=false;
    $('controlState').textContent='Принято сервером управления. Журнал переключится после обновления конфигурации сборщика.';
    note('Новая серверная версия передана. Старые монеты не добавляются задним числом.');
  }catch(e){
    $('controlState').textContent='Ошибка связи с защищённым сервером: '+String(e.message||e);
  }finally{
    clearTimeout(timer);
    button.disabled=!controlEndpoint;
  }
}

async function loadPassedArchiveDay(){
  const selected=$('passedDay').value;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(selected)){
    note('Неверная дата архива');return;
  }
  if(!serverPassActive){
    $('passedDayStatus').textContent='Архив сервера недоступен. Локальную историю можно посмотреть выше.';
    return;
  }
  const button=$('loadPassedDay');
  button.disabled=true;
  $('passedDayStatus').textContent='Получение проверенного журнала за '+selected+'…';
  $('passedDayList').innerHTML='';
  try{
    const data=await getJSON('passed-v2/day/'+selected+'.json');
    if(!data||data.day!==selected||data.origin!=='server-journal'||
       !Array.isArray(data.coins)){
      $('passedDayStatus').textContent='Файл за этот день не опубликован или недоступен. Это не означает ноль монет.';
      return;
    }
    const records=data.coins.filter(function(p){
      return p&&typeof p.mint==='string'&&['before','after'].includes(p.phase)&&
        Number.isSafeInteger(p.firstSeenAt)&&Number.isSafeInteger(p.zeroAt)&&
        Array.isArray(p.matches);
    });
    $('passedDayStatus').textContent='Серверная история за '+selected+': '+fmt(records.length)+
      ' записей. Показаны последние '+fmt(Math.min(150,records.length))+'.';
    $('passedDayList').innerHTML=records.slice(0,150).map(function(p){
      return '<div class="filter-row"><div class="row"><b>'+esc(p.name||p.mint.slice(0,14))+
        '</b><span class="badge mono">'+time(p.firstSeenAt)+'</span></div>'+
        '<p class="muted">'+esc(p.phase==='before'?'🌱 До миграции':'🎓 После миграции')+
        ' · '+esc(p.mint)+' · точка 0 '+time(p.zeroAt)+'</p>'+
        '<p class="muted">'+p.matches.map(function(f){
          return esc(f.name)+' · v'+esc(f.version)+' ('+esc(f.key)+' '+esc(f.op)+' '+fmt(f.value)+')';
        }).join(' · ')+'</p></div>';
    }).join('')||'<p class="muted">В опубликованном серверном журнале за этот день записей нет.</p>';
  }catch(e){
    $('passedDayStatus').textContent='Не удалось получить архив: '+String(e.message||e);
  }finally{
    button.disabled=false;
  }
}
function stageAutoRule(e){
  const btn=e.target.closest('[data-stage-auto]');
  if(!btn)return;
  const id=btn.dataset.stageAuto.split(':'),level=id[0],index=Number(id[1]);
  const report=level==='1'?autoOne:level==='2'?autoTwo:null;
  const item=report?.rules?.[index],rule=item?.rule;
  if(!rule||!['buyers','trades','volume','liq','mc','buys','sells','buySellRatio'].includes(rule.key)||
     !['>=','<='].includes(rule.op)||!Number.isFinite(rule.value)||rule.value<0){
    note('Некорректное условие исследования');return;
  }
  s.level=level;s.tab='library';save();
  document.querySelectorAll('#tabs [data-page]').forEach(function(x){
    x.classList.toggle('active',x.dataset.page==='library');
  });
  document.querySelectorAll('.page').forEach(function(x){
    x.hidden=x.id!=='p-library';
  });
  document.querySelectorAll('#levels [data-level]').forEach(function(x){
    x.classList.toggle('active',x.dataset.level===level);
  });
  renderLibrary();
  openEditor(null);
  const titles={buyers:'Покупатели',trades:'Сделки',volume:'Объём',
    liq:'Ликвидность',mc:'Капитализация',buys:'Покупки',sells:'Продажи',
    buySellRatio:'Покупки/продажи'};
  $('filterName').value=(titles[rule.key]||rule.key)+' '+rule.op+' '+fmt(rule.value);
  $('filterKey').value=rule.key;
  $('filterOp').value=rule.op;
  $('filterValue').value=rule.value;
  $('editorNote').textContent='Черновик из автоматического исследования. Проверь и нажми «Сохранить». Не включает модуль и не меняет сервер.';
  note('Предложение скопировано в редактор. Подтверди сохранение вручную.');
}
function bind(){
  $('exportServerConfig').addEventListener('click',exportServerConfig);
  $('loadPassedDay').addEventListener('click',loadPassedArchiveDay);
  $('r1Suggestions').addEventListener('click',stageAutoRule);
  $('r2Suggestions').addEventListener('click',stageAutoRule);
  $('publishServerConfig').addEventListener('click',publishServerConfig);
  $('publishSourceAge').addEventListener('click',publishSourceAge);
  $('publishResearchOne').addEventListener('click',function(){publishResearchLevel('1')});
  document.querySelectorAll('#mineSub button').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('#mineSub button').forEach(function(x){x.classList.toggle('active',x===b)});$('paneWin').hidden=b.dataset.msub!=='win';$('paneR1').hidden=b.dataset.msub!=='r1'})});
  document.querySelectorAll('#mineStreams button').forEach(function(b){b.addEventListener('click',function(){MINE_STREAM=b.dataset.mstream;document.querySelectorAll('#mineStreams button').forEach(function(x){x.classList.toggle('active',x===b)});$('modPicker').hidden=true;renderServerModules()})});
  document.querySelectorAll('[data-addlev]').forEach(function(b){b.addEventListener('click',function(){showModPicker(b.dataset.addlev)})});
  $('modPickerX').addEventListener('click',function(){$('modPicker').hidden=true});
  $('modPickerList').addEventListener('click',function(e){var b=e.target.closest('[data-pick]');if(b)pickFilter(b.dataset.pick)});
  $('mods1').addEventListener('click',modClick);$('mods2').addEventListener('click',modClick);$('modApply').addEventListener('click',applyModules);
  ['inManual','inModules','inPhaseOn','inPhase','inBuyOn','inBuy','inSolOn','inSol','inSampleOn','inSample'].forEach(function(id){$(id).addEventListener('input',function(){INTAKE_DIRTY=true;renderIntake()})});
  $('intakeApply').addEventListener('click',applyIntake);

  $('publishResearchTwo').addEventListener('click',function(){publishResearchLevel('2')});
  $('tabs').addEventListener('click',function(e){
    var b=e.target.closest('button[data-page]');if(!b)return;
    s.tab=b.dataset.page;
    document.querySelectorAll('#tabs button').forEach(function(x){x.classList.toggle('active',x===b)});
    document.querySelectorAll('.page').forEach(function(x){x.hidden=x.id!=='p-'+s.tab});
    save();
  });
  $('allStreams').addEventListener('click',function(e){var b=e.target.closest('button[data-stream]');if(!b)return;s.stream=b.dataset.stream;this.querySelectorAll('button').forEach(function(x){x.classList.toggle('active',x===b)});save();refresh()});
  $('applySource').addEventListener('click',function(){
    s.limit=+ $('cardLimit').value;
    if(!sourceActive){
      note('Количество карточек сохранено. Настройки возраста нельзя менять без серверного источника.');
    }else{
      s.ageBefore=sourceMeta.settings.beforeMinutes;s.ageAfter=sourceMeta.settings.afterMinutes;
      note('Количество карточек сохранено. Возрастные фильтры работают на сервере.');
    }
    save();refresh();
  });
  $('coinList').addEventListener('click',function(e){
    const button=e.target.closest('[data-coin]');if(!button)return;
    showCoinDetail(lastAccepted.find(function(c){return mint(c)===button.dataset.coin}),'coinList');
  });
  $('passedList').addEventListener('click',function(e){
    const button=e.target.closest('[data-coin]');if(!button)return;
    const item=lastPassed.find(function(x){return mint(x.coin)===button.dataset.coin});
    if(item)showCoinDetail(item.coin,'passedList');
  });
  $('moduleGrid').addEventListener('click',function(e){
    if(e.target.closest('[data-apply-modules]')){
      for(const m of s.modules)if(moduleDraft.has(draftModuleKey(m)))
        m.enabled=moduleDraft.get(draftModuleKey(m));
      moduleDraft.clear();save();refresh();note('Изменения модулей применены на этом телефоне');return;
    }
    if(e.target.closest('[data-cancel-modules]')){
      moduleDraft.clear();renderModules();note('Неприменённые переключения отменены');return;
    }
    var pick=e.target.closest('[data-pick-source]');if(pick){showPicker(pick.dataset.pickSource,pick.dataset.pickLevel);return}
    var remove=e.target.closest('[data-remove]');if(!remove)return;
    if(!window.confirm('Удалить модуль из локальной схемы?'))return;
    var target=s.modules.find(function(m){return m.filterId===remove.dataset.remove&&m.phase===remove.dataset.phase});
    if(target)moduleDraft.delete(draftModuleKey(target));
    s.modules=s.modules.filter(function(x){return !(x.filterId===remove.dataset.remove&&x.phase===remove.dataset.phase)});
    save();refresh();
  });
  $('moduleGrid').addEventListener('change',function(e){
    if(!e.target.matches('[data-toggle]'))return;
    var m=s.modules.find(function(x){return x.filterId===e.target.dataset.toggle&&x.phase===e.target.dataset.phase});
    if(m){
      const key=draftModuleKey(m);
      if(e.target.checked===m.enabled)moduleDraft.delete(key);
      else moduleDraft.set(key,e.target.checked);
      renderModules();
    }
  });
  $('pickerItems').addEventListener('click',function(e){
    var b=e.target.closest('[data-use]');if(!b||!picker)return;
    var m={filterId:b.dataset.use,phase:picker.phase,level:picker.level,enabled:false};
    s.modules.push(m);moduleDraft.set(draftModuleKey(m),true);
    $('filterPicker').hidden=true;picker=null;save();refresh();
    note('Добавлен черновик модуля. Нажми «Применить изменения» для включения.');
  });
  $('pickerClose').addEventListener('click',function(){$('filterPicker').hidden=true;picker=null});
  $('decisionMins').addEventListener('input',function(){$('decisionValue').textContent=this.value+' мин'});
  $('applyDecision').addEventListener('click',function(){
    s.decision=clamp(+$('decisionMins').value,1,30,10);
    $('decisionCurrent').textContent=s.decision+' мин';
    save();refresh();$('decisionSettings').open=false;
    note('Таймер решения: '+s.decision+' мин · применено');
  });
  $('decisionSettings').addEventListener('toggle',function(){
    if(!this.open){$('decisionMins').value=s.decision;$('decisionValue').textContent=s.decision+' мин';}
  });
  for(var id of ['r1Hours','r1Activity','r1Idle','r2Strong']){
    $(id).addEventListener('input',function(){
      $(this.id+'Value').textContent=this.value+(this.id==='r1Hours'?' часов':this.id==='r1Idle'?' минут':'%');
    });
  }
  $('applyR1').addEventListener('click',function(){
    s.r1Hours=+ $('r1Hours').value;s.r1Activity=+ $('r1Activity').value;s.r1Idle=+ $('r1Idle').value;
    save();refresh();note('Правила разметки 1-го уровня применены');
  });
  $('applyR2').addEventListener('click',function(){
    if(serverR2Active){note('Разметка второго уровня принадлежит серверу; с телефона пока доступен просмотр');return}
    s.r2Strong=+ $('r2Strong').value;save();refresh();note('Локальный порог сильных/слабых применён');
  });
  $('r2Streams').addEventListener('click',function(e){var b=e.target.closest('[data-stream]');if(!b)return;s.r2Stream=b.dataset.stream;this.querySelectorAll('button').forEach(function(x){x.classList.toggle('active',x===b)});save();renderR2()});
  $('r2Step').addEventListener('change',function(){s.r2Step=+this.value;s.r2Page=0;save();renderR2()});
  $('r2Prev').addEventListener('click',function(){s.r2Page--;save();renderR2()});
  $('r2Next').addEventListener('click',function(){s.r2Page++;save();renderR2()});
  $('levels').addEventListener('click',function(e){var b=e.target.closest('[data-level]');if(!b)return;s.level=b.dataset.level;testHtml='';$('editor').hidden=true;this.querySelectorAll('button').forEach(function(x){x.classList.toggle('active',x===b)});save();renderLibrary()});
  for(var id2 of ['polyA','polyB'])$(id2).addEventListener('input',function(){$(this.id+'Value').textContent=fmt(+this.value)});
  $('polyApply').addEventListener('click',function(){s.poly[s.level]=[+$('polyA').value,+$('polyB').value];testHtml='';save();renderLibrary();note('Размеры полигона сохранены')});
  $('testAll').addEventListener('click',testAll);
  $('createFilter').addEventListener('click',function(){openEditor(null)});
  $('libraryList').addEventListener('click',function(e){var b=e.target.closest('[data-edit]');if(b)openEditor(b.dataset.edit)});
  $('closeEditor').addEventListener('click',function(){$('editor').hidden=true});
  $('deleteFilter').addEventListener('click',removeEditor);
  $('editor').addEventListener('submit',saveEditor);
}
const jsonCache=new Map();
async function getJSON(path){
  const ttl=path.startsWith('observations-v2/summary/day/')?(path.includes(day(now()))?120000:600000):path.startsWith('source/day/')?300000:0,cached=jsonCache.get(path);
  if(ttl&&cached&&now()-cached.at<ttl)return cached.data;
  var ctl=new AbortController(),timer=setTimeout(function(){ctl.abort()},20000);
  try{var r=await fetch(BASE+path+'?v='+now(),{signal:ctl.signal,cache:'no-store'});
    if(r.status===404||r.status===403)return null;
    if(!r.ok)throw new Error(path+' HTTP '+r.status);
    const data=await r.json();if(ttl&&data){jsonCache.set(path,{at:now(),data});while(jsonCache.size>12)jsonCache.delete(jsonCache.keys().next().value);}return data;
  }finally{clearTimeout(timer)}
}
function observationCoins(file){
  if(!file)return [];if(file.schema!==2||!Array.isArray(file.coins))throw Error('Неверный формат наблюдений сервера');
  return file.coins.map(function(row){return SolObservations.toLegacy(row)});
}
function canonicalAdmissions(files,at){
  const rows=[];
  for(const file of files){if(file?.schema!==2||!Number.isFinite(file.updated)||at-file.updated>7*60000||file.updated>at+30000||!Array.isArray(file.coins))continue;
    for(const row of file.coins){const a=row.observations?.admission;
      if(a?.v!==1||a.mint!==row.a||typeof a.mint!=='string'||a.mint.length<32||!['before','after'].includes(a.phase)||!Number.isSafeInteger(a.eventAt)||a.eventAt<=0||!Number.isSafeInteger(a.acceptedAt)||a.acceptedAt<a.eventAt||a.acceptedAt>file.updated||!a.proof||typeof a.proof.signature!=='string'||!a.proof.signature)continue;
      rows.push({a:a.mint,phase:a.phase,eventAt:a.eventAt,acceptedAt:a.acceptedAt,n:row.n||'',s:row.s||'',i:row.i||'',proofSig:a.proof.signature,family:a.proof.family||null});
    }
  }
  return rows;
}
async function loadInternal(){
  var today=day(now()),yesterday=day(now()-864e5);
  var names=['status.json','observations-v2/summary/day/'+today+'.json','observations-v2/summary/day/'+yesterday+'.json',null,null,'observations-v2/summary/live.json',
    'source/status.json','source/day/'+today+'.json','source/day/'+yesterday+'.json','source/live.json',
    'research-v2/status.json','research-v2/polygon-1.json',
    'passed-v2/status.json','passed-v2/live.json',
    'passed-v2/day/'+today+'.json','passed-v2/day/'+yesterday+'.json',
    'research-v2/status-two.json','research-v2/polygon-2.json',
    'research-v2/auto-1.json','research-v2/auto-2.json','control/endpoint.json',
    'research-v2/curve-two.json','research-v2/filter-audit.json'];
  var fetched=await Promise.allSettled(names.map(function(name,i){
    if(!name)return Promise.resolve(null);
    if(i===11&&lastResearchBankRead&&now()-lastResearchBankRead<300000)return Promise.resolve(null);
    if(i===17&&lastSecondBankRead&&now()-lastSecondBankRead<300000)return Promise.resolve(null);
    return getJSON(name);
  }));
  var vals=fetched.map(function(q){return q.status==='fulfilled'?q.value:null});
  var errors=fetched.filter(function(q){return q.status==='rejected'});
  if(vals.slice(1,3).every(function(x){return !x})&&!vals[5]&&!vals[6]){
    // Previously rendered candidates must not remain active when the
    // authoritative source is unavailable on a later refresh.
    sourceActive=false;sourceMeta=null;sourceRecords=[];
    researchMeta=null;researchServerBank=false;bank['1']=[];
    serverPassActive=false;serverPassRows=[];passMeta=null;
    serverR2Active=false;serverR2Rows=[];serverR2Curve=null;twoMeta=null;autoOne=null;filterAuditMeta=null;bank['2']=[];
    lastAccepted=[];lastVisible=[];lastPassed=[];
    renderAll();renderPassed();renderR1();renderLibrary();
    dataErr=errors.length?String(errors[0].reason):'Сервер пока не опубликовал данные';
    $('dataState').textContent='Не удалось получить главный источник: '+dataErr+'. Повтор через 45 секунд.';
    $('net').textContent='● Источник недоступен';$('net').className='live bad';
    return;
  }
  status=vals[0]||status;
  controlEndpoint=validControlEndpoint(vals[20]);
  // Управление с телефона: поля пароля и выбор возраста видны только когда защищённый сервис работает.
  (function(){var on=!!controlEndpoint;if($('ageOwnerBlock'))$('ageOwnerBlock').classList.toggle('hide',!on);
    ['ageBefore','ageAfter'].forEach(function(id){if($(id))$(id).disabled=!on});
    var h=document.querySelector?document.querySelector('#ageFilterBox .hint'):null;if(h)h.textContent=on?'Выбери возраст, введи пароль, отметь галочку и нажми «Изменить возраст на сервере». Применится к новым монетам.':'Возраст задаёт сервер. Менять его с телефона можно будет после подключения управления.';})();
  $('publishServerConfig').disabled=!controlEndpoint;
  $('ownerControlKey').disabled=!controlEndpoint;
  $('ageOwnerKey').disabled=!controlEndpoint;
  $('ownerResearchOneKey').disabled=!controlEndpoint;
  $('ownerResearchTwoKey').disabled=!controlEndpoint;
  if(!controlEndpoint)$('controlState').textContent=
    'Защищённая отправка не включена. Можно подготовить серверную конфигурацию файлом.';
  if(researchMeta&&vals[10]&&
     researchMeta.cohortStart!==vals[10].cohortStart){
    // A new research definition owns a NEW bank. Never reuse the old rows
    // even during the 5-minute cache refresh interval.
    bank['1']=[];researchServerBank=false;lastResearchBankRead=0;
  }
  if(vals[10]&&vals[10].status==='observational'&&vals[10].settings &&
     Number.isFinite(vals[10].updated)&&now()-vals[10].updated<=7*60000){
    if(!researchMeta&&!researchServerBank)bank['1']=[];
    researchMeta=vals[10];
    // The polygon is owned by the server. Phone sliders cannot change
    // server labels until a secure settings API has been implemented.
    s.r1Hours=researchMeta.settings.hours;
    s.r1Activity=researchMeta.settings.minActive;
    s.r1Idle=researchMeta.settings.maxIdle;
    $('r1Hours').value=s.r1Hours;$('r1HoursValue').textContent=s.r1Hours+' часов';
    $('r1Activity').value=s.r1Activity;$('r1ActivityValue').textContent=s.r1Activity+'%';
    $('r1Idle').value=s.r1Idle;$('r1IdleValue').textContent=s.r1Idle+' минут';
    for(const id of ['r1Hours','r1Activity','r1Idle'])$(id).disabled=!controlEndpoint;
    $('applyR1').disabled=true;
    $('publishResearchOne').disabled=!controlEndpoint;
  }
  if(!vals[10]||vals[10].status!=='observational'||!Number.isFinite(vals[10].updated)||now()-vals[10].updated>7*60000){
    researchMeta=null;researchServerBank=false;bank['1']=[];
  }
  if(researchMeta&&vals[11]&&vals[11].epochStart===researchMeta.cohortStart&&
     Array.isArray(vals[11].coins)&&vals[11].counts){
    const sourceRows=vals[11].coins.filter(function(x){
      return x.mint&&Number.isFinite(x.activePct)&&Number.isFinite(x.maxIdleObserved)&&x.features;
    });
    bank['1']=sourceRows.map(function(x){
      return {mint:x.mint,t:x.acceptedAt,activity:x.activePct,
        idle:x.maxIdleObserved,features:x.features};
    }).sort(function(a,b){return a.t-b.t});
    researchServerBank=true;
    lastResearchBankRead=now();
  }
  // Server records are authoritative only while their own heartbeat is fresh.
  passMeta=vals[12]&&Number.isFinite(vals[12].updated)&&
    now()-vals[12].updated<7*60000&&
    ['server-observational','disabled-no-server-rules'].includes(vals[12].status)&&
    vals[12].serverOnly===true?vals[12]:null;
  serverPassActive=!!passMeta;
  if(passMeta?.serverConfig?.enabled&&!s.filters.length){s.filters=clone(passMeta.serverConfig.filters||[]);s.modules=clone(passMeta.serverConfig.modules||[]);s.decision=passMeta.serverConfig.decisionMinutes;save();}
  if(serverPassActive){
    const verified=new Map();
    for(const source of [vals[15],vals[14],vals[13]]){
      for(const p of source&&source.coins||[]){
        if(p&&typeof p.mint==='string'&&Number.isSafeInteger(p.acceptedAt)&&
           Number.isSafeInteger(p.firstSeenAt)&&Number.isSafeInteger(p.zeroAt)&&
           ['before','after'].includes(p.phase)&&Array.isArray(p.matches))
          verified.set(p.mint,p);
      }
    }
    serverPassRows=[...verified.values()].sort(function(a,b){return b.firstSeenAt-a.firstSeenAt});
  }else serverPassRows=[];
  if(twoMeta&&vals[16]&&twoMeta.cohortStart!==vals[16].cohortStart){
    serverR2Rows=[];serverR2Curve=null;bank['2']=[];lastSecondBankRead=0;
  }
  twoMeta=vals[16]&&vals[16].status==='observational'&&
    vals[16].origin==='server-verified-passed-only'&&
    Number.isFinite(vals[16].updated)&&now()-vals[16].updated<7*60000?vals[16]:null;
  serverR2Active=!!twoMeta;
  if(serverR2Active){
    s.r2Strong=twoMeta.settings.minAbove;
    $('r2Strong').value=s.r2Strong;$('r2StrongValue').textContent=s.r2Strong+'%';
    $('r2Strong').disabled=!controlEndpoint;$('applyR2').disabled=true;
    $('publishResearchTwo').disabled=!controlEndpoint;
    if(vals[17]&&vals[17].epochStart===twoMeta.cohortStart&&Array.isArray(vals[17].coins)){
      serverR2Rows=vals[17].coins.filter(function(row){
        return row&&typeof row.mint==='string'&&['strong','weak'].includes(row.label)&&
          Number.isFinite(row.pctAbove)&&row.features;
      });
      bank['2']=serverR2Rows.map(function(row){
        return {mint:row.mint,t:row.zeroAt,above:row.pctAbove,
          phase:row.phase,label:row.label,features:row.features}
      });
      lastSecondBankRead=now();
    }else if(!lastSecondBankRead||now()-lastSecondBankRead>=300000){
      serverR2Rows=[];bank['2']=[];
    }
  }else{
    serverR2Rows=[];serverR2Curve=null;bank['2']=[];lastSecondBankRead=0;
    $('r2Strong').disabled=false;$('applyR2').disabled=false;
    $('publishResearchTwo').disabled=true;
  }
  serverR2Curve=serverR2Active&&vals[21]&&vals[21].epochStart===twoMeta.cohortStart&&
    vals[21].origin==='server-verified-passed-only'&&vals[21].curves&&
    Number.isFinite(vals[21].updated)&&now()-vals[21].updated<45*60000?
    vals[21].curves:null;
  autoOne=researchMeta&&vals[18]&&vals[18].epochStart===researchMeta.cohortStart&&
    Number.isFinite(vals[18].updated)&&
    now()-vals[18].updated<40*60000?vals[18]:null;
  autoTwo=twoMeta&&vals[19]&&vals[19].epochStart===twoMeta.cohortStart&&
    Number.isFinite(vals[19].updated)&&
    now()-vals[19].updated<40*60000?vals[19]:null;
  filterAuditMeta=vals[22]&&vals[22].origin==='server-observational-analytics'&&
    Number.isFinite(vals[22].updated)&&now()-vals[22].updated<40*60000?vals[22]:null;
  sourceActive=false;sourceMeta=null;sourceRecords=[];
  $('ageBefore').disabled=true;$('ageAfter').disabled=true;
  $('publishSourceAge').disabled=true;
  if(vals[6]&&['verified-post-only','verified-pre-post'].includes(vals[6].mode)&&
     vals[6].settings&&Number.isFinite(vals[6].updated)&&now()-vals[6].updated<=7*60000 &&
     [vals[6].settings.beforeMinutes,vals[6].settings.afterMinutes].every(function(v){
       return Number.isInteger(v)&&v>=1&&v<=10;
     })&&(vals[7]||vals[9])) {
    sourceActive=true;sourceMeta=vals[6];
    var unique=new Map();
    for(var item of (vals[8]?.coins||[]).concat(vals[7]?.coins||[],vals[9]?.coins||[])) {
      if(item.a&&item.phase&&Number.isSafeInteger(item.eventAt)&&Number.isSafeInteger(item.acceptedAt))unique.set(item.a,item);
    }
    // Exact server journal records embedded in the 30-second summary.
    // This copies admissions; it never runs the admission gate on the phone.
    for(const item of canonicalAdmissions([vals[1],vals[2],vals[5]],now()))if(!unique.has(item.a))unique.set(item.a,item);
    sourceRecords=[...unique.values()];
    s.ageBefore=sourceMeta.settings.beforeMinutes;
    s.ageAfter=sourceMeta.settings.afterMinutes;
    $('ageBefore').value=s.ageBefore;$('ageAfter').value=s.ageAfter;
    $('ageBefore').disabled=!controlEndpoint;$('ageAfter').disabled=!controlEndpoint;
    $('publishSourceAge').disabled=!controlEndpoint;
    $('ageBefore').title=controlEndpoint?'Изменяется только по ключу владельца':'Управление возрастом ещё не подключено';
    $('ageAfter').title=$('ageBefore').title;
  }
  if(!sourceActive){serverPassActive=false;serverPassRows=[];}
  var by=new Map();
  for(var dayObj of [vals[2],vals[1]])for(var c of observationCoins(dayObj)){
    if(mint(c))by.set(mint(c),Object.assign({},by.get(mint(c))||{},c));
  }
  for(var c2 of observationCoins(vals[5])){
    var prior=by.get(mint(c2));by.set(mint(c2),Object.assign({},prior||{},c2));
  }
  dataset=[...by.values()];
  dataErr='';
  loadedAt=now();
  var updated=status&&ts(status.updated),age=updated?Math.floor((now()-updated)/60000):null;
  var connected=age!=null&&age<=8&&sourceActive;
  $('net').textContent=connected?'● LIVE':'● '+(!sourceActive?'Источник недоступен':age==null?'Данные':'Задержка '+Math.max(0,age)+' мин');
  $('net').className='live '+(connected?'good':'warn');
  $('dataState').textContent='Сервер: '+(updated?time(updated):'—')+' (Казахстан) · '+(sourceActive?'главный источник '+fmt(sourceRecords.length)+' записей, сегодня '+fmt(sourceMeta.today)+' (до '+fmt(sourceMeta.todayBefore)+', после '+fmt(sourceMeta.todayAfter)+')':'допуск приостановлен (основной журнал недоступен)')+' · обновление каждые 45 секунд.';
  refresh();
}
// Lightweight foreground refresh for short Passed windows. Do not poll all
// research files on a 15-second timer on low-memory Android devices.
let passPolling=false;
async function pollPassedLive(){
  if(passPolling||fetching||!sourceActive||!serverPassActive||document.hidden)return;
  passPolling=true;
  try{
    const payload=await getJSON('passed-v2/live.json');
    if(!payload||payload.origin!=='server-journal'||!Array.isArray(payload.coins)||
       !Number.isFinite(payload.updated)||now()-payload.updated>180000)return;
    const current=new Map(serverPassRows.filter(function(p){
      return p.firstSeenAt>now()-72*3600000;
    }).map(function(p){return [p.mint,p]}));
    for(const row of payload.coins){
      if(!row||typeof row.mint!=='string'||!Number.isSafeInteger(row.acceptedAt)||
         !Number.isSafeInteger(row.firstSeenAt)||!Number.isSafeInteger(row.zeroAt)||
         !['before','after'].includes(row.phase)||!Array.isArray(row.matches)||
         row.zeroAt<=row.firstSeenAt||row.firstSeenAt>now()+60000)continue;
      current.set(row.mint,row);
    }
    serverPassRows=[...current.values()].sort(function(a,b){
      return b.firstSeenAt-a.firstSeenAt;
    });
    lastPassed=passedCoins(lastAccepted);
    renderPassed();
  }catch(e){
    // The normal 45-second full refresh is responsible for error reporting.
  }finally{passPolling=false}
}
async function load(){
  if(fetching)return;
  fetching=true;
  try{
    await loadInternal();
  }catch(e){
    // A malformed server response or UI rendering error must not deadlock
    // the refresh loop: the next 45-second cycle can recover automatically.
    sourceActive=false;sourceMeta=null;sourceRecords=[];
    serverPassActive=false;serverPassRows=[];passMeta=null;
    serverR2Active=false;serverR2Rows=[];serverR2Curve=null;twoMeta=null;
    researchMeta=null;autoOne=null;autoTwo=null;
    bank['1']=[];bank['2']=[];
    lastAccepted=[];lastPassed=[];lastVisible=[];
    const message=String(e&&e.message||e).slice(0,180);
    $('net').textContent='● Ошибка получения данных';
    $('net').className='live bad';
    $('dataState').textContent='Ошибка обновления данных: '+message+
      '. Следующая попытка через 45 секунд.';
    try{renderAll();renderPassed();renderR1();renderR2();renderLibrary()}catch(_ignored){}
  }finally{
    fetching=false;
  }
}
function init(){
  s.ageBefore=clamp(s.ageBefore,1,10,2);s.ageAfter=clamp(s.ageAfter,1,10,2);
  s.limit=[10,20,30,50,100].includes(+s.limit)?+s.limit:20;
  s.decision=clamp(s.decision,1,30,10);s.r1Hours=clamp(s.r1Hours,1,24,5);
  s.r1Activity=clamp(s.r1Activity,0,100,70);s.r1Idle=clamp(s.r1Idle,5,120,60);
  s.r2Strong=clamp(s.r2Strong,1,100,70);s.r2Step=[1,5,10,15,30,60].includes(+s.r2Step)?+s.r2Step:5;
  s.level=['1','2'].includes(s.level)?s.level:'1';s.stream=['all','before','after'].includes(s.stream)?s.stream:'all';
  s.r2Stream=['before','after'].includes(s.r2Stream)?s.r2Stream:'after';
  if(!['all','mine','passed','r1','r2','library'].includes(s.tab))s.tab='all';
  $('ageBefore').innerHTML=Array.from({length:10},function(_,i){return '<option value="'+(i+1)+'">'+(i+1)+' мин</option>'}).join('');
  $('ageAfter').innerHTML=$('ageBefore').innerHTML;
  $('ageBefore').value=s.ageBefore;$('ageAfter').value=s.ageAfter;$('cardLimit').value=s.limit;
  for(var pair of [['decisionMins',s.decision],['r1Hours',s.r1Hours],['r1Activity',s.r1Activity],['r1Idle',s.r1Idle],['r2Strong',s.r2Strong]])$(pair[0]).value=pair[1];
  $('decisionValue').textContent=s.decision+' мин';$('decisionCurrent').textContent=s.decision+' мин';$('r1HoursValue').textContent=s.r1Hours+' часов';
  $('r1ActivityValue').textContent=s.r1Activity+'%';$('r1IdleValue').textContent=s.r1Idle+' минут';
  $('r2StrongValue').textContent=s.r2Strong+'%';$('r2Step').value=s.r2Step;
  // Previously saved phone-side studies are not verified server polygons.
  bank['1']=[];bank['2']=[];
  $('passedDay').innerHTML=Array.from({length:14},function(_,i){
    const d=day(now()-i*864e5);
    return '<option value="'+d+'">'+d+'</option>';
  }).join('');
  document.querySelectorAll('#tabs [data-page]').forEach(function(x){x.classList.toggle('active',x.dataset.page===s.tab)});
  document.querySelectorAll('.page').forEach(function(x){x.hidden=x.id!=='p-'+s.tab});
  document.querySelectorAll('#allStreams [data-stream]').forEach(function(x){x.classList.toggle('active',x.dataset.stream===s.stream)});
  document.querySelectorAll('#r2Streams [data-stream]').forEach(function(x){x.classList.toggle('active',x.dataset.stream===s.r2Stream)});
  document.querySelectorAll('#levels [data-level]').forEach(function(x){x.classList.toggle('active',x.dataset.level===s.level)});
  bind();refresh();load();
  setInterval(load,45000);
  setInterval(tickAges,1000);setInterval(pollMarket,15000);setTimeout(pollMarket,1500);setInterval(loadLogos,2000);setInterval(function(){if(document.getElementById('openCoinDetail')&&now()-TRADES_AT>10000)loadTrades()},5000);
  setInterval(pollPassedLive,15000);
  document.addEventListener('visibilitychange',function(){
    if(!document.hidden){pollPassedLive();if(now()-loadedAt>60000)load()}
  });
  setInterval(function(){renderDailySource();if(dataset.length){renderAll();renderPassed()}},10000);
}
window.addEventListener('error',function(e){if($('dataState'))$('dataState').textContent='Ошибка интерфейса: '+(e.message||'неизвестная')+'. Старый сайт доступен по кнопке сверху.'});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
