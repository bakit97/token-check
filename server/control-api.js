'use strict';
// Owner-only configuration gateway, intended for a separate HTTPS Cloud Run
// service. This never runs in the coin collector process.
// Credentials belong in Secret Manager / environment, never in GitHub or GCS.
const http=require('node:http');
const crypto=require('node:crypto');
const {configOf}=require('./pass-runtime');
const {settings:settingsOne}=require('./research-runtime');
const {configOf:settingsTwo}=require('./research-two-runtime');

const BUCKET=process.env.SOLSCAN_BUCKET||'sol-scan-511718-data';
const OBJECT='config/pass-filters.json';
const AGE_OBJECT='config/source-age.json';
const ONE_OBJECT='config/research-one.json';
const TWO_OBJECT='config/research-two.json';
const EPOCH_ONE='config/research-epoch-one.json',EPOCH_TWO='config/research-epoch-two.json';
const STORAGE_OBJECT='config/research-storage.json';
const MODULE_OBJECT='config/modules.json';
const ORIGIN=process.env.SOLSCAN_CONTROL_ORIGIN||'https://bakit97.github.io';
const SHA256=process.env.SOLSCAN_CONTROL_SHA256||'';
const MAX_BYTES=48*1024;
const MAX_PER_MINUTE=8;
const strikes=new Map();
const hash=s=>crypto.createHash('sha256').update(s).digest();
const storageWrite=name=>'https://storage.googleapis.com/upload/storage/v1/b/'+encodeURIComponent(BUCKET)+
  '/o?uploadType=media&name='+encodeURIComponent(name);
const storageRead=name=>'https://storage.googleapis.com/storage/v1/b/'+encodeURIComponent(BUCKET)+
  '/o/'+encodeURIComponent(name);
function validAges(c){
  if(!c||c.schema!==1||!Number.isInteger(c.beforeMinutes)||!Number.isInteger(c.afterMinutes)||
     c.beforeMinutes<1||c.beforeMinutes>10||c.afterMinutes<1||c.afterMinutes>10)
    throw TypeError('Both admission ages must be integers 1–10');
  return {schema:1,beforeMinutes:c.beforeMinutes,afterMinutes:c.afterMinutes};
}

function authorized(req){
  const m=/^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.headers.authorization||'');
  if(!m||!/^[a-f0-9]{64}$/i.test(SHA256))return false;
  return crypto.timingSafeEqual(hash(m[1]),Buffer.from(SHA256,'hex'));
}
function rateAllowed(req){
  const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  const now=Date.now(),prior=strikes.get(ip)||[];
  const recent=prior.filter(t=>now-t<60000);
  recent.push(now);strikes.set(ip,recent);
  if(strikes.size>5000)for(const [k,v] of strikes)if(v.at(-1)<now-60000)strikes.delete(k);
  return recent.length<=MAX_PER_MINUTE;
}
function reply(res,status,data){
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(data));
}
async function readBody(req,which){
  const chunks=[];let size=0;
  for await (const chunk of req){
    size+=chunk.length;
    if(size>MAX_BYTES)throw Object.assign(Error('Payload too large'),{http:413});
    chunks.push(chunk);
  }
  let data;
  try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'))}
  catch{throw Object.assign(Error('Invalid JSON'),{http:400})}
  if([EPOCH_ONE,EPOCH_TWO].includes(which)){if(data.confirm!==true)throw Object.assign(Error('Explicit confirm:true required'),{http:422});return {schema:1,id:crypto.randomUUID(),requestedAt:Date.now()};}
  try{return which===AGE_OBJECT?validAges(data):
    which===ONE_OBJECT?settingsOne(data):
    which===TWO_OBJECT?settingsTwo(data):which===STORAGE_OBJECT?require('./research-banks').storageConfig(data):which===MODULE_OBJECT?data:configOf(data)}
  catch{throw Object.assign(Error('Invalid or unsafe owner settings'),{http:422})}
}
async function cloudToken(){
  const r=await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{
    headers:{'Metadata-Flavor':'Google'},signal:AbortSignal.timeout(5000)
  });
  if(!r.ok)throw Error('Metadata token inaccessible');
  return (await r.json()).access_token;
}
async function storageGet(token,objectName,generation){
  const r=await fetch(storageRead(objectName)+'?alt=media'+(generation?'&ifGenerationMatch='+encodeURIComponent(generation):''),{
    headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)
  });
  if(r.status===404)return null;
  if(r.status===412)throw Object.assign(Error('Concurrent change; reload'),{http:409});
  if(!r.ok)throw Error('Reading GCS config failed: '+r.status);
  return r.json();
}
async function storageGeneration(token,objectName){
  const r=await fetch(storageRead(objectName)+'?fields=generation',{
    headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(10000)
  });
  if(r.status===404)return '0';
  if(!r.ok)throw Error('Reading GCS generation failed: '+r.status);
  const meta=await r.json();
  if(!/^\d+$/.test(String(meta.generation)))throw Error('Invalid GCS generation');
  return String(meta.generation);
}
async function storagePut(token,config,objectName,expectedGeneration){
  const generation=expectedGeneration??await storageGeneration(token,objectName);
  const r=await fetch(storageWrite(objectName)+'&ifGenerationMatch='+encodeURIComponent(generation),{
    method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:Buffer.from(JSON.stringify(config)),
    signal:AbortSignal.timeout(20000)
  });
  if(r.status===412)return {conflict:true};
  if(!r.ok)throw Error('Writing GCS config failed: '+r.status);
  return {conflict:false,generation:(await r.json()).generation};
}
function handler(req,res){
  const reqOrigin=req.headers.origin;
  if(reqOrigin&&reqOrigin!==ORIGIN)return reply(res,403,{error:'origin-not-allowed'});
  if(reqOrigin===ORIGIN){
    res.setHeader('Access-Control-Allow-Origin',ORIGIN);
    res.setHeader('Vary','Origin');
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  }
  if(req.method==='OPTIONS'){
    if(reqOrigin!==ORIGIN)return reply(res,403,{error:'origin-not-allowed'});
    return reply(res,204,{});
  }
  if(req.url==='/health'&&req.method==='GET')
    return reply(res,200,{status:'running',service:'solscan-owner-control'});
  const objectName=req.url==='/api/research-one/new-epoch'?EPOCH_ONE:req.url==='/api/research-two/new-epoch'?EPOCH_TWO:req.url==='/api/filter-config'?OBJECT:
    req.url==='/api/source-age'?AGE_OBJECT:
    req.url==='/api/research-one'?ONE_OBJECT:
    req.url==='/api/research-two'?TWO_OBJECT:req.url==='/api/research-storage'?STORAGE_OBJECT:['/api/modules','/api/module-test'].includes(req.url)?MODULE_OBJECT:null;
  if(!objectName||!['GET','POST'].includes(req.method))
    return reply(res,404,{error:'not-found'});
  // This endpoint changes the background server's behavior. Only an
  // out-of-band 256-bit owner credential can modify it.
  if(!rateAllowed(req))return reply(res,429,{error:'rate-limited'});
  if(!authorized(req))return reply(res,401,{error:'not-authorized'});
  if(req.method==='POST'&&!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))
    return reply(res,415,{error:'application-json-required'});
  (async()=>{
    if(req.method==='GET'){
      const value=await storageGet(await cloudToken(),objectName);
      return reply(res,200,{config:value});
    }
    const proposed=await readBody(req,objectName);
    if([EPOCH_ONE,EPOCH_TWO].includes(objectName)){const token=await cloudToken(),generation=await storageGeneration(token,objectName),stored=await storagePut(token,proposed,objectName,generation);return reply(res,stored.conflict?409:200,stored.conflict?{error:'concurrent-update-retry'}:{accepted:true,request:proposed,generation:stored.generation,note:'Settings unchanged; collector starts an empty epoch and preserves previous observations'});}
    if(objectName===MODULE_OBJECT){
      const token=await cloudToken(),generation=await storageGeneration(token,MODULE_OBJECT),current=generation==='0'?{schema:1,modules:[],deleted:[]}:await storageGet(token,MODULE_OBJECT,generation);
      const snapshot=(await storageGet(token,'research-v2/modules.json'))?.modules||[],lib=require('./module-library');let config,module,results,deleted;
      try{
        if(req.url==='/api/module-test'){
          const modules=lib.combine({owner:current,auto:snapshot}),bank=await storageGet(token,String(proposed.level)==='1'?'research-v2/polygon-1.json':'research-v2/polygon-2.json');
          results=lib.manualTest(modules,bank?.coins||[],proposed);config=lib.catalog(current);
          for(const result of results){const m=modules.find(m=>m.id===result.id);config.modules=config.modules.filter(x=>x.id!==m.id).concat({...m,eval:{...m.eval,test:result}})}
        }else{const out=lib.edit(current,proposed,snapshot);config=out.config;module=out.module;deleted=out.deleted}
      }catch(e){if(!e.http)e.http=422;throw e}
      const stored=await storagePut(token,config,MODULE_OBJECT,generation);if(stored.conflict)return reply(res,409,{error:'concurrent-update-retry'});
      if(deleted){const gen=await storageGeneration(token,OBJECT),pass=gen==='0'?null:await storageGet(token,OBJECT,gen);if(pass){const next=lib.windowConfig(pass,[],config.deleted),saved=await storagePut(token,next,OBJECT,gen);if(saved.conflict)return reply(res,409,{error:'module-deleted-window-reload-pending'})}}
      return reply(res,200,{accepted:true,module:module||null,results:results||null,deleted:deleted||null,generation:stored.generation});
    }
    // Server receipt controls first activation; no client can backdate rules.
    if(objectName===OBJECT)proposed.activatedAt=0;
    const token=await cloudToken();
    if(objectName===STORAGE_OBJECT){const one=await storageGet(token,ONE_OBJECT)||{},two=await storageGet(token,TWO_OBJECT)||{};Object.assign(proposed,require('./research-banks').storageConfig(proposed,one,two))}
    const stored=await storagePut(token,proposed,objectName);
    if(stored.conflict)return reply(res,409,{error:'concurrent-update-retry'});
    return reply(res,200,{accepted:true,
      sha256:hash(JSON.stringify(proposed)).toString('hex').slice(0,20),
      generation:stored.generation,
      note:'Await collector config reload; only future admissions can use new thresholds'});
  })().catch(e=>{
    if(e.http)return reply(res,e.http,{error:e.message});
    console.error('config gateway:',e.message);
    reply(res,503,{error:'server-unavailable'});
  });
}
function createServer(){return http.createServer(handler)}
if(require.main===module){
  if(!/^[a-f0-9]{64}$/i.test(SHA256))
    throw Error('SOLSCAN_CONTROL_SHA256 must be configured via Secret Manager');
  const port=Number(process.env.PORT||8080);
  createServer().listen(port,'0.0.0.0',()=>{
    console.log('SOL·СКАН owner control HTTPS gateway listening on port',port);
  });
}
module.exports={createServer,handler};
