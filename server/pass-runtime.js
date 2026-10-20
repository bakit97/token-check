'use strict';
// Server-only, read-only token analytics. One mint can enter "Passed" once.
// An append-only, fsynced journal freezes filter versions and observation time.
// Missing evidence never qualifies; source admissions are never synthesized here.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {featuresAt,evaluation}=require('./research-v2');

const MIN=60000,WINDOW=72*60*MIN,TZ=5*3600000;
function syncDirectory(dir){
  let fd;try{fd=fs.openSync(dir,'r');fs.fsyncSync(fd)}catch(e){if(process.platform!=='win32'||!['EPERM','EISDIR','EACCES'].includes(e.code))throw e}finally{if(fd!=null)fs.closeSync(fd)}
}
function kzDay(at){return new Date(at+TZ).toISOString().slice(0,10)}
const KEYS=new Set(require('./research-v2').RULE_KEYS);
const PHASES=new Set(['before','after']);

function configOf(raw={}){
  if(!raw||raw.schema!==1||typeof raw.enabled!=='boolean')
    throw new TypeError('Pass configuration schema/enable missing');
  const cfg={
    schema:1,enabled:raw.enabled,activatedAt:raw.activatedAt,
    decisionMinutes:raw.decisionMinutes,
    filters:raw.filters,modules:raw.modules,
    ...(raw.passMode!=null?{passMode:typeof raw.passMode==='object'?{before:String(raw.passMode.before),after:String(raw.passMode.after)}:{before:String(raw.passMode),after:String(raw.passMode)}}:{}),
    // Переключатель окна «→ И1» по потокам; отсутствует → прежний хеш.
    ...(raw.r1&&typeof raw.r1==='object'?{r1:{before:raw.r1.before===true,after:raw.r1.after===true}}:{})
  };
  if(!Number.isSafeInteger(cfg.activatedAt)||cfg.activatedAt<0||
     !Number.isInteger(cfg.decisionMinutes)||cfg.decisionMinutes<1||cfg.decisionMinutes>30||
     !Array.isArray(cfg.filters)||cfg.filters.length>200||
     !Array.isArray(cfg.modules)||cfg.modules.length>200)
    throw new RangeError('Invalid pass configuration');
  if(cfg.passMode&&Object.values(cfg.passMode).some(x=>!['1','12'].includes(x)))throw new TypeError('Invalid passMode');
  const ids=new Set();
  for(const original of cfg.filters){
    const f={...original};
    if(f.conds!=null){if(!Array.isArray(f.conds)||!f.conds.length||f.conds.length>8)throw new TypeError('Invalid conds');Object.assign(f,{key:f.conds[0]?.key,op:f.conds[0]?.op,value:f.conds[0]?.value,value2:f.conds[0]?.value2});f.conditions=f.conds.slice(1)}
    if(!f||typeof f.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(f.id)||ids.has(f.id)||
       typeof f.name!=='string'||!f.name.trim()||f.name.length>64||
       !['1','2'].includes(f.level)||!KEYS.has(f.key)||!['>=','<=','between'].includes(f.op)||
       typeof f.value!=='number'||!Number.isFinite(f.value)||f.value<(require('./research-v2').LEVEL2_KEYS.includes(f.key)?-1e12:0)||f.value>1e12||
       !Number.isInteger(f.version)||f.version<1)
      throw new TypeError('Invalid filter in pass configuration');
    if(f.op==='between'&&(!Number.isFinite(f.value2)||f.value2<f.value||f.value2>1e12))throw TypeError('Invalid interval bounds');
    if(f.conditions!=null&&(!Array.isArray(f.conditions)||f.conditions.length>8||f.conditions.some(c=>!c||!KEYS.has(c.key)||!['>=','<=','between'].includes(c.op)||!Number.isFinite(c.value)||c.value<(require('./research-v2').LEVEL2_KEYS.includes(c.key)?-1e12:0)||c.value>1e12||(c.op==='between'&&(!Number.isFinite(c.value2)||c.value2<c.value||c.value2>1e12))||c.conditions!=null)))throw new TypeError('Invalid compound filter');
    if(f.verdictMinutes!=null&&(!Number.isInteger(f.verdictMinutes)||f.verdictMinutes<1||f.verdictMinutes>30))throw new TypeError('Invalid module verdictMinutes');
    if(f.phase!=null&&!PHASES.has(f.phase))throw new TypeError('Invalid filter phase');
    ids.add(f.id);
  }
  for(const m of cfg.modules){
    if(!m||!ids.has(m.filterId)||!PHASES.has(m.phase)||!['1','2'].includes(m.level)||
       typeof m.enabled!=='boolean'||
       cfg.filters.find(f=>f.id===m.filterId).level!==m.level)
      throw new TypeError('Invalid module in pass configuration');
  }
  cfg.filters=cfg.filters.map(original=>{const f={...original};if(f.conds){Object.assign(f,{key:f.conds[0]?.key,op:f.conds[0]?.op,value:f.conds[0]?.value,value2:f.conds[0]?.value2});f.conditions=f.conds.slice(1)}return {id:f.id,name:f.name.trim(),level:f.level,key:f.key,
    op:f.op,value:f.value,...(f.op==='between'?{value2:f.value2}:{}),version:f.version,...(f.phase?{phase:f.phase}:{}),...(f.verdictMinutes!=null?{verdictMinutes:f.verdictMinutes}:{}),...(f.conds?{conds:f.conds.map(c=>({key:c.key,op:c.op,value:c.value,...(c.op==='between'?{value2:c.value2}:{})}))}:{}),...(f.conditions?{conditions:f.conditions.map(c=>({key:c.key,op:c.op,value:c.value,...(c.op==='between'?{value2:c.value2}:{})}))}:{})}});
  // toR1: монеты этого модуля идут и во вход Исследования 1 (поле отсутствует → прежний хеш конфигурации).
  cfg.modules=cfg.modules.map(m=>({filterId:m.filterId,phase:m.phase,level:m.level,enabled:m.enabled,...(m.toR1===true?{toR1:true}:{})}));
  return cfg;
}
function digest(cfg){return crypto.createHash('sha256').update(JSON.stringify({...cfg,filters:cfg.filters.map(({name,...f})=>f)})).digest('hex').slice(0,20)}
function isEvent(x){
  return x&&[1,2].includes(x.schema)&&typeof x.mint==='string'&&x.mint.length>=32&&
    PHASES.has(x.phase)&&Number.isSafeInteger(x.acceptedAt)&&
    Number.isSafeInteger(x.firstSeenAt)&&Number.isSafeInteger(x.zeroAt)&&
    x.zeroAt>x.acceptedAt&&x.firstSeenAt>=x.acceptedAt&&(x.schema===2?x.firstSeenAt>=x.zeroAt&&x.firstSeenAt<=x.zeroAt+2*MIN:x.firstSeenAt<=x.zeroAt)&&
    typeof x.configHash==='string'&&Array.isArray(x.matches)&&x.matches.length>0&&
    x.features&&typeof x.features==='object';
}
class PassRuntime {
  constructor({dir,config}={}){
    if(!dir)throw new TypeError('Pass journal directory required');
    fs.mkdirSync(dir,{recursive:true});
    // One append-only file per Kazakhstan day: bounded startup replay while
    // retaining historical journals independently of the in-memory 72h view.
    this.file=path.join(dir,'pass-v2.journal'); // legacy single-file format
    this.journalDir=path.join(dir,'pass-v2-journal');
    fs.mkdirSync(this.journalDir,{recursive:true});
    this.activationFile=path.join(dir,'pass-v2-activation.json');
    this.records=new Map();
    this.config=null;this.configHash='';
    this.applyConfig(config||{
      schema:1,enabled:false,activatedAt:0,decisionMinutes:10,filters:[],modules:[]
    });
    this.updated=null;
    this.appended=0;
    // Always replay and recover the single old-format file if present.
    // Recent daily shards are replayed chronologically; older files persist
    // on disk without consuming memory or startup time.
    if(fs.existsSync(this.file))this._replayFile(this.file);
    const dayLimit=kzDay(Date.now()-WINDOW-40*MIN);
    for(const name of fs.readdirSync(this.journalDir).sort()){
      if(!/^pass-[0-9]{4}-[0-9]{2}-[0-9]{2}\.jsonl$/.test(name)||
         name.slice(5,15)<dayLimit)continue;
      this._replayFile(path.join(this.journalDir,name));
    }
  }
  _replayFile(file){
    const buf=fs.readFileSync(file);
    if(!buf.length)return;
    const last=buf.lastIndexOf(10); // full JSONL records end with LF
    const complete=last<0?Buffer.alloc(0):buf.subarray(0,last+1);
    if(last<buf.length-1){
      // Only a partial tail from a crash may be discarded. Preserve bytes
      // separately for diagnosis; never fabricate or accept that record.
      const partial=buf.subarray(last+1);
      const backup=file+'.partial-'+Date.now();
      const fd=fs.openSync(backup,'wx',0o600);
      try{fs.writeSync(fd,partial);fs.fsyncSync(fd)}
      finally{fs.closeSync(fd)}
      const journal=fs.openSync(file,'r+');
      try{fs.ftruncateSync(journal,complete.length);fs.fsyncSync(journal)}
      finally{fs.closeSync(journal)}
      syncDirectory(path.dirname(file));
    }
    for(const line of complete.toString('utf8').split('\n')){
      if(!line)continue;
      let item;
      try{item=JSON.parse(line)}
      catch{throw Error('Malformed committed pass journal JSON: '+path.basename(file))}
      if(!isEvent(item))throw Error('Malformed committed pass journal row: '+path.basename(file));
      const old=this.records.get(item.mint);
      if(old&&(old.acceptedAt!==item.acceptedAt||old.firstSeenAt!==item.firstSeenAt))
        throw Error('Conflicting duplicate mint in pass journal: '+item.mint);
      if(item.acceptedAt>=Date.now()-WINDOW)this.records.set(item.mint,Object.freeze(item));
    }
  }
  applyConfig(raw){
    const cfg=configOf(raw),h=digest(cfg);
    if(h===this.configHash){this.config={...cfg,activatedAt:this.config.activatedAt};return false;}
    if(cfg.enabled){
      let old=null;
      try{old=JSON.parse(fs.readFileSync(this.activationFile,'utf8'))}
      catch(e){if(e.code!=='ENOENT')throw e}
      // Only the moment the SERVER received this version can activate it.
      // Never backfill a previously admitted coin when an editor publishes it.
      const serverAt=old&&old.hash===h&&Number.isSafeInteger(old.serverAt)?
        old.serverAt:Date.now();
      cfg.activatedAt=Math.max(cfg.activatedAt,serverAt);
      if(!old||old.hash!==h){
        const temp=this.activationFile+'.tmp',data=Buffer.from(JSON.stringify({
          schema:1,hash:h,serverAt
        }));
        const fd=fs.openSync(temp,'w',0o600);
        try{let written=0;while(written<data.length)
          written+=fs.writeSync(fd,data,written,data.length-written);fs.fsyncSync(fd)}
        finally{fs.closeSync(fd)}
        fs.renameSync(temp,this.activationFile);
        syncDirectory(path.dirname(this.activationFile));
      }
    }
    if(!cfg.enabled&&fs.existsSync(this.activationFile)){
      // Disabling invalidates this activation epoch. A later re-enable
      // must not resurrect admissions from the interval while disabled.
      fs.unlinkSync(this.activationFile);
      syncDirectory(path.dirname(this.activationFile));
    }
    this.config=cfg;
    this.configHash=h;
    return true;
  }
  _append(item){
    // A signal is visible in RAM only after it is committed to stable storage.
    const file=path.join(this.journalDir,'pass-'+kzDay(item.firstSeenAt)+'.jsonl');
    const fd=fs.openSync(file,'a',0o600);
    try {
      const buf=Buffer.from(JSON.stringify(item)+'\n');
      let offset=0;
      while(offset<buf.length)offset+=fs.writeSync(fd,buf,offset,buf.length-offset);
      fs.fsyncSync(fd);
    }finally{fs.closeSync(fd)}
    this.records.set(item.mint,Object.freeze(item));
    this.appended++;
  }
  update({source,coins,now=Date.now()}={}){
    if(!source?.records||!coins?.get)throw new TypeError('Source ledger and candidate map required');
    let added=0,missingFeatures=0,considered=0;
    if(this.config.passMode)return this._updateVerdicts({source,coins,now});
    const cfg=this.config;
    if(cfg.enabled){
      const available=new Map(cfg.filters.map(f=>[f.id,f]));
      const rules=cfg.modules.filter(m=>m.enabled&&m.level==='1').map(m=>({
        phase:m.phase,filter:available.get(m.filterId)
      })).filter(x=>x.filter);
      const recent=typeof source.recentAdmissions==='function'?
        source.recentAdmissions(now-cfg.decisionMinutes*MIN,now):
        source.records.values();
      for(const row of recent){
        if(!PHASES.has(row.phase)||this.records.has(row.mint)||row.acceptedAt<cfg.activatedAt||
           row.acceptedAt>now||now-row.acceptedAt>cfg.decisionMinutes*MIN)continue;
        considered++;
        const coin=coins.get(row.mint);
        if(!coin)continue;
        const F=featuresAt(coin,now,{eventAt:row.eventAt,phase:row.phase});
        const matches=[];
        for(const r of rules){
          if(r.phase!==row.phase)continue;
          const f=r.filter;
          const result=evaluation(F,f);
          if(result==='unknown'){missingFeatures++;continue}
          if(result==='pass')matches.push({...f});
        }
        if(!matches.length)continue;
        // Freeze all level-2 versions at first admission to Passed; an edit
        // during the next five hours cannot silently rewrite that cohort.
        const secondLevelRules=cfg.modules.filter(m=>
          m.enabled&&m.level==='2'&&m.phase===row.phase)
          .map(m=>available.get(m.filterId)).filter(Boolean)
          .map(f=>({...f}));
        const item={
          schema:1,mint:row.mint,phase:row.phase,p:row.proof?.pool||null,pair:row.proof?.pool||null,phaseEpoch:row.proof?.poolEpoch?.id||null,
          acceptedAt:row.acceptedAt,eventAt:row.eventAt,firstSeenAt:now,
          zeroAt:row.acceptedAt+cfg.decisionMinutes*MIN,
          configHash:this.configHash,features:F,matches,secondLevelRules,
          name:String(coin.n||coin.s||'').slice(0,64),
          kind:'observed-filter-match'
        };
        this._append(item);
        added++;
      }
    }
    for(const [mint,row] of this.records)
      if(now-row.acceptedAt>WINDOW)this.records.delete(mint);
    this.updated=now;
    return {added,considered,missingFeatures,...this.summary(now)};
  }
  _updateVerdicts({source,coins,now}){
    const cfg=this.config;let added=0,considered=0,missingFeatures=0,waiting=0,rejected=0;
    if(cfg.enabled){
      const byId=new Map(cfg.filters.map(f=>[f.id,f]));
      const selected=cfg.modules.filter(m=>m.enabled&&(m.level==='1'||cfg.passMode[m.phase]==='12'))
        .map(m=>({module:m,filter:byId.get(m.filterId)})).filter(x=>x.filter&&(!x.filter.phase||x.filter.phase===x.module.phase));
      const maxMinutes=Math.max(1,...selected.map(x=>x.filter.verdictMinutes||cfg.decisionMinutes));
      const recent=typeof source.recentAdmissions==='function'?source.recentAdmissions(now-(maxMinutes+2)*MIN,now):source.records.values();
      for(const row of recent){
        if(!PHASES.has(row.phase)||this.records.has(row.mint)||row.acceptedAt<cfg.activatedAt||row.acceptedAt>now)continue;
        const rules=selected.filter(x=>x.module.phase===row.phase);
        if(!rules.some(x=>x.module.level==='1')||(cfg.passMode[row.phase]==='12'&&!rules.some(x=>x.module.level==='2')))continue;
        const minutes=Math.max(...rules.map(x=>x.filter.verdictMinutes||cfg.decisionMinutes)),zeroAt=row.acceptedAt+minutes*MIN;
        if(now<zeroAt){waiting++;continue}if(now>zeroAt+2*MIN)continue;
        considered++;const coin=coins.get(row.mint);if(!coin){missingFeatures++;continue}
        const verdicts=rules.map(({filter:f})=>{
          const at=row.acceptedAt+(f.verdictMinutes||cfg.decisionMinutes)*MIN;
          const features=f.level==='2'?require('./research-v2').levelTwoFeaturesAt(coin,at,{entryAt:row.acceptedAt,acceptedAt:row.acceptedAt,phase:row.phase}):featuresAt(coin,at,{eventAt:row.acceptedAt,phase:row.phase});
          return {filter:f,at,features,result:evaluation(features,f)};
        });
        if(verdicts.some(x=>x.result==='unknown')){missingFeatures++;continue}
        if(verdicts.some(x=>x.result!=='pass')){rejected++;continue}
        this._append({schema:2,mint:row.mint,phase:row.phase,p:row.proof?.pool||null,pair:row.proof?.pool||null,phaseEpoch:row.proof?.poolEpoch?.id||null,acceptedAt:row.acceptedAt,eventAt:row.eventAt,
          firstSeenAt:now,zeroAt,passMode:cfg.passMode[row.phase],verdictMinutes:minutes,configHash:this.configHash,
          features:featuresAt(coin,zeroAt,{eventAt:row.acceptedAt,phase:row.phase}),
          matches:verdicts.filter(x=>x.filter.level==='1').map(x=>({...x.filter})),
          moduleVerdicts:verdicts.map(x=>({id:x.filter.id,level:x.filter.level,version:x.filter.version,at:x.at,features:x.features,result:x.result})),
          secondLevelRules:cfg.modules.filter(m=>m.enabled&&m.level==='2'&&m.phase===row.phase).map(m=>byId.get(m.filterId)).filter(Boolean).map(f=>({...f})),
          name:String(coin.n||coin.s||'').slice(0,64),kind:'completed-module-verdicts'});added++;
      }
    }
    for(const [mint,row] of this.records)if(now-row.acceptedAt>WINDOW)this.records.delete(mint);
    this.updated=now;this.verdictStats={waiting,rejected,missingFeatures,considered};
    return {added,...this.verdictStats,...this.summary(now)};
  }
  summary(now=Date.now()){
    const arr=[...this.records.values()];
    const current=arr.filter(x=>x.schema===2?now-x.firstSeenAt<5*MIN:x.zeroAt>now);
    const todayRows=arr.filter(x=>kzDay(x.firstSeenAt)===kzDay(now));
    return {schema:1,updated:this.updated,enabled:this.config.enabled,
      activatedAt:this.config.activatedAt,
      decisionMinutes:this.config.decisionMinutes,...(this.config.passMode?{passMode:this.config.passMode,verdictStats:this.verdictStats||{}}:{}),
      today:{day:kzDay(now),before:todayRows.filter(x=>x.phase==='before').length,after:todayRows.filter(x=>x.phase==='after').length},
      configHash:this.configHash,
      registeredModules:this.config.modules.filter(m=>m.enabled&&m.level==='1').length,
      storedLast72h:arr.length,active:current.length,appendedThisProcess:this.appended,
      status:this.config.enabled?'server-observational':'disabled-no-server-rules'};
  }
  latest(limit=200){return [...this.records.values()].sort((a,b)=>b.firstSeenAt-a.firstSeenAt).slice(0,limit)}
  day(dayKey){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(dayKey))throw TypeError('Invalid day');
    return [...this.records.values()].filter(x=>kzDay(x.firstSeenAt)===dayKey)
      .sort((a,b)=>b.firstSeenAt-a.firstSeenAt);
  }
}
function verdictConfig(raw){return {...raw,passMode:raw.passMode||{before:'1',after:'1'},filters:(raw.filters||[]).map(f=>({...f,verdictMinutes:f.verdictMinutes||raw.decisionMinutes}))}}
module.exports={PassRuntime,configOf,isEvent,verdictConfig};
