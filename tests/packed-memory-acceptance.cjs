'use strict';
// Separate processes measure retained representation rather than allocator reuse.
const {spawnSync}=require('node:child_process'),assert=require('node:assert/strict');
if(!process.argv[2]){
 const measure=mode=>{const p=spawnSync(process.execPath,['--expose-gc',__filename,mode],{encoding:'utf8'});if(p.status!==0)throw Error(p.stderr||p.stdout);return JSON.parse(p.stdout)};
 const ordinary=measure('ordinary'),packed=measure('packed');
 assert.equal(packed.rows,ordinary.rows);assert.equal(packed.checksum,ordinary.checksum);
 assert.ok(packed.heapUsedMB<ordinary.heapUsedMB*.65,'Retained JS heap did not decrease sufficiently');
 assert.ok(packed.rssMB<ordinary.rssMB,'Packed startup RSS must improve');
 console.log(JSON.stringify({ordinary,packed}));
}else{
 const {packRows}=require('../server/packed-observations'),coins=[];
 for(let i=0;i<4000;i++){
  const ds=Array.from({length:200},(_,j)=>[1700000000+j,1.234567+i/1000000,j%3?null:j,50000,j,1,j*100,5,8,10000]);
  coins.push(process.argv[2]==='packed'?packRows(ds):ds);
 }
 for(let i=0;i<3;i++)global.gc();
 let checksum=0;for(const ds of coins)checksum+=ds[199][1];
 const m=process.memoryUsage();console.log(JSON.stringify({rows:coins.reduce((s,c)=>s+c.length,0),checksum,heapUsedMB:m.heapUsed/1e6,rssMB:m.rss/1e6,arrayBuffersMB:m.arrayBuffers/1e6}));
}
