'use strict';
// Offline audit: no cloud credentials, RPC, publication or mutation of source data.
const fs=require('node:fs'),path=require('node:path'),{readRows}=require('../server/stream-json');
const {hydrateArchives,archiveCandidates}=require('../server/observation-archives');
async function main(){const [mode,contracts,archives,report]=process.argv.slice(2);
 if(!['inventory','audit'].includes(mode)||!report)throw Error('usage: node audit-observation-archives.cjs inventory|audit CONTRACT_DIR ARCHIVE_DIR REPORT');
 const refs=new Set(),stats={coins:0,references:0,statuses:{},rawSamples:0,rawDecodedBytes:0,tradeRows:0,tradeFetches:0},failures=[];
 for(const file of fs.readdirSync(contracts).filter(n=>/^observations-v2_.*\.json$/.test(n))){
  for(const row of readRows(path.join(contracts,file),null,{field:'coins'})){
   stats.coins++;
   if(mode==='inventory'){for(const p of row.observations.pools)for(const kind of ['rawStates','trades'])if(p.archives?.[kind])refs.add(p.archives[kind]);continue;}
   const r=await hydrateArchives(row,async name=>{
    if(!/^(?:raw\/|archive\/legacy\/raw\/|observations-v2\/raw\/)\d{4}-\d{2}-\d{2}\/[1-9A-HJ-NP-Za-km-z]+(?:\/[1-9A-HJ-NP-Za-km-z]+-\d+)?-(state|trades)\.json$/.test(name))throw Error('Unsafe archive path');
    for(const candidate of archiveCandidates(name)){const file=path.resolve(archives,...candidate.split('/'));if(!file.startsWith(path.resolve(archives)+path.sep))throw Error('Unsafe archive root');
     try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e}
    }return null;
   });
   for(const c of r.checks){stats.references++;stats.statuses[c.status]=(stats.statuses[c.status]||0)+1;
    for(const field of ['rawSamples','rawDecodedBytes','tradeRows','tradeFetches'])stats[field]+=c[field]||0;
    if(c.status!=='verified'&&failures.length<100)failures.push(c);}
  }
 }
 const out=mode==='inventory'?{references:[...refs].sort()}: {...stats,okay:!Object.keys(stats.statuses).some(s=>s!=='verified'),failures,scope:'Referenced archives only; historical gaps and missing references are not certified. Readers and legacy writers unchanged.'};
 fs.writeFileSync(report,JSON.stringify(out,null,2));console.log(JSON.stringify(mode==='inventory'?{references:refs.size}:out));
 if(mode==='audit'&&!out.okay)process.exitCode=2;
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
