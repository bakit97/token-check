'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root,'v2.html'),'utf8');
const js = fs.readFileSync(path.join(root,'v2.js'),'utf8');

test('все шесть разделов имеют правильные ID',()=>{
  for(const id of ['p-all','p-mine','p-passed','p-r1','p-r2','p-library']){
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(html,/v2\.js/);
  assert.match(html,/classic\.html/);
});
test('все статические ID, используемые JS, существуют в HTML',()=>{
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
  for(const m of js.matchAll(/\$\('([^']+)'\)/g)){
    if(['openCoinDetail','closeCoin'].includes(m[1]))continue;
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
  const sandbox={window:{addEventListener(){}},document,localStorage,fetch,
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
  const src={updated:now,mode:'verified-post-only',today:1,
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
  const sandbox={window:{addEventListener(){}},document,localStorage,fetch,
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
  const ctx={window:{addEventListener(){}},document,localStorage,fetch:fakeFetch,
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
    fetch,AbortController,URL,console,Date,Intl,Math,Number,Map,Set,Array,String,Object,JSON,Error,
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
  const begin=js.indexOf('function dataMetrics('),end=js.indexOf('\\nfunction ruleStatus(',begin);
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
