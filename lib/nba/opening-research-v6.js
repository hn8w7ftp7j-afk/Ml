import {createHash} from 'node:crypto';
import {buildTotalsV4Observations,TOTALS_V4_PROTOCOL_HASH} from './opening-research-v4.js';
import {auditOpeningResearchArchive} from './opening-history-evidence.js';
import {buildOpeningResearchBaselineObservations,OPENING_RESEARCH_BASELINE_VERSION,openingResearchReadiness} from './opening-research.js';
import {validateOpeningHistory} from './opening-core.js';

// One conservative hybrid candidate. Existing V2/V3/V4/V5 evidence is immutable.
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
export const totalsV6Hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const TOTALS_V6_PROTOCOL=freeze({
  version:'nba-opening-totals-early-baseline-hybrid-v6',
  pointModelProtocolHash:TOTALS_V4_PROTOCOL_HASH,
  point:'early_both_under10_exact_canonical_prior20_baseline_otherwise_exact_v4_point',
  shape:'same_target_candidate_version_phase_closed_prior_three_seasons_hybrid_point_errors_minus_weighted_mean',
  location:'strictly_earlier_date_current_season_all_phase_hybrid_point_error_sum_over_120_plus_count',
  distributionCenter:'hybrid_point_prediction_plus_current_season_location',
  update:'all_games_on_date_predicted_before_any_of_that_date_results',
  correctionPriorSamples:120,trainingSeasons:3,residualHalfLifeDays:365,minimumResidualSamples:50,
  earlyGames:10,developmentYears:[2021,2022,2023,2024,2025,2026],
  independentHoldoutYear:2011,independentTrainingYears:[2007,2008,2009,2010],
  holdoutRole:'new_external_backward_era_retrospective_validation_not_prospective_or_historical_pregame_capture',
  selection:'one_fixed_candidate_per_target_all_development_years_must_pass_no_parameter_search',
  holdoutPolicy:'freeze_protocol_implementation_and_development_selection_before_any_real_2011_predictive_metrics_no_reselection',
  baseline:OPENING_RESEARCH_BASELINE_VERSION,
  gates:{samples:1000,earlySamples:100,probabilitySamples:1000,
    modelMAE:'at_most_baseline',earlyModelMAE:'at_most_baseline',modelBrier:'at_most_baseline',modelLogLoss:'at_most_baseline'},
  probabilityEvent:'rounded_predictive_score_exceeds_arbitrary_reference_threshold',
  production:'no_activation_without_verified_independent_evidence_and_exact_runtime_parity',
  earlyPointClaim:'equals_benchmark_by_construction_no_claim_of_improved_early_point_accuracy',
});
export const TOTALS_V6_PROTOCOL_HASH=totalsV6Hash(TOTALS_V6_PROTOCOL);
if(TOTALS_V6_PROTOCOL_HASH!=='01bd869099a83f1113e499732ebc6bac10be5f716961ca7ef02aa793f09ce795')throw Error('NBA_TOTALS_V6_PROTOCOL_DRIFT');
const targets=['fullTotal','halfTotal'];
const mean=xs=>xs.length?xs.reduce((s,x)=>s+x,0)/xs.length:null;
// Dates repeat for every residual on a board. Cache parsing only; summation,
// weights and raw gate comparisons retain exactly the declared arithmetic.
const parsedDates=new Map();
const dateMs=date=>{if(!parsedDates.has(date)){if(parsedDates.size>=5000)parsedDates.delete(parsedDates.keys().next().value);parsedDates.set(date,Date.parse(date));}return parsedDates.get(date);};
const weight=(date,prior)=>2**(-(dateMs(date)-dateMs(prior))/86400000/365);
const closed=(r,row)=>r.date<row.date&&r.year<row.year&&r.year>=row.year-3;
export function totalsV6Candidate(target){
  if(!targets.includes(target))throw Error('NBA_TOTALS_V6_TARGET_INVALID');
  const d={target,modelVersion:TOTALS_V6_PROTOCOL.version,protocolHash:TOTALS_V6_PROTOCOL_HASH};
  return freeze({...d,candidateId:totalsV6Hash(d)});
}
function eligible(r,candidate){
  return r?.candidateId===candidate.candidateId&&r?.modelVersion===candidate.modelVersion&&r?.target===candidate.target
    &&Number.isInteger(r.year)&&Number.isFinite(dateMs(r.date))&&['early','mature'].includes(r.phase)
    &&r.featureThrough<r.date&&r.fitThrough<r.date&&(r.correctionThrough===null||r.correctionThrough<r.date)
    &&Number.isFinite(r.pointPrediction)&&Number.isFinite(r.pointError);
}
function currentLocation(row,observations,candidate){
  const prior=observations.filter(r=>eligible(r,candidate)&&r.year===row.year&&r.date<row.date);
  return {locationCorrection:prior.reduce((s,r)=>s+r.pointError,0)/(120+prior.length),
    locationSamples:prior.length,locationThrough:prior.at(-1)?.date??null};
}
// Usable with a target-score-free hybrid runtime row. No actual/pointError is read
// from the target. Only prior observations may update its predictive location.
export function totalsV6AsOfRow(pointRow,observations,target){
  const candidate=totalsV6Candidate(target),pointPrediction=pointRow.pointPrediction??pointRow.prediction;
  if(pointRow.target!=null&&pointRow.target!==target||!Number.isFinite(pointPrediction)||!Number.isInteger(pointRow.year)||!['early','mature'].includes(pointRow.phase)
    ||!(pointRow.featureThrough<pointRow.date)||!(pointRow.fitThrough<pointRow.date)
    ||(pointRow.correctionThrough!==null&&!(pointRow.correctionThrough<pointRow.date)))throw Error('NBA_TOTALS_V6_POINT_SCOPE_INVALID');
  if(pointRow.phase==='early'&&(!Number.isFinite(pointRow.baseline)||pointPrediction!==pointRow.baseline))throw Error('NBA_TOTALS_V6_EARLY_FALLBACK_INVALID');
  const row={...pointRow,target,modelVersion:candidate.modelVersion,candidateId:candidate.candidateId,
    pointPrediction,prediction:pointPrediction};
  const location=currentLocation(row,observations,candidate);
  return {...row,...location,distributionCenter:pointPrediction+location.locationCorrection};
}
export function buildTotalsV6Observations(history,target){
  const points=buildTotalsV4Observations(history,target),output=[],seasons=new Map(),candidate=totalsV6Candidate(target);
  for(let start=0;start<points.length;){
    let end=start+1;while(end<points.length&&points[end].date===points[start].date)end++;
    const batch=points.slice(start,end).map(r=>{
      const s=seasons.get(r.year)||{sum:0,n:0,through:null},locationCorrection=s.sum/(120+s.n);
      const prediction=r.phase==='early'?r.baseline:r.prediction,error=r.actual-prediction;
      return {...r,target,modelVersion:candidate.modelVersion,candidateId:candidate.candidateId,
        inheritedV4PointPrediction:r.prediction,inheritedV4PointError:r.error,
        prediction,error,pointPrediction:prediction,pointError:error,
        earlyPointFallback:r.phase==='early',locationCorrection,locationSamples:s.n,locationThrough:s.through,
        distributionCenter:prediction+locationCorrection,distributionError:r.actual-(prediction+locationCorrection)};
    });
    output.push(...batch);
    for(const r of batch){const s=seasons.get(r.year)||{sum:0,n:0,through:null};seasons.set(r.year,{sum:s.sum+r.pointError,n:s.n+1,through:r.date});}
    start=end;
  }
  return output;
}
export function totalsV6Distribution(row,observations,target){
  const candidate=totalsV6Candidate(target);
  if(row?.candidateId!==candidate.candidateId||row?.modelVersion!==candidate.modelVersion||row?.target!==target
    ||!(row.featureThrough<row.date)||!(row.fitThrough<row.date)
    ||(row.correctionThrough!==null&&!(row.correctionThrough<row.date))
    ||!Number.isFinite(row.pointPrediction)||!Number.isInteger(row.year)||!['early','mature'].includes(row.phase))throw Error('NBA_TOTALS_V6_DISTRIBUTION_SCOPE_INVALID');
  if(row.phase==='early'&&row.pointPrediction!==row.baseline)throw Error('NBA_TOTALS_V6_EARLY_FALLBACK_INVALID');
  const prior=observations.filter(r=>eligible(r,candidate)&&closed(r,row)&&r.phase===row.phase);
  if(prior.length<50)return null;
  const sum=prior.reduce((s,r)=>s+weight(row.date,r.date),0);
  const shapeCenter=prior.reduce((s,r)=>s+weight(row.date,r.date)*r.pointError,0)/sum;
  const location=currentLocation(row,observations,candidate),center=row.pointPrediction+location.locationCorrection;
  if(![sum,shapeCenter,center].every(Number.isFinite)||sum<=0)throw Error('NBA_TOTALS_V6_DISTRIBUTION_INVALID');
  return {target,date:row.date,year:row.year,phase:row.phase,candidateId:candidate.candidateId,modelVersion:candidate.modelVersion,
    pointPrediction:row.pointPrediction,center,shapeCenter,...location,samples:prior.length,through:prior.at(-1).date,
    residuals:prior.map(r=>({gameId:r.gameId,year:r.year,date:r.date,error:r.pointError-shapeCenter})),weightSum:sum};
}
// The same rounded-score distribution supports every quoted line. This is a
// proper monotone CDF, not a separately fitted probability for each quote.
export function totalsV6Cdf(distribution,threshold){
  if(!distribution||!Number.isFinite(threshold)||!Number.isFinite(distribution.center)
    ||!Array.isArray(distribution.residuals)||!distribution.residuals.length)throw Error('NBA_TOTALS_V6_CDF_INVALID');
  let sum=0,below=0;
  for(const r of distribution.residuals){
    if(!(r.date<distribution.date)||!Number.isFinite(r.error))throw Error('NBA_TOTALS_V6_CDF_RESIDUAL_INVALID');
    const w=weight(distribution.date,r.date);sum+=w;below+=w*Number(Math.round(distribution.center+r.error)<=threshold);
  }
  if(!Number.isFinite(sum)||sum<=0)throw Error('NBA_TOTALS_V6_CDF_WEIGHT_INVALID');
  return below/sum;
}
export function totalsV6Probability(row,observations,target,baselineObservations,{threshold=Math.floor(row.baseline)+.5}={}){
  if(!Number.isFinite(row.actual)||!Number.isFinite(row.baseline))throw Error('NBA_TOTALS_V6_LABEL_INVALID');
  const distribution=totalsV6Distribution(row,observations,target);
  const base=baselineObservations.filter(r=>closed(r,row)&&r.target===target&&r.baselineVersion===OPENING_RESEARCH_BASELINE_VERSION
    &&r.featureThrough<r.date&&[r.actual,r.baseline].every(Number.isFinite));
  if(!distribution||base.length<50)return null;
  const sum=base.reduce((s,r)=>s+weight(row.date,r.date),0);
  const baselineP=base.reduce((s,r)=>s+weight(row.date,r.date)*Number(Math.round(row.baseline+r.actual-r.baseline)>threshold),0)/sum;
  const p=1-totalsV6Cdf(distribution,threshold);
  if(![p,baselineP].every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw Error('NBA_TOTALS_V6_PROBABILITY_INVALID');
  return {gameId:row.gameId,date:row.date,year:row.year,target,candidateId:distribution.candidateId,
    p,baselineP,y:Number(row.actual>threshold),threshold,samples:distribution.samples,through:distribution.through,
    pointPrediction:distribution.pointPrediction,distributionCenter:distribution.center,
    locationCorrection:distribution.locationCorrection,locationSamples:distribution.locationSamples,locationThrough:distribution.locationThrough,
    shapeCenter:distribution.shapeCenter,baselineSamples:base.length,baselineThrough:base.at(-1).date};
}
export function totalsV6Metrics(rows,probabilities){
  const early=rows.filter(r=>r.currentGames.home<10&&r.currentGames.away<10);
  const loss=k=>{const xs=probabilities.map(r=>r.y?-Math.log(r[k]):-Math.log1p(-r[k]));return xs.length&&xs.every(Number.isFinite)?mean(xs):null;};
  return {samples:rows.length,earlySamples:early.length,probabilitySamples:probabilities.length,
    modelMAE:mean(rows.map(r=>Math.abs(r.pointError))),baselineMAE:mean(rows.map(r=>Math.abs(r.actual-r.baseline))),
    earlyModelMAE:mean(early.map(r=>Math.abs(r.pointError))),earlyBaselineMAE:mean(early.map(r=>Math.abs(r.actual-r.baseline))),
    modelBias:mean(rows.map(r=>-r.pointError)),earlyModelBias:mean(early.map(r=>-r.pointError)),
    modelBrier:mean(probabilities.map(r=>(r.p-r.y)**2)),baselineBrier:mean(probabilities.map(r=>(r.baselineP-r.y)**2)),
    modelLogLoss:loss('p'),baselineLogLoss:loss('baselineP')};
}
export function developTotalsV6(history,{archiveEvidence=null,regressionEvidence=null}={}){
  if(!validateOpeningHistory(history)||history.some(r=>r.year<2018||r.year>2026))throw Error('NBA_TOTALS_V6_DEVELOPMENT_YEAR_SCOPE_INVALID');
  const older=history.filter(r=>r.year<=2022),recent=history.filter(r=>r.year>=2023);
  const sourceAudit=auditOpeningResearchArchive(older,archiveEvidence);
  if(!sourceAudit.every(r=>r.verified))throw Error('NBA_TOTALS_V6_SOURCE_UNVERIFIED');
  if(totalsV6Hash(regressionEvidence)!=='7eed24fa68a50dcbb5b7fd462a847fcd35eebebb4d45450724b0f707619c5d47'
    ||totalsV6Hash(recent)!=='dbba448fefb530dcbb967c4858c90212472e8fe80c1dbc5545c48e0c4dbbdcc1')throw Error('NBA_TOTALS_V6_REGRESSION_SOURCE_UNVERIFIED');
  const result={};
  for(const target of targets){
    const observations=buildTotalsV6Observations(history,target),base=buildOpeningResearchBaselineObservations(history,target),years={};
    for(const year of TOTALS_V6_PROTOCOL.developmentYears){
      const rows=observations.filter(r=>r.year===year),probabilities=rows.flatMap(r=>totalsV6Probability(r,observations,target,base)||[]);
      const metrics=totalsV6Metrics(rows,probabilities),readiness=openingResearchReadiness(metrics);
      years[year]={role:'VIEWED_DEVELOPMENT_NOT_INDEPENDENT',metrics,passed:readiness.readyForIndependentValidation,reasons:readiness.reasons};
    }
    result[target]={candidate:totalsV6Candidate(target),years,selectedForIndependentValidation:Object.values(years).every(r=>r.passed)};
  }
  return {version:TOTALS_V6_PROTOCOL.version,protocol:TOTALS_V6_PROTOCOL,protocolHash:TOTALS_V6_PROTOCOL_HASH,
    historyHash:totalsV6Hash(history),sourceAudit,regressionSource:{yearScope:[2023,2024,2025,2026],verified:true,
      reviewedArchiveSha256:totalsV6Hash(regressionEvidence),historySha256:totalsV6Hash(recent)},targets:result,
    status:Object.values(result).every(r=>r.selectedForIndependentValidation)?'DEVELOPMENT_PASSED_PENDING_FROZEN_EXTERNAL_HOLDOUT':'BLOCKED_DEVELOPMENT_FAILED',
    independentValidation:{year:2011,status:'NOT_EVALUATED_SELECTION_NOT_FROZEN',metrics:null},
    executable:false,promotionEligible:false};
}
export function createTotalsV6Selection(report){
  if(report?.protocolHash!==TOTALS_V6_PROTOCOL_HASH||totalsV6Hash(report.protocol)!==TOTALS_V6_PROTOCOL_HASH
    ||report.independentValidation?.year!==2011||report.independentValidation?.metrics!==null
    ||!Array.isArray(report.sourceAudit)||!report.sourceAudit.every(r=>r.verified)||report.regressionSource?.verified!==true)throw Error('NBA_TOTALS_V6_DEVELOPMENT_EVIDENCE_INVALID');
  const selected={};
  for(const target of targets){
    const t=report.targets?.[target];
    if(!t?.selectedForIndependentValidation||JSON.stringify(t.candidate)!==JSON.stringify(totalsV6Candidate(target))
      ||JSON.stringify(Object.keys(t.years).map(Number))!==JSON.stringify(TOTALS_V6_PROTOCOL.developmentYears)
      ||!Object.values(t.years).every(r=>openingResearchReadiness(r.metrics).readyForIndependentValidation))throw Error('NBA_TOTALS_V6_DEVELOPMENT_NOT_ACCEPTED');
    selected[target]={candidate:t.candidate,developmentMetrics:Object.fromEntries(Object.entries(t.years).map(([year,r])=>[year,r.metrics]))};
  }
  return {version:TOTALS_V6_PROTOCOL.version,protocolHash:TOTALS_V6_PROTOCOL_HASH,developmentReportHash:totalsV6Hash(report),
    developmentHistoryHash:report.historyHash,selected,independentHoldoutYear:2011,
    frozenBeforeRealHoldoutEvaluation:true,executable:false,promotionEligible:false};
}

