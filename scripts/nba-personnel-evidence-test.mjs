import assert from 'node:assert/strict';
import { buildNbaPersonnelEvidence, nbaPersonnelSnapshotInputs, validNbaPersonnelTarget } from '../lib/nba/personnel-evidence.js';
import { loadTargetNbaInjuries, normalizeTargetNbaInjuries } from '../lib/nba/target-injuries.js';
import { createNbaCache } from '../lib/nba/cache.js';

const now = Date.parse('2026-10-08T00:00:00.000Z');
const game = { league: 'NBA', id: 'nba:espn:game:401900001', sourceId: '401900001', status: 'scheduled',
  completed: false, timeConfirmed: true, startTime: '2026-10-08T01:00:00.000Z', seasonType: 'preseason', season: { year: 2027 },
  home: { id: 'nba:espn:team:5' }, away: { id: 'nba:espn:team:18' } };
const source = (endpoint, extra = {}) => ({ provider: 'ESPN', status: 'ready', hash: 'a'.repeat(64), fetchedAt: new Date(now).toISOString(),
  publishedAt: null, url: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/${endpoint}`, ...extra });
const player = (teamId, n) => ({ id: `nba:espn:player:${n}`, sourceId: String(n), teamId, name: `Player ${n}`,
  starter: true, starterStatus: 'reported', lineupTemporalBasis: 'provider_pregame_report', didNotPlay: false,
  statistics: [{ name: 'minutes', displayValue: '31' }] });
const summary = () => ({ league: 'NBA', status: 'ready', qa: { status: 'WARNING' }, sources: [source(`summary?event=${game.sourceId}`)],
  data: { game: structuredClone(game), lineups: [game.away.id, game.home.id].map((teamId, index) => ({ teamId,
    players: Array.from({ length: 5 }, (_, n) => player(teamId, 100 + index * 10 + n)) })) } });
const injury = (extra = {}) => ({ id: 'nba:espn:injury:5:110:123', team: { id: game.home.id },
  player: player(game.home.id, 110), status: 'Questionable', reportedAt: '2026-10-07T22:00:00.000Z', description: 'Reported ankle injury', ...extra });
const injuries = () => ({ league: 'NBA', status: 'ready', qa: { status: 'WARNING' }, sources: [source('injuries?limit=1000')], data: { injuries: [injury()] } });
const build = (s = summary(), i = injuries(), target = game, clock = now) => buildNbaPersonnelEvidence(target, s, i, clock);

const ready = build();
assert.equal(ready.status, 'ready'); assert.equal(ready.modelInputEnabled, false); assert.equal(ready.strictPointInTime, false);
assert.equal(ready.officialLineupConfirmed, false); assert.equal(ready.coverage.officialInjuries, 'unknown');
assert.equal(ready.coverage.officialLineups, 'unknown'); assert.equal(ready.coverage.rotation, 'unknown'); assert.equal(ready.coverage.minutes, 'unknown');
assert.ok(ready.lineups.every(row => row.status === 'provider_reported' && row.officialConfirmed === false && row.confirmedMinutes === null));
assert.ok(ready.lineups.flatMap(row => row.players).every(row => row.confirmedMinutes === null));
assert.equal(ready.injuries[0].gameId, game.id); assert.equal(ready.injuries[0].startTime, game.startTime);
assert.equal(ready.injuries[0].status, 'provider_reported'); assert.equal(ready.injuries[0].officialReportVerified, false);
assert.equal(validNbaPersonnelTarget(game, now), true);
assert.equal(build(summary(), injuries(), game, Date.parse(game.startTime)).status, 'blocked');
for (const mutate of [
  g => g.league = 'MLB', g => g.status = 'final', g => g.completed = true, g => g.timeConfirmed = false,
  g => g.home.id = g.away.id, g => g.home.id = 'nba:espn:team:99', g => g.id = 'nba:espn:game:9', g => g.startTime = '2026-10-08T01:00:00',
]) { const target = structuredClone(game); mutate(target); assert.equal(build(summary(), injuries(), target).status, 'blocked'); }
for (const mutate of [
  s => s.sources[0].fetchedAt = '2026-10-07T23:54:59.999Z', s => s.sources[0].fetchedAt = '2026-10-08T00:00:00.001Z',
  s => s.sources[0].hash = null, s => s.sources[0].status = 'stale', s => s.sources[0].publishedAt = '2026-10-08T00:00:00.001Z',
  s => s.sources[0].url = s.sources[0].url.replace(game.sourceId, '401900002'), s => s.qa.status = 'BLOCK', s => s.qa = null,
  s => s.sources[0].url = 'https://example.com/summary?event=401900001', s => s.sources = [],
]) { const s = summary(); mutate(s); const result = build(s); assert.equal(result.status, 'unavailable'); assert.equal(result.coverage.game, 'unknown'); assert.equal(result.injuries.length, 0); }
for (const mutate of [s => s.data.game.startTime = '2026-10-08T01:01:00.000Z', s => s.data.game.away.id = 'nba:espn:team:3',
  s => s.data.game.sourceId = '401900002', s => s.data.game.seasonType = 'regular', s => s.data.game.season.year = 2026]) {
  const s = summary(); mutate(s); assert.equal(build(s).status, 'blocked');
}
for (const mutate of [
  i => i.sources[0].status = 'stale', i => i.sources[0].hash = '', i => i.sources[0].publishedAt = '2026-10-08T00:00:01.000Z',
  i => i.sources[0].fetchedAt = '2026-10-07T23:54:59.999Z', i => i.qa.status = 'BLOCK', i => i.status = 'unavailable',
]) { const i = injuries(); mutate(i); const result = build(summary(), i); assert.equal(result.status, 'partial'); assert.equal(result.coverage.injuries, 'unknown'); assert.equal(result.injuries.length, 0); }
for (const extra of [{ reportedAt: '2026-10-08T00:00:00.001Z' }, { reportedAt: null }, { reportedAt: '2026-10-05T23:59:59.999Z' },
  { status: 'NOT YET SUBMITTED' }, { status: 'Unknown' }, { player: { ...player(game.home.id, 110), sourceId: '999' } },
  { player: { ...player(game.home.id, 110), teamId: game.away.id } }]) {
  const i = injuries(); i.data.injuries = [injury(extra)]; const result = build(summary(), i);
  assert.equal(result.injuries[0].status, 'unknown'); assert.equal(result.status, 'partial');
  assert.equal(nbaPersonnelSnapshotInputs(result, summary(), i).injuryResult, null);
}
const empty = injuries(); empty.data.injuries = [];
assert.equal(build(summary(), empty).coverage.injuries, 'no_matching_report_not_confirmed_health');
const unrelated = injuries(); unrelated.data.injuries = [injury({ team: { id: 'nba:espn:team:6' }, player: player('nba:espn:team:6', 210) })];
assert.equal(build(summary(), unrelated).injuries.length, 0);
const duplicate = injuries(); duplicate.data.injuries.push(injury());
assert.ok(build(summary(), duplicate).injuries.every(row => row.playerId === null && row.status === 'unknown'));
const incomplete = summary(); incomplete.data.lineups[0].players.pop();
assert.equal(build(incomplete).lineups[0].status, 'unknown'); assert.equal(build(incomplete).lineups[0].players.length, 4);
const badPlayer = summary(); badPlayer.data.lineups[0].players[0].teamId = game.home.id;
assert.equal(build(badPlayer).lineups[0].status, 'unknown'); assert.equal(build(badPlayer).lineups[0].players.length, 0);
const actual = summary(); actual.data.lineups[0].players[0].starterStatus = 'actual'; actual.data.lineups[0].players[0].lineupTemporalBasis = 'postgame_boxscore';
assert.equal(build(actual).lineups[0].status, 'unknown');
const snapshotInputs = nbaPersonnelSnapshotInputs(ready, summary(), injuries());
assert.ok(snapshotInputs.gameResult.data.lineups.flatMap(row => row.players).every(row => row.statistics.length === 0));
assert.equal(nbaPersonnelSnapshotInputs(build(summary(), injuries(), game, Date.parse(game.startTime)), summary(), injuries()), null);

// Optional persistence is dependency-injected. These tests never contact a site,
// database, or place a bet, and verify saved receipts rather than optimistic UI.
const { loadNbaPersonnelEvidence } = await import('../lib/nba/personnel-service.js');
const loadOptions = { now, loadGame: async (query, options) => { assert.deepEqual(query, { view: 'game', id: game.sourceId }); assert.equal(options.timeoutMs, 6000); return summary(); },
  loadInjuries: async (query, options) => { assert.deepEqual(query, { view: 'injuries' }); assert.equal(options.timeoutMs, 6000); return injuries(); } };
assert.equal((await loadNbaPersonnelEvidence(game, loadOptions)).persistence.status, 'not_requested');
let saves = 0;
const saved = await loadNbaPersonnelEvidence(game, { ...loadOptions, saveSnapshot: async snapshot => {
  saves++; assert.equal(snapshot.gameId, game.id); assert.equal(snapshot.officialLineupConfirmed, false); assert.equal(snapshot.modelInputEnabled, false);
  assert.equal(snapshot.personnelEvidence.coverage.minutes, 'unknown'); assert.equal(snapshot.personnelEvidence.persistence, undefined);
  return { persisted: true, inserted: true, revision: 'b'.repeat(64), capturedAt: snapshot.capturedAt };
} });
assert.equal(saves, 1); assert.equal(saved.persistence.persisted, true);
const fail = await loadNbaPersonnelEvidence(game, { ...loadOptions, saveSnapshot: async () => { throw new Error('offline'); } });
assert.equal(fail.persistence.persisted, false); assert.equal(fail.persistence.status, 'save_failed');
const badReceipt = await loadNbaPersonnelEvidence(game, { ...loadOptions, saveSnapshot: async () => ({ persisted: true, revision: 'b'.repeat(64), capturedAt: game.startTime }) });
assert.equal(badReceipt.persistence.status, 'receipt_unverified');
const unknownInjuries = await loadNbaPersonnelEvidence(game, { ...loadOptions, loadInjuries: async () => { throw new Error('unavailable'); }, saveSnapshot: async snapshot => {
  assert.equal(snapshot.injuryStatus, 'unknown'); assert.equal(snapshot.injuries.length, 0);
  return { persisted: true, revision: 'c'.repeat(64), capturedAt: snapshot.capturedAt };
} });
assert.equal(unknownInjuries.status, 'partial'); assert.equal(unknownInjuries.persistence.persisted, true);
let fetches = 0;
const ended = await loadNbaPersonnelEvidence({ ...game, status: 'final' }, { ...loadOptions, loadGame: async () => { fetches++; }, saveSnapshot: async () => { saves++; } });
assert.equal(ended.status, 'blocked'); assert.equal(fetches, 0); assert.equal(saves, 1);

const rawTeam = (id, abbreviation) => ({ id, uid: `s:40~l:46~t:${id}`, abbreviation, displayName: `Team ${id}` });
const rawRecord = (team = rawTeam('5', 'CLE')) => ({ id: '200', status: 'Questionable', date: '2026-10-07T22:00:00Z',
  athlete: { id: '110', uid: 's:40~l:46~a:110', displayName: 'Player 110', team } });
const raw = () => ({ status: 'success', timestamp: new Date(now).toISOString(), injuries: [
  { id: '5', injuries: [rawRecord()] }, { id: '18', injuries: [] },
  // The all-league validator rejects this unrelated grouping. It is deliberately
  // outside this target's scope, not a reason to weaken a target-team check.
  { id: '2', injuries: [rawRecord(rawTeam('6', 'DAL'))] },
] });
assert.equal(normalizeTargetNbaInjuries(raw(), game).injuries.length, 1);
for (const mutate of [
  r => r.injuries[0].injuries[0].athlete.team = rawTeam('18', 'NY'),
  r => r.injuries[2].injuries[0].athlete.team = rawTeam('5', 'CLE'),
  r => r.injuries[0].injuries[0].athlete.uid = 's:40~l:40~a:110',
  r => r.injuries[0].injuries[0].athlete.team.abbreviation = 'BOS',
  r => r.injuries[0].injuries[0].athlete.id = 'bad',
  r => r.injuries.push(structuredClone(r.injuries[0])),
  r => r.injuries[0].injuries = null,
  r => r.timestamp = '2026-10-08T00:00:00',
]) { const r = raw(); mutate(r); assert.throws(() => normalizeTargetNbaInjuries(r, game)); }
const rawUnknown = raw(); rawUnknown.injuries[0].injuries[0].date = null; rawUnknown.injuries[0].injuries[0].status = 'NOT YET SUBMITTED';
assert.equal(normalizeTargetNbaInjuries(rawUnknown, game).injuries[0].reportedAt, null);
let targetFetches = 0; const currentCache = createNbaCache(); const rawBody = JSON.stringify(raw());
const fetched = await loadTargetNbaInjuries(game, { now, cache: currentCache, fetchImpl: async url => {
  assert.equal(url, 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries?limit=1000');
  targetFetches++; return new Response(rawBody, { headers: { 'Content-Type': 'application/json' } });
} });
assert.equal(fetched.status, 'ready'); assert.equal(fetched.data.injuries.length, 1); assert.match(fetched.sources[0].hash, /^[a-f0-9]{64}$/);
assert.equal(build(summary(), fetched).status, 'ready');
const nextGame = { ...game, away: { id: 'nba:espn:team:6' } };
const cachedOtherTarget = await loadTargetNbaInjuries(nextGame, { now, cache: currentCache, fetchImpl: async () => { targetFetches++; throw new Error('cache not reused'); } });
assert.equal(cachedOtherTarget.status, 'unavailable'); assert.equal(cachedOtherTarget.qa.status, 'BLOCK'); assert.equal(targetFetches, 1);
console.log('NBA personnel observations: identity, source freshness, unknown availability, five-but-not-official, no invented minutes and verified optional persistence passed');
