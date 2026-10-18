'use strict';
// Immutable original results and later background outcomes for every published
// version, including retired rules. Missing features NEVER count as rejects.
const fs=require('node:fs'),path=require('node:path');
const {ruleStats}=require('./research-v2');
const HOUR=3600_000,REQUIRED_PER_CLASS=20;
function atomic(file,value){
  const tmp=file+'.tmp',b=Buffer.from(JSON.stringify(value)),fd=fs.openSync(tmp,'w',0o600);
  try{let i=0;while(i<b.length)i+=fs.writeSync(fd,b,i,b.length-i);fs.fsyncSync(fd)}
  finally{fs.closeSync(fd)}
  fs.renameSync(tmp,file);
  require('./durable-json').syncDirectory(path.dirname(file));
}
function metrics(rows,f,positive,negative){
  const st=ruleStats(rows,f,positive,negative);
  return {...st,labeled:rows.length,
    missing:st.unknown,
    positivePercent:st.positiveRecall==null?null:+(st.positiveRecall*100).toFixed(2),
    negativePercent:st.negativeRejection==null?null:+(st.negativeRejection*100).toFixed(2)};
}
function validVersion(v){
  return v&&typeof v.key==='string'&&typeof v.id==='string'&&
    Number.isInteger(v.version)&&v.version>0&&
    ['1','2'].includes(v.level)&&['before','after'].includes(v.phase)&&
    v.rule&&typeof v.rule.key==='string'&&['>=','<='].includes(v.rule.op)&&
    typeof v.rule.value==='number'&&Number.isFinite(v.rule.value);
}
class FilterAudit{
  constructor({dir}={}){
    if(!dir)throw TypeError('Filter audit directory required');
    fs.mkdirSync(dir,{recursive:true});
    this.file=path.join(dir,'filter-audit-baselines.json');
    this.versions=new Map();
    if(fs.existsSync(this.file)){
      const data=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(data.schema===2&&Array.isArray(data.versions)){
        for(const v of data.versions){
          if(!validVersion(v)||this.versions.has(v.key))
            throw Error('Invalid stored filter version history');
          this.versions.set(v.key,v);
        }
      }else if(data.schema!==1||!Array.isArray(data.baselines))
        throw Error('Unknown filter audit history format');
      // The first schema stored baselines without the original rule metadata.
      // Never guess rules from keys; retain a matching frozen sample only if
      // that same explicit version returns to the published configuration.
      this.legacyBaselines=new Map(data.schema===1?data.baselines:[]);
    }else this.legacyBaselines=new Map();
  }
  report({config,one=[],two=[],oneHours=5,now=Date.now()}={}){
    if(!config||!Array.isArray(config.filters)||!Array.isArray(config.modules))
      throw TypeError('Published owner filter configuration required');
    const activeAt=Number.isSafeInteger(config.activatedAt)?config.activatedAt:0;
    const catalog=new Map(config.filters.map(f=>[f.id,f]));
    const selected=new Map();
    for(const m of config.modules){
      const f=catalog.get(m.filterId);
      if(!f||f.level!==m.level||!['before','after'].includes(m.phase))continue;
      const base=[m.level,m.phase,f.id,f.version,f.key,f.op,f.value].join('|');
      const key=f.conditions?.length?base+'|'+JSON.stringify(f.conditions):base;
      if(selected.has(key))continue;
      selected.set(key,!!config.enabled&&!!m.enabled);
      let row=this.versions.get(key);
      if(!row){
        row={key,id:f.id,name:f.name,version:f.version,level:m.level,phase:m.phase,
          rule:{key:f.key,op:f.op,value:f.value,...(f.conditions?{conditions:f.conditions.map(c=>({...c}))}:{})},
          firstPublishedAt:activeAt>0?activeAt:null,
          firstSeenAt:now,original:null,background:null,backgroundUpdated:null};
        if(this.legacyBaselines.has(key))
          row.original=this.legacyBaselines.get(key);
        this.versions.set(key,row);
      }
      if(!row.firstPublishedAt&&activeAt>0)row.firstPublishedAt=activeAt;
      row.name=f.name;
    }
    const rows=[];
    for(const row of this.versions.values()){
      const positive=row.level==='1'?'live':'strong';
      const negative=row.level==='1'?'dead':'weak';
      const bank=(row.level==='1'?one:two).filter(r=>
        r.phase===row.phase&&[positive,negative].includes(r.label)&&r.features);
      const start=row.firstPublishedAt;
      const doneAt=r=>row.level==='1'?r.acceptedAt+oneHours*HOUR:r.zeroAt+5*HOUR;
      const eligibleBefore=start?bank.filter(r=>
        Number.isFinite(doneAt(r))&&doneAt(r)<=start):[];
      const eligibleAfter=start?bank.filter(r=>{
        const t=row.level==='1'?r.acceptedAt:r.firstSeenAt;
        return Number.isFinite(t)&&t>=start;
      }):[];
      const pos=eligibleBefore.filter(r=>r.label===positive).length;
      const neg=eligibleBefore.filter(r=>r.label===negative).length;
      if(!row.original&&pos>=REQUIRED_PER_CLASS&&neg>=REQUIRED_PER_CLASS)
        row.original={capturedAt:now,
          cohort:'completed-before-first-rule-publication',
          ...metrics(eligibleBefore,row.rule,positive,negative)};
      const background=eligibleAfter.length?
        metrics(eligibleAfter,row.rule,positive,negative):null;
      // Keep the most recent documented background measurement even if the
      // respective study later rotates away its polygon epoch.
      if(background){
        row.background=background;
        row.backgroundUpdated=now;
      }
      rows.push({
        id:row.id,name:row.name,version:row.version,level:row.level,
        phase:row.phase,enabled:selected.get(row.key)||false,
        archived:!selected.has(row.key),
        rule:row.rule,
        firstPublishedAt:row.firstPublishedAt,
        original:row.original,background:row.background,
        backgroundUpdated:row.backgroundUpdated,
        missingOriginal:row.original?null:{
          positiveNeeded:Math.max(0,REQUIRED_PER_CLASS-pos),
          negativeNeeded:Math.max(0,REQUIRED_PER_CLASS-neg)
        }
      });
    }
    atomic(this.file,{schema:2,versions:[...this.versions.values()],updated:now});
    return {schema:2,updated:now,origin:'server-observational-analytics',
      requiredOriginalPerClass:REQUIRED_PER_CLASS,
      configEnabled:!!config.enabled,activatedAt:activeAt,
      totalRules:rows.length,archivedRules:rows.filter(r=>r.archived).length,
      rules:rows.slice(-500).reverse(),
      note:'Frozen first evaluation and later observations are reported separately; unknowns never count as correct'};
  }
}
module.exports={FilterAudit};
