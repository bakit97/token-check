"use strict";
// Conservative estimates bound retained data without serializing whole RPC replies.
function estimate(value,limit){let bytes=0,nodes=0;const seen=new Set(),stack=[value];while(stack.length){const x=stack.pop();if(++nodes>50000)return Infinity;if(typeof x==='string')bytes+=x.length*2+24;else if(x&&typeof x==='object'){if(seen.has(x))continue;seen.add(x);bytes+=64;if(ArrayBuffer.isView(x))bytes+=x.byteLength;else for(const key of Object.keys(x)){bytes+=key.length*2+16;stack.push(x[key]);if(stack.length>50000)return Infinity;}}else bytes+=16;if(bytes>limit)return Infinity;}return bytes;}
class BoundedCache{
 constructor({entries=32,bytes=8*1024*1024,itemBytes=1024*1024,ttl=300000,now=Date.now}={}){this.map=new Map();this.maxEntries=entries;this.maxBytes=bytes;this.itemBytes=itemBytes;this.ttl=ttl;this.now=now;this.bytes=0;this.evicted=0;this.expired=0;this.oversized=0;}
 delete(k){const row=this.map.get(k);if(!row)return false;this.bytes-=row.bytes;return this.map.delete(k);}
 sweep(){const now=this.now();for(const [k,r] of this.map)if(r.until<=now){this.delete(k);this.expired++;}}
 get(k){const r=this.map.get(k);if(!r)return undefined;if(r.until<=this.now()){this.delete(k);this.expired++;return undefined;}this.map.delete(k);this.map.set(k,r);return r.value;}
 has(k){return this.get(k)!==undefined;}
 set(k,value){this.sweep();this.delete(k);const bytes=estimate(value,this.itemBytes)+String(k).length*2;if(bytes>this.itemBytes||bytes>this.maxBytes){this.oversized++;return this;}while(this.map.size&&(this.map.size>=this.maxEntries||this.bytes+bytes>this.maxBytes)){this.delete(this.map.keys().next().value);this.evicted++;}this.map.set(k,{value,bytes,until:Math.min(this.now()+this.ttl,Number.isFinite(value?.until)?value.until:Infinity)});this.bytes+=bytes;return this;}
 keys(){return this.map.keys();}
 get size(){this.sweep();return this.map.size;}
 summary(){this.sweep();return {entries:this.map.size,estimatedBytes:this.bytes,maxBytes:this.maxBytes,maxEntries:this.maxEntries,ttlMs:this.ttl,evicted:this.evicted,expired:this.expired,oversized:this.oversized};}
}
module.exports={BoundedCache,estimate};
