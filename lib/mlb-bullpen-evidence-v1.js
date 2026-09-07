import { normalizePitchingV11, scopedStatSplitsV11 } from './mlb-context-v11.js';

export const BULLPEN_EVIDENCE_VERSION = 'MLB-RELIEF-SCOPE-USAGE-COVERAGE-v1';
const number = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) ? Number(value) : null;
const count = value => Number.isSafeInteger(number(value)) && number(value) >= 0 ? number(value) : null;
const outs = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const match = String(value).match(/^(\d+)(?:\.([012]))?$/);
  return match ? Number(match[1]) * 3 + Number(match[2] || 0) : null;
};

// Aggregate counts and outs, never average ERA/WHIP or mix starter appearances.
export function reliefOnlyGameLog(payload, { playerId, endDate } = {}) {
  const missing = reason => ({ available: false, status: 'MISSING', inningsPitched: null, gamesStarted: null, gamesPitched: null,
    ...Object.fromEntries(['earnedRuns', 'hits', 'baseOnBalls', 'strikeOuts', 'homeRuns', 'era', 'whip', 'kPer9', 'bbPer9', 'hrPer9', 'saves', 'holds'].map(key => [key, null])),
    source: 'MLB_PERSON_GAME_LOG_RELIEF_ONLY', scope: 'RELIEF_ONLY', reason });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(endDate))) return missing('CUTOFF_MISSING');
  const rows = scopedStatSplitsV11(payload, { group: 'pitching', playerId, season: endDate.slice(0, 4) });
  const games = new Map();
  for (const row of rows) {
    if (row.gameType && row.gameType !== 'R') continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.date))) return missing('GAME_DATE_MISSING');
    if (row.date < `${endDate.slice(0, 4)}-03-01` || row.date > endDate) continue;
    if (![0, 1].includes(count(row.stat?.gamesStarted))) return missing('APPEARANCE_ROLE_MISSING');
    if (count(row.stat.gamesStarted) === 1) continue;
    const id = count(row.game?.gamePk);
    if (!id) return missing('GAME_ID_MISSING');
    if (games.has(id) && JSON.stringify(games.get(id).stat) !== JSON.stringify(row.stat)) return missing('CONFLICTING_GAME_LOG');
    games.set(id, row);
  }
  const relief = [...games.values()];
  if (!relief.length) return missing('NO_MLB_RELIEF_SAMPLE');
  if (relief.some(row => outs(row.stat?.inningsPitched) == null)) return missing('RELIEF_OUTS_MISSING');
  const totalOuts = relief.reduce((sum, row) => sum + outs(row.stat.inningsPitched), 0);
  const sums = Object.fromEntries(['earnedRuns', 'hits', 'baseOnBalls', 'strikeOuts', 'homeRuns', 'saves', 'holds'].map(key => [key,
    relief.every(row => count(row.stat[key]) != null) ? relief.reduce((sum, row) => sum + count(row.stat[key]), 0) : null]));
  const stats = normalizePitchingV11({ ...sums, inningsPitched: `${Math.floor(totalOuts / 3)}.${totalOuts % 3}`, gamesStarted: 0, gamesPitched: relief.length });
  return { ...stats, saves: sums.saves, holds: sums.holds, scope: 'RELIEF_ONLY', source: 'MLB_PERSON_GAME_LOG_RELIEF_ONLY',
    sourceGameIds: [...games.keys()], asOf: endDate, reason: stats.available ? null : 'NO_USABLE_MLB_RELIEF_SAMPLE' };
}

export function reliefMetricBlock(row) {
  if (row.reliefMetrics) return { ...row.reliefMetrics, metricSource: 'MLB_PERSON_GAME_LOG_RELIEF_ONLY', metricScope: 'RELIEF_ONLY', metricAsOf: row.reliefMetrics.asOf || null };
  if (number(row.gamesStarted) === 0 && number(row.gamesPitched) > 0) return { metricScope: 'SEASON_WITH_ZERO_STARTS' };
  return { ...reliefOnlyGameLog(null, {}), metricSource: 'MISSING', metricScope: 'RELIEF_SCOPE_UNVERIFIED' };
}

export function bullpenUsageCoverage({ recentFeeds = [], expectedRecentGames, teamId, gameDate }) {
  const target = Date.parse(gameDate);
  const expected = Array.isArray(expectedRecentGames) ? expectedRecentGames : recentFeeds.map((feed, index) => ({ gamePk: feed?.gamePk || `fixture-${index}`, gameDate: feed?.gameData?.datetime?.dateTime }));
  const byId = new Map(recentFeeds.map((feed, index) => [String(feed?.gamePk || `fixture-${index}`), feed]));
  const conflicts = new Set(recentFeeds.filter(feed => feed?.gamePk && JSON.stringify(feed) !== JSON.stringify(byId.get(String(feed.gamePk)))).map(feed => String(feed.gamePk)));
  const seen = new Set();
  const games = expected.filter(row => { const key = String(row.gamePk); if (seen.has(key)) return false; seen.add(key); return true; }).map(row => {
    const feed = byId.get(String(row.gamePk));
    const side = Number(feed?.gameData?.teams?.home?.id) === Number(teamId) ? 'home' : Number(feed?.gameData?.teams?.away?.id) === Number(teamId) ? 'away' : null;
    const team = feed?.liveData?.boxscore?.teams?.[side];
    const time = Date.parse(feed?.gameData?.datetime?.dateTime);
    const ids = Array.isArray(team?.pitchers) ? team.pitchers : [];
    const valid = !conflicts.has(String(row.gamePk)) && Number.isFinite(time) && time < target && side && ids.length > 0 && new Set(ids.map(String)).size === ids.length
      && (!feed?.gameData?.status?.abstractGameState || feed.gameData.status.abstractGameState === 'Final');
    const missingPlayers = valid ? ids.slice(1).filter(id => count(team.players?.[`ID${id}`]?.stats?.pitching?.numberOfPitches) == null)
      .map(id => ({ id: String(id), name: team.players?.[`ID${id}`]?.person?.fullName || null })) : [];
    return { gamePk: row.gamePk, date: feed?.gameData?.datetime?.officialDate || row.officialDate || row.gameDate || null,
      fetched: Boolean(feed), valid: Boolean(valid), complete: Boolean(valid && missingPlayers.length === 0), missingPlayers,
      reason: !feed ? 'FEED_UNAVAILABLE' : !valid ? 'GAME_IDENTITY_TIME_OR_PITCHERS_UNVERIFIED' : missingPlayers.length ? 'PITCH_COUNTS_MISSING' : null };
  });
  return { version: BULLPEN_EVIDENCE_VERSION, expectedGames: games.length, fetchedGames: games.filter(row => row.fetched).length,
    completeGames: games.filter(row => row.complete).length, complete: games.length > 0 && games.every(row => row.complete),
    games, missingGames: games.filter(row => !row.complete) };
}
