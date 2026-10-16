if(typeof WebSocket==='undefined'&&!process.env.WSX){const ch=require('child_process').spawn(process.execPath,['--experimental-websocket','--max-old-space-size=600',__filename],{stdio:'inherit',env:{...process.env,WSX:'1'}});
  ['SIGTERM','SIGINT'].forEach(sg=>process.on(sg,()=>ch.kill(sg)));ch.on('exit',code=>process.exit(code??0))}else{
'use strict';
/* SOL·СКАН — сборщик. Круглосуточно записывает все новые пулы Solana:
   вид запуска (точная проверка миграции по блокчейну), контракт токена, снимки на 1/3/5/10 минуте,
   активность каждые 5 минут в течение 5 часов, свечи первых 10 минут и итог за 5 часов.
   Каждые 2 минуты выгружает перепись дня (по Алматы, с 00:00) в Cloud Storage. */
const fs=require('fs'),zlib=require('zlib');
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
const gtQ=[];let gtPause=0,gtOK=0,gtFail=0,gtSp=6500,gtRun=0;const gtLog=[]; // gtLog: [время, 1=ок/0=429/2=ошибка, задержка в очереди мс]
function gtPending(key){return gtQ.some(x=>x.key===key)}
function gt(path,prio,key){key=key||path;const ex=gtQ.find(x=>x.key===key);if(ex)return ex.p;
  let res,rej;const p=new Promise((a,b)=>{res=a;rej=b});gtQ.push({path,prio,res,rej,t:Date.now(),key,p});gtQ.sort((a,b)=>a.prio-b.prio||a.t-b.t);return p}
(async function gtLoop(){for(;;){if(gtQ.length&&Date.now()>gtPause){const t=gtQ.shift();
    try{const j=await getJSON(GT+t.path);gtOK++;gtLog.push([Date.now(),1,Date.now()-t.t]);if(++gtRun>=20){gtRun=0;gtSp=Math.max(6000,gtSp-250)}t.res(j)}
    catch(e){gtFail++;gtLog.push([Date.now(),e.rl?0:2,Date.now()-t.t]);if(e.rl){gtPause=Date.now()+30e3;gtSp=Math.min(15000,gtSp+500);gtRun=0;
        if(t.prio<=2&&!t.retry){t.retry=1;gtQ.unshift(t);continue}}t.rej(e)}
    while(gtLog.length&&gtLog[0][0]<Date.now()-3600e3)gtLog.shift()}
  await sleep(gtSp)}})();
function gtStats(){const ok=gtLog.filter(x=>x[1]===1),rl=gtLog.filter(x=>x[1]===0).length,lat=ok.map(x=>x[2]).sort((a,b)=>a-b);
  return{queue:gtQ.length,oldestSec:gtQ.length?Math.round((Date.now()-Math.min(...gtQ.map(x=>x.t)))/1000):0,okHour:ok.length,r429Hour:rl,errHour:gtLog.filter(x=>x[1]===2).length,
    spacingMs:gtSp,waitMedSec:lat.length?Math.round(lat[lat.length>>1]/1000):null,waitMaxSec:lat.length?Math.round(lat[lat.length-1]/1000):null,
    byPrio:[0,1,2,3].map(p=>gtQ.filter(x=>x.prio===p).length)}}

/* ---------- Solana RPC (Helius). Ключ лежит в метаданных сервера, не в коде ---------- */
let HKEY='';async function heliusKey(){if(HKEY)return HKEY;try{const r=await fetch('http://metadata.google.internal/computeMetadata/v1/instance/attributes/helius-key',{headers:{'Metadata-Flavor':'Google'}});if(r.ok)HKEY=(await r.text()).trim()}catch{}return HKEY}
let rpcN=0,rpcFail=0,rpcCredits=0,rpcBusy=Promise.resolve();const crLog=[];const RPCCTX={};let CTX='?';
async function rpc(method,params){const key=await heliusKey();if(!key)throw new Error('нет ключа Helius');
  const go=async()=>{for(let t=0;t<3;t++){const r=await fetch('https://mainnet.helius-rpc.com/?api-key='+key,{signal:AbortSignal.timeout(60000),method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      rpcN++;{const cr=method==='getProgramAccounts'?10:1;rpcCredits+=cr;crLog.push([Date.now(),cr,method]);RPCCTX[CTX]=(RPCCTX[CTX]||0)+cr;while(crLog.length&&crLog[0][0]<Date.now()-3600e3)crLog.shift()}if(r.status===429){await sleep(1500*(t+1));continue}if(!r.ok)throw new Error('rpc HTTP '+r.status);const d=await r.json();if(d.error)throw new Error('rpc '+d.error.message);return d.result}
    throw new Error('rpc 429')};
  const p=rpcBusy.then(go,go);rpcBusy=p.then(()=>sleep(150),()=>sleep(150));return p}
const b64=s=>Uint8Array.from(Buffer.from(s||'','base64'));
const pk=(u,o)=>b58enc(u.slice(o,o+32));
// метаданные Metaplex: можно ли менять название/картинку
function metaMutable(u){try{let o=1+32+32;for(let i=0;i<3;i++){const n=u[o]|(u[o+1]<<8)|(u[o+2]<<16)|(u[o+3]<<24);o+=4+n}
    o+=2;if(u[o]===1){const n=u[o+1]|(u[o+2]<<8)|(u[o+3]<<16)|(u[o+4]<<24);o+=5+n*34}else o+=1;o+=1;return u[o]===1}catch{return null}}

/* ---------- контракт токена: 2 запроса на монету, один раз ---------- */
async function ctCheck(c){
  const mi=await rpc('getAccountInfo',[c.a,{encoding:'jsonParsed'}]);const v=mi?.value;if(!v)throw new Error('токен не найден');
  const info=v.data?.parsed?.info||{},ct={prog:v.owner===T22?'token2022':'token',mint:!!info.mintAuthority,freeze:!!info.freezeAuthority,dec:+info.decimals,
    supply:(+info.supply||0)/10**(+info.decimals||0),fee:0,hook:false,deleg:false,nontr:false,defFrozen:false,pause:false,metaMut:null};
  (info.extensions||[]).forEach(e=>{const s=e.state||{};
    if(e.extension==='transferFeeConfig')ct.fee=Math.max(+(s.newerTransferFee?.transferFeeBasisPoints||0),+(s.olderTransferFee?.transferFeeBasisPoints||0))/100;
    if(e.extension==='transferHook'&&s.programId)ct.hook=true;if(e.extension==='permanentDelegate'&&s.delegate)ct.deleg=true;
    if(e.extension==='nonTransferable')ct.nontr=true;if(e.extension==='defaultAccountState'&&/frozen/i.test(s.accountState||''))ct.defFrozen=true;
    if(/pausable/i.test(e.extension))ct.pause=true;if(e.extension==='tokenMetadata')ct.metaMut=!!s.updateAuthority});
  if(ct.metaMut==null){const mv=(await rpc('getAccountInfo',[await metadataOf(c.a),{encoding:'base64'}]))?.value;if(mv)ct.metaMut=metaMutable(b64(mv.data?.[0]))}
  ct.at=Date.now();c.ct=ct}

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
async function firstOkSig(pool){let before,pages=[];for(let n=0;n<10;n++){const sg=await rpc('getSignaturesForAddress',[pool,before?{limit:1000,before}:{limit:1000}]);
    if(!sg?.length){before=null;break}pages.push(sg);if(pages.length>2)pages.shift();before=sg[sg.length-1].signature;if(sg.length<1000){before=null;break}}
  if(before)return{tooLong:1};const all=pages.flat().reverse();return all.find(x=>!x.err)||null}
async function proveMig(pool,fam,curve){const f=await firstOkSig(pool);if(!f)return{why:'у пула нет успешных транзакций'};if(f.tooLong)return{why:'история пула длиннее 10 000 транзакций',tooLong:1};
  const t=await rpc('getTransaction',[f.signature,{encoding:'json',maxSupportedTransactionVersion:1,commitment:'confirmed'}]);if(!t||t.meta?.err)return{why:'транзакция создания недоступна'};
  const keys=[...t.transaction.message.accountKeys,...(t.meta.loadedAddresses?.writable||[]),...(t.meta.loadedAddresses?.readonly||[])];
  const pi=keys.indexOf(pool);const created=pi>=0&&t.meta.preBalances[pi]===0&&t.meta.postBalances[pi]>0;
  if(!created)return{why:'пул создан не в первой успешной транзакции'};
  const prog=MIG_PROG[fam],ci=curve?keys.indexOf(curve):-1;let hit=null;
  const check=ix=>{if(keys[ix.programIdIndex]!==prog)return;const d=Buffer.from(b58dec(ix.data||'1')).subarray(0,8).toString('hex');
    if(MIG_IX[prog].has(d)&&ix.accounts.includes(pi)&&(!curve||ix.accounts.includes(ci)))hit=d};
  t.transaction.message.instructions.forEach(check);(t.meta.innerInstructions||[]).forEach(g=>g.instructions.forEach(check));
  if(!hit)return{why:'в транзакции создания пула нет инструкции миграции, ссылающейся на этот пул'};
  return{ok:1,sig:f.signature,slot:t.slot,t:(t.blockTime||f.blockTime)*1000,ix:hit}}
function pair2(u,o1,o2,mint){const x=pk(u,o1),y=pk(u,o2);return x===mint?y:y===mint?x:null}
async function exists(list){if(!list.length)return[];const v=(await rpc('getMultipleAccounts',[list,{encoding:'base64',dataSlice:{offset:0,length:0}}]))?.value||[];return list.filter((x,i)=>v[i])}
const MIG_OK={pump:'pump',launch:'launch','launch-v4':'launch-v4',dbc:'dbc'};
const MIG_UNK={pump:'unk-pump',launch:'unk-launch','launch-v4':'unk-launch',dbc:'unk-dbc'};
const DEXOF={pump:'pumpswap',launch:'raydium-cpmm','launch-v4':'raydium',dbc:'meteora-damm-v2'};
function setMg(c,st,k,why,x={}){const now=Date.now(),prev=c.mg;
  c.mg={v:MGV,st,k,why:why||'',owner:x.owner||prev?.owner||'',pool:x.pool||null,sig:x.sig||null,mT:x.mT||null,ix:x.ix||null,creator:x.creator??null,watch:x.watch||null,final:x.final||0,
    seenAt:prev&&prev.v===MGV&&prev.st===st&&prev.k===k?prev.seenAt:now,lastAt:now,n:(prev?.v===MGV?prev.n||0:0)+1};
  c.mgH=c.mgH||[];const last=c.mgH[c.mgH.length-1];if(!last||last[1]!==k||last[2]!==st)c.mgH.push([now,k,st]);if(c.mgH.length>20)c.mgH.shift()}
// витрина монеты = официальный пул миграции; при переезде старые данные сохраняются в orig
function moveTo(c,pool,fam,r){if(c.p===pool)return;c.origs=c.origs||[];c.origs.push({p:c.p,t:c.t,d:c.d,movedAt:Date.now(),...takeObs(c)});if(c.origs.length>3)c.origs.shift();
  c.p=pool;c.d=DEXOF[fam]||c.d;c.t0=c.t0||c.t;c.t=r.t;c.movedAt=Date.now()}
async function migCheck(c){
  const pv=(await rpc('getAccountInfo',[c.p,{encoding:'base64'}]))?.value;if(!pv)throw new Error('пул не найден');
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
      let cq=null;try{const cf=(await rpc('getAccountInfo',[pk(u,72),{encoding:'base64',dataSlice:{offset:8,length:32}}]))?.value;if(cf)cq=b58enc(b64(cf.data?.[0]))}catch{}
      if(cq&&!c.q)c.q=cq;for(const q of [...new Set([cq,c.q,WSOL,USDC].filter(Boolean))])cands.push(...await officialPools('dbc',mint,q))}}
  else if(owner===LAUNCH){fam='launch';curve=c.p;const st=u[17],mt=u[20];quote=pk(u,237);
    if(st===0){base='curve';baseK='curve-launch';why='торгуется на кривой LaunchLab';watch=c.p}
    else{base='unk';baseK='unk-launch';why=st===1?'LaunchLab в процессе миграции':'LaunchLab завершила, пул миграции ещё не найден';
      if(st===2&&mt===1)cands=await officialPools('launch',mint,quote);
      if(st===2&&mt===0){fam='launch-v4';const g=await rpc('getProgramAccounts',[AMM4,{encoding:'base64',dataSlice:{offset:0,length:0},filters:[{memcmp:{offset:400,bytes:mint}}]}]);cands=(g||[]).map(x=>x.pubkey).slice(0,5)}}}
  else{setMg(c,'other','other:'+owner.slice(0,6),'',{owner});return}
  const x={owner,creator,watch};
  // 1) этот пул — официальный?
  if(cands.includes(c.p)){const r=await proveMig(c.p,fam,curve);
    if(r.ok){setMg(c,'ok',MIG_OK[fam],'',{...x,pool:c.p,sig:r.sig,mT:r.t,ix:r.ix});if(c.t!==r.t){c.t0=c.t0||c.t;c.t=r.t}return}
    setMg(c,'unk',MIG_UNK[fam],r.why,{...x,final:r.tooLong?1:0});return}
  // 2) у монеты есть официальный пул в другом месте — витрина переезжает туда
  let fail=null;for(const P of await exists(cands.filter(p=>p!==c.p))){const r=await proveMig(P,fam,curve);
    if(r.ok){moveTo(c,P,fam,r);setMg(c,'ok',MIG_OK[fam],'',{owner:'',pool:P,sig:r.sig,mT:r.t,ix:r.ix});return}fail=fail||r}
  if(fail){setMg(c,'unk',MIG_UNK[fam],'официальный пул есть, но миграция не доказана: '+fail.why,{...x,final:fail.tooLong?1:0});return}
  setMg(c,base,baseK,why,x)}
const MIGNAME={pump:'pump.fun → PumpSwap',dbc:'Meteora DBC → Meteora',launch:'LaunchLab → Raydium','launch-v4':'LaunchLab → Raydium',
  'curve-dbc':'Meteora DBC (кривая)','curve-launch':'LaunchLab (кривая)','manual-pump':'Пул вручную (PumpSwap)','manual-meteora':'Пул вручную (Meteora)','manual-raydium':'Пул вручную (Raydium)',
  'unk-pump':'pump.fun: миграция не подтверждена','unk-launch':'LaunchLab: миграция не подтверждена','unk-dbc':'Meteora DBC: миграция не подтверждена','unk-err':'Миграция не проверена (ошибка)'};
// кривые: раз в 10 минут одним запросом на 100 монет читаем флаг «кривая завершена» (монеты на кривой и ручные пулы монет с кривой);
// флаг сменился — полная перепроверка
function curveDone(acc){const u=b64(acc.data?.[0]);if(acc.owner===PUMP)return !!u[48];if(acc.owner===LAUNCH)return u[17]!==0;if(acc.owner===DBC)return !!u[305];return true}
async function curveSweep(){const now=Date.now();const list=[...C.values()].filter(c=>c.mg?.v===MGV&&c.mg.watch&&c.mg.k==='manual-pump'&&now-c.mg.lastAt>=115e3&&now-c.t<24*3600e3); // Meteora и LaunchLab — по подписке
  for(let i=0;i<list.length;i+=100){const part=list.slice(i,i+100);try{const v=(await rpc('getMultipleAccounts',[part.map(c=>c.mg.watch),{encoding:'base64',dataSlice:{offset:0,length:320}}]))?.value||[];
    part.forEach((c,j)=>{if(!v[j]||curveDone(v[j]))c.mg.force=1;else c.mg.lastAt=now})}catch(e){err('sweep '+e.message)}}}
function needMig(c,now){if(now-c.t>24*3600e3&&c.mg)return false;if(!c.mg||c.mg.v!==MGV||c.mg.force)return true;
  const BACK=[2,5,10,20,40];const n=c.mg.n||1;return c.mg.st==='unk'&&!c.mg.final&&n<=BACK.length&&now-c.mg.lastAt>=BACK[n-1]*60e3&&now-c.t<6*3600e3}
async function chainLoop(){let lastSweep=0;for(;;){const now=Date.now();
  if(now-lastSweep>120e3){lastSweep=now;CTX='кривые';await curveSweep()}
  const c=[...C.values()].filter(c=>!c.chTry&&((!c.ct&&isOk(c)&&now-c.t<6*3600e3)||needMig(c,now))).sort((a,b)=>b.t-a.t)[0];
  if(!c){await sleep(2000);continue}c.chTry=1;
  try{CTX='контракт';if(!c.ct&&isOk(c))await ctCheck(c);CTX='миграция';if(needMig(c,Date.now())){if(c.mg&&c.mg.v!==MGV&&!c.mg0)c.mg0=c.mg;await migCheck(c)}}
  catch(e){rpcFail++;err('chain '+e.message);if(/ключа/.test(e.message))await sleep(60000);
    else if((c.mgErr=(c.mgErr||0)+1)>=3){c.mgErr=0;setMg(c,'unk','unk-err','ошибка проверки: '+e.message.slice(0,80))}}
  finally{setTimeout(()=>{c.chTry=0},30000)}}}

/* ---------- состояние ----------
   Правило: каждое наблюдение хранит абсолютное время, когда сервер его ПОЛУЧИЛ (at, мс) — данные никогда не привязываются
   к минуте «задним числом». Всё, что относится к пулу, при переезде витрины уходит в origs и начинается заново. */
const C=new Map();const FV=2; // версия формата наблюдений
const OBS_KEYS=['ds','k10','path','hold','bx','lq','gx','vaults','vmint','vdec','legacy'],OBS_TMP=['tr','raw','dsAt','tokAt','gxAt','lastTrade','kTry','pTry','trTry','trDone','lqAt','rawUp','vTry'];
function takeObs(c){const o={};for(const k of OBS_KEYS){if(c[k]!=null)o[k]=c[k];delete c[k]}for(const k of OBS_TMP)delete c[k];return o}
function load(){try{const a=JSON.parse(fs.readFileSync(DIR+'/state.json','utf8'));a.forEach(c=>{
    if(c.fv!==FV){c.legacy={snap:c.snap,act:c.act,k:c.k};for(const k of ['snap','act','k','o','cur','cn','orig'])delete c[k];c.fv=FV}
    if(c.disc==='ws'&&c.d==='pumpswap')return;C.set(c.a,c)});log('загружено монет',C.size)}catch{}
  try{RC=JSON.parse(fs.readFileSync(DIR+'/recon.json','utf8'))}catch{}}
function save(){try{fs.writeFileSync(DIR+'/state.tmp',JSON.stringify([...C.values()]));fs.renameSync(DIR+'/state.tmp',DIR+'/state.json');
  fs.writeFileSync(DIR+'/recon.json',JSON.stringify(RC))}catch(e){err('save '+e.message)}}
const isCurve=d=>/pump-?fun/i.test(d||'')&&!/swap/i.test(d||'');
const SKIP=new Set([WSOL,USDC,USDT]);
function launchType(c){if(c.mg)return MIGNAME[c.mg.k]||('Другое ('+(c.d||'?')+')');return 'Проверяется'}
const isOk=c=>c.mg?.st==='ok';
const ageMin=(c,now)=>(now-c.t)/60000;

/* ---------- 1. новые пулы (GeckoTerminal) ---------- */
async function addFromGT(r){const inc={};(r.included||[]).forEach(x=>inc[x.id]=x);let n=0;
  for(const d of r.data||[]){const a=d.attributes||{},dex=d.relationships?.dex?.data?.id||'';if(isCurve(dex))continue;
    let bid=d.relationships?.base_token?.data?.id||'',addr=bid.replace(/^solana_/,''),q=(d.relationships?.quote_token?.data?.id||'').replace(/^solana_/,'');
    if(SKIP.has(addr)){q=addr;bid=d.relationships?.quote_token?.data?.id||'';addr=bid.replace(/^solana_/,'')}
    if(!addr||SKIP.has(addr))continue;const t=Date.parse(a.pool_created_at);if(!t||Date.now()-t>3*3600e3)continue;
    const ex=C.get(addr);
    if(ex){ex.pools=ex.pools||[ex.p];if(!ex.pools.includes(a.address)){if(ex.pools.length<12)ex.pools.push(a.address);
        if(ex.mg&&ex.mg.st!=='ok'&&ex.mg.st!=='other')ex.mg.force=1} // у монеты новый пул — возможно, это миграция
      continue}
    const tk=inc[bid]?.attributes||{};
    C.set(addr,{a:addr,n:(tk.name||(a.name||'').split(' / ')[0]||'').slice(0,40),s:(tk.symbol||'').slice(0,16),i:tk.image_url&&tk.image_url!=='missing.png'?tk.image_url:'',
      p:a.address,d:dex,q,t,tSrc:'gt',seen:Date.now(),pools:[a.address],fv:FV});n++}
  return n}
async function pollNew(){if(gtPending('new'))return;try{const n=await addFromGT(await gt('/new_pools?page=1&include=base_token,quote_token,dex',0,'new'));if(n)log('новых',n,'всего',C.size)}catch(e){err('new_pools '+e.message)}}

/* ---------- 2. DEX Screener: ряд снимков [время получения (с), цена, ликв.$, mc, покупки 5м, продажи 5м, объём 5м, покупки 1ч, продажи 1ч, объём 1ч]
   Витрина: каждую минуту первые 15 минут, потом каждые 5 минут до 24 ч. Остальные пулы: раз в 15 минут первые 6 ч (только «торгуется ли»). ---------- */
function dsDue(c,now){const a=ageMin(c,now);if(isOk(c)){if(a<-1||a>24*60+10)return false;return now-(c.dsAt||0)>=(a<120?55e3:5*60e3-15e3)}
  return a<6*60&&now-(c.dsAt||0)>=15*60e3}
function dsEntry(p,at){return[Math.round(at/1000),+(+p.priceUsd||0).toPrecision(6),p.liquidity?.usd!=null?Math.round(p.liquidity.usd):null,p.marketCap||p.fdv||null,
  p.txns?.m5?.buys??null,p.txns?.m5?.sells??null,p.volume?.m5!=null?Math.round(p.volume.m5):null,p.txns?.h1?.buys??null,p.txns?.h1?.sells??null,p.volume?.h1!=null?Math.round(p.volume.h1):null]}
function dsApply(c,p,at){const e=dsEntry(p,at);
  if(isOk(c)){(c.ds=c.ds||[]).push(e);if(c.ds.length>520)c.ds.splice(130,1)}else c.ds=[e];
  if((e[4]||0)+(e[5]||0)>0)c.lastTrade=at;else if((e[7]||0)+(e[8]||0)>0&&!c.lastTrade)c.lastTrade=at-30*60e3}
// сведения о монете (имя, соцсети, когда родилась на кривой) — по адресу монеты
function dsTokenInfo(c,arr,at){if(!arr.length)return;
  if(!c.n&&arr[0].baseToken){c.n=(arr[0].baseToken.name||'').slice(0,40);c.s=(arr[0].baseToken.symbol||'').slice(0,16)}
  const cv=arr.filter(p=>isCurve(p.dexId)||/dbc|launch/i.test(p.dexId||'')).map(p=>p.pairCreatedAt).filter(Boolean);
  const all=arr.map(p=>p.pairCreatedAt).filter(Boolean);const born=Math.min(...(cv.length?cv:all));if(isFinite(born)&&born<c.t-60e3){const nt=Math.min(c.tk||Infinity,born);if(nt!==c.tk){c.tk=nt;c.tkAt=at}}
  c.soc=Math.max(c.soc||0,(arr[0].info?.socials||[]).length+(arr[0].info?.websites||[]).length);if(!c.i&&arr[0].info?.imageUrl)c.i=arr[0].info.imageUrl}
async function pollDS(){const now=Date.now();const need=[...C.values()].filter(c=>dsDue(c,now)).sort((a,b)=>isOk(b)-isOk(a)||b.t-a.t);
  // витрина: точный пул по адресу (запрос по монете у Meteora отдаёт пару кривой, а не пул миграции)
  const ok=need.filter(isOk),rest=need.filter(c=>!isOk(c)),tokFirst=ok.filter(c=>!c.tokAt);
  for(let i=0;i<ok.length&&i<1200;i+=30){const part=ok.slice(i,i+30);
    try{const j=await getJSON(`${DS}/latest/dex/pairs/solana/${part.map(c=>c.p).join(',')}`);const at=Date.now(),by={};(j.pairs||[]).forEach(p=>by[p.pairAddress]=p);
      for(const c of part){c.dsAt=at;const p=by[c.p];if(p)dsApply(c,p,at)}}catch(e){err('ds '+e.message);await sleep(5000)}
    await sleep(300)}
  for(const [list,isTok] of [[tokFirst,1],[rest,0]])for(let i=0;i<list.length&&i<600;i+=30){const part=list.slice(i,i+30);
    try{const ps=await getJSON(`${DS}/tokens/v1/solana/${part.map(c=>c.a).join(',')}`);const at=Date.now(),by={};
      ps.forEach(p=>{const a=p.baseToken?.address;if(a)(by[a]=by[a]||[]).push(p)});
      for(const c of part){const arr=by[c.a]||[];dsTokenInfo(c,arr,at);if(isTok){c.tokAt=at;continue}c.dsAt=at;const p=arr.find(x=>x.pairAddress===c.p);if(p)dsApply(c,p,at)}
    }catch(e){err('ds '+e.message);await sleep(5000)}
    await sleep(300)}}

/* ---------- 3. GeckoTerminal: свечи 1 мин (первые 10 минут, затем график до 24 ч) и сделки первых минут — только витрина ---------- */
const kRow=x=>[x[0],+(+x[1]).toPrecision(6),+(+x[2]).toPrecision(6),+(+x[3]).toPrecision(6),+(+x[4]).toPrecision(6),Math.round(+x[5])];
const kList=r=>(r.data?.attributes?.ohlcv_list||[]).map(kRow).sort((a,b)=>a[0]-b[0]);
function mergeK(a,b){const m=new Map();for(const x of [...(a||[]),...b])m.set(x[0],x);return [...m.values()].sort((x,y)=>x[0]-y[0])}
function candleTasks(){const now=Date.now();
  for(const c of C.values()){if(!isOk(c))continue;const a=ageMin(c,now),pool=c.p,ts=Math.floor;
    // первые 10 минут: запрос на 11-й минуте, чтобы минута с 10-й отметкой была закрыта
    if(!c.k10&&!c.kTry&&c.trDone&&a>=11&&a<6*60){c.kTry=1;gt(`/pools/${pool}/ohlcv/minute?aggregate=1&limit=15&before_timestamp=${ts((c.t+11*60e3)/1000)}&currency=usd`,3,'k10:'+pool)
      .then(r=>{if(c.p===pool)c.k10={at:Date.now(),c:kList(r)}}).catch(e=>err('k10 '+e.message)).finally(()=>{c.kTry=0})}
    // график: 5 ч (одним запросом) и 24 ч (двумя)
    const upto=c.path?.upto||0;
    if(!c.pTry&&upto<5&&a>=5*60+10&&a<24*60){c.pTry=1;gt(`/pools/${pool}/ohlcv/minute?aggregate=1&limit=330&before_timestamp=${ts((c.t+5*3600e3+10*60e3)/1000)}&currency=usd`,3,'p5:'+pool)
      .then(r=>{if(c.p===pool)c.path={at:Date.now(),upto:5,c:mergeK(c.path?.c,kList(r))}}).catch(e=>err('path '+e.message)).finally(()=>{c.pTry=0})}
    if(!c.pTry&&upto<24&&a>=24*60+10&&a<30*60){c.pTry=1;const end=ts((c.t+24*3600e3+10*60e3)/1000);
      gt(`/pools/${pool}/ohlcv/minute?aggregate=1&limit=1000&before_timestamp=${end}&currency=usd`,3,'p24a:'+pool).then(async r=>{const k1=kList(r);
          let k2=[];if(k1.length&&k1[0][0]*1000>c.t)k2=kList(await gt(`/pools/${pool}/ohlcv/minute?aggregate=1&limit=1000&before_timestamp=${k1[0][0]}&currency=usd`,3,'p24b:'+pool));
          if(c.p===pool)c.path={at:Date.now(),upto:24,c:mergeK(mergeK(c.path?.c,k2),k1)}})
        .catch(e=>err('path24 '+e.message)).finally(()=>{c.pTry=0})}}
  tradeTasks(now)}
// сделки: последние 300 сделок пула; чаще, если монета активная. Покрытие проверяется по перекрытию запросов.
function gxTasks(now){if(gtPending('gx'))return;const list=[...C.values()].filter(c=>isOk(c)&&ageMin(c,now)>=2&&ageMin(c,now)<16&&now-(c.gxAt||0)>=55e3).sort((a,b)=>a.t-b.t).slice(0,30);
  if(!list.length)return;const pools=list.map(c=>c.p);
  gt(`/pools/multi/${pools.join(',')}`,1,'gx').then(r=>{const at=Date.now(),by={};(r.data||[]).forEach(d=>by[d.attributes?.address]=d.attributes);
    for(const c of list){if(!pools.includes(c.p))continue;c.gxAt=at;const x=by[c.p];if(!x)continue;const T=x.transactions||{},V=x.volume_usd||{};
      const e=[Math.round(at/1000),T.m5?.buys??null,T.m5?.sells??null,T.m5?.buyers??null,T.m5?.sellers??null,T.m15?.buys??null,T.m15?.sells??null,T.m15?.buyers??null,T.m15?.sellers??null,
        V.m5!=null?Math.round(+V.m5):null,V.m15!=null?Math.round(+V.m15):null];(c.gx=c.gx||[]).push(e)}}).catch(e=>err('gx '+e.message))}
function tradeTasks(now){gxTasks(now);for(const c of C.values()){if(!isOk(c)||c.trDone||c.trTry)continue;const a=ageMin(c,now);if(a<1)continue;
    const tr=c.tr=c.tr||{f:[],x:{}},last=tr.f[tr.f.length-1];
    if(a>40&&!last){finishTrades(c,'не успели (очередь)');continue}
    const busy=last&&last[1]>=250,since=last?(now-last[0])/1000:1e9;
    const due=!last&&a>=10.25;
    if(!due)continue;const pool=c.p;c.trTry=1;
    gt(`/pools/${pool}/trades`,2,'tr:'+pool).then(r=>{if(c.p!==pool)return;const at=Date.now();let lo=Infinity,hi=0;
        for(const d of r.data||[]){const x=d.attributes||{};const ts=Math.floor(Date.parse(x.block_timestamp)/1000);if(!ts)continue;lo=Math.min(lo,ts);hi=Math.max(hi,ts);
          const pr=+(x.kind==='buy'?x.price_to_in_usd:x.price_from_in_usd)||0;tr.x[d.id||x.tx_hash]=[ts,x.kind==='buy'?1:0,+(+x.volume_in_usd||0).toFixed(2),(x.tx_from_address||'').slice(0,12),pr?+pr.toPrecision(6):null]}
        tr.f.push([at,(r.data||[]).length,isFinite(lo)?lo:null,hi||null]);
        if(at>=c.t+10*60e3+10e3)finishTrades(c,null)})
      .catch(e=>err('trades '+e.message)).finally(()=>{c.trTry=0})}}
function finishTrades(c,why){const tr=c.tr;c.trDone=1;if(!tr||!tr.f.length){c.bx={miss:why||'нет запросов'};return}
  const t0=Math.floor(c.t/1000),end=t0+600;
  // покрытие: первый запрос дошёл до начала торговли (или в пуле меньше 300 сделок), каждый следующий перекрывает предыдущий
  let cov=tr.f[0][1]<300||(tr.f[0][2]!=null&&tr.f[0][2]<=t0+5);
  for(let i=1;i<tr.f.length;i++){const [,n,lo]=tr.f[i],prevHi=tr.f[i-1][3];if(!(n<300||(lo!=null&&prevHi!=null&&lo<=prevHi)))cov=false}
  const lastAt=tr.f[tr.f.length-1][0];if(lastAt<(end+5)*1000)cov=false;
  const L=Object.values(tr.x).filter(x=>x[0]>=t0-5&&x[0]<end);const B={},S=new Set();let buys=0,sells=0,bu=0,su=0;
  for(const [ts,k,usd,from] of L){if(k){buys++;bu+=usd;B[from]=B[from]||[0,0];B[from][0]++;B[from][1]+=usd}else{sells++;su+=usd;S.add(from)}}
  const bv=Object.values(B).map(x=>x[1]).sort((a,b)=>b-a),sum=a=>a.reduce((s,x)=>s+x,0);
  c.bx={at:lastAt,cov,n:L.length,buys,sells,buyUsd:Math.round(bu),sellUsd:Math.round(su),payers:Object.keys(B).length,sellers:S.size,
    repeat:Object.values(B).filter(x=>x[0]>=2).length,both:Object.keys(B).filter(k=>S.has(k)).length,
    top1:bu?+(bv[0]/bu).toFixed(3):null,top5:bu?+(sum(bv.slice(0,5))/bu).toFixed(3):null,fetches:tr.f.length,why:why||null};
  if(cov&&!c.k10){const M=new Map();for(const x of Object.values(tr.x).filter(x=>x[0]>=t0-60&&x[0]<end+60&&x[4]).sort((a,b)=>a[0]-b[0])){const m=Math.floor(x[0]/60)*60;const k=M.get(m);
      if(!k)M.set(m,[m,x[4],x[4],x[4],x[4],x[2]]);else{k[2]=Math.max(k[2],x[4]);k[3]=Math.min(k[3],x[4]);k[4]=x[4];k[5]+=x[2]}}
    if(M.size)c.k10={at:lastAt,src:'trades',c:[...M.values()].map(k=>[k[0],k[1],k[2],k[3],k[4],Math.round(k[5])])}}
  uploadLater(`raw/${dayKey(c.t)}/${c.a}-trades.json`,{a:c.a,p:c.p,t:c.t,f:tr.f,x:tr.x});c.tr={f:tr.f}}

/* ---------- 4. блокчейн в моменте: держатели (3/5/10 мин), состояние пула и хранилищ (ключевые моменты + каждые 5 минут) ---------- */
const VAULT_OFF={[PUMP_AMM]:[139,171],[CPMM]:[72,104],[DAMM2]:[232,264],[AMM4]:[336,368]};
const qDec=new Map([[WSOL,9],[USDC,6],[USDT,6]]);
const HOLD_M=[5,10],RAW_M=[1,3,5,10,15,30,60,120,240,480,720,1440];
const u64=(u,o)=>{let x=0n;for(let i=7;i>=0;i--)x=(x<<8n)+BigInt(u[o+i]);return Number(x)};
async function ensureVaults(c,pv){if(c.vaults||c.vTry>=3)return;c.vTry=(c.vTry||0)+1;pv=pv||(await rpc('getAccountInfo',[c.p,{encoding:'base64'}]))?.value;if(!pv)return;
  const v=parseVaults(c,pv.owner,b64(pv.data?.[0]));if(!v)return;const ch=(await rpc('getMultipleAccounts',[v,{encoding:'base64'}]))?.value||[];
  const mints=ch.map(x=>x?pk(b64(x.data?.[0]),0):null);if(mints.includes(c.a)&&ch.every(Boolean)){c.vaults=v;c.vmint=mints}}
async function holdersSnap(c,m){const sup=c.ct?.supply;await ensureVaults(c);const r=await rpc('getTokenLargestAccounts',[c.a,{commitment:'confirmed'}]);const at=Date.now();
  const L=r?.value||[];if(!L.length||!sup){c.hold[m]={at,miss:'нет данных'};return}
  const own=await rpc('getMultipleAccounts',[L.map(x=>x.address),{encoding:'jsonParsed'}]);const V=new Set(c.vaults||[]);const by={};let ex=0,pda=0;
  L.forEach((x,i)=>{if(V.has(x.address)){ex++;return}const o=own?.value?.[i]?.data?.parsed?.info?.owner||x.address;const amt=+x.uiAmount||0;by[o]=(by[o]||0)+amt});
  const arr=Object.entries(by).sort((a,b)=>b[1]-a[1]);for(const [o,amt] of arr){try{if(!onCurve(b58dec(o)))pda+=amt}catch{}}
  const sh=n=>+(arr.slice(0,n).reduce((s,x)=>s+x[1],0)/sup).toFixed(4);
  c.hold[m]={at,slot:r.context?.slot,slot2:own?.context?.slot,top1:sh(1),top5:sh(5),top10:sh(10),pda:+(pda/sup).toFixed(4),poolEx:ex,vaultsKnown:!!c.vaults}}
function parseVaults(c,owner,u){const off=VAULT_OFF[owner];if(!off||u.length<off[1]+32)return null;return off.map(o=>pk(u,o))}
async function chainObsLoop(){for(;;){const now=Date.now();
  try{
    CTX='держатели';
    for(const c of C.values()){if(!isOk(c)||!c.ct)continue;c.hold=c.hold||{};const a=ageMin(c,now);
      for(const m of HOLD_M){if(c.hold[m])continue;if(a>=m+2){c.hold[m]={at:now,miss:'опоздали'};continue}if(a>=m){await holdersSnap(c,m).catch(e=>{c.hold[m]={at:Date.now(),miss:'ошибка'};err('hold '+e.message)})}}}
    CTX='пулы';if(now-(globalThis.lastPools||0)>=60e3){globalThis.lastPools=now;
    const jobs=[];for(const c of C.values()){if(!isOk(c))continue;const a=ageMin(c,now);if(a<0||a>24*60+15)continue;c.raw=c.raw||{};
      const rm=RAW_M.find(m=>!c.raw[m]&&a>=m&&a<m+Math.max(2,m*0.1));const lqDue=now-(c.lqAt||0)>=(a<120?5*60e3:30*60e3)-10e3;
      for(const m of RAW_M)if(!c.raw[m]&&a>=m+Math.max(2,m*0.1))c.raw[m]={at:now,miss:1};
      if(rm!=null||lqDue)jobs.push([c,rm])}
    for(let i=0;i<jobs.length;i+=33){const part=jobs.slice(i,i+33);const keys=[];
      part.forEach(([c])=>{keys.push(c.p,...(c.vaults||[]))});
      const r=await rpc('getMultipleAccounts',[keys,{encoding:'base64'}]);const at=Date.now(),slot=r?.context?.slot,V=r?.value||[];let j=0;
      for(const [c,rm] of part){const pv=V[j++];const vs=(c.vaults||[]).map(()=>V[j++]);if(!pv)continue;const u=b64(pv.data?.[0]);
        if(!c.vaults)await ensureVaults(c,pv);
        if(rm!=null)c.raw[rm]={at,slot,b:[pv.data?.[0],...vs.map(x=>x?.data?.[0]||null)]};
        if(c.vaults&&vs.length===2&&vs.every(Boolean)){const am=vs.map(x=>u64(b64(x.data?.[0]),64));c.lq=c.lq||[];c.lq.push([Math.round(at/1000),slot,...am]);if(c.lq.length>320)c.lq.splice(10,1)}
        c.lqAt=at}}}
    for(const c of C.values())if(isOk(c)&&c.vmint&&!c.vdec){c.vdec=await Promise.all(c.vmint.map(async mt=>{if(mt===c.a)return c.ct?.dec??null;if(qDec.has(mt))return qDec.get(mt);
        const v=(await rpc('getAccountInfo',[mt,{encoding:'jsonParsed'}]))?.value;const d=v?.data?.parsed?.info?.decimals;if(d!=null)qDec.set(mt,+d);return d??null}))}
    // через 24 ч 15 мин сырые состояния уходят в отдельный файл
    for(const c of C.values())if(c.raw&&ageMin(c,now)>24*60+20&&!c.rawUp){c.rawUp=1;uploadLater(`raw/${dayKey(c.t)}/${c.a}-state.json`,{a:c.a,p:c.p,t:c.t,vaults:c.vaults,raw:c.raw});
      c.raw=Object.fromEntries(Object.entries(c.raw).map(([m,x])=>[m,{at:x.at,slot:x.slot,miss:x.miss}]))}
  }catch(e){err('chainobs '+e.message)}
  await sleep(10000)}}

/* ---------- 5. сверка полноты: снимки состояния программ (LaunchLab «вышла», Meteora DBC «мигрировала») раз в 30 минут.
   Новые «вышедшие» кривые = кандидаты; миграция всё равно доказывается транзакцией, время — из блока. ---------- */
let RC={ll:null,dbc:null,log:[]};
function hiWin(hi){const b=Buffer.alloc(6);b.writeUInt16LE(hi&0xffff,0);return b58enc(b)}
async function snapshotSet(key){
  if(key==='ll'){const r=await rpc('getProgramAccounts',[LAUNCH,{encoding:'base64',dataSlice:{offset:0,length:0},filters:[{memcmp:{offset:17,bytes:'3'}}],withContext:true}]);return (r?.value||[]).map(x=>x.pubkey)}
  // DBC: все пулы слишком велики для одного запроса — берём только кривые с точкой активации (слот или unix-время, u64 @296) в двух последних окнах по 65536
  const slot=await rpc('getSlot',[]),nowS=Math.floor(Date.now()/1000),out=new Set();
  for(const v of [slot,nowS])for(const d of [0,1]){const r=await rpc('getProgramAccounts',[DBC,{encoding:'base64',dataSlice:{offset:0,length:0},
      filters:[{dataSize:424},{memcmp:{offset:305,bytes:'2'}},{memcmp:{offset:298,bytes:hiWin((v>>>16)-d)}}],withContext:true}]);(r?.value||[]).forEach(x=>out.add(x.pubkey))}
  return [...out]}
async function reconcile(){const now=Date.now();CTX='сверка';
  for(const [key,mOff,qOff] of [['ll',205,237],['dbc',136,null]]){
    try{const cur=await snapshotSet(key);const prev=RC[key]?new Set(RC[key]):null;RC[key]=cur;
      if(!prev){RC.log.push([now,key,'база',cur.length]);continue}
      RC.pend=RC.pend||{};const all=[...(RC.pend[key]||[]),...cur.filter(x=>!prev.has(x))];const nw=[...new Set(all)].slice(0,300);RC.pend[key]=[...new Set(all)].slice(300);let known=0,added=0,forced=0;
      for(let i=0;i<nw.length;i+=100){const v=(await rpc('getMultipleAccounts',[nw.slice(i,i+100),{encoding:'base64'}]))?.value||[];
        v.forEach((acc,j)=>{if(!acc)return;const u=b64(acc.data?.[0]);const mint=pk(u,mOff),quote=qOff?pk(u,qOff):null;const c=C.get(mint);
          if(c&&isOk(c)){known++;c.rcSeen=c.rcSeen||now;return}
          if(c){if(c.mg)c.mg.force=1;c.rcSeen=now;forced++;return}
          C.set(mint,{a:mint,n:'',s:'',i:'',p:nw[i+j],d:key==='ll'?'raydium-launchlab':'meteora-dbc',q:quote,t:now,tSrc:'recon',seen:now,disc:'chain',rcSeen:now,pools:[nw[i+j]],fv:FV});added++})}
      RC.log.push([now,key,'новых',nw.length,known,forced,added])}catch(e){err('recon '+key+' '+e.message)}}
  while(RC.log.length>200)RC.log.shift()}

/* ---------- 5б. подписки на блокчейн: миграции видны сразу, без GeckoTerminal ----------
   Meteora DBC: кривые с флагом «мигрировала»; LaunchLab: кривые со статусом 2; PumpSwap: аккаунты пулов с index = 0 (создаются один раз).
   Это только кандидаты — миграция всё равно доказывается транзакцией. */
const WS={on:false,bytes:0,msgs:{},cand:{},err:0,since:0};const wsSeen=new Map();
function wsCandidate(kind,acc,u){const now=Date.now();if(wsSeen.has(acc)&&now-wsSeen.get(acc)<6*3600e3)return;wsSeen.set(acc,now);
  if(wsSeen.size>20000)for(const [k,t] of wsSeen)if(now-t>6*3600e3)wsSeen.delete(k);
  let mint=null,quote=null,pool=acc;
  if(kind==='dbc'){mint=pk(u,136)}
  else if(kind==='ll'){mint=pk(u,205);quote=pk(u,237)}
  else if(kind==='pump'){const b=pk(u,43),q=pk(u,75);if(SKIP.has(b)){mint=q;quote=b}else{mint=b;quote=q}if(SKIP.has(mint))return}
  if(!mint)return;WS.cand[kind]=(WS.cand[kind]||0)+1;const c=C.get(mint);
  if(c){if(!isOk(c)&&c.mg)c.mg.force=1;c.wsSeen=c.wsSeen||now;return}
  C.set(mint,{a:mint,n:'',s:'',i:'',p:pool,d:kind==='pump'?'pumpswap':kind==='ll'?'raydium-launchlab':'meteora-dbc',q:quote,t:now,tSrc:'ws',seen:now,disc:'ws',wsSeen:now,pools:[pool],fv:FV})}
function chainWatch(){let ws,ping;const subs={};
  const start=async()=>{const key=await heliusKey();if(!key){setTimeout(start,60e3);return}
    ws=new WebSocket('wss://mainnet.helius-rpc.com/?api-key='+key);
    ws.onopen=()=>{WS.on=true;WS.since=Date.now();
      [['dbc',DBC,[{dataSize:424},{memcmp:{offset:305,bytes:'2'}}]],['ll',LAUNCH,[{memcmp:{offset:17,bytes:'3'}}]]]
        .forEach(([n,prog,f],i)=>{subs[100+i]=n;ws.send(JSON.stringify({jsonrpc:'2.0',id:100+i,method:'programSubscribe',params:[prog,{encoding:'base64',commitment:'confirmed',filters:f}]}))});
      ping=setInterval(()=>{try{ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'getHealth'}))}catch{}},30e3)};
    ws.onmessage=e=>{const txt=typeof e.data==='string'?e.data:'';WS.bytes+=txt.length;let m;try{m=JSON.parse(txt)}catch{return}
      if(m.id&&subs[m.id]){subs['s'+m.result]=subs[m.id];return}
      const n=subs['s'+m.params?.subscription];const v=m.params?.result?.value;if(!n||!v)return;WS.msgs[n]=(WS.msgs[n]||0)+1;
      if(WS.msgs[n]>5000&&Date.now()-WS.since<3600e3){err('подписка '+n+' слишком шумная — закрыта');try{ws.close()}catch{}WS.stop=1;return}
      try{wsCandidate(n,v.pubkey,b64(v.account?.data?.[0]))}catch(x){err('ws '+x.message)}};
    ws.onerror=()=>{WS.err++};
    ws.onclose=()=>{WS.on=false;clearInterval(ping);if(WS.stop)return;err('ws закрыт — переподключение');setTimeout(()=>{start();reconcile().catch(()=>{})},5000)}};
  start()}

/* ---------- 6. выгрузка ---------- */
const dayKey=t=>new Date(t+TZ).toISOString().slice(0,10);
const UPQ=[];function uploadLater(name,obj){UPQ.push([name,obj])}
async function flushUploads(){while(UPQ.length){const [n,o]=UPQ.shift();try{await upload(n,o)}catch(e){err('up '+e.message);UPQ.push([n,o]);break}}}
function rec(c,full){const mg=c.mg||{};
  const r={a:c.a,n:c.n,s:c.s,i:c.i,p:c.p,d:c.d,q:c.q,t:c.t,tSrc:c.tSrc||'gt',t0:c.t0||null,seen:c.seen,disc:c.disc||null,rcSeen:c.rcSeen||null,wsSeen:c.wsSeen||null,ty:launchType(c),
    mk:mg.k||null,mst:mg.st||null,mw:mg.why||'',mT:mg.mT||null,mSig:mg.sig||null,mSeen:mg.seenAt||null,mCr:mg.creator??null,mH:c.mgH||[],mk0:c.mg0?.k||null,
    origs:(c.origs||[]).map(o=>({p:o.p,t:o.t,d:o.d,movedAt:o.movedAt})),ct:c.ct||null,soc:c.soc||0,tk:c.tk&&isFinite(c.tk)?c.tk:null,tkAt:c.tkAt||null,
    live:c.lastTrade?Date.now()-c.lastTrade<30*60e3:false,lastTrade:c.lastTrade||null,legacy:c.legacy?1:0};
  if(isOk(c)){r.k10=c.k10||null;r.hold=c.hold||{};r.bx=c.bx||null;r.gx=c.gx||[];r.vdec=c.vdec||null;r.vmint=c.vmint||null;
    r.raw=c.raw?Object.fromEntries(Object.entries(c.raw).map(([m,x])=>[m,{at:x.at,slot:x.slot,miss:x.miss}])):{};
    const lim=Math.floor(c.t/1000)+20*60;r.ds=full?(c.ds||[]):(c.ds||[]).filter(x=>x[0]<=lim);r.lq=full?(c.lq||[]):(c.lq||[]).filter(x=>x[0]<=lim);
    if(full)r.path=c.path?{at:c.path.at,upto:c.path.upto,c:c.path.c}:null;else r.pathUpto=c.path?.upto||0}
  else r.ds=c.ds||[];
  return r}
async function token(){const r=await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{headers:{'Metadata-Flavor':'Google'}});return (await r.json()).access_token}
async function upload(name,obj){const body=zlib.gzipSync(Buffer.from(JSON.stringify(obj)));const tk=await token();
  const r=await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}&contentEncoding=gzip`,
    {method:'POST',headers:{Authorization:'Bearer '+tk,'Content-Type':'application/json'},body});
  if(!r.ok)throw new Error('upload '+r.status+' '+(await r.text()).slice(0,120));
  await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}`,{method:'PATCH',headers:{Authorization:'Bearer '+tk,'Content-Type':'application/json'},body:JSON.stringify({cacheControl:'no-cache, max-age=0'})})}
let lastYest=0,lastObs=0;
async function exportDays(){const now=Date.now(),today=dayKey(now),yest=dayKey(now-864e5);
  for(const d of [today,yest]){if(d===yest&&now-lastYest<30*60e3)continue;const list=[...C.values()].filter(c=>dayKey(c.t)===d);if(!list.length)continue;
    await upload(`day/${d}.json`,{day:d,tz:'Asia/Almaty',fv:FV,updated:now,count:list.length,coins:list.map(c=>rec(c,false))});
    if(d===yest||now-lastObs>=10*60e3){await upload(`obs/${d}.json`,{day:d,updated:now,coins:list.filter(isOk).map(c=>({a:c.a,t:c.t,ds:c.ds||[],lq:c.lq||[],path:c.path||null}))});if(d===today)lastObs=now}
    if(d===yest)lastYest=now}
  await flushUploads();
  await upload('status.json',{updated:now,version:VERSION,coins:C.size,today:[...C.values()].filter(c=>dayKey(c.t)===today).length,okToday:[...C.values()].filter(c=>dayKey(c.t)===today&&isOk(c)).length,
    gt:gtStats(),gtOK,gtFail,queue:gtQ.length,rpcN,rpcFail,credits:rpcCredits,creditsHour:crLog.reduce((s,x)=>s+x[1],0),creditsBy:crLog.reduce((o,x)=>(o[x[2]]=(o[x[2]]||0)+x[1],o),{}),rpcCtx:RPCCTX,helius:!!HKEY,recon:RC.log.slice(-12),ws:{on:WS.on,since:WS.since,kb:Math.round(WS.bytes/1024),credits:+(WS.bytes/1e6*20).toFixed(1),msgs:WS.msgs,cand:WS.cand,err:WS.err},mem:Math.round(process.memoryUsage().rss/1e6),errors:ERR.slice(-10),startedAt:STARTED})}
// живая лента для «Прошли»: монеты витрины младше 40 минут, раз в 30 секунд
async function exportLive(){const now=Date.now();const list=[...C.values()].filter(c=>isOk(c)&&now-c.t<40*60e3);
  await upload('live.json',{updated:now,coins:list.map(c=>rec(c,true))})}
function prune(){const lim=Date.now()-50*3600e3;for(const [a,c] of C)if(c.t<lim)C.delete(a)}

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
const STARTED=Date.now();
(async()=>{fs.mkdirSync(DIR,{recursive:true});load();log('старт, версия',VERSION);
  for(const pg of [1,2,3])try{await addFromGT(await gt(`/new_pools?page=${pg}&include=base_token,quote_token,dex`,0,'boot'+pg))}catch(e){err('boot '+e.message)}
  setInterval(pollNew,90000);
  (async()=>{for(;;){try{await pollDS()}catch(e){err('dsloop '+e.message)}await sleep(15000)}})();
  setInterval(()=>{try{candleTasks()}catch(e){err('candles '+e.message)}},15000);
  chainLoop();chainObsLoop();chainWatch();setInterval(diagCheck,60000);diagCheck();
  setTimeout(()=>{reconcile();setInterval(reconcile,60*60e3)},60000);
  setInterval(()=>{prune();save()},120000);
  (async()=>{for(;;){await sleep(120000);try{await exportDays()}catch(e){err('export '+e.message)}}})();
  (async()=>{await sleep(45000);for(;;){try{await exportLive()}catch(e){err('live '+e.message)}await sleep(30000)}})();
  setTimeout(()=>exportDays().catch(e=>err('export '+e.message)),30000);
  setInterval(async()=>{try{const g=await codeGen();if(g&&VERSION!=='dev'&&g!==VERSION){log('новая версия кода',g,'— перезапуск');save();process.exit(0)}}catch{}},60000);
})();
process.on('SIGTERM',()=>{save();process.exit(0)});

}
