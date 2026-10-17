'use strict';
// Continuous read-only field audit; never buys/sells tokens or writes to GCP.
const ORIGIN='https://storage.googleapis.com/sol-scan-511718-data/';
const now=Date.now();
const day=new Date(now+5*3600e3).toISOString().slice(0,10);
const pathList=['source/status.json','source/live.json','source/day/'+day+'.json','status.json'];
async function get(path){
  const resp=await fetch(ORIGIN+path+'?audit='+Date.now(),{signal:AbortSignal.timeout(30000),cache:'no-store'});
  if(!resp.ok)throw Error(path+': HTTP '+resp.status);
  return resp.json();
}
const [st,live,today,heartbeat]=await Promise.all(pathList.map(get));
const errors=[];
function check(cond,msg){if(!cond)errors.push(msg)}
const settings=st.settings||{},pre=st.pre||{};
const ageMax={before:settings.beforeMinutes,after:settings.afterMinutes};
check(['verified-pre-post','verified-post-only'].includes(st.mode),'unknown source mode');
check(now-st.updated<7*60_000,'source stale >7 minutes');
check(now-heartbeat.updated<7*60_000,'collector heartbeat stale >7 minutes');
check(st.mode!=='verified-pre-post'||st.preConnected===true,'Pump create logs subscription not acknowledged');
check([settings.beforeMinutes,settings.afterMinutes].every(n=>Number.isInteger(n)&&n>=1&&n<=10),'age filter malformed');
check(Array.isArray(live.coins),'no source/live coins');
check(Array.isArray(today.coins),'no source/day coins');
const seen=new Set(),sample=[],counts={before:0,after:0};
for(const coin of today.coins||[]){
  check(!seen.has(coin.a),'mint appears twice in source/day');
  seen.add(coin.a);
  if(coin.phase in counts)counts[coin.phase]++;
  else check(false,'unexpected phase '+coin.phase);
  check(coin.acceptedAt>=coin.eventAt,'acceptance before event');
  const minutes=(coin.acceptedAt-coin.eventAt)/60_000;
  check(minutes>=0&&minutes<=(ageMax[coin.phase]||0)+.0001,'age window violated for '+coin.a);
  check(coin.a&&typeof coin.a==='string'&&coin.a.length>=32,'bad mint');
  if(sample.length<6&&coin.phase==='before')sample.push({
    mint:coin.a,minutes:+minutes.toFixed(2),family:coin.family,tx:coin.proofSig});
}
check(st.day===today.day,'daily source day mismatch');
check(st.today===today.count,'daily main source count != archive count');
check(today.coins?.length===today.count,'archive count mismatch');
check(counts.before===st.todayBefore,'daily before count mismatch');
check(counts.after===st.todayAfter,'daily after count mismatch');
if(live.coins){check(live.coins.length<=200,'latest feed too large');}
if(st.mode==='verified-pre-post') {
  check(Number.isFinite(pre.logs),'pre raw logs metrics unavailable');
  check(Number.isFinite(pre.createLogs),'pre create metrics unavailable');
  // Counters cover the process lifespan and may span midnight; do not compare to today's totals.
}
console.log(JSON.stringify({runAt:new Date().toISOString(),day,
  mode:st.mode,preConnected:st.preConnected,
  heartbeatAgeSec:Math.round((now-heartbeat.updated)/1000),
  sourceAgeSec:Math.round((now-st.updated)/1000),
  total:st.total,today:st.today,byPhase:counts,
  pre:{logs:pre.logs,createLogs:pre.createLogs,processed:pre.processed,
    accepted:pre.accepted,late:pre.late,errors:pre.errors,untradeable:pre.untradeable,
    dropped:pre.dropped,queue:pre.queue,queuePeak:pre.queuePeak},
  sample,checksFailed:errors},null,2));
if(errors.length){console.error('FIELD AUDIT FAILED: '+errors.join(' | '));process.exitCode=1}
