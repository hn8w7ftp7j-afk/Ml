import assert from 'node:assert/strict';
import {
  PERFORMANCE_LEAGUE_IDS, performanceLeagueId, performanceLeagueConfig,
  loadSoccerPerformanceLedger, performanceStatsReady,
} from '../lib/performance-ledger-client.js';
import { LEAGUE_IDS } from '../lib/leagues.js';

const uuid = n => `22222222-2222-4222-8222-${n.toString(16).padStart(12, '0')}`;
const bet = (league, n) => ({
  id: `soccer-manual:${league}:${uuid(n)}`, nativeRecordId: uuid(n), nativeLeague: league,
  league: league.toUpperCase(), ledgerSource: 'SOCCER_MANUAL_V1',
});
const page = (league, bets, totalRecords, hasMore = false, nextCursor = null, invalidRecordsOnPage = 0) => ({
  ok: true, league, bets,
  pagination: { returnedRecords: bets.length, totalRecords, invalidRecordsOnPage, hasMore, nextCursor },
});
const invalid = { code: 'LEDGER_RESPONSE_INVALID' };

assert.deepEqual(PERFORMANCE_LEAGUE_IDS, ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'EPL', 'UCL']);
assert.deepEqual(LEAGUE_IDS, ['MLB', 'NPB', 'KBO', 'CPBL'], 'display scope must not widen baseball adapters');
for (const [league, name] of [['epl', '英超'], ['ucl', '歐冠']]) {
  const id = league.toUpperCase();
  assert.equal(performanceLeagueId(` ${league} `), id);
  assert.equal(performanceLeagueConfig(id).shortLabel, name);
  const calls = [];
  const pages = [page(league, [bet(league, 1)], 2, true, 'cursor/second'), page(league, [bet(league, 2)], 2)];
  const result = await loadSoccerPerformanceLedger(async (url, init, timeout) => {
    calls.push({ url, init, timeout }); return pages.shift();
  }, id);
  assert.equal(result.bets.length, 2);
  assert.equal(result.pagination.pages, 2);
  assert.equal(result.pagination.loadedRecords, 2);
  assert.equal(calls[0].url, `/api/soccer/performance?league=${league}&limit=500`);
  assert.equal(calls[1].url, `/api/soccer/performance?league=${league}&limit=500&cursor=cursor%2Fsecond`);
  assert.deepEqual(calls[0].init, {}, 'entry and refresh only read the native ledger');
  assert.ok(calls[0].timeout > 0 && calls[0].timeout <= 15000);
  assert.deepEqual((await loadSoccerPerformanceLedger(async () => page(league, [], 0), league)).bets, []);
  const quarantined = await loadSoccerPerformanceLedger(async () => page(league, [bet(league, 1)], 2, false, null, 1), id);
  assert.equal(quarantined.pagination.invalidRecords, 1);

  const other = league === 'epl' ? 'ucl' : 'epl';
  await assert.rejects(loadSoccerPerformanceLedger(async () => page(other, [], 0), id), invalid,
    'even an empty response must prove the requested league');
  await assert.rejects(loadSoccerPerformanceLedger(async () => page(league, [bet(other, 1)], 1), id), invalid);
  for (const patch of [
    { nativeLeague: other }, { league: 'NBA' }, { ledgerSource: 'NBA_MANUAL_V1' },
    { nativeRecordId: null }, { id: `soccer-manual:${other}:${uuid(1)}` },
    { nativeRecordId: uuid(2) },
  ]) {
    await assert.rejects(loadSoccerPerformanceLedger(async () => page(league, [{ ...bet(league, 1), ...patch }], 1), id), invalid,
      'native league, display identity and mutation identity must agree');
  }
  let reads = 0;
  await assert.rejects(loadSoccerPerformanceLedger(async () => {
    reads++;
    if (reads === 2) throw Error('later page unavailable');
    return page(league, [bet(league, 1)], 2, true, 'next');
  }, id), /later page unavailable/, 'an early page cannot masquerade as complete statistics');
  assert.equal(reads, 2);
  await assert.rejects(loadSoccerPerformanceLedger(async () => page(league, [bet(league, 1)], 2), id), invalid);
  reads = 0;
  await assert.rejects(loadSoccerPerformanceLedger(async () => ++reads === 1
    ? page(league, [bet(league, 1)], 2, true, 'next')
    : page(league, [bet(league, 2)], 3), id), invalid, 'changed count invalidates the complete-read claim');
  reads = 0;
  await assert.rejects(loadSoccerPerformanceLedger(async () => ++reads === 1
    ? page(league, [bet(league, 1)], 2, true, 'next')
    : page(league, [bet(league, 1)], 2), id), invalid, 'duplicate IDs cannot double-count actual profit');
  reads = 0;
  await assert.rejects(loadSoccerPerformanceLedger(async () => page(league, [bet(league, ++reads)], 3, true, 'same'), id), invalid,
    'repeated cursors fail closed');
}
let requested = false;
await assert.rejects(loadSoccerPerformanceLedger(async () => { requested = true; }, 'NBA'), /足球聯盟/);
assert.equal(requested, false);

const ready = { baseball: 'ready', nba: 'ready', epl: 'ready', ucl: 'ready' };
assert.equal(performanceStatsReady('ALL', ready), true);
for (const [source, selected] of [['baseball', 'MLB'], ['nba', 'NBA'], ['epl', 'EPL'], ['ucl', 'UCL']]) {
  for (const state of ['loading', 'unavailable', undefined]) {
    const states = { ...ready, [source]: state };
    assert.equal(performanceStatsReady('ALL', states), false, 'ALL never publishes an incomplete source sum');
    assert.equal(performanceStatsReady(selected, states), false);
    for (const other of ['NBA', 'EPL', 'UCL'].filter(id => id !== selected)) {
      assert.equal(performanceStatsReady(other, states), true, 'one unavailable sport does not hide a complete independent league');
    }
  }
}
for (const league of LEAGUE_IDS) {
  assert.equal(performanceStatsReady(league, { ...ready, nba: 'unavailable', epl: 'unavailable', ucl: 'loading' }), true);
  assert.equal(performanceStatsReady(league, { ...ready, baseball: 'unavailable' }), false);
}
assert.equal(performanceStatsReady('NHL', ready), false);
console.log('PASS soccer performance client: isolated EPL/UCL routes, full pagination, identity receipts, empty/partial failures and independent complete-statistics gates');
