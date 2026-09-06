import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fetchNhlTeamSummary } from '../lib/nhl/data.js';
import { nhlTeamSummaryUrl, normalizeNhlTeamSummary, validNhlTeamSummaryScope } from '../lib/nhl/team-summary.js';
const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/nhl/team-summary-NSH-20232024-2.json', import.meta.url)));
const scope = { teamId: 18, season: 20232024, gameType: 2 };
const source = { provider: 'NHL', url: nhlTeamSummaryUrl(18, 20232024, 2), fetchedAt: '2026-09-06T17:43:13.041Z' };
const normalize = (data = raw, query = scope, provenance = source) => normalizeNhlTeamSummary(data, query, provenance);
let groups = 0;
async function test(name, fn) { await fn(); console.log(`PASS ${name}`); groups++; }
await test('real official team summary keeps exact counts, fractions and retrospective scope', () => {
  const value = normalize(); assert.equal(value.ok, true); assert.equal(value.status, 'OK');
  assert.equal(value.statistics.gamesPlayed, 82); assert.equal(value.statistics.wins, 47);
  assert.equal(value.statistics.powerPlayPct, 0.215613); assert.equal(value.statistics.penaltyKillPct, 0.769231);
  assert.equal(value.pregamePointInTimeVerified, false); assert.equal(value.fiveOnFive, null); assert.equal(value.xGF, null);
  assert.equal(value.statistics.savePct, undefined); assert.equal(value.statistics.shotsFor, undefined);
});
await test('explicit phase and consecutive season are required before any source request', async () => {
  for (const args of [[18, 20232025, 2], [18, 20232024, 0], [18, 20232024, '2'], [0, 20232024, 2], [18, 2023, 2], [18, 19161917, 2]]) {
    assert.equal(validNhlTeamSummaryScope(...args), false);
    assert.equal((await fetchNhlTeamSummary(...args, { fetchImpl: () => { throw new Error('must not fetch'); } })).ok, false);
  }
});
await test('foreign team, season, phase, duplicate and truncated rows block', () => {
  for (const mutate of [x => x.data[0].teamId = 10, x => x.data[0].seasonId = 20242025,
    x => x.data[0].gameTypeId = 1, x => x.data.push(structuredClone(x.data[0])), x => x.total = 2,
    x => x.data = [null], x => x.total = '1']) {
    const data = structuredClone(raw); mutate(data); assert.equal(normalize(data).status, 'BLOCK');
  }
});
await test('query identity cannot be replaced by another phase, an aggregate or foreign source', () => {
  for (const url of [nhlTeamSummaryUrl(18, 20232024, 1), source.url.replace('isAggregate=false', 'isAggregate=true'),
    source.url.replace('api.nhle.com', 'example.com'), source.url + '&isGame=false', source.url + '#fragment'])
    assert.equal(normalize(raw, scope, { ...source, url }).status, 'BLOCK');
});
await test('missing official rows are EMPTY, malformed and coerced metrics never become zero', () => {
  assert.equal(normalize({ data: [], total: 0 }).status, 'EMPTY');
  assert.equal(normalize({ data: [], total: 0 }).statistics, null);
  for (const value of ['', '0', true, -1, NaN, Infinity, 90]) {
    const data = structuredClone(raw); data.data[0].powerPlayPct = value; assert.equal(normalize(data).status, 'BLOCK');
  }
  const missing = structuredClone(raw); delete missing.data[0].powerPlayPct;
  assert.equal(normalize(missing).status, 'WARNING'); assert.equal(normalize(missing).statistics.powerPlayPct, null);
  const zeros = structuredClone(raw); zeros.data[0].powerPlayPct = 0; assert.equal(normalize(zeros).statistics.powerPlayPct, 0);
});
await test('record integrity blocks inconsistent official totals without repairing numbers', () => {
  const data = structuredClone(raw); data.data[0].wins++; assert.equal(normalize(data).status, 'BLOCK');
  assert.equal(data.data[0].wins, 48);
  const value = normalize(); value.statistics.wins = 0; assert.equal(raw.data[0].wins, 47);
});
await test('official adapter fingerprints data and keeps 403/429/timeout failures explicit', async () => {
  const value = await fetchNhlTeamSummary(18, 20232024, 2, { fetchImpl: async url => {
    assert.equal(url, source.url); return new Response(JSON.stringify(raw));
  } });
  assert.equal(value.ok, true); assert.match(value.source.contentHash, /^[a-f0-9]{64}$/);
  for (const status of [403, 429, 503]) {
    const failed = await fetchNhlTeamSummary(18, 20232024, 2, { retry: false, fetchImpl: async () => new Response('{}', { status }) });
    assert.equal(failed.ok, false); assert.equal(failed.httpStatus, status);
  }
  const failed = await fetchNhlTeamSummary(18, 20232024, 2, { retry: false, timeoutMs: 5, fetchImpl: () => new Promise(() => {}) });
  assert.equal(failed.code, 'NHL_SOURCE_TIMEOUT');
});
console.log(`NHL team summary: ${groups} groups PASS; real official fixture, labelled counterexamples, no pregame-calibration claim.`);
