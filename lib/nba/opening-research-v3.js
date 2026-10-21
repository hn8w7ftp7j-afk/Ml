import { createHash } from 'node:crypto';
import { validateOpeningHistory } from './opening-core.js';
import { auditOpeningResearchArchive } from './opening-history-evidence.js';
import { buildOpeningResearchBaselineObservations, openingResearchReadiness, OPENING_RESEARCH_BASELINE_VERSION } from './opening-research.js';

// Research only. No production imports, acceptance writes or score overrides.
export const NBA_TOTALS_V3_VERSION = 'nba-opening-totals-phase-research-v3';
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
export const totalsV3Hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const TOTALS_V3_PROTOCOL = freeze({
  version: NBA_TOTALS_V3_VERSION, developmentYear: 2021, holdoutYear: 2022,
  viewedRegressionYears: [2023, 2024, 2025, 2026], priorWeights: [10, 20, 40],
  kernels: ['league_centered', 'phase_bias_centered', 'phase_ridge_centered'],
  selection: 'separate_target_common_cohort_all_existing_gates_then_brier_logloss_early_mae',
  trainingSeasons: 3, ridgePenalty: 1000, earlyGames: 10, leaguePriorGames: 120,
  biasPriorSamples: 120, minFitSamples: 30, minResidualSamples: 50,
  residualHalfLifeDays: 365,
  baseline: 'canonical_prior20_previous_three_closed_seasons_all_phases',
  phaseBias: 'weighted_raw_prequential_error_same_phase_previous_closed_seasons_shrunk_toward_zero',
  centeredCalibration: 'candidate_matched_same_phase_errors_minus_weighted_error_mean',
  phaseRidge: 'independent_early_mature_ridge_intercepts_and_slopes_previous_closed_seasons',
  sourceYears: [2018, 2019, 2020, 2021, 2022],
  gates: { samples: 1000, earlySamples: 100, probabilitySamples: 1000,
    modelMAE: 'at_most_baseline', earlyModelMAE: 'at_most_baseline',
    modelBrier: 'at_most_baseline', modelLogLoss: 'at_most_baseline' },
  rationale: 'V2 development shows larger positive prediction bias in early games. Compare bounded prior weights and prior-only phase correction; do not alter gates.',
  holdoutPolicy: 'Freeze development selection before evaluating 2022. A failed holdout ends this experiment; no re-selection from holdout.',
});
export const TOTALS_V3_PROTOCOL_HASH = totalsV3Hash(TOTALS_V3_PROTOCOL);
export const TOTALS_V3_EXPECTED_PROTOCOL_HASH = '241ae48469febe96b667b2175f745a8e6246ad90391a129953c70c0a05aee028';
if (TOTALS_V3_PROTOCOL_HASH !== TOTALS_V3_EXPECTED_PROTOCOL_HASH) throw Error('NBA_TOTALS_V3_PROTOCOL_DRIFT');
// Frozen from development only, before any real 2022 predictive metrics.
export const TOTALS_V3_FROZEN_SELECTION_HASH = '9983c154d42c243aa7c247fb52ec3530e0ec169c86cfc5b4c27ef49eee2c27c0';
const targets = ['fullTotal', 'halfTotal'];
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const actual = (r, target) => target === 'fullTotal' ? r.homeScore + r.awayScore : r.homeHalf + r.awayHalf;
const ordered = (a, b) => a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId);
const weight = (date, prior) => 2 ** (-(Date.parse(date) - Date.parse(prior)) / 86400000 / TOTALS_V3_PROTOCOL.residualHalfLifeDays);
const closed = (r, row) => r.date < row.date && r.year < row.year && r.year >= row.year - TOTALS_V3_PROTOCOL.trainingSeasons;
const early = r => r.currentGames.home < 10 && r.currentGames.away < 10;

export function totalsV3Candidate(target, priorWeight, kernel) {
  if (!targets.includes(target) || !TOTALS_V3_PROTOCOL.priorWeights.includes(priorWeight) || !TOTALS_V3_PROTOCOL.kernels.includes(kernel)) throw Error('NBA_TOTALS_V3_CANDIDATE_INVALID');
  const definition = { target, priorWeight, kernel, modelVersion: NBA_TOTALS_V3_VERSION, protocolHash: TOTALS_V3_PROTOCOL_HASH };
  return freeze({ ...definition, candidateId: totalsV3Hash(definition) });
}

function frames(history) {
  if (!validateOpeningHistory(history) || history.some(r => r.league != null && r.league !== 'NBA')) throw Error('NBA_TOTALS_V3_HISTORY_INVALID');
  const rows = [...history].sort(ordered), years = new Map(), output = new Map();
  const state = y => { if (!years.has(y)) years.set(y, { n: 0, fullTotal: 0, halfTotal: 0, teams: new Map(), through: null }); return years.get(y); };
  const team = (s, id) => s?.teams.get(id) || { n: 0, fullFor: 0, fullAgainst: 0, halfFor: 0, halfAgainst: 0 };
  const bounds = new Map();
  for (const r of rows) { const b = bounds.get(r.year); bounds.set(r.year, { first: b?.first || r.date, last: r.date }); }
  const sequence = [...bounds.keys()].sort((a,b)=>a-b);
  if (sequence.some((y,i)=>i && bounds.get(sequence[i-1]).last >= bounds.get(y).first)) throw Error('NBA_TOTALS_V3_SEASON_OVERLAP');
  for (let start = 0; start < rows.length;) {
    let end = start + 1; while (end < rows.length && rows[end].date === rows[start].date) end++;
    for (const r of rows.slice(start, end)) {
      const old = years.get(r.year - 1), fresh = state(r.year), ho = team(old,r.homeId), ao = team(old,r.awayId);
      if (!old?.n || ho.n < 20 || ao.n < 20) continue;
      const h = team(fresh,r.homeId), a = team(fresh,r.awayId), f = {};
      for (const prior of TOTALS_V3_PROTOCOL.priorWeights) {
        f[prior] = {};
        for (const target of targets) {
          const prefix = target === 'fullTotal' ? 'full' : 'half';
          const rate = (p,c,k) => (prior*p[k]/p.n+c[k])/(prior+c.n);
          const baseline = (rate(ho,h,`${prefix}For`)+rate(ao,a,`${prefix}Against`)+rate(ao,a,`${prefix}For`)+rate(ho,h,`${prefix}Against`))/2;
          const league = (120 * old[target]/old.n + fresh[target])/(120+fresh.n);
          f[prior][target] = { baseline, league, currentGames: { home:h.n, away:a.n },
            through:[old.through,fresh.through].filter(Boolean).sort().at(-1) };
        }
      }
      output.set(r.gameId,f);
    }
    for (const r of rows.slice(start,end)) {
      const s = state(r.year); s.n++; s.fullTotal+=actual(r,'fullTotal'); s.halfTotal+=actual(r,'halfTotal'); s.through=r.date;
      for (const side of ['home','away']) {
        const other=side==='home'?'away':'home',t={...team(s,r[`${side}Id`])}; t.n++;
        t.fullFor+=r[`${side}Score`]; t.fullAgainst+=r[`${other}Score`]; t.halfFor+=r[`${side}Half`]; t.halfAgainst+=r[`${other}Half`]; s.teams.set(r[`${side}Id`],t);
      }
    }
    start=end;
  }
  return {rows,inputs:output};
}

function ridge(prior) {
  const xb=mean(prior.map(r=>r.x)),yb=mean(prior.map(r=>r.y));
  const slope=prior.reduce((s,r)=>s+(r.x-xb)*(r.y-yb),0)/(1000+prior.reduce((s,r)=>s+(r.x-xb)**2,0));
  return {slope,intercept:yb-slope*xb,through:prior.at(-1).date,samples:prior.length};
}

export function buildTotalsV3Observations(history,candidate) {
  if (JSON.stringify(candidate)!==JSON.stringify(totalsV3Candidate(candidate?.target,candidate?.priorWeight,candidate?.kernel))) throw Error('NBA_TOTALS_V3_CANDIDATE_MISMATCH');
  const {rows,inputs}=frames(history), features=[], observations=[], fits=new Map(),biases=new Map();
  for (const row of rows) {
    const f=inputs.get(row.gameId)?.[candidate.priorWeight]?.[candidate.target], ref=inputs.get(row.gameId)?.[20]?.[candidate.target];
    if (!f || !ref) continue;
    const phase=f.currentGames.home<10&&f.currentGames.away<10?'early':'mature';
    const phaseFit=candidate.kernel==='phase_ridge_centered',key=`${row.year}:${phaseFit?phase:'all'}`;
    if (!fits.has(key)) {
      const prior=features.filter(r=>closed(r,row)&&(!phaseFit||r.phase===phase));
      fits.set(key,prior.length>=30?ridge(prior):null);
    }
    const fitted=fits.get(key),x=f.baseline-f.league,y=actual(row,candidate.target)-f.league;
    if (fitted) {
      const rawPrediction=fitted.intercept+fitted.slope*x+f.league;
      let bias=0,biasThrough=null,biasSamples=0;
      if (candidate.kernel==='phase_bias_centered') {
        const biasKey=`${row.year}:${phase}`;
        if (!biases.has(biasKey)) {
          const prior=observations.filter(r=>closed(r,row)&&r.phase===phase),sum=prior.reduce((s,r)=>s+weight(row.date,r.date),0);
          // Estimate once at the first eligible game of the phase, using only
          // closed seasons; current-year scores never tune the correction.
          biases.set(biasKey,{value:sum?prior.reduce((s,r)=>s+weight(row.date,r.date)*r.rawError,0)/(sum+120):0,
            through:prior.at(-1)?.date??null,samples:prior.length});
        }
        const b=biases.get(biasKey);bias=b.value;biasThrough=b.through;biasSamples=b.samples;
      }
      const prediction=rawPrediction+bias;
      if (![rawPrediction,prediction,bias].every(Number.isFinite)) throw Error('NBA_TOTALS_V3_PREDICTION_INVALID');
      observations.push({gameId:row.gameId,date:row.date,year:row.year,target:candidate.target,phase,currentGames:f.currentGames,
        candidateId:candidate.candidateId,modelVersion:NBA_TOTALS_V3_VERSION,prediction,actual:actual(row,candidate.target),baseline:ref.baseline,
        error:actual(row,candidate.target)-prediction,rawError:actual(row,candidate.target)-rawPrediction,
        rawPrediction,bias,biasThrough,biasSamples,featureThrough:f.through,fitThrough:fitted.through,fitSamples:fitted.samples,
        feature:{baseline:f.baseline,league:f.league},fit:{slope:fitted.slope,intercept:fitted.intercept}});
    }
    features.push({gameId:row.gameId,date:row.date,year:row.year,phase,x,y});
  }
  return observations;
}

export function totalsV3Probability(row,observations,candidate,baselineObservations) {
  if (JSON.stringify(candidate)!==JSON.stringify(totalsV3Candidate(candidate?.target,candidate?.priorWeight,candidate?.kernel))) throw Error('NBA_TOTALS_V3_CANDIDATE_MISMATCH');
  if (row?.candidateId!==candidate?.candidateId||row?.modelVersion!==NBA_TOTALS_V3_VERSION||row?.target!==candidate.target
    ||!(row.featureThrough<row.date)||!(row.fitThrough<row.date)||![row.prediction,row.actual,row.baseline].every(Number.isFinite)) throw Error('NBA_TOTALS_V3_PROBABILITY_SCOPE_INVALID');
  const phaseAware=candidate.kernel!=='league_centered';
  const prior=observations.filter(r=>closed(r,row)&&r.candidateId===candidate.candidateId&&r.modelVersion===NBA_TOTALS_V3_VERSION&&r.target===candidate.target
    &&r.featureThrough<r.date&&r.fitThrough<r.date&&Number.isFinite(r.error)&&(!phaseAware||r.phase===row.phase));
  const base=baselineObservations.filter(r=>closed(r,row)&&r.target===candidate.target&&r.baselineVersion===OPENING_RESEARCH_BASELINE_VERSION&&r.featureThrough<r.date&&[r.actual,r.baseline].every(Number.isFinite));
  if (prior.length<50||base.length<50) return null;
  const sum=prior.reduce((s,r)=>s+weight(row.date,r.date),0),bs=base.reduce((s,r)=>s+weight(row.date,r.date),0);
  const center=phaseAware?prior.reduce((s,r)=>s+weight(row.date,r.date)*r.error,0)/sum:0;
  const threshold=Math.floor(row.baseline)+.5;
  const p=prior.reduce((s,r)=>s+weight(row.date,r.date)*Number(Math.round(row.prediction+r.error-center)>threshold),0)/sum;
  const baselineP=base.reduce((s,r)=>s+weight(row.date,r.date)*Number(Math.round(row.baseline+r.actual-r.baseline)>threshold),0)/bs;
  if (![p,baselineP,center,sum,bs].every(Number.isFinite)||sum<=0||bs<=0) throw Error('NBA_TOTALS_V3_CALIBRATION_INVALID');
  return {gameId:row.gameId,date:row.date,year:row.year,candidateId:candidate.candidateId,p,baselineP,y:Number(row.actual>threshold),threshold,
    samples:prior.length,through:prior.at(-1).date,baselineSamples:base.length,baselineThrough:base.at(-1).date,
    residualCenter:center,basis:phaseAware?'candidate_matched_phase_centered_innovations':'candidate_matched_raw_empirical'};
}

export function totalsV3Metrics(rows,probabilities) {
  const first=rows.filter(early);
  const loss=k=>{const v=probabilities.map(r=>r.y?-Math.log(r[k]):-Math.log1p(-r[k]));return v.length&&v.every(Number.isFinite)?mean(v):null;};
  return {samples:rows.length,earlySamples:first.length,probabilitySamples:probabilities.length,
    modelMAE:mean(rows.map(r=>Math.abs(r.error))),baselineMAE:mean(rows.map(r=>Math.abs(r.actual-r.baseline))),
    earlyModelMAE:mean(first.map(r=>Math.abs(r.error))),earlyBaselineMAE:mean(first.map(r=>Math.abs(r.actual-r.baseline))),
    modelBias:mean(rows.map(r=>-r.error)),earlyModelBias:mean(first.map(r=>-r.error)),
    modelBrier:mean(probabilities.map(r=>(r.p-r.y)**2)),baselineBrier:mean(probabilities.map(r=>(r.baselineP-r.y)**2)),
    modelLogLoss:loss('p'),baselineLogLoss:loss('baselineP')};
}

export function developTotalsV3(history,{archiveEvidence=null}={}) {
  const sourceAudit=auditOpeningResearchArchive(history,archiveEvidence),development=history.filter(r=>r.year<=2021),results={};
  for (const target of targets) {
    const baseline=buildOpeningResearchBaselineObservations(development,target);
    const candidates=TOTALS_V3_PROTOCOL.priorWeights.flatMap(prior=>TOTALS_V3_PROTOCOL.kernels.map(kernel=>{
      const candidate=totalsV3Candidate(target,prior,kernel),observations=buildTotalsV3Observations(development,candidate),rows=observations.filter(r=>r.year===2021);
      return {candidate,rows,probabilities:rows.flatMap(r=>totalsV3Probability(r,observations,candidate,baseline)||[])};
    }));
    const common=key=>candidates.reduce((ids,c)=>{const next=new Set(c[key].map(r=>r.gameId));return ids==null?next:new Set([...ids].filter(id=>next.has(id)));},null);
    const ids=common('rows'),ps=common('probabilities');
    const summaries=candidates.map(c=>{const metrics=totalsV3Metrics(c.rows.filter(r=>ids.has(r.gameId)),c.probabilities.filter(r=>ps.has(r.gameId)));return {candidate:c.candidate,metrics,readiness:openingResearchReadiness(metrics)};});
    const eligible=summaries.filter(r=>r.readiness.readyForIndependentValidation).sort((a,b)=>a.metrics.modelBrier-b.metrics.modelBrier||a.metrics.modelLogLoss-b.metrics.modelLogLoss||a.metrics.earlyModelMAE-b.metrics.earlyModelMAE||a.candidate.candidateId.localeCompare(b.candidate.candidateId));
    results[target]={commonPointSamples:ids.size,commonProbabilitySamples:ps.size,candidates:summaries,selected:eligible[0]?.candidate??null};
  }
  return {version:NBA_TOTALS_V3_VERSION,protocol:TOTALS_V3_PROTOCOL,protocolHash:TOTALS_V3_PROTOCOL_HASH,
    developmentHistoryHash:totalsV3Hash(development),targets:results,sourceAudit,
    holdout:{year:2022,evaluationStatus:'NOT_EVALUATED_SELECTION_NOT_YET_LOCKED',metrics:null},
    executable:false,promotionEligible:false};
}

export function createTotalsV3Selection(report) {
  if (report?.protocolHash!==TOTALS_V3_PROTOCOL_HASH || totalsV3Hash(report.protocol)!==TOTALS_V3_PROTOCOL_HASH
    ||report.holdout?.metrics!==null ||report.holdout?.year!==2022
    ||JSON.stringify(report.sourceAudit?.map(r=>r.year))!==JSON.stringify(TOTALS_V3_PROTOCOL.sourceYears)
    ||!report.sourceAudit.every(r=>r.verified===true)) throw Error('NBA_TOTALS_V3_DEVELOPMENT_SOURCE_OR_PROTOCOL_INVALID');
  const selected={};
  for (const target of targets) {
    const value=report.targets?.[target];
    if (!value?.selected ||value.candidates?.length!==9) throw Error('NBA_TOTALS_V3_DEVELOPMENT_NOT_ACCEPTED');
    const eligible=value.candidates.filter(r=>openingResearchReadiness(r.metrics).readyForIndependentValidation)
      .sort((a,b)=>a.metrics.modelBrier-b.metrics.modelBrier||a.metrics.modelLogLoss-b.metrics.modelLogLoss||a.metrics.earlyModelMAE-b.metrics.earlyModelMAE||a.candidate.candidateId.localeCompare(b.candidate.candidateId));
    const best=eligible[0];
    if (!best||JSON.stringify(best.candidate)!==JSON.stringify(value.selected)
      ||JSON.stringify(best.candidate)!==JSON.stringify(totalsV3Candidate(target,best.candidate.priorWeight,best.candidate.kernel))) throw Error('NBA_TOTALS_V3_SELECTION_MISMATCH');
    selected[target]={candidate:best.candidate,developmentMetrics:best.metrics};
  }
  return {version:NBA_TOTALS_V3_VERSION,protocolHash:TOTALS_V3_PROTOCOL_HASH,developmentYear:2021,holdoutYear:2022,
    developmentHistoryHash:report.developmentHistoryHash,developmentReportHash:totalsV3Hash(report),selected,
    frozenBeforeRealHoldoutEvaluation:true,executable:false,promotionEligible:false};
}
