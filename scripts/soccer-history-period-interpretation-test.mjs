import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseSoccerCapture, canonicalSoccerPayload } from '../reader/soccer-parser.js';
import { soccerJournalHash } from '../lib/soccer/journal.js';
import { interpretSoccerHistoryPeriods } from '../lib/soccer/history-period-interpretation.js';
import { expandSoccerMarketHistoryRow } from '../lib/soccer/market-history-row.js';
import { validateHistoryResponse, historyDisplayMarkets, historyInterpretationSummary } from '../app/market-line-history/history-view.js';

const observedAt = '2026-11-06T21:58:20.351Z';
const persistedAt = '2026-11-06T21:58:24.115Z';
const now = Date.parse('2026-11-08T02:00:00.000Z');
const PRIMARY = ['時間', '主客隊伍', '讓球', '大小盤', '獨贏', '單雙', '備註'];
const HALF = ['時間', '主客隊伍', '上半讓球', '上半大小', '', '單雙', '備註'];
const emptyMoneyline = ['主勝 -', '和 -', '客勝 -'];
function fixture(changeSource = () => {}) {
  const row = (runline, total, moneyline = emptyMoneyline) => ({ cells: [
    { pair: ['11-07', '04:00'] }, { pair: ['高雲地利', '愛華頓[主]'] },
    { pair: runline }, { pair: total }, { pair: moneyline },
  ] });
  const source = { league: 'EPL', pageLeagueLabel: '聯盟: 英格蘭超級聯賽(25)', sourceHost: 'www.tai888.in',
    pageUrl: 'https://www.tai888.in/newapp/', observedAt, tables: [
      { sectionTitle: '聯盟: 英格蘭超級聯賽(25)', headers: [...PRIMARY], rows: [
        row(['1.050', '1+50 0.750'], ['大3+50 0.930', '小 0.890'], ['主勝 0.550', '和 3.050', '客勝 3.700']),
        row(['1.300', '0.5 0.640'], ['大2.5 0.720', '小 1.160']),
        row(['0.770', '1平 1.100'], ['大3平 1.250', '小 0.660']),
      ] },
      { sectionTitle: '聯盟: 英格蘭超級聯賽(25)', headers: [...HALF], rows: [
        row(['1.080', '0-50 0.800'], ['大1-50 1.110', '小 0.760']),
        row(['0.700', '0.5 1.220'], ['大1平 0.650', '小 1.270']),
        row(['0.460', '1+50 1.740'], ['大1.5 1.500', '小 0.530']),
      ] },
    ] };
  changeSource(source);
  const payload = { ...parseSoccerCapture(source, new Date(observedAt)), readerVersion: '2.1.56',
    pageActivityAt: observedAt, deviceId: 'synthetic-new-reader-device' };
  payload.contentHash = createHash('sha256').update(canonicalSoccerPayload(payload)).digest('hex');
  const game = payload.games[0];
  const observationId = soccerJournalHash(payload);
  return { payload, game, league: 'EPL', boardDate: payload.boardDate,
    gameKey: `${game?.boardTime}|${game?.awayKey}|${game?.homeKey}`,
    observationId, contentHash: payload.contentHash, observedAt, persistedAt, now };
}
const resign = input => {
  input.payload.contentHash = input.contentHash = createHash('sha256').update(canonicalSoccerPayload(input.payload)).digest('hex');
  input.observationId = soccerJournalHash(input.payload);
  return input;
};
const derived = result => result.displayContracts.filter(contract => contract.historyPeriodInterpretation);
const original = fixture(), before = JSON.stringify(original);
const result = interpretSoccerHistoryPeriods(original);
assert.equal(result.historyInterpretation.interpretedContractCount, 7, 'all three handicaps, totals and MONEYLINE are displayed');
assert.equal(derived(result).length, 7);
assert.ok(derived(result).every(contract => contract.period === 'FT' && contract.periodEvidence.period === 'UNKNOWN'
  && contract.historyPeriodInterpretation.originalPeriod === 'UNKNOWN'
  && contract.historyPeriodInterpretation.interpretedAt === new Date(now).toISOString()
  && contract.historyPeriodInterpretation.historicalAvailabilityVerified === false
  && contract.historyPeriodInterpretation.executable === false));
assert.equal(result.displayContracts.filter(contract => contract.period === 'HT').length, 6);
assert.equal(JSON.stringify(original), before, 'original source, raw period, hashes and timestamps remain immutable');
result.displayContracts[0].rawRows[0] = 'display-only mutation';
assert.equal(JSON.stringify(original), before, 'returned contracts do not alias original cells');

for (const [name, change] of [
  ['wrong payload hash', input => { input.contentHash = 'f'.repeat(64); }],
  ['wrong observation identity', input => { input.observationId = 'f'.repeat(64); }],
  ['quote changed after hashing', input => { input.game.markets[0].line = '9平'; }],
  ['header changed after hashing', input => { input.game.markets[0].periodEvidence.tableHeaders[2] = '角球'; }],
  ['wrong source host', input => { input.payload.sourceHost = 'other.tai888.in'; resign(input); }],
  ['wrong source page', input => { input.payload.pageUrl = 'https://www.tai888.in/another/'; resign(input); }],
  ['credentialed source page', input => { input.payload.pageUrl = 'https://someone@www.tai888.in/newapp/'; resign(input); }],
  ['source identity from another league', input => { input.league = 'UCL'; }],
  ['wrong game key', input => { input.gameKey = '04:00|another|愛華頓'; }],
  ['duplicate game identity', input => { input.payload.games.push(structuredClone(input.game)); resign(input); }],
  ['primary market sourced from another capture', input => { input.game.markets[0].serverObservation = { observationId: 'f'.repeat(64) }; resign(input); }],
  ['half market sourced from another capture', input => { input.game.markets.filter(m => m.period === 'HT').forEach(m => { m.serverObservation = { observationId: 'f'.repeat(64) }; }); resign(input); }],
  ['primary locked', input => { input.game.periodStates.UNKNOWN = 'locked'; resign(input); }],
  ['half locked', input => { input.game.periodStates.HT = 'locked'; resign(input); }],
  ['all markets locked', input => { input.game.marketStatus = 'locked'; resign(input); }],
  ['source before interpretation', input => { input.now = Date.parse(observedAt) - 1; }],
  ['persistence before interpretation', input => { input.now = Date.parse(persistedAt) - 1; }],
  ['missing source tables', input => { delete input.payload.sourceCapture; resign(input); }],
]) {
  const input = fixture(); change(input);
  assert.equal(interpretSoccerHistoryPeriods(input).historyInterpretation, null, name);
}
for (const [name, change] of [
  ['truncated primary', source => { source.tables[0].periodEvidenceTruncated = true; }],
  ['truncated half', source => { source.tables[1].periodEvidenceTruncated = true; }],
  ['unscoped primary headers', source => { source.tables[0].headers[2] = '其他讓球'; }],
  ['missing half', source => { source.tables.pop(); }],
  ['different half league', source => { source.tables[1].sectionTitle = '聯盟: 歐洲冠軍聯賽(25)'; }],
  ['different half game', source => { source.tables[1].rows.forEach(row => { row.cells[1].pair = ['曼城', '利物浦[主]']; }); }],
  ['different half kickoff', source => { source.tables[1].rows.forEach(row => { row.cells[0].pair = ['11-07', '05:00']; }); }],
  ['live scope', source => { source.tables[0].sectionTitle = '聯盟: 英格蘭超級聯賽(25) 走地'; }],
]) assert.equal(interpretSoccerHistoryPeriods(fixture(change)).historyInterpretation, null, name);

// A caller cannot append a convenient companion to a game that is not exactly
// the immutable same-observation game, even while retaining a valid payload.
const crossCapture = fixture(source => { source.tables.pop(); });
crossCapture.game = { ...crossCapture.game, markets: [...crossCapture.game.markets,
  ...fixture().game.markets.filter(market => market.period === 'HT')] };
assert.equal(interpretSoccerHistoryPeriods(crossCapture).historyInterpretation, null);

const input = fixture();
const rawRow = { league: input.league, board_date: input.boardDate, game_key: input.gameKey,
  observed_at: input.observedAt, received_at: '2026-11-06T21:58:24.100Z', persisted_at: input.persistedAt,
  observation_id: input.observationId, content_hash: input.contentHash, record_id: `${input.observationId}:1`,
  payload: input.payload, game: input.game };
const expanded = expandSoccerMarketHistoryRow(rawRow, { now });
assert.deepEqual(expanded.markets.map(market => market.status), ['PERIOD_UNKNOWN', 'PERIOD_UNKNOWN', 'AVAILABLE', 'AVAILABLE']);
assert.equal(expanded.historyInterpretation.interpretedContractCount, 7);
assert.equal(expanded.displayMarkets.length, 5);
assert.equal(expanded.displayMarkets[0].status, 'RETROSPECTIVE_INTERPRETATION');
assert.equal(expanded.displayMarkets[0].contracts.length, 3);
assert.equal(expanded.displayMarkets[0].directions.length, 6);
assert.equal(expanded.displayMarkets[0].directions[1].pick, '愛華頓讓1+50');
assert.equal(expanded.displayMarkets[0].directions[0].water, 1.05);
assert.equal(expanded.displayMarkets[0].directions[1].water, 0.75);
assert.equal(expanded.gameLabel, '高雲地利 @ 愛華頓 04:00');
const ml = expanded.displayMarkets.find(market => market.kind === 'MONEYLINE');
assert.deepEqual(ml.directions.map(direction => [direction.side, direction.water]), [['away', 3.7], ['draw', 3.05], ['home', 0.55]]);
assert.equal(expanded.rawMarkets, JSON.stringify(input.game.markets));
assert.equal(expanded.rawGame, input.game);
assert.equal(expanded.historicalAvailabilityVerified, false); assert.equal(expanded.executable, false);
assert.equal(soccerJournalHash(input.payload), input.observationId);
const envelope = { ok: true, schema: 'market-line-history-query-v1', sourceTable: 'tai888_market_line_history_v1',
  sourceTables: ['tai888_market_line_history_v1', 'sports_soccer_reader_observations_v2'],
  until: new Date(now).toISOString(), rows: [expanded], leagues: [],
  totals: { savedStates: 1, gameDateKeys: 1, boardDates: 1 }, hasMore: false, nextAfter: null };
assert.equal(validateHistoryResponse(envelope), envelope, 'actual backend row satisfies strict UI schema');
assert.equal(historyDisplayMarkets(expanded), expanded.displayMarkets);
assert.match(historyInterpretationSummary(expanded), /不代表當時已可分析或下注/);
console.log('PASS: same-observation retrospective FT display, all alternative lines/MONEYLINE, original immutable hash/raw periods, human-readable teams, strict UI contract, malicious/truncated/cross-capture/league/source/lock/time rejection; NOT Production');
