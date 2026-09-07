import assert from 'node:assert/strict';
import { normalizeHittingV11, normalizePitchingV11, normalizeWeatherV11, fetchWeatherV11, scopedStatSplitsV11 } from '../lib/mlb-context-v11.js';
import { hydrateBullpenPitchingV13, buildBullpenV13, normalizePlatoonV13, validateCurrentFeedIdentityV13 } from '../lib/mlb-context-v13.js';
import { buildAnalysisDataAudit } from '../lib/analysis-data-audit-v1.js';
import { estimateRunProfileV13 } from '../lib/joint-score-v13.js';
import { buildInjuryRunValueV2 } from '../lib/mlb-injury-run-value-v2.js';
import { buildCatcherUmpireZoneV2 } from '../lib/mlb-catcher-umpire-zone-v2.js';

let cases = 0;
const check = (label, fn) => { fn(); cases++; };
const pitching = { inningsPitched: '40.1', gamesPitched: 40, gamesStarted: 0, earnedRuns: 18, hits: 40, strikeOuts: 40, baseOnBalls: 12, homeRuns: 5, saves: 3, holds: 12 };
const responseFor = splits => ({ stats: [{ group: { displayName: 'pitching' }, splits }] });
const roster = [{ id: 20, name: 'Missing reliever', position: 'RP', ...normalizePitchingV11({ inningsPitched: '0.0' }) }, { id: 21, name: 'Complete reliever', position: 'RP', ...normalizePitchingV11(pitching) }];
const calls = [];
const hydrated = await hydrateBullpenPitchingV13(roster, '2026-09-05', { fetchImpl: async input => {
  const url = new URL(input); calls.push(url);
  return Response.json(responseFor([
    { player: { id: 20 }, season: '2026', sport: { id: 1 }, team: { id: 119 }, stat: pitching },
    { player: { id: 20 }, season: '2026', sport: { id: 0 }, team: { id: 119 }, stat: { ...pitching, earnedRuns: 90 } },
  ]));
} });
check('only missing identities receive bounded date-range hydration', () => {
  assert.equal(calls.length, 1); assert.match(calls[0].pathname, /people\/20\/stats/);
  assert.equal(calls[0].searchParams.get('endDate'), '2026-09-05');
  assert.equal(calls[0].searchParams.get('group'), 'pitching');
  assert.equal(calls[0].searchParams.get('startDate'), '2026-03-01');
  assert.equal(hydrated[0].inningsPitched, 40 + 1 / 3);
  assert.equal(hydrated[0].earnedRuns, 18);
  assert.equal(hydrated[0].metricProvenance.accepted, true);
  assert.ok(hydrated[0].metricProvenance.fetchedAt && hydrated[0].metricProvenance.rawPayloadHash);
  assert.equal(hydrated[1], roster[1]);
});
for (const [label, payload] of [
  ['wrong player', responseFor([{ player: { id: 999 }, stat: pitching }])],
  ['wrong season', responseFor([{ season: '2025', stat: pitching }])],
  ['wrong sport', responseFor([{ sport: { id: 11 }, stat: pitching }])],
  ['wrong group', { stats: [{ group: { displayName: 'hitting' }, splits: [{ stat: pitching }] }] }],
  ['multiple stints without official total', responseFor([{ team: { id: 1 }, stat: pitching }, { team: { id: 2 }, stat: pitching }])],
  ['no MLB sample', { stats: [] }],
]) {
  const result = await hydrateBullpenPitchingV13([roster[0]], '2026-09-05', { fetchImpl: async () => Response.json(payload) });
  check(label, () => { assert.equal(result[0].metricProvenance.accepted, false); assert.equal(result[0].era, null); assert.equal(result[0].inningsPitched, 0); });
}
const partial = await hydrateBullpenPitchingV13([{ ...roster[0], strikeOuts: 900 }], '2026-09-05', { fetchImpl: async () => Response.json(responseFor([{ stat: { inningsPitched: '10.0', era: 3, whip: 1.2 } }])) });
check('one atomic statistical block without borrowed counts', () => { assert.equal(partial[0].era, 3); assert.equal(partial[0].strikeOuts, null); });
const game = { gamePk: 823903, officialDate: '2026-09-06', gameDate: '2026-09-07T02:10:00Z', awayTeamId: 120, homeTeamId: 119 };
const correctFeed = { gamePk: game.gamePk, gameData: { datetime: { officialDate: game.officialDate }, teams: { away: { id: 120 }, home: { id: 119 } }, game: { season: '2026' } } };
check('official date is distinct from UTC start date', () => validateCurrentFeedIdentityV13(correctFeed, game));
for (const [label, alter] of [
  ['wrong game', feed => { feed.gamePk++; }], ['swapped home', feed => { feed.gameData.teams.home.id = 120; }],
  ['wrong baseball date', feed => { feed.gameData.datetime.officialDate = '2026-09-07'; }], ['wrong season', feed => { feed.gameData.game.season = '2025'; }],
]) { const feed = structuredClone(correctFeed); alter(feed); check(label, () => assert.throws(() => validateCurrentFeedIdentityV13(feed, game), /IDENTITY_MISMATCH/)); }

const buildBullpen = rows => buildBullpenV13({ roster: [...rows, ...[22, 23, 24, 25].map(id => ({ ...roster[1], id }))], recentFeeds: [], teamId: 119, gameDate: game.gameDate, rosterComplete: true });
const contextFor = rows => ({ game, league: { runsPerTeamGame: 4.4, ops: 0.72 }, home: { bullpen: buildBullpen(rows), starter: { expectedInnings: 5.5 } }, away: {} });
const before = estimateRunProfileV13(contextFor(roster)), after = estimateRunProfileV13(contextFor(hydrated));
check('hydrated quality reaches later innings but not a five-inning starter segment', () => {
  assert.notEqual(before.ninth.away, after.ninth.away);
  assert.equal(before.first5.away, after.first5.away);
  const audit = buildAnalysisDataAudit(contextFor(hydrated), after);
  const row = audit.rows.find(row => row.id === 'home.bullpen');
  assert.equal(row.coverage.qualityCount, 6); assert.equal(row.players.find(player => player.id === '20').qualityComplete, true);
});
const splitResponse = { ok: true, fetchedAt: '2026-09-07T00:26:00Z', sourceRecord: 'https://statsapi.mlb.com/api/v1/teams/120/stats', data: { stats: [{ group: { displayName: 'hitting' }, splits: [{ team: { id: 120 }, sport: { id: 1 }, season: '2026', split: { code: 'vl' }, stat: { ops: 0.779, plateAppearances: 1605 } }] }] } };
const split = normalizePlatoonV13(splitResponse, 'vl', { teamId: 120, season: '2026' });
check('observed split does not promote model reliability or forge cutoff', () => {
  assert.equal(split.observationStatus, 'CONFIRMED'); assert.equal(split.status, 'PROJECTED'); assert.equal(split.asOf, null);
  const context = { away: { vsLeft: split, vsRight: split }, home: { starter: { throws: 'L' } } };
  const originalProfile = estimateRunProfileV13(context);
  const receipt = buildAnalysisDataAudit(context, originalProfile).rows.find(row => row.id === 'away.splits');
  assert.equal(receipt.status, 'observed'); assert.equal(receipt.asOf, null); assert.deepEqual(receipt.modelStatuses, ['PROJECTED']);
  const withoutMetadata = structuredClone(context); delete withoutMetadata.away.vsLeft.observationStatus; delete withoutMetadata.away.vsRight.observationStatus;
  assert.deepEqual(estimateRunProfileV13(withoutMetadata), originalProfile);
  assert.equal(normalizePlatoonV13(splitResponse, 'vr', { teamId: 120, season: '2026' }).available, false);
  assert.equal(scopedStatSplitsV11(splitResponse.data, { teamId: 119, group: 'hitting' }).length, 0);
});
check('missing counts cannot be reported as zero offense', () => {
  for (const value of [null, undefined, '', false, [], {}]) {
    const hitter = normalizeHittingV11({ gamesPlayed: 12, runs: value, ops: 0.72 });
    assert.equal(hitter.runsPerGame, null); assert.equal(hitter.status, 'PROJECTED');
  }
  assert.equal(normalizeHittingV11({ gamesPlayed: 12, runs: 0, ops: 0.72 }).runsPerGame, 0);
});
check('recent hitting used; team recent pitching stays diagnostic', () => {
  const base = { away: { hitting: { status: 'CONFIRMED', games: 130, runsPerGame: 4.4, ops: 0.72 }, recentHitting: { status: 'PROJECTED', games: 12, runsPerGame: 3 } } };
  const changed = structuredClone(base); changed.away.recentHitting.runsPerGame = 6;
  assert.ok(estimateRunProfileV13(changed).first5.away > estimateRunProfileV13(base).first5.away);
  const pitchOnly = structuredClone(base); pitchOnly.away.recentPitching = { status: 'CONFIRMED', era: 20, whip: 5, inningsPitched: 100 };
  assert.deepEqual(estimateRunProfileV13(pitchOnly).full, estimateRunProfileV13(base).full);
});
const weatherResponse = { ok: true, fetchedAt: '2026-09-07T00:20:00Z', data: { hourly: { time: ['2026-09-07T02:00'], temperature_2m: [0], relative_humidity_2m: [null], surface_pressure: [''], wind_speed_10m: [0], wind_direction_10m: [0] } } };
check('weather observation, neutral inputs and target hour are distinct', () => {
  const result = normalizeWeatherV11(weatherResponse, game.gameDate, { roof: 'open' });
  assert.equal(result.temperature, 0); assert.equal(result.windSpeed, 0); assert.equal(result.relativeHumidity, null);
  assert.equal(result.surfacePressure, null); assert.equal(result.modelInputs.surfacePressure, 1013); assert.equal(result.substitutions.length, 2);
  assert.equal(normalizeWeatherV11(weatherResponse, '2026-09-08T02:10:00Z', { roof: 'open' }).status, 'MISSING');
  const historical = normalizeWeatherV11(weatherResponse, game.gameDate, { roof: 'retractable' }, { historical: true });
  assert.match(historical.temporalContract, /NOT_PREGAME_FORECAST/); assert.equal(historical.roofStatus, 'PROJECTED');
});
let archiveURL;
await fetchWeatherV11({ gameDate: '2020-09-07T02:10:00Z' }, { available: true, latitude: 34, longitude: -118, roof: 'open' }, { fetchImpl: async input => { archiveURL = new URL(input); return Response.json({ hourly: { time: [] } }); } });
check('archive requests exclude unsupported probability variable', () => { assert.equal(archiveURL.hostname, 'archive-api.open-meteo.com'); assert.ok(!archiveURL.searchParams.get('hourly').includes('precipitation_probability')); });
check('null advanced measurements stay missing and unpromoted', () => {
  const zone = buildCatcherUmpireZoneV2({ catcherFraming: { pitches: 1000 }, umpire: { id: 521889, status: 'CONFIRMED', catcherNeutralRunsPerGame: null } });
  assert.equal(zone.status, 'MISSING'); assert.equal(zone.catcherNeutralRunsPerGame, null); assert.equal(zone.appliedValue.runsPerGame, 0);
  const injury = buildInjuryRunValueV2({ injuredRoster: { available: true, roster: [{ person: { id: 1 }, stat: { ops: null, plateAppearances: 300 } }] }, lineup: { official: true } });
  assert.equal(injury.absentPlayers.length, 0); assert.equal(injury.coverage.playersWithBattingMetrics, 0); assert.equal(injury.appliedValue.absentRunsPerGame, 0);
});
console.log(JSON.stringify({ ok: true, suite: 'mlb-coverage-completion-v11916', cases }));
