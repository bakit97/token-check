const test=require('node:test'),a=require('node:assert/strict');const {cardAt}=require('../server/coin-profile');const T=1792400000000,WSOL='So11111111111111111111111111111111111111112';test('foreign quote reserves are never relabeled SOL and carry an explicit reason',()=>{const c={a:'mint',d:'pump-fun',q:'foreign-token',curveSol:[[T,123000000000]]},x=cardAt(c,T);a.equal(x.sol,null);a.equal(x.solUnavailableReason,'non-native-quote');a.equal(x.solQuoteMint,'foreign-token');const native=cardAt({...c,q:WSOL},T);a.equal(native.sol,123);a.equal(native.solUnavailableReason,null);a.equal(native.solMeasuredAt,T);});


test('new migrated pool does not inherit price, transactions or buyers from a still-trading launch curve',()=>{
 const api=require('../server/research-v2'),at=Date.UTC(2026,9,20),old={p:'curve',t:at,ds:[[at/1000,99,999,999,20,5,1000]],gx:[[at/1000,20,5,15,4]],bx:{at,cov:true,payers:15},tr:{x:{t:[at/1000,1,100,'A'.repeat(32),99]}}};
 const coin={p:'new',t:at,mg:{st:'ok',pool:'new'},origs:[old],preObs:old,ds:[]};a.equal(api.samples(coin).length,0);a.equal(api.candles(coin).length,0);const f=api.featuresAt(coin,at);a.equal(f.mc,null);a.equal(f.buyers,null);a.equal(f.trades,null);
 const out=api.activityEvidence(coin,at,at+60000,10);a.equal(out.minutes[0][1],null);a.equal(out.minutes[0][2],null);
});
