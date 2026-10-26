'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ResearchBanks,storageConfig}=require('../server/research-banks');
function dir(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'banks-eight-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d}
function settings(){return {schema:1,before:{live:50,dead:50,strong:50,weak:50},after:{live:50,dead:50,strong:50,weak:50}}}
const opts={config:settings(),one:{targetLive:50,targetDead:50},two:{targetStrong:50,targetWeak:50}};
test('eight banks rotate independently, preserve labeled features/curve, and restart without resurrecting old rows',t=>{
 const d=dir(t),b=new ResearchBanks({dir:d,...opts}),rows=[];for(const phase of ['before','after'])for(const label of ['live','dead','strong','weak'])for(let i=0;i<65;i++)rows.push({mint:phase+label+i,phase,label,acceptedAt:1000+i,features:{buys:i},featureAnchor:'acceptedAt',curve:[[0,null],[5,1.23456789123]],time:1000+i});
 assert.equal(b.upsert(rows),520);for(const phase of ['before','after'])for(const label of ['live','dead','strong','weak'])assert.equal(b.summary().counts[phase][label],50);
 const r=b.select({level:'1',phase:'before',label:'live',curves:true});assert.equal(r.length,50);assert.equal(r[0].mint,'beforelive15');assert.deepEqual(r[0].curve,rows[0].curve);assert.equal(r[0].features.buys,15);
 const restarted=new ResearchBanks({dir:d,...opts});assert.equal(restarted.select().length,400);assert.equal(restarted.upsert(rows),0);assert.ok(restarted.select().every(x=>!Object.hasOwn(x,'curvePacked')));
});
test('storage goals are clamped separately above study requirements and reject invalid ranges',()=>{
 const c=storageConfig(settings(),{phases:{before:{targetLive:400},after:{targetDead:300}}},{phases:{before:{targetStrong:150},after:{targetWeak:200}}});assert.equal(c.before.live,400);assert.equal(c.after.live,100);assert.equal(c.after.dead,300);assert.equal(c.before.strong,150);assert.equal(c.after.weak,200);
 assert.throws(()=>storageConfig({...settings(),before:{live:49}}));assert.throws(()=>storageConfig({...settings(),after:{weak:5001}}));
});
test('malformed storage is rejected, while unknown observations never enter labeled banks',t=>{
 const d=dir(t),b=new ResearchBanks({dir:d,...opts});assert.equal(b.upsert([{mint:'x',phase:'before',acceptedAt:1,label:'pending',features:{buys:null}}]),0);fs.writeFileSync(b.file('before-live'),'[{"label":"dead"}]');assert.throws(()=>new ResearchBanks({dir:d,...opts}),/Corrupt/);
});

test('relabel moves the same mint between banks and preserves unknown raw observations',t=>{const d=dir(t),b=new ResearchBanks({dir:d,...opts}),row={mint:'coin',phase:'before',label:'live',acceptedAt:1000,featureAnchor:'acceptedAt',features:{buys:1},hours:5,outcomeVersion:2,coverage:1,maxGap:0,lastHourTrades:5,lastHourWallets:4,uniqueBuyers:40,priceKeep:40};b.upsert([row]);b.relabelOne({hours:5,minPriceKeep:50});assert.equal(b.summary().counts.before.live,0);assert.equal(b.summary().counts.before.dead,1);b.relabelOne({hours:5,minPriceKeep:30});assert.equal(b.summary().counts.before.live,1);assert.equal(b.summary().counts.before.dead,0);b.upsert([{...row,label:'unknown',coverage:0,why:'collector-gap'}]);assert.equal(b.select({level:'1'}).length,0);assert.equal(fs.readdirSync(path.join(b.dir,'unclassified-one')).length,1);});

test('newer repaired observations cannot be replaced by an older unknown cache during relabel',t=>{const b=new ResearchBanks({dir:dir(t),...opts}),row={mint:'repair',phase:'after',label:'live',acceptedAt:1,featureAnchor:'acceptedAt',features:{buys:1},hours:5,outcomeVersion:2,coverage:1,maxGap:0,lastHourTrades:5,lastHourWallets:5,uniqueBuyers:50,priceKeep:100,outcomeAt:100};b.upsert([row]);b.upsert([{...row,outcomeAt:200,coverage:0,label:'unknown'}]);b.upsert([{...row,outcomeAt:300}]);b.relabelOne({hours:5});assert.equal(b.summary().counts.after.live,1);});

test('eventAt anchored outcomes enter banks and survive relabel and restart',t=>{
 const d=dir(t),b=new ResearchBanks({dir:d,...opts}),row={mint:'event-clock',phase:'after',label:'dead',acceptedAt:2000,eventAt:1000,featureAnchor:'eventAt',features:{postPoolSol:17.7}};
 assert.equal(b.upsert([row]),1);assert.equal(new ResearchBanks({dir:d,...opts}).select()[0].eventAt,1000);b.upsert([{...row,label:'live'}]);assert.equal(b.summary().counts.after.dead,0);assert.equal(b.summary().counts.after.live,1);
});

test('oversized bank row fails safely, analysis projection excludes packed histories',t=>{const {encode,analysisRow}=require('../server/research-banks');assert.throws(()=>encode({mint:'x',huge:'x'.repeat(300000)}),/256 KiB/);const row={mint:'a',features:{holders:5},featureTimesPacked:'large',outcomePacked:'large',curvePacked:'large'};assert.deepEqual(analysisRow(row),{mint:'a',features:{holders:5}});});

test('unchanged runtime observations do not rewrite full banks every heartbeat',t=>{const b=new ResearchBanks({dir:dir(t),...opts}),row={mint:'same',phase:'before',label:'live',acceptedAt:1,featureAnchor:'acceptedAt',features:{holders:3}};b.upsert([row]);const file=b.file('before-live'),before=fs.statSync(file).mtimeMs;b.dirty.clear();assert.equal(b.upsert([structuredClone(row)]),0);assert.equal(fs.statSync(file).mtimeMs,before);assert.equal(b.dirty.size,0);});

test('persisted labels skip unchanged restart work, but changed thresholds rerun classification',async t=>{const d=dir(t),b=new ResearchBanks({dir:d,...opts}),cfg={hours:5,minActive:20};await b.relabelOneAsync(cfg);const again=new ResearchBanks({dir:d,...opts});let scans=0;const original=again._relabelSteps.bind(again);again._relabelSteps=function*(...args){scans++;yield* original(...args);};await again.relabelOneAsync(cfg);assert.equal(scans,0);await again.relabelOneAsync({...cfg,minActive:60});assert.equal(scans,1);assert.notEqual(again.labelConfigSig,b.labelConfigSig);});
test('cooperative bank relabel rejects an epoch switch before committing old labels',t=>{const d=dir(t),b=new ResearchBanks({dir:d,...opts});b.upsert([{mint:'sample',phase:'before',label:'live',acceptedAt:1000,featureAnchor:'acceptedAt',features:{}}]);const steps=b._relabelSteps('1',()=>({label:'live'}));assert.equal(steps.next().done,false);b.epochs['1']={id:'new-epoch',at:2000};assert.throws(()=>steps.next(),/epoch changed/);assert.equal(b.select({level:'1'}).length,1);});
