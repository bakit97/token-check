'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
const js = fs.readFileSync(path.join(root,'server/observation-contract.js'),'utf8')+'\n'+fs.readFileSync(path.join(root,'v2.js'),'utf8');
// The mock transport serializes existing coin fixtures through the published schema-2 protocol.
function schemaFetch(fetch){return async function(url,...args){
  if(/sol-scan-511718-data\/(?:day\/|obs\/|live\.json)/.test(url))throw Error('Legacy observation endpoint requested');
  const r=await fetch(url,...args);if(!url.includes('observations-v2/')||!r?.json)return r;
  return {...r,json:async()=>{const data=await r.json();if(!data)return data;return {...data,schema:2,coins:(data.coins||[]).map(c=>require('../server/observation-contract').project({...c,t:c.t??c.mT??Date.now()-600000,p:c.p||'fixturePool'},{metadata:c}))};}};
};}

test('Server daily counters show zero only for healthy current-day feeds; missing, stale and stopped feeds show no data',()=>{
 const nodes=new Map(),at=Date.UTC(2026,9,17,18,59,59),date=t=>new Date(t+5*3600000).toISOString().slice(0,10);
 const row={seen:1240,accepted:312,tooOld:870,unverified:58,averageLateMs:90000};
 const context={sourceActive:true,sourceMeta:{updated:at,dailyAvailability:{before:false,after:true},daily:{schema:1,day:date(at),complete:true,partialDay:true,startedAt:at,after:row,before:{seen:0,accepted:0,tooOld:0,unverified:0}}},
   now:()=>at,day:date,fmt:String,time:()=> '23:59',Number,Map,Date,
   $:id=>{if(!nodes.has(id))nodes.set(id,{textContent:''});return nodes.get(id)}};
 const code=js.slice(js.indexOf('function dailySourceText('),js.indexOf('function renderLocalPreview('));
 vm.runInNewContext(code,context);context.renderDailySource();
 assert.equal(nodes.get('dailyBefore').textContent,'До миграции: нет данных');
 assert.match(nodes.get('dailyAfter').textContent,/увидели 1240 · прошли 312 · опоздали 870/);
 assert.match(nodes.get('dailyAfter').textContent,/1,5 мин/);
 assert.match(nodes.get('dailySourceNote').textContent,/день неполный/);
 context.sourceMeta.dailyAvailability.before=true;context.renderDailySource();
 assert.match(nodes.get('dailyBefore').textContent,/увидели 0 · прошли 0/);
 context.sourceMeta.updated=at-8*60000;context.renderDailySource();
 assert.equal(nodes.get('dailyAfter').textContent,'После миграции: нет данных');
 context.sourceMeta.updated=at;context.now=()=>at+1000;context.renderDailySource();
 assert.equal(nodes.get('dailyAfter').textContent,'После миграции: нет данных','previous-day status must not survive midnight');
 context.now=()=>at;context.sourceMeta.daily.complete=false;context.renderDailySource();
 assert.equal(nodes.get('dailyAfter').textContent,'После миграции: нет данных');
});

test('все шесть разделов имеют правильные ID',()=>{
  for(const id of ['p-all','p-mine','p-passed','p-r1','p-r2','p-library']){
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(html,/v2\.js/);
  assert.doesNotMatch(html,/classic\.html/);
  assert.match(html,/server\/observation-contract\.js/);
});
test('все статические ID, используемые JS, существуют в HTML',()=>{
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
  for(const m of js.matchAll(/\$\('([^']+)'\)/g)){
    if(['openCoinDetail','closeCoin','copyMint'].includes(m[1]))continue;
    assert.ok(ids.has(m[1]),'missing HTML id: '+m[1]);
  }
});
test('JS синтаксис и загрузка настоящего режима с тестовыми сетевыми событиями',async()=>{
  new vm.Script(js);
  const nodes = new Map();
  function fakeNode(id){
    if(nodes.has(id))return nodes.get(id);
    const el={id,innerHTML:'',textContent:'',value:'',hidden:false,dataset:{},style:{},disabled:false,
      classList:{toggle(){},add(){},remove(){}},
      addEventListener(){},querySelectorAll(){return[]},
      insertAdjacentHTML(){},scrollIntoView(){},remove(){},setAttribute(){}};
    nodes.set(id,el);return el;
  }
  const document={readyState:'complete',getElementById:fakeNode,querySelectorAll(){return[]},addEventListener(){}};
  const now=Date.now(),mint='So11111111111111111111111111111111111111112';
  const coin={a:mint,n:'Тестовая монета',s:'TEST',mst:'ok',mk:'pump',
    mT:now-25000,mSeen:now-20000,seen:now-20000,
    ds:[[Math.floor((now-10000)/1000),.000001,15000,40000,24,10,1200]]};
  const mocked={status:{updated:now},day:{coins:[coin]},obs:{coins:[]},live:{coins:[coin]}};
  const fetch=async url=>({
    ok:true,status:200,json:async()=>{
      if(url.includes('status.json'))return mocked.status;
      if(url.includes('live.json'))return mocked.live;
      if(url.includes('obs/'))return mocked.obs;
      if(url.includes('day/'))return mocked.day;
      return null;
    }
  });
  const memory=new Map();
  const localStorage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v)};
  const sandbox={window:{addEventListener(){}},document,localStorage,fetch:schemaFetch(fetch),
    AbortController,URL,console,Date,Intl,Math,Number,Map,Set,Array,String,Object,JSON,Error,
    setInterval:()=>0,setTimeout:(fn)=>{fn();return 0},clearTimeout:()=>{}};
  // Deferred loading completes while the VM is still alive.
  vm.runInNewContext(js,sandbox,{timeout:2000});
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.match(fakeNode('dataState').textContent,/допуск приостановлен/);
  assert.doesNotMatch(fakeNode('coinList').innerHTML,/Тестовая монета/);
  assert.equal(fakeNode('admitCount').textContent,'—');
  assert.equal(fakeNode('visibleCount').textContent,'—');
});


test('главный источник authoritative: только принятое событие и карточка не исчезает после 2 минут',async()=>{
  const nodes=new Map();
  function el(id){
    if(nodes.has(id))return nodes.get(id);
    const value={id,innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,dataset:{},style:{},
      classList:{toggle(){},add(){},remove(){}},
      addEventListener(){},querySelectorAll(){return[]},insertAdjacentHTML(){},scrollIntoView(){},remove(){}};
    nodes.set(id,value);return value;
  }
  const document={readyState:'complete',getElementById:el,querySelectorAll(){return[]},addEventListener(){}};
  const now=Date.now(),good='So11111111111111111111111111111111111111112';
  const other='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const coins=[{a:good,n:'Допущена',mst:'ok',mT:now-20*60e3,mSeen:now-19*60e3,
    ds:[[Math.floor(now/1000),0.0001,5000,10000,4,3,100]]},
    {a:other,n:'Не допущена',mst:'ok',mT:now-20*60e3,mSeen:now-19*60e3}];
  const src={updated:now,mode:'verified-post-only',today:1,total:1,
    settings:{beforeMinutes:2,afterMinutes:2}};
  const admitted={a:good,phase:'after',eventAt:now-20*60e3,acceptedAt:now-19*60e3};
  const fetch=async url=>({ok:true,status:200,json:async()=>{
    if(url.includes('source/status.json'))return src;
    if(url.includes('source/live.json')||url.includes('source/day/'))return {coins:[admitted]};
    if(url.includes('status.json'))return {updated:now};
    if(url.includes('obs/'))return {coins:[]};
    return {coins};
  }});
  const localStorage={getItem(){return null},setItem(){}};
  const sandbox={window:{addEventListener(){}},document,localStorage,fetch:schemaFetch(fetch),
    AbortController,URL,console,Date,Intl,Math,Number,Map,Set,Array,String,Object,JSON,Error,
    setInterval:()=>0,setTimeout:(fn)=>{fn();return 0},clearTimeout:()=>{}};
  vm.runInNewContext(js,sandbox,{timeout:2000});
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(el('admitCount').textContent,'1');
  assert.equal(el('visibleCount').textContent,'1');
  assert.match(el('coinList').innerHTML,/Допущена/);
  assert.doesNotMatch(el('coinList').innerHTML,/Не допущена/);
  assert.equal(el('ageAfter').disabled,true,'браузер не должен притворяться серверной настройкой');
  assert.match(el('sourceNote').textContent,/Источник до миграции|журнал сервера/);
});


test('полигон сервера: неопределённые показатели не считаются отклонёнными мёртвыми',async()=>{
  const nodes=new Map(),listeners=new Map();
  function el(id){
    if(nodes.has(id))return nodes.get(id);
    const value={id,innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,dataset:{},style:{},
      classList:{toggle(){},add(){},remove(){}},
      addEventListener(type,fn){listeners.set(id+':'+type,fn)},
      querySelectorAll(){return[]},insertAdjacentHTML(){},scrollIntoView(){},remove(){}};
    nodes.set(id,value);return value;
  }
  const document={readyState:'complete',getElementById:el,querySelectorAll(){return[]},addEventListener(){}};
  const now=Date.now(),address='So11111111111111111111111111111111111111112';
  const source={mode:'verified-pre-post',settings:{beforeMinutes:2,afterMinutes:2},
    today:1,todayBefore:1,todayAfter:0,updated:now};
  const token={a:address,n:'Тестовая монета',s:'TEST',
    ds:[[Math.floor(now/1000),1,2000,5000,10,3,500]]};
  const entry={a:address,phase:'before',eventAt:now-1000,acceptedAt:now-700};
  const bankRows=Array.from({length:1000},(_,i)=>({
    mint:'mon'+String(i).padStart(35,'1'),
    acceptedAt:now-6*3600e3-i*1000,
    activePct:i<500?100:0,maxIdleObserved:i<500?0:70,
    features:{buyers:i<500?30:i<750?5:null}
  }));
  const stats={status:'observational',updated:now,counts:{live:500,dead:500},
    settings:{hours:5,minActive:70,maxIdle:60,decisionMinutes:10},
    pending:{'not-yet-finished':0}};
  const fakeFetch=async url=>({ok:true,status:200,json:async()=>{
    if(url.includes('research-v2/status.json'))return stats;
    if(url.includes('research-v2/polygon-1.json'))return {counts:stats.counts,coins:bankRows};
    if(url.includes('source/status.json'))return source;
    if(url.includes('source/live.json')||url.includes('source/day/'))return {coins:[entry]};
    if(url.includes('status.json'))return {updated:now};
    if(url.includes('obs/'))return {coins:[]};
    return {coins:[token]};
  }});
  const prefs={level:'1',poly:{'1':[500,500],'2':[2000,2000]},
    filters:[{id:'001',level:'1',name:'Покупатели',key:'buyers',op:'>=',value:20,version:1}],
    modules:[]};
  const localStorage={getItem:k=>k==='solscan_v2_state_20261017'?JSON.stringify(prefs):null,setItem(){}};
  const ctx={window:{addEventListener(){}},document,localStorage,fetch:schemaFetch(fakeFetch),
    AbortController,URL,console,Date,Intl,Math,Number,Map,Set,Array,String,Object,JSON,Error,
    setInterval:()=>0,setTimeout:()=>0,clearTimeout:()=>{}};
  vm.runInNewContext(js,ctx,{timeout:4000});
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(el('r1Live').textContent,'500');
  assert.equal(el('r1Dead').textContent,'500');
  assert.equal(el('r1Activity').disabled,true);
  assert.equal(el('testAll').disabled,false);
  const event=listeners.get('testAll:click');
  assert.equal(typeof event,'function');
  event();
  assert.match(el('testResults').innerHTML,/250\/500/);
  assert.match(el('testResults').innerHTML,/Нет показателя: живые 0, мёртвые 250/);
  assert.doesNotMatch(el('testResults').innerHTML,/🔴 100\.0% \(500\/500\)/);
});


test('после пропадания сервера старые карточки не остаются как проверенные',async()=>{
  const nodes=new Map(),intervals=[];
  function el(id){
    if(nodes.has(id))return nodes.get(id);
    const node={id,innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,dataset:{},style:{},
      classList:{toggle(){},add(){},remove(){}},
      addEventListener(){},querySelectorAll(){return[]},insertAdjacentHTML(){},scrollIntoView(){},remove(){}};
    nodes.set(id,node);return node;
  }
  const document={readyState:'complete',getElementById:el,querySelectorAll(){return[]},addEventListener(){}};
  const now=Date.now(),mint='So11111111111111111111111111111111111111112';
  const coin={a:mint,n:'Принятая монета',s:'REAL',mst:'ok',
    mT:now-20000,mSeen:now-15000,ds:[[Math.floor(now/1000),1,2000,5000,2,1,100]]};
  const accepted={a:mint,phase:'after',eventAt:now-20000,acceptedAt:now-15000};
  let online=true;
  const fetch=async url=>{
    if(url.includes('source/status.json')&&!online)return {ok:false,status:503};
    return {ok:true,status:200,json:async()=>{
      if(url.includes('source/status.json'))return {mode:'verified-pre-post',updated:now,
        today:1,todayBefore:0,todayAfter:1,settings:{beforeMinutes:2,afterMinutes:2}};
      if(url.includes('source/live.json')||url.includes('source/day/'))return {coins:[accepted]};
      if(url.includes('research-v2/status.json'))return null;
      if(url.includes('status.json'))return {updated:now};
      if(url.includes('obs/'))return {coins:[]};
      return {coins:[coin]};
    }};
  };
  const env={window:{addEventListener(){}},document,localStorage:{getItem(){return null},setItem(){}},
    fetch:schemaFetch(fetch),AbortController,URL,console,Date,Intl,Math,Number,Map,Set,Array,String,Object,JSON,Error,
    setInterval:fn=>(intervals.push(fn),intervals.length),
    setTimeout:()=>0,clearTimeout:()=>{}};
  vm.runInNewContext(js,env,{timeout:2000});
  await new Promise(r=>setTimeout(r,70));
  assert.match(el('coinList').innerHTML,/Принятая монета/);
  assert.equal(el('net').textContent,'● LIVE');
  online=false;
  intervals[0]();
  await new Promise(r=>setTimeout(r,70));
  assert.doesNotMatch(el('coinList').innerHTML,/Принятая монета/);
  assert.match(el('sourceNote').textContent,/Главный источник сервера недоступен/);
  assert.equal(el('net').textContent,'● Источник недоступен');
  assert.equal(el('visibleCount').textContent,'—');
});

test('UI buyers must match server frozen 5-minute features, with stale data unknown',()=>{
  const begin=js.indexOf('function dataMetrics('),end=js.indexOf('\nfunction ruleStatus(',begin);
  assert.ok(begin>=0&&end>begin);
  const calc=vm.runInNewContext('('+js.slice(begin,end)+')');
  const cutoff=Date.UTC(2026,9,17,1,0,0),recent=Math.floor((cutoff-60000)/1000);
  const fresh=calc({ds:[[recent,1,200,300,4,5,123]],
    gx:[[recent,40,20,3,2,60,35,80,70]],
    bx:{at:cutoff-30000,cov:true,payers:45}},cutoff);
  assert.equal(fresh.buyers,3,'5m unique buyers must win over 15m and 10m');
  assert.equal(fresh.trades,9);
  const old=Math.floor((cutoff-9*60000)/1000);
  const stale=calc({ds:[[old,1,200,300,4,5,123]],gx:[[old,40,20,3,2,60,35,80,70]],
    bx:{at:cutoff-30000,cov:false,payers:45}},cutoff);
  assert.equal(stale.buyers,null,'missing or old coverage is not a zero or historical pass');
  assert.equal(stale.trades,null);
  assert.equal(stale.liq,null);
  const verified=calc({gx:[[recent,40,20,null,2,60,35,80,70]],
    bx:{at:cutoff-30000,cov:true,payers:17}},cutoff);
  assert.equal(verified.buyers,17,'verified 10m first-window fallback is allowed');
});

test('Passed journal preserves original version, deadline and detection after disabling filters',async()=>{
  const nodes=new Map(),listeners=new Map(),memory=new Map();
  function el(id){
    if(nodes.has(id))return nodes.get(id);
    const o={id,innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,dataset:{},style:{},
      classList:{toggle(){},add(){},remove(){}},
      addEventListener(type,fn){listeners.set(id+':'+type,fn)},
      querySelectorAll(){return []},insertAdjacentHTML(){},scrollIntoView(){},remove(){}};
    nodes.set(id,o);return o;
  }
  const now=Date.now(),acceptedAt=now-120000,mint='So11111111111111111111111111111111111111112';
  const source={mode:'verified-pre-post',updated:now,today:1,todayBefore:0,todayAfter:1,
    settings:{beforeMinutes:2,afterMinutes:2},preConnected:true};
  const entry={a:mint,phase:'after',eventAt:acceptedAt-1000,acceptedAt};
  const observed=Math.floor((now-30000)/1000);
  const coin={a:mint,n:'Фиксированная монета',s:'FREEZE',
    gx:[[observed,12,3,10,3,16,4,13,4]],
    ds:[[observed,0.001,12000,26000,12,3,1200]]};
  const defaults={decision:10,level:'1',filters:[
    {id:'001',level:'1',name:'Покупатели 8+',key:'buyers',op:'>=',value:8,version:3}
  ],modules:[{filterId:'001',phase:'after',level:'1',enabled:true}]};
  memory.set('solscan_v2_state_20261017',JSON.stringify(defaults));
  async function fetch(url){
    let value={coins:[]};
    if(url.includes('/source/status.json'))value=source;
    else if(url.includes('/source/day/')||url.includes('/source/live.json'))value={coins:[entry]};
    else if(url.includes('/research-v2/'))value=null;
    else if(url.includes('/status.json'))value={updated:now};
    else if(url.includes('/obs/'))value={coins:[]};
    else if(url.includes('/day/')||url.includes('/live.json'))value={coins:[coin]};
    return {status:200,ok:true,json:async()=>value};
  }
  const storage={getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v)};
  const document={readyState:'complete',getElementById:el,
    querySelectorAll(){return []},addEventListener(){}};
  function run(){
    vm.runInNewContext(js,{window:{addEventListener(){}},document,fetch:schemaFetch(fetch),localStorage:storage,
      AbortController,URL,console,Date,Intl,Math,Number,Map,Set,Array,String,Object,JSON,Error,
      setInterval:()=>0,setTimeout:()=>0,clearTimeout:()=>{}},{timeout:3000});
  }
  run();
  await new Promise(resolve=>setTimeout(resolve,60));
  let ledger=JSON.parse(memory.get('solscan_v2_verified_passes_20261017')||'[]');
  assert.equal(ledger.length,1);
  assert.equal(ledger[0].matches[0].version,3);
  assert.equal(ledger[0].deadline,acceptedAt+10*60000);
  assert.equal(ledger[0].features.buyers,10);
  assert.match(el('passedList').innerHTML,/Фиксированная монета/);
  const toggle=listeners.get('moduleGrid:change');
  toggle({target:{matches:()=>true,dataset:{toggle:'001',phase:'after'},checked:false}});
  el('decisionMins').value='25';
  listeners.get('applyDecision:click')();
  assert.match(el('passedList').innerHTML,/Фиксированная монета/);
  assert.equal(JSON.parse(memory.get('solscan_v2_verified_passes_20261017'))[0].deadline,acceptedAt+10*60000);
  assert.match(el('passedArchiveList').innerHTML,/v3/);
  // Reload from the same phone, now with every module disabled.
  nodes.clear();listeners.clear();
  run();
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.match(el('passedList').innerHTML,/Фиксированная монета/);
  assert.equal(JSON.parse(memory.get('solscan_v2_verified_passes_20261017')).length,1);
});

test('Expired historical coins never create fresh Passed signals on a late visit',async()=>{
  const nodes=new Map();
  function el(id){
    if(nodes.has(id))return nodes.get(id);
    const o={id,innerHTML:'',textContent:'',value:'',hidden:false,disabled:false,style:{},
      classList:{toggle(){},add(){},remove(){}},
      addEventListener(){},querySelectorAll(){return[]},insertAdjacentHTML(){},scrollIntoView(){},remove(){}};
    nodes.set(id,o);return o;
  }
  const t=Date.now(),mint='So11111111111111111111111111111111111111112';
  const entry={a:mint,phase:'after',acceptedAt:t-40*60000,eventAt:t-40*60000-1000};
  const observed=Math.floor((t-30000)/1000);
  const coin={a:mint,n:'Старый токен',gx:[[observed,100,50,90,40,100,50,95,40]],
    ds:[[observed,1,1000,2000,100,50,20000]]};
  const settings={decision:10,filters:[{id:'001',level:'1',name:'Buyers 8',key:'buyers',op:'>=',value:8,version:1}],
    modules:[{filterId:'001',phase:'after',level:'1',enabled:true}]};
  const memory=new Map([['solscan_v2_state_20261017',JSON.stringify(settings)]]);
  const fetch=async url=>({ok:true,status:200,json:async()=>{
    if(url.includes('/source/status.json'))return {mode:'verified-pre-post',updated:t,today:1,
      todayBefore:0,todayAfter:1,settings:{beforeMinutes:2,afterMinutes:2}};
    if(url.includes('/source/day/')||url.includes('/source/live.json'))return {coins:[entry]};
    if(url.includes('/research-v2/'))return null;
    if(url.includes('/status.json'))return {updated:t};
    if(url.includes('/obs/'))return {coins:[]};
    return {coins:[coin]};
  }});
  vm.runInNewContext(js,{window:{addEventListener(){}},
    document:{readyState:'complete',getElementById:el,querySelectorAll(){return[]},addEventListener(){}},
    localStorage:{getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,v)},
    fetch:schemaFetch(fetch),AbortController,URL,console,Date,Intl,Math,Number,Map,Set,Array,String,Object,JSON,Error,
    setInterval:()=>0,setTimeout:()=>0,clearTimeout:()=>{}},{timeout:3000});
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(memory.has('solscan_v2_verified_passes_20261017'),false);
  assert.doesNotMatch(el('passedList').innerHTML,/Старый токен/);
  assert.equal(el('passedArchiveCount').textContent,'0');
});

test('Unknown or zero placeholder volume is a dash in cards and detail; positive observed volume is shown',()=>{
 const scope={Number,Math,String,Date,Object,fmt:String,passMeta:null,serverPassRows:[],serverR2Rows:[],researchMeta:null,bank:{'1':[]},sourceMeta:null,safeImg:()=>'',ageM:()=>'',esc:String,mint:c=>c.a,price:()=>'',time:()=>'',now:()=>Date.now(),document:{querySelectorAll:()=>[],getElementById:()=>null}};
 const start=js.indexOf('// ---- Живые рыночные данные'),end=js.indexOf('function showCoinDetail(',start);
 vm.runInNewContext(js.slice(start,end),scope);
 for(const value of [null,undefined,0,NaN,'0']){
  const c={a:'mint',_entry:{eventAt:1,phase:'after'},ds:[[1,1,null,1,1,1,value]]};
  assert.doesNotMatch(scope.coinHtml(c),/5м \$0/);
  assert.match(scope.detail(c),/Объём 5м<\/span><b>—/);
 }
 assert.equal(scope.observedMoney(1234),'$1234');
 assert.match(html,/Всего допущено · за всё время/);assert.doesNotMatch(html,/На витрине сейчас/);
 assert.match(js,/fmt\(sourceMeta.total\)/);
});


test('compound owner publication preserves contract and SOL guards',()=>{
 const body=fs.readFileSync(path.join(root,'v2.js'),'utf8'),from=body.indexOf('function preparedServerConfig('),to=body.indexOf('function ',from+12);
 const cfg=require('../server/pass-filters.json'),context={s:{filters:cfg.filters,modules:cfg.modules,decision:15},moduleDraft:new Map(),note:()=>{},now:()=>2000000};
 vm.createContext(context);vm.runInContext(body.slice(from,to)+';this.config=preparedServerConfig();',context);
 assert.equal(context.config.filters[0].conditions.length,2);assert.equal(context.config.filters[0].conditions[1].key,'quoteSol');
});


test('fresh canonical summaries expose exact Source admissions before slower source/day publication',()=>{
 const at=2000000,mint='Mint'.padEnd(44,'a'),context={};vm.createContext(context);vm.runInContext(js.slice(js.indexOf('function canonicalAdmissions('),js.indexOf('async function loadInternal('))+';this.read=canonicalAdmissions;',context);
 const admission={v:1,mint,phase:'before',eventAt:at-15000,acceptedAt:at-10000,proof:{signature:'signed-create',family:'pump'}},row=require('../server/observation-contract').projectSummary({a:mint,p:'curve',t:admission.eventAt},{metadata:{n:'New'},admission}),file={schema:2,updated:at-1000,coins:[row]};
 assert.equal(context.read([file],at)[0].acceptedAt,admission.acceptedAt);assert.equal(context.read([file],at)[0].proofSig,'signed-create');
 assert.equal(context.read([{...file,updated:at-8*60000}],at).length,0);
 for(const change of [a=>delete a.proof,a=>a.mint='Other'.padEnd(44,'b'),a=>a.acceptedAt=at+1000,a=>a.eventAt=at+1000]){const copy=JSON.parse(JSON.stringify(file));change(copy.coins[0].observations.admission);assert.equal(context.read([copy],at).length,0);}
 const raw=require('../server/observation-contract').projectSummary({a:mint,p:'pool',t:at-15000});assert.equal(context.read([{schema:2,updated:at,coins:[raw]}],at).length,0,'third-party candidates without Source records never become admissions');
 assert.match(js,/if\(vals\[6\][\s\S]*canonicalAdmissions\(\[vals\[1\],vals\[2\],vals\[5\]\]/,'fresh Source heartbeat remains mandatory');
});
