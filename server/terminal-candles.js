'use strict';
// One immutable terminal chart shared by both studies. Never used for live features.
const fs=require('node:fs'),path=require('node:path'),z=require('node:zlib');
const {BoundedCache}=require('./bounded-cache');
const METHOD='gt-ohlcv-20m-v1',MIN=60000,SOL='So11111111111111111111111111111111111111112';
const pack=x=>z.deflateSync(Buffer.from(JSON.stringify(x)),{level:1}).toString('base64');
const unpack=x=>JSON.parse(z.inflateSync(Buffer.from(x,'base64'),{maxOutputLength:256*1024}).toString());
const keyOf=r=>require('node:crypto').createHash('sha256').update([r.mint,r.pool,r.anchor].join('|')).digest('hex');
const startOf=anchor=>Math.ceil(anchor/MIN)*MIN;
function atomic(file,data){const tmp=file+'.tmp',fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
function chart(response,job,receivedAt,rateAt){
 const meta=response?.meta,other=meta?.base?.address===job.mint?meta.quote?.address:meta?.quote?.address===job.mint?meta.base?.address:null;
 if(!other||(job.quote&&other!==job.quote))throw Error('terminal-pool-identity-unavailable');
 const raw=response?.data?.attributes?.ohlcv_list;
 if(!Array.isArray(raw)||raw.length>1000)throw Error('terminal-chart-malformed');
 const by=new Map();
 for(const r of raw){if(!Array.isArray(r)||r.length<6||!Number.isSafeInteger(r[0])||r[0]%60||r.slice(1,6).some(v=>!Number.isFinite(v)||v<0))throw Error('terminal-chart-malformed');const prior=by.get(r[0]);if(prior){if(JSON.stringify(prior)===JSON.stringify(r))continue;const same=(a,b)=>Math.abs(a-b)<=Math.max(Math.abs(a),Math.abs(b),1e-30)*1e-10;let first,last;if(same(prior[4],r[1])){first=prior;last=r;}else if(same(r[4],prior[1])){first=r;last=prior;}else throw Error('terminal-chart-malformed');by.set(r[0],[r[0],first[1],Math.max(prior[2],r[2]),Math.min(prior[3],r[3]),last[4],prior[5]+r[5]]);}else by.set(r[0],r);}
 if(raw.length>=job.limit&&raw.length&&Math.min(...raw.map(r=>r[0]))*1000>job.start)throw Error('terminal-chart-truncated');
 if(receivedAt<job.end)throw Error('terminal-window-not-finished');
 const rows=[];let close=null,missingRates=0;
 // include_empty_intervals=true + successful pool identity proves zero-volume gaps.
 for(let t=job.start;t<job.end;t+=MIN){const r=by.get(t/1000);if(r&&t+MIN<=receivedAt)close=r[4]>0?r[4]:close;const volume=r?r[5]:0,rate=rateAt(t+MIN);
  const volumeSol=job.quote===SOL?volume:volume===0?0:rate>0?volume/rate:null;
  const priceUsd=job.quote===SOL?close>0&&rate>0?close*rate:null:close;
  if(volumeSol==null)missingRates++;rows.push([t+MIN,volumeSol,priceUsd,r?.[1]??close,r?.[2]??close,r?.[3]??close,r?.[4]??close]);}
 return {schema:2,method:METHOD,mint:job.mint,pool:job.pool,anchor:job.anchor,start:job.start,end:job.end,receivedAt,knownPool:true,empty:raw.length===0,currency:job.quote===SOL?'token':'usd',quote:job.quote,priceUnit:'USD',volumeUnit:'SOL-equivalent',nativeVolume:job.quote===SOL,missingRates,minutesPacked:pack(rows)};
}
function classify(evidence,cfg={}){
 if(!evidence?.knownPool||evidence.method!==METHOD)return {label:'unknown',why:evidence?.reason||'terminal-chart-awaiting-retry'};
 const end=evidence.start+(cfg.hours??5)*60*MIN;if(evidence.end<end)return {label:'unknown',why:'terminal-chart-window-mismatch'};
 const rows=unpack(evidence.minutesPacked).filter(r=>r[0]>evidence.start&&r[0]<=end),n=(end-evidence.start)/MIN,totalSlices=Math.ceil(n/10),volumes=Array(totalSlices).fill(0);
 if(rows.length!==n||rows.some(r=>!Number.isFinite(r[1])||r[1]<0))return {label:'unknown',why:'terminal-sol-conversion-missing',totalSlices};
 for(let i=0;i<rows.length;i++)volumes[Math.floor(i/10)]+=rows[i][1];
 const turbulent=cfg.sliceRuleVersion===2||(cfg.sliceRuleVersion==null&&['minSliceRangePct','minGreenCandles','minRedCandles'].some(k=>cfg[k]!=null));
 if(turbulent&&evidence.schema!==2)return {label:'unknown',why:'terminal-ohlc-required'};
 const slices=volumes.map((volume,i)=>{const part=rows.slice(i*10,(i+1)*10),priced=part.filter(r=>r.length>=7&&r.slice(3,7).every(Number.isFinite)&&r[5]>0),low=priced.length?Math.min(...priced.map(r=>r[5])):null,high=priced.length?Math.max(...priced.map(r=>r[4])):null,green=priced.filter(r=>r[6]>r[3]).length,red=priced.filter(r=>r[6]<r[3]).length,rangePct=low>0?100*(high-low)/low:0;
  return {volumeSol:volume,open:priced[0]?.[3]??null,close:priced.at(-1)?.[6]??null,high,low,green,red,rangePct,active:volume+1e-12>=(cfg.minSliceVolumeSol??.5)&&(!turbulent||(green>=(cfg.minGreenCandles??2)&&red>=(cfg.minRedCandles??2)&&rangePct+1e-12>=(cfg.minSliceRangePct??3)))};});
 const active=slices.filter(s=>s.active).length,activePct=100*active/totalSlices,live=activePct+1e-12>=(cfg.minActive??60);
 return {label:live?'live':'dead',why:live?null:turbulent?'slice-turbulence-below-threshold':'slice-volume-below-threshold',activePct,activeSlices:active,totalSlices,sliceVolumes:volumes,slices,coverage:1,maxGap:0,maxIdleObserved:null};
}
function outcome(evidence,start,cfg,now,state=null){const end=startOf(start)+(cfg.hours??5)*60*MIN;
 if(now<end+MIN)return {label:'pending',why:'not-yet-finished'};
 if(!evidence&&state?.readyAt>now)return {label:'pending',why:'waiting-shared-terminal-window'};
 if(!evidence)return {label:'unknown',why:state?.reason||'terminal-chart-awaiting-retry',outcomeVersion:2,windowStart:startOf(start),windowEnd:end,terminalMethod:METHOD};
 const result=classify(evidence,cfg);return {...result,outcomeVersion:2,windowStart:evidence.start,windowEnd:end,terminalMethod:METHOD,terminalEvidenceId:state?.id||keyOf(evidence),terminalCandlesPacked:pack(evidence),curve:unpack(evidence.minutesPacked).filter(r=>(r[0]-evidence.start)/MIN%5===0).map(r=>[(r[0]-evidence.start)/MIN,r[2]]),minutes:[],priceKeep:null,lastHourTrades:null,lastHourWallets:null,uniqueBuyers:null};
}
function strength(evidence,lineAt,cfg,now){const end=lineAt+(cfg.hours??5)*60*MIN;if(now<end+MIN)return {label:'pending',why:'observation-window-not-finished'};
 if(!evidence?.knownPool)return {label:'pending',why:'terminal-chart-awaiting-retry'};
 if(evidence.end<end)return {label:'pending',why:'shared-terminal-window-mismatch'};
 const rows=unpack(evidence.minutesPacked);let i=-1;while(i+1<rows.length&&rows[i+1][0]<=lineAt)i++;
 const p0=rows[i]?.[2];if(!(p0>0))return {label:'pending',why:evidence.empty?'known-pool-no-price':'terminal-price-conversion-missing'};
 const minuteCurve=[],curve=[];let above=0;for(let m=1;m<=(cfg.hours??5)*60;m++){const at=lineAt+m*MIN;while(i+1<rows.length&&rows[i+1][0]<=at)i++;const price=rows[i]?.[2];if(!(price>0))return {label:'pending',why:'terminal-price-conversion-missing'};const pct=100*(price/p0-1);minuteCurve.push(pct);if(pct+1e-9>=(cfg.minAboveMarginPct??10))above++;if(m%5===0)curve.push([m,pct]);}
 const covered=minuteCurve.length,pctAbove=above/covered*100;return {label:pctAbove>=(cfg.minAbove??70)?'strong':'weak',p0,above,covered,pctAbove,curve,minuteCurve,terminalMethod:METHOD,terminalEvidenceId:keyOf(evidence)};
}
class TerminalCandles{
 constructor({dir,gt,onReady=()=>{},now=Date.now,cohortStart=0}={}){this.dir=path.join(dir,'terminal-candles-v1');fs.mkdirSync(this.dir,{recursive:true});this.file=path.join(this.dir,'ledger.json');this.gt=gt;this.onReady=onReady;this.now=now;this.busy=false;this.inFlight=new Set();this.cache=new BoundedCache({entries:256,bytes:4*1024*1024,itemBytes:256*1024,ttl:30*MIN,now});
  let saved;try{saved=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}this.jobs=new Map((saved?.jobs||[]).filter(([,j])=>now()-j.anchor<48*3600000&&j.anchor>=cohortStart));this.rates=(saved?.rates||[]).filter(r=>now()-r[0]<48*3600000);this.archivedPreviousEpoch=(saved?.jobs||[]).filter(([,j])=>j.anchor<cohortStart).length;if(this.archivedPreviousEpoch){const archive=path.join(this.dir,'ledger-archive-'+cohortStart+'.json');if(!fs.existsSync(archive))atomic(archive,{schema:1,archivedAt:now(),jobs:(saved.jobs||[]).filter(([,j])=>j.anchor<cohortStart)});}this.stats={requests:0,success:0,knownEmpty:0,errors:0,http429:0,lastError:null,sharedReads:0};
  // A durable response may precede the ledger write if the process stopped.
  for(const j of this.jobs.values()){if(j.reason==='terminal-chart-malformed'&&j.parserVersion!==2){j.nextAt=now();j.attempts=0;}j.parserVersion=2;if(j.state!=='ready'){j.nextAt=Math.max(j.nextAt||0,j.end+MIN);}if(j.state!=='ready'){try{const data=JSON.parse(fs.readFileSync(path.join(this.dir,j.key+'.json'),'utf8'));if(data.method===METHOD&&data.mint===j.mint&&data.pool===j.pool&&data.anchor===j.anchor&&data.end>=j.end){j.state='ready';j.reason=null;}}catch(e){if(e.code!=='ENOENT')throw e;}}}
 }
 save(){atomic(this.file,{schema:1,jobs:[...this.jobs],rates:this.rates});}
 observeRate(price,at=this.now()){if(!(price>1&&price<100000)||!Number.isFinite(at))return;const last=this.rates.at(-1);if(last&&at-last[0]<MIN)return;this.rates.push([at,price]);this.rates=this.rates.filter(r=>at-r[0]<48*3600000);this.save();}
 rateAt(at){for(let i=this.rates.length-1;i>=0;i--){const r=this.rates[i];if(r[0]<=at)return at-r[0]<=10*MIN?r[1]:null;}return null;}
 offer({mint,pool,anchor,quote=SOL,hours=5,lineEnd=0}){if(!mint||!pool||!Number.isSafeInteger(anchor))return;const key=keyOf({mint,pool,anchor}),start=startOf(anchor),end=Math.ceil(Math.max(start+hours*60*MIN,lineEnd)/MIN)*MIN,old=this.jobs.get(key);if(old){if(old.state!=='ready'&&end>old.end){old.end=end;old.limit=Math.ceil((end-start)/MIN)+1;old.nextAt=Math.max(old.nextAt||0,end+MIN);}return;}
  for(const [k,j] of this.jobs)if(this.now()-j.anchor>48*3600000){this.jobs.delete(k);try{fs.unlinkSync(path.join(this.dir,k+'.json'));}catch{}}
  if(this.jobs.size>=10000)return;this.jobs.set(key,{key,mint,pool,anchor,quote,start,end,limit:Math.ceil((end-start)/MIN)+1,state:'waiting',attempts:0,nextAt:end+MIN});this.save();}
 statusFor(record,pool){if(!record)return null;const j=this.jobs.get(keyOf({mint:record.mint,pool:pool||record.proof?.pool,anchor:record.acceptedAt}));return j?{id:j.key,state:j.state,dispatchAttempts:j.attempts,acceptedCharts:j.state==='ready'?1:0,reason:j.reason||null,readyAt:j.end+MIN,nextAt:j.nextAt}:null;}
 read(record,pool){if(!record)return null;const key=keyOf({mint:record.mint,pool:pool||record.proof?.pool,anchor:record.acceptedAt}),j=this.jobs.get(key);if(!j||j.state!=='ready')return null;this.stats.sharedReads++;const cached=this.cache.get(key);if(cached)return cached;const data=JSON.parse(fs.readFileSync(path.join(this.dir,key+'.json'),'utf8'));if(data.mint!==j.mint||data.pool!==j.pool||data.anchor!==j.anchor)throw Error('terminal-cache-identity');this.cache.set(key,data);return data;}
 async tick(){if(this.inFlight.size>=2)return;const j=[...this.jobs.values()].filter(j=>j.state!=='ready'&&!this.inFlight.has(j.key)&&j.end+MIN<=this.now()&&j.nextAt<=this.now()).sort((a,b)=>a.nextAt-b.nextAt)[0];if(!j)return;this.inFlight.add(j.key);this.busy=true;try{j.attempts++;this.stats.requests++;
  const response=await this.gt('/pools/'+j.pool+'/ohlcv/minute?aggregate=1&limit='+j.limit+'&currency='+(j.quote===SOL?'token':'usd')+'&token='+j.mint+'&include_empty_intervals=true&before_timestamp='+Math.floor(j.end/1000),1,'outcome:'+j.key);
  const data=chart(response,j,this.now(),at=>this.rateAt(at));atomic(path.join(this.dir,j.key+'.json'),data);this.cache.set(j.key,data);j.state='ready';j.reason=null;this.onReady(j);this.stats.success++;if(data.empty)this.stats.knownEmpty++;this.stats.lastError=null;
 }catch(e){const limited=e.rl||/429/.test(e.message||'');if(limited)this.stats.http429++;this.stats.errors++;j.lastHttp=e.status||null;j.reason=limited?'terminal-rate-limited':e.status===404?'terminal-pool-not-indexed':/^terminal-[a-z-]+$/.test(e.message||'')?e.message:'terminal-provider-unavailable';j.state='retry';j.nextAt=this.now()+Math.min(60*MIN,5*MIN*2**Math.min(j.attempts-1,4));this.stats.lastError=j.reason;
 }finally{this.inFlight.delete(j.key);this.save();this.busy=this.inFlight.size>0;}}
 summary(){const jobs=[...this.jobs.values()];return {method:METHOD,...this.stats,busy:this.busy,queued:jobs.filter(j=>j.state!=='ready').length,archivedPreviousEpoch:this.archivedPreviousEpoch,ready:jobs.filter(j=>j.state==='ready').length,due:jobs.filter(j=>j.state!=='ready'&&j.nextAt<=this.now()).length,oldestDueMs:Math.max(0,...jobs.filter(j=>j.state!=='ready'&&j.end<this.now()).map(j=>this.now()-j.end)),inFlight:this.inFlight.size,problems:jobs.filter(j=>j.state!=='ready'&&j.end<this.now()).slice(0,100).map(j=>({mint:j.mint,pool:j.pool,state:j.state,attempts:j.attempts,reason:j.reason||'queued-not-attempted',httpStatus:j.lastHttp||null,nextAt:j.nextAt,end:j.end})),rates:this.rates.length,cache:this.cache.summary(),normalRequestsPerCoin:1,sharedBy:['R1','R2'],retryReasons:Object.fromEntries([...new Set(jobs.map(j=>j.reason).filter(Boolean))].map(k=>[k,jobs.filter(j=>j.reason===k).length]))};}
}
module.exports={METHOD,TerminalCandles,chart,classify,outcome,strength,pack,unpack,startOf};
