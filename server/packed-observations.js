'use strict';
// Completed numeric series stay lossless, but do not retain a JS array per row.
// The array facade supports existing read-only consumers and JSON persistence.
const packed=new WeakMap();
function packRows(rows){
 if(!Array.isArray(rows)||packed.get(rows)?.active||rows.length<16)return rows;
 const width=rows[0]?.length;
 if(!width||!rows.every(r=>Array.isArray(r)&&r.length===width&&r.every(v=>v===null||(typeof v==='number'&&Number.isFinite(v)))))return rows;
 let values=new Float64Array(rows.length*width);
 for(let i=0;i<rows.length;i++)for(let j=0;j<width;j++)values[i*width+j]=rows[i][j]===null?NaN:rows[i][j];
 const target=new Array(rows.length),index=k=>values&&typeof k==='string'&&/^(0|[1-9]\d*)$/.test(k)&&Number(k)<target.length;
 const stats={rows:rows.length,bytes:values.byteLength,active:true};
 const read=i=>{const row=new Array(width);for(let j=0;j<width;j++){const n=values[i*width+j];row[j]=Number.isNaN(n)?null:n}return row};
 // Appends/splices thaw just this coin, never the full census. The next bounded
 // prune pass can pack it again. Existing rows are treated as immutable samples.
 const thaw=()=>{if(values){for(let i=0;i<target.length;i++)target[i]=read(i);values=null;stats.active=false;stats.bytes=0}};
 const facade=new Proxy(target,{
  get:(t,k,r)=>index(k)?read(Number(k)):Reflect.get(t,k,r),
  has:(t,k)=>index(k)||Reflect.has(t,k),
  ownKeys:t=>values?[...Array.from({length:t.length},(_,i)=>String(i)),'length']:Reflect.ownKeys(t),
  getOwnPropertyDescriptor:(t,k)=>index(k)?{value:read(Number(k)),writable:false,enumerable:true,configurable:true}:Reflect.getOwnPropertyDescriptor(t,k),
  set(t,k,v){thaw();return Reflect.set(t,k,v)},
  deleteProperty(t,k){thaw();return Reflect.deleteProperty(t,k)},
  defineProperty(t,k,d){thaw();return Reflect.defineProperty(t,k,d)}
 });
 packed.set(facade,stats);return facade;
}
function compactCoin(c,now=Date.now()){
 if(!Number.isFinite(c.t)||now-c.t<2*3600000)return;
 // DS frequency becomes five minutes after two hours. Preserve every row;
 // the next real observation transparently thaws this individual series.
 for(const pool of [c,...(c.origs||[])]){
  if(pool.ds)pool.ds=packRows(pool.ds);
  if(now-c.t>=25*3600000&&pool.lq)pool.lq=packRows(pool.lq);
 }
}
function packedStats(C){let series=0,rows=0,bytes=0;
 for(const c of C.values())for(const p of [c,...(c.origs||[])])for(const k of ['ds','lq']){const s=packed.get(p[k]);if(s?.active){series++;rows+=s.rows;bytes+=s.bytes}}
 return {series,rows,bytes};
}
module.exports={packRows,compactCoin,packedStats};
