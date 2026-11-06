import { soccerConditionsArtifacts } from './conditions-frozen.js';
import { soccerConditionsHash,SOCCER_CONDITIONS_MODEL_VERSION,soccerConditionsCovariates,soccerConditionsPriorRates } from './conditions-model.js';

const instant=value=>typeof value==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(value)?Date.parse(value):NaN;
const id=value=>typeof value==='string'&&/^\d{1,16}$/.test(value);
const slug={epl:'eng.1',ucl:'uefa.champions'};
const unavailable=(reason,extra={})=>({version:SOCCER_CONDITIONS_MODEL_VERSION,status:'INSUFFICIENT_RESEARCH_INPUTS',prediction:null,missing:[reason],features:null,
  accepted:false,formalEligible:false,modelEffectApplied:false,appliedToMainScore:false,historicalPointInTimeVerified:false,W:null,R:null,S:null,...extra});
function sameGame(a,b){return a?.id===b?.id&&a?.sourceId===b?.sourceId&&a?.league===b?.league&&a?.startTime===b?.startTime&&['home','away'].every(side=>a?.[side]?.sourceId===b?.[side]?.sourceId);}
function sourceValid(source,teamId,now){
  if(source?.provider!=='ESPN'||!/^[a-f0-9]{64}$/.test(source?.contentHash||'')||!Number.isFinite(instant(source?.fetchedAt))||instant(source.fetchedAt)>now)return false;
  try{const u=new URL(source.url);return u.protocol==='https:'&&u.hostname==='site.api.espn.com'&&!u.username&&!u.password&&!u.port&&!u.hash&&u.pathname===`/apis/site/v2/sports/soccer/all/teams/${teamId}/schedule`;}catch{return false;}
}
function teamFeatures(workload,team,game,now){
  if(workload?.ok!==true||workload.sourceId!==team.sourceId||!Array.isArray(workload.recentCompleted)||!Array.isArray(workload.sources)
    ||!Number.isFinite(instant(workload.asOf))||instant(workload.asOf)>now
    ||!workload.sources.some(source=>sourceValid(source,team.sourceId,Math.min(now,instant(workload.asOf)))))return null;
  if(workload.scheduledBeforeTarget!==undefined&&!Array.isArray(workload.scheduledBeforeTarget))return null;
  const pending=[];
  for(const record of workload.scheduledBeforeTarget||[]){
    if(record?.competition?.slug!==slug[game.league])continue;
    if(!id(record.eventId)||record.eventId===game.sourceId||record.status!=='SCHEDULED'||!Number.isFinite(instant(record.startTime))
      ||instant(record.startTime)<instant(workload.asOf)||instant(record.startTime)>=instant(game.startTime))return null;
    pending.push({eventId:record.eventId,startTime:record.startTime});
  }
  // Training rows refer to the next observed game after completed prior games.
  // A published intervening match is not completed workload and its eventual
  // occurrence/minutes cannot be guessed. Do not treat this as a long break.
  if(pending.length)return{blockedReason:'CONDITIONS_INTERVENING_SAME_COMPETITION_FIXTURE_PENDING',sourceId:team.sourceId,pendingFixtures:pending};
  const seen=new Map(),cutoff=Math.min(instant(workload.asOf),now,instant(game.startTime));
  const byCompetition=workload.lastKnownCompletedByCompetition;
  if(byCompetition!==undefined&&(!byCompetition||typeof byCompetition!=='object'||Array.isArray(byCompetition)))return null;
  const competitionLast=byCompetition&&Object.hasOwn(byCompetition,slug[game.league])?byCompetition[slug[game.league]]:null;
  if(competitionLast&&competitionLast.competition?.slug!==slug[game.league])return null;
  const entries=[...workload.recentCompleted,...(workload.lastKnownCompleted?[workload.lastKnownCompleted]:[]),...(competitionLast?[competitionLast]:[])];
  for(const record of entries){
    if(record?.competition?.slug!==slug[game.league])continue;
    if(!id(record.eventId)||record.eventId===game.sourceId||record.status!=='COMPLETED'||!Number.isFinite(instant(record.startTime))||instant(record.startTime)>=cutoff
      ||!['home','away'].includes(record.homeAway)||!id(record.opponent?.sourceId)||record.opponent.sourceId===team.sourceId)return null;
    const old=seen.get(record.eventId);if(old&&soccerConditionsHash(old)!==soccerConditionsHash(record))return null;seen.set(record.eventId,record);
  }
  const records=[...seen.values()].sort((a,b)=>instant(a.startTime)-instant(b.startTime));
  // Absence in a partially covered club schedule cannot assert zero fixtures
  // or a long recovery interval. Without an observed prior game, do not infer.
  if(!records.length)return null;
  const last=records.at(-1),reference=instant(game.startTime);
  return {sourceId:team.sourceId,competition:slug[game.league],kickoffGapHours:(reference-instant(last.startTime))/3600000,
    observedFixtures14d:records.filter(row=>instant(row.startTime)>=reference-14*86400000).length,lastEventId:last.eventId,lastKickoff:last.startTime,
    sourceHashes:[...new Set(workload.sources.filter(source=>sourceValid(source,team.sourceId,Math.min(now,instant(workload.asOf)))).map(source=>source.contentHash))].sort(),
    scope:'OBSERVED_SAME_COMPETITION_CLUB_FIXTURES',completeCoverageVerified:false,physicalRestHours:null,travelDistanceKm:null};
}
export function buildSoccerConditionsResearch({evidence,game=evidence?.game,now=Date.now()}={}){
  if(!Number.isFinite(now)||!game||!Object.hasOwn(slug,game.league)||!id(game.sourceId)||game.id!==`soccer:${game.league}:${game.sourceId}`
    ||!['home','away'].every(side=>id(game[side]?.sourceId))||game.home.sourceId===game.away.sourceId||!Number.isFinite(instant(game.startTime))
    ||evidence?.ok!==true||!sameGame(evidence.game,game))return unavailable('CONDITIONS_GAME_SCOPE_INVALID');
  const artifact=soccerConditionsArtifacts(),{contentHash,...body}=artifact;
  if(contentHash!==soccerConditionsHash(body)||artifact.version!==SOCCER_CONDITIONS_MODEL_VERSION||artifact.accepted!==false||artifact.formalEligible!==false
    ||!Number.isFinite(instant(artifact.createdAt))||instant(artifact.createdAt)>now)return unavailable('CONDITIONS_ARTIFACT_UNAVAILABLE_AT_CUTOFF');
  const model=artifact.leagues[game.league],{contentHash:modelHash,...modelBody}=model;
  if(modelHash!==soccerConditionsHash(modelBody)||model.league!==game.league||model.accepted!==false||model.formalEligible!==false||instant(model.trainingThrough)>now)
    return unavailable('CONDITIONS_MODEL_INVALID');
  const common={league:game.league,gameId:game.id,artifactHash:contentHash,modelHash,validation:model.validation,limitations:model.limitations,
    absentEffects:['WEATHER_FORECAST_NOT_CONNECTED','TRAVEL_NOT_VERIFIED','REFEREE_EFFECT_NOT_ESTIMATED',...(game.league==='ucl'?['UCL_AGGREGATE_AND_CROSS_LEAGUE_CONTEXT_NOT_ESTIMATED']:[])]};
  if(game.status!=='scheduled'||instant(game.startTime)<=now||evidence.phase!=='PREMATCH_OBSERVATION')return unavailable('CONDITIONS_NOT_PREMATCH',common);
  if(evidence.workload?.gameId!==game.id)return unavailable('CONDITIONS_WORKLOAD_SCOPE_MISMATCH',common);
  const features=Object.fromEntries(['home','away'].map(side=>[side,teamFeatures(evidence.workload.teams?.[side],game[side],game,now)]));
  const pendingReason=features.home?.blockedReason||features.away?.blockedReason;
  if(pendingReason)return unavailable(pendingReason,{...common,features});
  if(!features.home||!features.away)return unavailable('CONDITIONS_SAME_COMPETITION_HISTORY_MISSING',{...common,features});
  const baselineRates=soccerConditionsPriorRates(model.liveBaseline,game.home.sourceId,game.away.sourceId);
  if(!baselineRates)return unavailable('CONDITIONS_TEAM_PRIOR_MISSING',{...common,features});
  const logMultipliers=Object.fromEntries(['home','away'].map(side=>{const opposite=side==='home'?'away':'home';
    const x=soccerConditionsCovariates(features[side],features[opposite],game.neutralSite===true,side==='home');return[side,x.reduce((sum,value,index)=>sum+value*model.coefficients[index],0)];}));
  const prediction={period:'REGULATION_FT',homeRate:baselineRates.homeRate*Math.exp(logMultipliers.home),awayRate:baselineRates.awayRate*Math.exp(logMultipliers.away),baselineRates,logMultipliers,
    interpretation:'SEPARATE_RESEARCH_CHALLENGER_NOT_MAIN_SCORE_MULTIPLIER'};
  if(![prediction.homeRate,prediction.awayRate].every(value=>Number.isFinite(value)&&value>0&&value<=50))return unavailable('CONDITIONS_PREDICTION_INVALID',{...common,features});
  return {...unavailable(null,common),status:'RESEARCH_CHALLENGER_AVAILABLE',missing:[],features:{...features,neutralVenueFlag:game.neutralSite===true},prediction,
    forecastEffectsAvailable:false,observedAt:new Date(now).toISOString()};
}
