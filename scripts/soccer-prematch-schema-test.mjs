import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';

for (const [league, name] of [['epl', 'lineup-announced'], ['ucl', 'ucl-summary']]) {
  const source = JSON.parse(fs.readFileSync(`scripts/fixtures/soccer/${name}.json`));
  const competition = source.header.competitions[0];
  const game = normalizeSoccerSchedule({ leagues: [source.header.league], events: [{ ...source.header, date: competition.date, status: competition.status }] }, league, {}).games[0];
  assert.ok(game, `${league}: fixture must normalize`);
  const now = Date.parse(game.startTime) - 60000;
  const normalize = payload => normalizeSoccerPrematch(payload, game, { fetchedAt: new Date(now - 1000).toISOString() }, now);
  const original = normalize(source);
  assert.equal(original.ok, true);
  for (const invalid of [{}, [null]]) {
    const payload = structuredClone(source); payload.rosters = invalid;
    const result = normalize(payload);
    assert.equal(result.ok, true);
    for (const side of ['home', 'away']) {
      assert.equal(result.teams[side].lineup.status, 'UNKNOWN');
      assert.equal(result.teams[side].lineup.reason, 'ROSTER_SOURCE_SCHEMA_UNVERIFIED');
      assert.deepEqual(result.teams[side].lineup.starters, []);
    }
    assert.equal(result.minutesAudit.reason, 'ROSTER_SOURCE_SCHEMA_UNVERIFIED');
    assert.equal(result.league, league);
  }
  for (const invalid of [{}, [null]]) {
    const payload = structuredClone(source); payload.lastFiveGames = invalid;
    const result = normalize(payload);
    assert.equal(result.ok, true);
    assert.equal(result.recentMissing.home, 'RECENT_SOURCE_SCHEMA_UNVERIFIED');
    assert.equal(result.recentMissing.away, 'RECENT_SOURCE_SCHEMA_UNVERIFIED');
    assert.deepEqual(result.recent.home, []);
    assert.equal(result.teams.home.lineup.status, original.teams.home.lineup.status);
  }
  const badEvents = structuredClone(source); badEvents.lastFiveGames = [{ team: { id: game.home.sourceId }, events: {} }];
  assert.equal(normalize(badEvents).recentMissing.home, 'RECENT_SOURCE_SCHEMA_UNVERIFIED');
  const badOfficials = structuredClone(source); badOfficials.gameInfo ||= {}; badOfficials.gameInfo.officials = {};
  assert.equal(normalize(badOfficials).referee.reason, 'REFEREE_SOURCE_SCHEMA_UNVERIFIED');
  const absent = structuredClone(source); delete absent.rosters; delete absent.lastFiveGames;
  const missing = normalize(absent);
  assert.equal(missing.ok, true); assert.equal(missing.teams.home.lineup.status, 'NOT_PUBLISHED');
  assert.equal(missing.recentMissing.home, 'RECENT_SOURCE_NOT_PROVIDED');
  const foreign = { ...game, league: league === 'epl' ? 'ucl' : 'epl' };
  assert.notEqual(normalizeSoccerPrematch(source, foreign, {}, now).ok, true);
}
console.log('PASS prematch optional-field schema, fail-closed evidence and EPL/UCL isolation');
