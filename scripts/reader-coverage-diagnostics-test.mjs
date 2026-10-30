import assert from 'node:assert/strict';
import { readerDiagnosticCoverage, nbaSnapshotCoverage } from '../reader/coverage-diagnostics.js';
import { listReaderDiagnostics } from '../lib/reader-diagnostic-store.js';
import { nbaReaderPublicView } from '../lib/nba/reader.js';
import { buildNbaAnalysisBoard } from '../lib/nba/analysis-board.js';
import { resolveNbaReaderTeam } from '../lib/nba/reader-teams.js';

const report = () => ({ state: 'synced', rawGameCount: 8, marketCount: 30, boards: [
  { diagnostics: { expectedGameCount: 9, gameCount: 14 }, parsedGameCount: 7 },
  { diagnostics: { expectedGameCount: 10, gameCount: 16 }, parsedGameCount: 8 },
] });
const original = report(), copy = structuredClone(original);
const result = readerDiagnosticCoverage(original);
assert.equal(result.status, 'PARTIAL');
assert.equal(result.missingMarketCount, 2);
assert.deepEqual(result.sourceGaps, [
  { sourceIndex: 1, expected: 9, parsed: 7, missing: 2 },
  { sourceIndex: 2, expected: 10, parsed: 8, missing: 2 },
]);
assert.equal(result.missingGameCount, undefined, 'overlapping source gaps cannot be added as unique missing games');
assert.deepEqual(original, copy, 'observational coverage cannot rewrite the historical synced report');

const fullGame = (awayCode = 'ORL', homeCode = 'TOR') => ({ awayCode, homeCode,
  boardDate: '2026-10-31', boardTime: '07:35', marketStatus: 'open',
  fullRunline: { line: '6平' }, fullTotal: { line: '226.5' },
  firstHalfRunline: { line: '3平' }, firstHalfTotal: { line: '112平' },
});
const snapshot = games => ({ boardDate: '2026-10-31', expectedGameCount: games.length,
  gameCount: games.length, marketCount: games.reduce((total, game) => total
    + ['fullRunline', 'fullTotal', 'firstHalfRunline', 'firstHalfTotal'].filter(key => game[key] != null).length, 0), games });
const magic = fullGame(); magic.firstHalfRunline = null; magic.firstHalfTotal = null;
const magicSnapshot = snapshot([magic]), magicBefore = structuredClone(magicSnapshot);
const magicCoverage = nbaSnapshotCoverage(magicSnapshot);
assert.equal(magicCoverage.status, 'PARTIAL');
assert.equal(magicCoverage.missingGameCount, 0);
assert.equal(magicCoverage.missingMarketCount, 2);
assert.deepEqual(magicCoverage.missingMarkets, [{ awayCode: 'ORL', homeCode: 'TOR',
  boardDate: '2026-10-31', boardTime: '07:35', markets: ['firstHalfRunline', 'firstHalfTotal'] }]);
assert.deepEqual(magicSnapshot, magicBefore, 'coverage must never fill an unobserved half quote');
const shortSlate = snapshot([fullGame()]); shortSlate.expectedGameCount = 2;
assert.equal(nbaSnapshotCoverage(shortSlate).missingGameCount, 1);
assert.equal(nbaSnapshotCoverage(shortSlate).missingMarkets.length, 0, 'missing game identity is not invented from a count');

const locked = { awayCode: 'HOU', homeCode: 'DAL', boardDate: '2026-10-31', boardTime: '08:00',
  marketStatus: 'locked', fullRunline: null, fullTotal: null, firstHalfRunline: null, firstHalfTotal: null };
const lockedCoverage = nbaSnapshotCoverage(snapshot([locked]));
assert.equal(lockedCoverage.missingGameCount, 0);
assert.equal(lockedCoverage.missingMarketCount, 4);
assert.equal(lockedCoverage.error, undefined, 'locked quotes are unobserved slots, not parser errors');
assert.equal(readerDiagnosticCoverage({ state: 'synced', rawGameCount: 1, marketCount: 0,
  boards: [{ diagnostics: { expectedGameCount: 1 }, parsedGameCount: 1 }] }).missingMarketCount, 4);

for (const bad of [NaN, Infinity, -1, 1.5, '8', null, undefined, 41]) {
  assert.equal(readerDiagnosticCoverage({ ...report(), rawGameCount: bad }).status, 'UNKNOWN');
  assert.equal(nbaSnapshotCoverage({ ...snapshot([fullGame()]), expectedGameCount: bad }).status, 'UNKNOWN');
}
for (const patch of [{ marketCount: 33 }, { marketCount: -1 }, { marketCount: '30' },
  { boards: [{}] }, { boards: [{ diagnostics: { expectedGameCount: 7 }, parsedGameCount: 8 }] }]) {
  const unknown = readerDiagnosticCoverage({ ...report(), ...patch });
  assert.equal(unknown.status, 'UNKNOWN'); assert.equal(unknown.missingMarketCount, null);
  assert.deepEqual(unknown.sourceGaps, []);
}
for (const patch of [{ awayCode: 'HOU<script>' }, { homeCode: 'ORL' },
  { boardDate: '2026-10-30' }, { boardTime: '25:00' }, { fullTotal: '226.5' }]) {
  const unknown = nbaSnapshotCoverage(snapshot([{ ...fullGame(), ...patch }]));
  assert.equal(unknown.status, 'UNKNOWN'); assert.deepEqual(unknown.missingMarkets, []);
  assert.ok(!JSON.stringify(unknown).includes('<script>'), 'unrecognized source identity text must never be echoed');
}
assert.equal(nbaSnapshotCoverage(snapshot([fullGame(), fullGame()])).status, 'UNKNOWN', 'duplicate identities cannot count twice');
assert.equal(nbaSnapshotCoverage({ ...snapshot([fullGame()]), boardDate: '2026-02-30' }).status, 'UNKNOWN');
assert.equal(nbaSnapshotCoverage({ ...snapshot([fullGame()]), marketCount: 3 }).status, 'UNKNOWN');
const observedAll = readerDiagnosticCoverage({ state: 'synced', rawGameCount: 1, marketCount: 4,
  boards: [{ diagnostics: { expectedGameCount: 1 }, parsedGameCount: 1 }] });
assert.equal(observedAll.status, 'UNKNOWN', 'all observed slots do not prove complete source coverage');
assert.equal(nbaSnapshotCoverage(snapshot([fullGame()])).status, 'UNKNOWN');
for (const output of [result, magicCoverage, lockedCoverage, observedAll,
  nbaSnapshotCoverage(null), readerDiagnosticCoverage(null)]) {
  assert.equal(output.coverageComplete, false); assert.equal(output.readOnly, true);
  assert.ok(!Object.hasOwn(output, 'executable'), 'coverage cannot grant execution authority');
}

// Exercise the real persistence read adapter against an immutable historical
// Reader 2.1.50 report. Derived evidence must not rewrite its signed payload or
// turn a successful save receipt into a fabricated historical sync failure.
const historicalRows = [{ report_id: 'a9a3764b-7dc0-47b8-a78a-a5db6d412301',
  device_id: 'historical-reader-device', received_at: '2026-10-30T14:20:07.777Z',
  payload: { schema: 'READER-DIAGNOSTICS-v1', readerVersion: '2.1.50',
    createdAt: '2026-10-30T14:20:07.610Z', leagues: { NBA: report() } } },
{ report_id: '1c353d0b-60fa-4337-a2a7-e7bb68123f7c', device_id: 'football-reader-device',
  received_at: '2026-10-30T14:19:07.777Z', payload: { readerVersion: '2.1.50',
    leagues: { EPL: { state: 'synced', rawGameCount: 1, marketCount: 1, boards: [] } } } }];
const historicalBefore = structuredClone(historicalRows), statements = [];
const sql = async strings => {
  const statement = strings.join('?'); statements.push(statement);
  if (/CREATE TABLE IF NOT EXISTS sports_reader_diagnostics_v1/.test(statement)) return [];
  if (/SELECT report_id, device_id, received_at, payload FROM sports_reader_diagnostics_v1/.test(statement)) return historicalRows;
  throw new Error('Coverage integration attempted an unexpected database operation');
};
const historicalReports = await listReaderDiagnostics({}, { sql });
assert.deepEqual(historicalReports[0].computedCoverage.NBA, result,
  'older installed Readers gain server-derived partial coverage without changing their uploaded schema');
assert.equal(historicalReports[0].payload.leagues.NBA.state, 'synced');
assert.equal(historicalReports[0].payload.readerVersion, '2.1.50');
assert.deepEqual(historicalRows, historicalBefore, 'read-time enrichment cannot mutate stored reports');
assert.deepEqual(historicalReports[0].payload, historicalBefore[0].payload);
assert.equal(historicalReports[1].computedCoverage, undefined, 'NBA rules cannot leak into football reports');
assert.ok(statements.every(statement => !/INSERT|UPDATE|DELETE/i.test(statement)), 'coverage reads do not rewrite durable data');

// Continue the same evidence through the actual public Reader view and board
// builder. A gap warning cannot discard an otherwise valid matched quote.
const integrationNow = Date.parse('2026-10-30T14:20:07Z'), integrationAt = new Date(integrationNow).toISOString();
const integrationMagic = { ...magic, away: resolveNbaReaderTeam('ORL'), home: resolveNbaReaderTeam('TOR'),
  fullRunline: { line: '6平', lineSide: 'home', awayWater: .95, homeWater: .95 },
  fullTotal: { line: '226.5', overWater: .94, underWater: .94 } };
const integrationSnapshot = { ...snapshot([integrationMagic]), expectedGameCount: 2,
  observedAt: integrationAt, pageActivityAt: integrationAt, receivedAt: integrationAt,
  readerVersion: '2.1.50', sourceHost: 'www.tai888.in' };
const integrationBefore = structuredClone(integrationSnapshot);
const publicReader = nbaReaderPublicView(integrationSnapshot, { now: integrationNow });
assert.equal(publicReader.status, 'fresh');
assert.equal(publicReader.coverage.status, 'PARTIAL');
assert.equal(publicReader.coverage.missingGameCount, 1);
assert.equal(publicReader.coverage.missingMarketCount, 2);
assert.equal(publicReader.executable, false);
assert.deepEqual(publicReader.games, integrationSnapshot.games, 'public diagnostic enrichment cannot replace or fill quotes');
assert.deepEqual(integrationSnapshot, integrationBefore);
for (const [alias, canonical] of Object.entries({ GSW: 'GS', NYK: 'NY', NOP: 'NO', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH', PHO: 'PHX', BRK: 'BKN' })) {
  const aliased = { ...integrationSnapshot, games: [{ ...integrationMagic, awayCode: alias, away: resolveNbaReaderTeam(alias) }] };
  const before = structuredClone(aliased);
  const view = nbaReaderPublicView(aliased, { now: integrationNow });
  assert.equal(view.coverage.status, 'PARTIAL');
  assert.equal(view.coverage.missingMarkets[0].awayCode, canonical);
  assert.deepEqual(aliased, before, 'diagnostic alias projection cannot rewrite source quotes');
  assert.equal(view.games[0].awayCode, alias);
}
const officialGame = (id, away, home, startTime) => ({ id: `nba:espn:game:${id}`, sourceId: String(id),
  league: 'NBA', status: 'scheduled', completed: false, timeConfirmed: true, away, home, startTime });
const magicGame = officialGame(401999701, integrationMagic.away, integrationMagic.home, '2026-10-30T23:30:00Z');
const rocketsGame = officialGame(401999702, resolveNbaReaderTeam('HOU'), resolveNbaReaderTeam('DAL'), '2026-10-31T00:00:00Z');
const officialSchedule = { league: 'NBA', status: 'ready', qa: { status: 'WARNING' }, data: { games: [magicGame, rocketsGame] } };
const integrationBoard = buildNbaAnalysisBoard('2026-10-31', officialSchedule, publicReader, integrationNow);
assert.deepEqual(integrationBoard.readerCoverage, publicReader.coverage, 'board API must propagate the same observed gaps');
assert.equal(integrationBoard.readerStatus, 'fresh');
assert.equal(integrationBoard.rows[0].canAnalyze, true, 'partial coverage must not block a valid available full-game quote');
assert.equal(integrationBoard.rows[1].canAnalyze, false, 'coverage cannot manufacture a quote for the missing game');
assert.equal(integrationBoard.tasks.length, 1);
assert.equal(integrationBoard.tasks[0].nbaQuery.id, magicGame.sourceId);
assert.equal(integrationBoard.rows[0].quote.firstHalfTotal, null);
assert.equal(integrationBoard.rows[1].quote, null);
// Date splitting narrows the saved snapshot's expected count. The source
// report remains the place for header-count gaps; unmatched official rows
// must survive even when the dated snapshot itself reports no count gap.
const narrowedReader = nbaReaderPublicView({ ...integrationSnapshot, expectedGameCount: 1 }, { now: integrationNow });
const narrowedBoard = buildNbaAnalysisBoard('2026-10-31', officialSchedule, narrowedReader, integrationNow);
assert.equal(narrowedReader.coverage.missingGameCount, 0);
assert.equal(narrowedReader.coverage.missingMarketCount, 2);
assert.equal(narrowedBoard.rows.filter(row => !row.quote).length, 1);
assert.equal(narrowedBoard.rows[1].game.id, rocketsGame.id);
assert.equal(narrowedBoard.rows[0].canAnalyze, true);
const staleReader = nbaReaderPublicView(integrationSnapshot, { now: integrationNow + 180001 });
assert.equal(buildNbaAnalysisBoard('2026-10-31', officialSchedule, staleReader, integrationNow + 180001).tasks.length, 0,
  'partial diagnostic metadata cannot override freshness checks');
const lockedSnapshot = { ...integrationSnapshot, marketCount: 0,
  games: [{ ...integrationMagic, marketStatus: 'locked', fullRunline: null, fullTotal: null }] };
assert.equal(buildNbaAnalysisBoard('2026-10-31', officialSchedule,
  nbaReaderPublicView(lockedSnapshot, { now: integrationNow }), integrationNow).tasks.length, 0,
  'missing-market diagnostics cannot grant analysis eligibility to locked games');
console.log('Reader coverage diagnostics: saved partial slates, half-market gaps, locked slots, source overlap, invalid counts, old-report/API/analysis-board integration and read-only boundaries PASS');
