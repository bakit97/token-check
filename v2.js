(function(){
'use strict';
if(window.__SOLSCAN_V2__)return;
window.__SOLSCAN_V2__=true;
var BASE='https://storage.googleapis.com/sol-scan-511718-data/';
var STORE='solscan_v2_state_20261017';
var BANK='solscan_v2_polygons_20261017';
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
var bank=Object.assign({'1':[],'2':[]},loadLocal(BANK,{'1':[],'2':[]}));
for(var lv of ['1','2'])if(!Array.isArray(bank[lv]))bank[lv]=[];
var dataset=[],status=null,dataErr='',loadedAt=0,picker=null,editorId=null,lastPassed=[],lastR1=[],lastR2=[],lastAccepted=[],lastVisible=[],testHtml='',lastBankWrite=0,lastResearchBankRead=0,researchMeta=null,researchServerBank=false,fetching=false,sourceActive=false,sourceMeta=null,sourceRecords=[];
var phaseNames={before:'🌱 До миграции',after:'🎓 После миграции'};
function save(){try{localStorage.setItem(STORE,JSON.stringify(s))}catch(e){note('Не удалось сохранить настройки на устройстве')}}
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
  var data=(c.ds||[]).filter(function(d){return Number(d[0])*1000<=cutoff}).sort(function(a,b){return a[0]-b[0]});
  var d=data.length?data[data.length-1]:null;
  var bx=c.bx&&c.bx.at<=cutoff?c.bx:null;
  var gx=(c.gx||[]).filter(function(x){return x[0]*1000<=cutoff}).at(-1);
  function num(v){return v==null?null:Number.isFinite(+v)?+v:null}
  return {buyers:num(bx&&bx.payers!=null?bx.payers:gx?gx[7]:null),
    trades:d&&num(d[4])!=null&&num(d[5])!=null?num(d[4])+num(d[5]):null,
    volume:d?num(d[6]):null,liq:d?num(d[2]):null};
}
function ruleStatus(features,f){
  const v=features?.[f.key];
  if(typeof v!=='number'||!Number.isFinite(v))return 'unknown';
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
  if(sourceActive) {
    const byMint=new Map(dataset.map(function(c){return [mint(c),c]}));
    return sourceRecords.map(function(record){
      var raw=byMint.get(record.a)||{};
      return Object.assign({},raw,{a:record.a,n:raw.n||record.n||'',
        s:raw.s||record.s||'',i:raw.i||record.i||'',
        _entry:{phase:record.phase,eventAt:record.eventAt,acceptedAt:record.acceptedAt},
        _sourceProof:record.proofSig||null});
    }).sort(function(a,b){return b._entry.acceptedAt-a._entry.acceptedAt});
  }
  var list=[];
  var used=new Set();
  for(var c of dataset){
    var a=mint(c);if(!a||used.has(a))continue;
    var entry=freshAdmission(c);if(!entry)continue;
    used.add(a);list.push(Object.assign({_entry:entry},c));
  }
  list.sort(function(a,b){return b._entry.acceptedAt-a._entry.acceptedAt});
  return list;
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
  if(!s.modules.some(function(m){return m.enabled}))return [];
  var out=[];
  for(var c of coins){
    var start=c._entry.acceptedAt,deadline=start+s.decision*60000;
    var available=dataMetrics(c,Math.min(now(),deadline));
    var matches=[];
    for(var m of s.modules){
      if(!m.enabled||m.phase!==c._entry.phase)continue;
      var f=s.filters.find(function(x){return x.id===m.filterId});
      if(f&&ruleMatch(available,f))matches.push(f);
    }
    if(matches.length)out.push({coin:c,deadline:deadline,matches:matches,features:available});
  }
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
  if(!researchMeta)storeBank('1',lastR1.map(function(x){return {mint:mint(x.coin),t:x.coin._entry.acceptedAt,activity:x.result.score,idle:x.result.maxIdle,features:dataMetrics(x.coin,x.coin._entry.acceptedAt+s.decision*60000)}}));
  storeBank('2',lastR2.map(function(x){return {mint:mint(x.passed.coin),t:x.passed.deadline,above:x.result.score,features:x.passed.features}}));
}
function spark(c){
  var points=(c.ds||[]).slice(-12).map(function(x){return Number(x[1])}).filter(function(x){return x>0});
  if(points.length<2)return '';
  var low=Math.min.apply(null,points),high=Math.max.apply(null,points),span=high-low||high*.01||1;
  var d=points.map(function(p,i){return (i===0?'M':'L')+(i/(points.length-1)*59).toFixed(1)+' '+(24-20*(p-low)/span).toFixed(1)}).join(' ');
  var up=points.at(-1)>=points[0];
  return '<svg viewBox="0 0 62 28" class="spark" role="img" aria-label="График цены"><path d="'+d+'" fill="none" stroke="'+(up?'#38d996':'#fc6b83')+'" stroke-width="2.3" stroke-linecap="round"/></svg>';
}
function coinHtml(c,extra){
  var e=c._entry,p=(c.ds||[]).at(-1),img=safeImg(c.i);
  var age=ageM(e.eventAt),name=esc(c.n||c.s||'Токен'),symbol=esc(c.s||'');
  var metric=p?'L $'+fmt(p[2]||0)+' · 5м $'+fmt(p[6]||0):'Нет последних снимков';
  return '<button type="button" class="coin" data-coin="'+esc(mint(c))+'">'+
    (img?'<img class="avatar" src="'+esc(img)+'" alt="" loading="lazy">':'<span class="avatar empty">'+esc((c.s||'?').slice(0,2))+'</span>')+
    '<span class="body"><span class="name">'+name+' <small>'+symbol+'</small></span><span class="detail">'+age+' · '+(e.phase==='before'?'🌱 до':'🎓 после')+'</span><span class="detail">'+metric+'</span>'+
    (extra?'<span class="detail">'+esc(extra)+'</span>':'')+'</span><span class="right"><span class="price">'+price(p&&p[1])+'</span>'+spark(c)+'</span></button>';
}
function detail(c){
  var e=c._entry,p=(c.ds||[]).at(-1)||[];
  return '<div class="card" id="openCoinDetail"><div class="row"><h2>'+esc(c.n||c.s||'Монета')+'</h2><button id="closeCoin">Закрыть</button></div>'+
    '<div class="label">Адрес mint</div><div class="mono" style="overflow-wrap:anywhere;font-size:12px;margin:6px 0">'+esc(mint(c))+'</div>'+
    '<div class="statgrid"><div class="stat"><span>Начало потока</span><strong style="font-size:15px">'+time(e.eventAt)+'</strong></div>'+
    '<div class="stat"><span>Первое подтверждение</span><strong style="font-size:15px">'+time(e.acceptedAt)+'</strong></div>'+
    '<div class="stat"><span>Цена последняя</span><strong style="font-size:15px">'+price(p[1])+'</strong></div>'+
    '<div class="stat"><span>Объём 5 мин</span><strong style="font-size:15px">$'+fmt(p[6]||0)+'</strong></div></div>'+
    '<p class="hint">Источники проверки: '+esc(c.mk||c.d||'нет данных')+'. Допуск рассчитан по доступной выгрузке, а не по новому серверному журналу.</p></div>';
}
function renderAll(){
  var today=day(now());
  var count=sourceActive?sourceMeta.today:lastAccepted.filter(function(c){return day(c._entry.acceptedAt)===today}).length;
  $('admitCount').textContent=fmt(count);$('visibleCount').textContent=fmt(lastVisible.length);
  $('todayTab').textContent=count?' '+fmt(count):'';
  $('sourceNote').textContent=sourceActive?
    (sourceMeta?.preConnected?'✓ Главный источник: журнал сервера. До миграции — публичные торговые кривые Pump.fun; после — подтверждённые миграции. Дублей нет.':'⚠ Источник до миграции пока не подтвердил связь с сетью. Постмиграционные события продолжают проверяться.')+' Возраст проверяется при ВХОДЕ, карточка не исчезает через 2 минуты.':
    '⚠ Рабочий журнал источника пока не доступен. Список ниже — ПРЕДВАРИТЕЛЬНОЕ отображение старых данных, а не подтверждённый новый главный источник.';
  var list=lastVisible.slice(0,s.limit);
  $('coinList').innerHTML=list.length?list.map(function(c){return coinHtml(c)}).join(''):'<div class="empty-state">Пока нет подтверждённых записей в этом потоке. Монеты, не успевшие пройти фильтр возраста на входе, не добавляются позже задним числом.</div>';
}
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
        html+='<div class="module"><input type="checkbox" data-toggle="'+esc(m.filterId)+'" data-phase="'+phase+'" '+(m.enabled?'checked':'')+' aria-label="Включить модуль"><span>'+esc(f.name)+'</span><button data-remove="'+esc(m.filterId)+'" data-phase="'+phase+'" aria-label="Удалить модуль">×</button></div>';
      }
      html+='</div>';
    }
    html+='</div>';
  }
  $('moduleGrid').innerHTML=html;
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
  $('passedStats').textContent='Всего найдено по текущим фильтрам: '+fmt(lastPassed.length)+' · время решения не истекло: '+fmt(list.length)+'.';
  $('passedList').innerHTML=list.length?list.map(function(q){
    var left=Math.max(0,q.deadline-now()),sec=Math.ceil(left/1000),mins=Math.floor(sec/60);
    return '<div class="card"><div class="row"><b>'+esc(q.coin.n||q.coin.s||'Токен')+'</b><span class="badge warn mono">⏳ '+mins+':'+String(sec%60).padStart(2,'0')+'</span></div><p class="muted">Прошли: '+q.matches.map(function(f){return esc(f.name)}).join(', ')+'</p>'+coinHtml(q.coin)+'</div>';
  }).join(''):'<div class="empty-state">Пока нет монет, прошедших включённые модули с действующим таймером. Создай фильтр в библиотеке и включи его в «Мои фильтры».</div>';
}
function renderR1(){
  if(researchMeta){
    const cfg=researchMeta.settings||{},counts=researchMeta.counts||{},p=researchMeta.pending||{};
    const a=counts.live||0,b=counts.dead||0;
    $('r1Live').textContent=fmt(a);$('r1Dead').textContent=fmt(b);
    $('r1Meter').style.width=Math.min(100,a)+'%';
    $('r1Auto').textContent='Серверные наблюдения · '+cfg.hours+' ч · активность ≥'+cfg.minActive+
      '% · простой ≤'+cfg.maxIdle+' мин. Размечено живых: '+a+
      '/100. Ожидают окончания наблюдения: '+(p['not-yet-finished']||0)+
      ', недостаточно данных: '+(p['insufficient-activity-coverage']||0)+
      '. Автоподбор правил пока не запущен.';
    const rows=bank['1'].slice(-10).reverse();
    $('r1Rows').innerHTML=rows.length?'<h2>Размечено на сервере</h2>'+rows.map(function(x){
      const positive=x.activity>=cfg.minActive&&x.idle<=cfg.maxIdle;
      return '<div class="vrow"><div class="row"><b class="mono">'+esc(x.mint.slice(0,11))+'…</b>'+
        '<span class="badge '+(positive?'good':'bad')+'">'+(positive?'🟢 Живая':'🔴 Мёртвая')+'</span></div>'+
        '<p class="muted">Активность '+x.activity.toFixed(1)+'% · пауза '+x.idle+' мин · данные сохранены на сервере</p></div>';
    }).join(''):'<div class="muted">Пока нет монет с завершённым и достаточно полным наблюдением. Сервер продолжает сбор.</div>';
    return;
  }
  var a=lastR1.filter(function(x){return x.result.label==='live'}).length;
  var b=lastR1.filter(function(x){return x.result.label==='dead'}).length;
  $('r1Live').textContent=fmt(a);$('r1Dead').textContent=fmt(b);
  $('r1Meter').style.width=Math.min(100,a)+'%';
  $('r1Auto').textContent='Размечено живых: '+a+'/100. '+(a<100?'Ожидание накопления. ':'Порог достигнут. ')+'Серверный поиск условий по зелёной зоне ещё не подключён.';
  $('r1Rows').innerHTML=lastR1.length?'<h2>Завершённые наблюдения</h2>'+lastR1.slice(0,10).map(function(x){return '<div class="vrow"><div class="row"><b>'+esc(x.coin.n||x.coin.s||'Монета')+'</b><span class="badge '+(x.result.label==='live'?'good':'bad')+'">'+(x.result.label==='live'?'🟢 Живая':'🔴 Мёртвая')+'</span></div><p class="muted">Доля с активными сделками: '+x.result.score.toFixed(1)+'% · максимальный простой '+x.result.maxIdle+' мин · снимков '+x.result.observed+'/'+x.result.total+'</p></div>'}).join(''):'<div class="muted">Подтверждённой разметки пока нет. Нужны завершённые наблюдения 1–24 часа с достаточным покрытием торговых сделок.</div>';
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
  return {curve:curve,valid:valid,pending:pending,strong:strong,weak:weak,lines:lines};
}
function renderR2(){
  var r=researchTwoDataset();
  $('r2Graph').innerHTML=lineGraph(r.curve.length>1?r.curve:[]);
  $('r2Stats').textContent='Размечено: 🟢 сильных '+r.strong+' · 🔴 слабых '+r.weak+' · недостаточно данных '+r.pending+'.';
  var out=[];
  for(var m=0;m<=300;m+=s.r2Step){
    var found=r.curve.find(function(p){return p.min===m});
    if(!found&&m%5!==0){var nearest=r.curve.filter(function(p){return p.min<=m}).at(-1);found=nearest?{min:m,pct:nearest.pct,n:nearest.n}:null}
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
function renderLibrary(){
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
    var orig=x.original?x.original.livePercent.toFixed(1)+'% / '+x.original.deadPercent.toFixed(1)+'%':'не проверен';
    return '<div class="filter-row"><div class="row"><b>№'+esc(x.id)+' · '+esc(x.name)+'</b><button type="button" class="pbtn" data-edit="'+esc(x.id)+'">Открыть</button></div>'+
      '<p class="muted">'+esc(({buyers:'Покупатели',trades:'Сделки',volume:'Объём $',liq:'Ликвидность $'})[x.key])+' '+esc(x.op)+' '+fmt(x.value)+' · версия '+fmt(x.version)+'</p>'+
      '<div class="numbers"><span class="badge">Первоначальный: '+orig+'</span><span class="badge">Фоновый: ожидает новые данные</span></div></div>';
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
  $('editorNote').textContent='Сохраняется только в этом браузере. Изменение условия создаёт новую версию.';
  $('editor').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function saveEditor(e){
  e.preventDefault();
  var name=$('filterName').value.trim(),key=$('filterKey').value,op=$('filterOp').value,value=Number($('filterValue').value);
  if(!name||!['buyers','trades','volume','liq'].includes(key)||!['>=','<='].includes(op)||!Number.isFinite(value)||value<0||value>1e12){note('Проверь название и значение');return}
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
  renderAll();renderModules();renderPassed();renderR1();renderR2();renderLibrary();
}
function bind(){
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
      s.ageBefore=+$('ageBefore').value;s.ageAfter=+$('ageAfter').value;
      note('Настройки витрины сохранены локально; серверные ограничения не изменены.');
    }else{
      s.ageBefore=sourceMeta.settings.beforeMinutes;s.ageAfter=sourceMeta.settings.afterMinutes;
      note('Количество карточек сохранено. Возрастные фильтры работают на сервере.');
    }
    save();refresh();
  });
  $('coinList').addEventListener('click',function(e){
    var b=e.target.closest('[data-coin]');if(!b)return;var c=lastAccepted.find(function(x){return mint(x)===b.dataset.coin});if(!c)return;
    var old=$('openCoinDetail');if(old)old.remove();
    $('coinList').insertAdjacentHTML('afterend',detail(c));
    $('closeCoin').addEventListener('click',function(){$('openCoinDetail').remove()});
  });
  $('moduleGrid').addEventListener('click',function(e){
    var pick=e.target.closest('[data-pick-source]');if(pick){showPicker(pick.dataset.pickSource,pick.dataset.pickLevel);return}
    var remove=e.target.closest('[data-remove]');if(!remove)return;
    s.modules=s.modules.filter(function(x){return !(x.filterId===remove.dataset.remove&&x.phase===remove.dataset.phase)});
    save();refresh();
  });
  $('moduleGrid').addEventListener('change',function(e){
    if(!e.target.matches('[data-toggle]'))return;
    var m=s.modules.find(function(x){return x.filterId===e.target.dataset.toggle&&x.phase===e.target.dataset.phase});
    if(m){m.enabled=e.target.checked;save();refresh()}
  });
  $('pickerItems').addEventListener('click',function(e){
    var b=e.target.closest('[data-use]');if(!b||!picker)return;
    s.modules.push({filterId:b.dataset.use,phase:picker.phase,level:picker.level,enabled:true});
    $('filterPicker').hidden=true;picker=null;save();refresh();
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
  $('applyR2').addEventListener('click',function(){s.r2Strong=+ $('r2Strong').value;save();refresh();note('Порог сильных/слабых применён')});
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
async function getJSON(path){
  var ctl=new AbortController(),timer=setTimeout(function(){ctl.abort()},20000);
  try{var r=await fetch(BASE+path+'?v='+now(),{signal:ctl.signal,cache:'no-store'});
    if(r.status===404||r.status===403)return null;
    if(!r.ok)throw new Error(path+' HTTP '+r.status);
    return await r.json();
  }finally{clearTimeout(timer)}
}
async function load(){
  if(fetching)return;fetching=true;
  var today=day(now()),yesterday=day(now()-864e5);
  var names=['status.json','day/'+today+'.json','day/'+yesterday+'.json','obs/'+today+'.json','obs/'+yesterday+'.json','live.json',
    'source/status.json','source/day/'+today+'.json','source/day/'+yesterday+'.json','source/live.json',
    'research-v2/status.json','research-v2/polygon-1.json'];
  var fetched=await Promise.allSettled(names.map(function(name,i){
    if(i===11&&lastResearchBankRead&&now()-lastResearchBankRead<300000)return Promise.resolve(null);
    return getJSON(name);
  }));
  var vals=fetched.map(function(q){return q.status==='fulfilled'?q.value:null});
  var errors=fetched.filter(function(q){return q.status==='rejected'});
  if(vals.slice(1,3).every(function(x){return !x})&&!vals[5]){
    dataErr=errors.length?String(errors[0].reason):'Сервер пока не опубликовал данные';
    $('dataState').textContent='Не удалось получить выгрузку: '+dataErr+'. Повтор через 45 секунд.';
    $('net').textContent='● Ожидание';$('net').className='live bad';fetching=false;return;
  }
  status=vals[0]||status;
  if(vals[10]&&vals[10].status==='observational'&&vals[10].settings){
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
    for(const id of ['r1Hours','r1Activity','r1Idle','applyR1'])$(id).disabled=true;
  }
  if(vals[11]&&Array.isArray(vals[11].coins)){
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
  if(vals[6]&&['verified-post-only','verified-pre-post'].includes(vals[6].mode)&&vals[6].settings) {
    sourceActive=true;sourceMeta=vals[6];
    var unique=new Map();
    for(var item of (vals[8]?.coins||[]).concat(vals[7]?.coins||[],vals[9]?.coins||[])) {
      if(item.a&&item.phase&&Number.isSafeInteger(item.eventAt)&&Number.isSafeInteger(item.acceptedAt))unique.set(item.a,item);
    }
    sourceRecords=[...unique.values()];
    s.ageBefore=sourceMeta.settings.beforeMinutes;
    s.ageAfter=sourceMeta.settings.afterMinutes;
    $('ageBefore').value=s.ageBefore;$('ageAfter').value=s.ageAfter;
    $('ageBefore').disabled=true;$('ageAfter').disabled=true;
    $('ageBefore').title='Возрастные фильтры сейчас устанавливаются на сервере';
    $('ageAfter').title='Возрастные фильтры сейчас устанавливаются на сервере';
  }
  var by=new Map();
  for(var dayObj of [vals[2],vals[1]])for(var c of dayObj&&dayObj.coins||[]){
    if(mint(c))by.set(mint(c),Object.assign({},by.get(mint(c))||{},c));
  }
  for(var o of [vals[4],vals[3]])for(var d of o&&o.coins||[]){
    var existing=by.get(mint(d));if(!existing)continue;
    if(Array.isArray(d.ds)&&d.ds.length>=(existing.ds||[]).length)existing.ds=d.ds;
    if(d.path)existing.path=d.path;
    if(d.lq)existing.lq=d.lq;
  }
  for(var c2 of vals[5]&&vals[5].coins||[]){
    var prior=by.get(mint(c2));by.set(mint(c2),Object.assign({},prior||{},c2));
  }
  dataset=[...by.values()];
  dataErr='';
  loadedAt=now();
  var updated=status&&ts(status.updated),age=updated?Math.floor((now()-updated)/60000):null;
  var connected=age!=null&&age<=8;
  $('net').textContent=connected?'● LIVE':'● '+(age==null?'Данные':'Задержка '+Math.max(0,age)+' мин');
  $('net').className='live '+(connected?'good':'warn');
  $('dataState').textContent='Сервер: '+(updated?time(updated):'—')+' (Казахстан) · '+(sourceActive?'главный источник '+fmt(sourceRecords.length)+' записей, сегодня '+fmt(sourceMeta.today)+' (до '+fmt(sourceMeta.todayBefore)+', после '+fmt(sourceMeta.todayAfter)+')':'устаревший поток '+fmt(dataset.length)+' записей')+' · обновление каждые 45 секунд.';
  refresh();fetching=false;
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
  document.querySelectorAll('#tabs [data-page]').forEach(function(x){x.classList.toggle('active',x.dataset.page===s.tab)});
  document.querySelectorAll('.page').forEach(function(x){x.hidden=x.id!=='p-'+s.tab});
  document.querySelectorAll('#allStreams [data-stream]').forEach(function(x){x.classList.toggle('active',x.dataset.stream===s.stream)});
  document.querySelectorAll('#r2Streams [data-stream]').forEach(function(x){x.classList.toggle('active',x.dataset.stream===s.r2Stream)});
  document.querySelectorAll('#levels [data-level]').forEach(function(x){x.classList.toggle('active',x.dataset.level===s.level)});
  bind();refresh();load();
  setInterval(load,45000);
  setInterval(function(){if(dataset.length){renderAll();renderPassed()}},10000);
}
window.addEventListener('error',function(e){if($('dataState'))$('dataState').textContent='Ошибка интерфейса: '+(e.message||'неизвестная')+'. Старый сайт доступен по кнопке сверху.'});
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();