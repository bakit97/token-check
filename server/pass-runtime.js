'use strict';
// Server-only, read-only token analytics. One mint can enter "Passed" once.
// An append-only, fsynced journal freezes filter versions and observation time.
// Missing evidence never qualifies; source admissions are never synthesized here.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {featuresAt,evaluation}=require('./research-v2');

const MIN=60000,WINDOW=72*60*MIN;
const KEYS=new Set(['buyers','trades','volume','liq','mc','buys','sells','buySellRatio']);
const PHASES=new Set(['before','after']);

function configOf(raw={}){
  if(!raw||raw.schema!==1||typeof raw.enabled!=='boolean')
    throw new TypeError('Pass configuration schema/enable missing');
  const cfg={
    schema:1,enabled:raw.enabled,activatedAt:raw.activatedAt,
    decisionMinutes:raw.decisionMinutes,
    filters:raw.filters,modules:raw.modules
  };
  if(!Number.isSafeInteger(cfg.activatedAt)||cfg.activatedAt<0||
     !Number.isInteger(cfg.decisionMinutes)||cfg.decisionMinutes<1||cfg.decisionMinutes>30||
     !Array.isArray(cfg.filters)||cfg.filters.length>200||
     !Array.isArray(cfg.modules)||cfg.modules.length>200)
    throw new RangeError('Invalid pass configuration');
  const ids=new Set();
  for(const f of cfg.filters){
    if(!f||typeof f.id!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(f.id)||ids.has(f.id)||
       typeof f.name!=='string'||!f.name.trim()||f.name.length>64||
       !['1','2'].includes(f.level)||!KEYS.has(f.key)||!['>=','<='].includes(f.op)||
       typeof f.value!=='number'||!Number.isFinite(f.value)||f.value<0||f.value>1e12||
       !Number.isInteger(f.version)||f.version<1)
      throw new TypeError('Invalid filter in pass configuration');
    ids.add(f.id);
  }
  for(const m of cfg.modules){
    if(!m||!ids.has(m.filterId)||!PHASES.has(m.phase)||!['1','2'].includes(m.level)||
       typeof m.enabled!=='boolean'||
       cfg.filters.find(f=>f.id===m.filterId).level!==m.level)
      throw new TypeError('Invalid module in pass configuration');
  }
  cfg.filters=cfg.filters.map(f=>({id:f.id,name:f.name.trim(),level:f.level,key:f.key,
    op:f.op,value:f.value,version:f.version}));
  cfg.modules=cfg.modules.map(m=>({filterId:m.filterId,phase:m.phase,level:m.level,enabled:m.enabled}));
  return cfg;
}
function digest(cfg){return crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0,20)}
function isEvent(x){
  return x&&x.schema===1&&typeof x.mint==='string'&&x.mint.length>=32&&
    PHASES.has(x.phase)&&Number.isSafeInteger(x.acceptedAt)&&
    Number.isSafeInteger(x.firstSeenAt)&&Number.isSafeInteger(x.zeroAt)&&
    x.zeroAt>x.acceptedAt&&x.firstSeenAt>=x.acceptedAt&&x.firstSeenAt<=x.zeroAt&&
    typeof x.configHash==='string'&&Array.isArray(x.matches)&&x.matches.length>0&&
    x.features&&typeof x.features==='object';
}
class PassRuntime {
  constructor({dir,config}={}){
    if(!dir)throw new TypeError('Pass journal directory required');
    fs.mkdirSync(dir,{recursive:true});
    this.file=path.join(dir,'pass-v2.journal');
    this.activationFile=path.join(dir,'pass-v2-activation.json');
    this.records=new Map();
    this.config=null;this.configHash='';
    this.applyConfig(config||{
      schema:1,enabled:false,activatedAt:0,decisionMinutes:10,filters:[],modules:[]
    });
    this.updated=null;
    this.appended=0;
    if(fs.existsSync(this.file)){
      const bytes=fs.readFileSync(this.file,'utf8');
      // Torn journal writes are considered an error; never guess the tail.
      if(bytes&&!bytes.endsWith('\n'))throw Error('Truncated pass journal');
      for(const line of bytes.split('\n')){
        if(!line)continue;
        const row=JSON.parse(line);
        if(!isEvent(row))throw Error('Malformed pass journal row');
        if(row.acceptedAt>=Date.now()-WINDOW)this.records.set(row.mint,row);
      }
    }
  }
  applyConfig(raw){
    const cfg=configOf(raw),h=digest(cfg);
    if(h===this.configHash)return false;
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
        const dir=fs.openSync(path.dirname(this.activationFile),'r');
        try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}
      }
    }
    this.config=cfg;
    this.configHash=h;
    return true;
  }
  _append(item){
    // A signal is visible in RAM only after it is committed to stable storage.
    const fd=fs.openSync(this.file,'a',0o600);
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
    const cfg=this.config;
    if(cfg.enabled){
      const available=new Map(cfg.filters.map(f=>[f.id,f]));
      const rules=cfg.modules.filter(m=>m.enabled&&m.level==='1').map(m=>({
        phase:m.phase,filter:available.get(m.filterId)
      })).filter(x=>x.filter);
      for(const row of source.records.values()){
        if(!PHASES.has(row.phase)||this.records.has(row.mint)||row.acceptedAt<cfg.activatedAt||
           row.acceptedAt>now||now-row.acceptedAt>cfg.decisionMinutes*MIN)continue;
        considered++;
        const coin=coins.get(row.mint);
        if(!coin)continue;
        const F=featuresAt(coin,now);
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
          schema:1,mint:row.mint,phase:row.phase,
          acceptedAt:row.acceptedAt,firstSeenAt:now,
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
  summary(now=Date.now()){
    const arr=[...this.records.values()];
    const current=arr.filter(x=>x.zeroAt>now);
    return {schema:1,updated:this.updated,enabled:this.config.enabled,
      activatedAt:this.config.activatedAt,
      decisionMinutes:this.config.decisionMinutes,
      configHash:this.configHash,
      registeredModules:this.config.modules.filter(m=>m.enabled&&m.level==='1').length,
      storedLast72h:arr.length,active:current.length,appendedThisProcess:this.appended,
      status:this.config.enabled?'server-observational':'disabled-no-server-rules'};
  }
  latest(limit=200){return [...this.records.values()].sort((a,b)=>b.firstSeenAt-a.firstSeenAt).slice(0,limit)}
  day(dayKey){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(dayKey))throw TypeError('Invalid day');
    const tz=5*3600000;
    return [...this.records.values()].filter(x=>new Date(x.firstSeenAt+tz).toISOString().slice(0,10)===dayKey)
      .sort((a,b)=>b.firstSeenAt-a.firstSeenAt);
  }
}
module.exports={PassRuntime,configOf,isEvent};
