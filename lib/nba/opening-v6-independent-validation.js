import {auditOpeningV6IndependentArchive,OPENING_V6_INDEPENDENT_REVIEWED_ARCHIVE_SHA256} from './opening-v6-independent-evidence.js';
import {TOTALS_V6_PROTOCOL,TOTALS_V6_PROTOCOL_HASH,totalsV6Hash,createTotalsV6Selection,
  buildTotalsV6Observations,totalsV6Probability,totalsV6Metrics} from './opening-research-v6.js';
import {buildOpeningResearchBaselineObservations,openingResearchReadiness} from './opening-research.js';

// Development-only selection, filled before any real 2011 predictive metrics.
export const TOTALS_V6_FROZEN_SELECTION_HASH='63dc240cf3a12821b34cd00d9683f1462a061eb14f9cd9dd6ef6dfcdc6f5e746';
export function evaluateTotalsV6Independent(history,selection,{archiveEvidence,developmentEvidence,selectionFrozenCommit}={}){
  if(!/^[a-f0-9]{64}$/.test(TOTALS_V6_FROZEN_SELECTION_HASH)
    ||totalsV6Hash(selection)!==TOTALS_V6_FROZEN_SELECTION_HASH
    ||totalsV6Hash(createTotalsV6Selection(developmentEvidence))!==TOTALS_V6_FROZEN_SELECTION_HASH
    ||totalsV6Hash(developmentEvidence)!==selection.developmentReportHash
    ||selection.protocolHash!==TOTALS_V6_PROTOCOL_HASH)throw Error('NBA_TOTALS_V6_FROZEN_SELECTION_INVALID');
  if(!/^[a-f0-9]{40}$/.test(selectionFrozenCommit||''))throw Error('NBA_TOTALS_V6_FREEZE_COMMIT_REQUIRED');
  const sourceAudit=auditOpeningV6IndependentArchive(history,archiveEvidence);
  if(!sourceAudit.every(r=>r.verified))throw Error('NBA_TOTALS_V6_INDEPENDENT_SOURCE_UNVERIFIED');
  if(history.some(r=>!TOTALS_V6_PROTOCOL.independentTrainingYears.includes(r.year)&&r.year!==2011))throw Error('NBA_TOTALS_V6_INDEPENDENT_YEAR_SCOPE_INVALID');
  const targets={};
  for(const target of ['fullTotal','halfTotal']){
    const candidate=selection.selected[target].candidate,observations=buildTotalsV6Observations(history,target);
    const rows=observations.filter(r=>r.year===2011),baseline=buildOpeningResearchBaselineObservations(history,target);
    const probabilities=rows.flatMap(r=>totalsV6Probability(r,observations,target,baseline)||[]);
    if(rows.some(r=>r.candidateId!==candidate.candidateId)||probabilities.length!==rows.length)throw Error('NBA_TOTALS_V6_INDEPENDENT_COHORT_INCOMPLETE');
    const metrics=totalsV6Metrics(rows,probabilities),readiness=openingResearchReadiness(metrics);
    targets[target]={candidate,metrics,passed:readiness.readyForIndependentValidation,reasons:readiness.reasons};
  }
  return {version:'nba-opening-v6-independent-evaluation-v1',modelVersion:TOTALS_V6_PROTOCOL.version,
    protocolHash:TOTALS_V6_PROTOCOL_HASH,selectionHash:TOTALS_V6_FROZEN_SELECTION_HASH,selectionFrozenCommit,
    developmentReportHash:selection.developmentReportHash,sourceHistoryHash:totalsV6Hash(history),
    reviewedArchiveSha256:OPENING_V6_INDEPENDENT_REVIEWED_ARCHIVE_SHA256,holdoutYear:2011,
    role:'EARLIER_ERA_EXTERNAL_RETROSPECTIVE_NOT_PROSPECTIVE_OOS',sourceAudit,targets,
    status:Object.values(targets).every(r=>r.passed)?'HOLDOUT_PASSED_REQUIRES_CURRENT_REGRESSION_AND_INTEGRATION_REVIEW':'BLOCKED_HOLDOUT_FAILED',
    holdoutConsumed:true,reselectionAllowed:false,executable:false,promotionEligible:false,
    limitations:['Earlier-era validation is independent of viewed development outcomes but is not prospective OOS.',
      'Early point forecast uses the benchmark exactly; equality is by construction, not evidence of superior early point prediction.',
      'Historical final-score sources do not certify contemporaneous pregame availability.',
      'Reference-threshold losses do not establish betting win rates or profit.']};
}
