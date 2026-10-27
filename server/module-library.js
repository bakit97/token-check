'use strict';
const crypto=require('node:crypto'),zlib=require('node:zlib');
const {ruleKey,validCondition,RULE_KEYS,LEVEL1_KEYS,LEVEL2_KEYS,evaluation,featuresAt,levelTwoFeaturesAt}=require('./research-v2');
function moduleSignature(m){return crypto.createHash('sha256').update(JSON.stringify([String(m.level),m.phase,m.verdictMinutes,m.conds.map(c=>[c.key,c.op,c.op==='in'?[...c.values].sort():c.value,...(c.op==='between'?[c.value2]:[])]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))])).digest('hex').slice(0,24)}
function definition(raw){
 if(!raw||typeof raw.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(raw.id)||!['1','2'].includes(String(raw.level))||!['before','after'].includes(raw.phase)||typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>64||!Number.isInteger(raw.verdictMinutes)||raw.verdictMinutes<1||raw.verdictMinutes>20||!Array.isArray(raw.conds)||!raw.conds.length||raw.conds.length>8)throw TypeError('Invalid module');
 const level=String(raw.level),keys=level==='1'?LEVEL1_KEYS.concat(['liq']):RULE_KEYS;
 const conds=raw.conds.map(c=>{if(!c||!keys.includes(c.key)||!validCondition(c))throw TypeError('Invalid module condition');return c.op==='in'?{key:c.key,op:c.op,values:[...c.values].sort()}:{key:c.key,op:c.op,value:c.value,...(c.op==='between'?{value2:c.value2}:{})}});
 return {id:raw.id,level,phase:raw.phase,name:raw.name.trim(),verdictMinutes:raw.verdictMinutes,conds};
}
function catalog(raw={schema:1,modules:[],deleted:[]}){
 if(!raw||raw.schema!==1||!Array.isArray(raw.modules)||raw.modules.length>1000||!Array.isArray(raw.deleted)||raw.deleted.length>2000||raw.deleted.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(id)))throw TypeError('Invalid module catalog');
 const ids=new Set();for(const m of raw.modules){definition(m);if(ids.has(m.id))throw TypeError('Duplicate module');ids.add(m.id)}return structuredClone(raw);
}
function combine({auto=[],owner,configured=[],now=Date.now()}={}){
 const cfg=catalog(owner),rows=new Map();for(const m of [...configured,...auto,...cfg.modules]){let d;try{d=definition(m)}catch{continue}rows.set(m.id,{...m,...d,evalSig:moduleSignature(d),createdAt:m.createdAt||now,liveFrom:m.liveFrom||m.createdAt||now,eval:m.eval||{train:null,holdout:null,live:null,test:null}})}for(const id of cfg.deleted)rows.delete(id);return [...rows.values()];
}
function configuredModules(raw,previous=[],now=Date.now()){
 const old=new Map(previous.map(m=>[m.id,m])),presetPhases={'start-basic':'before','start-strong':'before','start-basic-h':'after','start-strong-h':'after'};
 return (raw.filters||[]).map(f=>{const phases=[...new Set((raw.modules||[]).filter(m=>m.filterId===f.id).map(m=>m.phase))],phase=f.phase||phases[0]||presetPhases[f.id];if(!phase)return null;return {...f,phase,verdictMinutes:f.verdictMinutes||raw.decisionMinutes,conds:f.conds||[f].concat(f.conditions||[]),createdAt:old.get(f.id)?.createdAt||raw.activatedAt||now}}).filter(Boolean);
}
function edit(raw,action,snapshot=[],now=Date.now()){
 const cfg=catalog(raw),rows=combine({owner:cfg,auto:snapshot,now}),old=rows.find(m=>m.id===(action.id||action.module?.id));
 if(action.expectedSig!=null&&old?.evalSig!==action.expectedSig)throw Object.assign(Error('Module changed; reload'),{http:409});
 if(action.action==='delete'){if(!action.id||!/^[a-zA-Z0-9_-]{1,64}$/.test(action.id))throw TypeError('Invalid module id');cfg.modules=cfg.modules.filter(m=>m.id!==action.id);cfg.deleted=[...new Set(cfg.deleted.concat(action.id))];return {config:catalog(cfg),module:null,deleted:action.id}}
 if(action.action!=='upsert')throw TypeError('Invalid module action');const d=definition(action.module),sig=moduleSignature(d),same=old&&old.evalSig===sig;
 const m={...d,version:same?(old.version||1):(old?(old.version||1)+1:1),evalSig:sig,createdAt:old?.createdAt||now,liveFrom:same?old.liveFrom:now,eval:same?old.eval:{train:null,holdout:null,live:null,test:null},...(old?.parentId?{parentId:old.parentId}:{})};
 cfg.modules=cfg.modules.filter(x=>x.id!==m.id).concat(m);cfg.deleted=cfg.deleted.filter(id=>id!==m.id);return {config:catalog(cfg),module:m};
}
function windowConfig(raw,modules,deleted=[]){const byId=new Map(modules.map(m=>[m.id,m])),removed=new Set(deleted);return {...raw,filters:raw.filters.filter(f=>!removed.has(f.id)).map(f=>{const m=byId.get(f.id);return m?{...f,name:m.name,phase:m.phase,level:m.level,version:m.version||f.version,verdictMinutes:m.verdictMinutes,key:m.conds[0].key,op:m.conds[0].op,value:m.conds[0].value,values:m.conds[0].values,conds:m.conds,conditions:m.conds.slice(1)}:f}),modules:raw.modules.filter(m=>!removed.has(m.filterId)&&(!byId.has(m.filterId)||byId.get(m.filterId).phase===m.phase))}}
function freezeFeatureTimes(coin,acceptedAt,level,phase){const times={};for(let minute=1;minute<=20;minute++)times[minute]=require('./feature-snapshots').read(coin,acceptedAt,minute,phase,level);return zlib.deflateRawSync(Buffer.from(JSON.stringify(times)),{level:1}).toString('base64')}
function featureTimes(row){return row.featureTimesPacked?JSON.parse(zlib.inflateRawSync(Buffer.from(row.featureTimesPacked,'base64'),{maxOutputLength:128*1024}).toString('utf8')):null}
function featuresFor(row,module,times){return require('./research-v2').verifiedFeatures((times||featureTimes(row))?.[module.verdictMinutes]||(Number.isFinite(row.decisionAt)&&row.decisionAt===(row.featureAnchor==='acceptedAt'?row.acceptedAt:require('./event-clock').eventAnchor(row))+module.verdictMinutes*60000?row.features:{}))}
async function liveStats(modules,rows){const counters=new Map(modules.map(m=>[m.id,{totalPositive:0,totalNegative:0,passedPositive:0,rejectedNegative:0,falsePositive:0,missingPositive:0,missingNegative:0}]));let n=0;
 for(const row of rows){const level=['live','dead'].includes(row.label)?'1':'2',pos=['live','strong'].includes(row.label);const candidates=modules.filter(m=>m.level===level&&m.phase===row.phase&&row.acceptedAt>=m.liveFrom);if(!candidates.length)continue;const times=featureTimes(row);
  for(const m of candidates){const c=counters.get(m.id),result=evaluation(featuresFor(row,m,times),{conds:m.conds});c[pos?'totalPositive':'totalNegative']++;if(result==='unknown')c[pos?'missingPositive':'missingNegative']++;else if(pos&&result==='pass')c.passedPositive++;else if(!pos)c[result==='reject'?'rejectedNegative':'falsePositive']++}
  if(++n%64===0)await new Promise(r=>setImmediate(r));
 }
 for(const c of counters.values()){c.positiveRecall=c.totalPositive?c.passedPositive/c.totalPositive:null;c.negativeRejection=c.totalNegative?c.rejectedNegative/c.totalNegative:null;c.unknown=c.missingPositive+c.missingNegative}return counters;
}
function manualTest(modules,rows,{ids,phase,level,positiveCount,negativeCount},now=Date.now()){
 if(!Array.isArray(ids)||!ids.length||ids.length>50||!['before','after'].includes(phase)||!['1','2'].includes(String(level))||![positiveCount,negativeCount].every(n=>Number.isInteger(n)&&n>=1&&n<=5000))throw TypeError('Invalid manual test');
 const pos=String(level)==='1'?'live':'strong',neg=String(level)==='1'?'dead':'weak',selected=ids.map(id=>{const m=modules.find(m=>m.id===id&&m.phase===phase&&m.level===String(level));if(!m)throw TypeError('Unknown selected module');return m;}),compact=[];
 for(const r of rows){if(r.phase!==phase||!r.features||![pos,neg].includes(r.label))continue;const times=featureTimes(r);compact.push({label:r.label,acceptedAt:r.acceptedAt,results:selected.map(m=>evaluation(featuresFor(r,m,times),{conds:m.conds}))});}
 compact.sort((a,b)=>b.acceptedAt-a.acceptedAt);const A=compact.filter(r=>r.label===pos).slice(0,positiveCount),B=compact.filter(r=>r.label===neg).slice(0,negativeCount);if(A.length<positiveCount||B.length<negativeCount)throw TypeError('Insufficient labeled bank');
 const results=ids.map((id,i)=>{const a=A.map(r=>r.results[i]),b=B.map(r=>r.results[i]),pl=a.filter(x=>x==='pass').length,pd=b.filter(x=>x==='pass').length,rejected=b.filter(x=>x==='reject').length;return {id,pl,tl:A.length,pd,td:B.length,unknownPositive:a.filter(x=>x==='unknown').length,unknownNegative:b.filter(x=>x==='unknown').length,score:pl/A.length+rejected/B.length-1,at:now};}).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));return results.map((r,i)=>({...r,rank:i+1,of:results.length}));
}
module.exports={freezeFeatureTimes,featureTimes,featuresFor,liveStats,moduleSignature,definition,catalog,combine,configuredModules,edit,windowConfig,manualTest};
