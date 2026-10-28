import { createHash } from 'node:crypto';
import { buildSoccerProbabilityAudit, soccerProbabilityAuditFields } from './probability-audit.js';

export const SOCCER_MODEL_VERSION = 'SOCCER-POISSON-DC-RESEARCH-v1';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function scoreDistribution(homeRate, awayRate, rho = 0, tolerance = 1e-12) {
  if (![homeRate, awayRate].every(x => Number.isFinite(x) && x > 0 && x <= 30) || !Number.isFinite(rho) || !(tolerance > 0 && tolerance < 1e-6)) throw Error('SOCCER_RATE_INVALID');
  const tau = (h,a) => h === 0 && a === 0 ? 1-homeRate*awayRate*rho : h === 0 && a === 1 ? 1+homeRate*rho : h === 1 && a === 0 ? 1+awayRate*rho : h === 1 && a === 1 ? 1-rho : 1;
  if ([[0,0],[0,1],[1,0],[1,1]].some(([h,a]) => tau(h,a) <= 0)) throw Error('SOCCER_DEPENDENCE_INVALID');
  function poisson(rate) { const p=[Math.exp(-rate)];let sum=p[0];for(let i=1;1-sum>tolerance/2;i++){if(i>300)throw Error('SOCCER_TAIL_NOT_CONVERGED');p.push(p.at(-1)*rate/i);sum+=p.at(-1);}return {p,sum}; }
  const hp=poisson(homeRate),ap=poisson(awayRate),cells=[];let mass=0,home=0,draw=0,away=0;
  for(let h=0;h<hp.p.length;h++)for(let a=0;a<ap.p.length;a++){const probability=hp.p[h]*ap.p[a]*tau(h,a);cells.push({home:h,away:a,probability});mass+=probability;if(h>a)home+=probability;else if(h===a)draw+=probability;else away+=probability;}
  // Retained mass is NOT renormalized: report the omitted tail explicitly.
  const tailMass=Math.max(0,1-mass);if(tailMass>tolerance*1.1||mass>1+1e-10)throw Error('SOCCER_PROBABILITY_MASS_INVALID');
  return {homeRate,awayRate,rho,cells,retainedMass:mass,tailMass,tolerance,outcomes:{home,draw,away},distributionFamily:'POISSON_DIXON_COLES',period:'REGULATION_FT',halfTime:null};
}
export function validateTrainingRows(rows, league, cutoff) {
  if (!['epl','ucl'].includes(league) || !Number.isFinite(Date.parse(cutoff)) || !Array.isArray(rows)) throw Error('SOCCER_TRAINING_SCOPE_INVALID');
  const seen=new Map();
  for(const r of rows){
    if(r.league!==league || !/^\d+$/.test(r.eventId||'') || !/^\d+$/.test(r.homeId||'') || !/^\d+$/.test(r.awayId||'') || r.homeId===r.awayId || r.period!=='REGULATION_FT' || !Number.isFinite(Date.parse(r.startTime)) || Date.parse(r.startTime)+86400000>=Date.parse(cutoff) || ![r.homeGoals,r.awayGoals].every(x=>Number.isInteger(x)&&x>=0&&x<=30) || !r.source?.url || !r.source.contentHash)throw Error('SOCCER_TRAINING_ROW_INVALID');
    const key=`${league}:${r.eventId}`;if(seen.has(key)&&JSON.stringify(seen.get(key))!==JSON.stringify(r))throw Error('SOCCER_TRAINING_REVISION_CONFLICT');seen.set(key,r);
  }
  return [...seen.values()].sort((a,b)=>a.startTime.localeCompare(b.startTime)||a.eventId.localeCompare(b.eventId));
}
// Offline likelihood-reweighting only. Keep original rows/IDs and trainingHash;
// a separate receipt identifies the positive per-match likelihood weights.
export function soccerObservationWeights(rows, observationWeights) {
  if (observationWeights == null) return null;
  if (typeof observationWeights !== 'object' || Array.isArray(observationWeights)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(observationWeights))) throw Error('SOCCER_OBSERVATION_WEIGHTS_INVALID');
  const keys = Object.keys(observationWeights), ids = new Set(rows.map(row => row.eventId));
  if (keys.length !== ids.size || keys.some(id => !ids.has(id)) || rows.some(row => !Object.hasOwn(observationWeights, row.eventId)
      || !Number.isFinite(observationWeights[row.eventId]) || observationWeights[row.eventId] <= 0)) throw Error('SOCCER_OBSERVATION_WEIGHTS_INVALID');
  const values = rows.map(row => observationWeights[row.eventId]);
  return { values, receipt: { version: 'SOCCER-MATCH-LIKELIHOOD-WEIGHTS-v1', count: rows.length,
    weightsHash: hash(rows.map((row, index) => ({ eventId: row.eventId, weight: values[index] }))) } };
}
export function fitScoreModel(input, {league,cutoff,halfLifeDays=365,penalty=.01,maxIterations=1800,tolerance=1e-7,dependence=true,observationWeights=null}={}) {
  const rows=validateTrainingRows(input,league,cutoff);if(rows.length<30)throw Error('SOCCER_TRAINING_INSUFFICIENT');
  if(!(halfLifeDays>0&&penalty>0)||!Number.isInteger(maxIterations)||maxIterations<1||!(tolerance>0))throw Error('SOCCER_FIT_OPTIONS_INVALID');
  const ids=[...new Set(rows.flatMap(r=>[r.homeId,r.awayId]))].sort(),index=new Map(ids.map((x,i)=>[x,i])),n=ids.length;
  const weighting=soccerObservationWeights(rows,observationWeights);
  const timeWeights=rows.map(r=>Math.exp(-Math.LN2*(Date.parse(cutoff)-Date.parse(r.startTime))/86400000/halfLifeDays));
  const weights=weighting?timeWeights.map((weight,index)=>weight*weighting.values[index]):timeWeights,weightSum=weights.reduce((a,b)=>a+b,0);
  if(weighting&&(!Number.isFinite(weightSum)||weightSum<=0||weights.some(weight=>!Number.isFinite(weight)||weight<=0)))throw Error('SOCCER_OBSERVATION_WEIGHT_NUMERICS_INVALID');
  const mean=rows.reduce((s,r,i)=>s+weights[i]*(r.homeGoals+r.awayGoals),0)/(2*weightSum);
  if(weighting&&!Number.isFinite(mean))throw Error('SOCCER_OBSERVATION_WEIGHT_NUMERICS_INVALID');
  if(!(mean>0))throw Error('SOCCER_TRAINING_NO_GOALS');
  let p=Array(2+2*n).fill(0);p[0]=Math.log(mean);
  function objective(v,gradient=false){let loss=0;const g=Array(v.length).fill(0);
    for(let k=0;k<rows.length;k++){const r=rows[k],hi=index.get(r.homeId),ai=index.get(r.awayId),w=weights[k]/weightSum;
      const homeIndicator=r.neutralSite?0:1,lh=v[0]+homeIndicator*v[1]+v[2+hi]+v[2+n+ai],la=v[0]+v[2+ai]+v[2+n+hi],h=Math.exp(lh),a=Math.exp(la);
      loss+=w*(h-r.homeGoals*lh+a-r.awayGoals*la);if(gradient){const dh=w*(h-r.homeGoals),da=w*(a-r.awayGoals);g[0]+=dh+da;g[1]+=homeIndicator*dh;g[2+hi]+=dh;g[2+n+ai]+=dh;g[2+ai]+=da;g[2+n+hi]+=da;}}
    for(let i=2;i<v.length;i++){loss+=penalty*v[i]*v[i]/2;if(gradient)g[i]+=penalty*v[i];}return{loss,g};
  }
  let iterations=0,converged=false,gradientNorm=null;
  for(;iterations<maxIterations;iterations++){const {loss,g}=objective(p,true);gradientNorm=Math.sqrt(g.reduce((s,x)=>s+x*x,0));if(gradientNorm<tolerance){converged=true;break;}let step=1,accepted=false;
    for(let k=0;k<30;k++){const candidate=p.map((x,i)=>x-step*g[i]);if(objective(candidate).loss<=loss-1e-4*step*gradientNorm**2){p=candidate;accepted=true;break;}step/=2;}if(!accepted)break;
  }
  // Conditional low-score dependence is fitted on TRAINING scores only.
  // This is a disclosed baseline, not a claim of joint Dixon–Coles maximum likelihood.
  const rates=r=>[Math.exp(p[0]+(r.neutralSite?0:p[1])+p[2+index.get(r.homeId)]+p[2+n+index.get(r.awayId)]),Math.exp(p[0]+p[2+index.get(r.awayId)]+p[2+n+index.get(r.homeId)])];
  let rho=0,best=Infinity;const rhoScores=[];
  for(const value of dependence?[-.15,-.1,-.05,0,.05,.1,.15]:[0]){let loss=0,valid=true;
    for(let i=0;i<rows.length;i++){const [h,a]=rates(rows[i]);const factors=[1-h*a*value,1+h*value,1+a*value,1-value];if(factors.some(x=>x<=0)){valid=false;break;}const {homeGoals:x,awayGoals:y}=rows[i];const t=x===0&&y===0?factors[0]:x===0&&y===1?factors[1]:x===1&&y===0?factors[2]:x===1&&y===1?factors[3]:1;loss-=weights[i]*Math.log(t)/weightSum;}
    rhoScores.push({rho:value,valid,conditionalLoss:valid?loss:null});if(valid&&loss<best){best=loss;rho=value;}}
  const coefficients=Object.fromEntries(ids.map((id,i)=>[id,{attack:p[2+i],defence:p[2+n+i]}]));
  return {version:SOCCER_MODEL_VERSION,league,period:'REGULATION_FT',cutoff,trainedThrough:rows.at(-1).startTime,trainingCount:rows.length,trainingHash:hash(rows),halfLifeDays,penalty,intercept:p[0],homeEffect:p[1],rho,coefficients,fit:{converged,iterations,gradientNorm,rhoScores,dependenceFit:'CONDITIONAL_TRAINING_GRID'},status:'RESEARCH_ONLY',executable:false,missing:['NO_XG_OR_PLAYER_EFFECTS','NO_DOMESTIC_CROSS_LEAGUE_MAPPING','NO_VERIFIED_HALF_TIME_MODEL','RETROSPECTIVE_AVAILABILITY_UNVERIFIED'],...(weighting?{observationWeighting:weighting.receipt}:{})};
}
export function predictScoreModel(model,game){
  if(model?.version!==SOCCER_MODEL_VERSION||game?.league!==model.league||game.homeId===game.awayId||!Number.isFinite(Date.parse(game.startTime))||Date.parse(game.startTime)<Date.parse(model.cutoff)||model.fit?.converged!==true)throw Error('SOCCER_MODEL_NOT_APPLICABLE');
  const h=model.coefficients[game.homeId],a=model.coefficients[game.awayId];if(!h||!a)throw Error('SOCCER_TEAM_NOT_TRAINED');
  const homeRate=Math.exp(model.intercept+(game.neutralSite?0:model.homeEffect)+h.attack+a.defence),awayRate=Math.exp(model.intercept+a.attack+h.defence);
  return {...scoreDistribution(homeRate,awayRate,model.rho),modelVersion:model.version,trainingHash:model.trainingHash,trainedThrough:model.trainedThrough,status:'RESEARCH_ONLY',executable:false};
}
export function soccerScoreLogProbability(homeGoals,awayGoals,homeRate,awayRate,rho=0){
  if(![homeGoals,awayGoals].every(x=>Number.isInteger(x)&&x>=0&&x<=30)||![homeRate,awayRate].every(x=>Number.isFinite(x)&&x>0&&x<=30)||!Number.isFinite(rho))throw Error('SOCCER_OBSERVED_SCORE_INVALID');
  const factors=[1-homeRate*awayRate*rho,1+homeRate*rho,1+awayRate*rho,1-rho];if(factors.some(x=>x<=0))throw Error('SOCCER_DEPENDENCE_INVALID');
  const lf=n=>{let sum=0;for(let i=2;i<=n;i++)sum+=Math.log(i);return sum;};
  const factor=homeGoals===0&&awayGoals===0?factors[0]:homeGoals===0&&awayGoals===1?factors[1]:homeGoals===1&&awayGoals===0?factors[2]:homeGoals===1&&awayGoals===1?factors[3]:1;
  return-homeRate+homeGoals*Math.log(homeRate)-lf(homeGoals)-awayRate+awayGoals*Math.log(awayRate)-lf(awayGoals)+Math.log(factor);
}
export function evaluateScoreModel(model,rows,{fold=null}={}){
  const modelHash=hash(model),scope={league:model.league,period:'REGULATION_FT',fold,modelHash};
  const context=row=>({...scope,trainingHash:model.trainingHash??null,cutoff:model.cutoff??null,startTime:row?.startTime??null,resultSourceHash:row?.source?.contentHash??null});
  let logLoss=0,brier=0,scoreLogLoss=0;const outcomes=['home','draw','away'],coverage=[];const bins=Array.from({length:10},(_,i)=>({from:i/10,to:(i+1)/10,count:0,predicted:0,observed:0}));
  for(const row of rows){try{
    // Check result identity, period and provenance before updating any metric.
    // Prediction applicability alone cannot establish that this is an FT result.
    if(row?.league!==model.league||!/^\d+$/.test(row?.eventId||'')||!/^\d+$/.test(row?.homeId||'')||!/^\d+$/.test(row?.awayId||'')||row.homeId===row.awayId||row.period!=='REGULATION_FT'||!Number.isFinite(Date.parse(row.startTime))||!row.source?.url||!row.source?.contentHash)throw Error('SOCCER_EVALUATION_ROW_INVALID');
    const d=predictScoreModel(model,row),outcome=row.homeGoals>row.awayGoals?'home':row.homeGoals===row.awayGoals?'draw':'away';const scoreLoss=-soccerScoreLogProbability(row.homeGoals,row.awayGoals,d.homeRate,d.awayRate,d.rho);logLoss-=Math.log(d.outcomes[outcome]);brier+=outcomes.reduce((s,k)=>s+(d.outcomes[k]-(k===outcome?1:0))**2,0);scoreLogLoss+=scoreLoss;for(const key of outcomes){const p=d.outcomes[key],bin=bins[Math.min(9,Math.floor(p*10))];bin.count++;bin.predicted+=p;bin.observed+=key===outcome?1:0;}coverage.push({eventId:row.eventId,status:'EVALUATED',...context(row),actualScore:{home:row.homeGoals,away:row.awayGoals},...soccerProbabilityAuditFields(d,outcome,-scoreLoss)});}catch(e){coverage.push({eventId:row?.eventId??null,status:'SKIPPED',reason:e.message,...context(row)});}}
  const count=coverage.filter(x=>x.status==='EVALUATED').length;return {total:rows.length,count,coverage:rows.length?count/rows.length:0,logLoss:count?logLoss/count:null,brier:count?brier/count:null,scoreLogLoss:count?scoreLogLoss/count:null,bins:bins.map(b=>({...b,meanPredicted:b.count?b.predicted/b.count:null,observedFrequency:b.count?b.observed/b.count:null})),games:coverage,probabilityAudit:buildSoccerProbabilityAudit(coverage,scope),profit:null,bettingEvidence:false};
}
