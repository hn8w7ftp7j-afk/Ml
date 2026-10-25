import { evaluateSoccerQuote } from './market-payoff.js';
import { soccerScoringHash } from './soccer-scoring.js';

export const SOCCER_MANUAL_SIMULATION_VERSION='SOCCER-MANUAL-CONDITIONAL-RETURN-v1';
const allowed=['league','date','eventId','revision','period','kind','side','line','lineSide','water'];
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
  const payoff=evaluateSoccerQuote({quote:{kind:input.kind,period:input.period,direction:input.side.toUpperCase(),
    sourceLine:input.line,lineSide:input.lineSide,water:input.water,waterFormat:'PROFIT_PER_UNIT'},distribution,
    contract:{type:'CREDIT_BOUNDARY',period:input.period,labelMapping:{home:game.home?.name,away:game.away?.name},
      rebate:{rate:.01,basis:'SETTLED_PRINCIPAL'},provenance:{status:'ASSUMPTION',note:'User-entered hypothesis; source/account payout applicability unverified. 1% settled-principal rebate.'}}});
  if(!payoff.ok)return fail('SIMULATION_PAYOUT_UNSUPPORTED');
  return{ok:true,version:SOCCER_MANUAL_SIMULATION_VERSION,status:'USER_HYPOTHESIS_ONLY',input:{...input},
    gameId:game.id,analysisRevision:snapshot.revision,analysisCutoff:snapshot.analysisCutoff,
    calculatedAt:new Date(now).toISOString(),modelVersion:distribution.modelVersion,trainingHash:distribution.trainingHash,
    distributionHash:soccerScoringHash(distribution),probabilities:payoff.probabilities,netReturnBounds:payoff.evBounds.net,
    unresolvedTailMass:payoff.unresolvedTailMass,assumption:{mechanic:'CREDIT_BOUNDARY',accountTermsVerified:false,
      rebateRate:.01,rebateBasis:'SETTLED_PRINCIPAL'},inputSource:'USER_HYPOTHESIS',
    W:null,R:null,S:null,formalScoringEnabled:false,eligible:false,executable:false};
}
