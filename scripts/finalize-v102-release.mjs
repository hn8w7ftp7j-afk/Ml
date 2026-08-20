import fs from 'node:fs';

const read = path => fs.readFileSync(path, 'utf8');
const write = (path, value) => fs.writeFileSync(path, value.endsWith('\n') ? value : `${value}\n`);
const replaceRequired = (path, pattern, replacement, description) => {
  const source = read(path);
  if (pattern.test(source)) {
    write(path, source.replace(pattern, replacement));
    return;
  }
  if (!source.includes(replacement)) throw new Error(`找不到需要更新的${description}：${path}`);
};

replaceRequired('app/page.js', /const VERSION = '10\.1\.1';/, "const VERSION = '10.2.0';", '前端版本');
replaceRequired('app/api/health/route.js', /version: '10\.1\.1',/, "version: '10.2.0',", '健康檢查版本');

const packageJson = JSON.parse(read('package.json'));
packageJson.version = '10.2.0';
write('package.json', JSON.stringify(packageJson, null, 2));

const packageLock = JSON.parse(read('package-lock.json'));
packageLock.version = '10.2.0';
if (packageLock.packages?.['']) packageLock.packages[''].version = '10.2.0';
write('package-lock.json', JSON.stringify(packageLock, null, 2));

write('DEPLOYMENT_VERSION', 'v10.2.0 SCORE-MODEL-INTEGRITY-SAVANT-PARK-FACTOR-SHADOW-DIAGNOSTIC');

const pageTest = `import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync('app/page.js', 'utf8');
const mustMatch = (pattern, label) => assert.match(page, pattern, label);

// Release identity and storage continuity. The storage key deliberately stays stable
// so a display-version bump cannot erase local settings or the emergency bet backup.
mustMatch(/const VERSION = '10\\.2\\.0'/, 'UI must expose the v10.2.0 release');
mustMatch(/const STORAGE = 'sports-positive-ev-v10-0-0'/, 'v10 storage continuity must be preserved');
mustMatch(/sports-positive-ev-bets-backup-v2/, 'bet backup storage must remain enabled');
mustMatch(/sports-positive-ev-v9-6-0/, 'legacy migration chain must remain available');
mustMatch(/mlb-positive-ev-v9-4-4/, 'legacy MLB migration chain must remain available');

// Four-league navigation and server capability gates.
mustMatch(/import \\{ LEAGUE_IDS, leagueConfig, normalizeLeagueId \\} from '\\.\\.\\/lib\\/leagues\\.js'/, 'league registry must be server-backed');
mustMatch(/activeLeague: normalizeLeagueId\\(own\\.activeLeague\\)/, 'stored league must be normalized');
mustMatch(/saveCompactStore\\(\\{ settings, bets, activeLeague: league \\}\\)/, 'active league must persist');
mustMatch(/const analysisEnabled = activeLeague\\.capabilities\\.analysis === true/, 'analysis capability gate missing');
mustMatch(/const readerEnabled = activeLeague\\.capabilities\\.reader === true/, 'Reader capability gate missing');
mustMatch(/const bettingEnabled = activeLeague\\.capabilities\\.bets === true/, 'bet capability gate missing');
mustMatch(/const shadowMode = activeLeague\\.status === 'shadow'/, 'Shadow state gate missing');
assert.doesNotMatch(page, /league !== 'MLB'|league === 'MLB'/, 'page must not hard-code an MLB-only navigation branch');

// Reader authority, date isolation and immutable revision/hash tracking.
mustMatch(/currentDateRef\\.current = date/, 'current date high-water reference missing');
mustMatch(/currentLeagueRef\\.current = league/, 'current league reference missing');
mustMatch(/analysisGenerationRef\\.current \\+= 1/, 'analysis generation invalidation missing');
mustMatch(/readerStatusHighWaterRef/, 'Reader high-water state missing');
mustMatch(/shouldAcceptReaderStatus/, 'Reader rollback rejection missing');
mustMatch(/mergeReaderStatusHighWater/, 'Reader high-water merge missing');
mustMatch(/\\/api\\/reader\\/status\\?league=\\$\\{encodeURIComponent\\(league\\)\\}&date=\\$\\{encodeURIComponent\\(date\\)\\}/, 'date-bound Reader status request missing');
mustMatch(/latest\\.boardDate !== currentDateRef\\.current/, 'Reader date auto-switch guard missing');
mustMatch(/setDate\\(latest\\.boardDate\\)/, 'Reader date auto-switch missing');
mustMatch(/readerRevisionKey\\(date, readerStatus\\?\\.payloadHash, readerStatus\\?\\.pageActivityAt\\)/, 'Reader revision key must include date, payload hash and page activity');
mustMatch(/readerHashKey\\(date, readerStatus\\?\\.payloadHash\\)/, 'Reader hash key must include date and payload hash');
mustMatch(/liveReaderHashMatches/, 'live Reader hash confirmation missing');
mustMatch(/setInterval\\(refreshReader, 30000\\)/, 'Reader status polling interval missing');
mustMatch(/setInterval\\(\\(\\) => pollReaderAndReprice\\(\\), 30000\\)/, 'Reader repricing interval missing');

// Automatic analysis must be keyed to a fresh Reader payload and must not overlap.
mustMatch(/autoAnalyzeHashRef/, 'automatic analysis hash guard missing');
mustMatch(/autoAnalyzePendingRef/, 'automatic analysis pending guard missing');
mustMatch(/operationBusyRef/, 'operation concurrency guard missing');
mustMatch(/readerPollBusyRef/, 'Reader polling concurrency guard missing');
mustMatch(/readerStatus\\?\\.fresh/, 'fresh Reader gate missing');
mustMatch(/oneClickAnalyze\\(key\\)/, 'automatic Reader analysis trigger missing');
mustMatch(/JSON\\.stringify\\(\\{ league, date: targetDate, schedule: games \\}\\)/, 'credit-line request must bind league, date and schedule');
mustMatch(/provider === 'TAI888_READER_AUTO'/, 'Reader provider authority missing');
mustMatch(/credit\\?\\.readerFresh === true/, 'fresh credit snapshot gate missing');

// Actual-bet ledger and price comparison remain available while formal model scoring is locked.
mustMatch(/betPriceMatches/, 'exact placed-price matching missing');
mustMatch(/compareBetPrice/, 'placed-versus-current price comparison missing');
mustMatch(/summarizeBetLedger/, 'ledger statistics missing');
mustMatch(/目前盤口與水位已經記錄/, 'same-price suppression text missing');
mustMatch(/加注目前盤/, 'reprice add-on action missing');
mustMatch(/記錄實際下注/, 'actual-bet action missing');

// Fail-closed market coverage and v10.2 diagnostic score presentation.
mustMatch(/已開 \\{openMarketCount\\}\\/4 市場/, 'partial-market coverage counter missing');
mustMatch(/資料異常｜不評分/, 'blocked market must fail closed');
mustMatch(/尚未開盤/, 'unopened market state missing');
mustMatch(/AVAILABLE/, 'available market state missing');
mustMatch(/BLOCKED/, 'blocked market state missing');
mustMatch(/UNAVAILABLE/, 'unavailable market state missing');
mustMatch(/Number\\(row\\?\\.weightedEV\\) <= 0 \\? 'PASS'/, 'negative Weighted EV must display PASS');
mustMatch(/Number\\(row\\?\\.robustEV\\) <= 0 \\? '觀察'/, 'non-positive Robust EV must display observation');
mustMatch(/rawShadowScore != null && rawShadowScore >= 7\\.2/, 'numeric score must start at the fixed 7.2 gate');
mustMatch(/V10\\.2影子診斷分數/, 'v10.2 diagnostic label missing');

console.log('Page Reader automation, four-league navigation, storage continuity, board authority and v10.2 score presentation PASS');
`;
write('scripts/page-reader-automation-v941-test.mjs', pageTest);

for (const obsolete of [
  '.github/workflows/apply-v102-score-model-fix.yml',
  'scripts/v102-patch-diagnostic.log',
]) {
  if (fs.existsSync(obsolete)) fs.rmSync(obsolete);
}

console.log('v10.2 release metadata, regression contract and temporary tooling finalized');
