'use strict';
// Deterministic fair scheduler for real market snapshots.
// Protects the first 12 minutes without starving already-admitted 5h cohorts.
// The collector calls this only on cohorts already due for observations.
const MIN=60000;
function sortByAttempt(rows){
  return rows.sort((a,b)=>
    (a.dsTryAt||a.dsAt||0)-(b.dsTryAt||b.dsAt||0)||
    (a.dsAt||0)-(b.dsAt||0)||
    (a.t||0)-(b.t||0)||
    String(a.a||'').localeCompare(String(b.a||'')));
}
function chooseDue(coins,{now=Date.now(),limit=1200,earlyShare=.3}={}){
  if(!Array.isArray(coins)||!Number.isInteger(limit)||limit<1||
     !Number.isFinite(now)||!Number.isFinite(earlyShare)||earlyShare<0||earlyShare>1)
    throw TypeError('Invalid snapshot scheduler input');
  const early=[],long=[];
  for(const c of coins){
    if(!c||!Number.isFinite(c.t))continue;
    const age=(now-c.t)/MIN;
    if(age<12)early.push(c);else long.push(c);
  }
  sortByAttempt(early);sortByAttempt(long);
  const reserveEarly=Math.ceil(limit*earlyShare);
  const earlyOut=early.splice(0,reserveEarly);
  const longOut=long.splice(0,Math.max(0,limit-earlyOut.length));
  // Fill spare capacity from whichever queue still has an urgent backlog.
  return earlyOut.concat(longOut,early,long).slice(0,limit);
}
module.exports={chooseDue};
