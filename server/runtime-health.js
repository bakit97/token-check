'use strict';
const v8=require('node:v8');
class RuntimeHealth{
 constructor({now=Date.now,memory=()=>process.memoryUsage()}={}){this.now=now;this.memory=memory;this.peak=0;this.windowPeak=0;this.phases={};this.lagMs=0;this.maxLagMs=0;this.activeUploads=0;this.uploadsHour=[];this.capture('init')}
 capture(stage,details={}){const m=this.memory(),rssMB=m.rss/1e6;this.peak=Math.max(this.peak,rssMB);this.windowPeak=Math.max(this.windowPeak,rssMB);
  if(stage){const previous=this.phases[stage];this.phases[stage]={at:this.now(),rssMB:+rssMB.toFixed(1),heapUsedMB:+(m.heapUsed/1e6).toFixed(1),externalMB:+(m.external/1e6).toFixed(1),...details,peakMB:Math.max(previous?.peakMB||0,rssMB)};}
  return m;
 }
 summary(structures){const m=this.capture(),at=this.now();this.uploadsHour=this.uploadsHour.filter(x=>x>at-3600000);
  const result={at,rssMB:+(m.rss/1e6).toFixed(1),heapUsedMB:+(m.heapUsed/1e6).toFixed(1),heapTotalMB:+(m.heapTotal/1e6).toFixed(1),externalMB:+(m.external/1e6).toFixed(1),arrayBuffersMB:+((m.arrayBuffers||0)/1e6).toFixed(1),heapLimitMB:+(v8.getHeapStatistics().heap_size_limit/1e6).toFixed(1),rssPeakMB:+this.peak.toFixed(1),rssPeakMinuteMB:+this.windowPeak.toFixed(1),lagMs:this.lagMs,maxLagMs:this.maxLagMs,activeUploads:this.activeUploads,uploadsHour:this.uploadsHour.length,structures,phases:this.phases};
  this.windowPeak=m.rss/1e6;this.maxLagMs=this.lagMs;return result;
 }
}
function structureCounts({C,wsSeen,RPC_CACHE,gtQ,UPQ,PRE,SOURCE,RESEARCH_V2,RESEARCH_TWO,PASS_V2,OLD_RESEARCH_ONE=[],OLD_RESEARCH_TWO=[],FILTER_AUDIT,crLog=[],now=Date.now()}){
 const c={size:C.size,ageUnder2h:0,age2to24h:0,age24to50h:0,ageOver50h:0,dsRows:0,vaultRows:0,candles:0,tradeRows:0,rawStates:0,rawBase64Chars:0,origPools:0};
 for(const x of C.values()){const age=now-x.t;if(age<7200000)c.ageUnder2h++;else if(age<86400000)c.age2to24h++;else if(age<180000000)c.age24to50h++;else c.ageOver50h++;
  c.dsRows+=x.ds?.length||0;c.vaultRows+=x.lq?.length||0;c.candles+=(x.path?.c?.length||0)+(x.gx?.length||0);c.tradeRows+=x.tr?.x?Object.keys(x.tr.x).length:0;c.origPools+=x.origs?.length||0;
  for(const raw of Object.values(x.raw||{})){c.rawStates++;for(const b of raw.b||[])if(typeof b==='string')c.rawBase64Chars+=b.length;}
 }
 const bank=b=>({rows:b?.rows?.length||0,processed:b?.processed?.size||0,lookup:b?.lookup?.size||0,retry:b?.retry?.size||0,lastAttemptAt:b?.lastAttemptAt?.size||0,journalCount:b?.journalCount||0});
 return {C:c,wsSeen:wsSeen.size,rpcCache:RPC_CACHE.size,queues:{gt:gtQ.length,uploads:UPQ.length,pre:PRE?.queue?.length||0,prePending:PRE?.pending?.size||0,preSeen:PRE?.seenSignatures?.size||0},banks:{one:bank(RESEARCH_V2),two:bank(RESEARCH_TWO),oldOne:OLD_RESEARCH_ONE.map(x=>bank(x.runtime)),oldTwo:OLD_RESEARCH_TWO.map(x=>bank(x.runtime))},journals:{sourceRecords:SOURCE?.records?.size||0,sourceRecent:SOURCE?.recent?.size||0,sourceGateAccepted:SOURCE?.gate?.accepted?.size||0,passedRecords:PASS_V2?.records?.size||0,auditVersions:FILTER_AUDIT?.versions?.size||0,rpcHour:crLog.length}};
}
module.exports={RuntimeHealth,structureCounts};
