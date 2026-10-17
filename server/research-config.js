'use strict';
// Durable research epochs: a rule edit never relabels older observations.
// Previous epochs remain available to finish their own observation windows.
const fs=require('node:fs'),path=require('node:path');
const crypto=require('node:crypto');
const hashOf=cfg=>crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0,20);
function atomic(file,value){
  const tmp=file+'.tmp',data=Buffer.from(JSON.stringify(value));
  const fd=fs.openSync(tmp,'w',0o600);
  try{let i=0;while(i<data.length)i+=fs.writeSync(fd,data,i,data.length-i);fs.fsyncSync(fd)}
  finally{fs.closeSync(fd)}
  fs.renameSync(tmp,file);
  const d=fs.openSync(path.dirname(file),'r');
  try{fs.fsyncSync(d)}finally{fs.closeSync(d)}
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
  apply(raw){
    const config=this.validate(raw),hash=hashOf(config);
    if(this.current?.hash===hash)return false;
    const now=Date.now();
    const activeAt=this.current?now:(this.adoptLegacy?0:now);
    const next={key:this.key,hash,activeAt,config};
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
