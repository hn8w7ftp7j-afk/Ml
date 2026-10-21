import {auditOpeningIndependentArchive,OPENING_INDEPENDENT_REVIEWED_ARCHIVE_SHA256} from './opening-independent-evidence.js';
import {TOTALS_V5_PROTOCOL,TOTALS_V5_PROTOCOL_HASH,totalsV5Hash,createTotalsV5Selection,
  buildTotalsV5Observations,totalsV5Probability,totalsV5Metrics} from './opening-research-v5.js';
import {buildOpeningResearchBaselineObservations,openingResearchReadiness} from './opening-research.js';

// Filled from development evidence only, before the first real 2017 evaluation.
export const TOTALS_V5_FROZEN_SELECTION_HASH='00ce57501c9da5c2e4ced47571a7437c8a577c9074172139a3f85f27a5ba8269';
export function evaluateTotalsV5Independent(history,selection,{archiveEvidence,developmentEvidence,selectionFrozenCommit}={}){
  if(!/^[a-f0-9]{64}$/.test(TOTALS_V5_FROZEN_SELECTION_HASH)
    ||totalsV5Hash(selection)!==TOTALS_V5_FROZEN_SELECTION_HASH
    ||totalsV5Hash(createTotalsV5Selection(developmentEvidence))!==TOTALS_V5_FROZEN_SELECTION_HASH
    ||totalsV5Hash(developmentEvidence)!==selection.developmentReportHash
    ||selection.protocolHash!==TOTALS_V5_PROTOCOL_HASH)throw Error('NBA_TOTALS_V5_FROZEN_SELECTION_INVALID');
  if(!/^[a-f0-9]{40}$/.test(selectionFrozenCommit||''))throw Error('NBA_TOTALS_V5_FREEZE_COMMIT_REQUIRED');
  const sourceAudit=auditOpeningIndependentArchive(history,archiveEvidence);
  if(!sourceAudit.every(r=>r.verified))throw Error('NBA_TOTALS_V5_INDEPENDENT_SOURCE_UNVERIFIED');
  if(history.some(r=>!TOTALS_V5_PROTOCOL.independentTrainingYears.includes(r.year)&&r.year!==2017))throw Error('NBA_TOTALS_V5_INDEPENDENT_YEAR_SCOPE_INVALID');
  const targets={};
  for(const target of ['fullTotal','halfTotal']){
    const candidate=selection.selected[target].candidate,observations=buildTotalsV5Observations(history,target);
    const rows=observations.filter(r=>r.year===2017),baseline=buildOpeningResearchBaselineObservations(history,target);
    const probabilities=rows.flatMap(r=>totalsV5Probability(r,observations,target,baseline)||[]);
    if(rows.some(r=>r.candidateId!==candidate.candidateId)||probabilities.length!==rows.length)throw Error('NBA_TOTALS_V5_INDEPENDENT_COHORT_INCOMPLETE');
    const metrics=totalsV5Metrics(rows,probabilities),readiness=openingResearchReadiness(metrics);
    targets[target]={candidate,metrics,passed:readiness.readyForIndependentValidation,reasons:readiness.reasons};
  }
  return {version:'nba-opening-v5-independent-evaluation-v1',modelVersion:TOTALS_V5_PROTOCOL.version,
    protocolHash:TOTALS_V5_PROTOCOL_HASH,selectionHash:TOTALS_V5_FROZEN_SELECTION_HASH,selectionFrozenCommit,
    developmentReportHash:selection.developmentReportHash,sourceHistoryHash:totalsV5Hash(history),
    reviewedArchiveSha256:OPENING_INDEPENDENT_REVIEWED_ARCHIVE_SHA256,holdoutYear:2017,
    role:'EARLIER_ERA_EXTERNAL_RETROSPECTIVE_NOT_PROSPECTIVE_OOS',sourceAudit,targets,
    status:Object.values(targets).every(r=>r.passed)?'HOLDOUT_PASSED_REQUIRES_CURRENT_REGRESSION_AND_INTEGRATION_REVIEW':'BLOCKED_HOLDOUT_FAILED',
    holdoutConsumed:true,reselectionAllowed:false,executable:false,promotionEligible:false,
    limitations:['Earlier-era validation is independent of viewed development outcomes but is not prospective OOS.',
      'Historical final-score sources do not certify contemporaneous pregame availability.',
      'Reference-threshold losses do not establish betting win rates or profit.']};
}
