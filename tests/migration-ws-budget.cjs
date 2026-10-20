'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const code=fs.readFileSync(process.env.SOLSCAN_TEST_COLLECTOR||path.join(__dirname,'../server/collector.js'),'utf8');
test('TZ20 disables birth socket while DBC, LaunchLab and migration-authority logs stay connected',async()=>{
 const sockets=[],received=[],offered=[],timers=[],metered=[];
 class Socket{constructor(){sockets.push(this);this.sent=[]}send(s){this.sent.push(JSON.parse(s))}close(){this.closed=true;this.onclose?.()}}
 let preAllowed=true;
 const WS={preOn:false,msgs:{},cand:{},bytes:0,err:0,preGapMs:0,prePausedAt:0,preBudgetPauses:0};
 const ctx={require,DIR:path.join(__dirname,'../server'),FAST_DISCOVERY:null,processFastMigration:async()=>{},processManualPool:async()=>{},POOL_DISCOVERY:null,POOL_LOGS:null,offerFastMigration:t=>offered.push(t),EVENT_CLOCK:null,WS,WebSocket:Socket,heliusKey:async()=>'<mock>',RESOURCE:{streamAllowed:()=>preAllowed,stream:(n,source)=>{metered.push(source);return false}},PRE:{onLog:()=>{}},
  PUMP_MINT_AUTH:'mint-auth',PUMP:'pump-program',DBC:'dbc-program',LAUNCH:'ll-program',Buffer,Date,JSON,err:()=>{},b64:x=>x,wsCandidate:(...x)=>received.push(x),
  setTimeout:f=>timers.push(f),setInterval:f=>{timers.push(f);return f},clearInterval:()=>{}};
 vm.createContext(ctx);vm.runInContext(code.slice(code.indexOf('function chainWatch()'),code.indexOf('/* ---------- 6.'))+'\nchainWatch();',ctx);
 await new Promise(r=>setImmediate(r));assert.equal(sockets.length,2);
 const migration=sockets[1];migration.onopen();
 assert.deepEqual(migration.sent.map(x=>x.method),['programSubscribe','programSubscribe','programSubscribe','logsSubscribe']);
 assert.equal(migration.sent[2].params[0],'pump-program');assert.equal(migration.sent[2].params[1].filters[0].memcmp.offset,48);
 assert.equal(migration.sent[0].params[1].filters[1].memcmp.offset,305);
 assert.equal(migration.sent[1].params[1].filters[0].memcmp.offset,17);
 migration.onmessage({data:JSON.stringify({id:100,result:1})});migration.onmessage({data:JSON.stringify({id:101,result:2})});
 preAllowed=false;
 for(let i=0;i<6001;i++)migration.onmessage({data:JSON.stringify({params:{subscription:i%2+1,result:{value:{pubkey:'curve'+i,account:{data:['account']}}}}})});
 assert.equal(received.length,6001);assert.equal(WS.connected.dbc,true);assert.equal(WS.connected.ll,true);assert.equal(migration.closed,undefined);
 migration.onmessage({data:JSON.stringify({id:103,result:4})});
 migration.onmessage({data:JSON.stringify({method:'logsNotification',params:{subscription:4,result:{context:{slot:100},value:{signature:'sig',err:null,logs:['Program log: Instruction: Migrate']}}}})});
 assert.equal(offered.length,0);
 migration.onmessage({data:JSON.stringify({method:'logsNotification',params:{subscription:4,result:{context:{slot:100},value:{signature:'sig',err:null,logs:['Program log: Instruction: MigrateV2','Program log: Instruction: CreatePool']}}}})});
 assert.equal(offered.length,1);
 assert.equal(WS.on,true);assert.equal(WS.preOn,false);assert.equal(metered.includes('pre'),false);
 assert.ok(metered.includes('migrations'));
});
