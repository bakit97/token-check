'use strict';
// TZ20: identity-scoped deletion, never infer phase from mint alone.
const crypto=require('node:crypto');
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const pair=(a,p)=>a+'|'+p;
function indexOf(documents=[],cutoff=0){const before=new Set(),after=new Set(),events=new Set();
 for(const doc of documents)for(const r of doc.coins||[]){const mint=r.mint||r.a,p=r.proof?.pool||r.proof?.curve||r.pair||r.p||r.migrationPool||r.curve;if(r.phase==='after'||(r.proof?.kind||r.proofKind)==='manual-pool-open-v1'){if(p)after.add(pair(mint,p));}else if(r.phase==='before'&&(!cutoff||r.acceptedAt<cutoff)){if(p)before.add(pair(mint,p));events.add(mint+'|'+r.eventAt);}}
 for(const doc of documents)for(const c of doc.coins||[]){if(!c.a)continue;for(const p of [c,...(c.origs||[]),...(c.preObs?[c.preObs]:[])]){if(p.d==='pump-fun'||p.preCurve===1){if(p.p)before.add(pair(c.a,p.p));if(p.t)events.add(c.a+'|'+p.t);}else if(p.p&&(p.mst==='ok'||p.mg?.st==='ok'))after.add(pair(c.a,p.p));}}
 for(const key of after)before.delete(key);return {before:[...before],after:[...after],events:[...events],cutoff};}
function context(index={}){return {...index,before:new Set(index.before||[]),after:new Set(index.after||[]),events:new Set(index.events||[])};}
function oldPool(a,p,ctx){return !!p&&ctx.before.has(pair(a,p))&&!ctx.after.has(pair(a,p));}
function oldPhase(r,ctx){return r?.phase==='before'&&(r.proof?.kind||r.proofKind)!=='manual-pool-open-v1'&&(r.acceptedAt??r.createdAt??0)<ctx.cutoff;}
function coin(c,ctx=context()){
 if(!c||typeof c!=='object')return c;
 const a=c.a||c.mint,proof=c.observations?.migrationProof,after=c.phase==='after'||c.mg?.st==='ok'||c.mst==='ok'||proof?.status==='ok';
 const old=p=>oldPool(a,p.p||p.address,ctx)||p.d==='pump-fun'||p.kind==='pump-fun'||p.preCurve===1;
 if(c.observations){const pools=c.observations.pools||[];if(pools.length&&old(pools[0]))return null;
  const kept=pools.filter(p=>!old(p)),admission=oldPhase(c.observations.admission,ctx)?null:c.observations.admission;
  if(kept.length!==pools.length||admission!==c.observations.admission)return {...c,observations:{...c.observations,pools:kept,admission}};return c;}
 if(old(c))return null;
 if(!after&&oldPhase(c,ctx))return null;
 if(!c.p&&ctx.events.has(a+'|'+c.t))return null;
 const origs=(c.origs||[]).filter(p=>!old(p));let out=c;
 if(origs.length!==(c.origs||[]).length){out={...c,origs};}
 if(c.preObs&&old(c.preObs)){if(out===c)out={...c};delete out.preObs;}
 return out;
}
function tombstone(row){if(row.erasedLegacyBirth)return row;const bytes=Buffer.byteLength(JSON.stringify(row)),out={fields:{},hash:digest('{}'),erasedLegacyBirth:true,padding:''},base=Buffer.byteLength(JSON.stringify(out));if(bytes<base)throw Error('History row too small for an offset-preserving tombstone');out.padding='x'.repeat(bytes-base);return out;}
function transform(name,value,index){const ctx=context(index),stats={removed:0,redacted:0};
 if(name.includes('/active-history/')){const rows=value.rows.map(r=>{if(!oldPool(r.a,r.p,ctx))return r;stats.redacted++;return tombstone(r)});return {value:{...value,rows},stats};}
 if(/(?:^|\/)raw\//.test(name)){if(oldPool(value.a,value.p,ctx))return {value:null,stats:{removed:1,redacted:0}};return {value,stats};}
 const out=Array.isArray(value)?[]:{...value};
 const clean=r=>{if(oldPhase(r,ctx)){stats.removed++;return null;}const next=coin(r,ctx);if(!next)stats.removed++;else if(next!==r)stats.redacted++;return next;};
 if(Array.isArray(value))return {value:value.map(clean).filter(Boolean),stats};
 for(const field of ['coins','rows','admitted','modules','filters'])if(Array.isArray(value[field]))out[field]=value[field].map(clean).filter(Boolean);
 if(Array.isArray(out.coins)&&Number.isInteger(out.count))out.count=out.coins.length;
 return {value:out,stats};
}
module.exports={indexOf,context,oldPool,oldPhase,coin,tombstone,transform};
if(require.main===module){const fs=require('node:fs'),[mode,input,indexFile,output]=process.argv.slice(2),v=JSON.parse(fs.readFileSync(input,'utf8')),idx=JSON.parse(fs.readFileSync(indexFile,'utf8'));const result=mode==='index'?indexOf(v,idx.cutoff):transform(mode,v,idx);fs.writeFileSync(output,JSON.stringify(result));}
