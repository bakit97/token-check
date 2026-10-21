"use strict";
// REQUEST is prefixed by the publisher. No keys or environment dumps in receipts.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const processStamp=pid=>{const text=fs.readFileSync('/proc/'+pid+'/stat','utf8');return text.slice(text.lastIndexOf(')')+2).split(' ')[19];};
async function main(){const generation=String(process.env.CODE_GEN||'');if(generation!==REQUEST.allowedFromGeneration){console.log(JSON.stringify({request:REQUEST.id,action:'skipped-other-generation'}));return;}
 const parent=process.ppid,stamp=processStamp(parent),command=fs.readFileSync('/proc/'+parent+'/cmdline','utf8');if(!/(?:^|\0)[^\0]*collector\.js(?:\0|$)/.test(command))throw Error('Recovery parent is not the collector');
 let body;for(let attempt=0;attempt<3;attempt++){try{const response=await fetch(REQUEST.collectorUrl,{signal:AbortSignal.timeout(15000)});if(!response.ok||Number(response.headers?.get('content-length')||0)>512*1024)throw Error('Recovery code unavailable');body=Buffer.from(await response.arrayBuffer());break;}catch(e){if(attempt===2)throw Error('Recovery code unavailable');await delay(1000);}}if(body.length>512*1024||crypto.createHash('sha256').update(body).digest('hex')!==REQUEST.targetHash)throw Error('Recovery code checksum mismatch');
 const dir=process.env.SOLSCAN_DIR||'/var/solscan',lock=path.join(dir,'checkpoint-recovery.lock');const lockFD=fs.openSync(lock,'wx');fs.closeSync(lockFD);try{const state=path.join(dir,'state.json'),before=fs.statSync(state).mtimeMs,deadline=Date.now()+REQUEST.maxWaitMs;let fresh=null;
 while(Date.now()<deadline){await delay(1000);const row=fs.statSync(state);if(row.mtimeMs>before&&row.size>0&&row.size<=REQUEST.maxStateBytes){fresh=row;break;}}
 if(!fresh)throw Error('No new complete bounded checkpoint; parent left running');
 const backup=path.join(dir,'checkpoint-before-recovery.json');await fs.promises.copyFile(state,backup);let count=0;require(path.join(dir,'stream-json.js')).loadRows(backup,row=>{require(path.join(dir,'packed-observations.js')).restoreStateCoin(row);count++;});if(!count)throw Error('Empty recovery checkpoint');
 if(processStamp(parent)!==stamp)throw Error('Recovery parent changed; no signal sent');
 const receipt={request:REQUEST.id,fromGeneration:generation,action:'SIGINT-after-verified-complete-checkpoint',rows:count,stateBytes:fs.statSync(backup).size,at:Date.now()};await fs.promises.writeFile(path.join(dir,'checkpoint-recovery-receipt.json'),JSON.stringify(receipt));console.log(JSON.stringify(receipt));process.kill(parent,'SIGINT');}finally{await fs.promises.unlink(lock).catch(()=>{});}
}
main().catch(e=>{console.error('Checkpoint recovery refused: '+e.message);process.exitCode=1;});
