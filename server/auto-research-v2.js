'use strict';
// Conservative, observational rule discovery on frozen early-time features.
// Rules are learned on older cohorts; a later 100-row holdout is never used
// for threshold discovery. These are diagnostics, not trading instructions.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {proposeRules,ruleStats,wilsonInterval,verifiedFeatures}=require('./research-v2');
function holdoutQuality(stat,{minPositiveRecall=.65,minNegativeRejection=.65,candidates=1}={}){if(!stat)return false;const z=Math.sqrt(2*Math.log(2*Math.max(1,candidates)/.05));stat.positiveRecallLowerAdjusted=wilsonInterval(stat.passedPositive,stat.totalPositive,z).low;stat.negativeRejectionLowerAdjusted=wilsonInterval(stat.rejectedNegative,stat.totalNegative,z).low;stat.adjustedZ=z;return stat.evaluablePositive>=20&&stat.evaluableNegative>=20&&stat.positiveRecallLowerAdjusted>=minPositiveRecall&&stat.negativeRejectionLowerAdjusted>=minNegativeRejection;}
function discover(rows,{level='1',minTrainPositive,minTrainNegative,minValidation=100,minPositiveRecall=.65,minNegativeRejection=.65,maxRules=12,missPenalty=3}={}){
 if(!['1','2'].includes(level))throw TypeError('Unknown research level');const pos=level==='1'?'live':'strong',neg=level==='1'?'dead':'weak',good=Math.max(20,minTrainPositive??(level==='1'?100:40)),bad=Math.max(20,minTrainNegative??40),clean=rows.filter(r=>r&&r.mint&&r.features&&[pos,neg].includes(r.label)&&Number.isSafeInteger(r.time)).sort((a,b)=>a.time-b.time),day=t=>new Date(t+5*3600000).toISOString().slice(0,10);let split=-1;
 for(let i=1;i<clean.length;i++){if(day(clean[i-1].time)===day(clean[i].time))continue;const late=clean.slice(i),early=clean.slice(0,i).filter(r=>(r.outcomeAt??r.windowEnd??r.time)<=late[0].time),ep=early.filter(r=>r.label===pos).length;if(ep>=good&&early.length-ep>=bad&&late.length>=minValidation&&late.filter(r=>r.label===pos).length>=20&&late.filter(r=>r.label===neg).length>=20)split=i;}
 const train=split>=0?clean.slice(0,split).filter(r=>(r.outcomeAt??r.windowEnd??r.time)<=clean[split].time):clean,validation=split>=0?clean.slice(split):[],count=r=>({positive:r.filter(x=>x.label===pos).length,negative:r.filter(x=>x.label===neg).length,total:r.length}),training=count(train),holdout=count(validation),ready=training.positive>=good&&training.negative>=bad,metrics={rulesTried:0},proposed=ready?proposeRules(train,{positive:pos,negative:neg,minPos:good,minNeg:bad,maxRules,missPenalty,metrics}):[],period=r=>({from:r[0]?.time??null,to:r.at(-1)?.time??null,days:[...new Set(r.map(x=>day(x.time)))]}),decorate=(stat,data)=>stat?{...stat,period:period(data),rulesTried:metrics.rulesTried,missPenalty}:null;
 const rules=proposed.map((r,i)=>{const val=holdout.positive&&holdout.negative?ruleStats(validation,r.rule,pos,neg):null,quality=holdoutQuality(val,{minPositiveRecall,minNegativeRejection,candidates:proposed.length});return {rank:i+1,rule:r.rule,train:decorate(r.train,train),trainScore:r.score,improvementOf:r.improvementOf||null,holdout:decorate(val,validation),passesHoldout:val?quality:null};});
 return {schema:2,level,status:!ready?'waiting-training':split<0?'training-only':'rolling-holdout-ready',population:clean.length,classes:{positive:pos,negative:neg},training,validation:holdout,trainingDays:period(train).days,validationDays:period(validation).days,dataPeriod:{train:period(train),holdout:period(validation)},rulesTried:metrics.rulesTried,missPenalty,multipleTesting:{method:'independent-later-day-holdout-bonferroni-conservative-normal-tail',holdoutCandidates:proposed.length,familyAlpha:.05},required:{trainingPositive:good,trainingNegative:bad,validation:minValidation,holdoutEachClass:20,minPositiveRecall,minNegativeRejection},rules,method:'later-complete-calendar-days-no-future-features',caution:'Observed diagnostics; passing holdout does not guarantee future results'};
}
function signature(rule){return (rule.conds||[rule].concat(rule.conditions||[])).map(c=>[c.key,c.op,Number(c.value).toPrecision(8),...(c.op==='between'?[Number(c.value2).toPrecision(8)]:[])].join('|')).sort().join('&')}
const NAMES={ageAtMigrationMin:'Возраст к миграции, мин',buyers:'Покупатели',buyers10:'Ранние покупатели',quoteSol:'SOL в пуле',safeContract:'Безопасный контракт',top10:'Концентрация топ-10',top1:'Крупнейший держатель',trades:'Сделки',volume:'Объём',buySellRatio:'Баланс спроса',buys:'Покупки',sells:'Продажи',sellShare:'Доля продаж',averageTrade:'Средняя сделка',token2022:'Тип токена',hasImage:'Изображение',hasDescription:'Описание',liq:'Ликвидность',mc:'Капитализация'};
class AutoStudies{
 constructor({dir}){this.file=path.join(dir,'auto-studies-v2.json');this.modules=new Map();if(fs.existsSync(this.file)){const x=JSON.parse(fs.readFileSync(this.file,'utf8'));if(x.schema!==1||!Array.isArray(x.modules)||x.modules.length>1000)throw Error('Invalid auto studies');for(const m of x.modules){if(!m.id||!['before','after'].includes(m.phase)||!m.createdAt)throw Error('Invalid auto module');this.modules.set(m.id,m)}}}
 report(rows,{level='1',settings={},now=Date.now(),parentId=null,inherited=[]}={}){
  const phases={},rules=[];let changed=false;
  for(const phase of ['before','after']){
   const cfg=settings.phases?.[phase]||settings,dm=cfg.decisionMinutes||10;
   const compatible=(r,minutes)=>!r.decisionAt||Math.abs((r.decisionAt-require('./event-clock').eventAnchor(r))/60000-minutes)<.01;
   const bank=rows.filter(r=>r.phase===phase&&compatible(r,dm)&&r.acceptedAt<=now&&(r.outcomeAt==null||r.outcomeAt<=now)).map(r=>({...r,features:verifiedFeatures(r.features)}));
   const report=discover(bank,{level,minTrainPositive:cfg.targetLive??cfg.targetStrong??(level==='1'?100:40),minTrainNegative:cfg.targetDead??cfg.targetWeak??40,missPenalty:cfg.missPenalty??3});phases[phase]=report;
   for(const proposal of report.rules){
    if(proposal.passesHoldout!==true)continue;
    const original=proposal.rule.conds||[proposal.rule].concat(proposal.rule.conditions||[]);
    const base=inherited.flatMap(f=>f.conds||[f].concat(f.conditions||[]));
    const allowed=original.filter(c=>!base.some(b=>b.key===c.key&&b.op===c.op&&(c.op==='between'?c.value<=b.value&&c.value2>=b.value2:c.op==='>='?c.value<=b.value:c.value>=b.value)));
    if(!allowed.length)continue;const candidate={...proposal,rule:{...allowed[0],conditions:allowed.slice(1),conds:allowed}};
    if(allowed.length!==original.length){const day=t=>new Date(t+5*3600000).toISOString().slice(0,10),trainDays=new Set(report.trainingDays),valDays=new Set(report.validationDays),pos=level==='1'?'live':'strong',neg=level==='1'?'dead':'weak';candidate.train=ruleStats(bank.filter(r=>trainDays.has(day(r.time))),candidate.rule,pos,neg);candidate.holdout=valDays.size?ruleStats(bank.filter(r=>valDays.has(day(r.time))),candidate.rule,pos,neg):null;if(candidate.train.positiveRecall<.55||candidate.train.negativeRejection<.5)continue;}
    if(!holdoutQuality(candidate.holdout,{candidates:report.rules.length}))continue;candidate.train={...candidate.train,period:report.dataPeriod.train,rulesTried:report.rulesTried,missPenalty:cfg.missPenalty??3};candidate.holdout={...candidate.holdout,period:report.dataPeriod.holdout,rulesTried:report.rulesTried,missPenalty:cfg.missPenalty??3};
    const sig=[level,phase,dm,parentId||'',signature(candidate.rule)].join('|'),id='auto'+level+'_'+crypto.createHash('sha256').update(sig).digest('hex').slice(0,20);
    if(this.modules.get(id)?.validatedBirth||!this.modules.has(id)&&this.modules.size>=1000)continue;
    const close=[...this.modules.values()].some(m=>m.validatedBirth===true&&m.level===level&&m.phase===phase&&(m.parentId||null)===parentId&&m.verdictMinutes===dm&&m.conds.length===allowed.length&&allowed.every(c=>m.conds.some(b=>b.key===c.key&&b.op===c.op&&Math.abs(c.value-b.value)<=Math.max(1e-8,Math.abs(b.value)*.05)&&(c.op!=='between'||Math.abs(c.value2-b.value2)<=Math.max(1e-8,Math.abs(b.value2)*.05)))));if(close)continue;
    const conds=(candidate.rule.conds||[candidate.rule].concat(candidate.rule.conditions||[])).map(c=>({key:c.key,op:c.op,value:c.value,...(c.op==='between'?{value2:c.value2}:{})}));
    const m={id,level,phase,validatedBirth:true,selection:{rulesTried:report.rulesTried,missPenalty:cfg.missPenalty??3,dataPeriod:report.dataPeriod,multipleTesting:report.multipleTesting},parentId,improvementOf:candidate.improvementOf||null,name:((candidate.improvementOf?'Улучшение · ':'')+conds.map(c=>(NAMES[c.key]||c.key)+' '+c.op+' '+Number(c.value.toPrecision(4))+(c.op==='between'?'…'+Number(c.value2.toPrecision(4)):'')).join(' · ')).slice(0,64),verdictMinutes:dm,conds,createdAt:now,liveFrom:now,evalSig:sig,
      eval:{train:candidate.train,holdout:candidate.holdout,live:null,test:null},rule:candidate.rule};
    this.modules.set(id,m);changed=true;
   }
   for(const m of this.modules.values())if(m.validatedBirth===true&&m.level===level&&m.phase===phase&&(m.parentId||null)===parentId){
    const eligible=rows.filter(r=>r.phase===phase&&compatible(r,m.verdictMinutes)&&r.acceptedAt>=m.liveFrom),pos=level==='1'?'live':'strong',neg=level==='1'?'dead':'weak';
    const live=eligible.length?ruleStats(eligible,m.rule,pos,neg):null;
    if(!m.eval.holdout&&eligible.length>=100){const holdout=eligible.slice().sort((a,b)=>a.time-b.time).slice(0,100),check=ruleStats(holdout,m.rule,pos,neg);if(check.totalPositive&&check.totalNegative){m.eval.holdout=check;changed=true}}
    if(live&&JSON.stringify(live)!==JSON.stringify(m.eval.live)){m.eval.live=live;changed=true}
    rules.push({...m,rule:{...m.rule,phase:m.phase,verdictMinutes:m.verdictMinutes},train:m.eval.train,holdout:m.eval.holdout,live:m.eval.live});
   }
  }
  if(changed){const tmp=this.file+'.tmp',fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify({schema:1,modules:[...this.modules.values()]}));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,this.file);require('./durable-json').syncDirectory(path.dirname(this.file))}
  return {schema:2,level,status:'phase-separated',phases,rules,supportedScopes:{creator:'observed-prior-launches-and-verified-positive-associated-account',snipers:'verified-pump-opening-slots',bundles:'observed-common-funding-lower-bound',smart:'ready-registry-known-at-admission'},unsupportedFeatures:['bot-identification','LP-lock-without-proof'],updated:now};
 }
 reportParents(rows,options={}){
  const cohorts=new Map();for(const row of rows)for(const f of row.sourceFilterVersions||[]){const id=f.id+'@'+f.version;if(!cohorts.has(id))cohorts.set(id,[]);cohorts.get(id).push(row)}
  const reports={},rules=[];for(const [id,bank] of cohorts){const inherited=bank[0].sourceFilterRules||[];const [filterId,version]=id.split('@');const r=this.report(bank,{...options,level:'2',parentId:id,inherited:inherited.filter(f=>f.id===filterId&&String(f.version)===version)});reports[id]=r.phases;rules.push(...r.rules)}
  return {schema:2,level:'2',status:'phase-and-parent-separated',cohorts:reports,rules,updated:options.now||Date.now()};
 }

}
module.exports={discover,holdoutQuality,signature,AutoStudies};
