'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const {gzipJson,saveRows,loadRows}=require('../server/stream-json');
(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memory-accept-'));let peak=0;const timer=setInterval(()=>peak=Math.max(peak,process.memoryUsage().rss),10);
 try{const row={a:'mint',at:123,ds:Array(20).fill('x'.repeat(200))},coins=Array(20000).fill(row),expected=Buffer.byteLength(JSON.stringify(row))*coins.length+coins.length+1;
  const file=path.join(dir,'state.json');saveRows(file,coins.values());let count=0;loadRows(file,()=>count++);if(count!==20000||fs.statSync(file).size!==expected)throw Error('snapshot mismatch');
  const out=await gzipJson({dir,value:{coins}});let bytes=0;for await(const chunk of fs.createReadStream(out.file).pipe(zlib.createGunzip()))bytes+=chunk.length;
  if(bytes!==expected+10)throw Error('gzip wire mismatch '+bytes+' '+expected);peak=Math.max(peak,process.memoryUsage().rss);if(peak>220e6)throw Error('Temporary serialization RSS exceeds 220 MB');console.log(JSON.stringify({rows:count,wireMB:bytes/1e6,peakRssMB:peak/1e6,heapLimitMB:require('v8').getHeapStatistics().heap_size_limit/1e6}));await out.dispose();
 }finally{clearInterval(timer);fs.rmSync(dir,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1});
