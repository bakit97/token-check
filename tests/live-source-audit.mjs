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
let raw=null, obs=null;
try{raw=await get('day/'+day+'.json')}catch(e){console.error('Candidate day feed unavailable:',e.message)}
try{obs=await get('obs/'+day+'.json')}catch(e){console.error('Observation archive unavailable:',e.message)}
const sourceByMint=new Map(today.coins.map(c=>[c.a,c]));
const candidates=new Map((raw?.coins||[]).map(c=>[c.a,c]));
const observations=new Map((obs?.coins||[]).map(c=>[c.a,c]));
const coverage={
  before:{count:0,candidate:0,priceHistory:0,tradeHistory:0,preHistoric:0,noCandidate:0},
  after:{count:0,candidate:0,priceHistory:0,tradeHistory:0,preHistoric:0,noCandidate:0}
};
const examplesNoHistory=[];
for(const [id,entry] of sourceByMint){
  const group=coverage[entry.phase];
  if(!group)continue;
  group.count++;
  const c=candidates.get(id),ob=observations.get(id);
  if(!c){group.noCandidate++;if(examplesNoHistory.length<8)examplesNoHistory.push(id);continue}
  group.candidate++;
  const ds=[...(c.ds||[]),...(ob?.ds||[])];
  if(ds.some(d=>Number(d[1])>0))group.priceHistory++;
  if(ds.some(d=>d[4]!=null&&d[5]!=null&&d[6]!=null))group.tradeHistory++;
  if(c.preObs&&Array.isArray(c.preObs.ds)&&c.preObs.ds.length)group.preHistoric++;
}
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
const candidateTotal=coverage.before.candidate+coverage.after.candidate;
if(st.today>0&&candidateTotal===0)
  errors.push('no admitted source records have corresponding candidate data');

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
  sample,candidateCoverage:coverage,exampleMissingCandidates:examplesNoHistory,checksFailed:errors},null,2));
if(errors.length){console.error('FIELD AUDIT FAILED: '+errors.join(' | '));process.exitCode=1}
