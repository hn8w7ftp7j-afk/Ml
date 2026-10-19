import { createHash } from 'node:crypto';
import { scoreDistribution,predictScoreModel,validateTrainingRows,evaluateScoreModel,soccerScoreLogProbability } from './score-model.js';
import { soccerProbabilityAuditFields,buildSoccerProbabilityAudit } from './probability-audit.js';
import { SOCCER_PERSONNEL_HISTORY_VERSION } from './personnel-history.js';
import { soccerLeague } from './contracts.js';

export const SOCCER_PERSONNEL_MODEL_VERSION='SOCCER-CLUB-CENTERED-XI-POISSON-RESEARCH-v1';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id=value=>typeof value==='string'&&/^\d{1,16}$/.test(value);
const instant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

function validateXI(row){
  const p=row?.personnel;
  const league=soccerLeague(row?.league),url=league&&id(row?.eventId)?`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/summary?event=${row.eventId}`:null;
  if(!url||p?.version!==SOCCER_PERSONNEL_HISTORY_VERSION||!plain(p.teams)||!instant(p.source?.fetchedAt)||p.source?.provider!=='ESPN'||p.source?.url!==url||!/^[a-f0-9]{64}$/.test(p.source?.contentHash||''))throw Error('PERSONNEL_XI_SOURCE_UNVERIFIED');
  const seen=new Set();
  for(const side of ['home','away']){
    const team=p.teams[side];
    if(!id(row?.[`${side}Id`])||team?.sourceId!==row[`${side}Id`]||!Array.isArray(team.starters)||team.starters.length!==11)throw Error('PERSONNEL_XI_INCOMPLETE');
    for(const player of team.starters){if(!id(player)||seen.has(player))throw Error('PERSONNEL_XI_IDENTITY_INVALID');seen.add(player);}
  }
  return p;
}

function baselineRates(model,row){
  const h=model.coefficients[row.homeId],a=model.coefficients[row.awayId];
  if(!h||!a)throw Error('SOCCER_TEAM_NOT_TRAINED');
  return [Math.exp(model.intercept+(row.neutralSite?0:model.homeEffect)+h.attack+a.defence),Math.exp(model.intercept+a.attack+h.defence)];
}

/** Retrospective XI association, with the unchanged team-score baseline as an offset. */
export function fitSoccerPersonnelModel(input,{league,cutoff,baselineModel,penalty=.01,maxIterations=6000,tolerance=1e-6}={}){
  if(baselineModel?.league!==league||baselineModel.cutoff!==cutoff||baselineModel.fit?.converged!==true||!(Number.isFinite(penalty)&&penalty>0)||!Number.isInteger(maxIterations)||maxIterations<1||!(tolerance>0))throw Error('PERSONNEL_FIT_OPTIONS_INVALID');
  const rows=validateTrainingRows(input,league,cutoff);
  if(rows.length<30)throw Error('PERSONNEL_TRAINING_INSUFFICIENT');
  for(const row of rows){const p=validateXI(row);if(p.availability!=='BACKFILLED_POSTMATCH_XI_NOT_PREMATCH_SAVED')throw Error('PERSONNEL_TRAINING_AVAILABILITY_INVALID');}
  const players=[...new Set(rows.flatMap(row=>['home','away'].flatMap(side=>row.personnel.teams[side].starters)))].sort(),index=new Map(players.map((p,i)=>[p,i])),n=players.length;
  const weights=rows.map(row=>Math.exp(-Math.LN2*(Date.parse(cutoff)-Date.parse(row.startTime))/86400000/baselineModel.halfLifeDays)),weightSum=weights.reduce((a,b)=>a+b,0),clubs={};
  rows.forEach((row,i)=>{for(const side of ['home','away']){const team=row[`${side}Id`];clubs[team]??={weight:0,starts:{}};clubs[team].weight+=weights[i];for(const p of row.personnel.teams[side].starters)clubs[team].starts[p]=(clubs[team].starts[p]||0)+weights[i];}});
  const frequencies=Object.fromEntries(Object.entries(clubs).map(([team,value])=>[team,Object.fromEntries(Object.entries(value.starts).map(([player,count])=>[player,count/value.weight]))]));
  const training=rows.map((row,i)=>({row,weight:weights[i]/weightSum,rates:baselineRates(baselineModel,row),home:row.personnel.teams.home.starters.map(p=>index.get(p)),away:row.personnel.teams.away.starters.map(p=>index.get(p))}));
  const centers=Object.fromEntries(Object.entries(frequencies).map(([team,values])=>[team,Object.entries(values).map(([player,value])=>[index.get(player),value])]));
  const sum=(indices,v,offset)=>indices.reduce((total,i)=>total+v[offset+i],0);
  function objective(v,withGradient=false){
    const g=Array(2*n).fill(0),means={},residuals={};let loss=0;
    for(const [team,entries]of Object.entries(centers)){means[team]=[entries.reduce((s,[i,f])=>s+f*v[i],0),entries.reduce((s,[i,f])=>s+f*v[n+i],0)];residuals[team]=[0,0];}
    for(const {row,weight,rates,home,away}of training){
      const hm=means[row.homeId],am=means[row.awayId],lh=Math.log(rates[0])+sum(home,v,0)-hm[0]+sum(away,v,n)-am[1],la=Math.log(rates[1])+sum(away,v,0)-am[0]+sum(home,v,n)-hm[1],h=Math.exp(lh),a=Math.exp(la);
      if(!Number.isFinite(h)||!Number.isFinite(a))return {loss:Infinity,g};
      loss+=weight*(h-row.homeGoals*lh+a-row.awayGoals*la);
      if(withGradient){const dh=weight*(h-row.homeGoals),da=weight*(a-row.awayGoals);
        for(const i of home){g[i]+=dh;g[n+i]+=da;}for(const i of away){g[i]+=da;g[n+i]+=dh;}
        residuals[row.homeId][0]+=dh;residuals[row.homeId][1]+=da;residuals[row.awayId][0]+=da;residuals[row.awayId][1]+=dh;
      }
    }
    if(withGradient)for(const [team,entries]of Object.entries(centers))for(const [i,f]of entries){g[i]-=f*residuals[team][0];g[n+i]-=f*residuals[team][1];}
    for(let i=0;i<v.length;i++){loss+=penalty*v[i]*v[i]/2;if(withGradient)g[i]+=penalty*v[i];}
    return {loss,g};
  }
  let values=Array(2*n).fill(0),iterations=0,converged=false,gradientNorm=null;
  for(;iterations<maxIterations;iterations++){
    const {loss,g}=objective(values,true);gradientNorm=Math.sqrt(g.reduce((s,x)=>s+x*x,0));if(gradientNorm<tolerance){converged=true;break;}
    let step=1,accepted=false;for(let k=0;k<30;k++){const candidate=values.map((x,i)=>x-step*g[i]);if(objective(candidate).loss<=loss-1e-4*step*gradientNorm**2){values=candidate;accepted=true;break;}step/=2;}if(!accepted)break;
  }
  return {version:SOCCER_PERSONNEL_MODEL_VERSION,league,period:'REGULATION_FT',cutoff,trainedThrough:rows.at(-1).startTime,trainingCount:rows.length,trainingHash:hash(rows),baselineHash:hash(baselineModel),baselineModel:structuredClone(baselineModel),penalty,
    coefficients:Object.fromEntries(players.map((player,i)=>[player,{attack:values[i],defence:values[n+i]}])),clubStarterFrequencies:frequencies,fit:{converged,iterations,gradientNorm},
    featureMeaning:'CLUB_CENTERED_STARTING_XI_ASSOCIATION_NOT_ACTUAL_MINUTES_OR_CAUSAL_PLAYER_VALUE',sourceAvailability:'BACKFILLED_POSTMATCH_XI_NOT_PREMATCH_SAVED',status:'RESEARCH_ONLY',formalEnabled:false,executable:false};
}

export function predictSoccerPersonnelModel(model,row,{mode='CURRENT_PREMATCH',asOf=Date.now()}={}){
  if(model?.version!==SOCCER_PERSONNEL_MODEL_VERSION||model.fit?.converged!==true||model.league!==row?.league||!instant(model.cutoff)||model.baselineModel?.cutoff!==model.cutoff||model.baselineHash!==hash(model.baselineModel)||!['CURRENT_PREMATCH','RETROSPECTIVE_OBSERVED_XI','COUNTERFACTUAL_DIAGNOSTIC'].includes(mode))throw Error('PERSONNEL_MODEL_NOT_APPLICABLE');
  const p=validateXI(row);
  if(mode==='CURRENT_PREMATCH'&&(!Number.isFinite(asOf)||Date.parse(model.cutoff)>asOf||Date.parse(row.startTime)<=asOf||p.availability!=='OBSERVED_PREMATCH_XI'||Date.parse(p.source.fetchedAt)>asOf||asOf-Date.parse(p.source.fetchedAt)>180000||Date.parse(p.source.fetchedAt)>=Date.parse(row.startTime)))throw Error('PERSONNEL_PREMATCH_AVAILABILITY_UNVERIFIED');
  if(mode==='RETROSPECTIVE_OBSERVED_XI'&&p.availability!=='BACKFILLED_POSTMATCH_XI_NOT_PREMATCH_SAVED')throw Error('PERSONNEL_RETROSPECTIVE_AVAILABILITY_INVALID');
  const baseline=predictScoreModel(model.baselineModel,row),deltas={};
  for(const side of ['home','away']){
    const team=row[`${side}Id`],frequency=model.clubStarterFrequencies[team];if(!frequency)throw Error('PERSONNEL_CLUB_NOT_TRAINED');
    const starts=p.teams[side].starters;if(starts.some(player=>!Object.hasOwn(model.coefficients,player)))throw Error('PERSONNEL_PLAYER_NOT_TRAINED');
    deltas[side]=Object.fromEntries(['attack','defence'].map(role=>[role,starts.reduce((s,player)=>s+model.coefficients[player][role],0)-Object.entries(frequency).reduce((s,[player,f])=>s+f*model.coefficients[player][role],0)]));
  }
  const homeLogDelta=deltas.home.attack+deltas.away.defence,awayLogDelta=deltas.away.attack+deltas.home.defence;
  const homeRate=baseline.homeRate*Math.exp(homeLogDelta),awayRate=baseline.awayRate*Math.exp(awayLogDelta);
  return {...scoreDistribution(homeRate,awayRate,model.baselineModel.rho),league:model.league,modelVersion:model.version,trainingHash:model.trainingHash,trainedThrough:model.trainedThrough,cutoff:model.cutoff,baselineHash:model.baselineHash,baselineRates:{home:baseline.homeRate,away:baseline.awayRate},personnelLogRateChange:{home:homeLogDelta,away:awayLogDelta},personnelComponents:deltas,mode,
    personnelObservation:{availability:p.availability,sourceUrl:p.source.url,sourceHash:p.source.contentHash,fetchedAt:p.source.fetchedAt,startingXIs:Object.fromEntries(['home','away'].map(side=>[side,[...p.teams[side].starters]]))},
    personnelEffectApplied:true,pointInTimeAvailabilityVerified:false,status:'RESEARCH_ONLY',formalEnabled:false,executable:false};
}

export function soccerPersonnelObservation(evidence,{asOf=Date.now()}={}){
  const g=evidence?.game;
  if(evidence?.ok!==true||evidence.phase!=='PREMATCH_OBSERVATION'||g?.status!=='scheduled'||!Number.isFinite(asOf)||Date.parse(g?.startTime)<=asOf||Date.parse(evidence.source?.fetchedAt)>asOf)throw Error('PERSONNEL_PREMATCH_AVAILABILITY_UNVERIFIED');
  const row={league:g.league,eventId:g.sourceId,homeId:g.home?.sourceId,awayId:g.away?.sourceId,startTime:g.startTime,neutralSite:g.neutralSite,period:'REGULATION_FT',personnel:{version:SOCCER_PERSONNEL_HISTORY_VERSION,source:structuredClone(evidence.source),availability:'OBSERVED_PREMATCH_XI',teams:Object.fromEntries(['home','away'].map(side=>[side,{sourceId:g[side]?.sourceId,starters:(evidence.teams?.[side]?.lineup?.starters||[]).map(p=>p.id)}]))}};
  validateXI(row);
  if(['home','away'].some(side=>evidence.teams?.[side]?.lineup?.status!=='PROVIDER_REPORTED_XI'))throw Error('PERSONNEL_PREMATCH_LINEUP_UNVERIFIED');
  return row;
}

/** Paired ablation: evaluate the base and XI model on the exact same accepted rows. */
export function evaluateSoccerPersonnelModel(model,rows,{fold=null}={}){
  const scope={league:model.league,period:'REGULATION_FT',fold,modelHash:hash(model)},games=[],accepted=[];let logLoss=0,brier=0,scoreLogLoss=0;
  for(const row of rows){try{
    if(row?.league!==model.league||!id(row.eventId)||row.period!=='REGULATION_FT'||![row.homeGoals,row.awayGoals].every(x=>Number.isInteger(x)&&x>=0&&x<=30)||!row.source?.url||!row.source.contentHash)throw Error('PERSONNEL_EVALUATION_ROW_INVALID');
    const d=predictSoccerPersonnelModel(model,row,{mode:'RETROSPECTIVE_OBSERVED_XI'}),outcome=row.homeGoals>row.awayGoals?'home':row.homeGoals===row.awayGoals?'draw':'away';
    const outcomeLoss=-Math.log(d.outcomes[outcome]),scoreLoss=-soccerScoreLogProbability(row.homeGoals,row.awayGoals,d.homeRate,d.awayRate,d.rho),rowBrier=['home','draw','away'].reduce((s,key)=>s+(d.outcomes[key]-(key===outcome?1:0))**2,0);
    if(![outcomeLoss,scoreLoss,rowBrier].every(Number.isFinite))throw Error('PERSONNEL_SCORE_METRIC_UNAVAILABLE');
    logLoss+=outcomeLoss;brier+=rowBrier;scoreLogLoss+=scoreLoss;accepted.push(row);
    games.push({eventId:row.eventId,startTime:row.startTime,status:'EVALUATED',...scope,homeRate:d.homeRate,awayRate:d.awayRate,logLoss:outcomeLoss,brier:rowBrier,scoreLogLoss:scoreLoss,...soccerProbabilityAuditFields(d,outcome,-scoreLoss)});
  }catch(error){games.push({eventId:row?.eventId??null,startTime:row?.startTime??null,status:'SKIPPED',reason:error.message,...scope});}}
  const count=accepted.length,baseline=evaluateScoreModel(model.baselineModel,accepted,{fold});
  return {sample:rows.length,count,excluded:rows.length-count,coverage:rows.length?count/rows.length:0,logLoss:count?logLoss/count:null,brier:count?brier/count:null,scoreLogLoss:count?scoreLogLoss/count:null,baseline:{count:baseline.count,logLoss:baseline.logLoss,brier:baseline.brier,scoreLogLoss:baseline.scoreLogLoss,probabilityAudit:baseline.probabilityAudit},games,probabilityAudit:buildSoccerProbabilityAudit(games,scope),status:'RESEARCH_ONLY',formalEnabled:false};
}
