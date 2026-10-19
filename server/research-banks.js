'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {readRows,saveRows}=require('./stream-json');
const {syncDirectory}=require('./durable-json');
const PHASES=['before','after'],LABELS=['live','dead','strong','weak'];
function storageConfig(raw={},one={},two={}){
 if(raw.schema!=null&&raw.schema!==1)throw TypeError('Invalid storage schema');
 const out={schema:1,before:{},after:{}};
 for(const phase of PHASES)for(const label of LABELS){const value=raw[phase]?.[label]??2000;if(!Number.isInteger(value)||value<50||value>5000)throw RangeError('Storage target must be 50..5000');const first=one.phases?.[phase]||one,second=two.phases?.[phase]||two;const minimum={live:first.targetLive||100,dead:first.targetDead||40,strong:second.targetStrong||40,weak:second.targetWeak||40}[label];out[phase][label]=Math.max(value,minimum)}
 return out;
}
function valid(row){return row&&typeof row.mint==='string'&&PHASES.includes(row.phase)&&LABELS.includes(row.label)&&Number.isSafeInteger(row.acceptedAt)&&row.features&&typeof row.features==='object'&&row.featureAnchor==='acceptedAt'}
function encode(row){const copy={...row};delete copy.minuteCurve;delete copy.minuteCurvePacked;if(Array.isArray(copy.curve)){copy.curvePacked=zlib.deflateRawSync(Buffer.from(JSON.stringify(copy.curve)),{level:1}).toString('base64');delete copy.curve}return copy}
function decode(row,curves=true){if(!curves){const {curvePacked,...rest}=row;return rest}if(!row.curvePacked)return row;const {curvePacked,...rest}=row;return {...rest,curve:JSON.parse(zlib.inflateRawSync(Buffer.from(curvePacked,'base64'),{maxOutputLength:128*1024}).toString('utf8'))}}
class ResearchBanks{
 constructor({dir,config={},one={},two={}}){this.dir=path.join(dir,'research-banks-v2');fs.mkdirSync(this.dir,{recursive:true});this.config=storageConfig(config,one,two);this.index=new Map();this.dirty=new Set();
  for(const phase of PHASES)for(const label of LABELS){const key=phase+'-'+label,file=this.file(key),index=new Map();if(fs.existsSync(file))for(const row of readRows(file)){if(!valid(row)||row.phase+'-'+row.label!==key)throw Error('Corrupt research bank');index.set(row.mint,row.acceptedAt)}this.index.set(key,index)}
 }
 file(key){if(!/^(before|after)-(live|dead|strong|weak)$/.test(key))throw TypeError('Invalid bank');return path.join(this.dir,key+'.json')}
 applyConfig(config,one,two){this.config=storageConfig(config,one,two)}
 _syncLabels(rows){const changes=new Map(rows.filter(r=>r?.mint&&PHASES.includes(r.phase)&&r.featureAnchor==='acceptedAt').map(r=>[r.phase+'-'+(['strong','weak'].includes(r.label)?'2':'1')+'-'+r.mint,r]));
  for(const [key,index] of this.index){const [phase,label]=key.split('-'),level=['live','dead'].includes(label)?'1':'2';if(![...index.keys()].some(m=>changes.has(phase+'-'+level+'-'+m)))continue;let changed=false;const kept=[];for(const old of readRows(this.file(key))){const row=changes.get(phase+'-'+level+'-'+old.mint);if(!row){kept.push(old);continue;}if(row.label===label){const fresh=encode(row);kept.push(fresh);if(JSON.stringify(fresh)!==JSON.stringify(old))changed=true;}else{changed=true;if(!LABELS.includes(row.label)){const dir=path.join(this.dir,'unclassified-one');fs.mkdirSync(dir,{recursive:true});const id=require('node:crypto').createHash('sha256').update(phase+old.mint).digest('hex');saveRows(path.join(dir,id+'.json'),[{...old,...encode(row),why:row.why||'relabel-unverified'}]);}}}if(changed){saveRows(this.file(key),kept);this.index.set(key,new Map(kept.map(r=>[r.mint,r.acceptedAt])));this.dirty.add(key);}}
 }
 relabelOne(config){const sig=JSON.stringify(config);if(this.labelConfigSig===sig)return;const {classOf,phaseSettings}=require('./research-runtime'),rows=this.select({level:'1',curves:false}),dir=path.join(this.dir,'unclassified-one');if(fs.existsSync(dir))for(const name of fs.readdirSync(dir)){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;for(const row of readRows(path.join(dir,name)))rows.push(row);}
  const latest=new Map();for(const row of rows){const cfg=phaseSettings(config,row.phase),label=row.hours===cfg.hours?classOf(row,config):'unknown';const id=row.phase+row.mint,old=latest.get(id);if(!old||(row.outcomeAt||0)>(old.outcomeAt||0)||(row.outcomeAt||0)===(old.outcomeAt||0)&&(row.coverage||0)>=(old.coverage||0))latest.set(id,{...row,label,why:label==='unknown'?'stored-observation-unverified':null});}this.upsert([...latest.values()]);this.labelConfigSig=sig;
 }
 upsert(rows){this._syncLabels(rows);const grouped=new Map(),oldest=new Map([...this.index].map(([key,index])=>[key,[...index].sort((a,b)=>a[1]-b[1]||b[0].localeCompare(a[0]))[0]]));for(const row of rows){if(!valid(row))continue;const key=row.phase+'-'+row.label;const index=this.index.get(key),limit=this.config[row.phase][row.label],last=oldest.get(key);if(index.has(row.mint)||index.size>=limit&&last&&(row.acceptedAt<last[1]||row.acceptedAt===last[1]&&row.mint.localeCompare(last[0])>=0))continue;if(!grouped.has(key))grouped.set(key,new Map());grouped.get(key).set(row.mint,row)}
  let added=0;for(const [key,index] of this.index){const [phase,label]=key.split('-'),limit=this.config[phase][label],input=grouped.get(key);if(!input?.size&&index.size<=limit)continue;
   const existing=fs.existsSync(this.file(key))?[...readRows(this.file(key))]:[],newRows=[...(input?.values()||[])].map(encode),all=existing.concat(newRows).sort((a,b)=>b.acceptedAt-a.acceptedAt||a.mint.localeCompare(b.mint)).slice(0,limit);
   saveRows(this.file(key),all);syncDirectory(this.dir);this.index.set(key,new Map(all.map(r=>[r.mint,r.acceptedAt])));this.dirty.add(key);added+=newRows.length;
  }return added;
 }
 *rows({level,phase,label,curves=false}={}){for(const [key] of this.index){const [ph,lb]=key.split('-');if(phase&&phase!==ph||label&&label!==lb||level&&String(level)!==(['live','dead'].includes(lb)?'1':'2'))continue;const file=this.file(key);if(fs.existsSync(file))for(const row of readRows(file))yield decode(row,curves)}}
 select(options={}){return [...this.rows(options)].sort((a,b)=>a.acceptedAt-b.acceptedAt)}
 summary(){const counts={before:{},after:{}};for(const [key,index] of this.index){const [phase,label]=key.split('-');counts[phase][label]=index.size}return {schema:1,settings:this.config,counts,banks:8,origin:'server-labeled-research-only'}}
}
module.exports={ResearchBanks,storageConfig,encode,decode};
