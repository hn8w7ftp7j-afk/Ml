import { assessCoreSnapshotFreshnessV109 } from './analysis-refresh-policy-v109.js';
import { applyMarketFreshness } from './market-freshness-v1.js';

export const ANALYSIS_RESPONSE_CACHE_TTL_MS = 30 * 1000;
export const ANALYSIS_IDEMPOTENCY_CACHE_TTL_MS = 15 * 1000;

const finiteTime = value => {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : null;
};

function cachedActualRows(payload) {
  return (Array.isArray(payload?.analysis?.results) ? payload.analysis.results : [])
    .filter(row => row?.sourceType === 'ACTUAL_TW_CREDIT');
}

export function assessAnalysisCacheEntryV110(entry, {
  league,
  gamePk,
  now = Date.now(),
  maxAgeMs = ANALYSIS_RESPONSE_CACHE_TTL_MS,
} = {}) {
  const reasons = [];
  const payload = entry?.payload;
  const cachedAt = Number(entry?.cachedAt);
  const ageMs = Number.isFinite(cachedAt) ? now - cachedAt : null;
  const expectedLeague = String(league || '').trim().toUpperCase();
  const payloadLeague = String(payload?.league || payload?.game?.league || payload?.game?.leagueId || '').trim().toUpperCase();
  const payloadGamePk = Number(payload?.game?.gamePk);
  const gameStart = finiteTime(payload?.game?.gameDate || payload?.context?.game?.gameDate);

  if (!payload) reasons.push('CACHE_PAYLOAD_MISSING');
  if (ageMs == null || ageMs < -5_000 || ageMs > maxAgeMs) reasons.push('CACHE_TTL_EXPIRED');
  if (!expectedLeague || payloadLeague !== expectedLeague) reasons.push('CACHE_LEAGUE_MISMATCH');
  if (!Number.isSafeInteger(Number(gamePk)) || payloadGamePk !== Number(gamePk)) reasons.push('CACHE_GAME_MISMATCH');
  if (gameStart == null || now >= gameStart) reasons.push('GAME_ALREADY_STARTED');

  const coreFreshness = payload?.context
    ? assessCoreSnapshotFreshnessV109(payload.context, now)
    : { fresh: false, reasons: ['CORE_CONTEXT_MISSING'] };
  if (coreFreshness.fresh !== true) reasons.push(...coreFreshness.reasons);

  const actualRows = cachedActualRows(payload);
  if (actualRows.some(row => applyMarketFreshness(row, now).lineFresh !== true)) {
    reasons.push('ACTUAL_LINE_TTL_EXPIRED');
  }

  return {
    fresh: reasons.length === 0,
    reasons: [...new Set(reasons)],
    ageMs,
    coreFreshness,
    actualLineCount: actualRows.length,
  };
}
