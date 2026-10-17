'use strict';
// Read-only correctness audit for SOL·СКАН observations and research polygons.
const ROOT='https://storage.googleapis.com/sol-scan-511718-data/';
async function read(name){
  const url=ROOT+name+'?verify='+Date.now();
  const res=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(25000)});
  if(!res.ok)throw Error(name+': HTTP '+res.status);
  return res.json();
}
const [source,research,polygon,heartbeat]=await Promise.all([
  read('source/status.json'),read('research-v2/status.json'),
  read('research-v2/polygon-1.json'),read('status.json')
]);
const now=Date.now(),errors=[],warnings=[];
function check(ok,message){if(!ok)errors.push(message)}
function warn(ok,message){if(!ok)warnings.push(message)}
check(typeof source.updated==='number'&&now-source.updated<7*60_000,'source stale');
check(typeof research.updated==='number'&&now-research.updated<7*60_000,'research stale');
check(typeof heartbeat.updated==='number'&&now-heartbeat.updated<7*60_000,'collector heartbeat stale');
check(research.status==='observational','research status malformed');
check(research.bankCapacityPerClass===5000,'wrong polygon capacity');
check(research.secondLevel==='waiting-for-server-verified-passed-stream','second-level status hidden or mislabeled');
const config=research.settings||{},counts=research.counts||{};
check(config.hours>=1&&config.hours<=24,'research hours outside 1–24');
check(typeof counts.live==='number'&&typeof counts.dead==='number','counters absent');
check(Array.isArray(polygon.coins),'polygon data not an array');
const labeled=new Map(),phaseCounts={before:{live:0,dead:0},after:{live:0,dead:0}};
for(const row of polygon.coins||[]){
  check(typeof row.mint==='string'&&row.mint.length>=32,'malformed mint');
  check(!labeled.has(row.mint),'duplicate labeled mint');
  labeled.set(row.mint,true);
  const predicted=row.activePct>=config.minActive&&row.maxIdleObserved<=config.maxIdle?'live':'dead';
  check(row.label===predicted,'incorrect activity labeling '+row.mint);
  check(row.coverage>=config.minCoverage,'label from insufficient coverage '+row.mint);
  check(row.decisionAt-row.acceptedAt===config.decisionMinutes*60000,'decision clock mismatch '+row.mint);
  check(row.acceptedAt<=now-config.hours*3600_000,'label before observation finished '+row.mint);
  check(row.label==='live'||row.label==='dead','unknown label in polygon');
  check(row.features&&typeof row.features==='object','missing frozen green-zone features');
  if(row.phase in phaseCounts)phaseCounts[row.phase][predicted]++;
  else check(false,'unknown phase');
}
const countLive=phaseCounts.before.live+phaseCounts.after.live,
  countDead=phaseCounts.before.dead+phaseCounts.after.dead;
check(countLive===counts.live&&countDead===counts.dead,'bank count mismatch');
check(countLive<=5000&&countDead<=5000,'polygon over 5000 per class');
check(source.total>=countLive+countDead,'research has more classified rows than detected tokens');
if(source.total>0&&counts.live+counts.dead===0)
  warnings.push('Nothing labeled yet: waiting for complete five-hour observation windows and coverage');
const metrics={
  at:new Date(now).toISOString(),
  source:{total:source.total,today:source.today,preConnected:source.preConnected},
  research:{updated:research.updated,settings:config,counts,pending:research.pending},
  polygon:{rows:labeled.size,live:countLive,dead:countDead,byPhase:phaseCounts},
  warnings,errors
};
console.log(JSON.stringify(metrics,null,2));
if(errors.length)process.exitCode=1;
