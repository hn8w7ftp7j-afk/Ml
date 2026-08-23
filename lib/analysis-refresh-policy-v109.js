export const ANALYSIS_REFRESH_POLICY_V109_VERSION = 'BASEBALL-EVENT-AWARE-CORE-REFRESH-2026-08-v10.9.0';

const finiteTime = value => {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : null;
};

function minutesUntilGame(context, now) {
  const start = finiteTime(context?.game?.gameDate);
  return start == null ? null : (start - now) / 60_000;
}

function contextQuality(context = {}) {
  const lineupConfirmed = context?.away?.lineup?.official === true && context?.home?.lineup?.official === true;
  const bullpenConfirmed = context?.away?.bullpen?.status === 'CONFIRMED' && context?.home?.bullpen?.status === 'CONFIRMED';
  const umpireConfirmed = String(context?.umpire?.status || '').toUpperCase() === 'CONFIRMED';
  const roofConfirmed = context?.weather?.roofConfirmed === true
    || ['dome', 'open'].includes(String(context?.park?.roof || context?.weather?.roof || '').toLowerCase());
  return { lineupConfirmed, bullpenConfirmed, umpireConfirmed, roofConfirmed };
}

export function coreRefreshTtlMsV109(context = {}, now = Date.now()) {
  const minutes = minutesUntilGame(context, now);
  const quality = contextQuality(context);
  if (minutes == null) return 5 * 60_000;
  if (minutes <= 0) return 0;
  if (minutes <= 20) return quality.lineupConfirmed && quality.bullpenConfirmed ? 2 * 60_000 : 60_000;
  if (minutes <= 60) return quality.lineupConfirmed ? 4 * 60_000 : 2 * 60_000;
  if (minutes <= 180) return 10 * 60_000;
  if (minutes <= 360) return 20 * 60_000;
  return 45 * 60_000;
}

export function assessCoreSnapshotFreshnessV109(context = {}, now = Date.now()) {
  const fetchedAt = finiteTime(context?.fetchedAt);
  const gameStart = finiteTime(context?.game?.gameDate);
  const ttlMs = coreRefreshTtlMsV109(context, now);
  const ageMs = fetchedAt == null ? null : Math.max(0, now - fetchedAt);
  const quality = contextQuality(context);
  const reasons = [];
  if (fetchedAt == null) reasons.push('CORE_FETCH_TIME_MISSING');
  if (gameStart != null && now >= gameStart) reasons.push('GAME_ALREADY_STARTED');
  if (ageMs != null && ageMs > ttlMs) reasons.push('CORE_SNAPSHOT_TTL_EXPIRED');
  const advisories = [];
  if (gameStart != null && gameStart - now <= 60 * 60_000 && !quality.lineupConfirmed) advisories.push('PREGAME_LINEUP_RECHECK_REQUIRED');
  return {
    version: ANALYSIS_REFRESH_POLICY_V109_VERSION,
    fresh: reasons.length === 0,
    reasons,
    advisories,
    fetchedAt: fetchedAt == null ? null : new Date(fetchedAt).toISOString(),
    checkedAt: new Date(now).toISOString(),
    ageMs,
    ttlMs,
    minutesUntilGame: gameStart == null ? null : (gameStart - now) / 60_000,
    quality,
  };
}
