import { createHash } from 'node:crypto';
import { MARKET_ORDER } from './markets.js';

export const READER_GAME_MARKET_REVISION_V110_VERSION = 'TAI888-READER-GAME-MARKET-CONTENT-SHA256-v11.1.0';

function canonicalRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    market: String(row?.market || '').trim(),
    pick: String(row?.pick || '').replace(/\s+/g, '').trim(),
    water: row?.water != null && row.water !== '' && Number.isFinite(Number(row.water))
      ? Number(row.water).toFixed(6)
      : '',
    waterEstimated: row?.waterEstimated === true,
    integrityError: String(row?.integrityError || '').trim(),
  })).filter(row => row.market && ((row.pick && row.water) || row.integrityError))
    .sort((left, right) => `${left.market}\u0000${left.pick}\u0000${left.integrityError}`.localeCompare(`${right.market}\u0000${right.pick}\u0000${right.integrityError}`));
}

export function readerGameMarketContentHash(rows) {
  const canonical = canonicalRows(rows);
  if (!canonical.length) return null;
  return createHash('sha256')
    .update(JSON.stringify({ domain: 'tai888-reader/game-market-content/v2', markets: canonical }))
    .digest('hex');
}

export function readerCoverageIntegrityRows(row, lineAsOf) {
  const available = new Set(Array.isArray(row?.marketCoverage?.availableMarkets)
    ? row.marketCoverage.availableMarkets
    : []);
  return (Array.isArray(row?.marketCoverage?.blockedMarkets) ? row.marketCoverage.blockedMarkets : [])
    .filter(market => MARKET_ORDER.includes(market) && !available.has(market))
    .map(market => ({
      market,
      pick: '',
      water: null,
      waterEstimated: false,
      waterMissing: true,
      confidence: 1,
      sourceType: 'ACTUAL_TW_CREDIT',
      sourceLabel: 'Tai888 Reader 自動信用盤',
      provider: 'TAI888_READER_AUTO',
      lineAsOf,
      executable: false,
      marketVerification: null,
      rawText: '',
      referenceSide: '',
      sourceTemplateVersion: 'TAI888-DOM-COVERAGE-BLOCK-v1.0.0',
      authorizationStatus: 'SERVER_ATTESTED_READER_COVERAGE_BLOCK',
      integrityOrigin: 'SERVER_SIGNED_READER_COVERAGE',
      integrityError: `Reader coverage BLOCKED：${market}盤口欄位不完整、重複或無法辨識，禁止當成尚未開盤`,
    }));
}

export function readerGameEvidenceRows(row, lineAsOf) {
  return [
    ...(Array.isArray(row?.markets) ? row.markets : []),
    ...readerCoverageIntegrityRows(row, lineAsOf),
  ];
}

export function readerGameEvidenceContentHash(row, lineAsOf) {
  return readerGameMarketContentHash(readerGameEvidenceRows(row, lineAsOf));
}

export function readerUnopenedGameMarketContentHash({ league, game, readerSnapshot } = {}) {
  const scheduledStartMs = Date.parse(game?.gameDate || '');
  const identity = {
    league: String(league || game?.league || game?.leagueId || '').trim().toUpperCase(),
    gamePk: Number(game?.gamePk) || null,
    awayTeamId: Number(game?.awayTeamId) || null,
    homeTeamId: Number(game?.homeTeamId) || null,
    gameNumber: Math.max(1, Number(game?.gameNumber) || 1),
    scheduledStart: Number.isFinite(scheduledStartMs) ? new Date(scheduledStartMs).toISOString() : '',
  };
  return createHash('sha256').update(JSON.stringify({
    domain: 'tai888-reader/game-market-content/unopened/v1',
    status: 'UNOPENED',
    game: identity,
    reader: {
      boardDate: String(readerSnapshot?.boardDate || ''),
      payloadHash: String(readerSnapshot?.payloadHash || '').toLowerCase(),
      rawBoardHash: String(readerSnapshot?.rawBoardHash || '').toLowerCase(),
      readerVersion: String(readerSnapshot?.readerVersion || ''),
    },
  })).digest('hex');
}
