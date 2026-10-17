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
  assert.match(fakeNode('dataState').textContent,/устаревший поток 1 записей/);
  assert.match(fakeNode('coinList').innerHTML,/Тестовая монета/);
  assert.equal(fakeNode('admitCount').textContent,'1');
  assert.equal(fakeNode('visibleCount').textContent,'1');
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
