import assert from 'node:assert/strict';
import { deriveNbaBoxscore } from '../lib/nba/basketball.js';
import { analyzeNbaShadow, nbaScheduleContext } from '../lib/nba/shadow.js';
import { cancelNbaShadow, nbaShadowKey, readNbaShadow, runNbaShadow } from '../lib/nba/shadow-client.js';
let checks = 0;
async function test(name, action) { await action(); checks += 1; console.log(`PASS ${name}`); }
const stat = (name, displayValue) => ({ name, displayValue: String(displayValue) });
// Synthetic unit-test fixtures, never treated as a historical dataset.
function team(id, i = 0) {
  const made = 35 + i % 9; const three = 8 + i % 4; const ft = 12 + i % 7;
  const score = 2 * made + three + ft;
  return { id: `nba:espn:team:${id}`, score, periodScores: [20, 25, 25, score - 70].map((score, index) => ({ period: index + 1, score })), statistics: [
    stat('fieldGoalsMade-fieldGoalsAttempted', `${made}-${80 + i % 11}`), stat('threePointFieldGoalsMade-threePointFieldGoalsAttempted', `${three}-30`), stat('freeThrowsMade-freeThrowsAttempted', `${ft}-24`), stat('offensiveRebounds', 10), stat('defensiveRebounds', 30), stat('totalRebounds', 40), stat('turnovers', 12), stat('teamTurnovers', 1), stat('totalTurnovers', 13)] };
}
function game(i, year = 2026, type = 'regular') {
  const date = new Date(Date.UTC(year - 1, 9, 1 + i * 2)).toISOString();
  const home = team(i % 2 ? '18' : '5', i); const away = team(i % 2 ? '5' : '18', i + 3);
  return { id: `nba:espn:game:${900000 + i + (year - 2026) * 1000}`, sourceId: String(900000 + i + (year - 2026) * 1000), league: 'NBA', startTime: date, taipeiDate: date.slice(0, 10), season: { year, type }, seasonType: type, status: 'final', completed: true, home, away, venue: i % 2 ? 'Synthetic NY venue' : 'Synthetic CLE venue' };
}
const options = { teamId: 'nba:espn:team:5', seasonType: 'regular' };
const games = Array.from({ length: 65 }, (_, i) => game(i));
await test('possessions use team total turnovers and one shared denominator', () => {
  const g = game(0); const box = deriveNbaBoxscore(g);
  const expected = ((80 + 0.44 * 24 - 10 + 13) + (83 + 0.44 * 24 - 10 + 13)) / 2;
  assert.equal(box.status, 'ready'); assert.equal(box.possessions, expected); assert.equal(box.pace, expected);
  assert.equal(box.home.offensiveRating, box.away.defensiveRating);
  assert.equal(box.home.netRating, -box.away.netRating);
});
await test('missing team turnovers are null, never silently use player turnovers', () => {
  const g = game(0); g.home.statistics = g.home.statistics.filter(r => r.name !== 'totalTurnovers');
  assert.equal(deriveNbaBoxscore(g).possessions, null);
});
await test('shooting arithmetic, made attempts and team turnovers conflict BLOCK', () => {
  for (const [name, value] of [['fieldGoalsMade-fieldGoalsAttempted', '90-80'], ['freeThrowsMade-freeThrowsAttempted', '0-24'], ['totalTurnovers', '99'], ['totalRebounds', '41']]) {
    const g = game(0); g.home.statistics.find(r => r.name === name).displayValue = value;
    assert.equal(deriveNbaBoxscore(g).status, 'blocked', name);
  }
});
await test('duplicate named statistics and foreign identities BLOCK', () => {
  const g = game(0); g.home.statistics.push(g.home.statistics[0]); assert.equal(deriveNbaBoxscore(g).status, 'blocked');
  assert.equal(deriveNbaBoxscore({ ...game(0), league: 'MLB' }).status, 'blocked');
});
await test('missing duration does not fabricate 48 minutes', () => {
  const g = game(0); g.home.periodScores = []; const box = deriveNbaBoxscore(g);
  assert.equal(box.status, 'ready'); assert.equal(box.pace, null); assert.ok(box.possessions > 0);
});
await test('overtime duration requires tied regulation and final total reconciliation', () => {
  const g = game(0); const regulation = Math.min(g.home.score, g.away.score) - 10;
  for (const side of ['home', 'away']) g[side].periodScores = [20, 20, 20, regulation - 60, g[side].score - regulation].map((score, index) => ({ period: index + 1, score }));
  const box = deriveNbaBoxscore(g); assert.equal(box.minutes, 53); assert.equal(box.pace, box.possessions * 48 / 53);
  g.home.periodScores[3].score -= 1; g.home.periodScores[4].score += 1;
  assert.equal(deriveNbaBoxscore(g).status, 'blocked');
});
await test('Usage preserves true zero, missing minutes and unbounded estimates', () => {
  const g = game(0);
  const player = { id: 'nba:espn:player:123', teamId: g.home.id, statistics: [stat('minutes', '1:30'), stat('fieldGoalsMade-fieldGoalsAttempted', '0-2'), stat('freeThrowsMade-freeThrowsAttempted', '0-0'), stat('turnovers', 3)] };
  const box = deriveNbaBoxscore(g, [player]); assert.equal(box.players[0].minutes, 1.5); assert.ok(box.players[0].usageEstimate > 100, 'not capped to appear plausible');
  player.statistics[0].displayValue = '0'; assert.equal(deriveNbaBoxscore(g, [player]).players[0].usageEstimate, null);
  player.statistics[0].displayValue = '48:60'; assert.equal(deriveNbaBoxscore(g, [player]).players[0].usageEstimate, null);
});
await test('future and other-season games cannot change schedule rest context', () => {
  const g = game(5); const a = nbaScheduleContext(g, options.teamId, games);
  const b = nbaScheduleContext(g, options.teamId, games.slice(0, 5)); assert.deepEqual(a, b); assert.equal(a.restDays, 1);
  assert.equal(a.actualTravelVerified, false); assert.equal(a.travelDistanceKm, null);
});
await test('walk-forward model reports same-fold baseline and valid joint covariance', () => {
  const r = analyzeNbaShadow(games, options); assert.equal(r.status, 'ready'); assert.equal(r.counts.validation, 50);
  assert.equal(r.validation.samples, r.validation.baselineSameFolds.samples);
  assert.ok(r.folds.every(row => row.trainingThrough < row.date));
  const c = r.validation.pairedResidualCovariance; assert.equal(c[0][1], c[1][0]); assert.ok(c[0][0] * c[1][1] - c[0][1] ** 2 >= -1e-8);
  assert.ok(r.validation.jointCoverage.every(row => row.observed >= 0 && row.observed <= 1 && row.samples === 30));
  assert.equal(r.method.pointInTimeReplay, false);
  assert.equal(r.promotionEligible, false);
});
await test('permuted inputs and exact duplicates produce the same validation', () => {
  const r = analyzeNbaShadow(games, options); const shuffled = analyzeNbaShadow([...games].reverse().concat(games[0]), options);
  assert.deepEqual(shuffled.validation, r.validation); assert.deepEqual(shuffled.folds, r.folds);
});
await test('future observations do not alter previous folds or parameter selection', () => {
  const prefix = analyzeNbaShadow(games.slice(0, 45), options); const full = analyzeNbaShadow(games, options);
  assert.deepEqual(full.folds.slice(0, prefix.folds.length), prefix.folds);
});
await test('no cross-season training, no preseason contamination', () => {
  const old = Array.from({ length: 20 }, (_, i) => game(i, 2025));
  const r = analyzeNbaShadow([...old, ...games], options);
  assert.deepEqual(r.folds.filter(row => row.gameId.startsWith('nba:espn:game:900')), analyzeNbaShadow(games, options).folds);
  assert.deepEqual(analyzeNbaShadow([...games, game(100, 2026, 'preseason')], options).validation, analyzeNbaShadow(games, options).validation);
});
await test('incomplete box scores remain explicitly excluded and cannot become full PASS', () => {
  const data = structuredClone(games); data[40].home.statistics = [];
  const r = analyzeNbaShadow(data, options); assert.equal(r.status, 'partial'); assert.equal(r.counts.missing, 1);
  assert.equal(r.excluded[0].gameId, data[40].id);
});
await test('same-day games do not train each other', () => {
  const data = structuredClone(games); data[30].startTime = data[29].startTime; data[30].taipeiDate = data[29].taipeiDate;
  const r = analyzeNbaShadow(data, options); const folds = r.folds.filter(row => row.date === data[29].taipeiDate);
  assert.equal(folds.length, 2); assert.equal(folds[0].trainingRows, folds[1].trainingRows); assert.equal(folds[0].lambda, folds[1].lambda);
});
await test('invalid history and wrong research-team scope block without scores', () => {
  const invalid = structuredClone(games); invalid[0].league = 'KBO'; assert.equal(analyzeNbaShadow(invalid, options).status, 'blocked');
  assert.equal(analyzeNbaShadow(games, { ...options, teamId: 'nba:espn:team:27' }).status, 'blocked');
  assert.equal(analyzeNbaShadow([], options).validation, null);
});
const response = g => ({ league: 'NBA', status: 'ready', qa: { status: 'WARNING' }, data: { game: g }, sources: [{ url: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${g.sourceId}`, fetchedAt: '2026-09-06T00:00:00Z', hash: 'fixture' }] });
await test('client runner isolates keys, stores completed report and never starts from read', async () => {
  const input = games.slice(0, 3); let calls = 0;
  const key = nbaShadowKey(input, options.teamId, 'regular'); assert.equal(readNbaShadow(key), null);
  const job = await runNbaShadow(input, options.teamId, 'regular', { pause: async () => {}, request: async query => { calls += 1; return response(input.find(g => g.sourceId === new URLSearchParams(query).get('id'))); } });
  assert.equal(calls, 3); assert.equal(job.status, 'completed'); assert.equal(readNbaShadow(key).report.counts.features, 3);
  assert.notEqual(key, nbaShadowKey(input, options.teamId, 'preseason')); assert.equal(calls, 3);
});
await test('client cancellation is terminal and a later explicit rerun works', async () => {
  const input = games.slice(0, 2); const key = nbaShadowKey(input, options.teamId, 'regular');
  const job = await runNbaShadow(input, options.teamId, 'regular', { pause: async () => cancelNbaShadow(key), request: async () => response(input[0]) });
  assert.equal(job.status, 'cancelled'); assert.equal(job.completed, 1);
  const done = await runNbaShadow(input, options.teamId, 'regular', { pause: async () => {}, request: async query => response(input.find(g => g.sourceId === new URLSearchParams(query).get('id'))) }); assert.equal(done.status, 'completed');
});
await test('failed source cannot become fabricated box score or complete research', async () => {
  const input = games.slice(0, 1);
  const job = await runNbaShadow(input, options.teamId, 'regular', { pause: async () => {}, request: async () => { throw new Error('HTTP 503 fixture'); } });
  assert.equal(job.status, 'partial'); assert.equal(job.report.counts.missing, 1); assert.equal(job.report.validation, null);
});
await test('client identity BLOCK and conflicting source scores never degrade to partial success', async () => {
  for (const result of [{ ...response(games[0]), qa: { status: 'BLOCK' } }, response(games[1])]) {
    const job = await runNbaShadow([games[0]], options.teamId, 'regular', { pause: async () => {}, request: async () => result });
    assert.equal(job.status, 'blocked'); assert.equal(job.report, null);
    assert.equal(job.completed, 1);
  }
});
await test('invalid history preflight never calls a provider', async () => {
  let calls = 0;
  const job = await runNbaShadow([{ ...games[0], league: 'MLB' }], options.teamId, 'regular', { request: async () => { calls += 1; } });
  assert.equal(job.status, 'blocked'); assert.equal(calls, 0);
});
await test('storage quota failure is visible and never removes another league', async () => {
  const previous = globalThis.sessionStorage; let removals = 0;
  globalThis.sessionStorage = { getItem: () => '[]', setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => { removals += 1; } };
  try {
    const job = await runNbaShadow([games[0]], options.teamId, 'regular', { request: async () => response(games[0]) });
    assert.equal(job.persistence, 'memory_only'); assert.equal(job.report.counts.features, 1); assert.equal(removals, 0);
  } finally { if (previous === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previous; }
});
await test('completed report explicitly confirms successful session storage', async () => {
  const previous = globalThis.sessionStorage; let saved;
  globalThis.sessionStorage = { getItem: () => '[]', setItem: (key, value) => { saved = JSON.parse(value); } };
  try {
    const job = await runNbaShadow([games[0]], options.teamId, 'regular', { request: async () => response(games[0]) });
    assert.equal(job.persistence, 'session_storage'); assert.equal(saved[0].job.persistence, 'session_storage'); assert.equal(saved[0].job.league, 'NBA');
  } finally { if (previous === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previous; }
});
console.log(`NBA basketball/Shadow: ${checks} checks passed.`);
