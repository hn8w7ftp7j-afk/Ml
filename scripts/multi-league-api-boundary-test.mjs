import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => fs.readFileSync(file, 'utf8');
const routes = [
  'app/api/analyze/route.js',
  'app/api/reprice/route.js',
  'app/api/credit-lines/route.js',
  'app/api/reader/status/route.js',
  'app/api/reader/ingest/route.js',
  'app/api/reference-lines/route.js',
  'app/api/result/route.js',
  'app/api/schedule/route.js',
];
for (const file of routes) {
  const source = read(file);
  assert.match(source, /requestedLeagueId\(/, `${file} 必須嚴格解析 league`);
  assert.doesNotMatch(source, /normalizeLeagueId\(/, `${file} 不得將未知 league 回落 MLB`);
  assert.match(source, /code: 'UNKNOWN_LEAGUE'/, `${file} 必須拒絕未知 league`);
}

const analyze = read('app/api/analyze/route.js');
assert.match(analyze, /resolveLeagueGame\(league, requestedGame\)/);
assert.match(analyze, /assertLeagueGamePrestart\(league, game\)/);
assert.match(analyze, /buildLeagueGameContext\(league, game\)/);
assert.match(analyze, /positiveInteger\(game\?\.gamePk, Number\.MAX_SAFE_INTEGER\)/);
assert.match(analyze, /attestIncomingMarketRows\(league, game,/);
assert.match(analyze, /buildSnapshotFingerprints\(\{ league,/);
assert.match(analyze, /analysisContractSignature\(league, game, activeMarkets\)/);
assert.match(analyze, /analysisCacheKey\(league, game\.gamePk,/);
assert.match(analyze, /analysisCachePayloadMatches\(cached, \{ league, game,/);
assert.match(analyze, /signRepriceSnapshot\(\s*league,\s*game,/s);
assert.match(analyze, /enforceAnalysisModeSafety\(\s*finalizeDeterministicAnalysis/s, 'finalizer 後必須重套 shadow safety');
assert.match(analyze, /const safePayload = enforceAnalysisModeSafety\(cached\.payload, cached\.payload\.context \|\| frozenContext\)/, 'cache HIT 必須對整體 payload 重套 shadow safety');
assert.match(analyze, /const safePayload = enforceAnalysisModeSafety\(payload, frozenContext\)/, 'cache MISS payload 也必須整體鎖定');
assert.match(analyze, /cacheSet\(cacheKey, signature, safePayload\)/, '快取只能儲存已鎖定 payload');

const reprice = read('app/api/reprice/route.js');
assert.doesNotMatch(reprice, /resolveLeagueGame\(/, 'price-only reprice不得重新抓官方賽程或其他核心棒球資料');
assert.match(reprice, /const game = context\.game/);
assert.match(reprice, /assertLeagueGamePrestart\(league, game\)/);
assert.match(reprice, /verifyRepriceSnapshot\(league, game, snapshot\)/);
assert.match(reprice, /attestIncomingMarketRows\(league, game,/);
assert.match(reprice, /buildSnapshotFingerprints\(\{\s*league,/s);
assert.match(reprice, /signRepriceSnapshot\(\s*league,\s*game,/s);
assert.match(reprice, /enforceAnalysisModeSafety\(\s*finalizeDeterministicAnalysis/s);

const credit = read('app/api/credit-lines/route.js');
assert.match(credit, /fetchLeagueTaipeiSlate\(league, date\)/);
assert.match(credit, /validateLeagueScheduleSubset\(league,/);
assert.match(credit, /loadReaderSnapshot\(league, date\)/);
assert.match(credit, /readerSnapshotStatus\(readerSnapshot, Date\.now\(\), league\)/);
assert.match(credit, /readerGameMarketHash: readerGameMarketContentHash\(row\.markets\)/, 'Reader must sign a per-game content revision independent of heartbeat liveness');
assert.match(credit, /signMarketGames\(league, readerEvidenceGames\)/);

const readerIngest = read('app/api/reader/ingest/route.js');
assert.match(readerIngest, /fetchLeagueTaipeiSlate\(league, boardDate\)/);
assert.match(readerIngest, /filterLeaguePrestartGames\(league,/);
assert.match(readerIngest, /loadReaderSnapshot\(league, boardDate\)/);
assert.match(readerIngest, /normalizeTai888ReaderPayload\(body, schedule, \{\s*league,/s);

const readerStatus = read('app/api/reader/status/route.js');
assert.match(readerStatus, /loadReaderSnapshot\(league, date\)/);
assert.match(readerStatus, /readerSnapshotPublicView\(snapshot, \{ complete, (?:now: Date\.now\(\), )?league \}\)/);

const reference = read('app/api/reference-lines/route.js');
assert.match(reference, /fetchLeagueTaipeiSlate\(league, date\)/);
assert.match(reference, /referencePolicy: 'NO_MLB_FALLBACK'/);
assert.match(reference, /if \(league !== 'MLB'\)/);
assert.match(reference, /signMarketGames\(league, filteredGames\)/);
const asianBlock = reference.indexOf("if (league !== 'MLB')", reference.indexOf('export async function POST'));
assert.ok(asianBlock >= 0 && asianBlock < reference.indexOf('loadJbot(date', asianBlock), 'Asian 必須在任何 MLB 參考盤讀取前返回');

const result = read('app/api/result/route.js');
assert.match(result, /positiveInteger\(searchParams\.get\('gamePk'\), Number\.MAX_SAFE_INTEGER\)/);
assert.match(result, /league !== 'MLB' && !validDateString\(date\)/);
assert.match(result, /fetchLeagueFinalResult\(league, gamePk, \{ date \}\)/);

const schedule = read('app/api/schedule/route.js');
assert.match(schedule, /fetchLeagueTaipeiSlate\(league, date\)/);
assert.match(schedule, /filterLeaguePrestartGames\(league, slate\)/);
assert.match(schedule, /analysisMode: provider\.analysisMode/);
assert.match(schedule, /betEligible: provider\.betEligible/);

const legacy = read('app/api/mlb/route.js');
assert.match(legacy, /fetchLeagueTaipeiSlate\('MLB', date\)/);
assert.doesNotMatch(legacy, /fetchOfficialTaipeiSlate/);

const leagueRoute = read('app/api/leagues/route.js');
assert.match(leagueRoute, /publicLeagueRegistry\(\)/);
assert.match(leagueRoute, /'Cache-Control': 'no-store'/);

console.log('Multi-league provider API boundaries, league signatures and shadow fail-closed gates PASS');
