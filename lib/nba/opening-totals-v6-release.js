import {createOpeningTotalsV6Runtime} from './opening-totals-v6-runtime.js';
import {OPENING_V6_INDEPENDENT_REVIEWED_ARCHIVE_SHA256} from './opening-v6-independent-evidence.js';
import {openingTotalsV6Independent,openingTotalsV6Development,
  openingTotalsV6IndependentHash,openingTotalsV6DevelopmentHash} from './opening-totals-v6-evidence.js';

const analyze=createOpeningTotalsV6Runtime({validationManifest:openingTotalsV6Independent,
  validationPins:{expectedSha256:openingTotalsV6IndependentHash,
    expectedArchiveSha256:OPENING_V6_INDEPENDENT_REVIEWED_ARCHIVE_SHA256,
    expectedSourceHistoryHash:openingTotalsV6Independent.sourceHistoryHash},
  regressionManifest:openingTotalsV6Development,expectedRegressionSha256:openingTotalsV6DevelopmentHash});
const releaseEvidence=Object.freeze({validationManifestHash:openingTotalsV6IndependentHash,
  developmentReportHash:openingTotalsV6DevelopmentHash,
  selectionFrozenCommit:openingTotalsV6Independent.selectionFrozenCommit,holdoutYear:2011,
  role:openingTotalsV6Independent.role,modelVersion:openingTotalsV6Independent.modelVersion,
  protocolHash:openingTotalsV6Independent.protocolHash,targets:openingTotalsV6Independent.targets});
export const analyzeNbaOpeningTotalsV6Released=(...args)=>({...analyze(...args),releaseEvidence});
export const NBA_TOTALS_V6_RELEASE_VALIDATION=Object.freeze({year:2011,
  role:'EARLIER_ERA_EXTERNAL_RETROSPECTIVE_NOT_PROSPECTIVE_OOS',
  selectionFrozenCommit:openingTotalsV6Independent.selectionFrozenCommit,
  manifestHash:openingTotalsV6IndependentHash,developmentHash:openingTotalsV6DevelopmentHash,
  protocolHash:openingTotalsV6Independent.protocolHash,executable:false,promotionEligible:false});
