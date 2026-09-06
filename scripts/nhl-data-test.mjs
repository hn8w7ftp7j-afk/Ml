import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeNhlGame, normalizeNhlSchedule, fetchNhlJson, fetchNhlSchedule, fetchNhlRoster, fetchNhlTeamStatistics, fetchNhlGame, fetchNhlPlayer, deriveNhlEventStatistics, buildNhlScheduleContext } from '../lib/nhl/data.js';
import { validateNhlIdentity, nhlDate, validNhlDate, normalizeNhlGoalieEvidence, detectNhlGoalieChange } from '../lib/nhl/identity.js';
import { NHL_HISTORICAL_SAMPLES } from '../lib/nhl/historical-samples.js';
import { normalizeNhlGameReport } from '../lib/nhl/game-report.js';
import { nhlRetryAfterPolicy, nhlSourceCooldown, recordNhlSourceRateLimit } from '../lib/nhl/source-retry-policy.js';

const load = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/nhl/${name}`, import.meta.url), 'utf8'));
const raw = load('landing-2023020001.json');
const roster = load('roster-TOR-20232024.json');
const clubStats = load('club-stats-TOR-20232024-2.json');
const source = { provider: 'NHL', url: 'https://api-web.nhle.com/v1/gamecenter/2023020001/landing', fetchedAt: '2026-09-06T03:00:00Z' };
const response = (data, status = 200, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: key => headers[key] ?? null }, json: async () => data });
let passed = 0;
async function test(name, run) { await run(); passed += 1; console.log(`PASS ${name}`); }

await test('real official scoring derives complete periods, preserving missing information', () => {
  const game = normalizeNhlGame(raw, { source });
  assert.equal(game.qa.status, 'PASS');
  assert.deepEqual(game.periods, [{ awayGoals: 0, homeGoals: 1 }, { awayGoals: 1, homeGoals: 0 }, { awayGoals: 2, homeGoals: 4 }]);
  assert.deepEqual(game.regulation, game.final);
  assert.equal(game.advanced.xGF, null);
  assert.equal(game.goalie.away, null);
  assert.equal(game.outcomeAvailableAt, null);
  assert.equal(game.source.url, source.url);
});

await test('official acquisition timestamp is complete-body availability, not request initiation', async () => {
  let now = Date.parse('2026-10-11T00:00:00Z');
  const result = await fetchNhlJson(source.url, { now: () => now, fetchImpl: async () => ({ ok: true, headers: new Headers(), json: async () => { now += 2000; return raw; } }) });
  assert.equal(result.source.requestedAt, '2026-10-11T00:00:00.000Z');
  assert.equal(result.source.fetchedAt, '2026-10-11T00:00:02.000Z');
});

await test('missing scoring and changed scoring fail closed instead of splitting final score', () => {
  const missing = structuredClone(raw); delete missing.summary;
  assert.equal(normalizeNhlGame(missing).periods, null);
  assert.equal(normalizeNhlGame(missing).qa.status, 'BLOCK');
  const broken = structuredClone(raw); broken.summary.scoring[0].goals = [];
  assert.equal(normalizeNhlGame(broken).periods, null);
  assert.ok(normalizeNhlGame(broken).qa.issues.includes('NHL_SCORING_PERIOD_TOTAL_MISMATCH'));
});

await test('real corpus period totals and shootout scoring reconcile, with no preseason contamination', () => {
  assert.ok(NHL_HISTORICAL_SAMPLES.length >= 12);
  for (const game of NHL_HISTORICAL_SAMPLES) {
    assert.equal(validateNhlIdentity(game).ok, true);
    assert.equal(game.gameType, 2);
    assert.equal(game.qa.canUseHistoricalPeriods, true);
    const extra = game.final.awayGoals + game.final.homeGoals - game.regulation.awayGoals - game.regulation.homeGoals;
    assert.equal(extra, game.outcomeType === 'REG' ? 0 : 1);
  }
  const shootout = NHL_HISTORICAL_SAMPLES.find(g => g.outcomeType === 'SO');
  assert.ok(shootout);
  assert.equal(shootout.regulation.awayGoals, shootout.regulation.homeGoals);
});

await test('league, season, team, game and requested date identity mismatches BLOCK', () => {
  const game = normalizeNhlGame(raw);
  for (const changed of [{ leagueId: 'MLB' }, { awayTeamId: game.homeTeamId }, { season: 20242025 }, { gameType: 1 }]) assert.equal(validateNhlIdentity({ ...game, ...changed }).ok, false);
  assert.equal(validateNhlIdentity(game, { taipeiDate: '2023-10-10' }).ok, false);
  assert.equal(validateNhlIdentity(game, { taipeiDate: '2023-10-11' }).ok, true);
  assert.equal(nhlDate('2023-10-10T21:30:00Z'), '2023-10-11');
  assert.equal(validNhlDate('2026-02-30'), false);
  for (const value of [null, undefined, false, [], [0], {}, '', '2023-10-10', '2023-10-10T21:30:00', '2026-02-30T20:00:00Z', '2023-10-10T24:00:00Z']) assert.equal(nhlDate(value), null);
  for (const value of [[18], true, {}, ' 18 ']) assert.equal(validateNhlIdentity({ ...game, awayTeamId: value }).ok, false);
  for (const changed of [{ gameId: [game.gameId] }, { season: [game.season] }, { gameType: [game.gameType] }]) assert.equal(validateNhlIdentity({ ...game, ...changed }).ok, false);
});

await test('duplicate schedule identity conflict cannot be restored by a third duplicate', () => {
  const changed = { ...raw, startTimeUTC: '2023-10-11T01:00:00Z' };
  const result = normalizeNhlSchedule({ games: [raw, changed, raw] }, source);
  assert.equal(result.ok, false); assert.equal(result.games.length, 0);
});

await test('403 negative cache and 429 retry-after do not produce repeated requests', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return response(null, 403); };
  const opts = { fetchImpl, now: () => Date.parse(source.fetchedAt) };
  assert.equal((await fetchNhlJson(source.url, opts)).code, 'NHL_SOURCE_FORBIDDEN');
  assert.equal((await fetchNhlJson(source.url, opts)).cached, true);
  assert.equal(requests, 1);
  let limitedRequests = 0;
  const limited = async () => { limitedRequests += 1; return response(null, 429); };
  assert.equal((await fetchNhlJson(source.url, { fetchImpl: limited })).code, 'NHL_SOURCE_RATE_LIMITED');
  assert.equal(limitedRequests, 1);
});

await test('429 seconds govern every new URL on the same host through exact expiry, without automatic retry', async () => {
  const start = Date.parse(source.fetchedAt); let clock = start; let requests = 0;
  const fetchImpl = async (_url, options) => { requests++; assert.equal(options.redirect, 'manual'); return requests === 1 ? response(null, 429, { 'retry-after': '120' }) : response(raw); };
  const options = { fetchImpl, now: () => clock };
  const first = await fetchNhlJson(source.url, options);
  assert.equal(first.retryAfter, '120'); assert.equal(first.retryAt, new Date(start + 120_000).toISOString());
  assert.equal(first.rateLimitSourceUrl, source.url); assert.equal(first.attempts, 1);
  clock += 31_000;
  const second = await fetchNhlJson(source.url.replace('/landing', '/play-by-play'), options);
  assert.equal(second.code, 'NHL_SOURCE_RATE_LIMITED'); assert.equal(second.hostCooldown, true); assert.equal(second.attempts, 0);
  assert.equal(second.retryAt, first.retryAt); assert.equal(second.source.fetchedAt, undefined); assert.equal(requests, 1);
  assert.equal((await fetchNhlJson(source.url, options)).cached, true);
  clock = start + 120_000;
  assert.equal(requests, 1, 'the passage of fake time must not initiate a request');
  assert.equal((await fetchNhlJson(source.url, options)).ok, true); assert.equal(requests, 2);
});

await test('HTTP-date and invalid retry-after preserve source cooldown, isolated by transport', async () => {
  const start = Date.parse(source.fetchedAt);
  for (const [header, duration, policy] of [
    [new Date(start + 90_000).toUTCString(), 90_000, 'OFFICIAL_RETRY_AFTER'],
    [null, 60_000, 'CONSERVATIVE_60_SECOND_BACKOFF_HEADER_ABSENT_OR_INVALID'],
    ['-1', 60_000, 'CONSERVATIVE_60_SECOND_BACKOFF_HEADER_ABSENT_OR_INVALID'],
    ['1.5', 60_000, 'CONSERVATIVE_60_SECOND_BACKOFF_HEADER_ABSENT_OR_INVALID'],
    ['not-a-date', 60_000, 'CONSERVATIVE_60_SECOND_BACKOFF_HEADER_ABSENT_OR_INVALID'],
  ]) {
    let clock = start; let requests = 0;
    const fetchImpl = async () => { requests++; return response(null, 429, { 'retry-after': header }); };
    const first = await fetchNhlJson(source.url, { fetchImpl, now: () => clock });
    assert.equal(first.retryAt, new Date(start + duration).toISOString()); assert.equal(first.retryPolicy, policy);
    clock += duration - 1;
    assert.equal((await fetchNhlJson(source.url.replace('/landing', '/boxscore'), { fetchImpl, now: () => clock })).attempts, 0);
    assert.equal(requests, 1);
  }
  assert.equal(nhlRetryAfterPolicy('0', start).retryAt, new Date(start).toISOString());
  assert.equal(nhlRetryAfterPolicy(new Date(start - 1000).toUTCString(), start).retryAt, new Date(start).toISOString());
  const independent = await fetchNhlJson(source.url, { fetchImpl: async () => response(raw), now: () => start });
  assert.equal(independent.ok, true);
});

await test('fresh successful cache retains original evidence clock during host cooldown', async () => {
  const start = Date.parse(source.fetchedAt); let clock = start; let requests = 0;
  const fetchImpl = async url => { requests++; return url === source.url ? response(raw) : response(null, 429, { 'retry-after': '120' }); };
  const options = { fetchImpl, now: () => clock, ttlMs: 180_000 };
  const success = await fetchNhlJson(source.url, options);
  clock += 1000;
  await fetchNhlJson(source.url.replace('/landing', '/right-rail'), options);
  clock += 30_000;
  const cached = await fetchNhlJson(source.url, options);
  assert.equal(cached.ok, true); assert.equal(cached.cached, true); assert.deepEqual(cached.source, success.source); assert.equal(requests, 2);
});

await test('parallel rate-limit responses cannot shorten or mutate the shared host deadline', () => {
  const start = Date.parse(source.fetchedAt); const fetchImpl = async () => {};
  const secondUrl = source.url.replace('/landing', '/boxscore');
  const first = recordNhlSourceRateLimit(fetchImpl, source.url, { retryAfter: '120', now: start });
  const shorter = recordNhlSourceRateLimit(fetchImpl, secondUrl, { retryAfter: '30', now: start + 1000 });
  assert.equal(shorter.retryAt, first.retryAt); assert.equal(shorter.rateLimitSourceUrl, source.url);
  shorter.retryAt = 'corrupt';
  assert.equal(nhlSourceCooldown(fetchImpl, secondUrl, start + 31_000).retryAt, first.retryAt);
  assert.equal(nhlSourceCooldown(fetchImpl, secondUrl, start + 120_000), null);
});

await test('concurrent 429 prevents another URL transient-failure automatic retry', async () => {
  let finishTransient; let requests = 0;
  const fetchImpl = async url => {
    requests++;
    if (url === source.url) return new Promise(resolve => { finishTransient = () => resolve(response(null, 500)); });
    return response(null, 429, { 'retry-after': '120' });
  };
  const options = { fetchImpl, now: () => Date.parse(source.fetchedAt) };
  const pending = fetchNhlJson(source.url, options);
  await fetchNhlJson(source.url.replace('/landing', '/boxscore'), options);
  finishTransient();
  const stopped = await pending;
  assert.equal(stopped.code, 'NHL_SOURCE_RATE_LIMITED'); assert.equal(stopped.attempts, 1); assert.equal(requests, 2);
});

await test('source allowlist rejects ports, credentials and fragments; redirects never follow or retry', async () => {
  let requests = 0;
  const never = async () => { requests++; return response(raw); };
  for (const url of ['https://api-web.nhle.com:444/v1/test', 'https://secret@api-web.nhle.com/v1/test', 'https://@api-web.nhle.com/v1/test', `${source.url}#fragment`, `${source.url}#`]) {
    assert.equal((await fetchNhlJson(url, { fetchImpl: never })).code, 'NHL_SOURCE_URL_NOT_ALLOWED');
  }
  assert.equal(requests, 0);
  assert.equal((await fetchNhlJson(source.url.replace('.com/', '.com:443/'), { fetchImpl: never })).ok, true);
  for (const value of [{ ...response(null, 302) }, { ...response(raw), redirected: true }, { ...response(raw), type: 'opaqueredirect' }, { ...response(raw), url: 'https://attacker.invalid/payload' }]) {
    let attempts = 0;
    const fetchImpl = async (_url, options) => { attempts++; assert.equal(options.redirect, 'manual'); return value; };
    const result = await fetchNhlJson(source.url, { fetchImpl });
    assert.equal(result.code, value.url ? 'NHL_SOURCE_RESPONSE_URL_MISMATCH' : 'NHL_SOURCE_REDIRECT_NOT_FOLLOWED'); assert.equal(attempts, 1);
  }
});

await test('network retries and body timeout are bounded; untrusted source URLs never fetch', async () => {
  let requests = 0;
  const broken = async () => { requests += 1; throw new Error('network unavailable'); };
  assert.equal((await fetchNhlJson(source.url, { fetchImpl: broken })).code, 'NHL_SOURCE_NETWORK_ERROR'); assert.equal(requests, 2);
  assert.equal((await fetchNhlJson('not a URL')).code, 'NHL_SOURCE_URL_NOT_ALLOWED');
  assert.equal((await fetchNhlJson('https://evil.invalid/private', { fetchImpl: broken })).code, 'NHL_SOURCE_URL_NOT_ALLOWED'); assert.equal(requests, 2);
  const never = async () => ({ ok: true, headers: { get: () => null }, json: () => new Promise(() => {}) });
  assert.equal((await fetchNhlJson(source.url, { fetchImpl: never, timeoutMs: 10 })).code, 'NHL_SOURCE_TIMEOUT');
});

await test('parallel source requests deduplicate and invalid last-modified stays null', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; await new Promise(resolve => setTimeout(resolve, 5)); return response(raw, 200, { 'last-modified': 'not-a-date' }); };
  const results = await Promise.all([fetchNhlJson(source.url, { fetchImpl }), fetchNhlJson(source.url, { fetchImpl })]);
  assert.equal(requests, 1); assert.equal(results[0].source.contentHash, results[1].source.contentHash); assert.equal(results[0].source.sourceUpdatedAt, null);
});

await test('Taipei schedule requests use prior source date and filter exact board day', async () => {
  const urls = [];
  const fetchImpl = async url => { urls.push(url); return response({ gameWeek: [{ date: '2023-10-10', games: [raw, { ...raw, id: 2023020002, startTimeUTC: '2023-10-11T18:00:00Z' }] }] }); };
  const result = await fetchNhlSchedule('2023-10-11', { fetchImpl });
  assert.equal(result.ok, true); assert.equal(result.games.length, 1); assert.ok(urls[0].endsWith('/2023-10-10'));
  assert.equal((await fetchNhlSchedule('2026-02-30', { fetchImpl })).ok, false);
});

await test('actual NHL roster and club statistics retain distinct player and team meaning', async () => {
  const fetchImpl = async url => response(url.includes('/roster/') ? roster : clubStats);
  const result = await fetchNhlRoster({ abbrev: 'TOR', teamId: 10 }, 20232024, { fetchImpl });
  assert.equal(result.ok, true); assert.ok(result.players.length > 20); assert.ok(result.players.filter(p => p.position === 'G').length > 1);
  const stats = await fetchNhlTeamStatistics({ abbrev: 'TOR', teamId: 10 }, 20232024, 2, { fetchImpl });
  assert.equal(stats.ok, true); assert.ok(stats.skaters.length > 20); assert.ok(stats.goalies.length > 1); assert.equal(stats.teamTotals, null); assert.equal(stats.xGF, null);
});

await test('game and player routes reject mismatched identity and schema', async () => {
  const mismatch = await fetchNhlGame('2023020002', { fetchImpl: async () => response(raw) });
  assert.equal(mismatch.ok, false); assert.ok(mismatch.issues.includes('NHL_IDENTITY_MISMATCH_gameId'));
  const player = await fetchNhlPlayer('8478402', { fetchImpl: async () => response({ playerId: 8478403 }) });
  assert.equal(player.ok, false);
});

await test('goalie evidence requires explicit source confirmation, correct roster and chronological updates', () => {
  const game = { gameId: '2023020001', awayTeamId: 18, homeTeamId: 14 };
  const goalieRoster = { teamId: 18, players: [{ playerId: 8477424, teamId: 18, position: 'G' }] };
  const evidence = { gameId: game.gameId, teamId: 18, playerId: 8477424, status: 'CONFIRMED', availableAt: '2023-10-10T20:00:00Z', source: { ...source, fetchedAt: '2023-10-10T20:01:00Z' } };
  assert.equal(normalizeNhlGoalieEvidence(evidence, { game, roster: goalieRoster }).status, 'UNKNOWN');
  const confirmed = normalizeNhlGoalieEvidence({ ...evidence, source: { ...evidence.source, confirmationExplicit: true } }, { game, roster: goalieRoster });
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(normalizeNhlGoalieEvidence({ ...evidence, source: { ...evidence.source, confirmationExplicit: true } }, { game, roster: goalieRoster, now: NaN }).status, 'UNKNOWN');
  for (const availableAt of ['2023-10-10', '2023-10-10T20:00:00']) assert.equal(normalizeNhlGoalieEvidence({ ...evidence, availableAt, source: { ...evidence.source, confirmationExplicit: true } }, { game, roster: goalieRoster }).status, 'UNKNOWN');
  assert.equal(detectNhlGoalieChange({ ...confirmed, status: 'PROJECTED' }, confirmed).invalidateAnalysis, true);
  assert.equal(detectNhlGoalieChange(confirmed, { ...confirmed, playerId: 8480947, availableAt: '2023-10-10T19:00:00Z' }).issue, 'NHL_GOALIE_UPDATE_OUT_OF_ORDER');
});

await test('event situations separate 5v5/PP/empty net/SO and never pretend counts are xG or exposure', () => {
  const base = { awayTeam: { id: 18 }, homeTeam: { id: 14 } };
  const make = (eventId, situationCode, typeDescKey, teamId, periodType = 'REG') => ({ eventId, situationCode, typeDescKey, periodDescriptor: { periodType }, details: { eventOwnerTeamId: teamId } });
  const events = [make(1, '1551', 'goal', 18), make(2, '1541', 'shot-on-goal', 18), make(3, '0551', 'goal', 14), make(4, '1551', 'goal', 18, 'SO'), make(5, null, 'shot-on-goal', 18)];
  const stats = deriveNhlEventStatistics({ ...base, plays: [...events, events[0]] }, source);
  assert.equal(stats.away.fiveOnFive.goals, 1); assert.equal(stats.away.fiveOnFive.shotsOnGoal, 1); assert.equal(stats.away.powerPlay.shotsOnGoal, 1); assert.equal(stats.home.fiveOnFive.goals, 0); assert.equal(stats.unknownSituationEvents, 1); assert.equal(stats.xGF, null); assert.equal(stats.timeOnIce5v5, null); assert.equal(stats.powerPlayOpportunities, null);
});

await test('situation ratios pair PP against PK, not opponent PP, and preserve zero denominators', () => {
  const make = (eventId, team, situationCode, typeDescKey = 'shot-on-goal') => ({ eventId, situationCode, typeDescKey, periodDescriptor: { periodType: 'REG' }, details: { eventOwnerTeamId: team } });
  const stats = deriveNhlEventStatistics({ awayTeam: { id: 18 }, homeTeam: { id: 14 }, plays: [
    make(1, 18, '1541', 'goal'), make(2, 18, '1541'), make(3, 14, '1541'),
    make(4, 14, '1451', 'goal'), make(5, 18, '1551', 'missed-shot'),
  ] });
  assert.equal(stats.ok, true);
  assert.equal(stats.away.powerPlay.shotsOnGoalAgainst, 1);
  assert.equal(stats.away.powerPlay.goalsAgainst, 0);
  assert.equal(stats.away.powerPlay.shotShare, 2 / 3);
  assert.equal(stats.away.powerPlay.shootingPercent, 0.5);
  assert.equal(stats.away.powerPlay.savePercent, 1);
  assert.equal(stats.home.shortHanded.savePercent, 0.5);
  assert.equal(stats.away.shortHanded.goalsAgainst, 1);
  assert.equal(stats.away.fiveOnFive.savePercent, null);
  assert.equal(stats.away.fiveOnFive.shotShare, null);
  assert.equal(stats.away.fiveOnFive.unblockedAttempts, 1);
  assert.equal(stats.home.fiveOnFive.unblockedAttemptsAgainst, 1);
  assert.equal(stats.metricScope, 'OBSERVED_EVENTS_NOT_PREGAME_FEATURES');
  assert.equal(stats.rateMetrics, null);
});

await test('event conflicts block irrespective of order; identical duplicates do not inflate shots', () => {
  const event = { eventId: 1, situationCode: '1551', typeDescKey: 'goal', periodDescriptor: { periodType: 'REG' }, details: { eventOwnerTeamId: 18 } };
  const base = { awayTeam: { id: 18 }, homeTeam: { id: 14 } };
  assert.equal(deriveNhlEventStatistics({ ...base, plays: [event, structuredClone(event)] }).away.fiveOnFive.goals, 1);
  for (const broken of [{ ...event, eventId: null }, { ...event, periodDescriptor: {} }, { ...event, details: { eventOwnerTeamId: 999 } }]) {
    assert.equal(deriveNhlEventStatistics({ ...base, plays: [broken] }).status, 'BLOCK');
  }
  const changed = { ...event, typeDescKey: 'shot-on-goal' };
  for (const plays of [[event, changed, event], [changed, event]]) {
    const result = deriveNhlEventStatistics({ ...base, plays });
    assert.equal(result.status, 'BLOCK'); assert.equal(result.away, undefined);
    assert.ok(result.issues.includes('NHL_PBP_EVENT_REVISION_CONFLICT'));
  }
  assert.equal(deriveNhlEventStatistics({ ...base, homeTeam: { id: 18 }, plays: [] }).status, 'BLOCK');
  const incomplete = deriveNhlEventStatistics({ ...base, plays: [event, { ...event, eventId: 2, situationCode: null }] });
  assert.equal(incomplete.status, 'WARNING'); assert.equal(incomplete.away.fiveOnFive.goals, 1);
  assert.equal(incomplete.away.fiveOnFive.shootingPercent, null);
});

await test('actual official PBP resolves blocked shot actors and source-derived ratios', () => {
  const pbp = load('pbp-2023020001.json');
  const stats = deriveNhlEventStatistics(pbp, { ...source, url: source.url.replace('/landing', '/play-by-play') });
  assert.equal(stats.ok, true); assert.equal(stats.unknownSituationEvents, 0); assert.equal(stats.unresolvedBlocks, 0);
  assert.equal(stats.away.fiveOnFive.shotShare, 18 / 40);
  assert.equal(stats.away.fiveOnFive.savePercent, 21 / 22);
  assert.equal(stats.away.fiveOnFive.blockedShots, 7);
  assert.equal(stats.away.fiveOnFive.blockedShotAttempts, 14);
  assert.equal(stats.home.fiveOnFive.blockedShots, 13);
  assert.equal(stats.away.fiveOnFive.teammateBlockedAttempts, 1);
  assert.equal(stats.home.fiveOnFive.teammateBlockedAttempts, 1);
  assert.equal(stats.away.fiveOnFive.shotAttempts, 37);
  const missingRoster = deriveNhlEventStatistics({ ...pbp, rosterSpots: [] });
  assert.equal(missingRoster.away.fiveOnFive.blockedShots, null);
  assert.equal(missingRoster.away.fiveOnFive.shotAttempts, null);
  assert.ok(missingRoster.unresolvedBlocks > 0);
});

await test('actual right-rail PP opportunities and scratches are game-specific, not injury or PIT evidence', () => {
  const report = load('right-rail-2023020001.json');
  const game = normalizeNhlGame(raw, { source, boxscore: load('boxscore-2023020001.json') });
  const origin = { ...source, url: source.url.replace('/landing', '/right-rail') };
  const result = normalizeNhlGameReport(report, game, origin);
  assert.equal(result.ok, true); assert.equal(result.away.powerPlayOpportunities, 4);
  assert.equal(result.home.powerPlayOpportunities, 5); assert.equal(result.away.powerPlayPercent, 1 / 4);
  assert.equal(result.away.penaltyKillPercent, 1 - 2 / 5); assert.equal(result.home.penaltyKillPercent, 1 - 1 / 4);
  assert.equal(result.away.scratches.length, 3); assert.equal(result.away.scratches[0].playerId, 8477446);
  assert.equal(result.away.scratches[0].sourcePublishedAt, null); assert.equal(result.pregamePointInTimeVerified, false);
  assert.equal(result.seasonSeries, undefined);
  for (const mutate of [
    x => { x.seasonSeries[0].homeTeam.id = 18; },
    x => { x.teamGameStats.push(x.teamGameStats[0]); },
    x => { x.teamGameStats.find(r => r.category === 'powerPlay').awayValue = '5/4'; },
    x => { x.gameInfo.awayTeam.scratches.push(x.gameInfo.homeTeam.scratches[0]); },
    x => { x.gameInfo.awayTeam.scratches[0].id = 8475158; },
    x => { x.gameInfo.awayTeam.scratches[0].id = 8476453; },
    x => { x.teamGameStats = {}; },
  ]) { const changed = structuredClone(report); mutate(changed); assert.equal(normalizeNhlGameReport(changed, game, origin).status, 'BLOCK'); }
  assert.equal(normalizeNhlGameReport(report, game, { ...origin, url: origin.url.replace('0001', '0002') }).status, 'BLOCK');
});

await test('schedule rest context handles DST, prior history and unknown travel honestly', () => {
  const game = { leagueId: 'NHL', gameId: '2023021000', awayTeamId: 18, homeTeamId: 14, startTimeUTC: '2024-03-10T23:00:00Z', venueTimezone: 'America/New_York' };
  const prior = { ...game, gameId: '2023020990', startTimeUTC: '2024-03-10T00:00:00Z' };
  const result = buildNhlScheduleContext(game, [prior, { ...prior, leagueId: 'NBA', startTimeUTC: '2024-03-10T22:00:00Z' }]);
  assert.equal(result.away.backToBack, null); assert.equal(result.away.restDays, null); assert.equal(result.away.gamesPast7Days, null); assert.equal(result.away.travelKm, null); assert.equal(result.away.observedElapsedHours, 23);
  const complete = buildNhlScheduleContext(game, [prior], {}, { coverage: { complete: true, from: '2024-03-01T00:00:00Z', to: game.startTimeUTC, source } });
  assert.equal(complete.away.backToBack, true); assert.equal(complete.away.restDays, 0); assert.equal(complete.away.elapsedHours, 23); assert.equal(complete.away.gamesPast7Days, 1);
});

await test('source cache callers cannot mutate another caller or the retained source evidence', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return response(structuredClone(raw)); };
  const first = await fetchNhlJson(source.url, { fetchImpl });
  const originalHash = first.source.contentHash;
  first.data.awayTeam.id = 999;
  first.source.contentHash = 'changed-by-consumer';
  const second = await fetchNhlJson(source.url, { fetchImpl });
  assert.equal(second.data.awayTeam.id, raw.awayTeam.id);
  assert.equal(second.source.contentHash, originalHash);
  second.data.homeTeam.id = 998;
  const third = await fetchNhlJson(source.url, { fetchImpl });
  assert.equal(third.data.homeTeam.id, raw.homeTeam.id);
  assert.equal(requests, 1);
});

await test('coalesced source requests share network work but not mutable payload references', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; await new Promise(resolve => setTimeout(resolve, 5)); return response(structuredClone(roster)); };
  const url = 'https://api-web.nhle.com/v1/roster/TOR/20232024';
  const [first, second] = await Promise.all([fetchNhlJson(url, { fetchImpl }), fetchNhlJson(url, { fetchImpl })]);
  first.data.forwards[0].id = 999;
  assert.equal(second.data.forwards[0].id, roster.forwards[0].id);
  assert.equal(requests, 1);
});

await test('invalid and duplicate roster identities block instead of silently dropping or duplicating players', async () => {
  for (const kind of ['missing', 'duplicate', 'conflicting-fields']) {
    const payload = structuredClone(roster);
    if (kind === 'missing') delete payload.forwards[0].id;
    if (kind === 'duplicate') payload.defensemen.push(structuredClone(payload.forwards[0]));
    if (kind === 'conflicting-fields') payload.forwards[0].playerId = payload.forwards[0].id + 1;
    const result = await fetchNhlRoster({ abbrev: 'TOR', teamId: 10 }, 20232024, { fetchImpl: async () => response(payload) });
    assert.equal(result.ok, false, kind);
    assert.equal(result.status, 'BLOCK', kind);
    assert.equal(result.code, 'NHL_ROSTER_IDENTITY_INVALID', kind);
    assert.deepEqual(result.players, [], kind);
    assert.ok(result.source.contentHash, kind);
  }
});

console.log(`NHL data tests: ${passed} groups passed (real official fixtures plus labelled counterexamples).`);
