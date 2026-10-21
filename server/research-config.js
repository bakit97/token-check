'use strict';
// Durable research epochs: a rule edit never relabels older observations.
// Previous epochs remain available to finish their own observation windows.
const fs=require('node:fs'),path=require('node:path');
const crypto=require('node:crypto');
function semantic(cfg){if(Array.isArray(cfg))return cfg.map(semantic);if(!cfg||typeof cfg!=='object')return cfg;
 const out=Object.fromEntries(Object.entries(cfg).filter(([k])=>!['targetLive','targetDead','targetStrong','targetWeak','missPenalty'].includes(k)).map(([k,v])=>[k,semantic(v)]));
 if(out.phases){const base={...out};delete base.phases;if(Object.values(out.phases).every(v=>JSON.stringify(v)===JSON.stringify(base)))delete out.phases}return out;
}
function twoIdentity(c){return {lineVersion:c.lineVersion??2,hours:c.hours??5,passWindowMinutes:c.passWindowMinutes??5,minCoverage:c.minCoverage??.9,decisionMinutes:c.decisionMinutes??5,phases:c.phases?Object.fromEntries(Object.entries(c.phases).map(([p,v])=>[p,{lineVersion:v.lineVersion??2,hours:v.hours??5,passWindowMinutes:v.passWindowMinutes??5,minCoverage:v.minCoverage??.9,decisionMinutes:v.decisionMinutes??5}])):undefined};}
const hashOf=cfg=>crypto.createHash('sha256').update(JSON.stringify(semantic(cfg))).digest('hex').slice(0,20);
function atomic(file,value){
  const tmp=file+'.tmp',data=Buffer.from(JSON.stringify(value));
  const fd=fs.openSync(tmp,'w',0o600);
  try{let i=0;while(i<data.length)i+=fs.writeSync(fd,data,i,data.length-i);fs.fsyncSync(fd)}
  finally{fs.closeSync(fd)}
  fs.renameSync(tmp,file);
  require('./durable-json').syncDirectory(path.dirname(file));
}
function isEpoch(e,key){
  return e&&e.key===key&&typeof e.hash==='string'&&
    Number.isSafeInteger(e.activeAt)&&e.activeAt>=0&&e.config&&typeof e.config==='object';
}
class ResearchEpoch{
  constructor({dir,key,validate,config,adoptLegacy=false}={}){
    if(!dir||!['one','two'].includes(key)||typeof validate!=='function')
      throw TypeError('Invalid research epoch constructor');
    fs.mkdirSync(dir,{recursive:true});
    this.dir=dir;this.key=key;this.validate=validate;this.adoptLegacy=adoptLegacy;
    this.file=path.join(dir,'research-epoch-'+key+'.json');
    this.current=null;this.history=[];
    if(fs.existsSync(this.file)){
      const stored=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(stored.schema===1&&isEpoch(stored,key)){
        this.current={key,hash:stored.hash,activeAt:stored.activeAt,
          config:this.validate(stored.config)};
      }else if(stored.schema===2&&isEpoch(stored.current,key)&&
        Array.isArray(stored.history)){
        this.current={...stored.current,config:this.validate(stored.current.config)};
        this.history=stored.history.map(x=>{
          if(!isEpoch(x,key)||!Number.isSafeInteger(x.endedAt)||x.endedAt<x.activeAt)
            throw Error('Invalid historical research epoch');
          return {...x,config:this.validate(x.config)};
        });
      }else throw Error('Invalid persisted research epoch state');
    }
    this.apply(config);
  }
  apply(raw,reset=null){
    const config=this.validate(raw);
    if(reset){if(typeof reset.id!=='string'||!/^[-a-zA-Z0-9]{8,80}$/.test(reset.id)||!Number.isSafeInteger(reset.requestedAt)||reset.requestedAt<=0||reset.requestedAt>Date.now()+60000)throw TypeError('Invalid epoch reset');}
    const fresh=reset&&reset.id!==this.current?.resetId;
    const hash=hashOf(this.key==='one'?{hours:config.hours,intake:config.intake,phases:config.phases?Object.fromEntries(Object.entries(config.phases).map(([p,v])=>[p,{hours:v.hours,intake:v.intake}])):undefined}:twoIdentity(config));
    if(!fresh&&this.key==='one'&&this.current){const old=this.current.config,identity=c=>hashOf({hours:c.hours,intake:c.intake,phases:c.phases?Object.fromEntries(Object.entries(c.phases).map(([p,v])=>[p,{hours:v.hours,intake:v.intake}])):undefined});if(identity(old)===identity(config)){if(JSON.stringify(old)!==JSON.stringify(config)){const next={...this.current,config};atomic(this.file,{schema:2,current:next,history:this.history,updated:Date.now()});this.current=next;}return false;}}
    if(!fresh&&this.current?.hash===hash){if(JSON.stringify(config)!==JSON.stringify(this.current.config)){const next={...this.current,config};atomic(this.file,{schema:2,current:next,history:this.history,updated:Date.now()});this.current=next}return false;}
    const now=Date.now();
    const activeAt=this.current?now:(this.adoptLegacy?0:now);
    const next={key:this.key,hash,activeAt,config,...(fresh?{resetId:reset.id,resetAt:activeAt}:this.current?.resetId?{resetId:this.current.resetId,resetAt:this.current.resetAt}:{})};
    const history=this.current?
      this.history.concat([{...this.current,endedAt:now}]):this.history;
    atomic(this.file,{schema:2,current:next,history,updated:now});
    this.history=history;this.current=next;
    return true;
  }
  summary(){
    return {schema:2,...this.current,previousVersions:this.history.length};
  }
}
module.exports={ResearchEpoch,hashOf};
