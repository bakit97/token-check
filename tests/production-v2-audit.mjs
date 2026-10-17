'use strict';
// Read-only production readiness. Fail closed on missing, stale or malformed
// server-backed study routes. Never relies on localStorage or historical UI.
const ROOT='https://storage.googleapis.com/sol-scan-511718-data/';
const required=[
 ['status.json',x=>Number.isFinite(x.updated)&&x.source?.active&&x.researchV2?.active&&x.passedV2?.active&&x.researchTwo?.active,'collector modules'],
 ['source/status.json',x=>x.mode==='verified-pre-post'&&x.preConnected===true,'source verified pre/post'],
 ['research-v2/status.json',x=>x.status==='observational'&&Number.isInteger(x.settings?.hours),'first study'],
 ['passed-v2/status.json',x=>x.serverOnly===true&&['server-observational','disabled-no-server-rules'].includes(x.status)&&x.configHash,'Passed immutable server journal'],
 ['research-v2/status-two.json',x=>x.status==='observational'&&x.origin==='server-verified-passed-only'&&x.settings?.hours===5,'second study'],
 ['research-v2/polygon-2.json',x=>Array.isArray(x.coins),'second-class bank'],
 ['research-v2/auto-1.json',x=>x.level==='1'&&Array.isArray(x.rules),'automatic level one'],
 ['research-v2/auto-2.json',x=>x.level==='2'&&Array.isArray(x.rules),'automatic level two']
];
const clock=()=>Date.now();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function read(name){
 const r=await fetch(ROOT+name+'?audit='+clock(),{
   headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error(name+' HTTP '+r.status);
 return r.json();
}
async function audit(){
 const out=await Promise.all(required.map(async ([name,validate,purpose])=>{
   const data=await read(name);
   if(!validate(data))throw Error('Invalid '+purpose+': '+name);
   if(clock()-data.updated>8*60000||data.updated>clock()+2*60000)
     throw Error('Stale or impossible timestamp '+name);
   return {name,updated:new Date(data.updated).toISOString(),ready:true};
 }));
 const [root,source,one,pass,two,polygon,auto1,auto2]=await Promise.all([
   'status.json','source/status.json','research-v2/status.json','passed-v2/status.json',
   'research-v2/status-two.json','research-v2/polygon-2.json',
   'research-v2/auto-1.json','research-v2/auto-2.json'].map(read)
 ]);
 // A disabled owner configuration is a healthy engine, not a trading signal.
 // But the observational paths must still be available and consistent.
 if(one.counts.live+one.counts.dead<0||
    two.counts.strong+two.counts.weak<0||
    !Array.isArray(polygon.coins))
   throw Error('Bad bank counts');
 if(pass.enabled===false&&pass.active>0) {
   // Existing historical signals can remain active while filters are paused.
   console.log('INFO: prior matches still in timer; no new server rules');
 }
 console.log(JSON.stringify({
   at:new Date().toISOString(),checks:out,
   source:{total:source.total,today:source.today,preConnected:source.preConnected},
   collector:{version:root.version,updated:root.updated},
   first:one.counts,passed:{enabled:pass.enabled,stored:pass.storedLast72h,active:pass.active},
   second:two.counts,auto:{first:auto1.status,second:auto2.status}
 },null,2));
}
let error=null;
for(let tries=0;tries<20;tries++){
 try{await audit();process.exit(0)}
 catch(e){
   error=e;
   console.log('Attempt '+(tries+1)+'/20: '+e.message);
   if(tries<19)await sleep(20000);
 }
}
console.error('Production V2 failed:',error.message);
process.exit(1);
