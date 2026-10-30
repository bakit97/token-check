const test=require('node:test'),a=require('node:assert/strict');const {PoolLogs}=require('../server/pool-logs'),{definitions}=require('../server/manual-pools');
function setup(){const sockets=[],signals=[];class Socket{constructor(){sockets.push(this);this.sent=[];}send(s){this.sent.push(JSON.parse(s));}close(){this.closed=true;this.onclose?.();}}const feed=new PoolLogs({WebSocket:Socket,definitions,onSignal:t=>signals.push(t),setTimer:()=>({}),clearTimer:()=>{}});feed.start();const ws=sockets[0];ws.onopen();ws.sent.forEach((m,i)=>ws.onmessage({data:JSON.stringify({id:m.id,result:100+i})}));return {feed,ws,signals};}
test('public subscriptions require all acks and only successful exact known initialize logs produce a candidate',()=>{const {feed,ws,signals}=setup();a.equal(feed.summary().available,true);const first=definitions[0],send=(err,name='Initialize')=>ws.onmessage({data:JSON.stringify({method:'logsNotification',params:{subscription:100,result:{context:{slot:4},value:{err,signature:'sig',logs:['Program '+first.program+' invoke [1]','Program log: Instruction: '+name]}}}})});send({failed:true});send(null,'InitializeReward');a.equal(signals.length,0);send(null);send(null);a.equal(signals.length,1);a.equal(signals[0].slot,4);a.equal(feed.summary().duplicates,1);a.equal(feed.summary().heliusWS,false);feed.stop();a.equal(feed.summary().available,false);});
test('6001 noisy swaps do not trigger JSON.parse in the public log handler',()=>{const {feed,ws,signals}=setup(),parse=JSON.parse;let calls=0;JSON.parse=(...args)=>{calls++;return parse(...args);};try{for(let i=0;i<6001;i++)ws.onmessage({data:'{"method":"logsNotification","logs":["Program log: Instruction: Swap"]}'});}finally{JSON.parse=parse;}a.equal(calls,0);a.equal(signals.length,0);a.equal(feed.summary().noise,6001);});
test('public overload closes its socket and never affects core subscriptions',()=>{const {feed,ws}=setup();feed.maxBytesSecond=20;ws.onmessage({data:'x'.repeat(101)});a.equal(ws.closed,true);a.equal(feed.summary().available,false);a.equal(feed.summary().overload,1);});

test('discarded public swaps refresh the slot clock at most once per five seconds without JSON.parse',()=>{
 let at=10000,ws;const observed=[];class Socket{constructor(){ws=this;}send(){}close(){this.onclose?.();}}
 const feed=new PoolLogs({WebSocket:Socket,definitions,onSignal:()=>{},onSlot:(slot,when)=>observed.push([slot,when]),now:()=>at,setTimer:()=>({}),clearTimer:()=>{}});feed.start();ws.onopen();const parse=JSON.parse;let calls=0;JSON.parse=(...args)=>{calls++;return parse(...args);};
 try{for(let i=0;i<6001;i++)ws.onmessage({data:'{"method":"logsNotification","params":{"result":{"context":{"slot":123},"logs":["Program log: Instruction: Swap"]}}}'});at+=5001;ws.onmessage({data:'{"method":"logsNotification","params":{"result":{"context":{"slot":124},"logs":["Program log: Instruction: Swap"]}}}'});}finally{JSON.parse=parse;}
 a.equal(calls,0);a.deepEqual(observed,[[123,10000],[124,15001]]);a.equal(feed.summary().clockSamples,2);feed.stop();
});

test('existing pool logs pass an official migration signature hint only with its exact program and instruction',()=>{
 const {feed,ws,signals}=setup(),spec=require('../server/migration-fast').specs.find(x=>x.family==='dbc'),def=definitions.find(x=>x.program===spec.dex),programs=[...new Set(definitions.map(x=>x.program))],label=n=>'Program log: Instruction: '+n.replace(/(^|_)([a-z0-9])/g,(_,p,c)=>c.toUpperCase());
 function send(signature,extra,err=null){ws.onmessage({data:JSON.stringify({method:'logsNotification',params:{subscription:100+programs.indexOf(def.program),result:{context:{slot:42},value:{err,signature,logs:['Program '+def.program+' invoke [2]',label(def.name),...extra]}}}})});}
 send('migration',['Program '+spec.program+' invoke [1]',label(spec.name)]);a.equal(signals[0].migrationKind,'dbc');a.equal(signals[0].signature,'migration');
 send('ordinary',[]);a.equal(signals[1].migrationKind,undefined);
 send('spoof',[label(spec.name)]);a.equal(signals[2].migrationKind,undefined);
 send('prefix',['Program '+spec.program+' invoke [1]',label(spec.name)+'Other']);a.equal(signals[3].migrationKind,undefined);
 send('failed',['Program '+spec.program+' invoke [1]',label(spec.name)],{failed:true});a.equal(signals.length,4);
 a.equal(feed.summary().subscriptions,programs.length);feed.stop();
});
test('migration log hint enters proof queue rather than direct admission or manual discovery',()=>{
 const vm=require('node:vm'),fs=require('node:fs'),src=fs.readFileSync(require.resolve('../server/collector.js'),'utf8'),line=src.split('\n').find(x=>x.includes('POOL_LOGS=new ')),fast=[],manual=[],ctx={DIR:'/runtime',WebSocket:class{},offerFastMigration:t=>fast.push(t),POOL_DISCOVERY:{offer:t=>manual.push(t)},EVENT_CLOCK:null,require:p=>p.endsWith('pool-logs.js')?{PoolLogs:class{constructor(options){ctx.options=options;}start(){}}}:{definitions}};
 vm.createContext(ctx);vm.runInContext(line,ctx);ctx.options.onSignal({signature:'known',kind:'pool',migrationKind:'dbc',slot:1});ctx.options.onSignal({signature:'manual',kind:'pool',slot:2});a.equal(fast.length,1);a.equal(fast[0].kind,'dbc');a.equal(fast[0].signature,'known');a.equal(manual.length,1);
});

test('InitializeAccount3 token-account noise is rejected before JSON.parse while the exact pool instruction stays subscribed',()=>{const {feed,ws}=setup(),parse=JSON.parse;let calls=0;JSON.parse=(...args)=>{calls++;return parse(...args);};try{ws.onmessage({data:'{"method":"logsNotification","logs":["Program log: Instruction: InitializeAccount3"]}'});}finally{JSON.parse=parse;}a.equal(calls,0);a.equal(feed.summary().noise,1);feed.stop();});
