import { createHash } from 'node:crypto';
import { soccerExpectedMinutesArtifacts } from './expected-minutes-frozen.js';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { SOCCER_MINUTES_AUDIT_V2_VERSION } from './personnel-audit.js';

export const SOCCER_EXPECTED_MINUTES_VERSION = 'SOCCER-PRIOR-PARTICIPATION-MINUTES-RESEARCH-v1';
const DAY=86400000, ROLES=['STARTER','SUBSTITUTE','NO_APPEARANCE'];
const restrictions={formalEligible:false,modelEffectApplied:false,pointInTimeAvailabilityVerified:false,executable:false};
const instant=value=>typeof value==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(value)?Date.parse(value):NaN;
const id=value=>typeof value==='string'&&/^\d{1,16}$/.test(value);
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export const soccerExpectedMinutesHash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const mean=values=>values.reduce((sum,value)=>sum+value,0)/values.length;
const role=player=>player?.starter?'STARTER':player?.appeared?'SUBSTITUTE':'NO_APPEARANCE';
const blank=()=>({n:0,counts:[0,0,0],minuteSums:[0,0,0]});
const increment=(value,row)=>{const at=ROLES.indexOf(row.targetRole);value.n++;value.counts[at]++;value.minuteSums[at]+=row.targetMinutes;};
const bucket=value=>value===0?'0':value===1?'1':'2+';

function historyValid(match){
  return match&&id(match.eventId)&&Number.isFinite(instant(match.startTime))&&Array.isArray(match.players)
    &&match.players.length>=11&&match.players.length<=40&&new Set(match.players.map(player=>player?.id)).size===match.players.length
    &&match.players.filter(player=>player.starter===true).length===11
    &&match.players.every(player=>id(player.id)&&typeof player.starter==='boolean'&&typeof player.appeared==='boolean'
      &&(!player.starter||player.appeared)&&Number.isFinite(player.regulationClockMinutes)&&player.regulationClockMinutes>=0&&player.regulationClockMinutes<=90
      &&(player.appeared||player.regulationClockMinutes===0));
}

// Candidate identity is obtained exclusively from earlier observed squads.
// The current target roster is used only for labels and omitted-newcomer counts.
export function soccerExpectedMinutesFeatures(priorMatches){
  const ordered=[...priorMatches].sort((a,b)=>b.startTime.localeCompare(a.startTime)||a.eventId.localeCompare(b.eventId)).slice(0,3);
  const candidates=new Map();
  for(const match of ordered)for(const player of match.players)if(!candidates.has(player.id))candidates.set(player.id,player.name||player.id);
  return [...candidates].map(([playerId,name])=>{
    const prior=ordered.map(match=>match.players.find(player=>player.id===playerId)||{id:playerId,starter:false,appeared:false,regulationClockMinutes:0});
    const lastRole=ordered[0].players.some(player=>player.id===playerId)?role(prior[0]):'ABSENT_FROM_LAST_SQUAD';
    const starts=prior.filter(player=>player.starter).length,appearances=prior.filter(player=>player.appeared).length;
    return{id:playerId,name,lastRole,key:`${lastRole}|${bucket(starts)}|${bucket(appearances)}|${prior.length}`,
      priorMatchCount:prior.length,sourceMatchIds:ordered.map(match=>match.eventId),
      priorRoles:prior.map(role),priorMinutes:prior.map(player=>player.regulationClockMinutes)};
  }).sort((a,b)=>a.id.localeCompare(b.id));
}

/** Retrospective chronological rows. This never establishes historical PIT. */
export function buildSoccerExpectedMinutesRows(observations){
  const games=[...observations].sort((a,b)=>a.startTime.localeCompare(b.startTime)||a.eventId.localeCompare(b.eventId));
  const histories=new Map(),rows=[],coverageByYear={},coverage={games:games.length,usableGames:0,omittedGames:0,teamTargets:0,withoutPrior:0,
    candidatePlayerTargets:0,targetRosterPlayers:0,targetAppearingPlayers:0,unseenAppearingPlayers:0,unseenRegulationMinutes:0};
  const seenGames=new Set();
  for(const game of games){
    const key=`${game.league}:${game.eventId}`;
    if(seenGames.has(key))throw Error('EXPECTED_MINUTES_DUPLICATE_GAME');seenGames.add(key);
    if(game.minutes?.status!=='REGULATION_CLOCK_RECONSTRUCTED'){coverage.omittedGames++;continue;}
    const at=instant(game.startTime);
    const year=game.startTime.slice(0,4);
    coverageByYear[year]??={usableGames:0,teamTargets:0,withoutPrior:0,candidatePlayerTargets:0,targetAppearingPlayers:0,unseenAppearingPlayers:0,unseenRegulationMinutes:0};
    const yearCoverage=coverageByYear[year];yearCoverage.usableGames++;
    const teams=['home','away'].map(side=>({side,team:game.minutes.teams?.[side]}));
    if(!Number.isFinite(at)||!['epl','ucl'].includes(game.league)||teams.some(({team})=>!id(team?.sourceId)
      ||!historyValid({eventId:game.eventId,startTime:game.startTime,players:team.players})))throw Error('EXPECTED_MINUTES_OBSERVATION_INVALID');
    coverage.usableGames++;
    for(const {team}of teams){
      const teamKey=`${game.league}:${team.sourceId}`,past=histories.get(teamKey)||[];
      const prior=past.filter(match=>instant(match.startTime)+DAY<=at&&instant(match.startTime)>=at-14*DAY).slice(-3);
      coverage.teamTargets++;yearCoverage.teamTargets++;coverage.targetRosterPlayers+=team.players.length;
      const appearing=team.players.filter(player=>player.appeared).length;coverage.targetAppearingPlayers+=appearing;yearCoverage.targetAppearingPlayers+=appearing;
      if(!prior.length){coverage.withoutPrior++;yearCoverage.withoutPrior++;}
      const features=soccerExpectedMinutesFeatures(prior),candidateIds=new Set(features.map(player=>player.id));
      const targets=new Map(team.players.map(player=>[player.id,player]));
      for(const player of team.players)if(player.appeared&&!candidateIds.has(player.id)){
        coverage.unseenAppearingPlayers++;coverage.unseenRegulationMinutes+=player.regulationClockMinutes;
        yearCoverage.unseenAppearingPlayers++;yearCoverage.unseenRegulationMinutes+=player.regulationClockMinutes;
      }
      for(const featuresRow of features){
        const target=targets.get(featuresRow.id);
        rows.push({...featuresRow,league:game.league,eventId:game.eventId,teamId:team.sourceId,startTime:game.startTime,
          targetRole:role(target),targetMinutes:target?.regulationClockMinutes||0});coverage.candidatePlayerTargets++;yearCoverage.candidatePlayerTargets++;
      }
    }
    // Insert both teams only after every target has been made, preserving the
    // same kickoff as a whole game even when multiple games share a timestamp.
    for(const{team}of teams){const key=`${game.league}:${team.sourceId}`;
      const past=histories.get(key)||[];past.push({eventId:game.eventId,startTime:game.startTime,players:team.players});histories.set(key,past);}
  }
  return{rows,coverage,coverageByYear,...restrictions};
}

export function fitSoccerExpectedMinutesModel(rows,{league,shrinkage=20}={}){
  if(!['epl','ucl'].includes(league)||!Number.isFinite(shrinkage)||shrinkage<=0||!Array.isArray(rows)||!rows.length
    ||rows.some(row=>row.league!==league||!ROLES.includes(row.targetRole)||!Number.isFinite(row.targetMinutes)||row.targetMinutes<0||row.targetMinutes>90))
    throw Error('EXPECTED_MINUTES_TRAINING_INVALID');
  const global=blank(),roles={},cells={};
  for(const row of rows){increment(global,row);roles[row.lastRole]??=blank();cells[row.key]??=blank();increment(roles[row.lastRole],row);increment(cells[row.key],row);}
  return{version:SOCCER_EXPECTED_MINUTES_VERSION,league,shrinkage,global,roles,cells,
    trainingRows:rows.length,trainingGames:new Set(rows.map(row=>row.eventId)).size,
    trainingBefore:new Date(rows.reduce((latest,row)=>Math.max(latest,instant(row.startTime)),-Infinity)).toISOString(),trainingRowsHash:soccerExpectedMinutesHash(rows),...restrictions};
}

function estimates(stats,parent,k){
  return{probabilities:ROLES.map((_role,index)=>(stats.counts[index]+k*parent.probabilities[index])/(stats.n+k)),
    conditionalMinutes:ROLES.map((_role,index)=>index===2?0:(stats.minuteSums[index]+k*parent.conditionalMinutes[index])/(stats.counts[index]+k))};
}
function globalEstimates(model){return{probabilities:model.global.counts.map(value=>value/model.global.n),
  conditionalMinutes:model.global.counts.map((value,index)=>index===2?0:value?model.global.minuteSums[index]/value:0)};}
export function predictSoccerExpectedMinutes(model,features,{baseline=false}={}){
  const global=globalEstimates(model);
  let result;
  if(baseline){
    const counts=ROLES.map(value=>features.priorRoles.filter(role=>role===value).length),n=features.priorRoles.length;
    result={probabilities:counts.map((value,index)=>(value+global.probabilities[index])/(n+1)),
      conditionalMinutes:global.conditionalMinutes};
    result.expectedMinutes=mean(features.priorMinutes);
  }else{
    const byRole=estimates(model.roles[features.lastRole]||blank(),global,model.shrinkage);
    result=estimates(model.cells[features.key]||blank(),byRole,model.shrinkage);
    result.expectedMinutes=result.probabilities.reduce((sum,value,index)=>sum+value*result.conditionalMinutes[index],0);
  }
  return{startProbability:result.probabilities[0],substituteProbability:result.probabilities[1],noAppearanceProbability:result.probabilities[2],
    appearanceProbability:result.probabilities[0]+result.probabilities[1],expectedMinutes:result.expectedMinutes,
    conditionalStarterMinutes:result.conditionalMinutes[0],conditionalSubstituteMinutes:result.conditionalMinutes[1],
    probabilities:result.probabilities,cellTrainingRows:model.cells[features.key]?.n||0};
}

export function reconcileSoccerExpectedMinutesTeam(players){
  const startSum=players.reduce((sum,player)=>sum+player.startProbability,0),startFactor=Math.min(1,11/startSum);
  if(startFactor<1)for(const player of players){const removed=player.startProbability*(1-startFactor);player.startProbability*=startFactor;player.noAppearanceProbability+=removed;
    player.appearanceProbability-=removed;player.expectedMinutes=Math.max(0,player.expectedMinutes-removed*player.conditionalStarterMinutes);}
  const minuteSum=players.reduce((sum,player)=>sum+player.expectedMinutes,0),minuteFactor=Math.min(1,990/minuteSum);
  for(const player of players){player.expectedMinutes*=minuteFactor;player.conditionalStarterMinutes*=minuteFactor;player.conditionalSubstituteMinutes*=minuteFactor;
    player.probabilities=[player.startProbability,player.substituteProbability,player.noAppearanceProbability];}
  return{method:'UPPER_BOUNDS_ONLY_NO_INVENTED_MISSING_PLAYERS',maximumExpectedStarters:11,maximumExpectedTeamRegulationMinutes:990,startFactor,minuteFactor};
}

export function evaluateSoccerExpectedMinutes(model,rows){
  const compute=baseline=>{
    const games=new Map(),teamPredictions=new Map();
    for(const row of rows){const key=`${row.eventId}:${row.teamId}`;if(!teamPredictions.has(key))teamPredictions.set(key,[]);
      teamPredictions.get(key).push({...predictSoccerExpectedMinutes(model,row,{baseline}),row});}
    for(const players of teamPredictions.values())reconcileSoccerExpectedMinutesTeam(players);
    for(const prediction of [...teamPredictions.values()].flat()){const row=prediction.row,which=ROLES.indexOf(row.targetRole);
      const metrics={logLoss:-Math.log(Math.max(1e-15,prediction.probabilities[which])),
        brier:prediction.probabilities.reduce((sum,value,index)=>sum+(value-Number(index===which))**2,0),
        minuteAbsoluteError:Math.abs(prediction.expectedMinutes-row.targetMinutes),minuteSquaredError:(prediction.expectedMinutes-row.targetMinutes)**2};
      if(!games.has(row.eventId))games.set(row.eventId,[]);games.get(row.eventId).push(metrics);
    }
    const values=[...games.values()].map(rows=>Object.fromEntries(Object.keys(rows[0]).map(key=>[key,mean(rows.map(row=>row[key]))])));
    return{games:values.length,playerTargets:rows.length,logLoss:values.length?mean(values.map(row=>row.logLoss)):null,
      brier:values.length?mean(values.map(row=>row.brier)):null,minuteMAE:values.length?mean(values.map(row=>row.minuteAbsoluteError)):null,
      minuteRMSE:values.length?Math.sqrt(mean(values.map(row=>row.minuteSquaredError))):null};
  };
  return{model:compute(false),baseline:compute(true),weighting:'EQUAL_REAL_GAME_THEN_EQUAL_PRIOR_CANDIDATE_PLAYER',
    baselineMethod:'PRIOR_THREE_MATCH_MEAN_MINUTES_AND_ROLE_FREQUENCIES_WITH_ONE_TRAINING_GLOBAL_PSEUDO_OBSERVATION',
    reconciliation:'SAME_TEAM_UPPER_BOUND_RECONCILIATION_AS_LIVE_INFERENCE',...restrictions};
}

const unavailable=(reason,extra={})=>({status:'INSUFFICIENT_PRIOR_OBSERVATIONS',reason,players:[],coverage:{complete:false,eligibleRosterVerified:false},...extra,...restrictions});
function liveTeam({game,side,teamWorkload,model,now}){
  const expected=game[side]?.sourceId,league=soccerLeague(game.league);
  const workload=teamWorkload?.playerWorkload,known=instant(teamWorkload?.asOf),reference=instant(teamWorkload?.referenceAt);
  // Player observations belong to the schedule observation that acquired
  // them. A same-team observation from another target/cutoff cannot replace it.
  if(teamWorkload?.ok!==true||teamWorkload.version!=='SOCCER-ALL-COMPETITION-WORKLOAD-v2'||teamWorkload.sourceId!==expected
    ||!Number.isFinite(known)||known>now||reference!==Math.min(known,instant(game.startTime))
    ||instant(workload?.referenceAt)!==reference||!Number.isFinite(instant(workload?.asOf))||instant(workload.asOf)<known)
    return unavailable('EXPECTED_MINUTES_WORKLOAD_SCOPE_MISMATCH');
  if(workload?.ok!==true||workload.version!=='SOCCER-OBSERVED-PLAYER-WORKLOAD-v2'||workload.sourceId!==expected
    ||workload.extractorVersion!==SOCCER_MINUTES_AUDIT_V2_VERSION||!Array.isArray(workload.matches)
    ||!Number.isFinite(instant(workload.asOf))||instant(workload.asOf)>now)return unavailable('EXPECTED_MINUTES_WORKLOAD_UNAVAILABLE');
  const omissions=[],matches=[];
  for(const match of workload.matches){
    const at=instant(match.startTime),source=match.source;
    if(match.sourceId!==expected||match.extractorVersion!==SOCCER_MINUTES_AUDIT_V2_VERSION||!historyValid(match)
      ||match.eventId===game.sourceId||!Number.isFinite(at)||at>=reference||at+DAY>now||at<instant(game.startTime)-14*DAY||source?.provider!=='ESPN'
      ||!/^[a-f0-9]{64}$/.test(source.contentHash||'')||!Number.isFinite(instant(source.fetchedAt))||instant(source.fetchedAt)>now
      ||instant(source.fetchedAt)>instant(workload.asOf)){omissions.push({eventId:match.eventId,reason:'PRIOR_MATCH_SCOPE_OR_TIME_UNVERIFIED'});continue;}
    if(match.competition?.slug!==league.espnSlug){omissions.push({eventId:match.eventId,reason:'OUTSIDE_TRAINING_COMPETITION_SCOPE'});continue;}
    if(source.url!==`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/summary?event=${match.eventId}`){omissions.push({eventId:match.eventId,reason:'PRIOR_MATCH_SOURCE_SCOPE_UNVERIFIED'});continue;}
    matches.push(match);
  }
  if(new Set(matches.map(match=>match.eventId)).size!==matches.length)return unavailable('EXPECTED_MINUTES_DUPLICATE_PRIOR_MATCH');
  if(!matches.length)return unavailable('EXPECTED_MINUTES_NO_SAME_LEAGUE_RECENT_MATCH',{omissions});
  const features=soccerExpectedMinutesFeatures(matches),players=features.map(feature=>({...feature,...predictSoccerExpectedMinutes(model,feature),eligibilityStatus:'UNKNOWN'}));
  // Missing entrants and unavailable players are not replaced with invented
  // names. Reconcile only physical upper bounds across the observed subset.
  const reconciliation=reconcileSoccerExpectedMinutesTeam(players);
  for(const player of players){delete player.probabilities;delete player.priorRoles;delete player.priorMinutes;}
  return{status:'RESEARCH_FORECAST_AVAILABLE',players:players.sort((a,b)=>b.expectedMinutes-a.expectedMinutes||a.id.localeCompare(b.id)),
    expectedTeamMinutes:players.reduce((sum,player)=>sum+player.expectedMinutes,0),
    coverage:{candidatePlayers:players.length,recentVerifiedMatches:Math.min(3,matches.length),complete:false,eligibleRosterVerified:false,
      missingEntrantsAndDepartures:'UNKNOWN',sourceCompetition:league.espnSlug},omissions,
    reconciliation,
    eligibilityStatus:'UNKNOWN',injuryStatus:'UNKNOWN',...restrictions};
}

/** Current research inference only. No player availability or score-rate effect
 * is inferred from a probability of participation in the observed candidate set. */
export function buildSoccerExpectedMinutesResearch({evidence,game=evidence?.game,now=Date.now(),artifacts=soccerExpectedMinutesArtifacts()}={}){
  const validNow=Number.isFinite(now)&&Math.abs(now)<=8.64e15;
  const base={version:SOCCER_EXPECTED_MINUTES_VERSION,gameId:game?.id||null,league:game?.league||null,
    generatedAt:validNow?new Date(now).toISOString():null,...restrictions};
  const{contentHash,...body}=artifacts||{};
  if(!validNow||artifacts?.version!==SOCCER_EXPECTED_MINUTES_VERSION||contentHash!==soccerExpectedMinutesHash(body)
    ||!Number.isFinite(instant(artifacts.createdAt))||instant(artifacts.createdAt)>now)return{...base,status:'MODEL_NOT_AVAILABLE_AT_CUTOFF',teams:{home:unavailable('MODEL_NOT_AVAILABLE_AT_CUTOFF'),away:unavailable('MODEL_NOT_AVAILABLE_AT_CUTOFF')}};
  const model=artifacts.leagues?.[game?.league]?.model;
  if(evidence?.ok!==true||evidence.phase!=='PREMATCH_OBSERVATION'||!soccerLeague(game?.league)||!id(game.sourceId)||game.id!==`soccer:${game.league}:${game.sourceId}`||!validSoccerDate(game.date)
    ||!id(game.home?.sourceId)||!id(game.away?.sourceId)||game.home.sourceId===game.away.sourceId||game.status!=='scheduled'
    ||!Number.isFinite(instant(game.startTime))||instant(game.startTime)<=now||evidence.game?.id!==game.id
    ||['sourceId','league','date','startTime','status'].some(field=>evidence.game[field]!==game[field])
    ||['home','away'].some(side=>evidence.game[side]?.sourceId!==game[side].sourceId)||!model)
    return{...base,status:'INSUFFICIENT_PRIOR_OBSERVATIONS',teams:{home:unavailable('CURRENT_GAME_SCOPE_INVALID'),away:unavailable('CURRENT_GAME_SCOPE_INVALID')}};
  const target=evidence.workload?.target;
  if(evidence.workload?.gameId!==game.id||['id','sourceId','league','date','startTime'].some(field=>target?.[field]!==game[field])
    ||['home','away'].some(side=>target?.[side]?.sourceId!==game[side].sourceId))
    return{...base,status:'INSUFFICIENT_PRIOR_OBSERVATIONS',teams:{home:unavailable('EXPECTED_MINUTES_WORKLOAD_SCOPE_MISMATCH'),away:unavailable('EXPECTED_MINUTES_WORKLOAD_SCOPE_MISMATCH')}};
  const teams=Object.fromEntries(['home','away'].map(side=>[side,liveTeam({game,side,teamWorkload:evidence.workload.teams?.[side],model,now})]));
  return{...base,status:Object.values(teams).some(team=>team.status==='RESEARCH_FORECAST_AVAILABLE')?'RESEARCH_FORECAST_AVAILABLE':'INSUFFICIENT_PRIOR_OBSERVATIONS',
    model:{version:model.version,artifactHash:contentHash,createdAt:artifacts.createdAt,trainingBefore:model.trainingBefore,shrinkage:model.shrinkage},
    validation:artifacts.leagues[game.league].validation,teams,
    interpretation:'LEARNED_PARTICIPATION_OF_PREVIOUSLY_OBSERVED_SQUAD_CANDIDATES_NOT_CONFIRMED_ELIGIBILITY_OR_CAUSAL_SCORE_EFFECT',
    limitations:artifacts.limitations};
}
