import assert from 'node:assert/strict';
import { normalizePitchingV11 } from '../lib/mlb-context-v11.js';
import { buildBullpenV13, buildGameContextV13, hydrateLineupBattingV13, parseOfficialLineupV13, starterOnlyGameLogV13 } from '../lib/mlb-context-v13.js';
import { estimateRunProfileV13 } from '../lib/joint-score-v13.js';
import { buildAnalysisDataAudit } from '../lib/analysis-data-audit-v1.js';

const league = { era: 4.25, whip: 1.30, kPer9: 8.6, bbPer9: 3.2, hrPer9: 1.15 };
const partialPitcher = normalizePitchingV11({ inningsPitched: '10.0', era: '5.40', whip: '1.50', earnedRuns: null, hits: '', baseOnBalls: undefined }, league);
assert.equal(partialPitcher.era, 5.4, 'missing ER cannot turn a supplied ERA into zero');
assert.equal(partialPitcher.whip, 1.5, 'missing counts cannot override a supplied WHIP');
assert.equal(partialPitcher.earnedRuns, null);
assert.equal(partialPitcher.hits, null);
assert.equal(partialPitcher.kPer9, null);
assert.equal(partialPitcher.fip, null, 'no component observations must remain missing');
assert.equal(partialPitcher.status, 'PROJECTED');
const zeroPitcher = normalizePitchingV11({ inningsPitched: '10.0', earnedRuns: 0, hits: 0, baseOnBalls: 0, strikeOuts: 0, homeRuns: 0, era: 9, whip: 9 }, league);
assert.equal(zeroPitcher.era, 0, 'genuine zero ER is a valid observation');
assert.equal(zeroPitcher.whip, 0);
assert.equal(zeroPitcher.kPer9, 0);
assert.equal(zeroPitcher.status, 'CONFIRMED');
const emptyPitcher = normalizePitchingV11({ inningsPitched: '10.0' }, league);
assert.equal(emptyPitcher.available, false);
assert.equal(emptyPitcher.era, null);

const missingStarts = starterOnlyGameLogV13({ stats: [{ splits: [{ date: '2026-09-04', team: { id: 1 }, stat: { gamesStarted: 1, inningsPitched: '5.0' } }] }] }, { teamId: 1, endDate: '2026-09-05' });
assert.equal(missingStarts.earnedRuns, null);
assert.equal(missingStarts.era, null);
assert.equal(missingStarts.whip, null);
assert.equal(missingStarts.status, 'PROJECTED');

const batter = (id, index, stat = null) => ({ person: { id, fullName: `Batter ${id}` }, battingOrder: (index + 1) * 100, position: { abbreviation: index === 8 ? 'C' : 'OF' }, ...(stat ? { seasonStats: { batting: stat } } : {}) });
const hitters = Array.from({ length: 9 }, (_, i) => batter(100 + i, i));
const playerMap = rows => Object.fromEntries(rows.map(row => [`ID${row.person.id}`, row]));
const feed = (awayPlayers, homePlayers = [], date = '2026-09-06T18:00:00Z') => ({
  gamePk: 800001,
  gameData: { datetime: { dateTime: date, officialDate: date.slice(0, 10) }, teams: { away: { id: 1 }, home: { id: 2 } }, players: {} },
  liveData: { boxscore: { teams: { away: { players: playerMap(awayPlayers), pitchers: [] }, home: { players: playerMap(homePlayers), pitchers: [] } } } },
});
const namesOnly = parseOfficialLineupV13(feed(hitters), 1, 0.80);
assert.equal(namesOnly.official, true, 'official names remain an identity fact');
assert.equal(namesOnly.identityStatus, 'CONFIRMED');
assert.equal(namesOnly.status, 'MISSING', 'names alone are not confirmed batting ability');
assert.equal(namesOnly.metricsStatus, 'MISSING');
assert.equal(namesOnly.metricCoverage, 0);
assert.equal(namesOnly.offensiveIndex, 1, 'no-stat lineup must be neutral even against team OPS .80');
assert.ok(namesOnly.players.every(row => row.ops === null && row.plateAppearances === null && row.reliability === 0));
const fullStat = { ops: 0.90, obp: 0.40, slg: 0.50, plateAppearances: 300 };
const partial = parseOfficialLineupV13(feed([batter(100, 0, fullStat), ...hitters.slice(1)]), 1, 0.80);
const full = parseOfficialLineupV13(feed(hitters.map((row, i) => batter(row.person.id, i, fullStat))), 1, 0.80);
assert.equal(partial.metricCoverage, 1 / 9);
assert.equal(partial.status, 'PROJECTED');
assert.ok(partial.offensiveIndex > 1 && partial.offensiveIndex < full.offensiveIndex, 'one known hitter cannot represent all nine');
const zeroBatting = parseOfficialLineupV13(feed(hitters.map((row, i) => batter(row.person.id, i, { ops: 0, obp: 0, slg: 0, plateAppearances: 10 }))), 1, 0.80);
assert.equal(zeroBatting.players[0].ops, 0);
assert.equal(zeroBatting.metricCoverage, 1);

const calls = [];
const hydrated = await hydrateLineupBattingV13(namesOnly, 1, 0.80, '2026-09-05', {
  fetchImpl: async input => {
    const url = new URL(input);
    calls.push(url);
    assert.equal(url.searchParams.get('stats'), 'byDateRange');
    assert.equal(url.searchParams.get('group'), 'hitting');
    assert.equal(url.searchParams.get('endDate'), '2026-09-05');
    assert.equal(url.searchParams.get('startDate'), '2026-03-01');
    return new Response(JSON.stringify({ stats: [{ splits: [{ stat: fullStat }] }] }), { status: 200 });
  },
});
assert.equal(calls.length, 9);
assert.equal(hydrated.status, 'CONFIRMED');
assert.equal(hydrated.metricCoverage, 1);
assert.ok(hydrated.players.every(row => row.metricSource === 'MLB_PERSON_HITTING_BY_DATE_RANGE' && row.metricProvenance.rawPayloadHash));
const unavailable = await hydrateLineupBattingV13(namesOnly, 1, 0.80, '2026-09-05', { fetchImpl: async () => new Response('{}', { status: 503 }) });
assert.equal(unavailable.status, 'MISSING');
assert.equal(unavailable.offensiveIndex, 1);
assert.ok(unavailable.players.every(row => row.ops === null));
const rateOnly = parseOfficialLineupV13(feed(hitters.map((row, i) => batter(row.person.id, i, { ops: 0.90 }))), 1, 0.80);
const countOnlyHydration = await hydrateLineupBattingV13(rateOnly, 1, 0.80, '2026-09-05', { fetchImpl: async () => Response.json({ stats: [{ splits: [{ stat: { plateAppearances: 300 } }] }] }) });
assert.equal(countOnlyHydration.offensiveIndex, 1, 'dated PA-only response cannot borrow OPS from another source snapshot');
assert.equal(countOnlyHydration.metricCoverage, 0);

const reliefStats = { inningsPitched: '40.0', gamesPitched: 40, gamesStarted: 0, earnedRuns: 16, hits: 40, era: 3.6, whip: 1.2, strikeOuts: 45, baseOnBalls: 8, homeRuns: 4, saves: 0, holds: 0 };
const reliefPlayer = id => ({ person: { id, fullName: `Pitcher ${id}` }, position: { abbreviation: 'RP' }, seasonStats: { pitching: reliefStats }, stats: { pitching: { numberOfPitches: 30, inningsPitched: '1.0' } } });
const currentRoster = Array.from({ length: 6 }, (_, i) => ({ id: 20 + i, name: `Pitcher ${20 + i}`, position: 'RP', ...reliefStats }));
const recent = feed([reliefPlayer(10), reliefPlayer(20), reliefPlayer(99)], [], '2026-09-05T18:00:00Z');
recent.liveData.boxscore.teams.away.pitchers = [10, 20, 99];
const bullpen = buildBullpenV13({ roster: currentRoster, recentFeeds: [recent], teamId: 1, gameDate: '2026-09-06T18:00:00Z', probableStarterId: 10, rosterComplete: true, league });
assert.equal(bullpen.rosterCount, 6);
assert.equal(bullpen.status, 'CONFIRMED');
assert.ok(bullpen.relievers.every(row => row.id !== 99));
assert.equal(bullpen.excludedHistoricalCount, 1);
assert.equal(bullpen.historicalOnlyRelievers[0].modelUsed, false);
assert.equal(bullpen.relievers.find(row => row.id === 20).pitchesLast1, 30);
const noRoster = buildBullpenV13({ roster: [], recentFeeds: [recent], teamId: 1, gameDate: '2026-09-06T18:00:00Z', probableStarterId: 10, rosterComplete: false, league });
assert.equal(noRoster.rosterAvailable, false);
assert.equal(noRoster.qualityFactor, 1);
assert.equal(noRoster.qualityFactorIncludesUsage, false);
const restedFeed = structuredClone(recent);
restedFeed.liveData.boxscore.teams.away.players.ID20.stats.pitching.numberOfPitches = 0;
const restedBullpen = buildBullpenV13({ roster: currentRoster, recentFeeds: [restedFeed], teamId: 1, gameDate: '2026-09-06T18:00:00Z', probableStarterId: 10, rosterComplete: true, league });
assert.ok(bullpen.qualityFactor > restedBullpen.qualityFactor, 'observed fatigue already enters bullpen quality upstream');
const profileFor = bullpenValue => estimateRunProfileV13({ league: { ...league, runsPerTeamGame: 4.4, ops: 0.72 }, away: {}, home: { bullpen: bullpenValue, starter: { expectedInnings: 5.5 } } });
const tiredProfile = profileFor(bullpen);
const restedProfile = profileFor(restedBullpen);
assert.equal(tiredProfile.first5.away, restedProfile.first5.away, 'relief fatigue cannot affect five innings assigned entirely to the starter');
assert.ok(tiredProfile.ninth.away > restedProfile.ninth.away, 'observed fatigue reaches later run means through qualityFactor');
for (const field of ['fatigueIndex', 'highLeverageAvailability']) {
  const usage = tiredProfile.dataUsage.find(row => row.key === `home.bullpen.${field}`);
  assert.equal(usage.usedInMean, true);
  assert.match(usage.reason, /INDIRECT_VIA_BULLPEN_QUALITY_FACTOR/);
  assert.equal(profileFor(noRoster).dataUsage.find(row => row.key === `home.bullpen.${field}`).usedInMean, false, 'missing usage defaults cannot be reported as observed model inputs');
}

// Full context transport regression: even a populated live feed cannot bypass
// the game-day active-roster endpoint or retain a departed pitcher.
const contextCalls = [];
const liveFeed = feed([...hitters.map((row, i) => batter(row.person.id, i, fullStat)), ...currentRoster.map(row => reliefPlayer(row.id)), reliefPlayer(99)], hitters.map((row, i) => batter(200 + i, i)), '2026-09-07T02:00:00Z');
liveFeed.gameData.datetime.officialDate = '2026-09-06';
const contextGame = { leagueId: 'MLB', gamePk: 800001, awayTeamId: 1, homeTeamId: 2, awayProbableId: 10, homeProbableId: 11, gameDate: '2026-09-07T02:00:00Z', officialDate: '2026-09-06', scheduledInnings: 9 };
const contextOptions = {
  timeoutMs: 100,
  fetchImpl: async input => {
    const url = new URL(input); contextCalls.push(url);
    if (url.pathname.includes('/feed/live')) return Response.json(liveFeed);
    if (url.pathname.endsWith('/roster')) {
      if (url.searchParams.get('rosterType') === 'active') return Response.json({ roster: [...currentRoster.map(row => ({ person: { id: row.id, fullName: row.name }, position: { abbreviation: 'RP' } })), ...hitters.slice(0, 4)] });
      return Response.json({ roster: [] });
    }
    if (url.pathname.endsWith('/schedule')) return Response.json({ dates: [] });
    if (url.pathname.includes('/people/') && url.searchParams.get('group') === 'hitting') return Response.json({ stats: [{ splits: [{ stat: fullStat }] }] });
    if (url.hostname === 'statsapi.mlb.com' && url.searchParams.get('group') === 'hitting') return Response.json({ stats: [{ splits: [{ stat: { ...fullStat, ops: 0.80, gamesPlayed: 20, runs: 90 } }] }] });
    return Response.json({ stats: [{ splits: [] }] });
  },
};
const context = await buildGameContextV13(contextGame, contextOptions);
assert.equal(context.away.lineup.metricCoverage, 1);
assert.equal(context.away.lineup.identityStatus, 'CONFIRMED');
assert.equal(context.away.bullpen.rosterComplete, true);
assert.ok(context.away.bullpen.relievers.every(row => row.id !== 99));
const activeRequests = contextCalls.filter(url => url.searchParams.get('rosterType') === 'active');
assert.equal(activeRequests.length, 2);
assert.ok(activeRequests.every(url => url.searchParams.get('date') === '2026-09-06'), 'current roster must use game day, not previous statistical cutoff');
const datedStats = contextCalls.filter(url => url.searchParams.get('stats') === 'byDateRange');
assert.ok(datedStats.length > 10);
assert.ok(datedStats.every(url => url.searchParams.get('endDate') === '2026-09-05'), 'MLB night games must use previous official baseball date consistently for pitcher/team/batter statistics');
assert.equal(context.league.asOf, '2026-09-05');
const sourceAudit = buildAnalysisDataAudit(context);
for (const side of ['away', 'home']) {
  for (const category of ['starter', 'lineup', 'bullpen', 'splits']) {
    const row = sourceAudit.rows.find(item => item.id === `${side}.${category}`);
    assert.ok(row.observedAt, `${row.id}: transport acquisition time survives normalization`);
    assert.ok(row.sources.some(source => source.observedAt && source.sourceRecord && source.rawPayloadHash), `${row.id}: timestamp retains its exact source and payload hash`);
  }
}
assert.ok(!context.away.lineup.players.some(player => player.metricProvenance), 'full feed lineup exercises receipt propagation without the hydration fallback');
const ownStarterSources = sourceAudit.rows.find(item => item.id === 'away.starter').sources.filter(source => source.sourceRecord?.includes('/people/'));
assert.ok(ownStarterSources.every(source => source.sourceRecord.includes('/people/10/')), 'per-source receipts must not attach the other team starter transport');
const contextWithoutNewReceipts = structuredClone(context);
for (const side of ['away', 'home']) {
  for (const category of ['starter', 'lineup', 'bullpen']) delete contextWithoutNewReceipts[side][category].sourceReceipts;
  for (const split of ['vsLeft', 'vsRight']) {
    delete contextWithoutNewReceipts[side][split].fetchedAt;
    delete contextWithoutNewReceipts[side][split].source;
  }
}
assert.deepEqual(estimateRunProfileV13(context), estimateRunProfileV13(contextWithoutNewReceipts), 'source receipts cannot change means, uncertainty, coefficients, or model-use declarations');
const DateBeforeCacheTest = globalThis.Date;
const laterClock = DateBeforeCacheTest.parse(context.fetchedAt) + 5000;
try {
  globalThis.Date = class extends DateBeforeCacheTest {
    constructor(...args) { super(...(args.length ? args : [laterClock])); }
    static now() { return laterClock; }
  };
  const cachedContext = await buildGameContextV13(contextGame, contextOptions);
  const cachedAudit = buildAnalysisDataAudit(cachedContext);
  assert.notEqual(cachedContext.fetchedAt, context.fetchedAt, 'new context assembly has a later clock');
  for (const id of ['away.starter', 'away.lineup', 'away.bullpen', 'away.splits']) {
    const original = sourceAudit.rows.find(row => row.id === id);
    const cached = cachedAudit.rows.find(row => row.id === id);
    assert.deepEqual(cached.sources, original.sources, `${id}: cache reuse cannot refresh source observation time`);
    assert.equal(cached.observedAt, original.observedAt);
    assert.notEqual(cached.observedAt, cachedContext.fetchedAt, 'context time is never substituted for source time');
  }
} finally {
  globalThis.Date = DateBeforeCacheTest;
}
console.log(JSON.stringify({ ok: true, cases: ['missing_vs_zero_pitching', 'name_only_lineup_neutral', 'partial_coverage', 'official_pregame_hydration', 'failed_hydration_neutral', 'no_mixed_stat_blocks', 'departed_relief_excluded', 'indirect_usage_labels', 'official_day_timezone_cutoff', 'current_roster_transport', 'actual_source_timestamp_propagation', 'cached_acquisition_time_immutable'] }));
