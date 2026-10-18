'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(process.env.SOLSCAN_TEST_COLLECTOR||path.join(__dirname,'../server/collector.js'),'utf8');
test('pool migration retains raw account data and fetched trades with their original receipt evidence',()=>{
 const raw={1:{at:1000,slot:1,b:['curve']}},tr={f:[[1100,1,1,1]],x:{sig:[1,'owner',1,true,1]}},coin={a:'mint',p:'curve',raw,tr,rawUp:0,trDone:0,vaultIdentityAt:900,ds:[[1,1]]};
 const ctx={};vm.createContext(ctx);vm.runInContext(code.slice(code.indexOf('const OBS_KEYS='),code.indexOf('function load(){'))+'\nthis.take=takeObs;',ctx);const captured=ctx.take(coin);
 assert.equal(captured.raw,raw);assert.equal(captured.tr,tr);assert.equal(captured.tr.f[0][0],1100);assert.equal(captured.raw[1].at,1000);assert.equal(coin.raw,undefined);assert.equal(captured.vaultIdentityAt,900);assert.equal(coin.vaultIdentityAt,undefined);
});
test('new contract export uses lazy rows and preserves DS, vault, raw counts for validation',async()=>{
 let sent;const coin={a:'mint',p:'pool',t:1000000,d:'pumpswap',ds:[[1001,2]],lq:[[1002,1,1,2]],raw:{1:{at:1003000,b:['state']}}};
 const ctx={DIR:'mock',SOURCE:{get:()=>({phase:'after',acceptedAt:1001000})},rec:c=>({a:c.a,n:'coin'}),require:p=>p.endsWith('observation-contract.js')?require('../server/observation-contract'):require('../server/stream-json'),upload:async(name,obj)=>{sent={name,...obj,coins:[...obj.coins]}}};
 vm.createContext(ctx);vm.runInContext(code.slice(code.indexOf('async function exportObservationContract('),code.indexOf('async function exportDays(){'))+'\nthis.send=exportObservationContract;',ctx);
 const result=await ctx.send('observations-v2/day.json',[coin],1100000);assert.equal(result.dsRows,1);assert.equal(result.vaultRows,1);assert.equal(result.rawStates,1);assert.equal(sent.coins[0].observations.pools[0].ds[0].at,1001000);assert.equal(sent.coins[0].observations.pools[0].rawStates[1].b[0],'state');assert.equal(sent.schema,2);
});
