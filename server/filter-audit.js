'use strict';
// Durable initial evaluations versus strictly later observations.
// Background evaluation is independent of which filter happened to signal.
// Do not interpret unknown features as correctly rejected tokens.
const fs=require('node:fs'),path=require('node:path');
const {ruleStats}=require('./research-v2');
const HOUR=3600_000,REQUIRED_PER_CLASS=20;
function atomic(file,value){
  const tmp=file+'.tmp',b=Buffer.from(JSON.stringify(value)),fd=fs.openSync(tmp,'w',0o600);
  try{let i=0;while(i<b.length)i+=fs.writeSync(fd,b,i,b.length-i);fs.fsyncSync(fd)}
  finally{fs.closeSync(fd)}
  fs.renameSync(tmp,file);
  const d=fs.openSync(path.dirname(file),'r');
  try{fs.fsyncSync(d)}finally{fs.closeSync(d)}
}
function metrics(rows,f,positive,negative){
  const st=ruleStats(rows,f,positive,negative);
  return {...st,labeled:rows.length,
    missing:st.unknown,positivePercent:st.positiveRecall==null?null:+(st.positiveRecall*100).toFixed(2),
    negativePercent:st.negativeRejection==null?null:+(st.negativeRejection*100).toFixed(2)};
}
class FilterAudit {
  constructor({dir}={}){
    if(!dir)throw TypeError('Filter audit directory required');
    fs.mkdirSync(dir,{recursive:true});
    this.file=path.join(dir,'filter-audit-baselines.json');
    this.snapshots=new Map();
    if(fs.existsSync(this.file)){
      const data=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(data.schema!==1||!Array.isArray(data.baselines))throw Error('Bad filter audit baseline schema');
      for(const [key,value] of data.baselines){
        if(typeof key!=='string'||!value||typeof value!=='object')throw Error('Bad saved audit baseline');
        this.snapshots.set(key,value);
      }
    }
  }
  report({config,one=[],two=[],oneHours=5,now=Date.now()}={}){
    if(!config||!Array.isArray(config.filters)||!Array.isArray(config.modules))
      throw TypeError('Need published server filter rules');
    let changed=false;
    const filters=new Map(config.filters.map(f=>[f.id,f]));
    const rows=[];
    const seen=new Set();
    const activeAt=config.activatedAt||0;
    for(const m of config.modules){
      const f=filters.get(m.filterId);
      if(!f||!['1','2'].includes(m.level)||!['before','after'].includes(m.phase))continue;
      const key=[m.level,m.phase,f.id,f.version,f.key,f.op,f.value].join('|');
      if(seen.has(key))continue;seen.add(key);
      const positive=m.level==='1'?'live':'strong',negative=m.level==='1'?'dead':'weak';
      const bank=(m.level==='1'?one:two).filter(r=>r.phase===m.phase&&
        [positive,negative].includes(r.label)&&r.features);
      const eligibleBefore=bank.filter(r=>{
        const at=m.level==='1'?r.acceptedAt+oneHours*HOUR:r.zeroAt+5*HOUR;
        return Number.isFinite(at)&&at<=activeAt;
      });
      const eligibleAfter=bank.filter(r=>{
        const at=m.level==='1'?r.acceptedAt:r.firstSeenAt;
        return Number.isFinite(at)&&at>=activeAt;
      });
      let original=this.snapshots.get(key)||null;
      const pos=eligibleBefore.filter(r=>r.label===positive).length;
      const neg=eligibleBefore.filter(r=>r.label===negative).length;
      if(!original&&pos>=REQUIRED_PER_CLASS&&neg>=REQUIRED_PER_CLASS){
        original={capturedAt:now,
          cohort:'completed-before-server-rule-activation',
          ...metrics(eligibleBefore,f,positive,negative)};
        this.snapshots.set(key,original);changed=true;
      }
      const background=eligibleAfter.length?metrics(eligibleAfter,f,positive,negative):null;
      rows.push({id:f.id,name:f.name,version:f.version,
        level:m.level,phase:m.phase,enabled:!!m.enabled,rule:{
          key:f.key,op:f.op,value:f.value
        },original,background,
        missingOriginal:original?0:{
          positiveNeeded:Math.max(0,REQUIRED_PER_CLASS-pos),
          negativeNeeded:Math.max(0,REQUIRED_PER_CLASS-neg)
        }});
    }
    if(changed)atomic(this.file,{
      schema:1,baselines:[...this.snapshots],updated:now
    });
    return {schema:1,updated:now,origin:'server-observational-analytics',
      requiredOriginalPerClass:REQUIRED_PER_CLASS,
      configEnabled:config.enabled,activatedAt:activeAt,
      totalRules:rows.length,rules:rows,
      note:'Frozen first evaluation versus later labeled events; not performance guarantees'};
  }
}
module.exports={FilterAudit};
