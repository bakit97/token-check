'use strict';
// Conservative, observational rule discovery on frozen early-time features.
// Rules are learned on older cohorts; a later 100-row holdout is never used
// for threshold discovery. These are diagnostics, not trading instructions.
const {proposeRules,ruleStats}=require('./research-v2');
function discover(rows,{level='1',minTrainPositive,minTrainNegative,minValidation=100,
    minPositiveRecall=.65,minNegativeRejection=.65,maxRules=12}={}){
  if(!['1','2'].includes(level))throw TypeError('Unknown research level');
  const pos=level==='1'?'live':'strong',neg=level==='1'?'dead':'weak';
  const good=minTrainPositive??(level==='1'?100:40);
  const bad=minTrainNegative??40;
  const clean=rows.filter(r=>r&&r.mint&&r.features&&[pos,neg].includes(r.label)&&
      Number.isSafeInteger(r.time)).sort((a,b)=>a.time-b.time);
  const enough=clean.length>=good+bad+minValidation;
  const train=enough?clean.slice(0,-minValidation):clean;
  const validation=enough?clean.slice(-minValidation):[];
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
    return {rank:i+1,rule:r.rule,train:r.train,trainScore:r.score,
      holdout:val,passesHoldout:val?!!quality:null};
  });
  return {schema:1,level,status:!ready?'waiting-training':
    !enough?'training-only':!holdout.positive||!holdout.negative?'waiting-both-holdout-classes':
    'rolling-holdout-ready',
    population:clean.length,classes:{positive:pos,negative:neg},
    training,validation:holdout,required:{
      trainingPositive:good,trainingNegative:bad,
      validation:minValidation,minPositiveRecall,minNegativeRejection
    },rules,method:'chronological-holdout-no-future-features',
    caution:'Provisional observational diagnostics; later holdout is not proof of future performance'};
}
module.exports={discover};
