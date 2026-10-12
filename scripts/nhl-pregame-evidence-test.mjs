import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NHL_SOURCES, normalizeNhlSchedule } from '../lib/nhl/data.js';
import { nhlPersonnelArticleUrl } from '../lib/nhl/personnel-feed.js';
import { buildNhlPregameScheduleFeatures, fetchNhlPregameEvidence } from '../lib/nhl/pregame-evidence.js';

const asOf = '2026-10-12T09:00:00Z';
assert.equal(NHL_SOURCES.lineupNews.url, 'https://www.nhl.com/news/');
assert.equal(NHL_SOURCES.lineupNews.urlTemplate.replace('{seasonStart}', '2026').replace('{seasonEndShort}', '27'), nhlPersonnelArticleUrl(20262027));
const targetRaw = { id: 2026020100, season: 20262027, gameType: 2, startTimeUTC: '2026-10-14T00:00:00Z', gameDate: '2026-10-13',
  awayTeam: { id: 10, abbrev: 'TOR', placeName: { default: 'Toronto' }, commonName: { default: 'Maple Leafs' } },
  homeTeam: { id: 14, abbrev: 'TBL', placeName: { default: 'Tampa Bay' }, commonName: { default: 'Lightning' } },
  gameState: 'FUT', gameScheduleState: 'OK' };
const prior = { ...targetRaw, id: 2026020001, startTimeUTC: '2026-10-10T23:00:00Z', gameDate: '2026-10-10', gameState: 'OFF' };
const upcomingPrior = { ...prior, id: 2026020050, startTimeUTC: '2026-10-13T00:00:00Z', gameDate: '2026-10-12', gameState: 'FUT' };
const payload = { currentSeason: 20262027, games: [prior, upcomingPrior, targetRaw] };
const source = team => ({ provider: 'NHL', url: `https://api-web.nhle.com/v1/club-schedule-season/${team}/20262027`,
  fetchedAt: asOf, contentHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') });
function schedule(team = 'TOR') {
  const src = source(team);
  return { ...normalizeNhlSchedule(payload, src), abbrev: team, season: 20262027,
    coverage: { complete: true, teamAbbrev: team, season: 20262027, from: '2026-07-01T00:00:00Z', to: '2027-07-01T00:00:00Z', source: src } };
}
const game = schedule().games.find(row => row.gameId === String(targetRaw.id));
const complete = buildNhlPregameScheduleFeatures(game, 'away', schedule(), { asOf });
assert.equal(complete.restHours, 24);
assert.equal(complete.gamesLastSevenDays, 2);
assert.equal(complete.precedingGameId, String(upcomingPrior.id));
assert.equal(complete.estimated, true);
assert.equal(complete.features.awayRestHours.availableAt, asOf);
assert.equal(complete.features.awayGamesLastSevenDays.basis, 'PRIOR_SCHEDULED_GAMES_IN_168_HOURS_EXCLUDING_TARGET');
assert.deepEqual(complete.issues, []);
assert.equal(buildNhlPregameScheduleFeatures(game, 'home', schedule('TBL'), { asOf }).restHours, 24);
for (const mutate of [
  row => { row.coverage.complete = false; },
  row => { row.source.fetchedAt = '2026-10-12T09:00:01Z'; },
  row => { row.source.fetchedAt = '2026-10-12T08:00:00Z'; },
  row => { row.source.sourceUpdatedAt = '2026-10-12T10:00:00Z'; },
  row => { row.source.requestedAt = '2026-10-12T09:00:01Z'; },
  row => { row.source.contentHash = 'wrong'; },
  row => { row.abbrev = 'TBL'; },
  row => { row.coverage.teamAbbrev = 'TBL'; },
  row => { row.coverage.from = '2026-10-13T00:00:00Z'; },
  row => { row.games = row.games.filter(item => item.gameId !== game.gameId); },
  row => { row.games.find(item => item.gameId === game.gameId).homeTeamId = 12; },
  row => { row.games.find(item => item.gameId === String(upcomingPrior.id)).gameScheduleState = 'TBD'; },
  row => { row.games.push({ ...row.games[0], startTimeUTC: '2026-10-09T23:00:00Z' }); },
]) {
  const wrong = structuredClone(schedule()); mutate(wrong);
  const rejected = buildNhlPregameScheduleFeatures(game, 'away', wrong, { asOf });
  assert.equal(rejected.restHours, null); assert.equal(rejected.gamesLastSevenDays, null); assert.deepEqual(rejected.features, {});
}
const cancelled = schedule(); cancelled.games.find(row => row.gameId === String(upcomingPrior.id)).gameScheduleState = 'PPD';
const withoutPostponed = buildNhlPregameScheduleFeatures(game, 'away', cancelled, { asOf });
assert.equal(withoutPostponed.restHours, 73); assert.equal(withoutPostponed.gamesLastSevenDays, 1);
assert.equal(withoutPostponed.estimated, false);
assert.equal(buildNhlPregameScheduleFeatures(game, 'away', schedule(), { asOf: game.startTimeUTC }).restHours, null);

function sourceFetch({ failSchedules = false, badSeasonStats = false, crossStart = false } = {}) {
  let clock = Date.parse(asOf); const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    if (failSchedules && url.includes('/club-schedule-season/')) return { ok: false, status: 503, url, headers: new Headers() };
    if (url.includes('/news/')) return { ok: true, status: 200, url, headers: new Headers(), text: async () => {
      if (crossStart) clock = Date.parse(game.startTimeUTC);
      // Today's rolling article cannot supply tomorrow's target lineup.
      return `<link rel="canonical" href="${url}"><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', datePublished: asOf })}</script><article class="nhl-c-article"><div class="oc-c-markdown-stories"><h2>OTHER at TEAMS</h2></div></article>`;
    } };
    const data = url.includes('/club-schedule-season/') ? payload : url.includes('/roster/')
      ? { forwards: [], defensemen: [], goalies: [] }
      : { season: badSeasonStats ? 20252026 : 20262027, gameType: 2, skaters: [], goalies: [] };
    return { ok: true, status: 200, url, headers: new Headers(), json: async () => structuredClone(data) };
  };
  return { fetchImpl, now: () => clock, urls };
}
const live = sourceFetch();
const evidence = await fetchNhlPregameEvidence(game, live);
assert.equal(evidence.ok, true); assert.equal(evidence.status, 'WARNING'); assert.equal(evidence.asOf, '2026-10-12T09:00:00.000Z');
assert.equal(evidence.features.awayRestHours.value, 24); assert.equal(evidence.features.homeRestHours.value, 24);
assert.equal(evidence.features.awayGamesLastSevenDays.value, 2);
assert.equal(evidence.personnel.status, 'NO_MATCHING_GAME'); assert.equal(evidence.personnel.pointInTimeEligible, false);
assert.ok(evidence.missing.includes('awayXgForPer60')); assert.ok(evidence.missing.includes('awayGoalieGsaxPer60'));
assert.ok(evidence.missing.includes('awayAttackGoalsPerGame'));
assert.equal(evidence.teamStatistics.away.usage, 'PERSONNEL_IDENTITY_AND_SOURCE_DISPLAY_ONLY');
assert.equal(live.urls.length, 7); assert.ok(live.urls.every(url => !url.includes('20252026')));
assert.ok(live.urls.includes('https://www.nhl.com/news/nhl-lineup-projections-2026-27-season'));
const absentSchedules = await fetchNhlPregameEvidence(game, sourceFetch({ failSchedules: true }));
assert.equal(absentSchedules.ok, true); assert.deepEqual(absentSchedules.features, {});
assert.ok(absentSchedules.warnings.some(code => code.includes('NHL_SOURCE_HTTP_ERROR')));
assert.equal(absentSchedules.sources.length, 5);
assert.equal(absentSchedules.missingSources.length, 2);
assert.ok(absentSchedules.sources.every(row => /^[a-f0-9]{64}$/.test(row.contentHash)));
const wrongSeason = await fetchNhlPregameEvidence(game, sourceFetch({ badSeasonStats: true }));
assert.equal(wrongSeason.teamStatistics.away, null);
assert.ok(wrongSeason.warnings.includes('away:NHL_TEAM_STATISTICS_SCHEMA_INVALID'));
const crossed = await fetchNhlPregameEvidence(game, sourceFetch({ crossStart: true }));
assert.equal(crossed.ok, false); assert.equal(crossed.code, 'NHL_PREGAME_EVIDENCE_ACQUIRED_AFTER_START'); assert.deepEqual(crossed.features, {});
for (const changed of [{ ...game, league: 'NBA' }, { ...game, gameState: 'LIVE' }, { ...game, gameScheduleState: 'PPD' },
  { ...game, startTimeUTC: asOf }]) {
  const read = sourceFetch(); const refused = await fetchNhlPregameEvidence(changed, read);
  assert.equal(refused.ok, false); assert.equal(read.urls.length, 0);
}
assert.equal((await fetchNhlPregameEvidence(game, { now: () => 1e100 })).ok, false);
console.log('NHL live pregame evidence: exact season/team scope, bounded parallel sources, scheduled context, missing metrics and puck-drop leakage PASS');
