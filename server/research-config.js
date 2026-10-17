'use strict';
// Immutable research cohorts. Every distinct analytical definition receives a
// new bank and a durable server-observed activation time, never retroactively
// relabeling older rows with newly selected observation thresholds.
const fs=require('node:fs'),path=require('node:path');
const crypto=require('node:crypto');
const hashOf=cfg=>crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0,20);
class ResearchEpoch {
  constructor({dir,key,validate,config,adoptLegacy=false}={}){
    if(!dir||!['one','two'].includes(key)||typeof validate!=='function')
      throw TypeError('Invalid research epoch constructor');
    fs.mkdirSync(dir,{recursive:true});
    this.dir=dir;this.key=key;this.validate=validate;this.adoptLegacy=adoptLegacy;
    this.file=path.join(dir,'research-epoch-'+key+'.json');
    this.current=null;
    this.apply(config);
  }
  apply(raw){
    const config=this.validate(raw),hash=hashOf(config);
    if(this.current?.hash===hash)return false;
    let old=null;
    try{old=JSON.parse(fs.readFileSync(this.file,'utf8'))}
    catch(e){if(e.code!=='ENOENT')throw e}
    const activeAt=old?.schema===1&&old.hash===hash&&
      Number.isSafeInteger(old.activeAt)?old.activeAt:
      (!old&&this.adoptLegacy?0:Date.now());
    const next={schema:1,key:this.key,hash,activeAt,config};
    if(!old||old.hash!==hash){
      const temp=this.file+'.tmp',data=Buffer.from(JSON.stringify(next));
      const fd=fs.openSync(temp,'w',0o600);
      try{let i=0;while(i<data.length)i+=fs.writeSync(fd,data,i,data.length-i);fs.fsyncSync(fd)}
      finally{fs.closeSync(fd)}
      fs.renameSync(temp,this.file);
      const dirFd=fs.openSync(this.dir,'r');
      try{fs.fsyncSync(dirFd)}finally{fs.closeSync(dirFd)}
    }
    this.current=next;
    return true;
  }
  summary(){return {...this.current}}
}
module.exports={ResearchEpoch,hashOf};
