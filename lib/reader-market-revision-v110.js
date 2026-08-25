import { createHash } from 'node:crypto';

export const READER_GAME_MARKET_REVISION_V110_VERSION = 'TAI888-READER-GAME-MARKET-CONTENT-SHA256-v11.0.0';

function canonicalRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    market: String(row?.market || '').trim(),
    pick: String(row?.pick || '').replace(/\s+/g, '').trim(),
    water: Number.isFinite(Number(row?.water)) ? Number(row.water).toFixed(6) : '',
    waterEstimated: row?.waterEstimated === true,
  })).filter(row => row.market && row.pick && row.water)
    .sort((left, right) => `${left.market}\u0000${left.pick}`.localeCompare(`${right.market}\u0000${right.pick}`));
}

export function readerGameMarketContentHash(rows) {
  const canonical = canonicalRows(rows);
  if (!canonical.length) return null;
  return createHash('sha256')
    .update(JSON.stringify({ domain: 'tai888-reader/game-market-content/v1', markets: canonical }))
    .digest('hex');
}
