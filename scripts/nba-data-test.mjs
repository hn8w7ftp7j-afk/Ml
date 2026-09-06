import assert from 'node:assert/strict';
import { loadNbaData, normalizeGame } from '../lib/nba/data.js';
import { createNbaCache } from '../lib/nba/cache.js';
import { normalizePlayer, normalizeTeam, sourceId, taipeiDate } from '../lib/nba/identity.js';

// All payloads below are synthetic TEST-ONLY fixtures, never production seed data.
const nowValue = Date.parse('2026-09-06T12:00:00Z');
const now = () => nowValue;
const league = { id: '46', uid: 's:40~l:46', abbreviation: 'NBA', season: { year: 2026, type: 2 } };
const team = (id = '5') => ({ id, uid: `s:40~l:46~t:${id}`, abbreviation: id === '5' ? 'CLE' : 'NY', displayName: id === '5' ? 'Cleveland Cavaliers' : 'New York Knicks' });
const athlete = { id: '123456', uid: 's:40~l:46~a:123456', displayName: 'Synthetic Test Player' };
function event({ id = '900001', date = '2026-04-12T22:00:00Z', type = 2, complete = true } = {}) {
  return { id, uid: `s:40~l:46~e:${id}`, date, season: { year: 2026, type }, competitions: [{ id, date, competitors: [
    { id: '5', homeAway: 'home', team: team(), score: '104', linescores: [25, 27, 26, 26].map((value, i) => ({ value, period: i + 1 })) },
    { id: '18', homeAway: 'away', team: team('18'), score: '100', linescores: [25, 25, 25, 25].map((value, i) => ({ value, period: i + 1 })) }
  ], status: { type: { state: complete ? 'post' : 'pre', completed: complete, description: complete ? 'Final' : 'Scheduled' } } }] };
}
const scoreboard = events => ({ leagues: [league], events });
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const fetchValue = value => async () => jsonResponse(value);
let count = 0;
async function test(name, fn) { await fn(); count += 1; console.log(`PASS ${name}`); }

await test('provider IDs preserve strings, reject numeric IDs and foreign namespaces', () => {
  assert.equal(sourceId('nba:espn:game:900001', 'game'), '900001');
  assert.throws(() => sourceId(900001, 'game'));
  assert.throws(() => sourceId('mlb:espn:game:900001', 'game'));
  assert.throws(() => normalizeTeam({ ...team(), uid: 's:1~l:10~t:5' }));
  assert.throws(() => normalizeTeam({ ...team(), abbreviation: 'LAL' }));
});
await test('player IDs can only be recovered from a verified ESPN NBA player link', () => {
  const links = [{ rel: ['playercard'], href: 'https://www.espn.com/nba/player/_/id/123456/test' }];
  assert.equal(normalizePlayer({ displayName: 'Synthetic Test Player', links }).sourceId, '123456');
  assert.throws(() => normalizePlayer({ displayName: 'Unknown', links: [{ rel: ['playercard'], href: 'https://evil.example/nba/player/_/id/123456/test' }] }));
});
await test('Taipei date conversion crosses UTC midnight correctly and ignores US DST', () => {
  assert.equal(taipeiDate('2026-04-12T22:00:00Z'), '2026-04-13');
  assert.equal(taipeiDate('2026-11-01T16:00:00Z'), '2026-11-02');
});
await test('source game time requires explicit timezone and a valid original calendar', () => {
  for (const date of ['2026-04-12T22:00:00', '2026-02-30T22:00:00Z', '2025-02-29T22:00:00+08:00', '2026-04-12T24:00:00Z', '2026-04-12T22:60:00Z', '2026-04-12T22:00:00+24:00']) {
    assert.throws(() => normalizeGame(event({ date })), /開賽時間/);
  }
  assert.equal(normalizeGame(event({ date: '2026-04-12T18:00:00-04:00' })).startTime, '2026-04-12T22:00:00.000Z');
  assert.equal(normalizeGame(event({ date: '2026-04-12T22:00Z' })).startTime, '2026-04-12T22:00:00.000Z');
  assert.equal(normalizeGame(event({ date: '2024-02-29T23:00:00+08:00' })).startTime, '2024-02-29T15:00:00.000Z');
});
await test('invalid source publication timestamps BLOCK before successful cache write', async () => {
  for (const timestamp of ['2026-02-30T00:00:00Z', '2026-09-06T01:00:00']) {
    const cache = createNbaCache();
    const result = await loadNbaData({ view: 'schedule', date: '2026-09-06' }, { cache, now, fetchImpl: fetchValue({ ...scoreboard([]), timestamp }) });
    assert.equal(result.qa.status, 'BLOCK'); assert.equal(cache.size, 0);
  }
});
await test('schedule neighboring range is filtered to exact Taipei calendar date', async () => {
  let url;
  const fetchImpl = async input => { url = input; return jsonResponse(scoreboard([event(), event({ id: '900002', date: '2026-04-12T15:59:59Z' }), event({ id: '900003', date: '2026-04-13T16:00:00Z' })])); };
  const result = await loadNbaData({ view: 'schedule', date: '2026-04-13' }, { fetchImpl, now });
  assert.match(url, /dates=20260412-20260414/);
  assert.equal(result.status, 'ready'); assert.equal(result.data.games.length, 1);
  assert.equal(result.data.games[0].id, 'nba:espn:game:900001');
  assert.equal(result.sources[0].publishedAt, null);
  assert.equal(result.sources[0].fetchedAt, new Date(nowValue).toISOString());
});
await test('an empty valid schedule is empty with predictable arrays, not an upstream failure', async () => {
  const result = await loadNbaData({ view: 'schedule', date: '2026-09-06' }, { fetchImpl: fetchValue(scoreboard([])), now });
  assert.equal(result.status, 'empty');
  for (const key of ['games', 'teams', 'players', 'injuries', 'statistics', 'lineups']) assert.ok(Array.isArray(result.data[key]));
});
await test('impossible calendar dates fail before any request', async () => {
  let calls = 0;
  const result = await loadNbaData({ date: '2026-02-30' }, { fetchImpl: async () => { calls += 1; }, now });
  assert.equal(result.qa.status, 'BLOCK'); assert.equal(calls, 0);
});
await test('foreign league response blocks data and is never cached as successful', async () => {
  const cache = createNbaCache();
  const result = await loadNbaData({ date: '2026-04-13' }, { cache, now, fetchImpl: fetchValue({ leagues: [{ ...league, abbreviation: 'MLB' }], events: [] }) });
  assert.equal(result.qa.status, 'BLOCK'); assert.equal(cache.size, 0);
});
await test('same team on both sides blocks the game', () => {
  const raw = event(); raw.competitions[0].competitors[1] = { ...raw.competitions[0].competitors[1], id: '5', team: team() };
  assert.throws(() => normalizeGame(raw), /同場兩隊/);
});
await test('a final score cannot be null or inconsistent with period totals', () => {
  const missing = event(); missing.competitions[0].competitors[0].score = null;
  assert.throws(() => normalizeGame(missing), /完賽比分/);
  const wrong = event(); wrong.competitions[0].competitors[0].score = '105';
  assert.throws(() => normalizeGame(wrong), /分節比分/);
});
await test('pregame scores remain null, not fabricated 0-0', () => {
  const game = normalizeGame(event({ complete: false })); assert.equal(game.home.score, null); assert.equal(game.away.score, null);
});
await test('game summary preserves postgame starters and excludes latest injuries', async () => {
  const header = { ...event(), league };
  const raw = { header, meta: { lastUpdatedAt: '2026-04-13T00:18:08Z' }, injuries: [{ date: '2026-07-19T00:14Z', status: 'Out' }], boxscore: { players: [{ team: team(), statistics: [{ keys: ['minutes', 'points'], labels: ['MIN', 'PTS'], athletes: [{ athlete, starter: true, didNotPlay: false, active: false, reason: "COACH'S DECISION", stats: ['30', '14'] }] }] }] } };
  const result = await loadNbaData({ view: 'game', id: '900001' }, { fetchImpl: fetchValue(raw), now });
  assert.equal(result.status, 'ready'); assert.equal(result.data.injuries.length, 0);
  assert.equal(result.data.players[0].starterStatus, 'actual');
  assert.equal(result.data.players[0].lineupTemporalBasis, 'postgame_boxscore');
  assert.equal(result.data.players[0].didNotPlay, false);
  assert.equal(result.sources[0].publishedAt, '2026-04-13T00:18:08.000Z');
  assert.equal(result.data.lineups[1].pregameConfirmedAt, null);
});
await test('wrong game returned by summary blocks, regardless of HTTP 200', async () => {
  const result = await loadNbaData({ view: 'game', id: '900002' }, { fetchImpl: fetchValue({ header: { ...event(), league } }), now });
  assert.equal(result.qa.status, 'BLOCK'); assert.equal(result.data.game, null);
});
await test('optional On/Off event conflict is quarantined without erasing independently verified scores', async () => {
  const raw = { header: { ...event(), league }, plays: [{ id: '7777', sequenceNumber: '1' }], boxscore: { players: ['5', '18'].map((id, side) => ({ team: team(id), statistics: [{ keys: ['minutes', 'points'], athletes: Array.from({ length: 5 }, (_, i) => {
    const playerId = String(1000 + side * 10 + i);
    return { athlete: { id: playerId, uid: `s:40~l:46~a:${playerId}`, displayName: `Synthetic ${playerId}` }, starter: true, didNotPlay: false, stats: ['48', '0'] };
  }) }] })) } };
  const result = await loadNbaData({ view: 'game', id: '900001' }, { fetchImpl: fetchValue(raw), now });
  assert.equal(result.status, 'ready'); assert.equal(result.qa.status, 'WARNING'); assert.equal(result.data.game.home.score, 104);
  assert.equal(result.data.onOff.status, 'blocked'); assert.equal(result.data.onOff.qa.status, 'BLOCK'); assert.deepEqual(result.data.onOff.players, []);
  assert.equal(result.data.onOff.source.hash, result.sources[0].hash); assert.equal(result.data.availability.playerOnOff, 'blocked');
});
await test('misaligned player statistic arrays block instead of shifting values', async () => {
  const raw = { header: { ...event(), league }, boxscore: { players: [{ team: team(), statistics: [{ keys: ['points', 'minutes'], athletes: [{ athlete, stats: ['5'] }] }] }] } };
  const result = await loadNbaData({ view: 'game', id: '900001' }, { fetchImpl: fetchValue(raw), now });
  assert.equal(result.qa.status, 'BLOCK');
});
await test('team statistics use requestedSeason and label roster as retrieved-now', async () => {
  const fetchImpl = async url => jsonResponse(url.includes('/roster') ? { status: 'success', team: team(), athletes: [athlete], timestamp: '2026-09-06T01:00:00Z' } : { status: 'success', team: team(), season: { year: 2027, type: 1 }, requestedSeason: { year: 2026, type: 2 }, results: { stats: { categories: [{ name: 'general', stats: [{ name: 'gamesPlayed', value: 82, displayValue: '82' }] }] } } });
  const result = await loadNbaData({ view: 'team', id: '5', season: 2026 }, { fetchImpl, now });
  assert.equal(result.data.season.year, 2026); assert.equal(result.data.season.type, 'regular');
  assert.equal(result.data.players[0].historicalMembershipVerified, false);
});
await test('current injury reports never serve a historical request', async () => {
  let calls = 0;
  const result = await loadNbaData({ view: 'injuries', date: '2026-04-13' }, { fetchImpl: async () => { calls += 1; }, now });
  assert.equal(result.status, 'unavailable'); assert.equal(calls, 0);
  assert.ok(result.qa.issues.some(item => item.code === 'HISTORICAL_INJURY_UNAVAILABLE'));
});
const playerStatistics = () => ({ filters: [{ name: 'league', value: 'nba' }, { name: 'seasontype', value: '2' }], teams: { 'cleveland-cavaliers': team() }, categories: [{ name: 'averages', displayName: 'Averages', names: ['gamesPlayed', 'avgPoints'], labels: ['GP', 'PTS'], statistics: [{ teamId: '5', teamSlug: 'cleveland-cavaliers', season: { year: 2025 }, stats: ['70', '20.0'] }, { teamId: '5', teamSlug: 'cleveland-cavaliers', season: { year: 2026 }, stats: ['80', '21.0'] }] }] });
await test('player profile verifies identity and career stats filter the requested season', async () => {
  const fetchImpl = async url => jsonResponse(url.includes('/stats?') ? playerStatistics() : { league, athlete: { ...athlete, team: team() }, season: { year: 2027, type: 1 } });
  const result = await loadNbaData({ view: 'player', id: '123456', season: 2026 }, { fetchImpl, now });
  assert.equal(result.status, 'ready'); assert.equal(result.data.player.id, 'nba:espn:player:123456');
  assert.equal(result.data.playerSeasons.length, 1); assert.equal(result.data.statistics[1].displayValue, '21.0');
  assert.equal(result.data.season.year, 2026); assert.equal(result.data.playerSeasons[0].season.year, 2026);
});
await test('wrong player profile blocks rather than associating someone else with statistics', async () => {
  const fetchImpl = async url => jsonResponse(url.includes('/stats?') ? playerStatistics() : { league, athlete: { ...athlete, id: '654321', uid: 's:40~l:46~a:654321' } });
  const result = await loadNbaData({ view: 'player', id: '123456', season: 2026 }, { fetchImpl, now });
  assert.equal(result.qa.status, 'BLOCK'); assert.equal(result.data.player, null); assert.equal(result.data.statistics.length, 0);
});
await test('player season-type mismatch blocks regular-season stats requested as postseason', async () => {
  const fetchImpl = async url => jsonResponse(url.includes('/stats?') ? playerStatistics() : { league, athlete });
  const result = await loadNbaData({ view: 'player', id: '123456', season: 2026, seasonType: 'postseason' }, { fetchImpl, now });
  assert.equal(result.qa.status, 'BLOCK');
});
await test('multi-team aggregate player rows stay explicitly separate from single-team rows', async () => {
  const stats = playerStatistics(); stats.categories[0].statistics.push({ teamSlug: '2025-26 Totals', season: { year: 2026 }, stats: ['82', '20.8'] });
  const fetchImpl = async url => jsonResponse(url.includes('/stats?') ? stats : { league, athlete });
  const result = await loadNbaData({ view: 'player', id: '123456', season: 2026 }, { fetchImpl, now });
  assert.equal(result.data.playerSeasons.length, 2); assert.equal(result.data.playerSeasons[1].team, null);
  assert.equal(result.data.playerSeasons[1].aggregateAcrossTeams, true);
});
await test('individual injury age differs from feed update time', async () => {
  const raw = { status: 'success', timestamp: '2026-09-06T01:00:00Z', injuries: [{ id: '5', injuries: [{ id: '-1', date: '2026-07-19T00:14Z', status: 'Day-To-Day', athlete: { ...athlete, team: team() }, details: { type: 'Foot' } }] }] };
  const result = await loadNbaData({ view: 'injuries' }, { fetchImpl: fetchValue(raw), now });
  assert.equal(result.data.injuries[0].freshness, 'older_report');
  assert.notEqual(result.data.injuries[0].reportedAt, result.sources[0].publishedAt);
});
await test('same-team players with sentinel injury ID -1 keep distinct verified identities', async () => {
  const secondPlayer = { ...athlete, id: '654321', uid: 's:40~l:46~a:654321', displayName: 'Second Synthetic Test Player' };
  const raw = { status: 'success', timestamp: '2026-09-06T01:00:00Z', injuries: [{ id: '5', injuries: [athlete, secondPlayer].map(player => ({ id: '-1', date: '2026-09-05T01:00:00Z', status: 'Out', athlete: { ...player, team: team() } })) }] };
  const result = await loadNbaData({ view: 'injuries' }, { fetchImpl: fetchValue(raw), now });
  assert.equal(result.status, 'ready'); assert.equal(result.data.injuries.length, 2);
  assert.deepEqual(result.data.injuries.map(record => record.id), ['nba:espn:injury:5:123456:-1', 'nba:espn:injury:5:654321:-1']);
});
await test('identical injury duplicates deduplicate; same-player conflicting reports BLOCK in either order', async () => {
  const record = { id: '-1', date: '2026-09-05T01:00:00Z', status: 'Out', athlete: { ...athlete, team: team() } };
  const payload = injuries => ({ status: 'success', injuries: [{ id: '5', injuries }] });
  const duplicate = await loadNbaData({ view: 'injuries' }, { fetchImpl: fetchValue(payload([record, structuredClone(record)])), now });
  assert.equal(duplicate.data.injuries.length, 1);
  const conflict = { ...record, status: 'Available' };
  for (const records of [[record, conflict], [conflict, record]]) {
    const cache = createNbaCache();
    const result = await loadNbaData({ view: 'injuries' }, { cache, fetchImpl: fetchValue(payload(records)), now });
    assert.equal(result.qa.status, 'BLOCK'); assert.equal(result.data.injuries.length, 0); assert.equal(cache.size, 0);
    assert.ok(result.qa.issues.some(item => item.code === 'INJURY_IDENTITY_CONFLICT'));
  }
});
await test('invalid injury report timestamps remain unknown rather than rolled into another date', async () => {
  for (const date of ['2026-02-30T01:00:00Z', '2026-09-05T01:00:00']) {
    const raw = { status: 'success', injuries: [{ id: '5', injuries: [{ id: '-1', date, status: 'Out', athlete: { ...athlete, team: team() } }] }] };
    const result = await loadNbaData({ view: 'injuries' }, { fetchImpl: fetchValue(raw), now });
    assert.equal(result.data.injuries[0].reportedAt, null); assert.equal(result.data.injuries[0].freshness, 'unknown');
  }
});
await test('history orders completed games and keeps season types separate', async () => {
  const fetchImpl = async url => {
    const type = Number(new URL(url).searchParams.get('seasontype'));
    const completed = event({ id: `90000${type}`, type, date: `2026-04-0${4 - type}T22:00:00Z` });
    // ESPN history has a separate event.seasonType, while event.season has no type.
    completed.season = { year: 2026 }; completed.seasonType = { id: String(type), type };
    return jsonResponse({ status: 'success', team: team(), season: { year: 2027, type: 1 }, requestedSeason: { year: 2026, type }, events: [completed, event({ id: `90001${type}`, type, complete: false })] });
  };
  for (const selected of ['regular', 'preseason', 'postseason']) {
    const result = await loadNbaData({ view: 'history', id: '5', season: 2026, seasonType: selected }, { fetchImpl, now });
    assert.equal(result.status, 'ready'); assert.equal(result.data.games.length, 1);
    assert.deepEqual(result.data.games.map(game => game.seasonType), [selected]);
    assert.ok(result.data.games.every(game => game.completed && game.season.year === 2026));
  }
});
await test('individual historical event season-type mismatch blocks before cache and cannot masquerade as empty', async () => {
  const raw = { team: team(), requestedSeason: { year: 2026, type: 2 }, events: [event({ type: 1 })] };
  const cache = createNbaCache();
  const result = await loadNbaData({ view: 'history', id: '5', season: 2026, seasonType: 'regular' }, { cache, fetchImpl: fetchValue(raw), now });
  assert.equal(result.status, 'unavailable'); assert.equal(result.qa.status, 'BLOCK'); assert.equal(cache.size, 0);
  assert.ok(result.qa.issues.some(item => item.code === 'SEASON_INVALID'));
});
await test('duplicate game identity with conflicting teams/date is blocked', async () => {
  const result = await loadNbaData({ date: '2026-04-13' }, { fetchImpl: fetchValue(scoreboard([event(), event({ date: '2026-04-12T23:00:00Z' })])), now });
  assert.equal(result.qa.status, 'BLOCK');
});
await test('upstream HTML is unavailable and never cached', async () => {
  const cache = createNbaCache();
  const result = await loadNbaData({ view: 'teams' }, { cache, now, fetchImpl: async () => new Response('<html>Access denied</html>', { headers: { 'content-type': 'text/html' } }) });
  assert.equal(result.status, 'unavailable'); assert.equal(cache.size, 0);
});
await test('cache deduplicates concurrent reads and isolates returned objects', async () => {
  const cache = createNbaCache(); let calls = 0;
  const fetchImpl = async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 5)); return jsonResponse({ value: 1 }); };
  const url = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=1000';
  const options = { fetchImpl, now, validate: value => assert.equal(value.value, 1) };
  const [a, b] = await Promise.all([cache.fetchJson(url, options), cache.fetchJson(url, options)]);
  assert.equal(calls, 1); a.value.value = 9; assert.equal(b.value.value, 1);
  assert.equal((await cache.fetchJson(url, options)).value.value, 1);
});
await test('cache marks stale fallback and preserves original timestamps', async () => {
  const cache = createNbaCache(); let tick = nowValue; let fail = false;
  const fetchImpl = async () => { if (fail) return new Response('', { status: 503 }); return jsonResponse({ value: 1 }); };
  const url = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=1000';
  const options = { fetchImpl, now: () => tick, ttlMs: 100, validate: value => assert.equal(value.value, 1) };
  const first = await cache.fetchJson(url, options); tick += 200; fail = true;
  const second = await cache.fetchJson(url, options);
  assert.equal(second.source.status, 'stale'); assert.equal(second.source.fetchedAt, first.source.fetchedAt); assert.equal(second.source.cacheAgeMs, 200);
});
await test('cache validates before write, cannot hide identity failure behind stale success', async () => {
  const cache = createNbaCache(); let tick = nowValue; let invalid = false;
  const fetchImpl = async () => jsonResponse({ good: !invalid });
  const url = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=1000';
  const options = { fetchImpl, now: () => tick, ttlMs: 1, validate: value => { if (!value.good) { const error = new Error('wrong league'); error.code = 'LEAGUE_IDENTITY_MISMATCH'; throw error; } } };
  await cache.fetchJson(url, options); tick += 2; invalid = true;
  await assert.rejects(cache.fetchJson(url, options), /wrong league/);
});
await test('bounded timeout works even if injected transport ignores abort', async () => {
  const cache = createNbaCache();
  await assert.rejects(cache.fetchJson('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams', { now, timeoutMs: 5, fetchImpl: () => new Promise(() => {}), validate: () => {} }), /逾時/);
});
await test('cache cannot fetch arbitrary hosts or non-NBA paths', async () => {
  const cache = createNbaCache();
  await assert.rejects(cache.fetchJson('https://example.com/private', { validate: () => {} }), /允許清單/);
  await assert.rejects(cache.fetchJson('https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/teams', { validate: () => {} }), /允許清單/);
});
await test('non-statistical upstream fields never leak into NBA output', async () => {
  const raw = scoreboard([event()]); raw.provider = { name: 'Unrelated upstream metadata' }; raw.events[0].odds = [{ hidden: true }];
  const result = await loadNbaData({ date: '2026-04-13' }, { fetchImpl: fetchValue(raw), now });
  assert.ok(!JSON.stringify(result).includes('Unrelated upstream metadata'));
  assert.ok(!JSON.stringify(result.data).includes('odds'));
});
console.log(`NBA data tests: ${count} passed`);
