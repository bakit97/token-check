'use strict';
// Owner TZ20: erase legacy birth cohorts, retaining every after record.
// Deliberately scoped to known runtime files; remote/raw cleanup is separate.
const fs=require('node:fs'),path=require('node:path');
const MAX=32*1024*1024;
function atomic(file,value){const tmp=file+'.purge-tmp',fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);require('./durable-json').syncDirectory(path.dirname(file));}
function snapshot(value,ids){
 let removed=0;const out={...value},after=new Set();
 for(const key of ['rows','admitted','modules'])if(Array.isArray(value[key])){out[key]=value[key].filter(r=>{if(r?.phase==='before'){removed++;return false;}if(r?.mint)after.add(r.mint);return true;});}
 if(Array.isArray(value.processed))out.processed=value.processed.filter(r=>!ids.has(r[0])||after.has(r[0]));
 return {value:out,removed};
}
function cleanup({dir,now=Date.now,maxBytes=MAX}={}){
 const marker=path.join(dir,'legacy-before-local-purge-v1.json');if(fs.existsSync(marker))return JSON.parse(fs.readFileSync(marker,'utf8'));
 const pending=path.join(dir,'legacy-before-purge-pending.json');if(!fs.existsSync(pending))return {schema:1,complete:false,reason:'missing-source-purge-manifest'};
 const manifest=JSON.parse(fs.readFileSync(pending,'utf8'));if(manifest.schema!==1||!Array.isArray(manifest.mints))throw Error('Invalid source purge manifest');const ids=new Set(manifest.mints),files=[];
 for(const name of fs.readdirSync(dir))if(/^research-v2-bank(?:-one|-two)?(?:-[a-f0-9]{20}-\d+)?\.json(?:\.journal)?$/.test(name)||name==='auto-studies-v2.json'||name==='pass-v2.journal')files.push({file:path.join(dir,name),kind:name.endsWith('.journal')?'journal':'snapshot'});
 const bank=path.join(dir,'research-banks-v2');if(fs.existsSync(bank)){for(const name of fs.readdirSync(bank))if(/^before-(live|dead|strong|weak)\.json$/.test(name))files.push({file:path.join(bank,name),kind:'bank'});const unknown=path.join(bank,'unclassified-one');if(fs.existsSync(unknown))for(const name of fs.readdirSync(unknown))if(/^[a-f0-9]{64}\.json$/.test(name))files.push({file:path.join(unknown,name),kind:'bank'});}
 const passes=path.join(dir,'pass-v2-journal');if(fs.existsSync(passes))for(const name of fs.readdirSync(passes))if(/^pass-\d{4}-\d\d-\d\d\.jsonl$/.test(name))files.push({file:path.join(passes,name),kind:'journal'});
 const result={schema:1,startedAt:now(),poolEpochAt:manifest.createdAt,complete:true,files:0,rowsRemoved:0,remoteCleanupPending:true,rawCleanupPending:true,skipped:[]};
 for(const {file,kind} of files){if(fs.statSync(file).size>maxBytes){result.complete=false;result.skipped.push(path.relative(dir,file));continue;}const text=fs.readFileSync(file,'utf8');let removed=0,body;
  if(kind==='journal'){if(text&&!text.endsWith('\n'))throw Error('Uncommitted journal suffix requires normal recovery before purge: '+path.basename(file));const rows=text.trim()?text.trim().split('\n').map(s=>JSON.parse(s)):[];const keep=rows.filter(r=>{if(r.phase==='before'){removed++;return false;}return true;});body=keep.map(r=>JSON.stringify(r)+'\n').join('');}
  else if(kind==='bank'){const rows=JSON.parse(text);if(!Array.isArray(rows))throw Error('Invalid bank during purge');body=JSON.stringify(rows.filter(r=>{if(r.phase==='before'){removed++;return false;}return true;}));}
  else{const x=snapshot(JSON.parse(text),ids);removed=x.removed;body=JSON.stringify(x.value);}
  if(body!==text)atomic(file,body);result.files++;result.rowsRemoved+=removed;
 }
 result.finishedAt=now();if(result.complete)atomic(marker,JSON.stringify(result));return result;
}
module.exports={cleanup,snapshot};
