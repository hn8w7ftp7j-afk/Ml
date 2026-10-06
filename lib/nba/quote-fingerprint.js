import { createHash } from 'node:crypto';
const keys = ['fullTotal', 'fullRunline', 'firstHalfTotal', 'firstHalfRunline'];
// Bind one event's contract, independent of heartbeat timestamps and other games.
export function nbaQuoteFingerprint(row) {
  if (!row) return null;
  const markets = keys.map(key => {
    const q = row[key];
    return [key, row.marketStates?.[key] ?? (q ? 'AVAILABLE' : 'UNAVAILABLE'), q ?
      key.endsWith('Total') ? [q.line, q.overWater, q.underWater] : [q.line, q.lineSide, q.homeWater, q.awayWater] : null];
  });
  return createHash('sha256').update(JSON.stringify([row.captureKey, row.boardDate, row.boardTime,
    row.away?.id, row.home?.id, row.marketStatus, markets])).digest('hex');
}
