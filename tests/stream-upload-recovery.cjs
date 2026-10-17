'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const code=fs.readFileSync(process.env.SOLSCAN_TEST_COLLECTOR||path.join(__dirname,'../server/collector.js'),'utf8');
const skip=code.includes("if(!PUBLICATIONS)")||!code.includes("gzipJson({dir:DIR");
function setup(t,fail){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sol-upload-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const calls=[];
 const ctx={AbortSignal,HEALTH:null,DIR:dir,BUCKET:'mock',fs,Date,JSON,String,Promise,require:()=>require('../server/stream-json'),token:async()=>'<mock>',fetch:async(url,options)=>{
  calls.push({url,options});if(options.method==='POST'){const chunks=[];for await(const chunk of options.body)chunks.push(chunk);const data=Buffer.concat(chunks),first=data.indexOf('\r\n\r\n'),second=data.indexOf('\r\n\r\n',first+4),end=data.lastIndexOf('\r\n--');calls.at(-1).metadata=data.subarray(first+4,data.indexOf('\r\n--',first)).toString();calls.at(-1).bytes=data.length;calls.at(-1).wire=zlib.gunzipSync(data.subarray(second+4,end)).toString();}
  return {ok:!fail,status:fail?500:200,text:async()=> 'offline',arrayBuffer:async()=>new ArrayBuffer(0)};}};
 vm.createContext(ctx);vm.runInContext(code.slice(code.indexOf('async function upload(name,obj)'),code.indexOf('let lastYest='))+'\nthis.send=upload;',ctx);return {ctx,calls,dir};}
test('real recovery sender streams gzip with a correct content length and cleans its disk payload',{skip},async t=>{
 const {ctx,calls,dir}=setup(t,false),obj={at:12,coins:[{at:11,ds:[[10,1]]}]};await ctx.send('obs/day.json',obj);
 assert.equal(calls.length,1);assert.match(calls[0].url,/uploadType=multipart/);assert.match(calls[0].metadata,/"cacheControl":"no-cache, max-age=0"/);assert.equal(calls[0].bytes,+calls[0].options.headers['Content-Length']);assert.equal(calls[0].wire,JSON.stringify(obj));assert.equal(calls[0].options.duplex,'half');assert.ok(+calls[0].options.headers['Content-Length']>0);assert.equal(fs.readdirSync(path.join(dir,'publish-tmp')).length,0);
});
test('failed streamed upload rejects and removes its temporary payload for a retained retry',{skip},async t=>{
 const {ctx,dir}=setup(t,true);await assert.rejects(ctx.send('obs/day.json',{coins:[{a:'mint'}]}),/upload 500/);assert.equal(fs.readdirSync(path.join(dir,'publish-tmp')).length,0);
});
