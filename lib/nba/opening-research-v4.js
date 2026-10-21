import { createHash } from 'node:crypto';
import { auditOpeningResearchArchive } from './opening-history-evidence.js';
import { OPENING_RESEARCH_PROTOCOL, OPENING_RESEARCH_BASELINE_VERSION,
  openingResearchCandidate, buildOpeningResearchObservations,
  buildOpeningResearchBaselineObservations, openingResearchReadiness } from './opening-research.js';

// Research only. V3 and its consumed holdout remain immutable.
export const TOTALS_V4_PROTOCOL = Object.freeze({
  version: 'nba-opening-totals-season-reset-v4',
  priorWeight: 10, trainingSeasons: 3, ridgePenalty: 1000,
  leaguePriorGames: 120, correctionPriorSamples: 120,
  residualHalfLifeDays: 365, minimumResidualSamples: 50,
  earlyGames: 10, diagnosticYears: Object.freeze([2021, 2022]),
  point: 'league_center_plus_closed_season_slope_times_team_deviation_plus_prior_current_season_raw_error_sum_over_120_plus_count',
  reset: 'zero_intercept_and_zero_correction_at_each_new_season',
  update: 'all_targets_on_a_date_predicted_before_any_of_that_date_results_update_state',
  calibration: 'candidate_matched_same_phase_closed_prior_three_seasons_centered_innovations',
  selection: 'one_fixed_candidate_per_target_no_parameter_search',
  baseline: OPENING_RESEARCH_BASELINE_VERSION,
  evidence: '2021_and_2022_are_viewed_development_only_never_fresh_holdouts',
  independentValidation: 'pending_new_frozen_pregame_capture_not_supplied_by_this_retrospective_runner',
  acceptance: 'unchanged_raw_MAE_earlyMAE_Brier_LogLoss_and_sample_gates',
});
export const totalsV4Hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const TOTALS_V4_PROTOCOL_HASH = totalsV4Hash(TOTALS_V4_PROTOCOL);
if(TOTALS_V4_PROTOCOL_HASH!=='0e95ea0df2b35bb02917e2e905e267418dd6a58ae40dc361e35cd38f455737fe')throw Error('NBA_TOTALS_V4_PROTOCOL_DRIFT');
const targets = ['fullTotal', 'halfTotal'];
const mean = xs => xs.length ? xs.reduce((s,x)=>s+x,0)/xs.length : null;
const weight = (date, prior) => 2 ** (-(Date.parse(date)-Date.parse(prior))/86400000/365);
const closed = (r,row) => r.year<row.year && r.year>=row.year-3 && r.date<row.date;
export function totalsV4Candidate(target) {
  if (!targets.includes(target)) throw Error('NBA_TOTALS_V4_TARGET_INVALID');
  const definition = {target, version:TOTALS_V4_PROTOCOL.version, protocolHash:TOTALS_V4_PROTOCOL_HASH};
  return Object.freeze({...definition,candidateId:totalsV4Hash(definition)});
}

export function buildTotalsV4Observations(history,target) {
  const candidate = totalsV4Candidate(target);
  // Reuse reviewed prior-only features/slopes, never its fitted intercept or
  // residuals. The inherited input/version is fixed, not searched on 2022.
  const definition = OPENING_RESEARCH_PROTOCOL.candidateDefinitions[target].find(r=>r.name==='league_centered');
  const input = buildOpeningResearchObservations(history,openingResearchCandidate(target,definition)).observations;
  const output=[], seasons=new Map();
  for(let start=0;start<input.length;) {
    let end=start+1;while(end<input.length&&input[end].date===input[start].date)end++;
    const batch=[];
    for(const r of input.slice(start,end)) {
      const s=seasons.get(r.year)||{sum:0,n:0,through:null};
      const rawPrediction=r.feature.leagueEstimate+r.fit.slope*(r.feature.baseline-r.feature.leagueEstimate);
      const correction=s.sum/(120+s.n),prediction=rawPrediction+correction;
      if(![rawPrediction,correction,prediction].every(Number.isFinite))throw Error('NBA_TOTALS_V4_NONFINITE');
      batch.push({...r,modelVersion:candidate.version,candidateId:candidate.candidateId,
        prediction,error:r.actual-prediction,rawPrediction,rawError:r.actual-rawPrediction,
        correction,correctionSamples:s.n,correctionThrough:s.through,
        discardedHistoricalIntercept:r.fit.intercept,fit:{slope:r.fit.slope,intercept:0}});
    }
    output.push(...batch);
    // Never learn from a same-date result, even if its game ID sorts earlier.
    for(const r of batch) {
      const s=seasons.get(r.year)||{sum:0,n:0,through:null};
      seasons.set(r.year,{sum:s.sum+r.rawError,n:s.n+1,through:r.date});
    }
    start=end;
  }
  return output;
}

export function totalsV4Probability(row,observations,target,baselineObservations) {
  const candidate=totalsV4Candidate(target);
  if(row?.candidateId!==candidate.candidateId||row?.modelVersion!==candidate.version||row?.target!==target
    ||!(row.featureThrough<row.date)||!(row.fitThrough<row.date)
    ||(row.correctionThrough!==null&&!(row.correctionThrough<row.date))
    ||![row.prediction,row.actual,row.baseline].every(Number.isFinite))throw Error('NBA_TOTALS_V4_SCOPE_INVALID');
  const prior=observations.filter(r=>closed(r,row)&&r.target===target&&r.candidateId===candidate.candidateId
    &&r.modelVersion===candidate.version&&r.phase===row.phase&&r.featureThrough<r.date&&r.fitThrough<r.date
    &&(r.correctionThrough===null||r.correctionThrough<r.date)&&Number.isFinite(r.error));
  const base=baselineObservations.filter(r=>closed(r,row)&&r.target===target
    &&r.baselineVersion===OPENING_RESEARCH_BASELINE_VERSION&&r.featureThrough<r.date
    &&[r.actual,r.baseline].every(Number.isFinite));
  if(prior.length<50||base.length<50)return null;
  const sum=prior.reduce((s,r)=>s+weight(row.date,r.date),0),bs=base.reduce((s,r)=>s+weight(row.date,r.date),0);
  const center=prior.reduce((s,r)=>s+weight(row.date,r.date)*r.error,0)/sum;
  const threshold=Math.floor(row.baseline)+.5;
  const p=prior.reduce((s,r)=>s+weight(row.date,r.date)*Number(Math.round(row.prediction+r.error-center)>threshold),0)/sum;
  const baselineP=base.reduce((s,r)=>s+weight(row.date,r.date)*Number(Math.round(row.baseline+r.actual-r.baseline)>threshold),0)/bs;
  if(![p,baselineP,center].every(Number.isFinite)||p<0||p>1||baselineP<0||baselineP>1)throw Error('NBA_TOTALS_V4_PROBABILITY_INVALID');
  return {gameId:row.gameId,date:row.date,target,candidateId:candidate.candidateId,p,baselineP,
    y:Number(row.actual>threshold),threshold,samples:prior.length,through:prior.at(-1).date,
    baselineSamples:base.length,baselineThrough:base.at(-1).date,residualCenter:center};
}

export function totalsV4Metrics(rows,probabilities) {
  const early=rows.filter(r=>r.currentGames.home<10&&r.currentGames.away<10);
  const loss=k=>{const xs=probabilities.map(r=>r.y?-Math.log(r[k]):-Math.log1p(-r[k]));return xs.length&&xs.every(Number.isFinite)?mean(xs):null;};
  return {samples:rows.length,earlySamples:early.length,probabilitySamples:probabilities.length,
    modelMAE:mean(rows.map(r=>Math.abs(r.error))),baselineMAE:mean(rows.map(r=>Math.abs(r.actual-r.baseline))),
    earlyModelMAE:mean(early.map(r=>Math.abs(r.error))),earlyBaselineMAE:mean(early.map(r=>Math.abs(r.actual-r.baseline))),
    modelBias:mean(rows.map(r=>-r.error)),earlyModelBias:mean(early.map(r=>-r.error)),
    modelBrier:mean(probabilities.map(r=>(r.p-r.y)**2)),baselineBrier:mean(probabilities.map(r=>(r.baselineP-r.y)**2)),
    modelLogLoss:loss('p'),baselineLogLoss:loss('baselineP')};
}

export function evaluateTotalsV4(history,{archiveEvidence=null}={}) {
  const sourceAudit=auditOpeningResearchArchive(history,archiveEvidence);
  if(!sourceAudit.every(r=>r.verified))throw Error('NBA_TOTALS_V4_SOURCE_UNVERIFIED');
  const results={};
  for(const target of targets) {
    const observations=buildTotalsV4Observations(history,target),base=buildOpeningResearchBaselineObservations(history,target);
    results[target]={candidate:totalsV4Candidate(target),years:{}};
    for(const year of TOTALS_V4_PROTOCOL.diagnosticYears) {
      const rows=observations.filter(r=>r.year===year),probabilities=rows.flatMap(r=>totalsV4Probability(r,observations,target,base)||[]);
      const metrics=totalsV4Metrics(rows,probabilities),readiness=openingResearchReadiness(metrics);
      results[target].years[year]={role:'VIEWED_DEVELOPMENT_NOT_INDEPENDENT',metrics,
        historicalGatesPassed:readiness.readyForIndependentValidation,reasons:readiness.reasons};
    }
  }
  const historicalGatesPassed=Object.values(results).every(r=>Object.values(r.years).every(y=>y.historicalGatesPassed));
  return {version:TOTALS_V4_PROTOCOL.version,protocol:TOTALS_V4_PROTOCOL,protocolHash:TOTALS_V4_PROTOCOL_HASH,
    historyHash:totalsV4Hash(history),sourceAudit,targets:results,
    status:historicalGatesPassed?'BLOCKED_PENDING_NEW_INDEPENDENT_VALIDATION':'BLOCKED_DEVELOPMENT_AND_INDEPENDENT_VALIDATION',
    independentValidation:{status:'NOT_STARTED',samples:0},
    executable:false,promotionEligible:false,
    limitations:['Viewed historical improvement cannot authorize production scores.',
      'No future pregame capture is performed by this runner.',
      'Retrospective source records do not prove historical pregame availability.',
      'Reference thresholds are not historical bookmaker quotes or betting win rates.']};
}
