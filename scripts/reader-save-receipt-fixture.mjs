import { createHash } from 'node:crypto';

// Synthetic responses matching the existing endpoint persistence contracts.
export function readerSaveReceiptFixture(payload, extra = {}) {
  const common = { ok: true, league: payload.league, rawGameCount: payload.games.length };
  if (['MLB', 'NPB', 'KBO', 'CPBL', 'NBA'].includes(payload.league)) return {
    ...common, boardDate: payload.boardDate, allRequiredWritesSucceeded: true,
    historyTracking: { configured: true, checked: payload.games.length,
      inserted: payload.games.length, unchanged: 0, failed: 0 }, ...extra,
  };
  const revision = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { ...common, persisted: true, revision, observedAt: payload.observedAt,
    ...(payload.league === 'NHL' ? {} : { observationId: revision, firstFetchedAt: payload.observedAt,
      receivedAt: payload.observedAt, timeEvidence: 'SERVER_RECEIPT_RECORDED' }), ...extra };
}
