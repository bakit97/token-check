'use strict';
// Conservative, observational rule discovery on frozen early-time features.
// Rules are learned on older cohorts; a later 100-row holdout is never used
// for threshold discovery. These are diagnostics, not trading instructions.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {proposeRules,ruleStats}=require('./research-v2');
function discover(rows,{level='1',minTrainPositive,minTrainNegative,minValidation=100,
    minPositiveRecall=.65,minNegativeRejection=.65,maxRules=12}={}){
  if(!['1','2'].includes(level))throw TypeError('Unknown research level');
  const pos=level==='1'?'live':'strong',neg=level==='1'?'dead':'weak';
  const good=minTrainPositive??(level==='1'?100:40);
  const bad=minTrainNegative??40;
  const clean=rows.filter(r=>r&&r.mint&&r.features&&[pos,neg].includes(r.label)&&
      Number.isSafeInteger(r.time)).sort((a,b)=>a.time-b.time);
  // Keep complete Kazakhstan-calendar days together: newer validation
  // rows must come from dates absent from the training cohort.
  const kzDay=t=>new Date(t+5*3600000).toISOString().slice(0,10);
  let split=-1;
  for(let i=1;i<clean.length;i++){
    if(kzDay(clean[i-1].time)===kzDay(clean[i].time))continue;
    const early=clean.slice(0,i),late=clean.slice(i);
    const earlyPos=early.filter(r=>r.label===pos).length;
    const earlyNeg=early.length-earlyPos;
    if(earlyPos>=good&&earlyNeg>=bad&&late.length>=minValidation&&
       late.some(r=>r.label===pos)&&late.some(r=>r.label===neg))split=i;
  }
  const enough=split>=0;
  const train=enough?clean.slice(0,split):clean;
  const validation=enough?clean.slice(split):[];
  const counts=(r)=>({positive:r.filter(x=>x.label===pos).length,
    negative:r.filter(x=>x.label===neg).length,total:r.length});
  const training=counts(train),holdout=counts(validation);
  const ready=training.positive>=good&&training.negative>=bad;
  const proposed=ready?proposeRules(train,{positive:pos,negative:neg,
    minPos:good,minNeg:bad,maxRules}):[];
  const rules=proposed.map((r,i)=>{
    const val=holdout.total&&holdout.positive&&holdout.negative?
      ruleStats(validation,r.rule,pos,neg):null;
    const quality=val&&val.positiveRecall>=minPositiveRecall&&
      val.negativeRejection>=minNegativeRejection;
    return {rank:i+1,rule:r.rule,train:r.train,trainScore:r.score,improvementOf:r.improvementOf||null,
      holdout:val,passesHoldout:val?!!quality:null};
  });
  return {schema:1,level,status:!ready?'waiting-training':
    !enough?'training-only':!holdout.positive||!holdout.negative?'waiting-both-holdout-classes':
    'rolling-holdout-ready',
    population:clean.length,classes:{positive:pos,negative:neg},
    training,validation:holdout,
    validationDays:[...new Set(validation.map(r=>kzDay(r.time)))],
    trainingDays:[...new Set(train.map(r=>kzDay(r.time)))],
    required:{
      trainingPositive:good,trainingNegative:bad,
      validation:minValidation,minPositiveRecall,minNegativeRejection
    },rules,method:'later-complete-calendar-days-no-future-features',
    caution:'Provisional observational diagnostics; later holdout is not proof of future performance'};
}
function signature(rule){return (rule.conds||[rule].concat(rule.conditions||[])).map(c=>[c.key,c.op,Number(c.value).toPrecision(8),...(c.op==='between'?[Number(c.value2).toPrecision(8)]:[])].join('|')).sort().join('&')}
const NAMES={buyers:'Покупатели',buyers10:'Ранние покупатели',quoteSol:'SOL в пуле',safeContract:'Безопасный контракт',top10:'Концентрация топ-10',top1:'Крупнейший держатель',trades:'Сделки',volume:'Объём',buySellRatio:'Баланс спроса',buys:'Покупки',sells:'Продажи',sellShare:'Доля продаж',averageTrade:'Средняя сделка',token2022:'Тип токена',hasImage:'Изображение',hasDescription:'Описание',liq:'Ликвидность',mc:'Капитализация'};
class AutoStudies{
 constructor({dir}){this.file=path.join(dir,'auto-studies-v2.json');this.modules=new Map();if(fs.existsSync(this.file)){const x=JSON.parse(fs.readFileSync(this.file,'utf8'));if(x.schema!==1||!Array.isArray(x.modules)||x.modules.length>1000)throw Error('Invalid auto studies');for(const m of x.modules){if(!m.id||!['before','after'].includes(m.phase)||!m.createdAt)throw Error('Invalid auto module');this.modules.set(m.id,m)}}}
 report(rows,{level='1',settings={},now=Date.now(),parentId=null,inherited=[]}={}){
  const phases={},rules=[];let changed=false;
  for(const phase of ['before','after']){
   const cfg=settings.phases?.[phase]||settings,dm=cfg.decisionMinutes||10;
   const compatible=(r,minutes)=>!r.decisionAt||Math.abs((r.decisionAt-r.acceptedAt)/60000-minutes)<.01;
   const bank=rows.filter(r=>r.phase===phase&&compatible(r,dm));
   const report=discover(bank,{level,minTrainPositive:cfg.targetLive??cfg.targetStrong??(level==='1'?100:40),minTrainNegative:cfg.targetDead??cfg.targetWeak??40});phases[phase]=report;
   for(const proposal of report.rules){
    const original=proposal.rule.conds||[proposal.rule].concat(proposal.rule.conditions||[]);
    const base=inherited.flatMap(f=>f.conds||[f].concat(f.conditions||[]));
    const allowed=original.filter(c=>!base.some(b=>b.key===c.key&&b.op===c.op&&(c.op==='between'?c.value<=b.value&&c.value2>=b.value2:c.op==='>='?c.value<=b.value:c.value>=b.value)));
    if(!allowed.length)continue;const candidate={...proposal,rule:{...allowed[0],conditions:allowed.slice(1),conds:allowed}};
    if(allowed.length!==original.length){const day=t=>new Date(t+5*3600000).toISOString().slice(0,10),trainDays=new Set(report.trainingDays),valDays=new Set(report.validationDays),pos=level==='1'?'live':'strong',neg=level==='1'?'dead':'weak';candidate.train=ruleStats(bank.filter(r=>trainDays.has(day(r.time))),candidate.rule,pos,neg);candidate.holdout=valDays.size?ruleStats(bank.filter(r=>valDays.has(day(r.time))),candidate.rule,pos,neg):null;if(candidate.train.positiveRecall<.55||candidate.train.negativeRejection<.5)continue;}
    const sig=[level,phase,dm,parentId||'',signature(candidate.rule)].join('|'),id='auto'+level+'_'+crypto.createHash('sha256').update(sig).digest('hex').slice(0,20);
    if(this.modules.has(id)||this.modules.size>=1000)continue;
    const close=[...this.modules.values()].some(m=>m.level===level&&m.phase===phase&&(m.parentId||null)===parentId&&m.verdictMinutes===dm&&m.conds.length===allowed.length&&allowed.every(c=>m.conds.some(b=>b.key===c.key&&b.op===c.op&&Math.abs(c.value-b.value)<=Math.max(1e-8,Math.abs(b.value)*.05)&&(c.op!=='between'||Math.abs(c.value2-b.value2)<=Math.max(1e-8,Math.abs(b.value2)*.05)))));if(close)continue;
    const conds=(candidate.rule.conds||[candidate.rule].concat(candidate.rule.conditions||[])).map(c=>({key:c.key,op:c.op,value:c.value,...(c.op==='between'?{value2:c.value2}:{})}));
    const m={id,level,phase,parentId,improvementOf:candidate.improvementOf||null,name:((candidate.improvementOf?'Улучшение · ':'')+conds.map(c=>(NAMES[c.key]||c.key)+' '+c.op+' '+Number(c.value.toPrecision(4))+(c.op==='between'?'…'+Number(c.value2.toPrecision(4)):'')).join(' · ')).slice(0,64),verdictMinutes:dm,conds,createdAt:now,liveFrom:now,evalSig:sig,
      eval:{train:candidate.train,holdout:candidate.holdout,live:null,test:null},rule:candidate.rule};
    this.modules.set(id,m);changed=true;
   }
   for(const m of this.modules.values())if(m.level===level&&m.phase===phase&&(m.parentId||null)===parentId){
    const eligible=rows.filter(r=>r.phase===phase&&compatible(r,m.verdictMinutes)&&r.acceptedAt>=m.liveFrom),pos=level==='1'?'live':'strong',neg=level==='1'?'dead':'weak';
    const live=eligible.length?ruleStats(eligible,m.rule,pos,neg):null;
    if(!m.eval.holdout&&eligible.length>=100){const holdout=eligible.slice().sort((a,b)=>a.time-b.time).slice(0,100),check=ruleStats(holdout,m.rule,pos,neg);if(check.totalPositive&&check.totalNegative){m.eval.holdout=check;changed=true}}
    if(live&&JSON.stringify(live)!==JSON.stringify(m.eval.live)){m.eval.live=live;changed=true}
    rules.push({...m,rule:{...m.rule,phase:m.phase,verdictMinutes:m.verdictMinutes},train:m.eval.train,holdout:m.eval.holdout,live:m.eval.live});
   }
  }
  if(changed){const tmp=this.file+'.tmp',fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify({schema:1,modules:[...this.modules.values()]}));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,this.file);require('./durable-json').syncDirectory(path.dirname(this.file))}
  return {schema:2,level,status:'phase-separated',phases,rules,unsupportedFeatures:['creator-history','sniper-bundle-identification','bot-identification','LP-lock-without-proof'],updated:now};
 }
 reportParents(rows,options={}){
  const cohorts=new Map();for(const row of rows)for(const f of row.sourceFilterVersions||[]){const id=f.id+'@'+f.version;if(!cohorts.has(id))cohorts.set(id,[]);cohorts.get(id).push(row)}
  const reports={},rules=[];for(const [id,bank] of cohorts){const inherited=bank[0].sourceFilterRules||[];const [filterId,version]=id.split('@');const r=this.report(bank,{...options,level:'2',parentId:id,inherited:inherited.filter(f=>f.id===filterId&&String(f.version)===version)});reports[id]=r.phases;rules.push(...r.rules)}
  return {schema:2,level:'2',status:'phase-and-parent-separated',cohorts:reports,rules,updated:options.now||Date.now()};
 }

}
module.exports={discover,signature,AutoStudies};
