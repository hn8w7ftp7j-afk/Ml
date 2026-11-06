// Server-only settlement admission. An explicit ledger marker is descriptive;
// only reloading its immutable original analysis can create this process proof.
import { createHash } from 'node:crypto';
import { soccerReaderIdentityVerified } from './reader-identity-proof.js';
import { soccerManualRecordFromSnapshot } from './manual-record.js';
import { soccerOriginalContract } from './manual-settlement.js';

const verified = new WeakMap();
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
const eligibleMarker = record => record?.sourceIdentityStatus === 'PROVIDER_SCOPED_UNIQUE_MATCH'
  && record.sourceIdentityEvidence?.version === 'SOCCER-PROVIDER-SCOPED-IDENTITY-v1'
  && /^[a-f0-9]{64}$/.test(record.sourceIdentityEvidence?.contentHash || '')
  && /^[a-f0-9]{64}$/.test(record.analysisRevision || '');

export async function verifySoccerManualSettlementIdentity(record, loadRevision) {
  if (!eligibleMarker(record) || typeof loadRevision !== 'function') return record;
  try {
    const snapshot = await loadRevision(record.league, record.gameId, record.date, record.analysisRevision);
    if (snapshot?.persisted !== true || snapshot.revision !== record.analysisRevision || !soccerReaderIdentityVerified(snapshot)
      || snapshot.readerIdentityEvidence?.contentHash !== record.sourceIdentityEvidence.contentHash
      || snapshot.readerIdentityEvidence?.version !== record.sourceIdentityEvidence.version) return record;
    const original = soccerManualRecordFromSnapshot(snapshot, record.quoteKey);
    if (canonical(soccerOriginalContract(original)) !== canonical(soccerOriginalContract(record))
      || canonical(original.sourceQuote) !== canonical(record.sourceQuote)) return record;
    const checked = { ...record };
    verified.set(checked, fingerprint(checked));
    return checked;
  } catch { return record; }
}

export function soccerManualSettlementIdentityVerified(record) {
  try { return Boolean(eligibleMarker(record) && verified.get(record) === fingerprint(record)); }
  catch { return false; }
}
