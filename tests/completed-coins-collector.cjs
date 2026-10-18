'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CompletedCoins}=require('../server/completed-coins'),stream=require('../server/stream-json'),contract=require('../server/observation-contract');
const code=fs.readFileSync(process.env.SOLSCAN_TEST_COLLECTOR||path.join(__dirname,'../server/collector.js'),'utf8'),H=3600000,clock=200000000,day=t=>new Date(t+5*H).toISOString().slice(0,10);
function coin(a,age,ok=true){return {a,p:a+'pool',t:clock-age*H,mg:{st:ok?'ok':'unk'},ds:[[1000,1,null],[1001,2,0]],lq:[[1001,1,2,3]],raw:{1:{at:1000000,b:['state']}}}}
function setup(t,coins,{failMirror=false,saveOk=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'retire-collector-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new CompletedCoins(dir),sent=new Map(),C=new Map(coins.map(c=>[c.a,c]));
 const ctx={C,COMPLETED:store,RETENTION:{removed:0},DIR:'mock',Date:{now:()=>clock},UPQ:[],RESEARCH_V2:null,RESEARCH_TWO:null,PASS_V2:null,OLD_RESEARCH_ONE:[],OLD_RESEARCH_TWO:[],SOURCE:{records:new Map(),get:()=>null},
  dayKey:day,lastYest:0,lastObs:0,FV:2,OBS_CONTRACT:{days:{}},setImmediate,err:()=>{},coinMetadata:c=>({a:c.a,t:c.t,ds:c.ds,n:c.n}),observedEligible:c=>c.mg?.st==='ok',
  reloadSourceAgeConfig:async()=>{},reloadResearchConfig:async()=>{},flushUploads:async()=>{},exportSource:async()=>{},exportResearchV2:async()=>{},exportPathsV2:async()=>{},
  save:()=>{if(!saveOk)return false;fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify([...C.values()]));return true},
  require:p=>p.endsWith('completed-coins.js')?require('../server/completed-coins'):p.endsWith('observation-contract.js')?contract:stream,
  upload:async(name,obj)=>{if(failMirror&&name.startsWith('observations-v2/'))throw Error('injected mirror failure');let text='';for await(const chunk of stream.jsonChunks(obj))text+=chunk;sent.set(name,JSON.parse(text))}};
 vm.createContext(ctx);vm.runInContext(code.slice(code.indexOf('async function exportObservationContract('),code.indexOf('let STATUS_BUSY='))+'\nthis.run=exportDaysBody;',ctx);ctx.seedCompletedDays=async()=>{};return {ctx,store,sent,dir};
}
test('failed mirror never permits eviction; retry confirms all exports before shrinking state',async t=>{
 const c=coin('old',27),{ctx,store}=setup(t,[c],{failMirror:true});await assert.rejects(ctx.run(),/injected mirror failure/);assert.equal(ctx.C.has(c.a),true);assert.equal(store.isConfirmed(c),false);assert.equal(store.sealed.size,0);
});
test('retention keeps active research/raw jobs and merges retired rows into later exports',async t=>{
 const old=coin('old',27),rejected=coin('rejected',3,false),research=coin('research',3,false),young=coin('young',1),raw=coin('raw',27);
 const {ctx,sent,store,dir}=setup(t,[old,rejected,research,young,raw]);ctx.SOURCE.records.set('research',{mint:'research',acceptedAt:clock-H});ctx.UPQ.push(['raw/'+day(raw.t)+'/raw-state.json',{}]);
 await ctx.run();assert.equal(ctx.C.has('old'),false);assert.equal(ctx.C.has('rejected'),false);for(const a of ['research','young','raw'])assert.equal(ctx.C.has(a),true,a);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'state.json'))).length,3);assert.equal(sent.get('observations-v2/'+day(old.t)+'.json').coins.length,2);
 ctx.UPQ.length=0;await ctx.run();const archived=sent.get('observations-v2/'+day(old.t)+'.json').coins;assert.deepEqual(archived.map(c=>c.a).sort(),['old','raw']);
 assert.deepEqual(archived.find(c=>c.a==='old').observations.pools[0].ds.map(r=>[r.at/1000,...r.values]),old.ds);assert.equal(ctx.C.has('raw'),false);assert.equal(store.sealed.has(day(old.t)),false);
});
test('failed state commit leaves the durable completed day available for restart',async t=>{
 const c=coin('old',27),{ctx,store,dir}=setup(t,[c],{saveOk:false});await ctx.run();assert.equal(ctx.C.size,0);assert.equal(store.sealed.size,0);
 const restored=new CompletedCoins(dir);assert.equal(restored.isConfirmed(c),true);assert.deepEqual([...restored.view(day(c.t),[])],[c]);
});
test('many days keep only the hot window in state and preserve every finalized daily file',async t=>{
 const {ctx,store,sent,dir}=setup(t,[]);
 for(let i=0;i<35;i++){
  const at=clock+i*24*H;ctx.Date.now=()=>at;
  for(let j=0;j<10;j++){const c=coin('day-'+i+'-'+j,0);c.t=at;ctx.C.set(c.a,c)}
  await ctx.run();assert.ok(ctx.C.size<=20);assert.ok(store.index.size<=3);assert.ok(store.sealed.size<=4);
  assert.ok(fs.statSync(path.join(dir,'state.json')).size<30000000);
 }
 for(let i=0;i<35;i++){const d=day(clock+i*24*H),rows=sent.get('observations-v2/'+d+'.json').coins;assert.equal(rows.length,10,d);assert.equal(rows[0].observations.pools[0].ds.length,2)}
});
test('an empty current hot census can accept another coin without overwriting its retired same-day history',async t=>{
 const c=coin('early',3,false),{ctx,store,sent}=setup(t,[c]);await ctx.run();assert.equal(ctx.C.size,0);assert.equal(store.sealed.has(day(c.t)),false);
 const late=coin('late',0);ctx.C.set(late.a,late);await ctx.run();const rows=sent.get('observations-v2/'+day(late.t)+'.json').coins;
 assert.deepEqual(rows.map(c=>c.a).sort(),['early','late']);
});
test('research can finalize an evicted cohort from disk without restoring it to the hot census',async t=>{
 const c=coin('mature',27),{ctx}=setup(t,[c]);vm.runInContext(code.slice(code.indexOf('function researchCoins()'),code.indexOf('async function exportResearchV2(')),ctx);
 let checked=false;ctx.exportResearchV2=async()=>{assert.equal(ctx.C.has(c.a),false);assert.deepEqual(ctx.researchCoins().get(c.a).ds,c.ds);assert.equal(ctx.C.has(c.a),false);checked=true};
 await ctx.run();assert.equal(checked,true);
});


test('research and Passed adapter reads the canonical schema-2 observation contract and excludes unknown fields',t=>{
 const c=coin('mint',1);c.oldResearchLabel='invalid';const {ctx}=setup(t,[c]);
 vm.runInContext(code.slice(code.indexOf('function researchCoins()'),code.indexOf('async function exportResearchV2(')),ctx);
 const read=ctx.researchCoins().get(c.a);assert.deepEqual(read.ds,c.ds);assert.equal(read.oldResearchLabel,undefined);assert.notEqual(read,c);assert.equal(ctx.C.get(c.a),c);
});
