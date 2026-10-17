'use strict';
// Completed numeric series stay lossless, but do not retain a JS array per row.
// The array facade supports existing read-only consumers and JSON persistence.
const packed=new WeakMap();
function packRows(rows){
 if(!Array.isArray(rows)||packed.has(rows)||rows.length<16)return rows;
 const width=rows[0]?.length;
 if(!width||!rows.every(r=>Array.isArray(r)&&r.length===width&&r.every(v=>v===null||(typeof v==='number'&&Number.isFinite(v)))))return rows;
 const values=new Float64Array(rows.length*width);
 for(let i=0;i<rows.length;i++)for(let j=0;j<width;j++)values[i*width+j]=rows[i][j]===null?NaN:rows[i][j];
 const target=new Array(rows.length),index=k=>typeof k==='string'&&/^(0|[1-9]\d*)$/.test(k)&&Number(k)<target.length;
 const read=i=>{const row=new Array(width);for(let j=0;j<width;j++){const n=values[i*width+j];row[j]=Number.isNaN(n)?null:n}return row};
 const facade=new Proxy(target,{
  get:(t,k,r)=>index(k)?read(Number(k)):Reflect.get(t,k,r),
  has:(t,k)=>index(k)||Reflect.has(t,k),
  ownKeys:t=>[...Array.from({length:t.length},(_,i)=>String(i)),'length'],
  getOwnPropertyDescriptor:(t,k)=>index(k)?{value:read(Number(k)),writable:false,enumerable:true,configurable:true}:Reflect.getOwnPropertyDescriptor(t,k),
  set(){throw Error('Completed observation series is immutable')},
  deleteProperty(){throw Error('Completed observation series is immutable')},
  defineProperty(){throw Error('Completed observation series is immutable')}
 });
 packed.set(facade,{rows:rows.length,bytes:values.byteLength});return facade;
}
function compactCoin(c,now=Date.now()){
 // All collection windows end by 24h20m. Leave an additional 40m margin.
 if(!Number.isFinite(c.t)||now-c.t<25*3600000)return;
 for(const pool of [c,...(c.origs||[])])for(const key of ['ds','lq'])if(pool[key])pool[key]=packRows(pool[key]);
}
function packedStats(C){let series=0,rows=0,bytes=0;
 for(const c of C.values())for(const p of [c,...(c.origs||[])])for(const k of ['ds','lq']){const s=packed.get(p[k]);if(s){series++;rows+=s.rows;bytes+=s.bytes}}
 return {series,rows,bytes};
}
module.exports={packRows,compactCoin,packedStats};
