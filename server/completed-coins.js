'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const HOUR=3600000,dayOf=t=>new Date(t+5*HOUR).toISOString().slice(0,10);
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const metrics=c=>({rawStates:Object.keys(c.raw||{}).length,dsRows:c.ds?.length||0,vaultRows:c.lq?.length||0});
const identity=c=>({n:c.n,s:c.s,i:c.i,nameObservedAt:c.nameObservedAt||null,discoveryFeatures:c.discoveryFeatures||null,createdAt:c.createdAt||null,createdAtSource:c.createdAtSource||null,metrics:metrics(c),poolKeys:[...new Set([c.p,...(c.pools||[]),...(c.origs||[]).map(x=>x.p)].filter(Boolean))]});
function syncDir(dir){if(process.platform==='win32')return;const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
function atomic(file,value){const tmp=file+'.tmp',fd=fs.openSync(tmp,'w');try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,file);syncDir(path.dirname(file))}
function writeAll(fd,buf){let n=0;while(n<buf.length)n+=fs.writeSync(fd,buf,n,buf.length-n)}
function researchPins({source,passes,one=[],two=[],now=Date.now()}={}){
 const pins=new Map(),pin=(mint,end)=>{if(end>now)pins.set(mint,Math.max(pins.get(mint)||0,end))};
 const first=one.filter(Boolean),second=two.filter(Boolean);
 for(const rt of first.length?first:[{}])for(const r of source?.records?.values()||[]){
  if(r.acceptedAt<(rt.cohortStart||0)||r.acceptedAt>=(rt.cohortEnd??Infinity)||rt.processed?.has(r.mint))continue;
  pin(r.mint,require('./event-clock').eventAnchor(r)+(rt.config?.phases?.[r.phase]?.hours??rt.config?.hours??5)*HOUR+3*60000);
 }
 for(const rt of second.length?second:[{}])for(const r of passes?.records?.values()||[]){
  if(r.firstSeenAt<(rt.cohortStart||0)||r.firstSeenAt>=(rt.cohortEnd??Infinity)||rt.processed?.has(r.mint))continue;
  const cfg=rt.config?.phases?.[r.phase]||rt.config||{};pin(r.mint,require('./research-two-runtime').lineClock(r,cfg).windowEnd+60000);
 }return pins;
}
function retirementDue(c,{now=Date.now(),pins=new Map()}={}){
 if(!Number.isFinite(c.t)||pins.get(c.a)>now)return false;
 // Мигрировавшие (витрина) наблюдаются 24 ч → 26 ч; монеты до миграции нужны только на 5 ч исследования → 6 ч
 // (исследования дополнительно держат свои монеты через pins). Остальные кандидаты — 2 ч.
 const post=c.mg?.st==='ok',pre=!post&&!!(c.preCurve&&Number.isFinite(c.preTradingAt)),at=post||pre?c.t:Math.max(c.t,c.proofEnqueuedAt||0);
 return now-at>(post?26:pre?6:2)*HOUR;
}
function cancelRetiredGT(queue,coins,{now=Date.now(),pins=new Map()}={}){
 const pools=new Set(),active=new Set();for(const c of coins.values()){const target=retirementDue(c,{now,pins})?pools:active;for(const p of [c.p,...(c.origs||[]).map(x=>x.p)])if(p)target.add(p)}for(const p of active)pools.delete(p);
 let cancelled=0;for(let i=queue.length-1;i>=0;i--){const task=queue[i],match=/^(k10|p5|p24a|p24b|tr):(.+)$/.exec(task.key||'');if(!match||!pools.has(match[2]))continue;
  queue.splice(i,1);task.rej(Object.assign(Error('observation window completed'),{code:'OBSERVATION_COMPLETE'}));cancelled++;
 }return cancelled;
}
function containsObject(archived,current){
 if(current===undefined)return true;if(current===null||typeof current!=='object')return Object.is(archived,current);
 if(Array.isArray(current))return Array.isArray(archived)&&JSON.stringify(archived)===JSON.stringify(current);
 if(!archived||typeof archived!=='object')return false;return Object.entries(current).every(([k,v])=>containsObject(archived[k],v));
}
function containsRows(archived,current){const rows=new Set((archived||[]).map(r=>JSON.stringify(r)));return (current||[]).every(r=>rows.has(JSON.stringify(r)))}
function containsObservations(archived,current){
 for(const key of ['ct','mg','mg0','mgH','wsMigrationSnapshot','migrationSlot','migrationSignalAt'])if(JSON.stringify(archived[key]??null)!==JSON.stringify(current[key]??null))return false;
 const contract=require('./observation-contract'),old=contract.project(archived,{metadata:archived}),hot=contract.project(current,{metadata:current});
 delete old.preTradingAt;delete hot.preTradingAt;delete old.legacy;delete hot.legacy; // This value is already durable in the source admission ledger.
 const oldObs=old.observations,newObs=hot.observations;delete old.observations;delete hot.observations;
 if(!containsObject(old,hot)||!containsObject(oldObs.migrationProof,newObs.migrationProof))return false;
 return newObs.pools.every(p=>{const prior=oldObs.pools.find(o=>o.address===p.address&&o.marketAt===p.marketAt);if(!prior)return false;
  for(const [key,value] of Object.entries(p)){
   if(key==='archives'||value===null)continue;
   if(key==='tradeRows'&&typeof value==='object'&&!Object.keys(value).length)continue;
   if(key==='tradeCoverage'&&!Number.isFinite(value?.at)&&Object.keys(value||{}).every(k=>['miss','reason','why','cov'].includes(k)))continue;
   if(['ds','activity'].includes(key)){if(!containsRows(prior[key],value))return false;}
   else if(key==='vaults'){if(!containsRows(prior.vaults?.samples,value?.samples))return false;const a={...prior.vaults},b={...value};delete a.samples;delete b.samples;if(!containsObject(a,b))return false;}
   else if(!containsObject(prior[key],value))return false;
  }return true;
 });
}
class CompletedCoins{
 constructor(dir){this.dir=path.join(dir,'completed-coins');this.outbox=path.join(this.dir,'raw-outbox');fs.mkdirSync(this.outbox,{recursive:true});this.index=new Map();this.confirmed=new Map();this.sealed=new Set();this.seeded=new Set();this.seedStats=new Map();this.removed=0;this.lastRemovedAt=null;
  for(const file of fs.readdirSync(this.dir)){
   if(/^\d{4}-\d\d-\d\d\.sealed\.json$/.test(file))this.sealed.add(file.slice(0,10));
   if(/^\d{4}-\d\d-\d\d\.seeded\.json$/.test(file)){const day=file.slice(0,10);this.seeded.add(day);this.seedStats.set(day,JSON.parse(fs.readFileSync(path.join(this.dir,file),'utf8')))}
   if(/^\d{4}-\d\d-\d\d\.confirmed\.json$/.test(file)){const v=JSON.parse(fs.readFileSync(path.join(this.dir,file),'utf8'));this.confirmed.set(file.slice(0,10),new Map(v.entries||[]))}
  }
  for(const file of fs.readdirSync(this.dir))if(/^\d{4}-\d\d-\d\d\.ndjson$/.test(file)){const day=file.slice(0,10);if(this.sealed.has(day)){fs.unlinkSync(this.file(day));try{fs.unlinkSync(path.join(this.dir,day+'.confirmed.json'))}catch(e){if(e.code!=='ENOENT')throw e}}else this.replay(day)}
  this.trimSealed();this.trimSeeded();
 }
 file(day){if(!/^\d{4}-\d\d-\d\d$/.test(day))throw Error('Invalid archive day');return path.join(this.dir,day+'.ndjson')}
 replay(day){const file=this.file(day),fd=fs.openSync(file,'r+'),buffer=Buffer.alloc(65536),records=new Map(),seenConfirmed=new Set(),ack=this.confirmed.get(day)||new Map();let carry=Buffer.alloc(0),offset=0;
  try{for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;const data=Buffer.concat([carry,buffer.subarray(0,n)]);let start=0,at;
    while((at=data.indexOf(10,start))!==-1){const bytes=data.subarray(start,at),row=JSON.parse(bytes.toString('utf8'));if(!row.c?.a||row.hash!==hash(JSON.stringify(row.c)))throw Error('Corrupt completed coin');
     if(ack.get(row.c.a)===row.hash)seenConfirmed.add(row.c.a);const length=bytes.length+1;records.set(row.c.a,{mint:row.c.a,hash:row.hash,offset,end:offset+length,length,t:row.c.t,...identity(row.c)});offset+=length;start=at+1;}
    carry=Buffer.from(data.subarray(start));if(carry.length>16*1024*1024)throw Error('Completed coin exceeds replay bound');
   }
   for(const mint of ack.keys())if(!seenConfirmed.has(mint))throw Error('Confirmed archive is incomplete');
   if(carry.length){fs.ftruncateSync(fd,offset);fs.fsyncSync(fd)}
  }finally{fs.closeSync(fd)}this.index.set(day,records);
 }
 async eraseLegacyBirths(cutoff){
  const marker=path.join(this.dir,'legacy-birth-redaction-v1.json');this.legacyCutoff=cutoff;
  if(fs.existsSync(marker))return JSON.parse(fs.readFileSync(marker,'utf8'));
  const {coin,context}=require('./legacy-data-redaction'),ctx=context({cutoff}),stats={removed:0,redacted:0,complete:false};
  for(const day of this.days()){
   const entries=[...(this.index.get(day)||new Map()).values()],tmp=this.file(day)+'.redact',fd=fs.openSync(tmp,'w',0o600),ack=new Map(this.confirmed.get(day)||[]);let touched=false;
   try{let n=0;for(const e of entries){const old=this.readCoin(e.mint),next=coin(old,ctx);if(!next){ack.delete(e.mint);stats.removed++;touched=true;}else{const body=JSON.stringify(next),h=hash(body);if(h!==e.hash){ack.delete(e.mint);stats.redacted++;touched=true;}writeAll(fd,Buffer.from(JSON.stringify({hash:h,c:next})+'\n'));}if(++n%32===0)await new Promise(r=>setImmediate(r));}fs.fsyncSync(fd);}finally{fs.closeSync(fd)}
   if(touched){
    // Remove affected acknowledgements first. A crash before data rename only
    // requires re-confirmation; it never acknowledges missing/changed data.
    atomic(path.join(this.dir,day+'.confirmed.json'),{schema:1,entries:[...ack]});this.confirmed.set(day,ack);
    fs.renameSync(tmp,this.file(day));syncDir(this.dir);this.replay(day);
   }else fs.unlinkSync(tmp);
  }
  stats.complete=true;atomic(marker,stats);return stats;
 }
 async stage(coins){const handles=new Map(),pending=[];let count=0;
  try{for await(const c of coins){const day=dayOf(c.t);if(this.sealed.has(day))continue;const json=JSON.stringify(c),digest=hash(json),old=this.index.get(day)?.get(c.a);if(old?.hash===digest)continue;
    let file=handles.get(day);if(!file){const fd=fs.openSync(this.file(day),'a'),end=fs.fstatSync(fd).size;file={fd,end,start:end};handles.set(day,file)}
    const line=Buffer.from('{"hash":"'+digest+'","c":'+json+'}\n');writeAll(file.fd,line);
    pending.push({day,entry:{mint:c.a,hash:digest,offset:file.end,length:line.length,end:file.end+line.length,t:c.t,...identity(c)}});file.end+=line.length;count++;
    if(count%32===0)await new Promise(r=>setImmediate(r));
   }
   for(const f of handles.values())fs.fsyncSync(f.fd);syncDir(this.dir);
   for(const {day,entry} of pending){if(!this.index.has(day))this.index.set(day,new Map());this.index.get(day).set(entry.mint,entry)}
  }catch(e){for(const f of handles.values()){fs.ftruncateSync(f.fd,f.start);fs.fsyncSync(f.fd)}throw e}finally{for(const f of handles.values())fs.closeSync(f.fd)}return count;
 }
 days(){return [...this.index.keys()].filter(d=>!this.sealed.has(d))}
 metadata(mint){let best=null;for(const records of this.index.values()){const row=records.get(mint);if(row&&(!best||row.t>best.t))best=row}return best}
 readCoin(mint){const e=this.metadata(mint);if(!e)return null;const fd=fs.openSync(this.file(dayOf(e.t)),'r');try{const b=Buffer.alloc(e.length);let n=0;while(n<b.length){const read=fs.readSync(fd,b,n,b.length-n,e.offset+n);if(!read)throw Error('Incomplete completed coin');n+=read}const row=JSON.parse(b.toString('utf8'));if(row.hash!==e.hash||hash(JSON.stringify(row.c))!==e.hash)throw Error('Completed coin checksum mismatch');return row.c}finally{fs.closeSync(fd)}}
 coversHot(c){const e=this.metadata(c.a);if(!e||e.t!==c.t||!e.poolKeys.includes(c.p)||this.confirmed.get(dayOf(e.t))?.get(c.a)!==e.hash)return false;
  const archived=this.readCoin(c.a);return archived.p===c.p&&containsObservations(archived,c);
 }
 view(day,live,hydrate=c=>c){const records=this.index.get(day)||new Map(),mutable=[],shadowed=new Set();
  for(const c of live){const e=records.get(c.a);if(!e||e.hash!==hash(JSON.stringify(hydrate(c)))){mutable.push(c);shadowed.add(c.a)}}
  const entries=[...records.values()].filter(e=>!shadowed.has(e.mint)),file=this.file(day);
  const end=fs.existsSync(file)?fs.statSync(file).size:0;
  const counts={rawStates:0,dsRows:0,vaultRows:0};for(const x of [...entries.map(e=>e.metrics),...mutable.map(c=>metrics(hydrate(c)))])for(const key of Object.keys(counts))counts[key]+=x[key];
  return {day,end,metrics:counts,proof:entries.map(e=>[e.mint,e.hash]),length:mutable.length+entries.length,*[Symbol.iterator](){
   if(entries.length){const fd=fs.openSync(file,'r');try{for(const e of entries){const b=Buffer.alloc(e.length);let n=0;while(n<b.length){const r=fs.readSync(fd,b,n,b.length-n,e.offset+n);if(!r)throw Error('Incomplete completed coin');n+=r}const row=JSON.parse(b.toString('utf8'));if(row.hash!==e.hash||hash(JSON.stringify(row.c))!==e.hash)throw Error('Completed coin checksum mismatch');yield row.c}}finally{fs.closeSync(fd)}}
   for(const c of mutable)yield hydrate(c);
  },reduce(fn,initial){let value=initial;for(const c of this)value=fn(value,c);return value}};
 }
 needsConfirmation(day){const entries=this.index.get(day),ack=this.confirmed.get(day);return !!entries&&[...entries.values()].some(e=>ack?.get(e.mint)!==e.hash)}
 confirm(day,view){if(!view.proof?.length)return;const next=new Map(this.confirmed.get(day)||[]);for(const [mint,digest] of view.proof)next.set(mint,digest);atomic(path.join(this.dir,day+'.confirmed.json'),{schema:1,entries:[...next]});this.confirmed.set(day,next)}
 isConfirmed(c){const day=dayOf(c.t),e=this.index.get(day)?.get(c.a);return !!e&&this.confirmed.get(day)?.get(c.a)===e.hash&&e.hash===hash(JSON.stringify(c))}
 seal(day,now=Date.now()){
  // A temporarily empty today/yesterday can still receive more records. Keep
  // its cold rows until even the last possible birth has completed 26 hours.
  const latestBirth=Date.parse(day+'T00:00:00Z')-5*HOUR+24*HOUR;
  if(now<latestBirth+26*HOUR||this.needsConfirmation(day))return false;
  atomic(path.join(this.dir,day+'.sealed.json'),{schema:1});this.sealed.add(day);this.index.delete(day);this.confirmed.delete(day);
  for(const file of [this.file(day),path.join(this.dir,day+'.confirmed.json')])try{fs.unlinkSync(file)}catch(e){if(e.code!=='ENOENT')throw e}syncDir(this.dir);this.trimSealed();return true;
 }
 trimSealed(){for(const day of [...this.sealed].sort().slice(0,-4)){try{fs.unlinkSync(path.join(this.dir,day+'.sealed.json'))}catch(e){if(e.code!=='ENOENT')throw e}this.sealed.delete(day)}}
 markSeeded(day,stats){atomic(path.join(this.dir,day+'.seeded.json'),stats);this.seeded.add(day);this.seedStats.set(day,stats);this.trimSeeded()}
 trimSeeded(){for(const day of [...this.seeded].sort().slice(0,-4)){try{fs.unlinkSync(path.join(this.dir,day+'.seeded.json'))}catch(e){if(e.code!=='ENOENT')throw e}this.seeded.delete(day);this.seedStats.delete(day)}}
 rawFile(name){return path.join(this.outbox,hash(name)+'.json')}
 enqueueRaw(name,payload){atomic(this.rawFile(name),{name,payload})}
 readRaw(name){return JSON.parse(fs.readFileSync(this.rawFile(name),'utf8')).payload}
 completeRaw(name){try{fs.unlinkSync(this.rawFile(name));syncDir(this.outbox)}catch(e){if(e.code!=='ENOENT')throw e}}
 rawQueue(){const rows=[];for(const f of fs.readdirSync(this.outbox))if(/^[a-f0-9]{64}\.json$/.test(f)){const x=JSON.parse(fs.readFileSync(path.join(this.outbox,f),'utf8'));rows.push([x.name,null])}return rows}
 summary(){let rows=0,pending=0,bytes=0;for(const [day,entries] of this.index){rows+=entries.size;bytes+=fs.statSync(this.file(day)).size;for(const e of entries.values()){if(this.confirmed.get(day)?.get(e.mint)!==e.hash)pending++}}
  return {rows,pendingConfirmation:pending,localArchiveBytes:bytes,openDays:this.days().length,sealedDays:this.sealed.size,removed:this.removed,lastRemovedAt:this.lastRemovedAt,legacySeed:Object.fromEntries(this.seedStats)};
 }
}
module.exports={CompletedCoins,researchPins,retirementDue,cancelRetiredGT};
