'use strict';
// Immutable prefixes of active observations: remote verification precedes RAM trimming.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const H=3600000,MAX=4*1024*1024,LIMIT=128,TAIL=30*60000;
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const baseOkay=s=>/^\d+-\d+-[a-f0-9]{12}$/.test(s);
const write=(fd,b)=>{let n=0;while(n<b.length)n+=fs.writeSync(fd,b,n,b.length-n)};
function syncDir(dir){if(process.platform==='win32')return;const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
function atomic(file,value){const tmp=file+'.tmp',fd=fs.openSync(tmp,'w',0o600);try{write(fd,Buffer.from(JSON.stringify(value)));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,file);syncDir(path.dirname(file))}
function same(a,b){return JSON.stringify(a)===JSON.stringify(b)}
function at(key,row){return row[0]*(key==='curveSol'?1:1000)}
function fieldsOf(pool,cutoff){const fields={};for(const key of ['ds','gx','lq','curveSol']){const rows=(pool[key]||[]).filter(r=>Array.isArray(r)&&at(key,r)<cutoff);if(rows.length>1)fields[key]=rows}
 const raw=Object.fromEntries(Object.entries(pool.raw||{}).filter(([,r])=>r?.b&&r.at<cutoff));if(Object.keys(raw).length)fields.raw=raw;
 for(const key of ['k10','path'])if(pool[key]?.c?.length&&pool[key].at<cutoff)fields[key]=pool[key];return JSON.parse(JSON.stringify(fields))}
function mergeFields(earlier,later){const out={...earlier,...later};for(const key of ['ds','gx','lq','curveSol'])if(earlier[key]||later[key]){const rows=new Map();for(const r of [...(earlier[key]||[]),...(later[key]||[])])rows.set(JSON.stringify(r),r);out[key]=[...rows.values()].sort((a,b)=>a[0]-b[0])}
 if(earlier.raw||later.raw){out.raw={...earlier.raw};for(const [k,r] of Object.entries(later.raw||{}))out.raw[k]={...out.raw[k],...r}}
 for(const key of ['k10','path'])if(earlier[key]&&!later[key]?.c?.length)out[key]={...earlier[key],...later[key],c:earlier[key].c};return out}
function trim(pool,fields,reference){for(const key of ['ds','gx','lq','curveSol'])if(fields[key]){const archived=new Set(fields[key].map(r=>JSON.stringify(r))),old=(pool[key]||[]).filter(r=>archived.has(JSON.stringify(r))),keep=new Set();if(old.length)keep.add(JSON.stringify(old.at(-1)));
  if(key==='lq'&&old.length){const qi=pool.vmint?.includes(pool.a)?1-pool.vmint.indexOf(pool.a):pool.vmint?.indexOf('So11111111111111111111111111111111111111112');if(qi>=0){const maximum=old.reduce((a,b)=>b[2+qi]>a[2+qi]?b:a);keep.add(JSON.stringify(maximum))}}
  pool[key]=(pool[key]||[]).filter(r=>!archived.has(JSON.stringify(r))||keep.has(JSON.stringify(r)));}
 for(const [key,row] of Object.entries(fields.raw||{}))if(same(pool.raw?.[key],row)){const {b,...metadata}=row;pool.raw[key]={...metadata,historyArchived:true}}
 for(const key of ['k10','path'])if(fields[key]&&same(fields[key],pool[key])){const {c,...metadata}=pool[key];pool[key]={...metadata,historyArchived:true}}
 pool.archiveRefs={...pool.archiveRefs,activeHistory:[...(pool.archiveRefs?.activeHistory||[]),reference]};delete pool.historyHydrated;
}
class ActiveHistory{
 constructor(dir){this.dir=path.join(dir,'active-history-v1');fs.mkdirSync(this.dir,{recursive:true});this.chunks=new Map();this.sequence=0;this.busy=false;this.lastAt=0;this.stats={offloadedPools:0,confirmedChunks:0,restoredChunks:0,bytesRemoved:0,errors:0};
  for(const name of fs.readdirSync(this.dir))if(name.endsWith('.index.json')){const x=JSON.parse(fs.readFileSync(path.join(this.dir,name),'utf8'));if(!baseOkay(x.base)||!x.confirmed)throw Error('Invalid active-history index');this.chunks.set(x.base,x)}
  this.pendingFile=path.join(this.dir,'pending.json');this.pending=fs.existsSync(this.pendingFile)?JSON.parse(fs.readFileSync(this.pendingFile,'utf8')):null;
 }
 file(base){if(!baseOkay(base))throw Error('Invalid active-history file');return path.join(this.dir,base+'.jsonl')}
 _read(ref){if(!Number.isSafeInteger(ref.offset)||!Number.isSafeInteger(ref.length)||ref.offset<0||ref.length<1||ref.length>MAX)throw Error('Invalid active-history range');const fd=fs.openSync(this.file(ref.base),'r'),b=Buffer.alloc(ref.length);try{let n=0;while(n<b.length){const k=fs.readSync(fd,b,n,b.length-n,ref.offset+n);if(!k)throw Error('Incomplete active history');n+=k}}finally{fs.closeSync(fd)}const row=JSON.parse(b.toString('utf8'));if(row.hash!==ref.hash||digest(JSON.stringify(row.fields))!==row.hash)throw Error('Active-history checksum mismatch');return row}
 hydrate(c){if(!c||c.historyHydrated)return c;const hydratePool=pool=>{const refs=pool.archiveRefs?.activeHistory;if(!refs?.length)return pool;let fields={};for(const ref of refs){const row=this._read(ref);if(row.a!==c.a||row.p!==pool.p||row.t!==pool.t)throw Error('Active-history identity mismatch');fields=mergeFields(fields,row.fields)}return {...mergeFields(fields,pool),historyHydrated:true}};
  const out=hydratePool(c),origs=(c.origs||[]).map(hydratePool);if(out===c&&origs.every((p,i)=>p===c.origs[i]))return c;return {...out,origs,historyHydrated:true}}
 references(coins){const refs=[];for(const c of coins.values())if(!c.historyHydrated)for(const pool of [c,...(c.origs||[])])for(const ref of pool.archiveRefs?.activeHistory||[])refs.push(ref);return refs}
 async restore(coins,read){const grouped=new Map();for(const ref of this.references(coins))if(!fs.existsSync(this.file(ref.base))){if(!grouped.has(ref.base))grouped.set(ref.base,[]);grouped.get(ref.base).push(ref)}
  for(const [base,refs] of grouped){const object=await read(refs[0].remote);if(object?.schema!==1||object.base!==base||!Array.isArray(object.rows)||object.rows.length>LIMIT)throw Error('Missing active-history mirror');const tmp=this.file(base)+'.restore',fd=fs.openSync(tmp,'w',0o600);let bytes=0;try{for(const row of object.rows){if(digest(JSON.stringify(row.fields))!==row.hash)throw Error('Bad active-history mirror');const b=Buffer.from(JSON.stringify(row)+'\n');bytes+=b.length;if(bytes>MAX)throw Error('Active-history mirror too large');write(fd,b)}fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,this.file(base));for(const ref of refs)this._read(ref);this.stats.restoredChunks++}
 }
 _prepare(coins,now){const selected=[];let bytes=0;for(const c of coins.values()){if(now-c.t<2*H)continue;for(const pool of [c,...(c.origs||[])]){const fields=fieldsOf(pool,now-TAIL),text=JSON.stringify(fields);if(text.length<1024)continue;const row={a:c.a,p:pool.p,t:pool.t,fields,hash:digest(text)},buf=Buffer.from(JSON.stringify(row)+'\n');if(buf.length>MAX)continue;if(selected.length&&(bytes+buf.length>MAX||selected.length>=LIMIT))break;selected.push({row,buf,offset:bytes,length:buf.length});bytes+=buf.length}if(selected.length>=LIMIT||bytes>=MAX-65536)break}
  if(!selected.length)return null;const hash=crypto.createHash('sha256');for(const x of selected)hash.update(x.buf);const base=now+'-'+(++this.sequence)+'-'+hash.digest('hex').slice(0,12),file=this.file(base),fd=fs.openSync(file,'wx',0o600);try{for(const x of selected)write(fd,x.buf);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  const day=new Date(now+5*H).toISOString().slice(0,10),remote='observations-v2/active-history/'+day+'/'+base+'.json',pending={base,remote,createdAt:now,bytes,entries:selected.map(x=>({a:x.row.a,p:x.row.p,t:x.row.t,hash:x.row.hash,offset:x.offset,length:x.length}))};atomic(this.pendingFile,pending);this.pending=pending;return pending;
 }
 async _finish(coins,publish,read){const pending=this.pending;if(!pending)return;const self=this,{rowStream}=require('./stream-json');await publish(pending.remote,{schema:1,base:pending.base,rows:rowStream(function*(){for(const e of pending.entries)yield self._read({...e,base:pending.base})})});
  const mirror=await read(pending.remote);if(mirror?.schema!==1||mirror.base!==pending.base||mirror.rows?.length!==pending.entries.length)throw Error('Active-history mirror incomplete');for(let i=0;i<pending.entries.length;i++){const row=mirror.rows[i],e=pending.entries[i];if(row.a!==e.a||row.p!==e.p||row.t!==e.t||row.hash!==e.hash||digest(JSON.stringify(row.fields))!==e.hash)throw Error('Active-history mirror checksum mismatch')}
  const confirmed={base:pending.base,remote:pending.remote,bytes:pending.bytes,confirmed:true,at:Date.now(),count:pending.entries.length};atomic(path.join(this.dir,pending.base+'.index.json'),confirmed);this.chunks.set(pending.base,confirmed);
  for(const e of pending.entries){const c=coins.get(e.a),pool=c&&[c,...(c.origs||[])].find(p=>p.p===e.p&&p.t===e.t);if(!pool)continue;const row=this._read({...e,base:pending.base}),before=JSON.stringify(pool).length;if(c.historyHydrated){delete c.historyHydrated;for(const p of [c,...(c.origs||[])])if(p.archiveRefs?.activeHistory){p.archiveRefs={...p.archiveRefs};delete p.archiveRefs.activeHistory;delete p.historyHydrated}}
   trim(pool,row.fields,{base:pending.base,remote:pending.remote,hash:e.hash,offset:e.offset,length:e.length});this.stats.bytesRemoved+=Math.max(0,before-JSON.stringify(pool).length);this.stats.offloadedPools++;
  }
  fs.unlinkSync(this.pendingFile);syncDir(this.dir);this.pending=null;this.stats.confirmedChunks++;
 }
 async compact({coins,publish,read,now=Date.now(),maxChunks=8}={}){if(this.busy||now-this.lastAt<60000)return false;this.busy=true;this.lastAt=now;let changed=false;try{for(let i=0;i<maxChunks;i++){if(!this.pending&&!this._prepare(coins,now))break;await this._finish(coins,publish,read);changed=true;await new Promise(r=>setImmediate(r))}this.gc(coins,now);return changed}catch(e){this.stats.errors++;throw e}finally{this.busy=false}}
 gc(coins,now){const used=new Set(this.references(coins).map(r=>r.base));for(const [base,index] of this.chunks)if(!used.has(base)&&now-index.at>48*H){fs.unlinkSync(this.file(base));fs.unlinkSync(path.join(this.dir,base+'.index.json'));this.chunks.delete(base)}}
 summary(){return {...this.stats,localChunks:this.chunks.size,localBytes:[...this.chunks.values()].reduce((n,x)=>n+x.bytes,0),pending:!!this.pending,lastAt:this.lastAt}}
}
module.exports={ActiveHistory,fieldsOf,mergeFields};
