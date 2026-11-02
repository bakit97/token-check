'use strict';
const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
test('slow checkpoint streams the live census: skips unwritten retired rows and includes births during earlier batches',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'live-census-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const C=new Map(Array.from({length:8},(_,i)=>[String(i),{a:String(i),receivedAt:i}])),src=fs.readFileSync(require.resolve('../server/collector'),'utf8'),line=src.split('\n').find(l=>l.startsWith('function save(){'));let mutated=false;
 const ctx={C,DIR:dir,HEALTH:null,RC:{},RETENTION:{},fs,Promise,Array,JSON,err:e=>{throw Error(e)},require:p=>p.endsWith('packed-observations.js')?{stateCoinAsync:async c=>{if(!mutated&&c.a==='0'){mutated=true;await new Promise(r=>setImmediate(r));C.delete('7');C.set('late',{a:'late',receivedAt:99});}return {...c};}}:require('../server/stream-json')};
 vm.createContext(ctx);const save=vm.runInContext(line+';save;',ctx);a.equal(await save(),true);const rows=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));a.deepEqual(rows.map(r=>r.a),['0','1','2','3','4','5','6','late']);a.equal(rows.at(-1).receivedAt,99);a.equal(rows.length,C.size);a.equal(ctx.RETENTION.stateBytes,fs.statSync(path.join(dir,'state.json')).size);
});
