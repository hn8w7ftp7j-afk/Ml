import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from './database-url.js';
import { analysisPitRecordFromDatabaseRow, buildAnalysisPitReplayBundle } from './analysis-pit-snapshot-store-v1.js';
import { hydrateAsianSourceEvidence } from './asian-source-store-v1.js';

export function parseHistorySnapshotIds(value) {
  const ids = String(value || '').split(',');
  if (!ids.length || ids.length > 8 || new Set(ids).size !== ids.length) throw new Error('INVALID_SNAPSHOT_BATCH');
  return ids.map(snapshotId => {
    const match = /^(MLB|NPB|KBO|CPBL):([1-9]\d{0,15}):(FULL|PRICE_ONLY_REPRICE):[a-f0-9]{64}$/.exec(snapshotId);
    if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error('INVALID_SNAPSHOT_ID');
    return { snapshotId, league: match[1], gamePk: Number(match[2]) };
  });
}

// Export the exact stored envelopes and a validated decoded bundle. This path
// does not call ensureSchema or any analysis/ledger/persistence write function.
export async function exportHistorySnapshot(scope) {
  const url = durableDatabaseUrl();
  if (!url) throw new Error('DATABASE_NOT_CONFIGURED');
  const sql = neon(url);
  async function read(id) {
    const rows = await sql`SELECT * FROM baseball_analysis_pit_snapshots WHERE snapshot_id=${id} AND league_id=${scope.league} LIMIT 1`;
    if (rows.length !== 1) throw new Error('SNAPSHOT_NOT_FOUND');
    return analysisPitRecordFromDatabaseRow(rows[0]);
  }
  const record = await read(scope.snapshotId), parents = [], seen = new Set([record.snapshotId]);
  let cursor = record;
  while (cursor.analysisType === 'PRICE_ONLY_REPRICE') {
    if (seen.has(cursor.parentSnapshotId) || parents.length >= 100) throw new Error('INVALID_PARENT_CHAIN');
    cursor = await read(cursor.parentSnapshotId); seen.add(cursor.snapshotId); parents.push(cursor);
  }
  const bundle = buildAnalysisPitReplayBundle(record, { parentRecords: parents, expected: { leagueId: scope.league, gamePk: scope.gamePk } });
  let hydratedContext = bundle.frozenContext, hydrationStatus = 'INLINE';
  try { hydratedContext = await hydrateAsianSourceEvidence(bundle.frozenContext); hydrationStatus = 'READ_COMPLETE'; }
  catch { hydrationStatus = 'SOURCE_CONTENT_UNAVAILABLE'; }
  return { record, parentRecords: parents, bundle, hydratedContext, hydrationStatus, integrityVerified: true, productionWrites: false };
}
