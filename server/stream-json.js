'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {Readable}=require('node:stream'),{pipeline}=require('node:stream/promises');
let sequence=0;const cleaned=new Set();
class JsonRows{constructor(factory){this.factory=factory}[Symbol.iterator](){return this.factory()}}
const rowStream=factory=>new JsonRows(factory);
// Preserve ordinary JSON wire semantics; split the large top-level row collections.
async function* jsonPieces(value,depth=0){
 if(value&&typeof value.toJSON==='function')value=value.toJSON();
 if(value===null||typeof value!=='object'||depth>=2){const json=JSON.stringify(value);if(json===undefined)throw TypeError('Undefined JSON root');yield json;return}
 if(Array.isArray(value)||value instanceof JsonRows){yield '[';let first=true,n=0;for(const item of value){if(!first)yield ',';first=false;
   if(item===undefined||typeof item==='function'||typeof item==='symbol')yield 'null';else yield*jsonPieces(item,depth+1);
   if(++n%4===0)await new Promise(r=>setImmediate(r));}yield ']';return}
 yield '{';let first=true;for(const key of Object.keys(value)){const item=value[key];if(item===undefined||typeof item==='function'||typeof item==='symbol')continue;
  if(!first)yield ',';first=false;yield JSON.stringify(key)+':';yield*jsonPieces(item,depth+1);}yield '}';
}
async function* jsonChunks(value){let pending='';for await(const piece of jsonPieces(value)){if(pending.length+piece.length>32768&&pending){yield pending;pending=''}
 if(piece.length>32768)yield piece;else pending+=piece;}if(pending)yield pending;}
async function gzipJson({dir,value,health,name}){
 const tmp=path.join(dir,'publish-tmp');fs.mkdirSync(tmp,{recursive:true});
 if(!cleaned.has(tmp)){cleaned.add(tmp);for(const name of fs.readdirSync(tmp))if(/^json-\d+-\d+\.gz$/.test(name)&&!name.startsWith('json-'+process.pid+'-'))try{fs.unlinkSync(path.join(tmp,name))}catch{}}
 const file=path.join(tmp,'json-'+process.pid+'-'+(++sequence)+'.gz');
 health?.capture('stream:before',{name});
 try{await pipeline(Readable.from(jsonChunks(value),{objectMode:false,highWaterMark:65536}),zlib.createGzip({chunkSize:16384,memLevel:4}),fs.createWriteStream(file,{flags:'wx'}));
  const bytes=fs.statSync(file).size;health?.capture('stream:ready',{name,bytes});return {file,bytes,dispose:()=>fs.promises.unlink(file).catch(()=>{})};
 }catch(e){await fs.promises.unlink(file).catch(()=>{});throw e}
}
function saveRows(file,rows,health){const tmp=file+'.tmp',fd=fs.openSync(tmp,'w');health?.capture('save:before');let count=0,chars=0;
 try{fs.writeSync(fd,'[');for(const row of rows){const json=JSON.stringify(row);if(count++)fs.writeSync(fd,',');fs.writeSync(fd,json);chars+=json.length}fs.writeSync(fd,']');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 fs.renameSync(tmp,file);health?.capture('save:complete',{rows:count,chars});return count;
}
// Production checkpoints yield per row; compression/JSON and disk flushing
// must not suspend WS delivery for the entire census.
async function saveRowsAsync(file,rows,health){const tmp=file+'.async-'+process.pid+'-'+(++sequence),started=Date.now();let fd,count=0,chars=0;health?.capture('save:before');
 const write=async value=>{const b=Buffer.from(value);let offset=0;while(offset<b.length){const r=await fd.write(b,offset,b.length-offset,null);if(!r.bytesWritten)throw Error('Incomplete state write');offset+=r.bytesWritten;}};
 try{fd=await fs.promises.open(tmp,'wx');await write('[');for(const row of rows){const json=JSON.stringify(row);await write((count?',':'')+json);count++;chars+=json.length;if(count%4===0)await new Promise(r=>setImmediate(r));}await write(']');await fd.sync();await fd.close();fd=null;await fs.promises.rename(tmp,file);health?.capture('save:complete',{rows:count,chars,durationMs:Date.now()-started});return count;
 }catch(e){if(fd)await fd.close().catch(()=>{});await fs.promises.unlink(tmp).catch(()=>{});throw e;}
}
// Incremental replay keeps the file text and parsed array from coexisting with C.
function* readRows(file,health,{field=null}={}){
 const {StringDecoder}=require('node:string_decoder'),decoder=new StringDecoder('utf8');
 const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(65536);let header='',headerFound=!field;let mode='start',row='',depth=0,quoted=false,escape=false,count=0,allowEnd=true;
 const consume=function*(text){let start=mode==='row'?0:-1;
  for(let i=0;i<text.length;i++){const ch=text[i];
   if(mode==='row'){
    if(quoted){if(escape)escape=false;else if(ch==='\\')escape=true;else if(ch==='"')quoted=false}
    else if(ch==='"')quoted=true;else if(ch==='{'||ch==='[')depth++;else if(ch==='}'||ch===']')depth--;
    if(depth===0){row+=text.slice(start,i+1);const item=JSON.parse(row);row='';if(!item||typeof item!=='object'||Array.isArray(item))throw Error('Invalid coin row');yield item;count++;if(count%1000===0)health?.capture('load:rows',{rows:count});mode='comma';start=-1}
    continue;
   }
   if(/\s/.test(ch))continue;
   if(mode==='start'){if(ch!=='[')throw Error('State must be a JSON array');mode='value';continue}
   if(mode==='value'){if(ch===']'&&allowEnd){mode='done';continue}if(ch!=='{')throw Error('Invalid state row');mode='row';start=i;depth=1;quoted=false;escape=false;continue}
   if(mode==='comma'){if(ch===','){mode='value';allowEnd=false;continue}if(ch===']'){mode='done';continue}throw Error('Invalid state separator')}
   if(field&&mode==='done'&&ch==='}'){mode='wrappedDone';continue}throw Error('Trailing state data');
  }
  if(mode==='row'){row+=text.slice(start);if(row.length>16*1024*1024)throw Error('Coin row exceeds replay bound')}
 };
 const read=function*(text){
  if(headerFound){yield*consume(text);return}header+=text;
  if(header.length>1024*1024)throw Error('Collection header exceeds bound');
  const pattern=new RegExp('"'+field+'"\\s*:\\s*\\[','g');let match;
  while((match=pattern.exec(header))){let prefix;try{prefix=JSON.parse(header.slice(0,match.index+match[0].length-1)+'[]}')}catch{continue}
   if(!prefix||Array.isArray(prefix)||!Array.isArray(prefix[field]))continue;
   headerFound=true;const rest=header.slice(match.index+match[0].length);header='';mode='value';yield*consume(rest);return;
  }
 };
 try{for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;yield*read(decoder.write(buffer.subarray(0,n)))}yield*read(decoder.end());if(mode!==(field?'wrappedDone':'done'))throw Error('Incomplete state array');health?.capture('load:rows:complete',{rows:count});return count}
 finally{fs.closeSync(fd)}
}
function loadRows(file,onRow,health,options){let count=0;for(const row of readRows(file,health,options)){onRow(row);count++}return count}
function multipartGzip(payload,name){
 const boundary='solscan-'+require('node:crypto').randomBytes(12).toString('hex');
 const metadata=JSON.stringify({name,contentType:'application/json',contentEncoding:'gzip',cacheControl:'no-cache, max-age=0'});
 const head=Buffer.from('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+metadata+'\r\n--'+boundary+'\r\nContent-Type: application/json\r\n\r\n');
 const tail=Buffer.from('\r\n--'+boundary+'--\r\n'),file=fs.createReadStream(payload.file);
 const body=Readable.from((async function*(){yield head;yield*file;yield tail})(),{objectMode:false,highWaterMark:65536});
 const close=stream=>stream.closed?Promise.resolve():new Promise(resolve=>{stream.once('close',resolve);stream.once('error',()=>{});stream.destroy()});
 return {body,contentType:'multipart/related; boundary='+boundary,length:head.length+payload.bytes+tail.length,close:async()=>{await close(body);await close(file)}};
}
module.exports={jsonChunks,gzipJson,saveRows,saveRowsAsync,loadRows,multipartGzip,rowStream,readRows};
