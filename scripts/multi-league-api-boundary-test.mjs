import assert from 'node:assert/strict';
import fs from 'node:fs';

const routeSpecs = [
  ['app/api/analyze/route.js', 'const context = await withClearedTimeout(buildGameContext'],
  ['app/api/reprice/route.js', 'if (!(await verifyRepriceSnapshot'],
  ['app/api/credit-lines/route.js', 'const snapshot = await loadReaderSnapshot'],
  ['app/api/reader/status/route.js', 'const snapshot = await loadReaderSnapshot'],
  ['app/api/reader/ingest/route.js', 'const envelope = validateTai888ReaderEnvelope'],
  ['app/api/result/route.js', 'fetchFinalResult(gamePk)'],
];

for (const [file, mlbWorkMarker] of routeSpecs) {
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /from ['"](?:\.\.\/)+lib\/leagues\.js['"]/, `${file} 必須使用共同聯盟 registry`);
  assert.match(source, /requestedLeagueId\(/, `${file} 必須以不回落未知值的 helper 解析 league`);
  assert.doesNotMatch(source, /normalizeLeagueId\(/, `${file} 不得將未知聯盟正規化成 MLB`);
  assert.match(source, /code: 'UNKNOWN_LEAGUE'/, `${file} 必須拒絕未知聯盟`);
  assert.match(source, /code: 'LEAGUE_NOT_READY'/, `${file} 必須拒絕尚未啟用的聯盟`);

  const notReadyIndex = source.indexOf("code: 'LEAGUE_NOT_READY'");
  const mlbWorkIndex = source.indexOf(mlbWorkMarker);
  assert.ok(mlbWorkIndex >= 0, `${file} 缺少預期 MLB 工作標記：${mlbWorkMarker}`);
  assert.ok(notReadyIndex >= 0 && notReadyIndex < mlbWorkIndex, `${file} 必須在進入 MLB 實作前拒絕未就緒聯盟`);
}

const credit = fs.readFileSync('app/api/credit-lines/route.js', 'utf8');
assert.match(credit, /requestedLeagueId\(new URL\(request\.url\)\.searchParams\.get\('league'\)\)/, 'credit-lines GET 必須隔離聯盟');
assert.match(credit, /requestedLeagueId\(body\?\.league\)/, 'credit-lines POST 必須隔離聯盟');

const readerStatus = fs.readFileSync('app/api/reader/status/route.js', 'utf8');
assert.match(readerStatus, /requestedLeagueId\(searchParams\.get\('league'\)\)/, 'Reader status 必須從 query 明確解析聯盟');

const readerIngest = fs.readFileSync('app/api/reader/ingest/route.js', 'utf8');
assert.match(readerIngest, /requestedLeagueId\(body\?\.league\)/, '舊 Reader 無 league 時只能由 registry 相容為 MLB');

const leagueRoute = fs.readFileSync('app/api/leagues/route.js', 'utf8');
assert.match(leagueRoute, /publicLeagueRegistry\(\)/);
assert.match(leagueRoute, /'Cache-Control': 'no-store'/);

console.log('multi-league API boundaries: unknown/not-ready rejection occurs before every legacy MLB implementation PASS');
