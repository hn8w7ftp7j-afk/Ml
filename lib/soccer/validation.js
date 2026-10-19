import { fitScoreModel,evaluateScoreModel,predictScoreModel } from './score-model.js';
export const SOCCER_VALIDATION_PROTOCOL=Object.freeze({version:'SOCCER-ROLLING-DIAGNOSTIC-v1',testYears:[2023,2024,2025],historyStarts:2021,halfLives:[180,365,730],penalties:[.002,.01],assumedResultLagHours:24,bootstrapUnit:'UTC_CALENDAR_WEEK',bootstrapReplicates:2000,bootstrapSeed:20261018,interpretation:'RETROSPECTIVE_DEVELOPMENT_DIAGNOSTIC_NOT_NEW_UNTOUCHED_TEST',promotion:false});
const before=(r,t)=>Date.parse(r.startTime)+86400000<Date.parse(t);
export function rollingSoccerFold(rows,league,testYear,grid=SOCCER_VALIDATION_PROTOCOL){
  if(!SOCCER_VALIDATION_PROTOCOL.testYears.includes(testYear)||rows.some(r=>r.league!==league))throw Error('SOCCER_VALIDATION_SCOPE_INVALID');
  const validationStart=`${testYear-1}-01-01T00:00:00.000Z`,testStart=`${testYear}-01-01T00:00:00.000Z`,testEnd=`${testYear+1}-01-01T00:00:00.000Z`;
  const train=rows.filter(r=>before(r,validationStart)),validation=rows.filter(r=>r.startTime>=validationStart&&r.startTime<testStart),test=rows.filter(r=>r.startTime>=testStart&&r.startTime<testEnd);
  const trials=[];
  for(const halfLifeDays of grid.halfLives)for(const penalty of grid.penalties){const model=fitScoreModel(train,{league,cutoff:validationStart,halfLifeDays,penalty,maxIterations:6000,tolerance:1e-6});const metrics=evaluateScoreModel(model,validation,{fold:`rolling-${testYear}-validation`});trials.push({halfLifeDays,penalty,trainingHash:model.trainingHash,converged:model.fit.converged,validationCount:metrics.count,validationTotal:metrics.total,validationLogLoss:metrics.logLoss});}
  const candidates=trials.filter(t=>t.converged&&Number.isFinite(t.validationLogLoss)&&t.validationCount>0).sort((a,b)=>a.validationLogLoss-b.validationLogLoss);if(!candidates.length)throw Error('SOCCER_VALIDATION_NO_MODEL');
  const selected={halfLifeDays:candidates[0].halfLifeDays,penalty:candidates[0].penalty};
  const finalRows=rows.filter(r=>before(r,testStart)),fit=dependence=>fitScoreModel(finalRows,{league,cutoff:testStart,...selected,maxIterations:6000,tolerance:1e-6,dependence});
  const model=fit(true),reference=fit(false),metrics=evaluateScoreModel(model,test,{fold:`rolling-${testYear}`}),referenceMetrics=evaluateScoreModel(reference,test,{fold:`rolling-${testYear}`});
  const paired=[];
  for(const r of test){try{const a=predictScoreModel(model,r),b=predictScoreModel(reference,r),key=r.homeGoals>r.awayGoals?'home':r.homeGoals===r.awayGoals?'draw':'away',modelLoss=-Math.log(a.outcomes[key]),referenceLoss=-Math.log(b.outcomes[key]);paired.push({eventId:r.eventId,startTime:r.startTime,modelLoss,referenceLoss,difference:modelLoss-referenceLoss});}catch{}}
  return{league,testYear,validationStart,testStart,testEnd,selected,trials,trainingHash:model.trainingHash,trainingCount:model.trainingCount,metrics,referenceMetrics,paired,comparison:pairedBlockDifference(paired),historicalAvailabilityVerified:false,formalPromotion:false};
}
export function pairedBlockDifference(rows,{replicates=2000,seed=20261018}={}){
  if(!Number.isInteger(replicates)||replicates<100||replicates>10000||!Number.isInteger(seed)||rows.some(r=>!Number.isFinite(r.difference)||!Number.isFinite(Date.parse(r.startTime))))throw Error('SOCCER_BOOTSTRAP_INPUT_INVALID');
  const seen=new Set(),blocks=new Map();for(const r of rows){if(seen.has(r.eventId))throw Error('SOCCER_BOOTSTRAP_DUPLICATE_GAME');seen.add(r.eventId);const day=new Date(r.startTime),weekday=(day.getUTCDay()+6)%7;day.setUTCDate(day.getUTCDate()-weekday);const key=day.toISOString().slice(0,10);if(!blocks.has(key))blocks.set(key,[]);blocks.get(key).push(r.difference);}
  const values=[...blocks.values()];if(values.length<2)return{status:'INSUFFICIENT_BLOCKS',games:rows.length,blocks:values.length,interval:null};
  let state=seed>>>0;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const samples=[];for(let i=0;i<replicates;i++){let sum=0,count=0;for(let j=0;j<values.length;j++){const b=values[Math.floor(random()*values.length)];sum+=b.reduce((a,b)=>a+b,0);count+=b.length;}samples.push(sum/count);}samples.sort((a,b)=>a-b);
  const lower=samples[Math.floor(.025*(replicates-1))],upper=samples[Math.ceil(.975*(replicates-1))];return{status:'DESCRIPTIVE_WEEK_BLOCK_BOOTSTRAP',games:rows.length,blocks:values.length,replicates,seed,meanDifference:rows.reduce((s,r)=>s+r.difference,0)/rows.length,interval:{lower,upper,level:.95},intervalBelowZero:upper<0,assumption:'Sampled UTC week blocks are exchangeable; interval does not address model selection or acquisition bias',marketOrProfitEvidence:false};
}
