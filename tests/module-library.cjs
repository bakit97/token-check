'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const lib=require('../server/module-library'),{PassRuntime}=require('../server/pass-runtime');
const M=60000,T=Date.UTC(2026,9,19),empty={schema:1,modules:[],deleted:[]};
const moduleDef={id:'own',name:'Спрос',level:'1',phase:'before',verdictMinutes:2,conds:[{key:'buys',op:'>=',value:5}]};
test('rename preserves server evaluation and birth; parameter/time edits reset future evaluation',()=>{
 let r=lib.edit(empty,{action:'upsert',module:{...moduleDef,createdAt:1,eval:{live:{forged:true}}}},[],T);assert.equal(r.module.createdAt,T);assert.equal(r.module.liveFrom,T);assert.equal(r.module.eval.live,null);
 r.config.modules[0].eval={train:{totalPositive:100},live:{totalPositive:3},holdout:{totalNegative:40},test:{at:T}};const original=structuredClone(r.module);r=lib.edit(r.config,{action:'upsert',module:{...moduleDef,name:'Имя владельца'},expectedSig:original.evalSig},[],T+M);assert.equal(r.module.liveFrom,T);assert.equal(r.module.createdAt,T);assert.equal(r.module.eval.live.totalPositive,3);assert.equal(r.module.version,1);
 r=lib.edit(r.config,{action:'upsert',module:{...moduleDef,verdictMinutes:3}},[],T+2*M);assert.equal(r.module.liveFrom,T+2*M);assert.equal(r.module.createdAt,T);assert.equal(r.module.eval.train,null);assert.equal(r.module.eval.holdout,null);assert.equal(r.module.eval.live,null);assert.equal(r.module.version,2);
 assert.throws(()=>lib.edit(r.config,{action:'upsert',module:moduleDef,expectedSig:original.evalSig}),e=>e.http===409);
});
test('delete tombstone excludes auto modules everywhere and strips their window selection',()=>{
 const auto={...moduleDef,createdAt:T,liveFrom:T,eval:{live:{totalPositive:1}}},r=lib.edit(empty,{action:'delete',id:'own'},[auto],T+M);assert.equal(lib.combine({auto:[auto],owner:r.config}).length,0);
 const window=lib.windowConfig({filters:[{id:'own'}],modules:[{filterId:'own',phase:'before'}]},[],r.config.deleted);assert.equal(window.filters.length,0);assert.equal(window.modules.length,0);
});
test('manual test uses the module minute, reports unknown separately, and ranks actual labeled banks',()=>{
 const coin={ds:[[T/1000+60,1,10,10,10,1,10],[(T+10*M)/1000,1,10,10,1000,1,1000]]},packed=lib.freezeFeatureTimes(coin,T,'1','before');
 const modules=[{...moduleDef,liveFrom:0},{...moduleDef,id:'strict',conds:[{key:'buys',op:'>=',value:20}]}];
 const rows=[{mint:'a',phase:'before',label:'live',acceptedAt:T,features:{buys:1000},featureTimesPacked:packed},{mint:'b',phase:'before',label:'dead',acceptedAt:T+1,features:{buys:1},decisionAt:T+1+2*M}];
 const r=lib.manualTest(modules,rows,{ids:['own','strict'],phase:'before',level:'1',positiveCount:1,negativeCount:1},T+M);assert.equal(r[0].id,'own');assert.equal(r[0].pl,1);assert.equal(r[1].pl,0);assert.equal(r[0].rank,1);assert.equal(r[0].pd,0);assert.equal(r[0].at,T+M);
 rows[1].decisionAt=T+10*M;const unknown=lib.manualTest(modules,rows,{ids:['own'],phase:'before',level:'1',positiveCount:1,negativeCount:1});assert.equal(unknown[0].unknownNegative,1);
});
test('live excludes old admissions and definition validation rejects empty or unsupported conditions',async()=>{
 assert.throws(()=>lib.definition({...moduleDef,conds:[]}));assert.throws(()=>lib.definition({...moduleDef,conds:[{key:'devSold',op:'>=',value:1}]}));assert.throws(()=>lib.definition({...moduleDef,verdictMinutes:1}));
 const m={...moduleDef,liveFrom:T},rows=[{phase:'before',label:'live',acceptedAt:T-M,decisionAt:T+M,features:{buys:100}},{phase:'before',label:'dead',acceptedAt:T,decisionAt:T+2*M,features:{buys:null}}];
 const stats=(await lib.liveStats([m],rows)).get(m.id);assert.equal(stats.totalPositive,0);assert.equal(stats.totalNegative,1);assert.equal(stats.rejectedNegative,0);assert.equal(stats.missingNegative,1);
});
test('renaming an active window rule does not restart activation or cancel its cohort',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rename-pass-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const cfg={schema:1,enabled:true,activatedAt:0,decisionMinutes:2,passMode:'1',filters:[{...moduleDef,version:1}],modules:[{filterId:'own',phase:'before',level:'1',enabled:true}]};const p=new PassRuntime({dir,config:cfg}),at=p.config.activatedAt,hash=p.configHash;cfg.filters[0].name='Новое имя';assert.equal(p.applyConfig(cfg),false);assert.equal(p.config.activatedAt,at);assert.equal(p.configHash,hash);assert.equal(p.config.filters[0].name,'Новое имя');
});

test('module report distinguishes known negative passes from unknown observations',()=>{
 const vm=require('node:vm'),code=fs.readFileSync(path.join(__dirname,'../v2.js'),'utf8'),scope={modPc:v=>v==null?'—':Math.round(v*100)+'%'};vm.runInNewContext(code.slice(code.indexOf('function modBlk('),code.indexOf('function modTestBlk(')),scope);const html=scope.modBlk({totalPositive:10,totalNegative:20,passedPositive:8,falsePositive:3,rejectedNegative:15,missingNegative:2,unknown:2},'mnow','сейчас');assert.match(html,/3 из 20/);assert.doesNotMatch(html,/5 из 20/);assert.match(html,/нет данных: 2/);
});
