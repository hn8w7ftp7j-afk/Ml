import assert from 'node:assert/strict';
import { PERFORMANCE_LEAGUE_IDS, performanceLeagueId, performanceLeagueConfig, loadNbaPerformanceLedger } from '../lib/performance-ledger-client.js';
import { LEAGUE_IDS } from '../lib/leagues.js';

assert.deepEqual(PERFORMANCE_LEAGUE_IDS, ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA']);
assert.deepEqual(LEAGUE_IDS, ['MLB', 'NPB', 'KBO', 'CPBL'], 'display changes cannot widen baseball model or API registry');
assert.equal(performanceLeagueId(' nba '), 'NBA');
assert.equal(performanceLeagueId('NHL'), null, 'unsupported sport cannot become MLB');
assert.equal(performanceLeagueId(null), 'MLB', 'legacy untagged MLB remains visible');
assert.equal(performanceLeagueConfig('NBA').shortLabel, '美籃');
const bet = id => ({ id: `nba-manual:${id}`, nativeRecordId: id, league: 'NBA', ledgerSource: 'NBA_MANUAL_V1' });
const page = (bets, totalRecords, hasMore = false, nextCursor = null) => ({ ok: true, bets,
  pagination: { returnedRecords: bets.length, totalRecords, invalidRecordsOnPage: 0, hasMore, nextCursor } });
let calls = [];
const pages = [page([bet('one')], 2, true, 'cursor/two'), page([bet('two')], 2)];
const result = await loadNbaPerformanceLedger(async (url, options) => { calls.push({ url, options }); return pages.shift(); });
assert.equal(result.bets.length, 2);
assert.match(calls[0].url, /^\/api\/nba\/performance\?limit=500$/);
assert.match(calls[1].url, /cursor=cursor%2Ftwo/);
assert.deepEqual(calls[0].options, {}, 'page entry reads only; never auto-settles or modifies records');
assert.deepEqual((await loadNbaPerformanceLedger(async () => page([], 0))).bets, []);
await assert.rejects(loadNbaPerformanceLedger(async () => page([{ ...bet('one'), league: 'MLB' }], 1)), { code: 'LEDGER_RESPONSE_INVALID' });
let count = 0;
await assert.rejects(loadNbaPerformanceLedger(async () => {
  if (++count === 2) throw Error('later page unavailable');
  return page([bet('one')], 2, true, 'next');
}), /later page unavailable/, 'partial NBA ledger must not become complete statistics');
await assert.rejects(loadNbaPerformanceLedger(async () => page([bet('one')], 3)), { code: 'LEDGER_RESPONSE_INVALID' });
console.log('PASS NBA performance client: independent league scope, complete pagination, fail-closed partial reads, read-only entry');
