'use strict';
/* SOL·СКАН — сборщик. Круглосуточно записывает все новые пулы Solana:
   вид запуска (точная проверка миграции по блокчейну), контракт токена, снимки на 1/3/5/10 минуте,
   активность каждые 5 минут в течение 5 часов, свечи первых 10 минут и итог за 5 часов.
   Каждые 2 минуты выгружает перепись дня (по Алматы, с 00:00) в Cloud Storage. */
const fs=require('fs'),zlib=require('zlib');
const BUCKET='sol-scan-511718-data',DIR='/var/solscan',TZ=5*3600e3;
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
async function isCanonical(mint,pair){try{for(const q of [WSOL,USDC]){if((await canonicalPoolOf(mint,q))===pair)return true}return false}catch{return false}}

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

/* ---------- сеть: лимит GeckoTerminal (бесплатно ~10/мин) — общая очередь ---------- */
async function getJSON(url){const r=await fetch(url,{headers:{accept:'application/json'}});if(r.status===429){const e=new Error('429');e.rl=1;throw e}
  if(!r.ok)throw new Error('HTTP '+r.status+' '+url.split('?')[0].slice(-60));return r.json()}
const gtQ=[];let gtPause=0,gtOK=0,gtFail=0;
function gt(path,prio){return new Promise((res,rej)=>{gtQ.push({path,prio,res,rej,t:Date.now()});gtQ.sort((a,b)=>a.prio-b.prio||a.t-b.t)})}
(async function gtLoop(){for(;;){if(gtQ.length&&Date.now()>gtPause){const t=gtQ.shift();
    try{t.res(await getJSON(GT+t.path));gtOK++}catch(e){gtFail++;if(e.rl)gtPause=Date.now()+60e3;t.rej(e)}}
  await sleep(6500)}})();

/* ---------- Solana RPC (Helius). Ключ лежит в метаданных сервера, не в коде ---------- */
let HKEY='';async function heliusKey(){if(HKEY)return HKEY;try{const r=await fetch('http://metadata.google.internal/computeMetadata/v1/instance/attributes/helius-key',{headers:{'Metadata-Flavor':'Google'}});if(r.ok)HKEY=(await r.text()).trim()}catch{}return HKEY}
let rpcN=0,rpcFail=0,rpcBusy=Promise.resolve();
async function rpc(method,params){const key=await heliusKey();if(!key)throw new Error('нет ключа Helius');
  const go=async()=>{for(let t=0;t<3;t++){const r=await fetch('https://mainnet.helius-rpc.com/?api-key='+key,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      rpcN++;if(r.status===429){await sleep(1500*(t+1));continue}if(!r.ok)throw new Error('rpc HTTP '+r.status);const d=await r.json();if(d.error)throw new Error('rpc '+d.error.message);return d.result}
    throw new Error('rpc 429')};
  const p=rpcBusy.then(go,go);rpcBusy=p.then(()=>sleep(150),()=>sleep(150));return p}
const b64=s=>Uint8Array.from(Buffer.from(s||'','base64'));
const pk=(u,o)=>b58enc(u.slice(o,o+32));
// метаданные Metaplex: можно ли менять название/картинку
function metaMutable(u){try{let o=1+32+32;for(let i=0;i<3;i++){const n=u[o]|(u[o+1]<<8)|(u[o+2]<<16)|(u[o+3]<<24);o+=4+n}
    o+=2;if(u[o]===1){const n=u[o+1]|(u[o+2]<<8)|(u[o+3]<<16)|(u[o+4]<<24);o+=5+n*34}else o+=1;o+=1;return u[o]===1}catch{return null}}

/* ---------- контракт + точная миграция: 2–4 запроса на монету ---------- */
async function chainCheck(c){
  const mi=await rpc('getAccountInfo',[c.a,{encoding:'jsonParsed'}]);const v=mi?.value;if(!v)throw new Error('токен не найден');
  const info=v.data?.parsed?.info||{},ct={prog:v.owner===T22?'token2022':'token',mint:!!info.mintAuthority,freeze:!!info.freezeAuthority,dec:+info.decimals,
    supply:(+info.supply||0)/10**(+info.decimals||0),fee:0,hook:false,deleg:false,nontr:false,defFrozen:false,pause:false,metaMut:null};
  (info.extensions||[]).forEach(e=>{const s=e.state||{};
    if(e.extension==='transferFeeConfig')ct.fee=Math.max(+(s.newerTransferFee?.transferFeeBasisPoints||0),+(s.olderTransferFee?.transferFeeBasisPoints||0))/100;
    if(e.extension==='transferHook'&&s.programId)ct.hook=true;if(e.extension==='permanentDelegate'&&s.delegate)ct.deleg=true;
    if(e.extension==='nonTransferable')ct.nontr=true;if(e.extension==='defaultAccountState'&&/frozen/i.test(s.accountState||''))ct.defFrozen=true;
    if(/pausable/i.test(e.extension))ct.pause=true;if(e.extension==='tokenMetadata')ct.metaMut=!!s.updateAuthority});
  const md=await metadataOf(c.a);
  const acc=await rpc('getMultipleAccounts',[[md,c.p],{encoding:'base64'}]);const [mv,pv]=acc?.value||[];
  if(ct.metaMut==null&&mv)ct.metaMut=metaMutable(b64(mv.data?.[0]));
  c.ct=ct;
  // вид запуска — по программе-владельцу пула
  const owner=pv?.owner||'';let k='other',why='';
  if(owner===PUMP_AMM)k=(await isCanonical(c.a,c.p))?'pump':'manual-pump';
  else if(owner===DAMM1||owner===DAMM2)k=(await isDbcGraduate(owner,c.p,c.a,c.q))?'dbc':'manual-meteora';
  else if(owner===DBC)k='curve-dbc';
  else if(owner===LAUNCH)k='curve-launch';
  else if(owner===CPMM||owner===AMM4){k='manual-raydium';
    if(c.q){const lp=await launchPoolOf(c.a,c.q);const la=await rpc('getMultipleAccounts',[[lp],{encoding:'base64'}]);const L=la?.value?.[0];
      if(L&&L.owner===LAUNCH){const u=b64(L.data?.[0]),status=u[17],mtype=u[20],cfg=pk(u,141);
        if(status===2){if(owner===CPMM){const ca=await rpc('getMultipleAccounts',[[cfg],{encoding:'base64'}]);const cu=b64(ca?.value?.[0]?.data?.[0]);
            const creator=pk(b64(pv.data?.[0]),40);if(cu.length>=243&&creator===pk(cu,211))k='launch';else why='создатель пула не кошелёк миграции LaunchLab'}
          else if(mtype===0)k='launch-v4'}
        else why='LaunchLab ещё не выпустил монету (статус '+status+')'}}}
  else if(owner)k='other:'+owner.slice(0,6);
  c.mg={k,why,owner,at:Date.now()}}
const MIGNAME={pump:'pump.fun → PumpSwap',dbc:'Meteora DBC → Meteora',launch:'LaunchLab → Raydium','launch-v4':'LaunchLab → Raydium',
  'curve-dbc':'Meteora DBC (кривая)','curve-launch':'LaunchLab (кривая)','manual-pump':'Пул вручную (PumpSwap)','manual-meteora':'Пул вручную (Meteora)','manual-raydium':'Пул вручную (Raydium)'};
async function chainLoop(){for(;;){const c=[...C.values()].filter(c=>!c.mg&&!c.chTry&&Date.now()-c.t<6*3600e3).sort((a,b)=>b.t-a.t)[0];
  if(!c){await sleep(2000);continue}c.chTry=1;try{await chainCheck(c)}catch(e){rpcFail++;err('chain '+e.message);if(/ключа/.test(e.message))await sleep(60000)}
  finally{setTimeout(()=>{c.chTry=0},30000)}}}

/* ---------- состояние ---------- */
const C=new Map();
function load(){try{const a=JSON.parse(fs.readFileSync(DIR+'/state.json','utf8'));a.forEach(c=>{if(c.o&&!('winMin' in c.o))delete c.o;if(!c.act)c.act=[];C.set(c.a,c)});log('загружено монет',C.size)}catch{}}
function save(){try{fs.writeFileSync(DIR+'/state.tmp',JSON.stringify([...C.values()]));fs.renameSync(DIR+'/state.tmp',DIR+'/state.json')}catch(e){err('save '+e.message)}}
const isCurve=d=>/pump-?fun/i.test(d||'')&&!/swap/i.test(d||'');
const isPumpSwap=d=>/pump-?swap/i.test(d||'');
const SKIP=new Set([WSOL,USDC,USDT]);
function launchType(c){if(c.mg)return MIGNAME[c.mg.k]||('Другое ('+(c.d||'?')+')');const d=(c.d||'').toLowerCase(),ps=(c.dx||[]).join(' ').toLowerCase();
  if(/pump-?swap/.test(d))return c.cn===true?'pump.fun → PumpSwap':c.cn===false?'Пул вручную (PumpSwap)':'PumpSwap';
  if(/dbc|dynamic-bonding/.test(d))return 'Meteora DBC (кривая)';
  if(/launch/.test(d))return 'LaunchLab (кривая)';
  if(/meteora/.test(d))return /dbc|dynamic-bonding/.test(ps)?'Meteora DBC → Meteora':'Пул вручную (Meteora)';
  if(/raydium/.test(d))return /launch/.test(ps)?'LaunchLab → Raydium':'Пул вручную (Raydium)';
  return 'Другое ('+(c.d||'?')+')'}

/* ---------- 1. новые пулы ---------- */
async function addFromGT(r){const inc={};(r.included||[]).forEach(x=>inc[x.id]=x);let n=0;
  for(const d of r.data||[]){const a=d.attributes||{},dex=d.relationships?.dex?.data?.id||'';if(isCurve(dex))continue;
    let bid=d.relationships?.base_token?.data?.id||'',addr=bid.replace(/^solana_/,''),q=(d.relationships?.quote_token?.data?.id||'').replace(/^solana_/,'');
    if(SKIP.has(addr)){q=addr;bid=d.relationships?.quote_token?.data?.id||'';addr=bid.replace(/^solana_/,'')}
    if(!addr||SKIP.has(addr))continue;const t=Date.parse(a.pool_created_at);if(!t||Date.now()-t>3*3600e3)continue;
    const ex=C.get(addr);if(ex){if(t<ex.t&&ex.cn!==true){ex.t=t;ex.p=a.address;ex.d=dex;ex.q=q;ex.cn=undefined;ex.mg=undefined}continue}
    const tk=inc[bid]?.attributes||{};
    const c={a:addr,n:(tk.name||(a.name||'').split(' / ')[0]||'').slice(0,40),s:(tk.symbol||'').slice(0,16),i:tk.image_url&&tk.image_url!=='missing.png'?tk.image_url:'',
      p:a.address,d:dex,q,t,seen:Date.now(),snap:{},act:[],dx:[dex]};
    if(isPumpSwap(dex))c.cn=await isCanonical(addr,c.p);
    C.set(addr,c);n++}
  return n}
async function pollNew(){try{const r=await gt('/new_pools?page=1&include=base_token,quote_token,dex',0);const n=await addFromGT(r);if(n)log('новых',n,'всего',C.size)}catch(e){err('new_pools '+e.message)}}

/* ---------- 2. DEX Screener: снимки и «жива ли» (лимит большой, пачки по 30) ---------- */
const MARKS=[1,3,5,10];
function snapOf(p){return{price:+p.priceUsd||0,liq:p.liquidity?.usd??null,mc:p.marketCap||p.fdv||null,
  b5:p.txns?.m5?.buys??null,s5:p.txns?.m5?.sells??null,v5:p.volume?.m5??null,b1:p.txns?.h1?.buys??null,s1:p.txns?.h1?.sells??null,v1h:p.volume?.h1??null}}
async function pollDS(){const now=Date.now(),need=[];
  for(const c of C.values()){const age=(now-c.t)/60000;
    const wantSnap=MARKS.some(m=>age>=m&&!c.snap[m]&&age<m+4);
    const wantLive=(age<5*60+10&&now-(c.dsAt||0)>5*60e3-15e3)||(age>=5*60+10&&now-(c.dsAt||0)>15*60e3&&age<40*60);
    if(wantSnap||wantLive||!c.dsAt)need.push(c)}
  need.sort((a,b)=>b.t-a.t);
  for(let i=0;i<need.length&&i<600;i+=30){const part=need.slice(i,i+30);
    try{const ps=await getJSON(`${DS}/tokens/v1/solana/${part.map(c=>c.a).join(',')}`);const by={};
      ps.forEach(p=>{const a=p.baseToken?.address;if(a)(by[a]=by[a]||[]).push(p)});
      for(const c of part){const arr=by[c.a]||[];c.dsAt=Date.now();if(!arr.length)continue;
        c.dx=[...new Set([...(c.dx||[]),...arr.map(p=>p.dexId)])];
        const cv=arr.filter(p=>isCurve(p.dexId)||/dbc|launch/i.test(p.dexId||'')).map(p=>p.pairCreatedAt).filter(Boolean);
        const all=arr.map(p=>p.pairCreatedAt).filter(Boolean);
        const born=Math.min(...(cv.length?cv:all));if(isFinite(born)&&born<c.t-60e3)c.tk=Math.min(c.tk||Infinity,born);
        c.soc=Math.max(c.soc||0,(arr[0].info?.socials||[]).length+(arr[0].info?.websites||[]).length);if(!c.i&&arr[0].info?.imageUrl)c.i=arr[0].info.imageUrl;
        const p=arr.find(x=>x.pairAddress===c.p);if(!p)continue;const sn=snapOf(p);
        // для монет pump.fun: если основной пул ручной, а есть настоящий миграционный — переключаемся на него
        if(c.cn===false||(c.mg&&/^manual/.test(c.mg.k)))for(const x of arr){if(isPumpSwap(x.dexId)&&x.pairAddress!==c.p&&await isCanonical(c.a,x.pairAddress)){c.p=x.pairAddress;c.cn=true;c.mg=undefined;c.t=x.pairCreatedAt||c.t;c.snap={};c.act=[];c.k=undefined;c.o=undefined;break}}
        const age=(Date.now()-c.t)/60000;for(const m of MARKS)if(age>=m&&!c.snap[m]&&age<m+4)c.snap[m]=sn;
        c.cur=sn;if(age<5*60+10){c.act=c.act||[];const m5=Math.round(age);if(!c.act.length||m5-c.act[c.act.length-1][0]>=4)c.act.push([m5,sn.b5,sn.s5,Math.round(sn.v5||0),Math.round(sn.liq||0),+(+sn.price).toPrecision(5)])}
        if((sn.b5||0)+(sn.s5||0)>0)c.lastTrade=Date.now();else if((sn.b1||0)+(sn.s1||0)>0&&!c.lastTrade)c.lastTrade=Date.now()-30*60e3}
    }catch(e){err('ds '+e.message);await sleep(5000)}
    await sleep(400)}}

/* ---------- 3. свечи: первые 10 минут и итог ---------- */
function feat10(c,k){const m=x=>Math.floor((x[0]-c.t)/60000);const f=k.filter(x=>m(x)>=0&&m(x)<10);if(!f.length)return null;
  const p0=f[0][1]||f[0][4],p10=f[f.length-1][4];let hi=0,dd=0;f.forEach(x=>{hi=Math.max(hi,x[2]);dd=Math.max(dd,1-x[3]/hi)});
  return{v1:f.filter(x=>m(x)===0).reduce((s,x)=>s+x[5],0),v5:f.filter(x=>m(x)<5).reduce((s,x)=>s+x[5],0),v510:f.filter(x=>m(x)>=5).reduce((s,x)=>s+x[5],0),
    x10:p0?p10/p0:null,dd10:dd*100,green:f.filter(x=>x[4]>x[1]).length,active:new Set(f.map(m)).size,p0,p10,
    c:f.map(x=>[m(x),+x[1].toPrecision(5),+x[2].toPrecision(5),+x[3].toPrecision(5),+x[4].toPrecision(5),Math.round(x[5])])}}
const parseK=r=>(r.data?.attributes?.ohlcv_list||[]).map(x=>[x[0]*1000,+x[1],+x[2],+x[3],+x[4],+x[5]]).sort((a,b)=>a[0]-b[0]);
const WIN=5*3600e3;
async function candleTasks(){const now=Date.now();
  // первые 10 минут
  const first=[...C.values()].filter(c=>!c.k&&now-c.t>=11*60e3&&now-c.t<6*3600e3&&!c.kTry).sort((a,b)=>b.t-a.t).slice(0,3);
  for(const c of first){c.kTry=1;gt(`/pools/${c.p}/ohlcv/minute?aggregate=1&limit=20&before_timestamp=${Math.floor((c.t+11*60e3)/1000)}&currency=usd`,2)
    .then(r=>{c.k=feat10(c,parseK(r))||{none:1}}).catch(e=>{err('k10 '+e.message)}).finally(()=>{c.kTry=0})}
  // итог: 5 часов после выхода на витрину, вход = цена на 10-й минуте
  const due=[...C.values()].filter(c=>c.k&&!c.k.none&&!c.o&&now-c.t>=WIN+10*60e3&&!c.oTry).sort((a,b)=>a.t-b.t).slice(0,3);
  for(const c of due){c.oTry=1;gt(`/pools/${c.p}/ohlcv/minute?aggregate=5&limit=70&before_timestamp=${Math.floor((c.t+WIN+5*60e3)/1000)}&currency=usd`,3).then(r=>{
      const k=parseK(r).filter(x=>x[0]>=c.t+10*60e3&&x[0]<c.t+WIN);c.o=outcome(c,k)})
    .catch(e=>{err('out '+e.message)}).finally(()=>{c.oTry=0})}}
function outcome(c,k){const p10=c.k.p10,m=x=>Math.round((x[0]-c.t)/60000);if(!p10)return{none:1};
  const o={at:Date.now(),peak:null,peakMin:null,min:null,winMin:null,rugMin:null,deadMin:null,liqDrop:null};
  if(k.length){let pk=0,pkAt=0,mn=Infinity;k.forEach(x=>{if(x[2]>pk){pk=x[2];pkAt=x[0]}if(x[3]<mn)mn=x[3]});o.peak=pk/p10;o.peakMin=m([pkAt]);o.min=mn/p10;
    const w=k.find(x=>x[2]>=1.5*p10);if(w)o.winMin=m(w);const r=k.find(x=>x[3]<=0.3*p10);if(r)o.rugMin=m(r)}
  // деньги в пуле: ушло больше половины от 10-й минуты
  const l10=c.snap?.[10]?.liq;if(l10&&c.act?.length){const d=c.act.find(x=>x[0]>=10&&x[4]>0&&x[4]<l10*0.5);if(d){o.liqDrop=d[0];o.rugMin=o.rugMin==null?d[0]:Math.min(o.rugMin,d[0])}}
  // торговля остановилась: 30 минут подряд без сделок (6 замеров по 5 минут)
  if(c.act?.length){let run=0;for(const x of c.act){if(x[0]<10)continue;if((x[1]||0)+(x[2]||0)===0){run++;if(run>=6&&o.deadMin==null)o.deadMin=x[0]-25}else run=0}}
  if(!k.length&&o.deadMin==null)o.deadMin=10;
  return o}

/* ---------- 4. итог и выгрузка ---------- */
// группы за 5 часов: win — дала +50% (раньше, чем слилась), rug — слив, dead — торговля встала, flat — живая без роста
function groupOf(c){const o=c.o;if(!o||o.none)return null;const end=x=>x==null?1e9:x;
  if(o.winMin!=null&&o.winMin<end(o.rugMin))return 'win';if(o.rugMin!=null)return 'rug';if(o.deadMin!=null)return 'dead';return 'flat'}
function rec(c){const k=c.k&&!c.k.none?c.k:null;const sup=c.cur?.mc&&c.cur?.price?c.cur.mc/c.cur.price:null;
  return{a:c.a,n:c.n,s:c.s,i:c.i,p:c.p,d:c.d,q:c.q,t:c.t,seen:c.seen,tk:c.tk&&isFinite(c.tk)?c.tk:null,ty:launchType(c),mk:c.mg?.k||null,mw:c.mg?.why||'',ct:c.ct||null,act:c.act||[],soc:c.soc||0,
    mig:c.tk&&isFinite(c.tk)?Math.round((c.t-c.tk)/60000):null,mcMig:k&&sup?Math.round(k.p0*sup):null,snap:c.snap,f:k,o:c.o||null,
    live:c.lastTrade?Date.now()-c.lastTrade<30*60e3:false,lastTrade:c.lastTrade||null,g:groupOf(c)}}
async function token(){const r=await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',{headers:{'Metadata-Flavor':'Google'}});return (await r.json()).access_token}
async function upload(name,obj){const body=zlib.gzipSync(Buffer.from(JSON.stringify(obj)));const tk=await token();
  const r=await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}&contentEncoding=gzip`,
    {method:'POST',headers:{Authorization:'Bearer '+tk,'Content-Type':'application/json'},body});
  if(!r.ok)throw new Error('upload '+r.status+' '+(await r.text()).slice(0,120));
  await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}`,{method:'PATCH',headers:{Authorization:'Bearer '+tk,'Content-Type':'application/json'},body:JSON.stringify({cacheControl:'no-cache, max-age=0'})})}
const dayKey=t=>new Date(t+TZ).toISOString().slice(0,10);
let lastUp=0;
async function exportDays(){const now=Date.now(),today=dayKey(now),yest=dayKey(now-864e5),days={[today]:[],[yest]:[]};
  for(const c of C.values()){const k=dayKey(c.t);if(days[k])days[k].push(rec(c))}
  for(const [d,list] of Object.entries(days)){if(!list.length)continue;
    if(d===yest&&now-lastUp<30*60e3&&lastUp)continue; // вчерашний день — раз в 30 минут
    await upload(`day/${d}.json`,{day:d,tz:'Asia/Almaty',updated:now,count:list.length,coins:list})}
  if(now-lastUp>=30*60e3)lastUp=now;
  await upload('status.json',{updated:now,version:VERSION,coins:C.size,today:days[today].length,queue:gtQ.length,gtOK,gtFail,rpcN,rpcFail,helius:!!HKEY,errors:ERR.slice(-10),startedAt:STARTED})}
function prune(){const lim=Date.now()-50*3600e3;for(const [a,c] of C)if(c.t<lim)C.delete(a)}

/* ---------- самообновление: новая версия кода в бакете → перезапуск ---------- */
async function codeGen(){const tk=await token();const r=await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/code%2Fcollector.js?fields=generation`,{headers:{Authorization:'Bearer '+tk}});return (await r.json()).generation}

/* ---------- диагностика: новый code/diag.js в бакете → запустить один раз, вывод в diag/out.txt ---------- */
let diagGen=null;async function diagCheck(){try{const tk=await token();const r=await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/code%2Fdiag.js?fields=generation`,{headers:{Authorization:'Bearer '+tk}});
  if(!r.ok)return;const g=(await r.json()).generation;if(diagGen===null){diagGen=g;return}if(g===diagGen)return;diagGen=g;
  const src=await (await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/code%2Fdiag.js?alt=media`,{headers:{Authorization:'Bearer '+tk}})).text();
  fs.writeFileSync(DIR+'/diag.js',src);const out=require('child_process').spawnSync('node',[DIR+'/diag.js'],{timeout:120000,env:{...process.env,HELIUS:await heliusKey()},encoding:'utf8'});
  const txt=(out.stdout||'')+(out.stderr?'\n--- stderr ---\n'+out.stderr:'');const body=Buffer.from(txt.replaceAll(HKEY||'@@','***'));
  await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=diag%2Fout.txt`,{method:'POST',headers:{Authorization:'Bearer '+(await token()),'Content-Type':'text/plain'},body})}catch(e){err('diag '+e.message)}}

/* ---------- старт ---------- */
const STARTED=Date.now();
(async()=>{fs.mkdirSync(DIR,{recursive:true});load();log('старт, версия',VERSION);
  for(const pg of [1,2,3,4,5])try{await addFromGT(await gt(`/new_pools?page=${pg}&include=base_token,quote_token,dex`,0))}catch(e){err('boot '+e.message)}
  setInterval(pollNew,13000);
  (async()=>{for(;;){try{await pollDS()}catch(e){err('dsloop '+e.message)}await sleep(20000)}})();
  setInterval(()=>{try{candleTasks()}catch(e){err('candles '+e.message)}},20000);
  chainLoop();setInterval(diagCheck,60000);diagCheck();
  setInterval(()=>{prune();save()},60000);
  (async()=>{for(;;){await sleep(120000);try{await exportDays()}catch(e){err('export '+e.message)}}})();
  setTimeout(()=>exportDays().catch(e=>err('export '+e.message)),30000);
  setInterval(async()=>{try{const g=await codeGen();if(g&&VERSION!=='dev'&&g!==VERSION){log('новая версия кода',g,'— перезапуск');save();process.exit(0)}}catch{}},60000);
})();
process.on('SIGTERM',()=>{save();process.exit(0)});
