import { createHash } from 'node:crypto';

export const SOCCER_CONDITIONS_MODEL_VERSION = 'SOCCER-SCHEDULE-CONGESTION-POISSON-RIDGE-RESEARCH-v1';
export const SOCCER_CONDITIONS_FEATURES = Object.freeze(['intercept','ownShortKickoffGap96h','opponentShortKickoffGap96h','ownObservedFixtures14dScaled','opponentObservedFixtures14dScaled','neutralVenueSide']);
export const SOCCER_CONDITIONS_PROTOCOL = Object.freeze({version:SOCCER_CONDITIONS_MODEL_VERSION,
  trainingBefore:'2024-01-01T00:00:00.000Z',validationBefore:'2025-01-01T00:00:00.000Z',testBefore:'2026-01-01T00:00:00.000Z',
  liveTrainingBefore:'2026-10-18T00:00:00.000Z',ridgePenalties:[.001,.01,.1],selection:'VALIDATION_FULL_SCORE_POISSON_LOG_LOSS',
  assumedResultLagHours:24,teamPriorMatches:5,minimumPriorTeamMatches:3,minimumPriorCompetitionMatches:20,
  baselineUpdateRule:'SEQUENTIAL_PRIOR_RESULTS_ONLY_WITH_FIXED_LAG_AND_PRIOR_NO_TEST_PARAMETER_FIT',
  featureScope:'OBSERVED_SAME_COMPETITION_FIXTURES_ONLY_NOT_PHYSICAL_REST',historicalPointInTimeVerified:false,formalPromotion:false});
export const soccerConditionsHash=value=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)).digest('hex');
const DAY=86400000;
const finite=Number.isFinite;
const instant=value=>typeof value==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(value)?Date.parse(value):NaN;
const validId=value=>typeof value==='string'&&/^\d{1,16}$/.test(value);
const dot=(a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0);
const seal=value=>({...value,contentHash:soccerConditionsHash(value)});
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
export function soccerConditionsCovariates(own,opponent,neutral,home){
  if(![own,opponent].every(side=>side&&finite(side.kickoffGapHours)&&side.kickoffGapHours>0&&Number.isSafeInteger(side.observedFixtures14d)&&side.observedFixtures14d>=0))throw Error('SOCCER_CONDITIONS_FEATURES_INVALID');
  return [1,Math.max(0,(96-own.kickoffGapHours)/96),Math.max(0,(96-opponent.kickoffGapHours)/96),Math.min(12,own.observedFixtures14d)/4,Math.min(12,opponent.observedFixtures14d)/4,neutral?(home?1:-1):0];
}
function state(){return{matches:0,homeGoals:0,awayGoals:0,teams:{}};}
function update(s,row){s.matches++;s.homeGoals+=row.homeGoals;s.awayGoals+=row.awayGoals;for(const side of ['home','away']){const key=row[`${side}Id`],team=s.teams[key]||(s.teams[key]={matches:0,for:0,against:0});team.matches++;team.for+=row[`${side}Goals`];team.against+=row[`${side==='home'?'away':'home'}Goals`];}}
export function soccerConditionsPriorRates(s,homeId,awayId){
  if(!s||s.matches<20||[homeId,awayId].some(id=>(s.teams[id]?.matches||0)<3))return null;
  const global=(s.homeGoals+s.awayGoals)/(2*s.matches),prior=SOCCER_CONDITIONS_PROTOCOL.teamPriorMatches;
  if(!(global>0))return null;
  const rate=(ownId,oppId,home)=>{const own=s.teams[ownId],opp=s.teams[oppId];const attack=(own.for+prior*global)/(own.matches+prior),defence=(opp.against+prior*global)/(opp.matches+prior);return(home?s.homeGoals/s.matches:s.awayGoals/s.matches)*attack*defence/(global*global);};
  const rates={homeRate:rate(homeId,awayId,true),awayRate:rate(awayId,homeId,false)};
  return Object.values(rates).every(value=>finite(value)&&value>0)?rates:null;
}

// Backfilled results are never asserted to have been available historically.
// The fixed lag is an explicit retrospective assumption, not a receipt.
export function buildSoccerConditionsRows(input,league,{before='2100-01-01T00:00:00Z'}={}){
  if(!['epl','ucl'].includes(league)||!Array.isArray(input)||!finite(instant(before)))throw Error('SOCCER_CONDITIONS_SCOPE_INVALID');
  if(input.some(row=>row?.league!==league||!finite(instant(row.startTime))))throw Error('SOCCER_CONDITIONS_HISTORY_SCOPE_INVALID');
  const seen=new Set(),rows=input.filter(row=>row?.league===league&&instant(row.startTime)<instant(before)).map(row=>{
    if(!validId(row.eventId)||!validId(row.homeId)||!validId(row.awayId)||row.homeId===row.awayId||!finite(instant(row.startTime))||row.period!=='REGULATION_FT'||![row.homeGoals,row.awayGoals].every(x=>Number.isSafeInteger(x)&&x>=0&&x<=100)||!['ESPN'].includes(row.source?.provider)||!/^[a-f0-9]{64}$/.test(row.source?.contentHash||''))throw Error('SOCCER_CONDITIONS_HISTORY_INVALID');
    if(seen.has(row.eventId))throw Error('SOCCER_CONDITIONS_DUPLICATE_GAME');seen.add(row.eventId);return row;
  }).sort((a,b)=>instant(a.startTime)-instant(b.startTime)||a.eventId.localeCompare(b.eventId));
  const s=state(),pastByTeam=new Map(),modeled=[];let cursor=0;
  for(const row of rows){const cutoff=instant(row.startTime)-DAY;
    while(cursor<rows.length&&instant(rows[cursor].startTime)<cutoff){const old=rows[cursor++];update(s,old);for(const id of [old.homeId,old.awayId]){if(!pastByTeam.has(id))pastByTeam.set(id,[]);pastByTeam.get(id).push(old);}}
    const rates=soccerConditionsPriorRates(s,row.homeId,row.awayId);if(!rates)continue;
    const features=Object.fromEntries(['home','away'].map(side=>{const past=pastByTeam.get(row[`${side}Id`])||[],last=past.at(-1);return[side,{kickoffGapHours:(instant(row.startTime)-instant(last.startTime))/3600000,observedFixtures14d:past.filter(old=>instant(old.startTime)>=instant(row.startTime)-14*DAY).length,lastEventId:last.eventId}];}));
    modeled.push({league,eventId:row.eventId,startTime:row.startTime,homeGoals:row.homeGoals,awayGoals:row.awayGoals,baselineRates:rates,
      features,homeX:soccerConditionsCovariates(features.home,features.away,row.neutralSite===true,true),awayX:soccerConditionsCovariates(features.away,features.home,row.neutralSite===true,false),sourceHashes:[row.source.contentHash]});
  }
  // Live priors are computed only from retained results known before cutoff
  // under this same explicit lag, with no future/result-window contamination.
  const live=state();for(const row of rows)if(instant(row.startTime)<instant(before)-DAY)update(live,row);
  return {rows:modeled,liveBaseline:live,inputHash:soccerConditionsHash(rows),sourceRows:rows.length,sourceHashes:[...new Set(rows.map(row=>row.source.contentHash))].sort(),historicalPointInTimeVerified:false};
}
function solve(matrix,vector){const a=matrix.map((row,i)=>[...row,vector[i]]),n=vector.length;for(let i=0;i<n;i++){let pivot=i;for(let j=i+1;j<n;j++)if(Math.abs(a[j][i])>Math.abs(a[pivot][i]))pivot=j;if(Math.abs(a[pivot][i])<1e-14)throw Error('SOCCER_CONDITIONS_SINGULAR_FIT');[a[i],a[pivot]]=[a[pivot],a[i]];const d=a[i][i];for(let k=i;k<=n;k++)a[i][k]/=d;for(let j=0;j<n;j++)if(j!==i){const v=a[j][i];for(let k=i;k<=n;k++)a[j][k]-=v*a[i][k];}}return a.map(row=>row[n]);}
export function fitSoccerConditionsPoisson(examples,penalty){
  if(!Array.isArray(examples)||examples.length<10||!finite(penalty)||penalty<=0||examples.some(row=>row.x?.length!==6||!row.x.every(finite)||!finite(row.offset)||!Number.isSafeInteger(row.y)||row.y<0))throw Error('SOCCER_CONDITIONS_FIT_INPUT_INVALID');
  const n=examples.length,beta=Array(6).fill(0),objective=b=>examples.reduce((sum,row)=>{const log=row.offset+dot(row.x,b);return sum+Math.exp(log)-row.y*log;},0)/n+penalty*b.reduce((sum,x,i)=>sum+(i?x*x:0),0)/2;
  let converged=false,iterations=0;
  for(;iterations<80;iterations++){const gradient=beta.map((x,i)=>i?penalty*x:0),h=beta.map((_,i)=>beta.map((_,j)=>i===j&&i?penalty:0));for(const row of examples){const mu=Math.exp(row.offset+dot(row.x,beta));for(let i=0;i<6;i++){gradient[i]+=(mu-row.y)*row.x[i]/n;for(let j=0;j<6;j++)h[i][j]+=mu*row.x[i]*row.x[j]/n;}}
    const step=solve(h,gradient),current=objective(beta);let scale=1,candidate;
    while(scale>1e-8){candidate=beta.map((value,i)=>value-scale*step[i]);if(finite(objective(candidate))&&objective(candidate)<=current+1e-12)break;scale/=2;}
    if(scale<=1e-8)throw Error('SOCCER_CONDITIONS_FIT_LINE_SEARCH_FAILED');
    for(let i=0;i<6;i++)beta[i]=candidate[i];if(Math.max(...step.map(x=>Math.abs(scale*x)))<1e-9){converged=true;break;}}
  if(!converged||!beta.every(finite))throw Error('SOCCER_CONDITIONS_FIT_NOT_CONVERGED');
  return {coefficients:beta,penalty,observations:n,iterations:iterations+1,converged:true};
}
const examples=rows=>rows.flatMap(row=>['home','away'].map(side=>({x:row[`${side}X`],offset:Math.log(row.baselineRates[`${side}Rate`]),y:row[`${side}Goals`]})));
const logFactorial=n=>{let sum=0;for(let i=2;i<=n;i++)sum+=Math.log(i);return sum;};
export function soccerConditionsMetrics(rows,coefficients=Array(6).fill(0)){
  const paired=rows.map(row=>{let scoreLogLoss=0,absoluteError=0;const rates={};for(const side of ['home','away']){const rate=row.baselineRates[`${side}Rate`]*Math.exp(dot(row[`${side}X`],coefficients)),actual=row[`${side}Goals`];rates[side]=rate;scoreLogLoss+=rate-actual*Math.log(rate)+logFactorial(actual);absoluteError+=Math.abs(actual-rate);}return{eventId:row.eventId,scoreLogLoss,absoluteError:absoluteError/2,rates,actual:{home:row.homeGoals,away:row.awayGoals}};});
  return {games:paired.length,scoreLogLoss:mean(paired.map(row=>row.scoreLogLoss)),goalMAE:mean(paired.map(row=>row.absoluteError)),meanPredictedGoals:mean(paired.map(row=>row.rates.home+row.rates.away)),meanObservedGoals:mean(paired.map(row=>row.actual.home+row.actual.away))};
}
export function fitSoccerConditionsResearch(input,league){
  const data=buildSoccerConditionsRows(input,league,{before:SOCCER_CONDITIONS_PROTOCOL.liveTrainingBefore}),p=SOCCER_CONDITIONS_PROTOCOL;
  const train=data.rows.filter(row=>instant(row.startTime)<instant(p.trainingBefore)),validation=data.rows.filter(row=>instant(row.startTime)>=instant(p.trainingBefore)&&instant(row.startTime)<instant(p.validationBefore)),test=data.rows.filter(row=>instant(row.startTime)>=instant(p.validationBefore)&&instant(row.startTime)<instant(p.testBefore));
  if(!train.length||!validation.length||!test.length)throw Error('SOCCER_CONDITIONS_SPLIT_MISSING');
  const trials=p.ridgePenalties.map(penalty=>{const fit=fitSoccerConditionsPoisson(examples(train),penalty);return {penalty,fit,validation:soccerConditionsMetrics(validation,fit.coefficients)};}).sort((a,b)=>a.validation.scoreLogLoss-b.validation.scoreLogLoss||a.penalty-b.penalty);
  const selected=trials[0],evaluationFit=fitSoccerConditionsPoisson(examples([...train,...validation]),selected.penalty),liveFit=fitSoccerConditionsPoisson(examples(data.rows),selected.penalty),baselineTest=soccerConditionsMetrics(test),testMetrics=soccerConditionsMetrics(test,evaluationFit.coefficients);
  return seal({version:SOCCER_CONDITIONS_MODEL_VERSION,league,status:'RETROSPECTIVE_RESEARCH_NOT_ACCEPTED',protocol:p,features:SOCCER_CONDITIONS_FEATURES,inputHash:data.inputHash,sourceHashes:data.sourceHashes,sourceRows:data.sourceRows,
    selectedPenalty:selected.penalty,validation:{train:soccerConditionsMetrics(train,selected.fit.coefficients),validation:selected.validation,test:testMetrics,baselineTest,deltaScoreLogLoss:testMetrics.scoreLogLoss-baselineTest.scoreLogLoss,trials:trials.map(({fit,...row})=>row),testUsedForSelection:false,testUntouchedVerified:false,interpretation:'RETROSPECTIVE_FIXED_DATE_HOLDOUT_NOT_PROSPECTIVE_ACCEPTANCE'},
    evaluationCoefficients:evaluationFit.coefficients,coefficients:liveFit.coefficients,liveBaseline:data.liveBaseline,liveTrainedGames:data.rows.length,trainingThrough:p.liveTrainingBefore,
    accepted:false,formalEligible:false,modelEffectApplied:false,historicalPointInTimeVerified:false,W:null,R:null,S:null,
    limitations:['Only retained same-competition fixtures enter these congestion features; missing or foreign competitions are not zero workload.',
      'Kickoff gaps are not physical recovery, travel distance or match end times.',
      'A 24-hour result-availability lag is assumed for retrospective replay; backfilled sources do not prove historical availability.',
      'Weather, travel, referee effects, injury/eligibility and UCL cross-league/aggregate context are not estimated by this challenger.',
      'The current research challenger does not modify the main score distribution or authorize formal W/R/S.']});
}
