import { evaluateSoccerQuote } from './market-payoff.js';
import { soccerScoringHash } from './soccer-scoring.js';
import { buildSoccerScenarioResearch } from './scenario-research.js';
import { soccerResearchArtifacts } from './research-frozen.js';
import { soccerHalfTimeArtifacts } from './half-time-frozen.js';
import { predictScoreModel } from './score-model.js';
import { predictHalfTimeDistribution } from './half-time-model.js';
import { summarizeSoccerPredictionReturns } from './prediction-score.js';

export const SOCCER_MANUAL_SIMULATION_VERSION='SOCCER-MANUAL-CONDITIONAL-RETURN-v1';
const allowed=['league','date','eventId','revision','period','kind','side','line','lineSide','water'];
function manualPrediction({input,snapshot,game,distribution,quote,contract,cutoff}){
  const unavailable=reason=>({status:'UNAVAILABLE',reason,inputSource:'USER_HYPOTHESIS',eligiblePrediction:false,
    formalEligible:false,executable:false,totalModelError:null,W:null,R:null,R_model:null,S:null,score:null});
  try{
    const base=predictScoreModel(soccerResearchArtifacts().leagues[game.league].liveModel,
      {league:game.league,startTime:game.startTime,homeId:game.home.sourceId,awayId:game.away.sourceId,neutralSite:game.neutralSite});
    const expected=input.period==='FT'?base:predictHalfTimeDistribution(base,soccerHalfTimeArtifacts().leagues[game.league].liveModel,
      {league:game.league,startTime:game.startTime});
    if(soccerScoringHash({...expected,league:game.league,gameId:game.id})!==soccerScoringHash(distribution))
      return unavailable('PREDICTION_BASELINE_MODEL_MISMATCH');
    const research=buildSoccerScenarioResearch({game,now:cutoff}),period=research.periods?.[input.period];
    if(research.status!=='RESEARCH_ONLY'||period?.status!=='RESEARCH_SCENARIOS_AVAILABLE'
      ||period.failed!==0||period.weightsRenormalized!==false||period.count!==period.attempted
      ||!Array.isArray(period.scenarios)||period.scenarios.length!==period.attempted)
      return unavailable('COMPLETE_SCENARIO_SET_REQUIRED');
    const rows=period.scenarios.map(scenario=>{
      if(scenario.league!==game.league||scenario.gameId!==game.id||scenario.period!==input.period)
        throw Error('PREDICTION_SCENARIO_SCOPE_MISMATCH');
      const payoff=evaluateSoccerQuote({quote,distribution:scenario.distribution,contract});
      if(!payoff.ok)throw Error('PREDICTION_PAYOFF_UNAVAILABLE');
      const certificate=payoff.certifiedDifferencePayoff;
      const bounds=certificate?.status==='CERTIFIED_NUMERICAL_MODEL_LAW_INTERVAL'
        &&certificate.sourceVerification==='RECOMPUTED_GENERATOR_PMF_AND_COMPLETE_RECTANGLE'
        &&certificate.infiniteSeriesRemainderIncluded===true&&certificate.arithmeticRoundingIncluded===true
        ?certificate.evBounds.net:payoff.evBounds.net;
      return{id:scenario.id,weight:scenario.weight,lower:bounds.lower,upper:bounds.upper,
        distributionHash:soccerScoringHash(scenario.distribution)};
    });
    const value=summarizeSoccerPredictionReturns({rows,expectedCount:period.attempted});
    if(value.ok!==true)return unavailable(value.reason||'PREDICTION_NUMERIC_INVALID');
    return{...value,inputSource:'USER_HYPOTHESIS',eligiblePrediction:false,formalEligible:false,executable:false,
      formalScoringEnabled:false,analysisRevision:snapshot.revision,gameId:game.id,league:game.league,period:input.period,
      sourceQuoteKey:null,analysisCutoff:snapshot.analysisCutoff,distributionHash:soccerScoringHash(distribution),
      scenarioArtifactHash:research.artifactHash,scenarioProtocolHash:research.protocolHash,
      totalModelError:null,modelValidation:'UNVERIFIED',interpretation:'USER_ENTERED_PRICE_MODEL_PREDICTION_NOT_READER_OR_FORMAL_ACCEPTANCE'};
  }catch{return unavailable('PREDICTION_SOURCE_MODEL_UNAVAILABLE');}
}
export function validSoccerSimulationInput(input){
  return Boolean(input&&typeof input==='object'&&!Array.isArray(input)
    &&Object.keys(input).length===allowed.length&&Object.keys(input).every(k=>allowed.includes(k))
    &&['epl','ucl'].includes(input.league)&&/^\d{4}-\d{2}-\d{2}$/.test(input.date||'')
    &&/^[1-9]\d{0,15}$/.test(input.eventId||'')&&/^[a-f0-9]{64}$/.test(input.revision||'')
    &&['FT','HT'].includes(input.period)&&['HANDICAP','TOTAL'].includes(input.kind)
    &&(input.kind==='HANDICAP'?['home','away'].includes(input.side)&&['home','away'].includes(input.lineSide)
      :['over','under'].includes(input.side)&&input.lineSide===null)
    &&typeof input.line==='string'&&/^\d+(?:\.5)?(?:平|[+-]\d{1,3})?$/.test(input.line)
    &&typeof input.water==='number'&&Number.isFinite(input.water)&&input.water>0&&input.water<=1000);
}

// Read-only hypothesis calculator. It neither creates a Reader quote nor
// registers a source contract, analysis, candidate, bet or result observation.
export function simulateSoccerManualQuote({input,snapshot,now=Date.now()}={}){
  const fail=reason=>({ok:false,reason,formalScoringEnabled:false,eligible:false,executable:false});
  if(!validSoccerSimulationInput(input))return fail('SIMULATION_INPUT_INVALID');
  const game=snapshot?.evidence?.game,cutoff=Date.parse(snapshot?.analysisCutoff||'');
  if(!Number.isFinite(now)||!game||snapshot.ok!==true||snapshot.executable!==false||snapshot.qaFlag==='BLOCKED'
    ||snapshot.analysisStatus!=='COMPLETED'||snapshot.revision!==input.revision||snapshot.persisted!==true
    ||snapshot.gameId!==`soccer:${input.league}:${input.eventId}`||game.id!==snapshot.gameId
    ||snapshot.league!==input.league||game.league!==input.league||game.sourceId!==input.eventId
    ||snapshot.date!==input.date||game.date!==input.date||game.status!=='scheduled'
    ||!Number.isFinite(Date.parse(game.startTime))||Date.parse(game.startTime)<=now
    ||!Number.isFinite(cutoff)||cutoff>now||now-cutoff>=180000
    ||!Number.isFinite(Date.parse(snapshot.evidence.source?.fetchedAt))
    ||Date.parse(snapshot.evidence.source.fetchedAt)>cutoff||now-Date.parse(snapshot.evidence.source.fetchedAt)>=180000)
    return fail('SIMULATION_PREGAME_FORECAST_EXPIRED');
  const distribution=input.period==='FT'?snapshot.prediction:snapshot.halfTimePrediction;
  if(!distribution||distribution.league!==input.league||distribution.gameId!==game.id
    ||distribution.period!==({FT:'REGULATION_FT',HT:'REGULATION_HT'})[input.period]
    ||!distribution.modelVersion||!/^[a-f0-9]{64}$/.test(distribution.trainingHash||'')
    ||!Number.isFinite(Date.parse(distribution.trainedThrough))||Date.parse(distribution.trainedThrough)>=cutoff)
    return fail('SIMULATION_PERIOD_MODEL_UNAVAILABLE');
  const quote={kind:input.kind,period:input.period,direction:input.side.toUpperCase(),
    sourceLine:input.line,lineSide:input.lineSide,water:input.water,waterFormat:'PROFIT_PER_UNIT'};
  const contract={type:'CREDIT_BOUNDARY',period:input.period,labelMapping:{home:game.home?.name,away:game.away?.name},
    rebate:{rate:.01,basis:'SETTLED_PRINCIPAL'},provenance:{status:'ASSUMPTION',note:'User-entered hypothesis; source/account payout applicability unverified. 1% settled-principal rebate.'}};
  const payoff=evaluateSoccerQuote({quote,distribution,contract});
  if(!payoff.ok)return fail('SIMULATION_PAYOUT_UNSUPPORTED');
  return{ok:true,version:SOCCER_MANUAL_SIMULATION_VERSION,status:'USER_HYPOTHESIS_ONLY',input:{...input},
    gameId:game.id,analysisRevision:snapshot.revision,analysisCutoff:snapshot.analysisCutoff,
    calculatedAt:new Date(now).toISOString(),modelVersion:distribution.modelVersion,trainingHash:distribution.trainingHash,
    distributionHash:soccerScoringHash(distribution),probabilities:payoff.probabilities,netReturnBounds:payoff.evBounds.net,
    unresolvedTailMass:payoff.unresolvedTailMass,assumption:{mechanic:'CREDIT_BOUNDARY',accountTermsVerified:false,
      rebateRate:.01,rebateBasis:'SETTLED_PRINCIPAL'},inputSource:'USER_HYPOTHESIS',
    predictionScore:manualPrediction({input,snapshot,game,distribution,quote,contract,cutoff}),
    W:null,R:null,S:null,formalScoringEnabled:false,eligible:false,executable:false};
}
