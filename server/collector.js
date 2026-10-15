'use strict';
/* SOL·СКАН — сборщик. Круглосуточно записывает все новые пулы Solana,
   делает снимки на 1/3/5/10 минуте, свечи первых 10 минут и итог через 1.5 ч / 6 ч / конец дня.
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

/* ---------- сеть: лимит GeckoTerminal (бесплатно ~10/мин) — общая очередь ---------- */
async function getJSON(url){const r=await fetch(url,{headers:{accept:'application/json'}});if(r.status===429){const e=new Error('429');e.rl=1;throw e}
  if(!r.ok)throw new Error('HTTP '+r.status+' '+url.split('?')[0].slice(-60));return r.json()}
const gtQ=[];let gtPause=0,gtOK=0,gtFail=0;
function gt(path,prio){return new Promise((res,rej)=>{gtQ.push({path,prio,res,rej,t:Date.now()});gtQ.sort((a,b)=>a.prio-b.prio||a.t-b.t)})}
(async function gtLoop(){for(;;){if(gtQ.length&&Date.now()>gtPause){const t=gtQ.shift();
    try{t.res(await getJSON(GT+t.path));gtOK++}catch(e){gtFail++;if(e.rl)gtPause=Date.now()+60e3;t.rej(e)}}
  await sleep(6500)}})();

/* ---------- состояние ---------- */
const C=new Map();
function load(){try{const a=JSON.parse(fs.readFileSync(DIR+'/state.json','utf8'));a.forEach(c=>C.set(c.a,c));log('загружено монет',C.size)}catch{}}
function save(){try{fs.writeFileSync(DIR+'/state.tmp',JSON.stringify([...C.values()]));fs.renameSync(DIR+'/state.tmp',DIR+'/state.json')}catch(e){err('save '+e.message)}}
const isCurve=d=>/pump-?fun/i.test(d||'')&&!/swap/i.test(d||'');
const isPumpSwap=d=>/pump-?swap/i.test(d||'');
const SKIP=new Set([WSOL,USDC,USDT]);
function launchType(c){const d=(c.d||'').toLowerCase(),ps=(c.dx||[]).join(' ').toLowerCase();
  if(/pump-?swap/.test(d))return c.cn===true?'pump.fun → PumpSwap':c.cn===false?'Пул вручную (PumpSwap)':'PumpSwap';
  if(/dbc|dynamic-bonding/.test(d))return 'Meteora DBC (кривая)';
  if(/launch/.test(d))return 'LaunchLab (кривая)';
  if(/meteora/.test(d))return /dbc|dynamic-bonding/.test(ps)?'Meteora DBC → Meteora':'Пул вручную (Meteora)';
  if(/raydium/.test(d))return /launch/.test(ps)?'LaunchLab → Raydium':'Пул вручную (Raydium)';
  return 'Другое ('+(c.d||'?')+')'}

/* ---------- 1. новые пулы ---------- */
async function addFromGT(r){const inc={};(r.included||[]).forEach(x=>inc[x.id]=x);let n=0;
  for(const d of r.data||[]){const a=d.attributes||{},dex=d.relationships?.dex?.data?.id||'';if(isCurve(dex))continue;
    let bid=d.relationships?.base_token?.data?.id||'',addr=bid.replace(/^solana_/,'');
    if(SKIP.has(addr)){bid=d.relationships?.quote_token?.data?.id||'';addr=bid.replace(/^solana_/,'')}
    if(!addr||SKIP.has(addr))continue;const t=Date.parse(a.pool_created_at);if(!t||Date.now()-t>3*3600e3)continue;
    const ex=C.get(addr);if(ex){if(t<ex.t&&ex.cn!==true){ex.t=t;ex.p=a.address;ex.d=dex;ex.cn=undefined}continue}
    const tk=inc[bid]?.attributes||{};
    const c={a:addr,n:(tk.name||(a.name||'').split(' / ')[0]||'').slice(0,40),s:(tk.symbol||'').slice(0,16),i:tk.image_url&&tk.image_url!=='missing.png'?tk.image_url:'',
      p:a.address,d:dex,t,seen:Date.now(),snap:{},dx:[dex]};
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
    const wantLive=age>=12&&now-(c.dsAt||0)>10*60e3&&age<40*60;
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
        if(c.cn===false)for(const x of arr){if(isPumpSwap(x.dexId)&&x.pairAddress!==c.p&&await isCanonical(c.a,x.pairAddress)){c.p=x.pairAddress;c.cn=true;c.t=x.pairCreatedAt||c.t;c.snap={};c.k=undefined;break}}
        const age=(Date.now()-c.t)/60000;for(const m of MARKS)if(age>=m&&!c.snap[m]&&age<m+4)c.snap[m]=sn;
        c.cur=sn;if((sn.b5||0)+(sn.s5||0)>0)c.lastTrade=Date.now();else if((sn.b1||0)+(sn.s1||0)>0&&!c.lastTrade)c.lastTrade=Date.now()-30*60e3}
    }catch(e){err('ds '+e.message);await sleep(5000)}
    await sleep(400)}}

/* ---------- 3. свечи: первые 10 минут и итог ---------- */
function feat10(c,k){const m=x=>Math.floor((x[0]-c.t)/60000);const f=k.filter(x=>m(x)>=0&&m(x)<10);if(!f.length)return null;
  const p0=f[0][1]||f[0][4],p10=f[f.length-1][4];let hi=0,dd=0;f.forEach(x=>{hi=Math.max(hi,x[2]);dd=Math.max(dd,1-x[3]/hi)});
  return{v1:f.filter(x=>m(x)===0).reduce((s,x)=>s+x[5],0),v5:f.filter(x=>m(x)<5).reduce((s,x)=>s+x[5],0),v510:f.filter(x=>m(x)>=5).reduce((s,x)=>s+x[5],0),
    x10:p0?p10/p0:null,dd10:dd*100,green:f.filter(x=>x[4]>x[1]).length,active:new Set(f.map(m)).size,p0,p10,
    c:f.map(x=>[m(x),+x[1].toPrecision(5),+x[2].toPrecision(5),+x[3].toPrecision(5),+x[4].toPrecision(5),Math.round(x[5])])}}
const parseK=r=>(r.data?.attributes?.ohlcv_list||[]).map(x=>[x[0]*1000,+x[1],+x[2],+x[3],+x[4],+x[5]]).sort((a,b)=>a[0]-b[0]);
function dayEnd(t){return Math.floor((t+TZ)/864e5)*864e5-TZ+864e5}
function outcomeDue(c){if(!c.k)return false;const age=Date.now()-c.t,n=c.oN||0;
  if(n===0)return age>=90*60e3;if(n===1)return age>=6*3600e3;if(n===2)return Date.now()>=dayEnd(c.t)-10*60e3&&age>=7*3600e3;return false}
async function candleTasks(){const now=Date.now();
  // первые 10 минут
  const first=[...C.values()].filter(c=>!c.k&&now-c.t>=11*60e3&&now-c.t<6*3600e3&&!c.kTry).sort((a,b)=>b.t-a.t).slice(0,3);
  for(const c of first){c.kTry=1;gt(`/pools/${c.p}/ohlcv/minute?aggregate=1&limit=20&before_timestamp=${Math.floor((c.t+11*60e3)/1000)}&currency=usd`,2)
    .then(r=>{c.k=feat10(c,parseK(r))||{none:1}}).catch(e=>{err('k10 '+e.message)}).finally(()=>{c.kTry=0})}
  // итог: пик после 10-й минуты, текущая цена
  const due=[...C.values()].filter(c=>c.k&&!c.k.none&&outcomeDue(c)&&!c.oTry).sort((a,b)=>a.t-b.t).slice(0,3);
  for(const c of due){c.oTry=1;gt(`/pools/${c.p}/ohlcv/minute?aggregate=5&limit=1000&currency=usd`,3).then(r=>{
      const k=parseK(r).filter(x=>x[0]>=c.t+10*60e3);const p10=c.k.p10;if(!k.length||!p10){c.oN=(c.oN||0)+1;return}
      const last=k[k.length-1];let pk=0,pkAt=0;k.forEach(x=>{if(x[2]>pk){pk=x[2];pkAt=x[0]}});
      c.o={at:Date.now(),peak:pk/p10,peakMin:(pkAt-c.t)/60000,now:last[4]/p10,lastK:last[0],min:Math.min(...k.map(x=>x[3]))/p10};c.oN=(c.oN||0)+1})
    .catch(e=>{err('out '+e.message)}).finally(()=>{c.oTry=0})}}

/* ---------- 4. итог и выгрузка ---------- */
function groupOf(c){const o=c.o;if(!o||Date.now()-c.t<90*60e3)return null;
  const alive=Date.now()-Math.max(c.lastTrade||0,o.lastK||0)<60*60e3;
  if(o.peak>=2&&o.now>=1&&alive)return 'grow';if(o.peak>=2)return 'pd';if(o.now<=0.3)return 'rug';return 'dead'}
function rec(c){const k=c.k&&!c.k.none?c.k:null;const sup=c.cur?.mc&&c.cur?.price?c.cur.mc/c.cur.price:null;
  return{a:c.a,n:c.n,s:c.s,i:c.i,p:c.p,d:c.d,t:c.t,tk:c.tk&&isFinite(c.tk)?c.tk:null,ty:launchType(c),soc:c.soc||0,
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
  await upload('status.json',{updated:now,version:VERSION,coins:C.size,today:days[today].length,queue:gtQ.length,gtOK,gtFail,errors:ERR.slice(-10),startedAt:STARTED})}
function prune(){const lim=Date.now()-50*3600e3;for(const [a,c] of C)if(c.t<lim)C.delete(a)}

/* ---------- самообновление: новая версия кода в бакете → перезапуск ---------- */
async function codeGen(){const tk=await token();const r=await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/code%2Fcollector.js?fields=generation`,{headers:{Authorization:'Bearer '+tk}});return (await r.json()).generation}

/* ---------- старт ---------- */
const STARTED=Date.now();
(async()=>{fs.mkdirSync(DIR,{recursive:true});load();log('старт, версия',VERSION);
  for(const pg of [1,2,3,4,5])try{await addFromGT(await gt(`/new_pools?page=${pg}&include=base_token,quote_token,dex`,0))}catch(e){err('boot '+e.message)}
  setInterval(pollNew,13000);
  (async()=>{for(;;){try{await pollDS()}catch(e){err('dsloop '+e.message)}await sleep(20000)}})();
  setInterval(()=>{try{candleTasks()}catch(e){err('candles '+e.message)}},20000);
  setInterval(()=>{prune();save()},60000);
  (async()=>{for(;;){await sleep(120000);try{await exportDays()}catch(e){err('export '+e.message)}}})();
  setTimeout(()=>exportDays().catch(e=>err('export '+e.message)),30000);
  setInterval(async()=>{try{const g=await codeGen();if(g&&VERSION!=='dev'&&g!==VERSION){log('новая версия кода',g,'— перезапуск');save();process.exit(0)}}catch{}},60000);
})();
process.on('SIGTERM',()=>{save();process.exit(0)});
