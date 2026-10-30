import { soccerManualRecordFromSnapshot } from './manual-record.js';
import { soccerOriginalContract, soccerManualContractHash, settleSoccerManualRecord } from './manual-settlement.js';
import { loadSoccerAnalysisRevision } from './analysis-store.js';
import { fetchSoccerSettlementResult } from './settlement-result.js';
import { soccerVerifiedSettlementContract, soccerSettlementMissingTerms } from './settlement-contract.js';
import { listUnsettledSoccerManualRecords, archiveSoccerSettlementCheck } from './manual-record-store.js';

export async function hydrateSoccerSettlementIdentity(record, loadRevision = loadSoccerAnalysisRevision) {
  if (record.teamIds?.home && record.teamIds?.away) return record;
  try {
    const snapshot = await loadRevision(record.league, record.gameId, record.date, record.analysisRevision);
    const original = soccerManualRecordFromSnapshot(snapshot, record.quoteKey);
    // Names are display labels; only the archived provider identities qualify.
    const keys = Object.keys(soccerOriginalContract(record)).filter(key => key !== 'teamIds');
    if (!original.teamIds || keys.some(key => JSON.stringify(original[key] ?? null) !== JSON.stringify(record[key] ?? null))) return record;
    return { ...record, identityEvidence: { source: 'IMMUTABLE_ANALYSIS_REVISION', analysisRevision: record.analysisRevision, teamIds: original.teamIds } };
  } catch { return record; }
}

export async function settleOpenSoccerManualRecords({ league = null, date = null, limit = 100, timeBudgetMs = 15000,
  now = Date.now, list = listUnsettledSoccerManualRecords, load = fetchSoccerSettlementResult,
  archive = archiveSoccerSettlementCheck, resolveContract = soccerVerifiedSettlementContract,
  hydrate = hydrateSoccerSettlementIdentity } = {}) {
  const started = now(), deadline = started + timeBudgetMs;
  const records = await list({ league, date, limit });
  const summary = { checked: 0, resultVerified: 0, settled: 0, pending: 0, deferred: 0, reasons: {}, missingTerms: soccerSettlementMissingTerms(started),
    contractApproval: 'SOURCE_TERMS_UNVERIFIED', persistence: 'durable_database' };
  const groups = new Map();
  for (const original of records) {
    if (now() >= deadline) { summary.deferred++; continue; }
    const record = await hydrate(original);
    const key = JSON.stringify([record.league, record.gameId, record.date, record.startTime]);
    groups.set(key, [...(groups.get(key) || []), record]);
  }
  for (const group of groups.values()) {
    if (now() >= deadline) { summary.deferred += group.length; continue; }
    const identities=group.map(r=>r.teamIds||r.identityEvidence?.teamIds).filter(ids=>ids?.home&&ids?.away&&ids.home!==ids.away);
    const conflictingIdentities=new Set(identities.map(ids=>JSON.stringify([ids.home,ids.away]))).size>1;
    const reference=group.find(r=>{const ids=r.teamIds||r.identityEvidence?.teamIds;return ids?.home&&ids?.away&&ids.home!==ids.away;})||group[0];
    let result;
    if (Date.parse(group[0].startTime) > now()) result = { ok: false, reason: 'RESULT_NOT_STARTED' };
    else if(conflictingIdentities)result={ok:false,reason:'ORIGINAL_RECORD_TEAM_IDENTITY_CONFLICT'};
    else try { result = await load(reference, { now, timeoutMs: Math.min(6000, Math.max(1, deadline - now())) }); }
    catch { result = { ok: false, reason: 'RESULT_SOURCE_UNAVAILABLE' }; }
    for (const record of group) {
      summary.checked++;
      const ids=record.teamIds||record.identityEvidence?.teamIds;
      const verifiedForRecord=result?.ok===true&&result.verified===true&&result.gameId===record.gameId&&result.league===record.league
        &&result.date===record.date&&result.startTime===record.startTime&&['home','away'].every(side=>result.teamIds?.[side]===ids?.[side]);
      const check = { ...settleSoccerManualRecord(record, result, resolveContract(record), now()),
        contractHash: soccerManualContractHash(record), ...(verifiedForRecord?{resultEvidence:result,resultHash:result.resultHash}:{}),
        ...(record.identityEvidence ? { identityEvidence: record.identityEvidence } : {}) };
      if (check.resultEvidence?.verified === true) summary.resultVerified++;
      let receipt;
      try { receipt = await archive(record, check, { now: now() }); }
      catch { summary.pending++; summary.reasons.SETTLEMENT_EVIDENCE_PERSISTENCE_FAILED = (summary.reasons.SETTLEMENT_EVIDENCE_PERSISTENCE_FAILED || 0) + 1; continue; }
      if (receipt.check?.status === 'SETTLED') summary.settled++;
      else { summary.pending++; const reason = receipt.check ? check.reason : 'RECORD_CHANGED'; summary.reasons[reason] = (summary.reasons[reason] || 0) + 1; }
    }
  }
  return summary;
}
