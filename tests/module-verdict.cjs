'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {PassRuntime,configOf,verdictConfig}=require('../server/pass-runtime');
const MIN=60000,M='So11111111111111111111111111111111111111112';
function setup(t,mode='12'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'verdict-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const cfg={schema:1,enabled:true,activatedAt:0,decisionMinutes:10,passMode:{before:mode,after:'1'},filters:[
 {id:'early',name:'Спрос',level:'1',version:1,phase:'before',verdictMinutes:2,conds:[{key:'buys',op:'>=',value:5},{key:'sells',op:'<=',value:4}]},
 {id:'late',name:'Продолжение',level:'2',version:1,phase:'before',verdictMinutes:5,conds:[{key:'volume',op:'>=',value:100}]}],
 modules:[{filterId:'early',phase:'before',level:'1',enabled:true},{filterId:'late',phase:'before',level:'2',enabled:true}]};
 const runtime=new PassRuntime({dir,config:cfg}),at=Math.ceil((runtime.config.activatedAt+1000)/1000)*1000;
 const source={records:new Map([[M,{mint:M,phase:'before',acceptedAt:at,eventAt:at}]])};
 const row=(m,b=7,s=2,v=200)=>[(at+m*MIN)/1000,1,100,200,b,s,v];
 const coin={a:M,ds:[row(1),row(4),row(6,99,99,0)]},coins=new Map([[M,coin]]);
 return {runtime,source,coin,coins,at,cfg,dir,row};
}
test('Window waits for max of both levels from detection, freezes each cutoff and replays completed verdict',t=>{
 const x=setup(t);assert.equal(x.runtime.update({...x,now:x.at+4*MIN}).added,0);
 assert.equal(x.runtime.update({...x,now:x.at+5*MIN}).added,1);
 const r=x.runtime.records.get(M);assert.equal(r.schema,2);assert.equal(r.zeroAt,x.at+5*MIN);assert.equal(r.moduleVerdicts[0].at,x.at+2*MIN);assert.equal(r.moduleVerdicts[0].features.buys,7);assert.equal(r.moduleVerdicts[1].features.volume,200);
 assert.equal(r.passMode,'12');assert.equal(x.runtime.summary(x.at+5*MIN).today.before,1);
 const again=new PassRuntime({dir:x.dir,config:x.cfg});assert.equal(again.records.get(M).zeroAt,r.zeroAt);
 assert.equal(again.update({...x,now:x.at+6*MIN}).added,0);
});
test('all configured modules must pass; future observations and missing data cannot qualify',t=>{
 const x=setup(t);x.coin.ds[0]=x.row(1,1);assert.equal(x.runtime.update({...x,now:x.at+5*MIN}).added,0);
 x.coin.ds=[x.row(3,9)];assert.equal(x.runtime.update({...x,now:x.at+5*MIN}).added,0);assert.equal(x.runtime.records.size,0);
});
test('mode 1 excludes level 2; phases do not borrow modules; overdue admissions are not backfilled',t=>{
 const x=setup(t,'1');assert.equal(x.runtime.update({...x,now:x.at+MIN}).added,0);assert.equal(x.runtime.update({...x,now:x.at+2*MIN}).added,1);
 const y=setup(t);assert.equal(y.runtime.update({...y,now:y.at+8*MIN}).added,0);
 y.source.records.get(M).phase='after';assert.equal(y.runtime.update({...y,now:y.at+5*MIN}).added,0);
});
test('configuration preserves compound conditions and separate modes; rejects invalid times/modes',t=>{
 const x=setup(t),c=configOf(x.cfg);assert.equal(c.filters[0].conditions.length,1);assert.equal(c.filters[0].conds.length,2);assert.equal(c.passMode.after,'1');assert.equal(c.filters[0].verdictMinutes,2);
 assert.throws(()=>configOf({...x.cfg,passMode:'bad'}));assert.throws(()=>configOf({...x.cfg,filters:[{...x.cfg.filters[0],verdictMinutes:0}]}));
 const old={...x.cfg};delete old.passMode;delete old.filters[0].verdictMinutes;assert.equal(verdictConfig(old).filters[0].verdictMinutes,10);
});

test('phone shows only completed server verdicts and never falls back to browser rules',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),code=fs.readFileSync(require('node:path').join(__dirname,'../v2.js'),'utf8');const body=code.slice(code.indexOf('function passedCoins('),code.indexOf('function storeBank('));const scope={serverPassActive:false,serverPassRows:[],now:()=>100,mint:c=>c.a};vm.runInNewContext(body,scope);assert.equal(scope.passedCoins([{a:M,_entry:{acceptedAt:1}}]).length,0);scope.serverPassActive=true;scope.serverPassRows=[{mint:M,phase:'before',acceptedAt:1,firstSeenAt:90,zeroAt:110,matches:[]}];assert.equal(scope.passedCoins([]).length,0);scope.serverPassRows[0].zeroAt=90;assert.equal(scope.passedCoins([]).length,1);
});

test('feature minute follows detection under TZ27 while the pool event timestamp remains unchanged',t=>{
 const x=setup(t,'1'),r=x.source.records.get(M);r.eventAt=x.at;r.acceptedAt=x.at+MIN;
 assert.equal(x.runtime.update({...x,now:x.at+2*MIN}).added,0);assert.equal(x.runtime.update({...x,now:x.at+3*MIN}).added,1);
 const pass=x.runtime.records.get(M);assert.equal(pass.zeroAt,x.at+3*MIN);assert.equal(pass.acceptedAt,x.at+MIN);assert.equal(pass.eventAt,x.at);
 assert.equal(new PassRuntime({dir:x.dir,config:x.cfg}).records.get(M).zeroAt,pass.zeroAt);
});
