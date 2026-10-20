if(typeof WebSocket==='undefined'&&!process.env.WSX){const ch=require('child_process').spawn(process.execPath,['--experimental-websocket','--max-old-space-size=600',__filename],{stdio:'inherit',env:{...process.env,WSX:'1'}});
  ['SIGTERM','SIGINT'].forEach(sg=>process.on(sg,()=>ch.kill(sg)));ch.on('exit',code=>process.exit(code??0))}else{
'use strict';
/* SOL·СКАН — сборщик. Круглосуточно записывает все новые пулы Solana:
   вид запуска (точная проверка миграции по блокчейну), контракт токена, снимки на 1/3/5/10 минуте,
   активность каждые 5 минут в течение 5 часов, свечи первых 10 минут и итог за 5 часов.
   Каждые 2 минуты выгружает перепись дня (по Алматы, с 00:00) в Cloud Storage. */
const fs=require('fs'),zlib=require('zlib');
let HEALTH=null,PROFILES=null;
let COMPLETED=null,ACTIVE_HISTORY=null,OBS_RECOVERY=null,RECOVERY_RPC=null;
const fullCoin=c=>ACTIVE_HISTORY?ACTIVE_HISTORY.hydrate(c):c;
const PUBLIC_FEEDS={busy:false,sourceAt:0,libraryAt:0,storageAt:0,error:''},RESEARCH_EXPORTS={busy:false,oneAt:0,twoAt:0,error:''};let SOURCE_DAY_PUBLISHED_AT=0;
const RETENTION={activeHours:26,rejectedHours:2,stateTargetBytes:30000000,stateBytes:0,lastSweepAt:null,removed:0,protectedResearch:0,pendingRaw:0,pendingWork:0,cancelledGT:0};
let RESOURCE=null,FAST_DISCOVERY=null,POOL_DISCOVERY=null,POOL_LOGS=null;const POOL_TRANSITION={mode:'pools-v1',legacySourceRemoved:0,legacyDataCleanupPending:true};
const resourcePressure=()=>process.memoryUsage().rss>=360*1024*1024;
const BUCKET='sol-scan-511718-data',DIR=process.env.SOLSCAN_DIR||'/var/solscan',TZ=5*3600e3;
const GT='https://api.geckoterminal.com/api/v2/networks/solana',DS='https://api.dexscreener.com';
const VERSION=(process.env.CODE_GEN||'dev').replace(/[^0-9a-z]/g,'')||'dev';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=(...a)=>console.log(new Date().toISOString(),...a);
const ERR=[];function err(m){ERR.push(new Date().toISOString()+' '+m);if(ERR.length>30)ERR.shift();log('ERR',m)}

/* ---------- pump.fun: канонический пул миграции (тот же расчёт, что на сайте) ---------- */
const B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58dec(s){let n=0n;for(const ch of s){const i=B58.indexOf(ch);if(i<0)throw new Error('base58');n=n*58n+BigInt(i)}
  const out=[];while(n>0n){out.push(Number(n&255n));n>>=8n}for(const ch of s){if(ch==='1')out.push(0);else break}return new Uint8Array(out.reverse())}
function b58enc(b){let n=0n;for(const x of b)n=(n<<8n)+BigInt(x);let s='';while(n>0n){s=B58[Number(n%58n)]+s;n/=58n}for(const x of b){if(x===0)s='1'+s;else break}return s}
const EP=(1n<<255n)-19n,emod=a=>((a%EP)+EP)%EP;
function epow(b,e){let r=1n;b=emod(b);while(e>0n){if(e&1n)r=r*b%EP;b=b*b%EP;e>>=1n}return r}
const ED=emod(-121665n*epow(121666n,EP-2n));
function onCurve(bytes){let y=0n;for(let i=31;i>=0;i--)y=(y<<8n)+BigInt(bytes[i]);y&=(1n<<255n)-1n;if(y>=EP)return false;
  const y2=y*y%EP,u=emod(y2-1n),v=emod(ED*y2+1n),v3=v*v%EP*v%EP,v7=v3*v3%EP*v%EP;let x=u*v3%EP*epow(u*v7%EP,(EP-5n)/8n)%EP;
  const vx2=v*x%EP*x%EP;return vx2===u||vx2===emod(-u)}
async function findPDA(seeds,prog){const pb=b58dec(prog),te=new TextEncoder();
  for(let bump=255;bump>=0;bump--){const parts=[...seeds,new Uint8Array([bump]),pb,te.encode('ProgramDerivedAddress')];
    const buf=new Uint8Array(parts.reduce((s,p)=>s+p.length,0));let o=0;parts.forEach(p=>{buf.set(p,o);o+=p.length});
    const h=new Uint8Array(await crypto.subtle.digest('SHA-256',buf));if(!onCurve(h))return b58enc(h)}throw new Error('no PDA')}
const PUMP='6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',PUMP_AMM='pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
// mint authority pump.fun (PDA 'mint-authority'): есть только в create/create_v2, а не в каждой сделке
const PUMP_MINT_AUTH=process.env.PUMP_MINT_AUTH||'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
const WSOL='So11111111111111111111111111111111111111112',USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',USDT='Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
async function canonicalPoolOf(mint,quote){const te=new TextEncoder();const auth=await findPDA([te.encode('pool-authority'),b58dec(mint)],PUMP);
  return findPDA([te.encode('pool'),new Uint8Array([0,0]),b58dec(auth),b58dec(mint),b58dec(quote)],PUMP_AMM)}
const bondingCurveOf=mint=>findPDA([new TextEncoder().encode('bonding-curve'),b58dec(mint)],PUMP);

/* ---------- Meteora: выпускники DBC попадают в DAMM v1/v2 по адресу из официальных миграционных конфигов ---------- */
const DBC='dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',DAMM1='Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',DAMM2='cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const DAMM1_CFG=['8f848CEy8eY6PhJ3VcemtBDzPPSD4Vq7aJczLZ3o8MmX','HBxB8Lf14Yj8pqeJ8C4qDb5ryHL7xwpuykz31BLNYr7S','7v5vBdUQHTNeqk1HnduiXcgbvCyVEZ612HLmYkQoAkik','EkvP7d5yKxovj884d2DwmBQbrHUWRLGK6bympzrkXGja','9EZYAJrcqNWNQzP2trzZesP7XKMHA1jEomHzbRsdX8R2','8cdKo87jZU2R12KY1BUjjRPwyjgdNjLGqSGQyrDshhud'];
const DAMM2_CFG=['7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd','2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k','Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp','2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq','AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD','DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u','A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck'];
function cmpB(a,b){for(let i=0;i<32;i++){if(a[i]!==b[i])return a[i]-b[i]}return 0}
function orderKeys(x,y){const a=b58dec(x),b=b58dec(y);return cmpB(a,b)>0?[a,b]:[b,a]} // как getFirstKey/getSecondKey в SDK Meteora
async function isDbcGraduate(owner,pool,mint,quote){if(!quote)return false;const [k1,k2]=orderKeys(mint,quote),te=new TextEncoder();
  if(owner===DAMM2){for(const cfg of DAMM2_CFG)if(await findPDA([te.encode('pool'),b58dec(cfg),k1,k2],DAMM2)===pool)return true}
  if(owner===DAMM1){for(const cfg of DAMM1_CFG)if(await findPDA([k1,k2,b58dec(cfg)],DAMM1)===pool)return true}
  return false}
/* ---------- Raydium LaunchLab: запись монеты PDA("pool",mint,quote), статус и кошелёк миграции из конфига ---------- */
const LAUNCH='LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',CPMM='CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',AMM4='675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const launchPoolOf=(mint,quote)=>findPDA([new TextEncoder().encode('pool'),b58dec(mint),b58dec(quote)],LAUNCH);
const META='metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const metadataOf=mint=>findPDA([new TextEncoder().encode('metadata'),b58dec(META),b58dec(mint)],META);
const T22='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/* ---------- сеть: GeckoTerminal (бесплатно ≈10/мин, на деле меньше) — общая очередь с подстройкой скорости ---------- */
async function getJSON(url){const r=await fetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(30000)});if(r.status===429){const e=new Error('429');e.rl=1;throw e}
  if(!r.ok)throw new Error('HTTP '+r.status+' '+url.split('?')[0].slice(-60));return r.json()}
// приоритеты: 0 новые пулы, 1 сделки первых минут, 2 свечи первых 10 минут, 3 график цены
const gtQ=[];let gtPause=0,gtOK=0,gtFail=0,gtSp=6500,gtRun=0;
const GT_BACKGROUND_LIMIT=24; // keep slow multi-hour charts from burying early trading evidence
const gtBackgroundBusy=()=>gtQ.filter(x=>x.prio===3).length>=GT_BACKGROUND_LIMIT;const gtLog=[]; // gtLog: [время, 1=ок/0=429/2=ошибка, задержка в очереди мс]
function gtPending(key){return gtQ.some(x=>x.key===key)}
function gt(path,prio,key,windowEnd){key=key||path;const ex=gtQ.find(x=>x.key===key);if(ex)return ex.p;
  let res,rej;const p=new Promise((a,b)=>{res=a;rej=b});gtQ.push({path,prio,res,rej,t:Date.now(),key,p,windowEnd});gtQ.sort((a,b)=>a.prio-b.prio||a.t-b.t);return p}
(async function gtLoop(){for(;;){if(gtQ.length&&Date.now()>gtPause){for(const q of gtQ)if(q.windowEnd&&Date.now()>q.windowEnd)q.prio=3;gtQ.sort((a,b)=>a.prio-b.prio||a.t-b.t);const t=gtQ.shift();
    try{const j=await getJSON(GT+t.path);gtOK++;gtLog.push([Date.now(),1,Date.now()-t.t]);if(++gtRun>=20){gtRun=0;gtSp=Math.max(6000,gtSp-250)}t.res(j)}
    catch(e){gtFail++;gtLog.push([Date.now(),e.rl?0:2,Date.now()-t.t]);if(e.rl){gtPause=Date.now()+30e3;gtSp=Math.min(15000,gtSp+500);gtRun=0;
        if(t.prio<=2&&!t.retry){t.retry=1;gtQ.unshift(t);continue}}t.rej(e)}
    while(gtLog.length&&gtLog[0][0]<Date.now()-3600e3)gtLog.shift()}
  await sleep(gtSp)}})();
function gtStats(){const ok=gtLog.filter(x=>x[1]===1),rl=gtLog.filter(x=>x[1]===0).length,lat=ok.map(x=>x[2]).sort((a,b)=>a-b);
  return{queue:gtQ.length,backgroundLimit:GT_BACKGROUND_LIMIT,oldestSec:gtQ.length?Math.round((Date.now()-Math.min(...gtQ.map(x=>x.t)))/1000):0,okHour:ok.length,r429Hour:rl,errHour:gtLog.filter(x=>x[1]===2).length,
    spacingMs:gtSp,waitMedSec:lat.length?Math.round(lat[lat.length>>1]/1000):null,waitMaxSec:lat.length?Math.round(lat[lat.length-1]/1000):null,
    byPrio:[0,1,2,3].map(p=>gtQ.filter(x=>x.prio===p).length)}}

/* ---------- Solana RPC (Helius). Ключ лежит в метаданных сервера, не в коде ---------- */
let HKEY='';async function heliusKey(){if(HKEY)return HKEY;try{const r=await fetch('http://metadata.google.internal/computeMetadata/v1/instance/attributes/helius-key',{headers:{'Metadata-Flavor':'Google'}});if(r.ok)HKEY=(await r.text()).trim()}catch{}return HKEY}
let rpcN=0,rpcFail=0,rpcCredits=0,rpcBusy=Promise.resolve();const crLog=[];const RPCCTX={};let CTX='?';
const RPC_CACHE=new Map();
async function rpc(method,params,options={}){
  if(!RESOURCE)throw Object.assign(new Error('Helius accounting unavailable'),{code:'BUDGET_DEFERRED'});
  const context=options.context||CTX,priority=options.priority??({'миграция':'migration','кривые':'migration','сверка':'reconcile','пулы':'pools','держатели':'holders','контракт':'metadata','новые до миграции':'pre'}[context]||'background'),source=options.source||context;
  const cacheable=options.cache!==false&&['getTransaction','getSignaturesForAddress','getProgramAccounts','getSlot'].includes(method);
  const cacheKey=cacheable?method+JSON.stringify(params):null,cached=RPC_CACHE.get(cacheKey);
  if(cached&&cached.until>Date.now())return cached.value;
  const key=await heliusKey();if(!key)throw new Error('нет ключа Helius');
  // No FIFO of sleeping calls: old background jobs cannot delay fresh proofs.
  if(!RESOURCE.allow(require(DIR+'/resource-budget.js').rpcCost(method),priority)){RESOURCE.deferred(source);throw Object.assign(new Error('Helius budget: observation deferred'),{code:'BUDGET_DEFERRED',retryAfterMs:RESOURCE.retryAfterMs?.()||5000})}
  const go=async()=>{for(let t=0;t<3;t++){
      const cr=RESOURCE.reserveRPC(method,priority,source); // charge BEFORE fetch, including failures/retries
      rpcN++;rpcCredits+=cr;crLog.push([Date.now(),cr,method]);RPCCTX[context]=(RPCCTX[context]||0)+cr;
      while(crLog.length&&crLog[0][0]<Date.now()-3600e3)crLog.shift();
      const r=await fetch('https://mainnet.helius-rpc.com/?api-key='+key,{signal:AbortSignal.timeout(30000),method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      if(r.status===429){await sleep(1500*(t+1));continue}if(!r.ok)throw new Error('rpc HTTP '+r.status);const d=options.maxBytes?await require(DIR+'/early-intelligence.js').readBoundedJSON(r,options.maxBytes):await r.json();if(d.error)throw new Error('rpc '+d.error.message);
      if(cacheKey&&d.result){RPC_CACHE.delete(cacheKey);RPC_CACHE.set(cacheKey,{value:d.result,until:Date.now()+(method==='getSlot'?10000:method==='getSignaturesForAddress'?10000:5*60e3)});while(RPC_CACHE.size>128)RPC_CACHE.delete(RPC_CACHE.keys().next().value)}
      return d.result}
    throw new Error('rpc 429')};
  if(options.urgent)return go();const p=rpcBusy.then(go,go);rpcBusy=p.then(()=>sleep(150),()=>sleep(150));return p}
const globalRPC=rpc;
function budgetSource(c){return c?.discoverySource||(c?.d?.includes('dbc')||c?.d?.includes('meteora')?'dbc':c?.d?.includes('launch')?'ll':'pump')}
function rpcFor(c,context){return async(method,params)=>{const value=await rpc(method,params,{context,source:context==='миграция'?budgetSource(c):context});if(context==='миграция')c.proofProgressAt=Date.now();return value}}
const b64=s=>Uint8Array.from(Buffer.from(s||'','base64'));
const pk=(u,o)=>b58enc(u.slice(o,o+32));
// метаданные Metaplex: можно ли менять название/картинку
function metaMutable(u){try{let o=1+32+32;for(let i=0;i<3;i++){const n=u[o]|(u[o+1]<<8)|(u[o+2]<<16)|(u[o+3]<<24);o+=4+n}
    o+=2;if(u[o]===1){const n=u[o+1]|(u[o+2]<<8)|(u[o+3]<<16)|(u[o+4]<<24);o+=5+n*34}else o+=1;o+=1;return u[o]===1}catch{return null}}

/* ---------- контракт токена: 2 запроса на монету, один раз ---------- */
async function ctCheck(c){
  const rpc=rpcFor(c,'контракт');
  const mi=await rpc('getAccountInfo',[c.a,{encoding:'jsonParsed'}]);const v=mi?.value;if(!v)throw new Error('токен не найден');
  const ct=ctFromMint(v);
  ct.at=Date.now();c.ct=ct;require(DIR+'/coin-profile.js').applyMintIdentity(c,v,ct.at); // A deferred optional metadata read must not discard verified mint rights.
  if(ct.metaMut==null)try{const mv=(await rpc('getAccountInfo',[await metadataOf(c.a),{encoding:'base64'}]))?.value;if(mv?.owner===META){const bytes=b64(mv.data?.[0]);ct.metaMut=metaMutable(bytes);ct.metaMutAt=Date.now();const meta=require(DIR+'/coin-profile.js').parseMetadata(bytes);require(DIR+'/coin-profile.js').applyIdentity(c,meta,ct.metaMutAt)}}catch(e){c.metadataReason=e.code==='BUDGET_DEFERRED'?'budget-deferred':'metadata-unavailable'}
}
// разбор mint-аккаунта (jsonParsed) без запросов — общий для одиночной и пакетной проверки
function ctFromMint(v){
  if(![T22,'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'].includes(v.owner)||v.data?.parsed?.type!=='mint')throw Error('Unverified mint account');
  const info=v.data.parsed.info,ct={prog:v.owner===T22?'token2022':'token',mint:!!info.mintAuthority,freeze:!!info.freezeAuthority,dec:+info.decimals,
    supply:(+info.supply||0)/10**(+info.decimals||0),fee:0,hook:false,deleg:false,nontr:false,defFrozen:false,pause:false,metaMut:null};
  (info.extensions||[]).forEach(e=>{const s=e.state||{};
    if(e.extension==='transferFeeConfig')ct.fee=Math.max(+(s.newerTransferFee?.transferFeeBasisPoints||0),+(s.olderTransferFee?.transferFeeBasisPoints||0))/100;
    if(e.extension==='transferHook'&&s.programId)ct.hook=true;if(e.extension==='permanentDelegate'&&s.delegate)ct.deleg=true;
    if(e.extension==='nonTransferable')ct.nontr=true;if(e.extension==='defaultAccountState'&&/frozen/i.test(s.accountState||''))ct.defFrozen=true;
    if(/pausable/i.test(e.extension))ct.pause=true;if(e.extension==='tokenMetadata'){ct.metaMut=!!s.updateAuthority;ct.metaMutFromMint=true;}});
  ct.feeAuthority=(info.extensions||[]).some(e=>e.extension==='transferFeeConfig'&&!!e.state?.transferFeeConfigAuthority);
  const benign=new Set(['transferFeeConfig','transferHook','permanentDelegate','nonTransferable','defaultAccountState','pausableConfig','pausable','tokenMetadata','metadataPointer','groupPointer','groupMemberPointer','tokenGroup','tokenGroupMember']);
  ct.unknownExtensions=(info.extensions||[]).filter(e=>!benign.has(e.extension)).map(e=>e.extension);ct.safetyVersion=1;
  return ct}
/* Монеты до миграции (pump): контракт и SOL в кривой берём пачками по 100 аккаунтов за 1 запрос,
   иначе стартовые фильтры «Прошли» не видят safeContract/quoteSol и монеты до миграции не проходят никогда.
   Кривая pump: real_sol_reserves = u64 @32, complete = bool @48. Замер — только у монет перед моментом решения. */
const PRE_STATS={ct:0,curve:0,calls:0,deferred:0,errors:0};let PRE_SWEEP_BUSY=false;
async function preChainSweep(){if(PRE_SWEEP_BUSY)return;PRE_SWEEP_BUSY=true;try{await preChainSweepBody()}finally{PRE_SWEEP_BUSY=false}}
async function preChainSweepBody(){const now=Date.now(),dec=(PASS_V2?.config?.decisionMinutes||15)*60e3;
  const visible=new Set(SOURCE?.latest(200).map(r=>r.mint)||[]);
  const pre=[...C.values()].filter(c=>isRecordedPre(c)&&isCurve(c.d)&&now-(SOURCE.get(c.a)?.acceptedAt||now)<Math.max(dec+5*60e3,(require(DIR+'/research-runtime.js').phaseSettings(RESEARCH_V2?.config||{},'before').hours||5)*3600e3));
  const admitted=[...C.values()].filter(c=>SOURCE?.has(c.a)&&now-c.t<2*3600e3);
  const needCt=admitted.filter(c=>!c.ct).sort((a,b)=>(SOURCE.get(b.a)?.acceptedAt||0)-(SOURCE.get(a.a)?.acceptedAt||0)).slice(0,100);
  const needCurve=pre.filter(c=>c.p&&(!c.q||c.q===WSOL)&&now-(c.curveSol?.at(-1)?.[0]||0)>=(now-(SOURCE.get(c.a)?.acceptedAt||now)<dec+5*60e3?120e3:now-(SOURCE.get(c.a)?.acceptedAt||now)<2*3600e3?5*60e3:30*60e3)).sort((a,b)=>Number(visible.has(b.a))-Number(visible.has(a.a))||(a.curveSol?.at(-1)?.[0]||0)-(b.curveSol?.at(-1)?.[0]||0)||(SOURCE.get(b.a)?.acceptedAt||0)-(SOURCE.get(a.a)?.acceptedAt||0)).slice(0,200);
  const call=async(list,enc)=>{PRE_STATS.calls++;return (await rpc('getMultipleAccounts',[list,enc],{priority:'identity',context:'до миграции',source:'pump-card'}))?.value||[]};
  try{for(let i=0;i<needCurve.length;i+=100){const part=needCurve.slice(i,i+100),pools=part.map(c=>c.p),v=await call(pools,{encoding:'base64',dataSlice:{offset:0,length:115}}),at=Date.now();
      part.forEach((c,j)=>{const a=v[j];if(c.p!==pools[j]||!a||a.owner!==PUMP)return;const u=b64(a.data?.[0]);if(u.length<49)return;
        const bytes=Buffer.from(u);if(bytes.length>=81&&bytes.subarray(49,81).some(x=>x!==0)&&!c.creatorAddress){c.creatorAddress=pk(bytes,49);c.creatorObservedAt=at;}const lam=Number(bytes.readBigUInt64LE(32));(c.curveSol=c.curveSol||[]).push([at,lam,u[48]?1:0]);PRE_STATS.curve++})}
  }catch(e){if(e.code==='BUDGET_DEFERRED')PRE_STATS.deferred++;else{PRE_STATS.errors++;err('pre sweep '+e.message)}}  try{
    if(needCt.length){const v=await call(needCt.map(c=>c.a),{encoding:'jsonParsed'});const at=Date.now();needCt.forEach((c,j)=>{if(!v[j])return;try{const ct=ctFromMint(v[j]);ct.at=at;ct.batch=1;c.ct=ct;require(DIR+'/coin-profile.js').applyMintIdentity(c,v[j],at);PRE_STATS.ct++}catch{PRE_STATS.errors++}})}
  }catch(e){if(e.code==='BUDGET_DEFERRED')PRE_STATS.deferred++;else{PRE_STATS.errors++;err('pre contracts '+e.message)}}
  const needMeta=admitted.filter(c=>(!c.n||!c.s||(!c.i&&!c.uri))&&now-(c.metadataAttemptAt||0)>5*60e3).sort((a,b)=>b.t-a.t).slice(0,20);
  if(needMeta.length)try{const addresses=await Promise.all(needMeta.map(c=>metadataOf(c.a))),values=await call(addresses,{encoding:'base64'}),at=Date.now();needMeta.forEach((c,i)=>{c.metadataAttemptAt=at;const value=values[i];if(value?.owner!==META)return;try{const bytes=b64(value.data?.[0]);if(pk(bytes,33)!==c.a)return;const api=require(DIR+'/coin-profile.js'),meta=api.parseMetadata(bytes);api.applyIdentity(c,meta,at);if(c.ct){c.ct.metaMut=metaMutable(bytes);c.ct.metaMutAt=at;}c.metadataReason=null;}catch{c.metadataReason='metadata-invalid';}});}catch(e){if(e.code==='BUDGET_DEFERRED')PRE_STATS.deferred++;else PRE_STATS.errors++;}
}

/* ---------- миграция. Доказательство = 2 условия вместе:
   1) пул лежит по официальному адресу миграции (вычисляется из адреса монеты: PDA площадки);
   2) первая УСПЕШНАЯ транзакция пула — инструкция миграции программы-площадки, и пул создан именно в ней.
   Время миграции — время этого блока. Создатель пула — только дополнительный признак. ---------- */
const LL_CPMM_CFG=['D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2','B5u5x9S5pyaJdonf7bXUiEnBfEXsJWhNxXfLGAbRFtg2'];
const LL_AUTH='WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh',DBC_AUTH='FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
const ixd=n=>require('crypto').createHash('sha256').update('global:'+n).digest().subarray(0,8).toString('hex');
// pump.fun: migrate_v2 (bbcb121f…, видели на реальных миграциях) и старая migrate
const MIG_IX={[PUMP]:new Set([ixd('migrate_v2'),ixd('migrate')]),[LAUNCH]:new Set([ixd('migrate_to_cpswap'),ixd('migrate_to_amm')]),[DBC]:new Set([ixd('migration_damm_v2'),ixd('migrate_meteora_damm')])};
const MGV=3; // версия правил: монеты с другой версией перепроверяются (старый результат сохраняется в mg0)
const RECHECK=10*60e3;
function cmpAsc(x,y){const a=b58dec(x),b=b58dec(y);return cmpB(a,b)<0?[x,y]:[y,x]}
async function officialPools(fam,mint,quote){const te=new TextEncoder(),out=[];
  if(fam==='pump')out.push(await canonicalPoolOf(mint,quote));
  if(fam==='launch'){const [t0,t1]=cmpAsc(mint,quote);for(const cfg of LL_CPMM_CFG)out.push(await findPDA([te.encode('pool'),b58dec(cfg),b58dec(t0),b58dec(t1)],CPMM))}
  if(fam==='dbc'){const [k1,k2]=orderKeys(mint,quote);for(const cfg of DAMM2_CFG)out.push(await findPDA([te.encode('pool'),b58dec(cfg),k1,k2],DAMM2));
    for(const cfg of DAMM1_CFG)out.push(await findPDA([k1,k2,b58dec(cfg)],DAMM1))}
  return out}
const MIG_PROG={pump:PUMP,launch:LAUNCH,'launch-v4':LAUNCH,dbc:DBC};
// первая успешная транзакция пула (листаем подписи до самой старой, максимум 60 страниц)
const MIG_BLOCKS=new Map(),PROOF_FAST={slotBlocks:0,slotCacheHits:0,firstPages:0,transactionReads:0,verified:0,blockFilterOverflow:0};
async function firstOkSig(pool,rpc){
  PROOF_FAST.firstPages++;
  const page=await rpc('getSignaturesForAddress',[pool,{limit:1000,commitment:'confirmed'}]);
  if(!page?.length)return null;
  if(page.length>=1000)return {tooLong:1};
  return [...page].reverse().find(x=>!x.err)||null;
}
function verifyMigTransaction(pool,fam,curve,t,signature,blockTime,slot){
  if(!t||t.meta?.err||!t.transaction?.message)return {why:'транзакция создания недоступна'};
  const msg=t.transaction.message,keys=[...(msg.accountKeys||[]).map(k=>typeof k==='string'?k:k.pubkey),...(t.meta.loadedAddresses?.writable||[]),...(t.meta.loadedAddresses?.readonly||[])];
  const pi=keys.indexOf(pool),ci=curve?keys.indexOf(curve):-1;
  if(pi<0||t.meta.preBalances?.[pi]!==0||!(t.meta.postBalances?.[pi]>0))return {why:'транзакция не создаёт пул'};
  if(curve&&ci<0)return {why:'транзакция не ссылается на кривую'};
  const prog=MIG_PROG[fam];let hit=null;
  const check=ix=>{const program=typeof ix.programId==='string'?ix.programId:keys[ix.programIdIndex];
    if(program!==prog||!Array.isArray(ix.accounts))return;
    let d;try{d=Buffer.from(b58dec(ix.data||'1')).subarray(0,8).toString('hex')}catch{return}
    if(MIG_IX[prog]?.has(d)&&ix.accounts.includes(pi)&&(!curve||ix.accounts.includes(ci)))hit=d;
  };
  (msg.instructions||[]).forEach(check);(t.meta.innerInstructions||[]).forEach(g=>(g.instructions||[]).forEach(check));
  if(!hit)return {why:'нет инструкции миграции с пулом и кривой'};
  const seconds=t.blockTime||blockTime;if(!Number.isFinite(seconds)||seconds<=0)return {why:'нет времени блока'};
  return {ok:1,sig:signature,slot:t.slot||slot,t:seconds*1000,ix:hit};
}
function hasMigrationInstruction(t){
  if(t.meta?.err||!t.transaction?.message)return false;
  const keys=[...(t.transaction.message.accountKeys||[]).map(k=>typeof k==='string'?k:k.pubkey),...(t.meta?.loadedAddresses?.writable||[]),...(t.meta?.loadedAddresses?.readonly||[])];
  const instructions=[...(t.transaction.message.instructions||[])];for(const group of t.meta?.innerInstructions||[])instructions.push(...(group.instructions||[]));
  return instructions.some(ix=>{const prog=ix.programId||keys[ix.programIdIndex];if(!MIG_IX[prog])return false;
    try{return MIG_IX[prog].has(Buffer.from(b58dec(ix.data||'1')).subarray(0,8).toString('hex'))}catch{return false}});
}
async function migrationBlock(slot,rpc){
    let block=MIG_BLOCKS.get(slot);
    if(block)PROOF_FAST.slotCacheHits++;
    else{
      PROOF_FAST.slotBlocks++;
      const full=await rpc('getBlock',[slot,{encoding:'json',transactionDetails:'full',rewards:false,maxSupportedTransactionVersion:1,commitment:'confirmed'}]);
      if(!full?.transactions)return null;
      const transactions=[];
      for(let i=0;i<full.transactions.length;i++){
        if(hasMigrationInstruction(full.transactions[i])){if(transactions.length<128)transactions.push(full.transactions[i]);else PROOF_FAST.blockFilterOverflow++;}
        if(i%32===31)await new Promise(resolve=>setImmediate(resolve));
      }
      block={blockTime:full.blockTime,transactions};MIG_BLOCKS.set(slot,block);
      while(MIG_BLOCKS.size>4)MIG_BLOCKS.delete(MIG_BLOCKS.keys().next().value);
    }
    return block;
}
async function proveMig(pool,fam,curve,rpc,slot){
  if(Number.isSafeInteger(slot)&&slot>0){
    const block=await migrationBlock(slot,rpc);
    if(!block)return {why:'блок сигнала пока недоступен'};
    for(const tx of block.transactions){const sig=tx.transaction?.signatures?.[0];if(!sig)continue;
      const proof=verifyMigTransaction(pool,fam,curve,tx,sig,block.blockTime,slot);
      if(proof.ok){PROOF_FAST.verified++;return {...proof,method:'signal-slot-block'}};
    }
    return {why:'в блоке сигнала нет доказанной миграции этого пула',final:1};
  }
  const first=await firstOkSig(pool,rpc);
  if(!first)return {why:'у пула нет успешных транзакций'};
  if(first.tooLong)return {why:'первая страница не содержит начало истории; старую историю не листаем',tooLong:1};
  PROOF_FAST.transactionReads++;
  const t=await rpc('getTransaction',[first.signature,{encoding:'json',maxSupportedTransactionVersion:1,commitment:'confirmed'}]);
  const proof=verifyMigTransaction(pool,fam,curve,t,first.signature,first.blockTime,first.slot);
  if(proof.ok)PROOF_FAST.verified++;return proof;
}
async function launchAmmPoolsAtSlot(mint,quote,curve,slot,rpc){
  const block=await migrationBlock(slot,rpc);if(!block)return [];
  const addresses=new Set();
  for(const tx of block.transactions){const keys=[...(tx.transaction.message.accountKeys||[]).map(k=>typeof k==='string'?k:k.pubkey),...(tx.meta?.loadedAddresses?.writable||[]),...(tx.meta?.loadedAddresses?.readonly||[])];
    const ci=keys.indexOf(curve);if(ci<0)continue;
    const ixes=[...(tx.transaction.message.instructions||[])];for(const g of tx.meta?.innerInstructions||[])ixes.push(...(g.instructions||[]));
    for(const ix of ixes){if((ix.programId||keys[ix.programIdIndex])!==LAUNCH||!ix.accounts?.includes(ci))continue;
      let d;try{d=Buffer.from(b58dec(ix.data||'1')).subarray(0,8).toString('hex')}catch{continue}
      if(!MIG_IX[LAUNCH].has(d))continue;
      for(const index of ix.accounts)if(tx.meta?.preBalances?.[index]===0&&tx.meta?.postBalances?.[index]>0)addresses.add(keys[index]);
    }
  }
  const pools=[...addresses].filter(Boolean).slice(0,32);if(!pools.length)return [];
  const values=(await rpc('getMultipleAccounts',[pools,{encoding:'base64'}]))?.value||[],found=[];
  for(let i=0;i<pools.length;i++){
    const account=values[i];if(account?.owner!==AMM4)continue;
    const u=b64(account.data?.[0]);if(u.length<560||pair2(u,400,432,mint)!==quote)continue;
    // Official Raydium associated AMM PDA; marketId at offset 528.
    // raydium-io/raydium-sdk-v1/src/liquidity/liquidity.ts: getAssociatedId.
    const expected=await findPDA([b58dec(AMM4),b58dec(pk(u,528)),new TextEncoder().encode('amm_associated_seed')],AMM4);
    if(expected===pools[i])found.push(pools[i]);
  }
  return found;
}
function pair2(u,o1,o2,mint){const x=pk(u,o1),y=pk(u,o2);return x===mint?y:y===mint?x:null}
async function exists(list,rpc){if(!list.length)return[];const v=(await rpc('getMultipleAccounts',[list,{encoding:'base64',dataSlice:{offset:0,length:0}}]))?.value||[];return list.filter((x,i)=>v[i])}
const MIG_OK={pump:'pump',launch:'launch','launch-v4':'launch-v4',dbc:'dbc'};
const MIG_UNK={pump:'unk-pump',launch:'unk-launch','launch-v4':'unk-launch',dbc:'unk-dbc'};
const DEXOF={pump:'pumpswap',launch:'raydium-cpmm','launch-v4':'raydium',dbc:'meteora-damm-v2'};
function setMg(c,st,k,why,x={}){const now=Date.now(),prev=c.mg;
  c.mg={v:MGV,st,k,why:why||'',owner:x.owner||prev?.owner||'',pool:x.pool||null,sig:x.sig||null,mT:x.mT||null,ix:x.ix||null,creator:x.creator??null,watch:x.watch||null,signal:c.wsMigrationSnapshot||prev?.signal||null,final:x.final||0,
    seenAt:prev&&prev.v===MGV&&prev.st===st&&prev.k===k?prev.seenAt:now,lastAt:now,n:(prev?.v===MGV?prev.n||0:0)+1};
  c.mgH=c.mgH||[];const last=c.mgH[c.mgH.length-1];if(!last||last[1]!==k||last[2]!==st)c.mgH.push([now,k,st]);if(c.mgH.length>20)c.mgH.shift()}
// витрина монеты = официальный пул миграции; при переезде старые данные сохраняются в orig
function moveTo(c,pool,fam,r){if(c.p===pool)return;c.origs=c.origs||[];c.origs.push({p:c.p,t:c.t,d:c.d,movedAt:Date.now(),...takeObs(c)});if(c.origs.length>3)c.origs.shift();
  c.p=pool;c.d=DEXOF[fam]||c.d;c.t0=c.t0||c.t;c.t=r.t;c.movedAt=Date.now()}
async function migCheck(c){if(rejectOldProof(c))return;const rpc=rpcFor(c,'миграция');
  if(c.preCurve&&c.d==='pump-fun'){
    const poolList=await officialPools('pump',c.a,c.q||WSOL);
    for(const p of await exists(poolList,rpc)){
      const proof=await proveMig(p,'pump',await bondingCurveOf(c.a),rpc,c.migrationSlot);
      if(proof.ok){
        moveTo(c,p,'pump',proof);
        setMg(c,'ok','pump','',{pool:p,sig:proof.sig,mT:proof.t,ix:proof.ix});
        admitVerifiedMigration(c);
        return;
      }
    }
    // Curve remains active. A later official pool will trigger a recheck.
    setMg(c,'curve','curve-pump','',{final:1});
    return;
  }
  if(c.tSrc==='gt'&&c.d&&!/pump|meteora|dbc|raydium|launch|bags|stonk|believe|moon|heaven|jup/i.test(c.d)){setMg(c,'other','other:'+c.d.slice(0,12),'площадка '+c.d);return}
  const signal=c.wsMigrationSnapshot;
  const pv=signal&&signal.address===c.p&&Date.now()-signal.at<30000?{owner:signal.owner,data:[signal.data,'base64']}:(await rpc('getAccountInfo',[c.p,{encoding:'base64'}]))?.value;if(!pv)throw new Error('пул не найден');
  const owner=pv.owner,u=b64(pv.data?.[0]),mint=c.a;
  let fam=null,quote=null,cands=[],curve=null,base='manual',baseK='other',why='',creator=null,watch=null;
  if(owner===PUMP_AMM){fam='pump';baseK='manual-pump';quote=pair2(u,43,75,mint)||c.q||WSOL;curve=await bondingCurveOf(mint);cands=await officialPools('pump',mint,quote);why='не официальный адрес пула pump.fun';
    if(!cands.includes(c.p)){const b=(await rpc('getAccountInfo',[curve,{encoding:'base64',dataSlice:{offset:48,length:1}}]))?.value;if(b&&!b64(b.data?.[0])[0])watch=curve}}
  else if(owner===CPMM||owner===AMM4){fam='launch';baseK='manual-raydium';quote=owner===CPMM?pair2(u,168,200,mint):pair2(u,400,432,mint);quote=quote||c.q;
    if(owner===CPMM)creator=pk(u,40)===LL_AUTH;
    const lp=quote?await launchPoolOf(mint,quote):null;const L=lp?(await rpc('getAccountInfo',[lp,{encoding:'base64'}]))?.value:null;
    if(!L||L.owner!==LAUNCH)why='монета не с LaunchLab — обычный пул Raydium';
    else{curve=lp;const w=b64(L.data?.[0]),st=w[17],mt=w[20];
      if(st===0){why='монета ещё на кривой LaunchLab, этот пул сделан вручную';watch=lp}
      else if(st===1){base='unk';baseK='unk-launch';why='LaunchLab в процессе миграции'}
      else if(mt===1)cands=await officialPools('launch',mint,quote);
      else{fam='launch-v4';if(owner===AMM4)cands=[c.p];why='вышла в AMM v4, этот пул не её'}
      if(st===2&&!cands.includes(c.p)&&!why)why='не официальный адрес пула LaunchLab'}}
  else if(owner===DAMM1||owner===DAMM2){fam='dbc';baseK='manual-meteora';quote=owner===DAMM2?pair2(u,168,200,mint):null;
    if(!quote)for(const q of [c.q,WSOL,USDC,USDT].filter(Boolean)){if(b64(pv.data?.[0]).length&&Buffer.from(u).includes(Buffer.from(b58dec(q)))){quote=q;break}}
    if(owner===DAMM2)creator=pk(u,648)===DBC_AUTH;
    if(quote){cands=await officialPools('dbc',mint,quote);if(creator&&!cands.includes(c.p))cands.push(c.p)} // новый конфиг Meteora: решит транзакция
    why='не пул выпускника DBC'}
  else if(owner===DBC){fam='dbc';curve=c.p;
    if(!u[305]){base='curve';baseK='curve-dbc';why='торгуется на кривой DBC';watch=c.p}
    else{base='unk';baseK='unk-dbc';why='DBC завершила кривую, пул миграции ещё не найден';
      let cq=null;try{const cf=(await rpc('getAccountInfo',[pk(u,72),{encoding:'base64',dataSlice:{offset:8,length:32}}]))?.value;if(cf)cq=b58enc(b64(cf.data?.[0]))}catch(e){if(e.code==='BUDGET_DEFERRED')throw e}
      if(cq&&!c.q)c.q=cq;for(const q of [...new Set([cq,c.q,WSOL,USDC].filter(Boolean))])cands.push(...await officialPools('dbc',mint,q))}}
  else if(owner===LAUNCH){fam='launch';curve=c.p;const st=u[17],mt=u[20];quote=pk(u,237);
    if(st===0){base='curve';baseK='curve-launch';why='торгуется на кривой LaunchLab';watch=c.p}
    else{base='unk';baseK='unk-launch';why=st===1?'LaunchLab в процессе миграции':'LaunchLab завершила, пул миграции ещё не найден';
      if(st===2&&mt===1)cands=await officialPools('launch',mint,quote);
      if(st===2&&mt===0){fam='launch-v4';if(c.migrationSlot)cands=await launchAmmPoolsAtSlot(mint,quote,curve,c.migrationSlot,rpc);else{const g=await rpc('getProgramAccounts',[AMM4,{encoding:'base64',dataSlice:{offset:0,length:0},filters:[{memcmp:{offset:400,bytes:mint}}]}]);cands=(g||[]).map(x=>x.pubkey).slice(0,5)}}}}
  else{setMg(c,'other','other:'+owner.slice(0,6),'',{owner});return}
  const x={owner,creator,watch};
  // 1) этот пул — официальный?
  if(cands.includes(c.p)){const r=await proveMig(c.p,fam,curve,rpc,c.migrationSlot);
    if(r.ok){setMg(c,'ok',MIG_OK[fam],'',{...x,pool:c.p,sig:r.sig,mT:r.t,ix:r.ix});if(c.t!==r.t){c.t0=c.t0||c.t;c.t=r.t}admitVerifiedMigration(c);return}
    setMg(c,'unk',MIG_UNK[fam],r.why,{...x,final:r.tooLong||r.final?1:0});return}
  // 2) у монеты есть официальный пул в другом месте — витрина переезжает туда
  let fail=null;for(const P of await exists(cands.filter(p=>p!==c.p),rpc)){const r=await proveMig(P,fam,curve,rpc,c.migrationSlot);
    if(r.ok){moveTo(c,P,fam,r);setMg(c,'ok',MIG_OK[fam],'',{owner:'',pool:P,sig:r.sig,mT:r.t,ix:r.ix});admitVerifiedMigration(c);return}fail=fail||r}
  if(fail){setMg(c,'unk',MIG_UNK[fam],'официальный пул есть, но миграция не доказана: '+fail.why,{...x,final:fail.tooLong||fail.final?1:0});return}
  setMg(c,base,baseK,why,x)}
const MIGNAME={pump:'pump.fun → PumpSwap',dbc:'Meteora DBC → Meteora',launch:'LaunchLab → Raydium','launch-v4':'LaunchLab → Raydium',
  'curve-dbc':'Meteora DBC (кривая)','curve-launch':'LaunchLab (кривая)','manual-pump':'Пул вручную (PumpSwap)','manual-meteora':'Пул вручную (Meteora)','manual-raydium':'Пул вручную (Raydium)',
  'unk-pump':'pump.fun: миграция не подтверждена','unk-launch':'LaunchLab: миграция не подтверждена','unk-dbc':'Meteora DBC: миграция не подтверждена','unk-expired':'не подтверждена (просрочено)','unk-err':'Миграция не проверена (ошибка)'};
// кривые: раз в 10 минут одним запросом на 100 монет читаем флаг «кривая завершена» (монеты на кривой и ручные пулы монет с кривой);
// флаг сменился — полная перепроверка
function curveDone(acc){const u=b64(acc.data?.[0]);if(acc.owner===PUMP)return !!u[48];if(acc.owner===LAUNCH)return u[17]!==0;if(acc.owner===DBC)return !!u[305];return true}
async function curveSweep(){const now=Date.now();const list=[...C.values()].filter(c=>c.mg?.v===MGV&&c.mg.watch&&c.mg.k==='manual-pump'&&now-c.mg.lastAt>=115e3&&now-c.t<24*3600e3); // Meteora и LaunchLab — по подписке
  for(let i=0;i<list.length;i+=100){const part=list.slice(i,i+100);try{const v=(await rpc('getMultipleAccounts',[part.map(c=>c.mg.watch),{encoding:'base64',dataSlice:{offset:0,length:320}}],{priority:'migration',context:'кривые'}))?.value||[];
    part.forEach((c,j)=>{if(!v[j]||curveDone(v[j]))c.mg.force=1;else c.mg.lastAt=now})}catch(e){err('sweep '+e.message)}}}
function queueMigrationSignal(c,now){if(c.mg?.st==='ok')return;
  if(!c.discoverySource||c.proofExpiredAt||(c.migrationSignalAt&&c.migrationSignalAt>proofQueuedAt(c))){c.proofEnqueuedAt=now;delete c.proofExpiredAt;delete c.proofRetryAt;delete c.proofBudgetDeferredAt;delete c.proofProgressAt;if(c.mg){c.mg.force=1;c.mg.n=0}}}
function proofQueuedAt(c){return c.proofEnqueuedAt||c.firstPostSeenAt||c.wsSeen||c.rcSeen||c.seen||c.t}
function expireProofs(now=Date.now()){for(const c of C.values())if(!(c.mg?.st==='ok'&&c.mg.v===MGV)&&!c.preCurve&&!c.proofExpiredAt&&now-proofQueuedAt(c)>2*3600e3){
  c.proofExpiredAt=now;delete c.proofProgressAt;delete c.proofBudgetDeferredAt;delete c.proofRetryAt;
  setMg(c,'unk','unk-expired','не подтверждена (просрочено)',{final:1});}}
function proofEventAge(c,now){
  const slot=EVENT_CLOCK?.estimate(c.migrationSlot,now);
  if(slot)return slot;
  if(c.tSrc==='gt'&&Number.isFinite(c.t))return {at:c.t,ageMs:Math.max(0,now-c.t),source:'gt-pool-created'};
  const at=c.migrationSignalAt||proofQueuedAt(c);
  return Number.isFinite(at)?{at,ageMs:Math.max(0,now-at),source:'queue-wait'}:null;
}
function rejectOldProof(c,now=Date.now()){
  if(c.proofExpiredAt||isOk(c)||c.preCurve||SOURCE?.has(c.a))return false;
  const age=proofEventAge(c,now),limit=(SOURCE?.settings().afterMinutes||2)*60000;
  if(!age||age.ageMs<=limit+30000)return false;
  c.proofAgeRejectedAt=now;c.proofAgeEstimate=age;c.proofExpiredAt=now;
  SOURCE?.observe({mint:c.a,phase:'after',outcome:'tooOld',lateMs:age.ageMs-limit});
  setMg(c,'unk','unk-age','опоздал (предварительная оценка возраста)',{final:1});
  return true;
}
function proofAgeBand(c,now){const age=proofEventAge(c,now)?.ageMs??(now-proofQueuedAt(c)),buyMinutes=SOURCE?.settings().afterMinutes||2;return age<buyMinutes*60e3?0:age<15*60e3?1:2}
function compareProofTasks(a,b,now){return proofAgeBand(a,now)-proofAgeBand(b,now)||Number(now-proofQueuedAt(a)>=15*60e3)-Number(now-proofQueuedAt(b)>=15*60e3)||Number(!!b.proofProgressAt&&now-b.proofProgressAt<4*60e3)-Number(!!a.proofProgressAt&&now-a.proofProgressAt<4*60e3)||Number(!!b.discoverySource)-Number(!!a.discoverySource)||(proofEventAge(a,now)?.at||proofQueuedAt(a))-(proofEventAge(b,now)?.at||proofQueuedAt(b))||(a.proofAttemptAt||0)-(b.proofAttemptAt||0)||b.t-a.t}
function migrationQueueSummary(now=Date.now()){
  const out={length:0,ready:0,freshUnder15m:0,waitingBudget:0,expired:0,buyWindowOpen:0,buyWindowMissedPending:0,lateProofRejected:0,ageRejected:0,oldestTaskAt:null,oldestAgeSec:0,reconcilePending:{dbc:RC.pend?.dbc?.length||0,ll:RC.pend?.ll?.length||0}};
  for(const c of C.values()){if(c.proofAgeRejectedAt)out.ageRejected++;if(c.buyWindowMissedAt)out.lateProofRejected++;if(c.proofExpiredAt){out.expired++;continue}if(!needMig(c,now))continue;
    const at=proofEventAge(c,now)?.at||proofQueuedAt(c);out.length++;if(proofAgeBand(c,now)===0)out.buyWindowOpen++;else out.buyWindowMissedPending++;if(now-at<15*60e3)out.freshUnder15m++;if(c.proofBudgetDeferredAt)out.waitingBudget++;
    if(!c.chTry&&(!c.proofRetryAt||now>=c.proofRetryAt))out.ready++;out.oldestTaskAt=out.oldestTaskAt==null?at:Math.min(at,out.oldestTaskAt);}
  out.oldestAgeSec=out.oldestTaskAt==null?0:Math.max(0,Math.floor((now-out.oldestTaskAt)/1000));return out;
}
function needMig(c,now){if(c.proofExpiredAt)return false;if(now-proofQueuedAt(c)>2*3600e3&&c.mg)return false;if(!c.mg||c.mg.v!==MGV||c.mg.force)return true;
  if(c.mg.st==='unk'&&!c.mg.final&&proofAgeBand(c,now)===0)return now-c.mg.lastAt>=2000;
  const BACK=[2,5,10,20,40];const n=c.mg.n||1;return c.mg.st==='unk'&&!c.mg.final&&n<=BACK.length&&now-c.mg.lastAt>=BACK[n-1]*60e3&&now-proofQueuedAt(c)<2*3600e3}
async function chainLoop(){let lastSweep=0;for(;;){const now=Date.now();expireProofs(now);
  if(now-lastSweep>120e3){lastSweep=now;CTX='кривые';await curveSweep()}
  if(now-(globalThis.lastPreSweep||0)>60e3){globalThis.lastPreSweep=now;CTX='до миграции';await preChainSweep()}
  for(const c of C.values())rejectOldProof(c,now);
  const candidates=[...C.values()].filter(c=>!c.chTry&&(!c.proofRetryAt||now>=c.proofRetryAt)&&((!c.ct&&isOk(c)&&now-c.t<6*3600e3)||needMig(c,now)));RESOURCE.migrationPending=[...C.values()].some(c=>needMig(c,now));
  const c=candidates.sort((a,b)=>compareProofTasks(a,b,now))[0];
  if(!c){await sleep(2000);continue}c.chTry=1;c.proofAttemptAt=now;
  try{CTX='миграция';if(needMig(c,Date.now())){if(c.mg&&c.mg.v!==MGV&&!c.mg0)c.mg0=c.mg;await migCheck(c);delete c.proofProgressAt;delete c.proofBudgetDeferredAt}CTX='контракт';if(!c.ct&&isOk(c))await ctCheck(c)}
  catch(e){if(e.code==='BUDGET_DEFERRED'){if(needMig(c,Date.now()))c.proofBudgetDeferredAt=c.proofBudgetDeferredAt||Date.now();c.proofRetryAt=Date.now()+3000;await sleep(500);continue}rpcFail++;err('chain '+e.message);if(/ключа/.test(e.message))await sleep(60000);
    else if((c.mgErr=(c.mgErr||0)+1)>=3){c.mgErr=0;setMg(c,'unk','unk-err','ошибка проверки: '+e.message.slice(0,80))}}
  finally{c.chTry=0;if(needMig(c,Date.now())&&!c.proofRetryAt)c.proofRetryAt=Date.now()+2000}}}

/* ---------- состояние ----------
   Правило: каждое наблюдение хранит абсолютное время, когда сервер его ПОЛУЧИЛ (at, мс) — данные никогда не привязываются
   к минуте «задним числом». Всё, что относится к пулу, при переезде витрины уходит в origs и начинается заново. */
const C=new Map();const FV=2; // версия формата наблюдений
// Авторитетный «Все»: отдельный read-only журнал допуска, не зависит от телефона.
let EVENT_CLOCK=null;
let SOURCE=null, SOURCE_ERR='', SOURCE_CFG_ERR='', PRE=null;
let RESEARCH_V2=null, RESEARCH_V2_ERR='', RESEARCH_BANK_UPLOADED=0, RESEARCH_DEBUG_SIG='';
let PASS_V2=null, RESEARCH_TWO=null, AUTO_V2=null, FILTER_AUDIT=null;
let RESEARCH_ONE_EPOCH=null, RESEARCH_TWO_EPOCH=null, RESEARCH_CONFIG_ERR='';
let OLD_RESEARCH_ONE=[], OLD_RESEARCH_TWO=[];
let AUTO_STUDIES=null,RESEARCH_BANKS=null,LIBRARY_CONFIG={schema:1,modules:[],deleted:[]},LIBRARY_ROWS=[],LIBRARY_SCORES={},LIBRARY_SCORE_AT=0,LIBRARY_PUBLISH_SIG='';
let PASS_ERR='', TWO_ERR='', PASS_CFG_ERR='', TWO_BANK_UPLOADED=0, AUTO_UPLOADED=0;
function seedLaunchEvidence(c,event,record){if(c.initialTradingEvidence)return;c.initialTradingEvidence=true;const p=event||record.proof||{},at=record.acceptedAt;
 if(p.creator){c.creatorAddress=p.creator;c.creatorObservedAt=at;}if(p.supplyRaw)c.supplyRaw=p.supplyRaw;if(p.tokenProgram)c.tokenProgram=p.tokenProgram;if(c.n)c.nameObservedAt=c.nameObservedAt||at;
 if((c.q||WSOL)===WSOL&&Number.isSafeInteger(p.initialCurveSol)&&p.initialCurveSol>=0){c.curveSol=c.curveSol||[];if(!c.curveSol.some(r=>r[0]===at))c.curveSol.push([at,p.initialCurveSol,p.initialComplete?1:0]);c.curveSol.sort((a,b)=>a[0]-b[0]);}
 const trades=p.trades||p.initialTrades||[];c.earlyWallets=[...new Set(trades.filter(t=>t.buy).map(t=>t.wallet))];c.earlyWalletsAt=at;const dev=trades.filter(t=>t.wallet===c.creatorAddress);appendIntelligence(c,{at,earlyWallets:c.earlyWallets,features:{devBuySol:c.creatorAddress&&(c.q||WSOL)===WSOL&&(dev.some(t=>t.buy)||p.initialTradesComplete===true)?dev.filter(t=>t.buy).reduce((n,t)=>n+Number(t.solRaw)/1e9,0):null,devSold:dev.some(t=>!t.buy)?1:null},lowerBoundKeys:['devBuySol']});
}
function appendIntelligence(c,snapshot){snapshot={...snapshot,evidenceVersion:2};const list=c.intelligenceSnapshots=c.intelligenceSnapshots||[];list.push(snapshot);if(list.length>48){const early=(SOURCE?.get(c.a)?.acceptedAt||c.t)+15*60e3,candidates=list.filter(s=>s.at<=early);c.intelligenceSnapshots=[...candidates.slice(0,24),...list.filter(s=>s.at>early).slice(-24)];}}
async function admitVerifiedPublicLaunch(launch,record) {
  const existing=C.get(record.mint);
  if(existing){existing.preCurve=existing.preCurve||1;existing.preTradingAt=record.eventAt;existing.createdAt=record.eventAt;existing.createdAtObservedAt=record.acceptedAt;existing.createdAtSource='verified-create-log-slot-time';
    if(!existing.n)existing.n=launch.name;if(!existing.s)existing.s=launch.symbol;
    seedLaunchEvidence(existing,launch,record);return;
  }
  C.set(record.mint,{a:record.mint,n:launch.name,s:launch.symbol,i:'',
    p:launch.curve,d:'pump-fun',q:launch.quote||WSOL,t:record.eventAt,
    preTradingAt:record.eventAt,createdAt:record.eventAt,createdAtObservedAt:record.acceptedAt,createdAtSource:'verified-create-log-slot-time',tSrc:'pre',seen:record.acceptedAt,disc:'pre-ws',
    preCurve:1,pools:[launch.curve],fv:FV,
    mg:{v:MGV,st:'curve',k:'curve-pump',final:1,lastAt:record.acceptedAt}});seedLaunchEvidence(C.get(record.mint),launch,record);
}
let SMART_WALLETS=null,INTEL_BUSY=false,INTEL_LAST=0,INTEL_RPC_LAST=0;const INTEL_BLOCKS=new Map(),INTEL_STATS={opening:0,deferred:0,errors:0,creatorBalances:0,history:0};
async function collectIntelligence(){const now=Date.now();if(INTEL_BUSY||now-INTEL_LAST<60000||!SOURCE)return;INTEL_BUSY=true;INTEL_LAST=now;try{const api=require(DIR+'/early-intelligence.js');
 if(!SMART_WALLETS)SMART_WALLETS=new api.SmartWallets(DIR);SMART_WALLETS.refresh(()=>RESEARCH_BANKS?RESEARCH_BANKS.rows({curves:false}):RESEARCH_V2?.select({limit:20000})||[],now);
 for(const c of C.values())if(c.earlyProgress&&now-(SOURCE.get(c.a)?.acceptedAt||now)>15*60000){delete c.earlyProgress;c.earlyDone=true;}
 const sourceRows=[...SOURCE.records.values()],records=sourceRows.map(r=>{const c=C.get(r.mint);return {mint:r.mint,acceptedAt:r.acceptedAt,creator:r.proof?.creator||c?.creatorAddress||null,creatorAt:r.proof?.creator?r.acceptedAt:c?.creatorObservedAt??Infinity};}),outcomes=RESEARCH_V2?.select({limit:20000})||[],candidates=[...C.values()].filter(c=>{const r=SOURCE.get(c.a);if(!r)return false;const cfg=require(DIR+'/research-runtime.js').phaseSettings(RESEARCH_V2?.config||{},r.phase);return now-r.acceptedAt<Math.max(15,cfg.decisionMinutes||15)*60000;}).sort((a,b)=>SOURCE.get(b.a).acceptedAt-SOURCE.get(a.a).acceptedAt);
 const byCreator=new Map();for(const r of records){if(!r.creator)continue;if(!byCreator.has(r.creator))byCreator.set(r.creator,[]);byCreator.get(r.creator).push(r);}
 const fields=['devBuySol','devHold','devHoldPct','devSold','devLaunches','devRugShare','sniperShare','bundleShare','bundledWallets','smartBuyers','smartShare'],coverage={sampledAt:now,scope:'latest-200-admissions-as-of-decision-or-now',coins:0,known:Object.fromEntries(fields.map(k=>[k,0]))};for(const r of SOURCE.latest(200)){const c=C.get(r.mint);if(!c)continue;const cfg=require(DIR+'/research-runtime.js').phaseSettings(RESEARCH_V2?.config||{},r.phase),f=require(DIR+'/research-v2.js').featuresAt(c,Math.min(now,require(DIR+'/event-clock.js').eventAnchor(r)+(cfg.decisionMinutes||10)*60000),{eventAt:require(DIR+'/event-clock.js').eventAnchor(r),phase:r.phase});coverage.coins++;for(const key of fields)if(Number.isFinite(f[key]))coverage.known[key]++;}INTEL_STATS.coverage=coverage;
 for(const c of candidates.slice(0,150)){const r=SOURCE.get(c.a);if(c.creatorAddress&&!c.creatorHistoryAt){appendIntelligence(c,{at:now,features:api.creatorFeatures(c.creatorAddress,r.acceptedAt,byCreator.get(c.creatorAddress)||[],outcomes),lowerBoundKeys:['devLaunches'],creatorScope:'observed-prior-launches'});c.creatorHistoryAt=now;INTEL_STATS.history++;}if(!c.smartAt||c.bx?.at>c.smartAt||c.earlyWalletsAt>c.smartAt){const smart=SMART_WALLETS.features(c,r.acceptedAt,now);if(smart){appendIntelligence(c,smart);c.smartAt=now;}}}
 if(now-INTEL_RPC_LAST<60000)return;if(process.memoryUsage().rss>330e6){INTEL_STATS.memoryDeferred=(INTEL_STATS.memoryDeferred||0)+1;return;}if(!RESOURCE.allow(require(DIR+'/resource-budget.js').rpcCost('getBlock'),'metadata')){INTEL_STATS.headroomDeferred=(INTEL_STATS.headroomDeferred||0)+1;return;}
 const opt={priority:'metadata',context:'ранние признаки',source:'intelligence',maxBytes:6*1024*1024};INTEL_RPC_LAST=now;
 // Alternate a bounded creator-account batch with one immutable opening block.
 const balances=candidates.filter(c=>c.creatorAddress&&c.ct?.safetyVersion===1&&c.ct?.supply>0&&now-(c.creatorBalanceAt||0)>120000).slice(0,50);
 if(balances.length&&Math.floor(now/60000)%2===0){const prepared=[];for(const c of balances){const program=c.ct.prog==='token2022'?T22:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';c.creatorAta=c.creatorAta||await findPDA([b58dec(c.creatorAddress),b58dec(program),b58dec(c.a)],'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');prepared.push(c.creatorAta);}const rows=(await rpc('getMultipleAccounts',[prepared,{encoding:'jsonParsed'}],opt))?.value||[],at=Date.now();balances.forEach((c,i)=>{c.creatorBalanceAt=at;const snapshot=api.creatorHolding(rows[i],{mint:c.a,creator:c.creatorAddress,supply:c.ct.supply,at});if(!snapshot)return;appendIntelligence(c,snapshot);INTEL_STATS.creatorBalances++;});return;}
 const c=candidates.filter(c=>{const r=SOURCE.get(c.a),cfg=require(DIR+'/research-runtime.js').phaseSettings(RESEARCH_V2?.config||{},r.phase);return api.openingEligible(c,r,now,cfg.decisionMinutes||10)}).sort((a,b)=>(b.earlyProgress?.blocks?.length||0)-(a.earlyProgress?.blocks?.length||0)||SOURCE.get(b.a).acceptedAt-SOURCE.get(a.a).acceptedAt)[0];if(!c)return;const record=SOURCE.get(c.a),slot=record.proof.slot;c.earlyProgress=c.earlyProgress||{blocks:[]};const next=slot+c.earlyProgress.blocks.length;let block=INTEL_BLOCKS.get(next);
 if(!block){let raw;try{raw=await rpc('getBlock',[next,{encoding:'json',transactionDetails:'full',rewards:false,maxSupportedTransactionVersion:1,commitment:'confirmed'}],opt);}catch(e){if(e.message==='optional-rpc-response-too-large'){c.earlyDone=true;c.earlyUnavailableReason='rpc-response-limit';delete c.earlyProgress;INTEL_STATS.sizeDeferred=(INTEL_STATS.sizeDeferred||0)+1;return;}throw e;}block=api.blockEvidence(raw,next,Date.now(),b58dec);if(!block)return;INTEL_BLOCKS.set(next,block);while(INTEL_BLOCKS.size>6)INTEL_BLOCKS.delete(INTEL_BLOCKS.keys().next().value);}
 c.earlyProgress.blocks.push({...block,events:block.events.filter(e=>e.mint===c.a)});
 {const snap=api.openingFeatures({mint:c.a,creator:c.creatorAddress,supplyRaw:c.supplyRaw||(c.ct?.supply>0?Math.round(c.ct.supply*10**c.ct.dec).toString():null),slot,blocks:c.earlyProgress.blocks,at:Date.now()});if(!(c.tokenProgram==='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'||c.ct?.safetyVersion===1&&c.ct.fee===0&&!c.ct.hook&&c.ct.unknownExtensions?.length===0)){snap.features.sniperShare=null;snap.features.bundleShare=null;}appendIntelligence(c,snap);c.earlyWallets=snap.earlyWallets;c.earlyWalletsAt=snap.at;const smart=SMART_WALLETS.features(c,record.acceptedAt,snap.at);if(smart){appendIntelligence(c,smart);c.smartAt=snap.at;}if(c.earlyProgress.blocks.length===3){c.earlyDone=true;delete c.earlyProgress;INTEL_STATS.opening++;}}
 }catch(e){if(e.code==='BUDGET_DEFERRED')INTEL_STATS.deferred++;else INTEL_STATS.errors++;}finally{INTEL_BUSY=false;}}
// Все модули скачиваются ОДНИМ шагом до любого require: модули зависят друг от друга
// (pass-runtime → research-v2, source-runtime → admission), раздельная загрузка давала MODULE_NOT_FOUND.
const MODULES=['activity-slices.js','event-clock.js','admission.js','source-runtime.js','pump-pre.js','pre-watcher.js','research-v2.js','research-runtime.js',
  'research-config.js','pass-runtime.js','research-two-runtime.js','auto-research-v2.js','filter-audit.js','resource-budget.js','runtime-health.js','stream-json.js','observation-contract.js','packed-observations.js','completed-coins.js','seed-completed.js','coin-profile.js','durable-json.js','research-banks.js','module-library.js','active-history.js','launch-history.js','early-intelligence.js','migration-fast.js','legacy-birth-cleanup.js','manual-pools.js','pool-logs.js','legacy-data-redaction.js','side-pools.js','observation-recovery.js'];
let MODULES_OK=null;
function ensureModules(){if(!MODULES_OK)MODULES_OK=(async()=>{const auth=await token();
  for(const name of MODULES){const r=await fetch('https://storage.googleapis.com/storage/v1/b/'+BUCKET+'/o/'+encodeURIComponent('code/'+name)+'?alt=media',
      {headers:{Authorization:'Bearer '+auth},signal:AbortSignal.timeout(30000)});
    if(!r.ok)throw new Error('module '+name+' HTTP '+r.status);
    const out=DIR+'/'+name,tmp=out+'.tmp';fs.writeFileSync(tmp,await r.text());fs.renameSync(tmp,out)}})().catch(e=>{MODULES_OK=null;throw e});
  return MODULES_OK}
async function initSource() {
  await ensureModules();

  // Отсутствующий/повреждённый журнал НЕ очищать; источник лучше отключить,
  // чем повторно занести монеты после рестарта.
  SOURCE=new (require(DIR+'/source-runtime.js').SourceRuntime)({dir:DIR});
  const epochFile=DIR+'/manual-pool-epoch-v1.json';if(!fs.existsSync(epochFile)){const at=Date.now();fs.writeFileSync(epochFile+'.tmp',JSON.stringify({schema:1,phase:'pool',id:'pool-'+at,startedAt:at}));fs.renameSync(epochFile+'.tmp',epochFile);require(DIR+'/durable-json.js').syncDirectory(DIR);}POOL_TRANSITION.poolEpoch=JSON.parse(fs.readFileSync(epochFile,'utf8'));POOL_TRANSITION.phaseAliases={before:'pool'};
  const removed=SOURCE.removeLegacyBirths();POOL_TRANSITION.legacySourceRemoved=removed.length;
  if(removed.length){for(const mint of removed)C.delete(mint);fs.writeFileSync(DIR+'/legacy-before-purge-pending.json',JSON.stringify({schema:1,createdAt:Date.now(),mints:removed,reason:'owner-TZ20-delete-legacy-birth-data'}));save();}
  POOL_TRANSITION.completedCleanup=await COMPLETED?.eraseLegacyBirths(POOL_TRANSITION.poolEpoch.startedAt);
  POOL_TRANSITION.localCleanup=require(DIR+'/legacy-birth-cleanup.js').cleanup({dir:DIR});
  EVENT_CLOCK=new (require(DIR+'/event-clock.js').EventClock)({rpc:(method,params)=>rpc(method,params,{priority:'migration',context:'часы',source:'clock'})});
  await EVENT_CLOCK.refresh();
  setInterval(()=>{EVENT_CLOCK.refresh().catch(()=>{})},10000);
  const PumpPreWatcher=require(DIR+'/pre-watcher.js').PumpPreWatcher;
  PRE=new PumpPreWatcher({onCreate:rememberCurve,canObserve:()=>!resourcePressure()&&C.size<12000,rpc:(method,params)=>rpc(method,params,{priority:'pre',context:'новые до миграции',source:'pre'}),decode58:b58dec,deriveCurve:bondingCurveOf,source:SOURCE,slotClock:EVENT_CLOCK,telemetry:new (require(DIR+'/resource-budget.js').PumpTelemetry)({dir:DIR}),
    onAdmitted:admitVerifiedPublicLaunch,log:msg=>err(msg)});
  // Journal is durable even if the VM was restarted before candidate-state save.
  for(const item of SOURCE.records.values())if(item.phase==='before'&&!C.has(item.mint)&&item.proof?.curve) {
    if(Date.now()-item.acceptedAt>26*3600e3)continue;
    if(COMPLETED?.metadata(item.mint)){RETENTION.archivedRestoreSkipped=(RETENTION.archivedRestoreSkipped||0)+1;continue;}
    C.set(item.mint,{a:item.mint,n:item.proof.name||'',s:item.proof.symbol||'',i:'',
      p:item.proof.curve,d:'pump-fun',q:item.proof.quote||WSOL,t:item.eventAt,
      tSrc:'pre',preTradingAt:item.eventAt,seen:item.acceptedAt,disc:'pre-ws',preCurve:1,firstPostSeenAt:null,
      pools:[item.proof.curve],mg:{v:MGV,st:'curve',k:'curve-pump',final:1,
      lastAt:item.acceptedAt},fv:FV});seedLaunchEvidence(C.get(item.mint),item.proof,item);
  }
  for(const item of SOURCE.records.values())if(item.proof?.kind==='manual-pool-open-v1'&&!C.has(item.mint)&&Date.now()-item.acceptedAt<26*3600e3){const p=item.proof;C.set(item.mint,{a:item.mint,n:'',s:'',i:'',p:p.pool,d:({'PumpSwap':'pumpswap','Raydium CPMM':'raydium-cpmm','Raydium CLMM':'raydium-clmm','Meteora DLMM':'meteora-dlmm','Meteora DAMM v2':'meteora-damm-v2','Orca':'orca-whirlpools'})[p.dex],q:p.quote,t:item.eventAt,seen:item.acceptedAt,pools:[p.pool],preCurve:0,fv:FV,disc:'manual-pool',discoverySource:'manual-pool',mg:{v:MGV,st:'ok',k:'manual-pool',pool:p.pool,sig:p.signature,mT:item.eventAt,owner:p.dexProgram},ct:p.ct,creatorAddress:p.creatorAddress,openingMetrics:p.openingMetrics,admissionVerifiedAt:p.verifiedAt,launchpad:null,dex:p.dex,venue:p.venue,vaults:[p.baseVault,p.quoteVault]});}
  SOURCE_ERR='';
  log('главный источник готов, принято',SOURCE.records.size,'настройки',SOURCE.settings());
}
async function reloadSourceAgeConfig(){
  if(!SOURCE)return;
  try{
    const cfg=await getObj('config/source-age.json');
    if(!cfg||cfg.schema!==1||!Number.isInteger(cfg.beforeMinutes)||
       !Number.isInteger(cfg.afterMinutes)||cfg.beforeMinutes<1||cfg.beforeMinutes>10||
       cfg.afterMinutes<1||cfg.afterMinutes>10)
      throw Error('Invalid source-age config');
    const current=SOURCE.settings();
    if(current.beforeMinutes!==cfg.beforeMinutes||current.afterMinutes!==cfg.afterMinutes){
      SOURCE.configure({beforeMinutes:cfg.beforeMinutes,afterMinutes:cfg.afterMinutes});
      log('возраст главного источника обновлён: до',cfg.beforeMinutes,'после',cfg.afterMinutes);
    }
    SOURCE_CFG_ERR='';
  }catch(e){
    SOURCE_CFG_ERR=e.message;
    err('source age config '+e.message);
  }
}
function oneResearchBankName(epoch){
  return epoch.activeAt===0?'research-v2-bank.json':
    'research-v2-bank-one-'+epoch.hash+'-'+epoch.activeAt+'.json';
}
function twoResearchBankName(epoch){
  return 'research-v2-bank-two-'+epoch.hash+'-'+epoch.activeAt+'.json';
}
function recoverSupersededStudies(now=Date.now()){
  const maxAge=50*3600e3;
  if(RESEARCH_ONE_EPOCH&&RESEARCH_V2){
    const {ResearchRuntime}=require(DIR+'/research-runtime.js');
    OLD_RESEARCH_ONE=RESEARCH_ONE_EPOCH.history
      .filter(e=>e.endedAt>now-maxAge)
      .map(e=>({epoch:e,runtime:{config:e.config,cohortStart:e.activeAt,cohortEnd:e.endedAt,rows:[],processed:new Map(),summary:()=>({counts:null,archivedRaw:true})}}));
  }
  if(RESEARCH_TWO_EPOCH&&RESEARCH_TWO){
    const {ResearchTwoRuntime}=require(DIR+'/research-two-runtime.js');
    OLD_RESEARCH_TWO=RESEARCH_TWO_EPOCH.history
      .filter(e=>e.endedAt>now-maxAge)
      .map(e=>({epoch:e,runtime:new ResearchTwoRuntime({
        dir:DIR,config:e.config,bankName:twoResearchBankName(e),
        cohortStart:e.activeAt,cohortEnd:e.endedAt
      })}));
  }
}
async function initResearchV2() {
  await ensureModules();
  // Separate initialization: invalid research settings must never stop
  // the authoritative token source or the on-chain listeners.

  const {ResearchRuntime,settings}=require(DIR+'/research-runtime.js');
  const {ResearchEpoch}=require(DIR+'/research-config.js');
  const requested=await getObj('config/research-one.json')||settings();
  const config=settings(requested);
  const baseline=settings();
  RESEARCH_ONE_EPOCH=new ResearchEpoch({dir:DIR,key:'one',validate:settings,
    config,adoptLegacy:JSON.stringify(config)===JSON.stringify(baseline)});
  const epoch=RESEARCH_ONE_EPOCH.current;
  RESEARCH_V2=new ResearchRuntime({
    dir:DIR,config:epoch.config,cohortStart:epoch.activeAt,
    bankName:oneResearchBankName(epoch)
  });
  recoverSupersededStudies();
  RESEARCH_V2_ERR='';
  log('исследование v2 готово, накоплено',RESEARCH_V2.rows.length);
}
async function initPathsV2(){
  await ensureModules();

  // A malformed control object fails closed. Never trust a phone-side
  // localStorage setting as permission to create an authoritative alert.
  const config=await getObj('config/pass-filters.json');
  if(!config)throw Error('Missing server filter configuration');
  await refreshLibrary(config);
  PASS_V2=new (require(DIR+'/pass-runtime.js').PassRuntime)({dir:DIR,config:require(DIR+'/pass-runtime.js').verdictConfig(require(DIR+'/module-library.js').windowConfig(config,LIBRARY_CONFIG.modules,LIBRARY_CONFIG.deleted))});
  const {ResearchTwoRuntime,configOf}=require(DIR+'/research-two-runtime.js');
  const {ResearchEpoch}=require(DIR+'/research-config.js');
  const requested=await getObj('config/research-two.json')||configOf();
  RESEARCH_TWO_EPOCH=new ResearchEpoch({dir:DIR,key:'two',validate:configOf,
    config:requested});
  const two=RESEARCH_TWO_EPOCH.current;
  RESEARCH_TWO=new ResearchTwoRuntime({
    dir:DIR,config:two.config,cohortStart:two.activeAt,
    bankName:twoResearchBankName(two)
  });
  recoverSupersededStudies();
  AUTO_V2=require(DIR+'/auto-research-v2.js');
  AUTO_STUDIES=new AUTO_V2.AutoStudies({dir:DIR});
  try{LIBRARY_SCORES=JSON.parse(fs.readFileSync(DIR+'/module-live-evaluations.json','utf8'))}catch(e){if(e.code!=='ENOENT')err('library live scores unavailable')}
  await refreshLibrary(PASS_V2.config);
  RESEARCH_BANKS=new (require(DIR+'/research-banks.js').ResearchBanks)({dir:DIR,config:await getObj('config/research-storage.json')||{},one:RESEARCH_V2?.config||{},two:RESEARCH_TWO.config});
  FILTER_AUDIT=new (require(DIR+'/filter-audit.js').FilterAudit)({dir:DIR});
  PASS_ERR='';TWO_ERR='';PASS_CFG_ERR='';
  log('серверные пути готовы: Прошли',PASS_V2.records.size,
    'Уровень 2',RESEARCH_TWO.rows.length,'включено',PASS_V2.config.enabled);
}
async function reloadResearchConfig(){
  try{
    if(RESEARCH_ONE_EPOCH&&RESEARCH_V2){
      const cfg=await getObj('config/research-one.json');
      if(!cfg)throw Error('First research config missing');
      if(RESEARCH_ONE_EPOCH.apply(cfg)){
        const x=RESEARCH_ONE_EPOCH.current;
        const {ResearchRuntime}=require(DIR+'/research-runtime.js');
        RESEARCH_V2=new ResearchRuntime({dir:DIR,config:x.config,carry:RESEARCH_V2,
          cohortStart:x.activeAt,bankName:oneResearchBankName(x)});
        recoverSupersededStudies();
        RESEARCH_BANK_UPLOADED=0;AUTO_UPLOADED=0;
        log('первый исследовательский полигон переключён на новую эпоху',x.hash);
      }else RESEARCH_V2.config=RESEARCH_ONE_EPOCH.current.config;
    }
    if(RESEARCH_TWO_EPOCH&&RESEARCH_TWO){
      const cfg=await getObj('config/research-two.json');
      if(!cfg)throw Error('Second research config missing');
      if(RESEARCH_TWO_EPOCH.apply(cfg)){
        const x=RESEARCH_TWO_EPOCH.current;
        const {ResearchTwoRuntime}=require(DIR+'/research-two-runtime.js');
        RESEARCH_TWO=new ResearchTwoRuntime({dir:DIR,config:x.config,
          cohortStart:x.activeAt,bankName:twoResearchBankName(x)});
        recoverSupersededStudies();
        TWO_BANK_UPLOADED=0;AUTO_UPLOADED=0;
        log('второй исследовательский полигон переключён на новую эпоху',x.hash);
      }else RESEARCH_TWO.config=RESEARCH_TWO_EPOCH.current.config;
    }
    if(RESEARCH_BANKS){RESEARCH_BANKS.applyConfig(await getObj('config/research-storage.json')||{},RESEARCH_V2?.config||{},RESEARCH_TWO?.config||{});RESEARCH_BANKS.upsert([])}
    RESEARCH_CONFIG_ERR='';
  }catch(e){
    RESEARCH_CONFIG_ERR=e.message;
    err('research config '+e.message);
  }
}
async function refreshLibrary(raw){
 const lib=require(DIR+'/module-library.js');LIBRARY_CONFIG=lib.catalog(await getObj('config/modules.json')||{schema:1,modules:[],deleted:[]});
 const configured=lib.configuredModules(raw,LIBRARY_ROWS,PASS_V2?.config?.activatedAt||Date.now());
 LIBRARY_ROWS=lib.combine({owner:LIBRARY_CONFIG,auto:AUTO_STUDIES?[...AUTO_STUDIES.modules.values()].filter(m=>m.validatedBirth===true):[],configured});
 for(const m of LIBRARY_ROWS){const score=LIBRARY_SCORES[m.id];if(score?.evalSig===m.evalSig)m.eval={...m.eval,live:score.live}}
}
async function publishLibrary(now,{score=true}={}){
 if(!AUTO_STUDIES||!PASS_V2)return;
 await refreshLibrary(PASS_V2.config);
 if(score&&RESEARCH_BANKS&&now-LIBRARY_SCORE_AT>=60*60e3){const scores=await require(DIR+'/module-library.js').liveStats(LIBRARY_ROWS,RESEARCH_BANKS.rows());
  for(const m of LIBRARY_ROWS){const live=scores.get(m.id);if(live&&(live.totalPositive||live.totalNegative)){m.eval={...m.eval,live};LIBRARY_SCORES[m.id]={evalSig:m.evalSig,live}}}
  const ids=new Set(LIBRARY_ROWS.map(m=>m.id));for(const id of Object.keys(LIBRARY_SCORES))if(!ids.has(id))delete LIBRARY_SCORES[id];
  const file=DIR+'/module-live-evaluations.json',tmp=file+'.tmp',fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(LIBRARY_SCORES));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,file);require(DIR+'/durable-json.js').syncDirectory(DIR);LIBRARY_SCORE_AT=now;
 }
 const content=JSON.stringify(LIBRARY_ROWS),sig=require('node:crypto').createHash('sha256').update(content).digest('hex');
 if(sig!==LIBRARY_PUBLISH_SIG){await upload('research-v2/modules.json',{schema:1,origin:'server-module-library',updated:now,modules:LIBRARY_ROWS});LIBRARY_PUBLISH_SIG=sig}
}
async function reloadPassConfig(){
  if(!PASS_V2)return;
  try{
    const config=await getObj('config/pass-filters.json');
    if(!config)throw Error('No pass configuration');
    await refreshLibrary(config);
    if(PASS_V2.applyConfig(require(DIR+'/pass-runtime.js').verdictConfig(require(DIR+'/module-library.js').windowConfig(config,LIBRARY_CONFIG.modules,LIBRARY_CONFIG.deleted))))
      log('применена новая серверная версия фильтров',PASS_V2.configHash);
    PASS_CFG_ERR='';
  }catch(e){
    PASS_CFG_ERR=e.message;err('pass control '+e.message);
  }
}
function admitVerifiedMigration(c){
  if(!SOURCE)return;
  try{
    const now=Date.now(),deadline=c.mg?.mT+(SOURCE.settings().afterMinutes||2)*60e3;c.buyDeadlineAt=deadline;
    if(!SOURCE.has(c.a)&&Number.isFinite(deadline)&&now>deadline){c.buyWindowMissedAt=now;SOURCE.observe({mint:c.a,phase:'after',outcome:'tooOld',lateMs:now-deadline});return}
    const d=SOURCE.afterVerifiedMigration(c);
    if(d.admitted)log('ВСЕ + после',c.a,'возраст секунд',Math.round((d.record.acceptedAt-d.record.eventAt)/1000));
  }catch(e){SOURCE_ERR='ошибка записи источника: '+e.message;err('source '+e.message)}
}

const OBS_KEYS=['curveSol','ds','k10','path','hold','bx','lq','gx','vaults','vmint','vdec','vaultIdentityAt','legacy','raw','tr','rawUp','trDone','archiveRefs'],OBS_TMP=['tr','raw','dsAt','dsTryAt','tokAt','gxAt','lastTrade','kTry','pTry','trTry','trDone','lqAt','rawUp','vTry'];
function takeObs(c){const o={};for(const k of OBS_KEYS){if(c[k]!=null)o[k]=c[k];delete c[k]}for(const k of OBS_TMP)delete c[k];return o}
function load(){try{require(DIR+'/stream-json.js').loadRows(DIR+'/state.json',c=>{
    for(const key of ['chTry','kTry','pTry','trTry','vTry'])delete c[key]; // in-flight locks belong to the old process
    if(c.fv!==FV){c.legacy={snap:c.snap,act:c.act,k:c.k};for(const k of ['snap','act','k','o','cur','cn','orig'])delete c[k];c.fv=FV}
    if(c.disc==='ws'&&c.d==='pumpswap')return;c=require(DIR+'/legacy-data-redaction.js').coin(c);if(!c)return;require(DIR+'/packed-observations.js').compactCoin(c);C.set(c.a,c)},HEALTH);log('загружено монет',C.size)}catch(e){if(e.code!=='ENOENT')throw e}
  try{RC=JSON.parse(fs.readFileSync(DIR+'/recon.json','utf8'))}catch{}}
function save(){try{require(DIR+'/stream-json.js').saveRows(DIR+'/state.json',C.values(),HEALTH);
  fs.writeFileSync(DIR+'/recon.json',JSON.stringify(RC));RETENTION.stateBytes=fs.statSync(DIR+'/state.json').size;return true}catch(e){err('save '+e.message);return false}}
const isCurve=d=>/pump-?fun/i.test(d||'')&&!/swap/i.test(d||'');
const SKIP=new Set([WSOL,USDC,USDT]);
function launchType(c){if(c.mg)return MIGNAME[c.mg.k]||('Другое ('+(c.d||'?')+')');return 'Проверяется'}
const isOk=c=>c.mg?.st==='ok';
const isRecordedPre=c=>!!c.preCurve&&SOURCE?.get(c.a)?.phase==='before';
const observedEligible=c=>isOk(c)||isRecordedPre(c)||c.completedLegacyObserved===1;
const ageMin=(c,now)=>(now-c.t)/60000;

/* ---------- 1. новые пулы (GeckoTerminal) ---------- */
async function addFromGT(r){const inc={};(r.included||[]).forEach(x=>inc[x.id]=x);let n=0;
  for(const d of r.data||[]){const a=d.attributes||{},dex=d.relationships?.dex?.data?.id||'';if(isCurve(dex))continue;
    let bid=d.relationships?.base_token?.data?.id||'',addr=bid.replace(/^solana_/,''),q=(d.relationships?.quote_token?.data?.id||'').replace(/^solana_/,'');
    if(SKIP.has(addr)){q=addr;bid=d.relationships?.quote_token?.data?.id||'';addr=bid.replace(/^solana_/,'')}
    if(!addr||SKIP.has(addr))continue;SOURCE?.observe({mint:addr,phase:'after',origin:'geckoterminal'});const t=Date.parse(a.pool_created_at);if(!t||Date.now()-t>3*3600e3)continue;
    let ex=C.get(addr);if(!ex&&typeof COMPLETED!=='undefined'&&COMPLETED){const old=COMPLETED.metadata(addr);if(old?.poolKeys.includes(a.address))continue;if(old){ex=COMPLETED.readCoin(addr);C.set(addr,ex)}}
    if(ex){ex.pools=ex.pools||[ex.p];if(!ex.pools.includes(a.address)){queueMigrationSignal(ex,Date.now());if(!ex.firstPostSeenAt)ex.firstPostSeenAt=Date.now();if(ex.pools.length<12)ex.pools.push(a.address);
        if(ex.mg&&ex.mg.st!=='ok'&&ex.mg.st!=='other')ex.mg.force=1} // у монеты новый пул — возможно, это миграция
      continue}
    const tk=inc[bid]?.attributes||{};
    C.set(addr,{a:addr,n:(tk.name||(a.name||'').split(' / ')[0]||'').slice(0,40),s:(tk.symbol||'').slice(0,16),i:tk.image_url&&tk.image_url!=='missing.png'?tk.image_url:'',
      p:a.address,d:dex,q,t,tSrc:'gt',seen:Date.now(),pools:[a.address],fv:FV});n++}
  return n}
async function pollNew(){if(gtPending('new'))return;try{const n=await addFromGT(await gt('/new_pools?page=1&include=base_token,quote_token,dex',0,'new'));if(n)log('новых',n,'всего',C.size)}catch(e){err('new_pools '+e.message)}}

/* ---------- 2. DEX Screener: ряд снимков [время получения (с), цена, ликв.$, mc, покупки 5м, продажи 5м, объём 5м, покупки 1ч, продажи 1ч, объём 1ч]
   Витрина: каждую минуту первые 15 минут, потом каждые 5 минут до 24 ч. Остальные пулы: раз в 15 минут первые 6 ч (только «торгуется ли»). ---------- */
// Avoid importing a module before the collector's GCS bootloader has fetched it.
// Fair due-time rotation: protect the first minutes while allowing every
// five-hour cohort to keep collecting observations in the presence of backlog.
function chooseDue(coins,{now=Date.now(),limit=1200,earlyShare=.3}={}){
  const early=[],long=[];
  for(const c of coins){
    if(!c||!Number.isFinite(c.t))continue;
    ((now-c.t)/60000<12?early:long).push(c);
  }
  const order=(a,b)=>
    (a.dsTryAt||a.dsAt||0)-(b.dsTryAt||b.dsAt||0)||
    (a.dsAt||0)-(b.dsAt||0)||
    (a.t||0)-(b.t||0);
  early.sort(order);long.sort(order);
  const n=Math.ceil(limit*earlyShare);
  const a=early.splice(0,n),b=long.splice(0,limit-a.length);
  return a.concat(b,early,long).slice(0,limit);
}
function dsDue(c,now){
  const a=ageMin(c,now),last=Math.max(c.dsAt||0,c.dsTryAt||0);
  if(observedEligible(c)){
    if(a<-1||a>24*60+10)return false;
    // Failed polls must not monopolize the queue; never pretend a failure was data.
    return now-last>=(a<120?55e3:5*60e3-15e3);
  }
  return a<6*60&&now-last>=15*60e3;
}
function dsEntry(p,at){return[Math.round(at/1000),+(+p.priceUsd||0).toPrecision(6),p.liquidity?.usd!=null?Math.round(p.liquidity.usd):null,p.marketCap||p.fdv||null,
  p.txns?.m5?.buys??null,p.txns?.m5?.sells??null,p.volume?.m5!=null?Math.round(p.volume.m5):null,p.txns?.h1?.buys??null,p.txns?.h1?.sells??null,p.volume?.h1!=null?Math.round(p.volume.h1):null]}
// First-level decisions have a 1–30 minute deadline. The regular
// two-minute export is too slow for short windows. Evaluate promptly after
// fresh market snapshots and publish on the next normal upload cycle.
let passObservationTimer=null,lastPassObservationAt=0;
function schedulePassOnObservation(){
  if(!PASS_V2||!SOURCE||!PASS_V2.config.enabled||passObservationTimer)return;
  const delay=Math.max(80,8000-(Date.now()-lastPassObservationAt));
  passObservationTimer=setTimeout(()=>{
    passObservationTimer=null;lastPassObservationAt=Date.now();
    try{PASS_V2.update({source:SOURCE,coins:researchCoins(),now:lastPassObservationAt})}
    catch(e){PASS_ERR=e.message;err('pass observation '+e.message)}
  },delay);
}
function dsApply(c,p,at){const e=dsEntry(p,at);
  if(observedEligible(c)){(c.ds=c.ds||[]).push(e);if(c.ds.length>520)c.ds.splice(130,1)}else c.ds=[e];
  if((e[4]||0)+(e[5]||0)>0)c.lastTrade=at;else if((e[7]||0)+(e[8]||0)>0&&!c.lastTrade)c.lastTrade=at-30*60e3;
  if(observedEligible(c))schedulePassOnObservation();
}
// сведения о монете (имя, соцсети, когда родилась на кривой) — по адресу монеты
function dsTokenInfo(c,arr,at){if(!arr.length)return;
  if(!c.n&&arr[0].baseToken){c.nameObservedAt=at;c.n=(arr[0].baseToken.name||'').slice(0,40);c.s=(arr[0].baseToken.symbol||'').slice(0,16)}
  const cv=arr.filter(p=>isCurve(p.dexId)||/dbc|launch/i.test(p.dexId||'')).map(p=>p.pairCreatedAt).filter(Boolean);
  const all=arr.map(p=>p.pairCreatedAt).filter(Boolean);const born=Math.min(...(cv.length?cv:all));if(isFinite(born)&&born<c.t-60e3){const nt=Math.min(c.tk||Infinity,born);if(nt!==c.tk){c.tk=nt;c.tkAt=at}}
  const info=arr[0].info;if(info){const social=info.socials;c.socialFeatures={at,hasTwitter:Array.isArray(social)?social.some(s=>/^(twitter|x)$/i.test(s.type||'')):null,hasTelegram:Array.isArray(social)?social.some(s=>/telegram/i.test(s.type||'')):null,hasWebsite:Array.isArray(info.websites)?info.websites.some(s=>!!s.url):null};if(info.imageUrl&&!c.i)c.imageObservedAt=at;}
  c.soc=Math.max(c.soc||0,(arr[0].info?.socials||[]).length+(arr[0].info?.websites||[]).length);if(!c.i&&arr[0].info?.imageUrl)c.i=arr[0].info.imageUrl}
async function pollDS(){const now=Date.now(),pins=collectionPins(now);
  const need=[...C.values()].filter(c=>collectionActive(c,now,pins)&&dsDue(c,now));
  // A newest-first truncation permanently starved older, admitted cohorts:
  // reserve a fixed share of each pass for the first 12 minutes and rotate
  // everyone else by last actual attempt, independent of migration phase.
  const ok=chooseDue(need.filter(observedEligible),{now,limit:1200,earlyShare:.3});
  const rest=chooseDue(need.filter(c=>!observedEligible(c)),{now,limit:600,earlyShare:.3});
  const tokFirst=ok.filter(c=>require(DIR+'/coin-profile.js').tokenInfoDue(c,now)).slice(0,300);
  for(let i=0;i<ok.length;i+=30){const part=ok.slice(i,i+30);
    const attempted=Date.now();for(const c of part)c.dsTryAt=attempted;
    try{const j=await getJSON(`${DS}/latest/dex/pairs/solana/${part.map(c=>c.p).join(',')}`);const at=Date.now(),by={};(j.pairs||[]).forEach(p=>by[p.pairAddress]=p);
      for(const c of part){c.dsAt=at;const p=by[c.p];if(p)dsApply(c,p,at)}}catch(e){err('ds '+e.message);await sleep(5000)}
    await sleep(300)}
  for(const [list,isTok] of [[tokFirst,1],[rest,0]])for(let i=0;i<list.length;i+=30){const part=list.slice(i,i+30);
    if(!isTok){const attempted=Date.now();for(const c of part)c.dsTryAt=attempted}
    try{const ps=await getJSON(`${DS}/tokens/v1/solana/${part.map(c=>c.a).join(',')}`);const at=Date.now(),by={};
      ps.forEach(p=>{const a=p.baseToken?.address;if(a)(by[a]=by[a]||[]).push(p)});
      for(const c of part){const arr=by[c.a]||[];dsTokenInfo(c,arr,at);if(isTok){c.tokAt=at;continue}c.dsAt=at;const p=arr.find(x=>x.pairAddress===c.p);if(p)dsApply(c,p,at)}
    }catch(e){err('ds '+e.message);await sleep(5000)}
    await sleep(300)}}

/* ---------- 3. GeckoTerminal: свечи 1 мин (первые 10 минут, затем график до 24 ч) и сделки первых минут — только витрина ---------- */
const kRow=x=>[x[0],+(+x[1]).toPrecision(6),+(+x[2]).toPrecision(6),+(+x[3]).toPrecision(6),+(+x[4]).toPrecision(6),Math.round(+x[5])];
const kList=r=>(r.data?.attributes?.ohlcv_list||[]).map(kRow).sort((a,b)=>a[0]-b[0]);
function mergeK(a,b){const m=new Map();for(const x of [...(a||[]),...b])m.set(x[0],x);return [...m.values()].sort((x,y)=>x[0]-y[0])}
function candleTasks(){const now=Date.now(),pins=collectionPins(now);
  for(const c of C.values()){if(!observedEligible(c)||!collectionActive(c,now,pins))continue;const a=ageMin(c,now),pool=c.p,ts=Math.floor;
    // первые 10 минут: запрос на 11-й минуте, чтобы минута с 10-й отметкой была закрыта
    if(!c.k10&&!c.kTry&&c.trDone&&!gtBackgroundBusy()&&a>=11&&a<6*60){c.kTry=1;gt(`/pools/${pool}/ohlcv/minute?aggregate=1&limit=15&before_timestamp=${ts((c.t+11*60e3)/1000)}&currency=usd`,3,'k10:'+pool)
      .then(r=>{if(c.p===pool)c.k10={at:Date.now(),c:kList(r)}}).catch(e=>{if(e.code!=='OBSERVATION_COMPLETE')err('k10 '+e.message)}).finally(()=>{c.kTry=0})}
    // график: 5 ч (одним запросом) и 24 ч (двумя)
    const upto=c.path?.upto||0;
    if(!c.pTry&&!gtBackgroundBusy()&&upto<5&&a>=5*60+10&&a<24*60){c.pTry=1;gt(`/pools/${pool}/ohlcv/minute?aggregate=1&limit=330&before_timestamp=${ts((c.t+5*3600e3+10*60e3)/1000)}&currency=usd`,3,'p5:'+pool)
      .then(r=>{if(c.p===pool)c.path={at:Date.now(),upto:5,c:mergeK(c.path?.c,kList(r))}}).catch(e=>{if(e.code!=='OBSERVATION_COMPLETE')err('path '+e.message)}).finally(()=>{c.pTry=0})}
    if(!c.pTry&&!gtBackgroundBusy()&&upto<24&&a>=24*60+10&&a<30*60){c.pTry=1;const end=ts((c.t+24*3600e3+10*60e3)/1000);
      gt(`/pools/${pool}/ohlcv/minute?aggregate=1&limit=1000&before_timestamp=${end}&currency=usd`,3,'p24a:'+pool).then(async r=>{const k1=kList(r);
          let k2=[];if(k1.length&&k1[0][0]*1000>c.t)k2=kList(await gt(`/pools/${pool}/ohlcv/minute?aggregate=1&limit=1000&before_timestamp=${k1[0][0]}&currency=usd`,3,'p24b:'+pool));
          if(c.p===pool)c.path={at:Date.now(),upto:24,c:mergeK(mergeK(c.path?.c,k2),k1)}})
        .catch(e=>{if(e.code!=='OBSERVATION_COMPLETE')err('path24 '+e.message)}).finally(()=>{c.pTry=0})}}
  researchActivityTape(now);researchTradeTail(now);tradeTasks(now,pins)}
function researchActivityTape(now){
 if(!RESEARCH_V2||gtPending('r1-activity'))return;
 const candidates=[...RESEARCH_V2.admitted.values()].map(row=>({row,c:C.get(row.mint)})).filter(({row,c})=>c?.p&&now-(c.activityAttemptAt||0)>10*60000&&now<require(DIR+'/event-clock.js').eventAnchor(row)+(require(DIR+'/research-runtime.js').phaseSettings(RESEARCH_V2.config,row.phase).hours*60+30)*60000).sort((a,b)=>(a.c.activityAttemptAt||0)-(b.c.activityAttemptAt||0));
 const item=candidates[0];if(!item)return;const {row,c}=item,pool=c.p,start=require(DIR+'/event-clock.js').eventAnchor(row),end=start+require(DIR+'/research-runtime.js').phaseSettings(RESEARCH_V2.config,row.phase).hours*3600000;c.activityAttemptAt=now;
 gt('/pools/'+pool+'/trades',1,'r1-activity').then(response=>{if(c.p!==pool)return;const api=require(DIR+'/activity-slices.js');c.activityTapePacked=api.pack(api.observe(api.unpack(c.activityTapePacked),response.data,c.a,start,end,Date.now()));const old=RESEARCH_V2.rows.find(r=>r.mint===row.mint);if(old){const coin=researchCoins().get(row.mint);if(coin){const raw=require(DIR+'/research-v2.js').activityEvidence(coin,start,end,RESEARCH_V2.config.decisionMinutes);old.activitySlicesPacked=api.pack(raw.activitySlices);delete old.activitySlices;RESEARCH_BANKS?.upsert([{...old,...require(DIR+'/research-v2.js').classifyActivity(old,require(DIR+'/research-runtime.js').phaseSettings(RESEARCH_V2.config,row.phase))}]);}}}).catch(e=>err('activity history '+e.message));
}
// One bounded public GT request per tick; this uses no Helius credits.
function researchTradeTail(now){if(!RESEARCH_V2||gtBackgroundBusy()||gtPending('r1-tail'))return;
 const entries=[...RESEARCH_V2.admitted.values()].filter(r=>{const c=C.get(r.mint),cfg=require(DIR+'/research-runtime.js').phaseSettings(RESEARCH_V2.config,r.phase),end=require(DIR+'/event-clock.js').eventAnchor(r)+cfg.hours*3600e3;return c?.p&&now>=end&&now-end<24*3600e3&&(c.outcomeTape?.windowEnd!==end||!c.outcomeTape?.activityEvidenceVersion)&&!c.outcomeTailBusy&&now-(c.outcomeTailTry||0)>15*60e3;}).sort((a,b)=>b.acceptedAt-a.acceptedAt);
 const row=entries[0];if(!row)return;const c=C.get(row.mint),cfg=require(DIR+'/research-runtime.js').phaseSettings(RESEARCH_V2.config,row.phase),end=require(DIR+'/event-clock.js').eventAnchor(row)+cfg.hours*3600e3;c.outcomeTailBusy=true;c.outcomeTailTry=now;
 gt(`/pools/${c.p}/trades`,2,'r1-tail').then(r=>{if(!Array.isArray(r.data))throw Error('Missing trade response');const at=Date.now(),rows=require(DIR+'/activity-slices.js').tradeRows(r.data,c.a,at);c.outcomeTape={activityEvidenceVersion:1,...require(DIR+'/research-v2.js').tradeOutcomeEvidence(rows,require(DIR+'/event-clock.js').eventAnchor(row),end,at)};if(RESEARCH_V2){RESEARCH_V2.processed.delete(row.mint);RESEARCH_V2.lastAttemptAt.delete(row.mint);}uploadLater(`observations-v2/research-trades/${dayKey(row.acceptedAt)}/${row.mint}-${end}.json`,{mint:row.mint,at,start:require(DIR+'/event-clock.js').eventAnchor(row),end,rows});}).catch(e=>err('research trade tail '+e.message)).finally(()=>{c.outcomeTailBusy=false;});
}
// сделки: последние 300 сделок пула; чаще, если монета активная. Покрытие проверяется по перекрытию запросов.
function sourceDecisionEnd(c){const row=SOURCE?.get(c.a);return row?require(DIR+'/event-clock.js').eventAnchor(row)+(PASS_V2?.config?.decisionMinutes||15)*60e3:0}
function gxTasks(now){if(gtPending('gx'))return;const list=[...C.values()].filter(c=>observedEligible(c)&&ageMin(c,now)>=2&&ageMin(c,now)<16&&now-(c.gxAt||0)>=(c.gxMiss?Math.min(10,2**c.gxMiss)*60e3:55e3)).sort((a,b)=>{
 const rank=c=>sourceDecisionEnd(c)>now?(isOk(c)?0:1):2;return rank(a)-rank(b)||b.t-a.t}).slice(0,30);
 if(!list.length)return;const requested=new Map(list.map(c=>[c.a,c.p])),pools=list.map(c=>c.p);
 gt(`/pools/multi/${pools.join(',')}`,1,'gx').then(r=>{const at=Date.now(),by={};(r.data||[]).forEach(d=>by[d.attributes?.address]=d.attributes);
  for(const c of list){if(c.p!==requested.get(c.a))continue;c.gxAt=at;const x=by[c.p];if(!x){c.gxMiss=(c.gxMiss||0)+1;continue}c.gxMiss=0;const T=x.transactions||{},V=x.volume_usd||{};
   const e=[Math.round(at/1000),T.m5?.buys??null,T.m5?.sells??null,T.m5?.buyers??null,T.m5?.sellers??null,T.m15?.buys??null,T.m15?.sells??null,T.m15?.buyers??null,T.m15?.sellers??null,
    V.m5!=null?Math.round(+V.m5):null,V.m15!=null?Math.round(+V.m15):null];(c.gx=c.gx||[]).push(e)}}).catch(e=>err('gx '+e.message))}
function tradeTasks(now,pins=collectionPins(now)){gxTasks(now);for(const c of C.values()){if(!observedEligible(c)||!collectionActive(c,now,pins)||c.trDone||c.trTry)continue;const a=ageMin(c,now);if(a<1)continue;
    const tr=c.tr=c.tr||{f:[],x:{}},last=tr.f[tr.f.length-1];
    if(a>40&&!last){finishTrades(c,'не успели (очередь)');continue}
    const busy=last&&last[1]>=250,since=last?(now-last[0])/1000:1e9;
    const due=!last&&a>=10.25;
    if(!due)continue;if(c.d==='pump-fun'&&!c.gx?.length){if(now>sourceDecisionEnd(c))finishTrades(c,'GT не подтвердил наличие пула');continue}const end=sourceDecisionEnd(c),fresh=end>now;if(!fresh&&gtBackgroundBusy())continue;const pool=c.p;c.trTry=1;
    gt(`/pools/${pool}/trades`,fresh?1:3,'tr:'+pool,fresh?end:0).then(r=>{if(c.p!==pool)return;const at=Date.now();let lo=Infinity,hi=0;
        for(const d of r.data||[]){const x=d.attributes||{};const ts=Math.floor(Date.parse(x.block_timestamp)/1000);if(!ts)continue;lo=Math.min(lo,ts);hi=Math.max(hi,ts);
          const pr=+(x.kind==='buy'?x.price_to_in_usd:x.price_from_in_usd)||0;tr.x[d.id||x.tx_hash]=[ts,x.kind==='buy'?1:0,+(+x.volume_in_usd||0).toFixed(2),x.tx_from_address||'',pr?+pr.toPrecision(6):null]}
        tr.f.push([at,(r.data||[]).length,isFinite(lo)?lo:null,hi||null]);
        if(at>=c.t+10*60e3+10e3)finishTrades(c,null)})
      .catch(e=>{if(e.code!=='OBSERVATION_COMPLETE')err('trades '+e.message)}).finally(()=>{c.trTry=0})}}
function rawArchiveName(c,kind){return `observations-v2/raw/${dayKey(c.t)}/${c.a}/${c.p}-${c.t}-${kind}.json`}
function finishTrades(c,why){const tr=c.tr;c.trDone=1;if(!tr||!tr.f.length){c.bx={miss:why||'нет запросов'};return}
  const t0=Math.floor(c.t/1000),end=t0+600;
  // покрытие: первый запрос дошёл до начала торговли (или в пуле меньше 300 сделок), каждый следующий перекрывает предыдущий
  let cov=tr.f[0][1]<300||(tr.f[0][2]!=null&&tr.f[0][2]<=t0+5);
  for(let i=1;i<tr.f.length;i++){const [,n,lo]=tr.f[i],prevHi=tr.f[i-1][3];if(!(n<300||(lo!=null&&prevHi!=null&&lo<=prevHi)))cov=false}
  const lastAt=tr.f[tr.f.length-1][0];if(lastAt<(end+5)*1000)cov=false;
  const L=Object.values(tr.x).filter(x=>x[0]>=t0-5&&x[0]<end);const B={},S=new Set();let buys=0,sells=0,bu=0,su=0;
  for(const [ts,k,usd,from] of L){if(k){buys++;bu+=usd;B[from]=B[from]||[0,0];B[from][0]++;B[from][1]+=usd}else{sells++;su+=usd;S.add(from)}}
  const bv=Object.values(B).map(x=>x[1]).sort((a,b)=>b-a),sum=a=>a.reduce((s,x)=>s+x,0);
  c.bx={at:lastAt,cov,n:L.length,buys,sells,buyUsd:Math.round(bu),sellUsd:Math.round(su),payers:Object.keys(B).length,earlyWallets:Object.keys(B).filter(w=>w.length>=32),sellers:S.size,
    repeat:Object.values(B).filter(x=>x[0]>=2).length,both:Object.keys(B).filter(k=>S.has(k)).length,
    top1:bu?+(bv[0]/bu).toFixed(3):null,top5:bu?+(sum(bv.slice(0,5))/bu).toFixed(3):null,fetches:tr.f.length,why:why||null};
  if(cov&&!c.k10){const M=new Map();for(const x of Object.values(tr.x).filter(x=>x[0]>=t0-60&&x[0]<end+60&&x[4]).sort((a,b)=>a[0]-b[0])){const m=Math.floor(x[0]/60)*60;const k=M.get(m);
      if(!k)M.set(m,[m,x[4],x[4],x[4],x[4],x[2]]);else{k[2]=Math.max(k[2],x[4]);k[3]=Math.min(k[3],x[4]);k[4]=x[4];k[5]+=x[2]}}
    if(M.size)c.k10={at:lastAt,src:'trades',c:[...M.values()].map(k=>[k[0],k[1],k[2],k[3],k[4],Math.round(k[5])])}}
  const name=rawArchiveName(c,'trades');c.archiveRefs={...(c.archiveRefs||{}),trades:name};uploadLater(name,{a:c.a,p:c.p,t:c.t,f:tr.f,x:tr.x});c.tr={f:tr.f}}

/* ---------- 4. блокчейн в моменте: держатели (3/5/10 мин), состояние пула и хранилищ (ключевые моменты + каждые 5 минут) ---------- */
const VAULT_OFF={[PUMP_AMM]:[139,171],[CPMM]:[72,104],[DAMM2]:[232,264],[AMM4]:[336,368],CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK:[137,169],LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo:[152,184],whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc:[133,213]};
const qDec=new Map([[WSOL,9],[USDC,6],[USDT,6]]);
const HOLD_M=[10],RAW_M=[1,3,5,10,15,30,60,120,240,480,720,1440];
const u64=(u,o)=>{let x=0n;for(let i=7;i>=0;i--)x=(x<<8n)+BigInt(u[o+i]);return Number(x)};
async function ensureVaults(c,pv){const rpc=rpcFor(c,'пулы');if(c.vaults)return;pv=pv||(await rpc('getAccountInfo',[c.p,{encoding:'base64'}]))?.value;if(!pv)return;
  const v=parseVaults(c,pv.owner,b64(pv.data?.[0]));if(!v)return;const ch=(await rpc('getMultipleAccounts',[v,{encoding:'base64'}]))?.value||[];
  const mints=ch.map(x=>x?pk(b64(x.data?.[0]),0):null);if(mints.includes(c.a)&&ch.every(Boolean)){c.vaults=v;c.vmint=mints}}
async function holdersSnap(c,m){const rpc=rpcFor(c,'держатели');const sup=c.ct?.supply;await ensureVaults(c);const r=await rpc('getTokenLargestAccounts',[c.a,{commitment:'confirmed'}]);const at=Date.now();
  const L=r?.value||[];if(!L.length||!sup){c.hold[m]={at,miss:'нет данных'};return}
  const own=await rpc('getMultipleAccounts',[L.map(x=>x.address),{encoding:'jsonParsed'}]);const V=new Set(c.vaults||[]);const by={};let ex=0,pda=0;
  L.forEach((x,i)=>{if(V.has(x.address)){ex++;return}const o=own?.value?.[i]?.data?.parsed?.info?.owner||x.address;const amt=+x.uiAmount||0;by[o]=(by[o]||0)+amt});
  const arr=Object.entries(by).sort((a,b)=>b[1]-a[1]);for(const [o,amt] of arr){try{if(!onCurve(b58dec(o)))pda+=amt}catch{}}
  const sh=n=>+(arr.slice(0,n).reduce((s,x)=>s+x[1],0)/sup).toFixed(4);
  c.hold[m]={at,slot:r.context?.slot,slot2:own?.context?.slot,top1:sh(1),top5:sh(5),top10:sh(10),pda:+(pda/sup).toFixed(4),poolEx:ex,vaultsKnown:!!c.vaults}}
function parseVaults(c,owner,u){const off=VAULT_OFF[owner];if(!off||u.length<off[1]+32)return null;return off.map(o=>pk(u,o))}
function poolInterval(c,now=Date.now()){return ageMin(c,now)<120?5*60e3:30*60e3}
function budgetEventSummary(now=Date.now()){
  const sources=Object.fromEntries(['dbc','ll','pump'].map(x=>[x,{skippedMigrationEvents:0,deferredPending:0,reconcilePending:RC.pend?.[x]?.length||0,rawWindowsMissedBudget:0,holderWindowsMissedBudget:0}]));
  for(const c of C.values()){const x=sources[budgetSource(c)]||sources.pump;
    if(c.proofBudgetDeferredAt){if(!isOk(c)&&!needMig(c,now))x.skippedMigrationEvents++;else if(!isOk(c))x.deferredPending++}
    for(const r of Object.values(c.raw||{}))if(r.miss&&r.reason==='budget')x.rawWindowsMissedBudget++;
    for(const r of Object.values(c.hold||{}))if(r.miss==='бюджет')x.holderWindowsMissedBudget++;
  }
  return {since:STARTED,sources,pre:{skippedBudget:PRE?.summary().budgetDeferred||0,skippedCapacity:PRE?.summary().dropped||0,
    pausedMs:WS.preGapMs+(WS.prePausedAt?now-WS.prePausedAt:0),unreceivedEvents:null}};
}
function poolCoverage(now=Date.now()){
  const out={eligible:0,withVaults:0,withBalances:0,current:0,due:0,budgetDeferred:0,rawWindowsMissed:0,oldestOverdueSec:0};
  for(const c of C.values()){if(!isOk(c)||ageMin(c,now)<0||ageMin(c,now)>24*60+15)continue;out.eligible++;
    if(c.vaults)out.withVaults++;if(c.lq?.length)out.withBalances++;
    const overdue=now-(c.lqAt||c.t)-poolInterval(c,now);
    if(c.lqAt&&overdue<0)out.current++;else{out.due++;out.oldestOverdueSec=Math.max(out.oldestOverdueSec,Math.max(0,Math.round(overdue/1000)))}
    if(c.poolBudgetDeferredAt)out.budgetDeferred++;
    for(const x of Object.values(c.raw||{}))if(x.miss)out.rawWindowsMissed++;
  }return out;
}
async function collectPoolBatch(part){
  const call=(keys)=>rpc('getMultipleAccounts',[keys,{encoding:'base64'}],{priority:'pools',context:'пулы',source:'пулы'});
  const keys=[];for(const [c] of part)keys.push(c.p,...(c.vaults||[]));
  const r=await call(keys),at=Date.now(),slot=r?.context?.slot,V=r?.value||[];let j=0;const rows=[],missing=[];
  for(const [c,rm] of part){const pv=V[j++],vs=(c.vaults||[]).map(()=>V[j++]);
    if(!pv){c.poolMissingAt=at;continue}
    // Preserve the received state even if the second batch is budget-deferred.
    if(rm!=null)c.raw[rm]={at,slot,b:[pv.data?.[0],...vs.map(x=>x?.data?.[0]||null)]};
    const vaults=parseVaults(c,pv.owner,b64(pv.data?.[0]));
    if(!vaults){c.poolUnsupported=pv.owner;continue}
    const row={c,rm,pv,vaults,vs,at,slot};rows.push(row);
    if(vs.length!==2||vaults.some((v,i)=>v!==c.vaults?.[i])){row.vs=[];missing.push(row)}
  }
  const commit=row=>{const {c,rm,vaults,vs}=row;if(vs.length!==2||vs.some(x=>!x||b64(x.data?.[0]).length<72)){c.vaultMissingAt=Date.now();return}
    const mints=vs.map(x=>pk(b64(x.data?.[0]),0));if(!mints.includes(c.a)){c.vaultMismatchAt=Date.now();return}
    c.vaults=vaults;c.vmint=mints;c.vaultIdentityAt=c.vaultIdentityAt||row.at;
    const am=vs.map(x=>u64(b64(x.data?.[0]),64));c.lq=c.lq||[];c.lq.push([Math.round(row.at/1000),row.slot,...am]);if(c.lq.length>320)c.lq.splice(10,1);
    c.lqAt=row.at;delete c.poolBudgetDeferredAt;
    if(rm!=null&&c.raw[rm])Object.assign(c.raw[rm],{vaultAt:row.at,vaultSlot:row.slot,b:[row.pv.data?.[0],...vs.map(x=>x.data?.[0])]});
  };
  rows.filter(x=>x.vs.length===2).forEach(commit);
  if(missing.length){const extra=await call(missing.flatMap(x=>x.vaults)),vat=Date.now(),vals=extra?.value||[];
    missing.forEach((row,i)=>{row.vs=vals.slice(i*2,i*2+2);row.at=vat;row.slot=extra?.context?.slot;commit(row)})}
}
async function chainObsLoop(){for(;;){const now=Date.now();
  try{
    // Pool balances precede holders. Oldest due observations are served first.
    if(now-(globalThis.lastPools||0)>=10000){globalThis.lastPools=now;if(now-(globalThis.lastPreUrgent||0)>=30000&&SOURCE?.latest(200).some(r=>{const c=C.get(r.mint);return c&&(!c.ct||!c.n||!c.s||(!c.i&&!c.uri));})){globalThis.lastPreUrgent=now;await preChainSweep();}const jobs=[];
      for(const c of C.values()){if(!isOk(c))continue;const a=ageMin(c,now);if(a<0||a>24*60+15)continue;c.raw=c.raw||{};
        const rm=RAW_M.find(m=>!c.raw[m]&&a>=m&&a<m+Math.max(2,m*.1));
        for(const m of RAW_M)if(!c.raw[m]&&a>=m+Math.max(2,m*.1))c.raw[m]={at:now,miss:1,reason:c.poolBudgetDeferredAt?'budget':'not-observed'};
        if(rm!=null||!c.lqAt||now-c.lqAt>=poolInterval(c,now))jobs.push([c,rm])}
      RESOURCE.poolsPending=jobs.length>0;
      const urgent=c=>SOURCE?.get(c.a)&&now-c.t<15*60e3&&!c.lq?.length?1:0;
      jobs.sort((a,b)=>urgent(b[0])-urgent(a[0])||(a[0].poolAttemptAt||0)-(b[0].poolAttemptAt||0)||(a[0].lqAt||0)-(b[0].lqAt||0));
      for(let i=0;i<jobs.length;i+=33){const part=jobs.slice(i,i+33);part.forEach(([c])=>c.poolAttemptAt=now);
        try{await collectPoolBatch(part);if(i+33>=jobs.length)RESOURCE.poolsPending=false}catch(e){if(e.code!=='BUDGET_DEFERRED')throw e;
          for(const [c] of jobs.slice(i))c.poolBudgetDeferredAt=c.poolBudgetDeferredAt||Date.now();break}}
    }
    // Держатели — только у монет, допущенных в «Все» после миграции: опоздавшие нам не нужны, а бюджет ограничен.
    for(const c of C.values()){if(!isOk(c)||!c.ct||SOURCE?.get(c.a)?.phase!=='after')continue;c.hold=c.hold||{};const a=ageMin(c,now);
      for(const m of HOLD_M){if(c.hold[m])continue;if(a>=m+2){c.hold[m]={at:now,miss:c.holderBudgetDeferredAt?'бюджет':'опоздали'};continue}
        if(a>=m)try{await holdersSnap(c,m);delete c.holderBudgetDeferredAt}catch(e){if(e.code==='BUDGET_DEFERRED'){c.holderBudgetDeferredAt=c.holderBudgetDeferredAt||Date.now();continue}
          c.hold[m]={at:Date.now(),miss:'ошибка'};err('hold '+e.message)}}}
    for(const c of C.values())if(isOk(c)&&c.vmint&&!c.vdec){c.vdec=await Promise.all(c.vmint.map(async mt=>{if(mt===c.a)return c.ct?.dec??null;if(qDec.has(mt))return qDec.get(mt);
      const v=(await rpc('getAccountInfo',[mt,{encoding:'jsonParsed'}],{priority:'holders',context:'держатели'}))?.value;const d=v?.data?.parsed?.info?.decimals;if(d!=null)qDec.set(mt,+d);return d??null}))}
    for(const c of C.values())if(c.raw&&ageMin(c,now)>24*60+20&&!c.rawUp){const name=rawArchiveName(c,'state');c.archiveRefs={...(c.archiveRefs||{}),rawStates:name};uploadLater(name,{a:c.a,p:c.p,t:c.t,vaults:c.vaults,raw:c.raw});c.rawUp=1;
      c.raw=Object.fromEntries(Object.entries(c.raw).map(([m,x])=>[m,{at:x.at,slot:x.slot,miss:x.miss}]))}
  }catch(e){if(e.code!=='BUDGET_DEFERRED')err('chainobs '+e.message)}
  await sleep(10000)}}

/* ---------- 5. сверка полноты: снимки состояния программ (LaunchLab «вышла», Meteora DBC «мигрировала») раз в 30 минут.
   Новые «вышедшие» кривые = кандидаты; миграция всё равно доказывается транзакцией, время — из блока. ---------- */
let RC={ll:null,dbc:null,log:[]};
function hiWin(hi){const b=Buffer.alloc(6);b.writeUInt16LE(hi&0xffff,0);return b58enc(b)}
async function snapshotSet(key){const rpc=(method,params)=>globalRPC(method,params,{priority:'reconcile',context:'сверка',source:key});
  if(key==='ll'){const r=await rpc('getProgramAccounts',[LAUNCH,{encoding:'base64',dataSlice:{offset:0,length:0},filters:[{memcmp:{offset:17,bytes:'3'}}],withContext:true}]);return (r?.value||[]).map(x=>x.pubkey)}
  // DBC: все пулы слишком велики для одного запроса — берём только кривые с точкой активации (слот или unix-время, u64 @296) в двух последних окнах по 65536
  const slot=await rpc('getSlot',[]),nowS=Math.floor(Date.now()/1000),out=new Set();
  for(const v of [slot,nowS])for(const d of [0,1]){const r=await rpc('getProgramAccounts',[DBC,{encoding:'base64',dataSlice:{offset:0,length:0},
      filters:[{dataSize:424},{memcmp:{offset:305,bytes:'2'}},{memcmp:{offset:298,bytes:hiWin((v>>>16)-d)}}],withContext:true}]);(r?.value||[]).forEach(x=>out.add(x.pubkey))}
  return [...out]}
let RECON_BUSY=false,RECON_RETRY=null;
async function reconcile(){if(RECON_BUSY)return;RECON_BUSY=true;try{await reconcileBody()}finally{RECON_BUSY=false}}
async function reconcileBody(){const now=Date.now();const rpc=(method,params)=>globalRPC(method,params,{priority:'reconcile',context:'сверка'});CTX='сверка';
  for(const [key,mOff,qOff] of [['ll',205,237],['dbc',136,null]]){
    try{const cur=await snapshotSet(key);const prev=RC[key]?new Set(RC[key]):null;RC[key]=cur;
      if(!prev){RC.log.push([now,key,'база',cur.length]);continue}
      RC.pend=RC.pend||{};const all=[...(RC.pend[key]||[]),...cur.filter(x=>!prev.has(x))];const nw=[...new Set(all)].slice(0,300);RC.pend[key]=[...new Set(all)];let known=0,added=0,forced=0;
      for(let i=0;i<nw.length;i+=100){const v=(await rpc('getMultipleAccounts',[nw.slice(i,i+100),{encoding:'base64'}]))?.value||[];
        v.forEach((acc,j)=>{if(!acc)return;const u=b64(acc.data?.[0]);const mint=pk(u,mOff),quote=qOff?pk(u,qOff):null;SOURCE?.observe({mint,phase:'after',origin:'reconcile'});let c=C.get(mint);if(!c&&typeof COMPLETED!=='undefined'&&COMPLETED){const old=COMPLETED.metadata(mint);if(old?.poolKeys.includes(nw[i+j])){known++;return}if(old){c=COMPLETED.readCoin(mint);C.set(mint,c)}}
          if(c&&isOk(c)){c.discoverySource=key;known++;c.rcSeen=c.rcSeen||now;return}
          if(c){queueMigrationSignal(c,now);c.discoverySource=key;if(c.mg)c.mg.force=1;c.rcSeen=now;c.firstPostSeenAt=c.firstPostSeenAt||now;forced++;return}
          C.set(mint,{a:mint,n:'',s:'',i:'',p:nw[i+j],d:key==='ll'?'raydium-launchlab':'meteora-dbc',q:quote,t:now,tSrc:'recon',seen:now,disc:'chain',discoverySource:key,proofEnqueuedAt:now,rcSeen:now,firstPostSeenAt:now,pools:[nw[i+j]],fv:FV});added++});const done=new Set(nw.slice(i,i+100));RC.pend[key]=RC.pend[key].filter(x=>!done.has(x))}
      RC.log.push([now,key,'новых',nw.length,known,forced,added])}catch(e){if(e.code==='BUDGET_DEFERRED'){if(!RECON_RETRY)RECON_RETRY=setTimeout(()=>{RECON_RETRY=null;reconcile().catch(e=>err('recon retry '+e.message))},65000)}else err('recon '+key+' '+e.message)}}
  while(RC.log.length>200)RC.log.shift()}

/* ---------- 5б. подписки на блокчейн: миграции видны сразу, без GeckoTerminal ----------
   Meteora DBC: кривые с флагом «мигрировала»; LaunchLab: кривые со статусом 2; PumpSwap: аккаунты пулов с index = 0 (создаются один раз).
   Это только кандидаты — миграция всё равно доказывается транзакцией. */
const WS={on:false,preOn:false,preSub:false,connected:{dbc:false,ll:false},preBudgetPauses:0,prePausedAt:0,preGapMs:0,bytes:0,msgs:{},cand:{},err:0,since:0};const wsSeen=new Map();
function wsCandidate(kind,acc,u,slot,owner){const now=Date.now();if(wsSeen.has(acc)&&now-wsSeen.get(acc)<6*3600e3)return;wsSeen.set(acc,now);
  if(wsSeen.size>20000)for(const [k,t] of wsSeen)if(now-t>6*3600e3)wsSeen.delete(k);
  let mint=null,quote=null,pool=acc;
  if(kind==='dbc'){mint=pk(u,136)}
  else if(kind==='ll'){mint=pk(u,205);quote=pk(u,237)}
  else if(kind==='pump'){const b=pk(u,43),q=pk(u,75);if(SKIP.has(b)){mint=q;quote=b}else{mint=b;quote=q}if(SKIP.has(mint))return}
  if(!mint)return;if(kind==='dbc'||kind==='ll')offerFastMigration({curve:acc,mint,slot,kind});SOURCE?.observe({mint,phase:'after',origin:'ws-'+kind});WS.cand[kind]=(WS.cand[kind]||0)+1;let c=C.get(mint);if(!c&&typeof COMPLETED!=='undefined'&&COMPLETED){const old=COMPLETED.metadata(mint);if(old?.poolKeys.includes(pool))return;if(old){c=COMPLETED.readCoin(mint);C.set(mint,c)}}
  const snapshot=((kind==='dbc'&&owner===DBC&&u.length===424&&u[305]===1)||(kind==='ll'&&owner===LAUNCH&&u.length>268&&u[17]===2))?{address:acc,owner,at:now,slot:slot||null,data:Buffer.from(u).toString('base64')}:null;
  if(c){if(snapshot)c.wsMigrationSnapshot=snapshot;c.migrationSlot=slot||c.migrationSlot;c.migrationSignalAt=now;queueMigrationSignal(c,now);c.discoverySource=kind;if(!isOk(c)&&c.mg)c.mg.force=1;c.wsSeen=c.wsSeen||now;c.firstPostSeenAt=c.firstPostSeenAt||now;return}
  C.set(mint,{a:mint,n:'',s:'',i:'',p:pool,d:kind==='pump'?'pumpswap':kind==='ll'?'raydium-launchlab':'meteora-dbc',q:quote,t:now,tSrc:'ws',wsMigrationSnapshot:snapshot,migrationSlot:slot||null,migrationSignalAt:now,seen:now,disc:'ws',discoverySource:kind,proofEnqueuedAt:now,wsSeen:now,firstPostSeenAt:now,pools:[pool],fv:FV})}
/* Миграция pump.fun в реальном времени: подписка на кривые pump с complete=1 (байт 48).
   Завершённая кривая больше не торгуется, поэтому сообщений мало: завершение + опустошение при миграции.
   Монету по адресу кривой знаем из create (карта CURVE2MINT) — без RPC. Неизвестные кривые просто считаем. */
// Поток «до миграции» считается рабочим, если create приходили последние 10 мин (короткие бюджетные паузы не = «нет данных»)
function preFlowing(){const at=PRE?.summary?.()?.lastAt;return !!PRE&&Number.isFinite(at)&&Date.now()-at<10*60e3}
const CURVE2MINT=new Map();
function rememberCurve(ev){if(!ev||!ev.curve||!ev.mint)return;CURVE2MINT.set(ev.curve,{mint:ev.mint,q:ev.quote||WSOL,n:ev.name||'',s:ev.symbol||'',t:ev.blockAt||ev.observedAt||Date.now()});
  if(CURVE2MINT.size>80000){const cut=Date.now()-30*3600e3;for(const [k,v] of CURVE2MINT){if(v.t<cut)CURVE2MINT.delete(k);if(CURVE2MINT.size<=70000)break}}}
/* Неизвестная кривая (create пришёл во время паузы потока): монету берём из последних транзакций кривой.
   Инструкция pump (buy/sell/migrate): accounts[2]=mint, accounts[3]=кривая. Подтверждение — PDA кривой из mint. ~2 кредита. */
const CURVE_RESOLVING=new Set(),CURVE_FAILED=new Map();
async function resolveCurve(curve,slot){if(CURVE_RESOLVING.has(curve)||(CURVE_FAILED.get(curve)||0)>Date.now()||CURVE_RESOLVING.size>5)return;CURVE_RESOLVING.add(curve);
  try{const opt={priority:'migration',context:'миграция',source:'pump-complete'};
    const sigs=(await rpc('getSignaturesForAddress',[curve,{limit:3,commitment:'confirmed'}],opt))||[];
    for(const sg of sigs){if(sg.err)continue;const tx=await rpc('getTransaction',[sg.signature,{encoding:'json',maxSupportedTransactionVersion:0,commitment:'confirmed'}],opt);if(!tx)continue;
      const keys=[...(tx.transaction?.message?.accountKeys||[]),...(tx.meta?.loadedAddresses?.writable||[]),...(tx.meta?.loadedAddresses?.readonly||[])];
      const ixs=[...(tx.transaction?.message?.instructions||[]),...(tx.meta?.innerInstructions||[]).flatMap(x=>x.instructions||[])];
      for(const ix of ixs){if(keys[ix.programIdIndex]!==PUMP||!Array.isArray(ix.accounts)||ix.accounts.length<4)continue;
        const mint=keys[ix.accounts[2]];if(keys[ix.accounts[3]]!==curve||!mint)continue;
        if(await bondingCurveOf(mint)!==curve)continue;
        WS.pcResolved=(WS.pcResolved||0)+1;rememberCurve({curve,mint,quote:WSOL,observedAt:Date.now()});
        const acc=(await rpc('getAccountInfo',[curve,{encoding:'base64',dataSlice:{offset:0,length:49}}],opt))?.value;
        if(acc)pumpCurveComplete(curve,b64(acc.data?.[0]),slot);return}}
    CURVE_FAILED.set(curve,Date.now()+30*60e3);WS.pcUnresolved=(WS.pcUnresolved||0)+1}
  catch(e){CURVE_FAILED.set(curve,Date.now()+(e.code==='BUDGET_DEFERRED'?60e3:10*60e3));if(e.code!=='BUDGET_DEFERRED')err('pump curve '+e.message)}
  finally{CURVE_RESOLVING.delete(curve)}}
function pumpCurveComplete(curve,u,slot){const now=Date.now();if(!u||u.length<49||!u[48])return;
  const info=CURVE2MINT.get(curve);if(!info){WS.pcUnknown=(WS.pcUnknown||0)+1;resolveCurve(curve,slot);return}
  WS.pcKnown=(WS.pcKnown||0)+1;let c=C.get(info.mint);
  if(c&&isOk(c))return;
  if(!c){c={a:info.mint,n:info.n,s:info.s,i:'',p:curve,d:'pump-fun',q:info.q,t:info.t,tSrc:'pre',preTradingAt:info.t,seen:now,disc:'ws-pump-complete',
      preCurve:1,pools:[curve],fv:FV,mg:{v:MGV,st:'curve',k:'curve-pump',lastAt:now}};C.set(info.mint,c)}
  if(SOURCE?.get(c.a)?.phase==='after')return; // уже в «Все» как «до миграции»: второй вход запрещён
  c.migrationSlot=slot||c.migrationSlot;c.migrationSignalAt=now;c.discoverySource='pump-complete';c.wsSeen=c.wsSeen||now;
  queueMigrationSignal(c,now);if(c.mg){c.mg.force=1;delete c.mg.final}}
async function processFastMigration(task){
 if(task.mint&&SOURCE.get(task.mint)?.phase==='after')return {outcome:'already-admitted'};
 const api=require(DIR+'/migration-fast.js'),options={priority:'migration-fast',context:'миграция:быстро',source:'migration-fast',urgent:true,maxBytes:3*1024*1024};
 let signatures=task.signature?[task.signature]:Object.keys(task.proofs||{}).filter(sig=>task.proofs[sig].some(v=>v.curve===task.curve));let outcome=null,proofSeen=false;
 if(!signatures.length){const rows=await rpc('getSignaturesForAddress',[task.curve,{limit:6,commitment:'confirmed'}],{...options,cache:false});signatures=(rows||[]).filter(r=>r.err===null&&(!task.slot||Math.abs(r.slot-task.slot)<=2)).map(r=>r.signature).slice(0,6);}
 if(!signatures.length)throw Object.assign(Error('migration transaction pending'),{code:'TX_PENDING'});
 task.proofs=task.proofs||{};
 for(const signature of signatures){const tx=task.proofs[signature]?null:await rpc('getTransaction',[signature,{encoding:'json',maxSupportedTransactionVersion:1,commitment:'confirmed'}],options);if(!tx&&!task.proofs[signature])throw Object.assign(Error('migration transaction pending'),{code:'TX_PENDING'});
  if(tx&&tx.slot===task.slot&&api.administrativeUpdate(tx,task.curve,b58dec))task.administrativeUpdate=true;
  const candidates=task.proofs[signature]||(task.proofs[signature]=api.migrationCandidates(tx,b58dec));
  for(const v of candidates){if(v.signature!==signature||(task.curve&&v.curve!==task.curve))continue;proofSeen=true;task.mint=v.mint;let official=false;
   if(v.family==='pump')official=await bondingCurveOf(v.mint)===v.curve&&await canonicalPoolOf(v.mint,v.quote)===v.pool;
   else if(v.family==='launch'){const [a,b]=cmpAsc(v.mint,v.quote);official=await launchPoolOf(v.mint,v.quote)===v.curve&&await findPDA([new TextEncoder().encode('pool'),b58dec(v.config),b58dec(a),b58dec(b)],CPMM)===v.pool;}
   else if(v.family==='launch-v4')official=await launchPoolOf(v.mint,v.quote)===v.curve&&await findPDA([b58dec(AMM4),b58dec(v.market),new TextEncoder().encode('amm_associated_seed')],AMM4)===v.pool;
   else if(v.family==='dbc-v1'){const [a,b]=orderKeys(v.mint,v.quote);official=await findPDA([a,b,b58dec(v.config)],DAMM1)===v.pool;}
   else if(v.family==='dbc'){official=(await officialPools('dbc',v.mint,v.quote)).includes(v.pool);if(!official){const account=(await rpc('getAccountInfo',[v.pool,{encoding:'base64',commitment:'confirmed'}],options))?.value;if(!account)throw Object.assign(Error('confirmed migration pool account pending'),{code:'TX_PENDING'});const u=b64(account?.data?.[0]);official=account?.owner===DAMM2&&u?.length>=680&&pk(u,648)===DBC_AUTH&&pair2(u,168,200,v.mint)===v.quote;}}
   if(!official)continue;SOURCE.observe({mint:v.mint,phase:'after',at:task.receivedAt,origin:'fast-'+task.kind});if(SOURCE.get(v.mint)?.phase==='after'){outcome='already-admitted';if(task.curve)return {outcome};continue;}
   const now=Date.now(),limit=SOURCE.settings().afterMinutes*60000;if(v.eventAt>now)throw Object.assign(Error('migration block clock pending'),{code:'TX_PENDING'});if(now-v.eventAt>limit){SOURCE.observe({mint:v.mint,phase:'after',outcome:'tooOld',lateMs:now-v.eventAt-limit});outcome='too-old';if(task.curve)return {outcome};continue;}
   const family=v.family==='dbc-v1'?'dbc':v.family;let c=C.get(v.mint);if(!c){c={a:v.mint,n:'',s:'',i:'',p:v.pool,d:DEXOF[family],q:v.quote,t:v.eventAt,seen:task.receivedAt,firstPostSeenAt:Math.max(task.receivedAt,v.eventAt),disc:'migration-signature',discoverySource:'migration-fast',pools:[v.pool],fv:FV};C.set(v.mint,c)}else moveTo(c,v.pool,family,{t:v.eventAt});
   c.openingMetrics={pool:v.pool,quoteMint:v.quote,at:now,eventAt:v.eventAt,scope:'creation-transaction-end',liquiditySol:v.openingQuoteSol,liquidityUsd:null,marketCapUsd:null,liquidityToMarketCap:null,creatorAddress:null,creatorDepositSol:null,lpEvidence:null};c.q=v.quote;if(v.baseVault&&v.quoteVault&&Number.isFinite(v.openingQuoteSol)){c.vaults=[v.baseVault,v.quoteVault];c.vmint=[v.mint,v.quote];c.vaultIdentityAt=now;c.lq=c.lq||[];c.lq.push([Math.floor(now/1000),v.slot,null,Math.round(v.openingQuoteSol*1e9)]);c.lqAt=now;}c.admissionVerifiedAt=now;c.t=v.eventAt;c.migrationSlot=v.slot;c.migrationSignalAt=task.receivedAt;c.wsSeen=Math.max(task.receivedAt,v.eventAt);c.firstPostSeenAt=c.wsSeen;c.preCurve=0;
   setMg(c,'ok',family,'',{owner:v.dexProgram,pool:v.pool,sig:signature,mT:v.eventAt,ix:v.ix});const decision=SOURCE.afterVerifiedMigration(c);if(decision.admitted){FAST_DISCOVERY.accepted('after',v.eventAt,family,now);c.admissionVerifiedAt=now;outcome='accepted';}else outcome=decision.reason||'unverified';
   if(task.curve)return {outcome};
  }
 }
 if(!outcome&&task.administrativeUpdate){if(task.mint)SOURCE.observe({mint:task.mint,phase:'after',origin:'ws-'+task.kind,reason:'non-migration-update'});return {outcome:'non-migration-update'};}
 if(!outcome)throw Object.assign(Error('migration instruction or official pool proof not found'),{code:task.curve&&!proofSeen?'TX_PENDING':'PROOF_NOT_FOUND'});
 return {outcome};
}
async function processManualPool(task){
 const api=require(DIR+'/manual-pools.js'),options={priority:'pool-discovery',context:'ручные пулы',source:'pool-discovery',urgent:true,maxBytes:3*1024*1024};
 if(!task.candidates){const tx=await rpc('getTransaction',[task.signature,{encoding:'json',maxSupportedTransactionVersion:1,commitment:'confirmed'}],options);if(!tx)throw Object.assign(Error('manual pool transaction pending'),{code:'TX_PENDING'});if(require(DIR+'/migration-fast.js').migrationCandidates(tx,b58dec).length)return {outcome:'migration-excluded'};task.candidates=api.manualPoolCandidates(tx,b58dec);}
 if(!task.candidates.length)return {outcome:'not-direct-sol-pool'};
 let outcome='not-direct-sol-pool';
 for(const v of task.candidates){task.mint=v.mint;if(SOURCE.has(v.mint)){outcome=SOURCE.get(v.mint)?.proof?.pool===v.pool?'already-admitted':'rejected-side-pool';continue;}SOURCE.observe({mint:v.mint,phase:'before',origin:'manual-pool'});
  const now=Date.now(),limit=SOURCE.settings().beforeMinutes*60000;if(now-v.eventAt>limit){SOURCE.observe({mint:v.mint,phase:'before',outcome:'tooOld',lateMs:now-v.eventAt-limit,origin:'manual-pool'});outcome='too-old';continue;}
  const guard=require(DIR+'/side-pools.js');if(task.catalogueCheckedMint!==v.mint){try{task.earlierPair=!!(await guard.catalogue(v));task.catalogueCheckedMint=v.mint;}catch{throw Object.assign(Error('pool catalogue pending'),{code:'TX_PENDING',retryAfterMs:5000});}}if(task.earlierPair){SOURCE.observe({mint:v.mint,phase:'before',outcome:'rejectedSidePool',origin:'manual-pool',reason:'earlier-pool'});outcome='rejected-side-pool';continue;}
  const curve=await bondingCurveOf(v.mint),llCurve=await launchPoolOf(v.mint,WSOL);
  const r=await rpc('getMultipleAccounts',[[v.pool,v.mint,v.baseVault,v.quoteVault,curve,llCurve],{encoding:'jsonParsed',commitment:'confirmed'}],options),at=Date.now();if(!r?.value?.[0])throw Object.assign(Error('manual pool account pending'),{code:'TX_PENDING'});
  const active=guard.activeCurve(r.value[4],PUMP),launchActive=guard.activeCurve(r.value[5],LAUNCH);if(active==null||launchActive==null)throw Object.assign(Error('launchpad curve state pending'),{code:'TX_PENDING'});if(active||launchActive){SOURCE.observe({mint:v.mint,phase:'before',outcome:'rejectedSidePool',origin:'manual-pool',reason:active?'active-pump-curve':'active-launchlab-curve'});outcome='rejected-side-pool';continue;}
  const snapshot=api.poolSnapshot(v,r.value);if(!snapshot)return {outcome:'unverified'};if(!snapshot.funded)throw Object.assign(Error('manual pool liquidity pending'),{code:'TX_PENDING',retryAfterMs:20000});
  const opening={pool:v.pool,quoteMint:WSOL,eventAt:v.eventAt,at,scope:'creation-transaction-end',liquiditySol:v.liquiditySol,liquidityUsd:null,marketCapUsd:null,liquidityToMarketCap:null,creatorAddress:v.creatorAddress,creatorDepositSol:null,lpEvidence:null};
  const ct=ctFromMint(r.value[1]);ct.at=at;const proof={kind:'manual-pool-open-v1',poolEpoch:POOL_TRANSITION.poolEpoch,pool:v.pool,signature:task.signature,slot:v.slot,timeSource:'block',family:'manual-pool',dex:v.dex,dexProgram:v.dexProgram,launchpad:null,venue:v.dex,quote:WSOL,baseVault:v.baseVault,quoteVault:v.quoteVault,creatorAddress:v.creatorAddress,fundedAt:at,verifiedAt:at,openingMetrics:opening,ct};
  const decision=SOURCE.before({mint:v.mint,publicTradingAt:v.eventAt,observedAt:at,verified:true,proof});if(!decision.admitted){outcome=decision.reason;continue;}
  const c={a:v.mint,n:'',s:'',i:'',p:v.pool,d:({'PumpSwap':'pumpswap','Raydium CPMM':'raydium-cpmm','Raydium CLMM':'raydium-clmm','Meteora DLMM':'meteora-dlmm','Meteora DAMM v2':'meteora-damm-v2','Orca':'orca-whirlpools'})[v.dex],q:WSOL,t:v.eventAt,seen:task.receivedAt,disc:'manual-pool',discoverySource:'manual-pool',preCurve:0,pools:[v.pool],fv:FV,ct,creatorAddress:v.creatorAddress,creatorObservedAt:at,supplyRaw:snapshot.supplyRaw,openingMetrics:opening,admissionVerifiedAt:at,launchpad:null,dex:v.dex,venue:v.dex,vaults:[v.baseVault,v.quoteVault],vmint:[v.mint,WSOL],vdec:[snapshot.decimals,9],vaultIdentityAt:at,lq:[[Math.round(at/1000),r.context?.slot,snapshot.baseRaw,snapshot.quoteRaw]],lqAt:at};
  setMg(c,'ok','manual-pool','',{owner:v.dexProgram,pool:v.pool,sig:task.signature,mT:v.eventAt});C.set(v.mint,c);POOL_DISCOVERY.accepted('pool',v.eventAt,null,at);outcome='accepted';
 }
 return {outcome};
}
const MANUAL_AUDIT={checked:0,revoked:0,errors:0,busy:false,lastAt:0};const MANUAL_AUDITED=new Map();
async function auditManualPools(){if(MANUAL_AUDIT.busy||!SOURCE)return;MANUAL_AUDIT.busy=true;try{for(let checked=0;checked<4;checked++){
 const row=[...SOURCE.records.values()].sort((a,b)=>(MANUAL_AUDITED.get(a.mint)||0)-(MANUAL_AUDITED.get(b.mint)||0)).find(r=>r.proof?.kind==='manual-pool-open-v1'&&Date.now()-r.acceptedAt<26*3600e3&&Date.now()-(MANUAL_AUDITED.get(r.mint)||0)>5*60e3);if(!row)return;
 const earlier=await require(DIR+'/side-pools.js').catalogue({mint:row.mint,pool:row.proof.pool,eventAt:row.eventAt});MANUAL_AUDIT.checked++;MANUAL_AUDITED.set(row.mint,Date.now());while(MANUAL_AUDITED.size>2000)MANUAL_AUDITED.delete(MANUAL_AUDITED.keys().next().value);MANUAL_AUDIT.lastAt=Date.now();
 if(earlier&&SOURCE.revokeManualPool(row.mint,'earlier-pool')){MANUAL_AUDIT.revoked++;C.delete(row.mint);RESEARCH_V2?.pruneRevoked(SOURCE.revokedManual);RESEARCH_TWO?.pruneRevoked(SOURCE.revokedManual);if(PASS_V2?.records.get(row.mint)?.phase==='before')PASS_V2.records.delete(row.mint);RESEARCH_BANKS?.removeRevoked(SOURCE.revokedManual);save();}
 }}catch{MANUAL_AUDIT.errors++;}finally{MANUAL_AUDIT.busy=false}}
function discoveryStatus(){const x=FAST_DISCOVERY?.summary();if(!x)return null;return {...x,manualPoolStreamReady:POOL_LOGS?.summary().available===true,latency:{...x.latency,pool:POOL_DISCOVERY?.summary().latency.pool||x.latency.pool}};}
function offerFastMigration(task){if(!FAST_DISCOVERY)return;FAST_DISCOVERY.offer({...task,receivedAt:Date.now()});}
function chainWatch(){
  RESOURCE.migrationWSOnly=true;RESOURCE.freshMigrationReserve=6; // fresh signatures precede legacy migration lookups
  FAST_DISCOVERY=new (require(DIR+'/migration-fast.js').FastSignals)({process:processFastMigration,onPending:n=>{RESOURCE.freshMigrationPending=n},onError:(e,task)=>{if(task?.mint)SOURCE?.observe({mint:task.mint,phase:'after',origin:'fast-'+task.kind,reason:e.code||'RPC_ERROR'});err('fast migration '+(e.code||'RPC_ERROR')+' '+e.message)}});
  const PUMP_WITHDRAW_AUTH=require(DIR+'/migration-fast.js').PUMP_WITHDRAW_AUTH;
  const connect=async(channel)=>{const key=await heliusKey();if(!key||(channel==='pre'&&(!PRE||!RESOURCE?.streamAllowed('pre')))){setTimeout(()=>connect(channel),10000);return}
    const pre=channel==='pre',subs={},ws=new WebSocket('wss://mainnet.helius-rpc.com/?api-key='+key);let timer;
    ws.onopen=()=>{
      if(pre){WS.preOn=true;WS.preGapMs+=WS.prePausedAt?Date.now()-WS.prePausedAt:0;WS.prePausedAt=0}
      else{WS.on=true;WS.since=Date.now();WS.connected={dbc:false,ll:false,pc:false}}
      const requests=pre?[[150,'pre','logsSubscribe',[{mentions:[PUMP_MINT_AUTH]},{commitment:'confirmed'}]]]:
        [[100,'dbc','programSubscribe',[DBC,{encoding:'base64',commitment:'confirmed',filters:[{dataSize:424},{memcmp:{offset:305,bytes:'2'}}]}]],
         [101,'ll','programSubscribe',[LAUNCH,{encoding:'base64',commitment:'confirmed',filters:[{memcmp:{offset:17,bytes:'3'}}]}]],
         [102,'pc','programSubscribe',[PUMP,{encoding:'base64',commitment:'confirmed',dataSlice:{offset:0,length:49},filters:[{memcmp:{offset:48,bytes:'2'}}]}]],
         [103,'pumpMigrate','logsSubscribe',[{mentions:[PUMP_WITHDRAW_AUTH]},{commitment:'confirmed'}]]];
      for(const [id,name,method,params] of requests){subs[id]=name;ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params}))}
      if(pre)timer=setInterval(()=>{if(!RESOURCE.streamAllowed('pre')){WS.preBudgetPauses++;ws.budgetPause=true;try{ws.close()}catch{}}},10000);
    };
    ws.onmessage=e=>{const txt=typeof e.data==='string'?e.data:'',bytes=Buffer.byteLength(txt);WS.bytes+=bytes;
      RESOURCE.stream(bytes,pre?'pre':'migrations');
      // Never discard the last already-received create event when its byte quota fills.
      if(pre&&txt.length>200&&txt.includes('"logsNotification"')&&!txt.includes('Instruction: Create')){WS.preDrop=(WS.preDrop||0)+1;return}
      let m;try{m=JSON.parse(txt)}catch{WS.invalid=(WS.invalid||0)+1;return}
      if(m.id&&subs[m.id]){if(m.error){WS.err++;err('ws subscription '+subs[m.id]+' rejected');try{ws.close()}catch{}return}
        subs['s'+m.result]=subs[m.id];if(pre){WS.preSub=true;PRE?.telemetry?.connected(EVENT_CLOCK?.anchor?.slot)}else WS.connected[subs[m.id]]=true;return}
      const n=subs['s'+m.params?.subscription],v=m.params?.result?.value;if(!n||!v)return;
      const slot=m.params?.result?.context?.slot;EVENT_CLOCK?.observe(slot,Date.now());
      WS.msgs[n]=(WS.msgs[n]||0)+1;
      if(pre){PRE?.onLog(v,Date.now(),slot);if(!RESOURCE.streamAllowed('pre')){WS.preBudgetPauses++;ws.budgetPause=true;try{ws.close()}catch{}}return}
      if(n==='pumpMigrate'){if(v.err===null&&v.logs?.some(l=>/^Program log: Instruction: Migrate(?:V2)?\s*$/.test(l))&&v.logs?.some(l=>/^Program log: Instruction: CreatePool(?:V2)?\s*$/.test(l)))offerFastMigration({signature:v.signature,slot,kind:'pump'});else WS.migrationNoCreateDrop=(WS.migrationNoCreateDrop||0)+1;return;}
      if(n==='pc'){try{pumpCurveComplete(v.pubkey,b64(v.account?.data?.[0]),slot)}catch(x){WS.err++;err('ws pc '+x.message)}return}
      try{wsCandidate(n,v.pubkey,b64(v.account?.data?.[0]),slot,v.account?.owner)}catch(x){WS.err++;err('ws '+x.message)}
    };
    ws.onerror=()=>{WS.err++;try{ws.close()}catch{}};
    ws.onclose=()=>{clearInterval(timer);if(pre){PRE?.telemetry?.disconnected(ws.budgetPause?'budget':'network',EVENT_CLOCK?.anchor?.slot);WS.preOn=false;WS.preSub=false;WS.prePausedAt=WS.prePausedAt||Date.now()}
      else{WS.on=false;WS.connected={dbc:false,ll:false,pc:false};WS.disconnects=(WS.disconnects||0)+1}
      setTimeout(()=>connect(channel),pre?10000:5000)};
  };
  POOL_DISCOVERY=new (require(DIR+'/migration-fast.js').FastSignals)({process:processManualPool,maxQueue:64,workers:1,onError:(e,t)=>{if(t?.mint)SOURCE?.observe({mint:t.mint,phase:'before',origin:'manual-pool',reason:e.code||'RPC_ERROR'});err('manual pool '+(e.code||'RPC_ERROR'))}});
  POOL_LOGS=new (require(DIR+'/pool-logs.js').PoolLogs)({WebSocket,definitions:require(DIR+'/manual-pools.js').definitions,onSignal:t=>POOL_DISCOVERY.offer(t),onSlot:(slot,at)=>EVENT_CLOCK?.observe(slot,at)});POOL_LOGS.start();
  connect('migrations'); // TZ20: birth stream intentionally disabled; migration socket is never budget-paused.
}

/* ---------- 6. выгрузка ---------- */
const dayKey=t=>new Date(t+TZ).toISOString().slice(0,10);
const UPQ=[];function uploadLater(name,obj){if(typeof COMPLETED!=='undefined'&&COMPLETED){COMPLETED.enqueueRaw(name,obj);if(!UPQ.some(x=>x[0]===name))UPQ.push([name,null])}else UPQ.push([name,obj])}
async function flushUploads(){if(FLUSHING)return;FLUSHING=true;try{await flushUploadsInner()}finally{FLUSHING=false}}
let FLUSHING=false;
// Пока архивный хвост большой — отдельный разбор раз в 10 с (не ждём цикла выгрузки).
if(typeof setInterval==='function')setInterval(()=>{if(UPQ.length>200&&!FLUSHING)flushUploads().catch(e=>err('drain '+e.message))},10000);
async function flushUploadsInner(){
  // Drain the finite old-namespace tail before moving that namespace to archive.
  UPQ.sort((a,b)=>Number(b[0].startsWith('raw/'))-Number(a[0].startsWith('raw/')));
  // A restored raw backlog must not hold source/status/heartbeat publication hostage.
  // Keep the unsent tail intact; never drain a producer-fed queue without a bound.
  // Большой хвост архива (тысячи файлов) блокирует выгрузку монет из памяти: разбираем быстрее, но с лимитом времени.
  const limit=Math.min(UPQ.length>200?20:6,UPQ.length),started=Date.now();
  for(let i=0;i<limit&&UPQ.length&&Date.now()-started<20000;i++){
    const [n,o]=UPQ.shift();
    try{await upload(n,o===null&&typeof COMPLETED!=='undefined'&&COMPLETED?COMPLETED.readRaw(n):o);if(typeof COMPLETED!=='undefined'&&COMPLETED)COMPLETED.completeRaw(n)}catch(e){err('up '+e.message);UPQ.push([n,o]);break}
  }
}
function coinMetadata(c){const mg=c.mg||{};
  const r={a:c.a,n:c.n,s:c.s,i:c.i,p:c.p,d:c.d,q:c.q,t:c.t,tSrc:c.tSrc||'gt',t0:c.t0||null,createdAt:c.createdAt||null,createdAtSource:c.createdAtSource||null,createdAtObservedAt:c.createdAtObservedAt||null,uri:c.uri||null,metadataAt:c.metadataAt,description:c.description||null,seen:c.seen,disc:c.disc||null,rcSeen:c.rcSeen||null,wsSeen:c.wsSeen||null,firstPostSeenAt:c.firstPostSeenAt||null,preCurve:!!c.preCurve,preTradingAt:c.preTradingAt||null,ty:launchType(c),
    mk:mg.k||null,mst:mg.st||null,mw:mg.why||'',mT:mg.mT||null,mSig:mg.sig||null,mSeen:mg.seenAt||null,mCr:mg.creator??null,mH:c.mgH||[],mk0:c.mg0?.k||null,
    origs:(c.origs||[]).map(o=>({p:o.p,t:o.t,d:o.d,movedAt:o.movedAt})),
    preObs:c.preCurve?((c.origs||[]).find(o=>o.d==='pump-fun')||null):null,ct:c.ct||null,curveSol:c.preCurve&&c.curveSol?.length?c.curveSol:undefined,soc:c.soc||0,tk:c.tk&&isFinite(c.tk)?c.tk:null,tkAt:c.tkAt||null,
    openingMetrics:c.openingMetrics||null,admissionVerifiedAt:c.admissionVerifiedAt||null,creatorAddress:c.creatorAddress||null,creatorObservedAt:c.creatorObservedAt??null,supplyRaw:c.supplyRaw||null,tokenProgram:c.tokenProgram||null,intelligenceSnapshots:c.intelligenceSnapshots||[],earlyWallets:c.earlyWallets||[],earlyWalletsAt:c.earlyWalletsAt??null,discoveryFeatures:c.discoveryFeatures||null,nameObservedAt:c.nameObservedAt??null,socialFeatures:c.socialFeatures||null,lpEvidence:c.lpEvidence||null,
    live:c.lastTrade?Date.now()-c.lastTrade<30*60e3:false,lastTrade:c.lastTrade||null,legacy:c.legacy?1:0};
  return r}
async function token(){const r=await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{headers:{'Metadata-Flavor':'Google'}});return (await r.json()).access_token}
async function getObj(name){const tk=await token();const r=await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media`,{headers:{Authorization:'Bearer '+tk},signal:AbortSignal.timeout(30000)});
  if(r.status===404)return null;if(!r.ok)throw new Error('get '+name+' '+r.status);return r.json()}
async function upload(name,obj){
  if(HEALTH)HEALTH.activeUploads++;
  let payload,multipart;try{
    const stream=require(DIR+'/stream-json.js');payload=await stream.gzipJson({dir:DIR,value:obj,health:HEALTH,name});
    const tk=await token();multipart=stream.multipartGzip(payload,name);
    const r=await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=multipart`,
      {method:'POST',duplex:'half',signal:AbortSignal.timeout(60000),headers:{Authorization:'Bearer '+tk,'Content-Type':multipart.contentType,'Content-Length':String(multipart.length)},body:multipart.body});
    if(!r.ok)throw new Error('upload '+r.status+' '+(await r.text()).slice(0,120));await r.arrayBuffer();
    HEALTH?.uploadsHour.push(Date.now());
  }finally{await multipart?.close();await payload?.dispose();if(HEALTH)HEALTH.activeUploads--;HEALTH?.capture('upload:complete',{name})}
}

let lastYest=0,lastObs=0;
/* ---------- сводка для ИИ: простой текст + JSON по постоянной ссылке, раз в 5 мин. Без ключей и секретов. ---------- */
const AI_SNAP={};let AI_LAST=0;
async function uploadText(name,text,contentType){const tk=await token(),boundary='solscan-ai-'+Date.now();
  const meta=JSON.stringify({name,contentType,cacheControl:'no-cache, max-age=0'});
  const body=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+meta+'\r\n--'+boundary+'\r\nContent-Type: '+contentType+'\r\n\r\n'),Buffer.from(text,'utf8'),Buffer.from('\r\n--'+boundary+'--\r\n')]);
  const r=await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=multipart`,{method:'POST',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+tk,'Content-Type':'multipart/related; boundary='+boundary},body});
  if(!r.ok)throw new Error('ai upload '+r.status);await r.arrayBuffer()}
function aiCoin(mint,extra={}){const c=C.get(mint)||{},d=(c.ds||[]).at(-1),cs=(c.curveSol||[]).at(-1);
  return {mint,name:c.n||'',symbol:c.s||'',...extra,priceUsd:d?.[1]??null,liqUsd:d?.[2]??null,mcUsd:d?.[3]??null,buys5m:d?.[4]??null,sells5m:d?.[5]??null,vol5mUsd:d?.[6]??null,
    marketAt:d?new Date(d[0]*1000).toISOString():null,curveSol:cs?+(cs[1]/1e9).toFixed(2):null,safeContract:c.ct?!(c.ct.mint||c.ct.freeze||c.ct.fee>0||c.ct.hook||c.ct.deleg||c.ct.pause||c.ct.nontr||c.ct.defFrozen):null}}
async function exportAiSummary(now){if(now-AI_LAST<5*60e3||!SOURCE)return;AI_LAST=now;
  const t=x=>x?new Date(x+TZ).toISOString().slice(11,19):'—',ago=x=>x?Math.round((now-x)/60000)+' мин':'—',n=v=>v==null||!Number.isFinite(+v)?'—':(+v>=1e6?(+v/1e6).toFixed(2)+'M':+v>=1e3?(+v/1e3).toFixed(1)+'K':+v>=1?(+v).toFixed(0):+v>0?(+v).toPrecision(3):'0');
  const daily=AI_SNAP.source?.daily||{},hel=RESOURCE?.summary?.()||{};
  const recent=SOURCE.latest(30).map(x=>aiCoin(x.mint,{phase:x.phase,eventAt:new Date(x.eventAt).toISOString(),ageMin:Math.round((now-x.eventAt)/60000)}));
  const passed=(PASS_V2?.day(dayKey(now))||[]).slice(-40).map(x=>aiCoin(x.mint,{phase:x.phase,ageMin:Math.round((now-x.eventAt)/60000),acceptedAt:new Date(x.acceptedAt).toISOString(),zeroAt:new Date(x.zeroAt).toISOString(),
    filters:(x.matches||[]).map(m=>m.name),buyers10:x.features?.buyers10??null,quoteSolAtDecision:x.features?.quoteSol??null}));
  const json={updated:new Date(now).toISOString(),timezone:'UTC+5 (Алматы) для суток; времена ISO в UTC',
    server:{memMB:Math.round(process.memoryUsage().rss/1048576),heliusCreditsPerMin:hel.creditsMinute??null,ws:WS.connected,errors:ERR.slice(-5)},
    daily:{before:daily.before||null,after:daily.after||null,partialDay:!!daily.partialDay},
    passedConfig:PASS_V2?.config?{enabled:PASS_V2.config.enabled,decisionMinutes:PASS_V2.config.decisionMinutes,filters:(PASS_V2.config.filters||[]).map(f=>({name:f.name,level:f.level,rule:[f,...(f.conditions||[])].map(r=>r.key+' '+r.op+' '+r.value).join(' & ')}))}:null,
    research1:AI_SNAP.r1?{settings:AI_SNAP.r1.settings,counts:AI_SNAP.r1.counts,pending:AI_SNAP.r1.pending}:null,
    research2:AI_SNAP.r2?{settings:AI_SNAP.r2.settings,counts:AI_SNAP.r2.counts,pending:AI_SNAP.r2.pending}:null,
    recentAll:recent,passedToday:passed,
    links:{site:'https://bakit97.github.io/token-check/',data:'https://storage.googleapis.com/'+BUCKET+'/',code:'https://github.com/bakit97/token-check'}};
  const row=c=>'| '+(c.name||'?').replace(/\|/g,'/')+' | '+c.mint+' | '+(c.phase==='before'?'до':'после')+' | '+(c.ageMin??'')+' | '+n(c.priceUsd)+' | '+n(c.mcUsd)+' | '+n(c.liqUsd)+' | '+n(c.vol5mUsd)+' | '+(c.curveSol??'—')+' | '+(c.safeContract==null?'—':c.safeContract?'да':'НЕТ')+' |';
  const dl=(k,x)=>x?k+': увидели '+x.seen+' · прошли '+x.accepted+' · опоздали '+x.tooOld+' · не подтв. '+x.unverified:k+': нет данных';
  const md=['# SOL·СКАН — сводка для ИИ','Обновлено: '+t(now)+' (UTC+5). Обновляется раз в 5 минут. Машиночитаемо: ai/summary.json рядом.','',
    'Проект: сканер новых мемкоинов Solana (pump.fun, Meteora DBC, Raydium LaunchLab). «Все» — монеты, допущенные по возрасту (до или после миграции, один mint — один вход). «Прошли» — монеты из «Все», прошедшие фильтры сервера на момент решения. Исследование 1 — живые/мёртвые по торговой активности за 5 ч. Исследование 2 — сильные/слабые по цене 300 мин после «Прошли». Это исследование, не торговые сигналы.','',
    '## Сервер','Память '+json.server.memMB+' МБ · Helius '+(hel.creditsMinute?.toFixed?.(1)??'—')+' кредитов/мин · WS '+JSON.stringify(WS.connected)+' · ошибок за последнее время: '+json.server.errors.length,'',
    '## Сутки',dl('До миграции',daily.before),dl('После миграции',daily.after),daily.partialDay?'(день неполный — учёт начат позже 00:00)':'','',
    '## Фильтры «Прошли»',...(json.passedConfig?['Включено: '+json.passedConfig.enabled+' · таймер решения '+json.passedConfig.decisionMinutes+' мин',...json.passedConfig.filters.map(f=>'- '+f.name+': '+f.rule)]:['нет данных']),'',
    '## Исследования','Уровень 1: '+JSON.stringify(json.research1?.counts||null)+' · ожидают: '+JSON.stringify(json.research1?.pending||null),'Уровень 2: '+JSON.stringify(json.research2?.counts||null)+' · ожидают: '+JSON.stringify(json.research2?.pending||null),'',
    '## «Прошли» сегодня ('+passed.length+')','| Имя | Mint | Поток | Возраст, мин | Цена $ | MC $ | Ликв. $ | Объём 5м $ | SOL в кривой | Контракт чистый |','|---|---|---|---|---|---|---|---|---|---|',...passed.map(row),'',
    '## Последние 30 в «Все»','| Имя | Mint | Поток | Возраст, мин | Цена $ | MC $ | Ликв. $ | Объём 5м $ | SOL в кривой | Контракт чистый |','|---|---|---|---|---|---|---|---|---|---|',...recent.map(row),'',
    '«—» = данных нет (не ноль). Рыночные данные — последний снимок сервера; у свежих монет до миграции их может ещё не быть.',
    'Сайт: '+json.links.site+' · Код: '+json.links.code].join('\n');
  await uploadText('ai/summary.md',md,'text/markdown; charset=utf-8');
  await uploadText('ai/summary.json',JSON.stringify(json,null,1),'application/json; charset=utf-8');
}
function withPoolReference(row){const mint=row.mint||row.a,admission=SOURCE?.get(mint),pool=admission?.proof?.pool||null;return {...row,p:pool,pair:pool,phaseKey:row.phase==='before'?'pool':row.phase};}
async function exportSource(now) {
  if(!SOURCE)return;
  const d=dayKey(now);
  const enrich=x=>{
    const c=C.get(x.mint)||COMPLETED?.metadata(x.mint);
    return {...require(DIR+'/coin-profile.js').cardAt(c,now),p:x.proof?.pool||null,pair:x.proof?.pool||null,openingMetrics:x.proof?.openingMetrics||null,a:x.mint,phase:x.phase,phaseKey:x.phase==='before'?'pool':x.phase,launchpad:x.proof?.launchpad??null,dex:x.proof?.dex??null,venue:x.proof?.venue??null,eventAt:x.eventAt,acceptedAt:x.acceptedAt,
      n:c?.n||'',s:c?.s||'',i:c?.i||'',family:x.proof?.family||null,curve:x.proof?.curve||null,
      proofSig:x.proof?.signature||null,uri:c?.uri||x.proof?.uri||null,migrationPool:x.proof?.pool||null,proofKind:x.proof?.kind||null,eventSlot:x.proof?.slot||null,eventTimeSource:x.proof?.timeSource||null};
  };
  const summary=SOURCE.summary(now);
  const solReasons={};for(const x of SOURCE.latest(200)){const c=C.get(x.mint),card=require(DIR+'/coin-profile.js').cardAt(c,now);if(card.sol!=null)continue;const reason=!c?'missing-candidate':x.phase!=='before'?'post-no-native-vault':c.q&&c.q!==WSOL?'non-native-quote':!c.curveSol?.length?'curve-not-read':'curve-stale';solReasons[reason]=(solReasons[reason]||0)+1;}

  const today=SOURCE.day(d).map(enrich),live=SOURCE.latest(200).map(enrich),active=[...C.values()].filter(c=>SOURCE.has(c.a)).map(c=>require(DIR+'/coin-profile.js').cardAt(c,now)),coverage=rows=>{const known=rows.filter(r=>r.sol!=null).length,nonNativeQuote=rows.filter(r=>r.solUnavailableReason==='non-native-quote').length,nativeEligible=rows.length-nonNativeQuote;return {known,total:rows.length,percent:rows.length?known/rows.length*100:null,nonNativeQuote,nativeEligible,nativeEligiblePercent:nativeEligible?known/nativeEligible*100:null,olderThan7Minutes:rows.filter(r=>r.sol!=null&&r.solAgeMs>7*60e3).length}};if(PROFILES)PROFILES.stats.solCoverage={live:coverage(live),active:coverage(active),day:coverage(today)};
  // Нет задним числом добавленных кандидатов из обычной ленты.
  // Предмиграционный адаптер пока не активен: не выдавать пустоту за готовность.
  AI_SNAP.source=summary;
  await upload('source/status.json',{...summary,phaseModel:'pool-after-with-before-alias',phaseAliases:{before:'pool'},poolDiscovery:POOL_DISCOVERY?{...POOL_DISCOVERY.summary(),rejectedSidePool:(POOL_DISCOVERY.summary().outcomes['rejected-side-pool']||0)+(SOURCE?.revokedManual.size||0),audit:{...MANUAL_AUDIT},manualPoolStreamReady:POOL_LOGS?.summary().available===true}:null,poolTransport:POOL_LOGS?.summary()||null,birthStreamEnabled:false,fastDiscovery:discoveryStatus(),solCoverage:PROFILES?.stats.solCoverage||null,solMissingReasons:solReasons,cardUnits:{sol:'SOL',top10:'percent',b5:'transactions',s5:'transactions',createdAt:'unix-ms'},mode:'verified-pre-post',preConnected:preFlowing(),preLive:!!PRE&&WS.preOn&&WS.preSub,pre:PRE?.summary()||null,dailyAvailability:{before:POOL_LOGS?.summary().available===true&&!SOURCE_ERR,pool:POOL_LOGS?.summary().available===true&&!SOURCE_ERR,after:!!WS.on&&!!WS.connected.dbc&&!!WS.connected.ll&&!SOURCE_ERR}});
  await upload('source/live.json',{updated:now,count:today.length,coins:live});
  if(now-SOURCE_DAY_PUBLISHED_AT>=5*60e3){await upload('source/day/'+d+'.json',{day:d,updated:now,count:today.length,coins:today});SOURCE_DAY_PUBLISHED_AT=now;}
}
function initObservationRecovery(){
 const api=require(DIR+'/observation-recovery.js');
 RECOVERY_RPC=new api.RecoveryRPC({fallback:(m,p)=>rpc(m,p,{priority:'recovery',context:'дозагрузка',source:'recovery',urgent:true,maxBytes:2*1024*1024})});
 OBS_RECOVERY=new api.ObservationRecovery({dir:DIR,gt,preferChain:()=>true,rpc:(m,p)=>RECOVERY_RPC.call(m,p),resolveCoin:mint=>C.get(mint)||COMPLETED?.readCoin(mint),onUpdated:(job,payload)=>{
  const row=RESEARCH_V2?.rows.find(r=>r.mint===job.mint&&(!r.p||r.p===job.pool));if(row){const cfg=require(DIR+'/research-runtime.js').phaseSettings(RESEARCH_V2.config,row.phase),next=api.relabel(row,OBS_RECOVERY.evidence(job.mint,job.pool),cfg);Object.assign(row,next,{recoveryJobId:job.id,recoveredAt:Date.now(),outcomeAt:Date.now()});job.recoveredMinutes=next.backfilledMinutes||0;RESEARCH_BANKS?.upsert([row]);}
  if(job.kind.startsWith('two')){RESEARCH_TWO?.retry.delete(job.mint);RESEARCH_TWO?.processed.delete(job.mint);}
  const name='observations-v2/backfill/'+dayKey(job.start)+'/'+job.mint+'-'+job.id+'.json';if(!payload.mirrored){uploadLater(name,{...payload,backfilled:true});payload.mirrored=true;OBS_RECOVERY.store(job,payload);}const c=C.get(job.mint);if(c)c.recoveryRef={name,at:Date.now(),start:job.start,end:job.end};
 }});
}
let RECOVERY_SCAN_AT=0,RECOVERY_CURSOR=0;
function recoveryTick(){if(resourcePressure())return;if(!OBS_RECOVERY||!RESEARCH_V2||!SOURCE)return;const now=Date.now(),api=require(DIR+'/research-v2.js'),one=RESEARCH_V2;
 const enqueue=(row,start,end,kind)=>{const source=SOURCE.get(row.mint);if(!source||source.phase!==row.phase)return;const pool=source.proof?.pool||row.p;if(!pool)return;const job=OBS_RECOVERY.enqueue({mint:row.mint,pool,start,end,kind});if(!job)return;
  const raw=one.rows.find(r=>r.mint===row.mint);if(raw&&kind==='one'){if(row.why==='trade-coverage-gap'&&job.state==='recovered'){const payload=OBS_RECOVERY.payload(job);if(payload&&!payload.tradesAttempted&&payload.candlesSkipped!=='chain-inactivity-complete'){job.state='queued';job.retryAt=now;OBS_RECOVERY.persist();}}raw.recoveryPending=['queued','fetching','waiting-budget'].includes(job.state);if(['recovered','unavailable'].includes(job.state)&&(raw.recoveryJobId!==job.id||raw.recoveryVersion!==2))OBS_RECOVERY.onUpdated(job,OBS_RECOVERY.payload(job)||{candles:[]});}
 };
 for(const row of one.view())if(row.label==='unknown'||row.recoveryPending||(row.recoveryJobId&&row.recoveryVersion!==2)){const cfg=require(DIR+'/research-runtime.js').phaseSettings(one.config,row.phase),start=row.windowStart??row.eventAt??row.acceptedAt,end=row.windowEnd??start+cfg.hours*3600e3;if(end<now)enqueue(row,start,end,'one');}
 if(now-RECOVERY_SCAN_AT>=120000){RECOVERY_SCAN_AT=now;const active=[...one.admitted.values()].filter(r=>!r.intakePending&&now<(r.eventAt??r.acceptedAt)+require(DIR+'/research-runtime.js').phaseSettings(one.config,r.phase).hours*3600e3),window=active.slice(RECOVERY_CURSOR,RECOVERY_CURSOR+8);RECOVERY_CURSOR=RECOVERY_CURSOR+8>=active.length?0:RECOVERY_CURSOR+8;
  for(const row of window){const c=C.get(row.mint),cfg=require(DIR+'/research-runtime.js').phaseSettings(one.config,row.phase),start=row.eventAt??row.acceptedAt,end=Math.min(Math.floor((now-3*60000)/60000)*60000,start+cfg.hours*3600e3);if(!c||end-start<10*60000)continue;const raw=api.activityEvidence(OBS_RECOVERY.attach(fullCoin(c)),start,end,cfg.decisionMinutes);let from=null,to=null;for(const minute of raw.minutes){if(minute[1]!==1){from??=minute[0]-60000;to=minute[0];}else if(from!=null)break;}if(from!=null&&to-from>=2*60000)enqueue(row,from,to,'one-gap');}
  for(const pass of PASS_V2?.records.values()||[]){if(RESEARCH_TWO?.processed.has(pass.mint)||now-pass.zeroAt<5*3600e3)continue;enqueue(pass,pass.zeroAt-7*60000,pass.zeroAt+5*3600e3,'two');}
 }
 OBS_RECOVERY.tick();
}
function researchCoins(){const contract=require(DIR+'/observation-contract.js');return {get:mint=>{const c=C.get(mint)||(typeof COMPLETED!=='undefined'&&COMPLETED?COMPLETED.readCoin(mint):null);const row=c?contract.toLegacy(contract.project(fullCoin(c),{metadata:fullCoin(c),admission:SOURCE?.get(mint)||null})):null;return OBS_RECOVERY?OBS_RECOVERY.attach(row):row}}}
async function exportResearchV2(now) {
  if(!RESEARCH_V2||!SOURCE)return;
  // All read-only observations originate from the accepted main source.
  const result=RESEARCH_V2.update({source:SOURCE,coins:researchCoins(),passes:PASS_V2,now});
  // A settings change does NOT abandon previously admitted cohorts.
  // Earlier raw cohorts remain on disk; current labels must not be overwritten by old criteria.
  RESEARCH_BANKS?.removeRevoked(SOURCE.revokedManual);RESEARCH_BANKS?.relabelOne(RESEARCH_V2.config);
  RESEARCH_BANKS?.upsert(RESEARCH_V2.select({limit:20000}));
  AI_SNAP.r1=result;
  const population=RESEARCH_V2.view().map(r=>withPoolReference({mint:r.mint,phase:r.phase,acceptedAt:r.acceptedAt,label:r.label,why:r.why||null,activePct:r.activePct??null,maxIdleObserved:r.maxIdleObserved??null,features:r.features||{}}));
  await upload('research-v2/status.json',{...result,snapshotId:String(now),population});
  const debug={epochStart:result.cohortStart,selection:'sha256-order-independent-sample',coins:RESEARCH_V2.debugSample(20,{coins:researchCoins(),now})},debugSig=JSON.stringify(debug);if(debugSig!==RESEARCH_DEBUG_SIG){await upload('research-v2/debug-sample.json',{updated:now,...debug});RESEARCH_DEBUG_SIG=debugSig;}
  {
    await upload('research-v2/polygon-1.json',{
      updated:now,epochStart:result.cohortStart,settings:result.settings,counts:result.counts,
      coins:population,byPhase:result.byPhase,snapshotId:String(now),snapshotUpdated:now,
      note:'Observed classifications only; no buy/sell signals'
    });
    RESEARCH_BANK_UPLOADED=now;
  }
}
async function exportPathsV2(now){
  if(!PASS_V2||!RESEARCH_TWO||!SOURCE)return;
  await reloadPassConfig();
  await publishLibrary(now);
  const p=PASS_CFG_ERR
    ?{added:0,...PASS_V2.summary(now),status:'paused-control-unavailable'}
    :PASS_V2.update({source:SOURCE,coins:researchCoins(),now});
  PASS_ERR='';
  AI_SNAP.pass=p;
  await upload('passed-v2/status.json',{...p,
    controlError:PASS_CFG_ERR||null,
    serverConfig:PASS_V2.config,
    serverOnly:true});
  await upload('passed-v2/live.json',{
    updated:now,origin:'server-journal',
    coins:PASS_V2.latest(1000).filter(x=>x.schema===2?now-x.firstSeenAt<5*60e3:x.zeroAt>now).map(withPoolReference)
  });
  for(const d of [dayKey(now),dayKey(now-864e5)]){
    const rows=PASS_V2.day(d).map(withPoolReference);
    await upload('passed-v2/day/'+d+'.json',{
      day:d,updated:now,origin:'server-journal',count:rows.length,coins:rows
    });
  }
  const result=RESEARCH_TWO.update({passes:PASS_V2,source:SOURCE,coins:researchCoins(),now});
  for(const item of OLD_RESEARCH_TWO){
    try{item.runtime.update({passes:PASS_V2,source:SOURCE,coins:researchCoins(),now});RESEARCH_BANKS?.upsert(item.runtime.select({limit:20000}))}
    catch(e){err('research old 2 '+item.epoch.hash+' '+e.message)}
  }
  TWO_ERR='';
  RESEARCH_BANKS?.upsert(RESEARCH_TWO.select({limit:20000}));
  AI_SNAP.r2=result;
  await upload('research-v2/status-two.json',result);
  if(result.added>0||now-TWO_BANK_UPLOADED>20*60e3){
    // Don't transfer a 300-minute price array for every bank sample to a phone.
    // Publish frozen feature rows and a tiny server-aggregated curve separately.
    const levelTwoRows=RESEARCH_BANKS?RESEARCH_BANKS.rows({level:'2',curves:true}):RESEARCH_TWO.select({limit:20000});
    await upload('research-v2/polygon-2.json',{
      updated:now,epochStart:result.cohortStart,settings:result.settings,counts:result.counts,
      coins:require(DIR+'/stream-json.js').rowStream(function*(){for(const {minuteCurve,minuteCurvePacked,...row} of levelTwoRows)yield withPoolReference(row)}),
      note:'Only fully observed server Passed stream; no orders'
    });
    await upload('research-v2/curve-two.json',{
      updated:now,epochStart:result.cohortStart,origin:'server-verified-passed-only',
      curves:RESEARCH_TWO.aggregateCurves()
    });
    TWO_BANK_UPLOADED=now;
  }
  if(AUTO_V2&&RESEARCH_V2&&(now-AUTO_UPLOADED>60*60e3)){
    const levelOne=(RESEARCH_BANKS?RESEARCH_BANKS.select({level:'1'}):RESEARCH_V2.select({limit:20000})).filter(x=>x.outcomeVersion===2&&['live','dead'].includes(x.label)).map(x=>({
      ...x,time:x.acceptedAt
    }));
    const levelTwo=RESEARCH_BANKS?RESEARCH_BANKS.select({level:'2'}):RESEARCH_TWO.select({limit:20000});
    const one=AUTO_STUDIES.report(levelOne,{level:'1',settings:RESEARCH_V2.config,now});
    const two=AUTO_STUDIES.reportParents(levelTwo,{settings:RESEARCH_TWO.config,now});
    await refreshLibrary(PASS_V2.config);
    const visible=report=>({...report,rules:report.rules.map(r=>LIBRARY_ROWS.find(m=>m.id===r.id&&m.level===report.level)).filter(Boolean).map(m=>({...m,rule:{...m.conds[0],conditions:m.conds.slice(1),conds:m.conds,phase:m.phase,verdictMinutes:m.verdictMinutes},train:m.eval.train,holdout:m.eval.holdout,live:m.eval.live}))});
    await upload('research-v2/auto-1.json',{updated:now,epochStart:RESEARCH_V2.cohortStart,...visible(one)});
    await upload('research-v2/auto-2.json',{updated:now,epochStart:RESEARCH_TWO.cohortStart,...visible(two)});
    if(FILTER_AUDIT){
      const audit=FILTER_AUDIT.report({
        config:PASS_V2.config,one:levelOne,two:levelTwo,
        oneHours:RESEARCH_V2.config.hours,now
      });
      await upload('research-v2/filter-audit.json',audit);
    }
    await upload('research-v2/epochs.json',{
      updated:now,
      first:{current:RESEARCH_ONE_EPOCH?.summary()||null,
        older:OLD_RESEARCH_ONE.map(x=>({hash:x.epoch.hash,from:x.epoch.activeAt,
          to:x.epoch.endedAt,counts:x.runtime.summary().counts}))},
      second:{current:RESEARCH_TWO_EPOCH?.summary()||null,
        older:OLD_RESEARCH_TWO.map(x=>({hash:x.epoch.hash,from:x.epoch.activeAt,
          to:x.epoch.endedAt,counts:x.runtime.summary().counts}))},
      note:'Older cohorts continue their original observation settings and are never relabeled'
    });
    AUTO_UPLOADED=now;await publishLibrary(now);
  }
}
// Critical path: durable first-level matches must not wait for the 120s
// export cycle, especially when the decision timer is only one minute.
let FAST_PASS_PUBLISH_AT=0,FAST_PASS_STATUS_AT=0,FAST_PASS_CONFIG_AT=0,FAST_PASS_ATTEMPTS=0,FAST_PASS_LAST_ADDED=0;
async function fastPassedLoop(){
  for(;;){
    const now=Date.now();
    try{
      if(SOURCE&&PASS_V2){
        if(now-FAST_PASS_CONFIG_AT>=30000){
          FAST_PASS_CONFIG_AT=now;
          await reloadPassConfig();
        }
        if(!PASS_CFG_ERR){
          const outcome=PASS_V2.update({source:SOURCE,coins:researchCoins(),now:Date.now()});
          FAST_PASS_ATTEMPTS++;
          FAST_PASS_LAST_ADDED=outcome.added;
          if(outcome.added||now-FAST_PASS_PUBLISH_AT>=30000){
            const publishAt=Date.now();
            if(publishAt-FAST_PASS_STATUS_AT>=60000){await upload('passed-v2/status.json',{...PASS_V2.summary(publishAt),controlError:PASS_CFG_ERR||null,serverConfig:PASS_V2.config,serverOnly:true});FAST_PASS_STATUS_AT=publishAt;}
            await upload('passed-v2/live.json',{
              updated:publishAt,origin:'server-journal',
              coins:PASS_V2.latest(1000).filter(x=>x.schema===2?publishAt-x.firstSeenAt<5*60e3:x.zeroAt>publishAt).map(withPoolReference)
            });
            FAST_PASS_PUBLISH_AT=publishAt;
          }
        }else FAST_PASS_LAST_ADDED=0;
      }
    }catch(e){
      PASS_ERR='быстрый журнал: '+e.message;
      err('fast pass '+e.message);
    }
    await sleep(15000);
  }
}
const OBS_CONTRACT={schema:2,mode:'primary',legacyWriters:false,historicalArchiveGaps:{raw:77,trades:65,scope:'already absent before cutover; no fabricated backfill'},days:{}};
async function exportObservationContract(name,list,now){
  const contract=require(DIR+'/observation-contract.js'),{rowStream}=require(DIR+'/stream-json.js');
  await upload(name,{schema:2,updated:now,receiptTimeUnit:'unix-ms',count:list.length,coins:rowStream(function*(){for(const c of list)yield contract.project(c,{metadata:coinMetadata(c),admission:SOURCE?.get(c.a)||null})})});
  return {path:name,at:now,coins:list.length,...(list.metrics||{rawStates:list.reduce((n,c)=>n+Object.keys(c.raw||{}).length,0),dsRows:list.reduce((n,c)=>n+(c.ds?.length||0),0),vaultRows:list.reduce((n,c)=>n+(c.lq?.length||0),0)})};
}
function retentionPins(now){return require(DIR+'/completed-coins.js').researchPins({source:SOURCE,passes:PASS_V2,one:[RESEARCH_V2,...OLD_RESEARCH_ONE.map(x=>x.runtime)],two:[RESEARCH_TWO,...OLD_RESEARCH_TWO.map(x=>x.runtime)],now})}
async function seedCompletedDays(now){
  if(!COMPLETED)return;const {retirementDue}=require(DIR+'/completed-coins.js'),pins=retentionPins(now);
  const days=[...new Set([dayKey(now),dayKey(now-864e5),...COMPLETED.days(),...[...C.values()].filter(c=>retirementDue(c,{now,pins})).map(c=>dayKey(c.t))])].filter(d=>!COMPLETED.seeded.has(d)&&!COMPLETED.sealed.has(d));
  if(!days.length)return;const auth=await token(),headers={Authorization:'Bearer '+auth},temp=DIR+'/archive-seed-tmp';fs.mkdirSync(temp,{recursive:true});
  const {Readable,Transform}=require('node:stream'),{pipeline}=require('node:stream/promises');
  const bounded=max=>{let bytes=0;return new Transform({transform(chunk,enc,done){bytes+=chunk.length;done(bytes>max?Error('Archive seed exceeds bound'):null,chunk)}})};
  const fetchObject=async name=>{const r=await fetch('https://storage.googleapis.com/storage/v1/b/'+BUCKET+'/o/'+encodeURIComponent(name)+'?alt=media',{headers,signal:AbortSignal.timeout(120000)});if(r.status===404){await r.arrayBuffer();return null}if(!r.ok)throw Error('Archive seed HTTP '+r.status);return r};
  const download=async(prefix,day)=>{const r=await fetchObject(prefix+'/'+day+'.json');if(!r)return null;const file=temp+'/'+prefix+'-'+day+'.json',raw=file+'.download',tmp=file+'.tmp';
    try{await pipeline(Readable.fromWeb(r.body),bounded(256*1024*1024),fs.createWriteStream(raw));const fd=fs.openSync(raw,'r'),head=Buffer.alloc(2);try{fs.readSync(fd,head,0,2,0)}finally{fs.closeSync(fd)}
      if(head[0]===31&&head[1]===139){await pipeline(fs.createReadStream(raw),zlib.createGunzip(),bounded(256*1024*1024),fs.createWriteStream(tmp));fs.unlinkSync(raw)}else fs.renameSync(raw,tmp);
      fs.renameSync(tmp,file);return file;
    }catch(e){for(const p of [raw,tmp])try{fs.unlinkSync(p)}catch{}throw e}
  };
  for(const day of days)await require(DIR+'/seed-completed.js').seedObservationDay({store:COMPLETED,day,hot:C,download});
}
function collectionPins(now){return typeof COMPLETED!=='undefined'&&COMPLETED?retentionPins(now):new Map()}
function collectionActive(c,now,pins){return typeof COMPLETED==='undefined'||!COMPLETED||!require(DIR+'/completed-coins.js').retirementDue(c,{now,pins})}
function retirementBlocked(c){return !!(c.chTry||c.kTry||c.pTry||c.trTry||UPQ.some(([name])=>(name.includes('/'+c.a+'-')||name.includes('/'+c.a+'/'))))}
async function stageCompleted(now){
  if(!COMPLETED)return;const pins=retentionPins(now),{retirementDue}=require(DIR+'/completed-coins.js');RETENTION.protectedResearch=pins.size;RETENTION.pendingRaw=0;RETENTION.pendingWork=0;
  const cancelled=typeof gtQ==='undefined'?0:require(DIR+'/completed-coins.js').cancelRetiredGT(gtQ,C,{now,pins});RETENTION.cancelledGT+=cancelled;if(cancelled)await new Promise(r=>setImmediate(r));
  const candidates=[];for(const c of C.values())if(retirementDue(c,{now,pins})){if(retirementBlocked(c)){if(UPQ.some(([name])=>(name.includes('/'+c.a+'-')||name.includes('/'+c.a+'/'))))RETENTION.pendingRaw++;else RETENTION.pendingWork++;continue}candidates.push(c)}
  await COMPLETED.stage((function*(){for(const c of candidates)yield fullCoin(c)})());RETENTION.lastSweepAt=now;
}
async function retireConfirmed(day,list,now){
  if(!COMPLETED)return;const pins=retentionPins(now),{retirementDue}=require(DIR+'/completed-coins.js');let removed=0;
  for(const c of list){if(C.get(c.a)!==c||!retirementDue(c,{now,pins})||retirementBlocked(c))continue;
    if(COMPLETED.isConfirmed(fullCoin(c))){C.delete(c.a);removed++}if(removed&&removed%32===0)await new Promise(r=>setImmediate(r));}
  if(removed){RETENTION.removed+=removed;COMPLETED.removed+=removed;COMPLETED.lastRemovedAt=Date.now();}
  return removed;
}
async function exportObservationSummary(name,list,now){
  const contract=require(DIR+'/observation-contract.js'),{rowStream}=require(DIR+'/stream-json.js');
  await upload(name,{schema:2,updated:now,scope:'admitted-latest-observations-only',coins:rowStream(function*(){for(const c of list){const admission=SOURCE?.get(c.a);if(admission)yield contract.projectSummary(c,{metadata:{...coinMetadata(c),...require(DIR+'/coin-profile.js').cardAt(c,now)},admission});}})});
}
let COLD_DEDUP_BUSY=false;
async function deduplicateClosedArchiveRows(){if(COLD_DEDUP_BUSY||!COMPLETED||!SOURCE)return;COLD_DEDUP_BUSY=true;try{
 const now=Date.now(),pins=retentionPins(now);let checked=0,removed=0;
 for(const c of C.values()){
  if(now-c.t<24*3600e3+20*60e3||pins.get(c.a)>now||SOURCE.get(c.a)?.phase!=='before'||c.chTry||c.kTry||c.pTry||c.trTry||now-(c.dsTryAt||0)<35000)continue;
  if(COMPLETED.coversHot(c)){C.delete(c.a);removed++;}if(++checked%16===0)await new Promise(r=>setImmediate(r));
 }
 RETENTION.closedArchiveDeduplicated=(RETENTION.closedArchiveDeduplicated||0)+removed;if(removed)save();
}finally{COLD_DEDUP_BUSY=false}}
const LAST_DAY_EXPORT=new Map();
let DAY_EXPORT_BUSY=false;
async function exportDays(){if(DAY_EXPORT_BUSY)return;DAY_EXPORT_BUSY=true;try{await exportDaysBody()}finally{DAY_EXPORT_BUSY=false}}
async function exportDaysBody(){const now=Date.now(),today=dayKey(now),yest=dayKey(now-864e5);
  await reloadSourceAgeConfig();await reloadResearchConfig();
  if(ACTIVE_HISTORY&&await ACTIVE_HISTORY.compact({coins:C,publish:upload,read:getObj,now}))save();
  await seedCompletedDays(now);await stageCompleted(now);
  const {rowStream}=require(DIR+'/stream-json.js'),days=[...new Set([today,yest,...(COMPLETED?.days()||[])])],completedDays=[];
  for(const d of days){const live=[...C.values()].filter(c=>dayKey(c.t)===d),pins=COMPLETED?retentionPins(now):new Map();
    const force=COMPLETED&&(COMPLETED.needsConfirmation(d)||live.some(c=>require(DIR+'/completed-coins.js').retirementDue(c,{now,pins})&&!retirementBlocked(c)));if(d!==today&&!force&&now-(LAST_DAY_EXPORT.get(d)||0)<30*60e3)continue;
    if(COMPLETED?.sealed.has(d)){if(live.length)err('retention: sealed day has unexpected active records '+d);continue}
    const list=COMPLETED?COMPLETED.view(d,live,fullCoin):live;if(!list.length)continue;
    OBS_CONTRACT.days[d]=await exportObservationContract('observations-v2/'+d+'.json',list,now);
    await exportObservationSummary('observations-v2/summary/day/'+d+'.json',list,now);
    if(COMPLETED){COMPLETED.confirm(d,list);await retireConfirmed(d,live,Date.now());completedDays.push(d)}
    LAST_DAY_EXPORT.set(d,now);while(LAST_DAY_EXPORT.size>4)LAST_DAY_EXPORT.delete(LAST_DAY_EXPORT.keys().next().value);if(d===yest)lastYest=now;
  }
  const stateCommitted=completedDays.length&&save();
  await flushUploads();
  // Lightweight feeds and bounded research have independent timers.

  if(stateCommitted){const activeDays=new Set([...C.values()].map(c=>dayKey(c.t)));for(const d of completedDays)if(!activeDays.has(d)&&COMPLETED.index.has(d))COMPLETED.seal(d,now)}
}
async function publicFeedsCycle(){
 if(PUBLIC_FEEDS.busy)return;PUBLIC_FEEDS.busy=true;const errors=[];
 try{
  if(SOURCE)try{await exportSource(Date.now());PUBLIC_FEEDS.sourceAt=Date.now();SOURCE_ERR=''}catch(e){SOURCE_ERR='source publication failed';errors.push('source');err('source export '+e.message)}
  if(AUTO_STUDIES&&PASS_V2)try{await publishLibrary(Date.now(),{score:false});PUBLIC_FEEDS.libraryAt=Date.now()}catch(e){errors.push('library');err('library export '+e.message)}
  if(RESEARCH_BANKS&&Date.now()-PUBLIC_FEEDS.storageAt>=2*60e3)try{await upload('research-v2/storage.json',{...RESEARCH_BANKS.summary(),updated:Date.now()});PUBLIC_FEEDS.storageAt=Date.now()}catch(e){errors.push('storage');err('storage export '+e.message)}
  try{await exportAiSummary(Date.now())}catch(e){err('ai summary '+e.message)}
  PUBLIC_FEEDS.error=errors.join(',');
 }finally{PUBLIC_FEEDS.busy=false}
}
async function researchExportsCycle(){
 if(RESEARCH_EXPORTS.busy)return;RESEARCH_EXPORTS.busy=true;const errors=[];
 try{
  if(RESEARCH_V2&&SOURCE)try{await exportResearchV2(Date.now());RESEARCH_EXPORTS.oneAt=Date.now();RESEARCH_V2_ERR=''}catch(e){RESEARCH_V2_ERR=e.message;errors.push('one');err('research-v2 export '+e.message)}
  if(PASS_V2&&RESEARCH_TWO&&SOURCE)try{await exportPathsV2(Date.now());RESEARCH_EXPORTS.twoAt=Date.now()}catch(e){PASS_ERR=e.message;TWO_ERR=e.message;errors.push('two');err('pass/r2 export '+e.message)}
  RESEARCH_EXPORTS.error=errors.join(',');
 }finally{RESEARCH_EXPORTS.busy=false}
}
let STATUS_BUSY=false;
async function exportStatus(){if(STATUS_BUSY)return;STATUS_BUSY=true;try{const now=Date.now(),today=dayKey(now);
  const memory=HEALTH?.summary(require(DIR+'/runtime-health.js').structureCounts({C,wsSeen,RPC_CACHE,gtQ,UPQ,PRE,SOURCE,RESEARCH_V2,RESEARCH_TWO,PASS_V2,OLD_RESEARCH_ONE,OLD_RESEARCH_TWO,FILTER_AUDIT,crLog,now}));
  await upload('status.json',{updated:now,publicFeeds:{...PUBLIC_FEEDS},researchExports:{...RESEARCH_EXPORTS},memory,retention:{...RETENTION,legacyRawPending:UPQ.filter(([name])=>name.startsWith('raw/')).length,overStateTarget:RETENTION.stateBytes>=RETENTION.stateTargetBytes,archive:COMPLETED?.summary()||null,activeHistory:ACTIVE_HISTORY?.summary()||null},packedObservations:require(DIR+'/packed-observations.js').packedStats(C),proofFast:{...PROOF_FAST,cachedBlocks:MIG_BLOCKS.size},eventClock:EVENT_CLOCK?.summary()||null,migrationQueue:migrationQueueSummary(now),observationContract:OBS_CONTRACT,observationRecovery:OBS_RECOVERY?{...OBS_RECOVERY.summary(),rpc:RECOVERY_RPC?.summary()||null,r1Unknown:RESEARCH_V2?.summary().counts.unknown??null}:null,version:VERSION,poolTransition:{...POOL_TRANSITION},fastDiscovery:discoveryStatus(),poolDiscovery:POOL_DISCOVERY?{...POOL_DISCOVERY.summary(),rejectedSidePool:(POOL_DISCOVERY.summary().outcomes['rejected-side-pool']||0)+(SOURCE?.revokedManual.size||0),audit:{...MANUAL_AUDIT},manualPoolStreamReady:POOL_LOGS?.summary().available===true}:null,poolTransport:POOL_LOGS?.summary()||null,coinProfiles:PROFILES?.stats||null,intelligence:{...INTEL_STATS,blocksCached:INTEL_BLOCKS.size,smartWallets:SMART_WALLETS?.snapshot?.wallets?.length??null,smartRegistryAt:SMART_WALLETS?.snapshot?.createdAt??null,smartRegistryReady:SMART_WALLETS?.snapshot?.ready===true,smartRegistrySupport:SMART_WALLETS?.snapshot?.support??null},resources:{stage:'canonical-observations-v2',helius:RESOURCE?.summary(),gcsGovernorActive:false},source:{active:!!SOURCE,error:SOURCE_ERR,configError:SOURCE_CFG_ERR,summary:SOURCE?.summary(now)||null},
    researchV2:{active:!!RESEARCH_V2,error:RESEARCH_V2_ERR,configError:RESEARCH_CONFIG_ERR,summary:RESEARCH_V2?.summary()||null},
    passedV2:{active:!!PASS_V2,error:PASS_ERR,configError:PASS_CFG_ERR,
      fast:{attempts:FAST_PASS_ATTEMPTS,lastAdded:FAST_PASS_LAST_ADDED,publishedAt:FAST_PASS_PUBLISH_AT},
      summary:PASS_V2?.summary(now)||null},
    researchTwo:{active:!!RESEARCH_TWO,error:TWO_ERR,summary:RESEARCH_TWO?.summary()||null},
    coins:C.size,today:[...C.values()].filter(c=>dayKey(c.t)===today).length,okToday:[...C.values()].filter(c=>dayKey(c.t)===today&&isOk(c)).length,
    gt:gtStats(),gtOK,gtFail,queue:gtQ.length,preChain:PRE_STATS,rpcN,rpcFail,credits:rpcCredits,creditsHour:crLog.reduce((s,x)=>s+x[1],0),creditsBy:crLog.reduce((o,x)=>(o[x[2]]=(o[x[2]]||0)+x[1],o),{}),rpcCtx:RPCCTX,poolObservations:poolCoverage(now),pumpPre:PRE?.telemetry?.summary(EVENT_CLOCK?.anchor?.slot)||null,budgetEvents:budgetEventSummary(now),helius:!!HKEY,recon:RC.log.slice(-12),legacyResearch:{enabled:false,reason:'old-results-invalid'},ws:{...WS,preGapEventsUnknown:true,preGapCurrentMs:WS.prePausedAt?Date.now()-WS.prePausedAt:0,since:WS.since,kb:Math.round(WS.bytes/1024),credits:+(WS.bytes/1e6*20).toFixed(1),msgs:WS.msgs,cand:WS.cand,err:WS.err},mem:Math.round(process.memoryUsage().rss/1e6),errors:ERR.slice(-10),startedAt:STARTED})
}finally{STATUS_BUSY=false}}

// живая лента для «Прошли»: монеты витрины младше 40 минут, раз в 30 секунд
async function exportLive(){const now=Date.now();const list=[...C.values()].filter(c=>observedEligible(c)&&now-c.t<40*60e3);
  await exportObservationSummary('observations-v2/summary/live.json',list,now)}
function prune(){const now=Date.now();const {compactCoin}=require(DIR+'/packed-observations.js');for(const c of C.values())compactCoin(c,now)}

/* ---------- самообновление: новая версия кода в бакете → перезапуск ---------- */
async function codeGen(){const tk=await token();const r=await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/code%2Fcollector.js?fields=generation`,{headers:{Authorization:'Bearer '+tk}});return (await r.json()).generation}

/* ---------- диагностика: новый code/diag.js в бакете → запустить один раз, вывод в diag/out.txt ---------- */
let diagGen=null;async function diagCheck(){try{const tk=await token();const r=await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/code%2Fdiag.js?fields=generation`,{headers:{Authorization:'Bearer '+tk}});
  if(!r.ok)return;const g=(await r.json()).generation;if(diagGen===null){diagGen=g;return}if(g===diagGen)return;diagGen=g;
  const src=await (await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/code%2Fdiag.js?alt=media`,{headers:{Authorization:'Bearer '+tk}})).text();
  fs.writeFileSync(DIR+'/diag.js',src);const out=await new Promise(res=>{const ch=require('child_process').execFile('node',[DIR+'/diag.js'],{timeout:600000,maxBuffer:4e6,env:{...process.env,HELIUS:HKEY||''},encoding:'utf8'},(e,stdout,stderr)=>res({stdout,stderr:stderr||(e?String(e.message):'')}))});
  const txt=(out.stdout||'')+(out.stderr?'\n--- stderr ---\n'+out.stderr:'');const body=Buffer.from(txt.replaceAll(HKEY||'@@','***'));
  await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=diag%2Fout.txt`,{method:'POST',headers:{Authorization:'Bearer '+(await token()),'Content-Type':'text/plain'},body})}catch(e){err('diag '+e.message)}}

/* ---------- старт ---------- */
function startDiscoveryBootstrap(){
  // Discovery backfill cannot delay live migration proofs or code-version monitoring.
  (async()=>{for(const pg of [1,2,3])try{await addFromGT(await gt(`/new_pools?page=${pg}&include=base_token,quote_token,dex`,0,'boot'+pg))}catch(e){err('boot '+e.message)}})().catch(e=>err('boot '+e.message));
}
const STARTED=Date.now();
(async()=>{fs.mkdirSync(DIR,{recursive:true});await ensureModules();
  RESOURCE=new (require(DIR+'/resource-budget.js').ResourceBudget)({dir:DIR,env:{...process.env,HELIUS_USED_CREDITS:process.env.HELIUS_USED_CREDITS||'185000'}});
  HEALTH=new (require(DIR+'/runtime-health.js').RuntimeHealth)();let expected=Date.now()+1000;setInterval(()=>{const at=Date.now();HEALTH.lagMs=Math.max(0,at-expected);HEALTH.maxLagMs=Math.max(HEALTH.maxLagMs,HEALTH.lagMs);expected=at+1000;HEALTH.capture()},1000).unref();
  COMPLETED=new (require(DIR+'/completed-coins.js').CompletedCoins)(DIR);UPQ.push(...COMPLETED.rawQueue());
  load();ACTIVE_HISTORY=new (require(DIR+'/active-history.js').ActiveHistory)(DIR);await ACTIVE_HISTORY.restore(C,getObj);if(fs.existsSync(DIR+'/state.json'))RETENTION.stateBytes=fs.statSync(DIR+'/state.json').size;HEALTH.capture('load:complete');log('старт, версия',VERSION);
  try{await initSource();await reloadSourceAgeConfig()}catch(e){SOURCE_ERR=e.message;err('главный источник не запустился: '+e.message)}
  try{await initResearchV2()}catch(e){RESEARCH_V2_ERR=e.message;err('исследование v2 не запустилось: '+e.message)}
  try{await initPathsV2()}catch(e){PASS_ERR=e.message;TWO_ERR=e.message;err('серверные пути не запустились: '+e.message)}
  initObservationRecovery();setTimeout(()=>recoveryTick(),20000);setInterval(()=>{try{recoveryTick()}catch(e){err('recovery '+e.message)}},15000);
  PROFILES=new (require(DIR+'/coin-profile.js').CoinProfiles)();
  const LAUNCH_HISTORY=new (require(DIR+'/launch-history.js').LaunchHistory)();
  const updateLaunchHistory=()=>{try{LAUNCH_HISTORY.update({source:SOURCE,coins:C,metadata:mint=>COMPLETED?.metadata(mint),now:Date.now()})}catch(e){err('launch history '+e.message)}};updateLaunchHistory();setInterval(updateLaunchHistory,60000);
  const updateProfiles=()=>PROFILES.update({coins:C,source:SOURCE,rpc:(m,p)=>rpc(m,p,{priority:'identity',context:'карточка',source:'coin-profile'})}).catch(e=>err('profiles '+e.message));
  setInterval(updateProfiles,60000);updateProfiles();setTimeout(()=>collectIntelligence(),30000);setInterval(()=>collectIntelligence(),60000);
  setTimeout(()=>auditManualPools(),20000);setInterval(()=>auditManualPools(),30000);
  chainWatch();setInterval(()=>exportStatus().catch(e=>err('status '+e.message)),60000);exportStatus().catch(e=>err('status '+e.message));
  publicFeedsCycle().catch(e=>err('public feeds '+e.message));setInterval(()=>publicFeedsCycle().catch(e=>err('public feeds '+e.message)),60000);
  setTimeout(()=>researchExportsCycle().catch(e=>err('research exports '+e.message)),15000);setInterval(()=>researchExportsCycle().catch(e=>err('research exports '+e.message)),120000);
  startDiscoveryBootstrap();
  setInterval(pollNew,90000);
  (async()=>{for(;;){try{await pollDS()}catch(e){err('dsloop '+e.message)}await sleep(15000)}})();
  setInterval(()=>{try{candleTasks()}catch(e){err('candles '+e.message)}},15000);
  chainLoop();chainObsLoop();setInterval(diagCheck,60000);diagCheck();
  setTimeout(()=>{reconcile();setInterval(reconcile,60*60e3)},60000);
  // Legacy research results are invalid; keep observation exports, run only v2 research.
  setTimeout(()=>deduplicateClosedArchiveRows().catch(e=>err('archive dedup '+e.message)),1000);
  setInterval(()=>{prune();save();deduplicateClosedArchiveRows().catch(e=>err('archive dedup '+e.message))},120000);
  fastPassedLoop().catch(e=>err('fast pass loop '+e.message));
  (async()=>{for(;;){await sleep(5*60e3);try{await exportDays()}catch(e){err('export '+e.message)}}})();
  (async()=>{await sleep(45000);for(;;){try{await exportLive()}catch(e){err('live '+e.message)}await sleep(30000)}})();
  setTimeout(()=>exportDays().catch(e=>err('export '+e.message)),30000);
  setInterval(async()=>{try{const g=await codeGen();if(g&&VERSION!=='dev'&&g!==VERSION){log('новая версия кода',g,'— перезапуск');save();process.exit(0)}}catch{}},60000);
})();
process.on('SIGTERM',()=>{save();process.exit(0)});

}
