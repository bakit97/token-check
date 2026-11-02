'use strict';
const test=require('node:test'),a=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('day retention defers secondary R1 bank I/O, and the next idle cycle resumes both operations',async()=>{
 const src=fs.readFileSync(require.resolve('../server/collector'),'utf8'),start=src.indexOf('  if(!DAY_EXPORT_BUSY){',src.indexOf('async function exportResearchV2(')),end=src.indexOf('async function exportPathsV2(',start),writes=[];
 const ctx={DAY_EXPORT_BUSY:true,manualPool:{enabled:false},RESEARCH_EXPORTS:{},SOURCE:{revokedManual:new Set()},activeMigrationRevocations:()=>new Map(),runtime:{config:{},select:()=>[{mint:'preserved',phase:'after'}]},RESEARCH_BANKS:{removeRevoked(){},relabelOneAsync:async()=>writes.push('labels'),upsertAsync:async rows=>writes.push(rows[0].mint)}};
 vm.createContext(ctx);vm.runInContext('async function run(){'+src.slice(start,end)+';this.run=run;',ctx);await ctx.run();a.deepEqual(writes,[]);ctx.DAY_EXPORT_BUSY=false;await ctx.run();a.deepEqual(writes,['labels','preserved']);
});
