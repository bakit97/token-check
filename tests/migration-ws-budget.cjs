'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(process.env.SOLSCAN_TEST_COLLECTOR||path.join(__dirname,'../server/collector.js'),'utf8');
test('DBC and LaunchLab survive exhausted pre quota and more than 5000 migration notifications',async()=>{
 const sockets=[],received=[],timers=[],metered=[];
 class Socket{constructor(){sockets.push(this);this.sent=[]}send(s){this.sent.push(JSON.parse(s))}close(){this.closed=true;this.onclose?.()}}
 let preAllowed=true;
 const WS={msgs:{},cand:{},bytes:0,err:0,preGapMs:0,prePausedAt:0,preBudgetPauses:0};
 const ctx={WS,WebSocket:Socket,heliusKey:async()=>'<mock>',RESOURCE:{streamAllowed:()=>preAllowed,stream:(n,source)=>{metered.push(source);return false}},PRE:{onLog:()=>{}},
  PUMP_MINT_AUTH:'mint-auth',DBC:'dbc-program',LAUNCH:'ll-program',Buffer,Date,JSON,err:()=>{},b64:x=>x,wsCandidate:(...x)=>received.push(x),
  setTimeout:f=>timers.push(f),setInterval:f=>{timers.push(f);return f},clearInterval:()=>{}};
 vm.createContext(ctx);vm.runInContext(code.slice(code.indexOf('function chainWatch()'),code.indexOf('/* ---------- 6.'))+'\nchainWatch();',ctx);
 await new Promise(r=>setImmediate(r));assert.equal(sockets.length,2);
 const [migration,pre]=sockets;migration.onopen();pre.onopen();
 assert.deepEqual(migration.sent.map(x=>x.method),['programSubscribe','programSubscribe']);
 assert.equal(migration.sent[0].params[1].filters[1].memcmp.offset,305);
 assert.equal(migration.sent[1].params[1].filters[0].memcmp.offset,17);
 migration.onmessage({data:JSON.stringify({id:100,result:1})});migration.onmessage({data:JSON.stringify({id:101,result:2})});
 preAllowed=false;
 for(let i=0;i<6001;i++)migration.onmessage({data:JSON.stringify({params:{subscription:i%2+1,result:{value:{pubkey:'curve'+i,account:{data:['account']}}}}})});
 assert.equal(received.length,6001);assert.equal(WS.connected.dbc,true);assert.equal(WS.connected.ll,true);assert.equal(migration.closed,undefined);
 pre.onmessage({data:JSON.stringify({id:150,result:3})});
 pre.onmessage({data:JSON.stringify({params:{subscription:3,result:{value:{signature:'create'}}}})});
 assert.equal(pre.closed,true);assert.equal(WS.on,true);assert.equal(WS.preOn,false);assert.ok(WS.preBudgetPauses>0);
 assert.ok(metered.includes('migrations'));assert.ok(metered.includes('pre'));
});
