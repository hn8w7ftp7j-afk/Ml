import { continueSoccerForwardScan } from './forward-validation-scan.js';
import { buildSoccerReturnErrorDatasetHydrated, fitSoccerReturnErrorResearch } from './return-error-model.js';
import { soccerDate } from './contracts.js';
import { freezeSoccerReturnErrorParameters, loadSoccerReturnErrorFreezeVerifier,
  loadSoccerReturnErrorProtocol, soccerReturnErrorDatabaseNow } from './return-error-validation-store.js';

// The registered league and full calendar-date scope are recovered from the
// immutable store. No HTTP body can choose observations or supply an artifact.
export async function runSoccerReturnErrorValidation({ protocolId, operation = 'evaluate' } = {}, overrides = {}) {
  if (!['freeze','evaluate'].includes(operation)) throw Error('RETURN_ERROR_VALIDATION_OPERATION_INVALID');
  const deps = { scan: continueSoccerForwardScan, buildDataset: buildSoccerReturnErrorDatasetHydrated,
    fit: fitSoccerReturnErrorResearch, loadProtocol: loadSoccerReturnErrorProtocol,
    loadVerifier: loadSoccerReturnErrorFreezeVerifier, freeze: freezeSoccerReturnErrorParameters,
    databaseNow: soccerReturnErrorDatabaseNow, maxDatasetBytes: 64*1024*1024, ...overrides };
  if(!Number.isSafeInteger(deps.maxDatasetBytes)||deps.maxDatasetBytes<1||deps.maxDatasetBytes>64*1024*1024)
    throw Error('RETURN_ERROR_VALIDATION_DATASET_BUDGET_INVALID');
  const receipt = await deps.loadProtocol(protocolId), protocol = receipt.protocol, now = await deps.databaseNow();
  if (operation === 'freeze' && (now < Date.parse(protocol.calibrationBefore) || now >= Date.parse(protocol.testBefore)))
    throw Error('RETURN_ERROR_FREEZE_WINDOW_INVALID');
  const through = soccerDate((operation === 'freeze' ? Date.parse(protocol.calibrationBefore)
    : Math.min(now,Date.parse(protocol.testBefore)))-1);
  if (through < protocol.from) throw Error('RETURN_ERROR_VALIDATION_WINDOW_NOT_STARTED');
  const datasets = []; let retainedDatasetBytes=0;
  let cursor = null, processed = -1, result;
  do {
    result = await deps.scan({ league: receipt.league, from: protocol.from, through }, {
      cursor, purpose: 'read', onGameEvidence: async (evidence,context) => {
        const dataset=await deps.buildDataset(evidence,{ ...context, now: Math.min(context.now,now) });
        retainedDatasetBytes+=Buffer.byteLength(JSON.stringify(dataset));
        if(retainedDatasetBytes>deps.maxDatasetBytes)throw Error('RETURN_ERROR_VALIDATION_DATASET_MEMORY_BUDGET');
        datasets.push(dataset);
      },
    });
    cursor = result.report.scan.nextCursor;
    if (cursor && result.report.scan.processedGames <= processed) throw Error('RETURN_ERROR_VALIDATION_SCAN_DID_NOT_ADVANCE');
    processed = result.report.scan.processedGames;
  } while (cursor);
  const authority = await deps.loadVerifier(protocolId);
  const artifact = deps.fit({ datasets, protocol, now, requestedScopeComplete: result.report.complete === true,
    verifyFrozenModelReceipt: authority.verifyFrozenModelReceipt });
  const saved = operation === 'freeze' ? await deps.freeze(protocolId,artifact) : null;
  return { artifact, protocolReceipt: receipt, freezes: saved?.freezes || authority.freezes,
    sourceScope: { league: receipt.league, from: protocol.from, through },
    interpretation: 'PROSPECTIVE_RESEARCH_EXISTENCE_AND_TIME_PROOF_NOT_FORMAL_R_OR_MODEL_ACCEPTANCE',
    accepted: false, formalEligible: false, executable: false };
}
