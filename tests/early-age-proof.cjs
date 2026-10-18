'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(process.env.SOLSCAN_TEST_COLLECTOR||path.join(__dirname,'../server/collector.js'),'utf8');
test('Old GT events and stale slots are rejected before even constructing proof RPC; unknown clocks remain unverified',async()=>{
 const observed=[],at=200000000;
 const ctx={EVENT_CLOCK:{estimate:slot=>slot===1?{at:at-160000,ageMs:160000,source:'slot-estimate'}:null},SOURCE:{has:()=>false,settings:()=>({afterMinutes:2}),observe:x=>observed.push(x)},Date:{now:()=>at},isOk:c=>c.mg?.st==='ok',setMg:(c,st,k,why)=>c.mg={st,k,why},rpcFor:()=>{throw Error('Proof RPC must not start')}};
 vm.createContext(ctx);
 vm.runInContext(code.slice(code.indexOf('function proofEventAge('),code.indexOf('function proofAgeBand('))+'\n'+code.slice(code.indexOf('async function migCheck(c)'),code.indexOf('const MIGNAME='))+'\nthis.check=migCheck;this.reject=rejectOldProof;',ctx);
 const gt={a:'old',t:at-150001,tSrc:'gt'},ws={a:'slot',migrationSlot:1};
 await ctx.check(gt);await ctx.check(ws);
 assert.equal(observed.length,2);assert.equal(observed[0].outcome,'tooOld');assert.equal(ws.proofAgeEstimate.source,'slot-estimate');
 const timely={a:'new',t:at-149999,tSrc:'gt'};assert.equal(ctx.reject(timely),false);
 assert.equal(ctx.reject({a:'proven',t:1,tSrc:'gt',mg:{st:'ok'}}),false);
});
