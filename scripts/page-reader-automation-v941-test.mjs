import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync('app/page.js', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packageLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const mustMatch = (pattern, label) => assert.match(page, pattern, label);
mustMatch(/模型影子排名/, 'ranking tab must identify model shadow output');


// Release identity and storage continuity. The storage key deliberately stays stable
// so a display-version bump cannot erase local settings or the emergency bet backup.
mustMatch(/const VERSION = '10\.5\.1'/, 'UI must expose the V10.5.1 visible model-EV correction');
assert.equal(packageJson.version, '10.5.1', 'package/release identity must match the V10.5.1 UI');
assert.equal(packageLock.version, '10.5.1', 'package-lock release identity must match V10.5.1');
assert.equal(packageLock.packages?.['']?.version, '10.5.1', 'root lockfile package must match V10.5.1');
mustMatch(/const STORAGE = 'sports-positive-ev-v10-0-0'/, 'v10 storage continuity must be preserved');
mustMatch(/sports-positive-ev-bets-backup-v2/, 'bet backup storage must remain enabled');
mustMatch(/const READER_DOWNLOAD_PATH = '\/downloads\/Tai888-Reader-v2\.1\.13-KBO-TRADITIONAL-NAME-SAFE\.zip'/, 'Reader download must point at the packaged production artifact');
mustMatch(/href=\{READER_DOWNLOAD_PATH\}/, 'Reader download link must use the packaged production path');
assert.ok(fs.existsSync('public/downloads/Tai888-Reader-v2.1.13-KBO-TRADITIONAL-NAME-SAFE.zip'), 'Reader production zip must exist');
assert.ok(fs.existsSync('public/downloads/Tai888-Reader-v2.1.13-KBO-TRADITIONAL-NAME-SAFE.zip.sha256'), 'Reader checksum must exist');
mustMatch(/sports-positive-ev-v9-6-0/, 'legacy migration chain must remain available');
mustMatch(/mlb-positive-ev-v9-4-4/, 'legacy MLB migration chain must remain available');

// Four-league navigation and server capability gates.
mustMatch(/import \{ LEAGUE_IDS, leagueConfig, normalizeLeagueId \} from '\.\.\/lib\/leagues\.js'/, 'league registry must be server-backed');
mustMatch(/activeLeague: normalizeLeagueId\(own\.activeLeague\)/, 'stored league must be normalized');
mustMatch(/saveCompactStore\(\{ settings, bets, activeLeague: league \}\)/, 'active league must persist');
mustMatch(/const analysisEnabled = activeLeague\.capabilities\.analysis === true/, 'analysis capability gate missing');
mustMatch(/const readerEnabled = activeLeague\.capabilities\.reader === true/, 'Reader capability gate missing');
mustMatch(/const bettingEnabled = activeLeague\.capabilities\.bets === true/, 'bet capability gate missing');
mustMatch(/const shadowMode = activeLeague\.status === 'shadow'/, 'Shadow state gate missing');
mustMatch(/LEAGUE_IDS\.map/, 'all configured leagues must still render from the registry');

// Reader authority, date isolation and immutable revision/hash tracking.
mustMatch(/currentDateRef\.current = date/, 'current date high-water reference missing');
mustMatch(/currentLeagueRef\.current = league/, 'current league reference missing');
mustMatch(/analysisGenerationRef\.current \+= 1/, 'analysis generation invalidation missing');
mustMatch(/readerStatusHighWaterRef/, 'Reader high-water state missing');
mustMatch(/shouldAcceptReaderStatus/, 'Reader rollback rejection missing');
mustMatch(/mergeReaderStatusHighWater/, 'Reader high-water merge missing');
mustMatch(/\/api\/reader\/status\?league=\$\{encodeURIComponent\(league\)\}&date=\$\{encodeURIComponent\(date\)\}/, 'date-bound Reader status request missing');
mustMatch(/latest\.boardDate !== currentDateRef\.current/, 'Reader date auto-switch guard missing');
mustMatch(/setDate\(latest\.boardDate\)/, 'Reader date auto-switch missing');
mustMatch(/readerRevisionKey\(date, readerStatus\?\.payloadHash, readerStatus\?\.pageActivityAt\)/, 'Reader revision key must include date, payload hash and page activity');
mustMatch(/readerHashKey\(date, readerStatus\?\.payloadHash\)/, 'Reader hash key must include date and payload hash');
mustMatch(/liveReaderHashMatches/, 'live Reader hash confirmation missing');
mustMatch(/setInterval\(refreshReader, 30000\)/, 'Reader status polling interval missing');
mustMatch(/setInterval\(\(\) => pollReaderAndReprice\(\), 30000\)/, 'Reader repricing interval missing');

// Automatic analysis must be keyed to a fresh Reader payload and must not overlap.
mustMatch(/autoAnalyzeHashRef/, 'automatic analysis hash guard missing');
mustMatch(/autoAnalyzePendingRef/, 'automatic analysis pending guard missing');
mustMatch(/operationBusyRef/, 'operation concurrency guard missing');
mustMatch(/readerPollBusyRef/, 'Reader polling concurrency guard missing');
mustMatch(/readerStatus\?\.fresh/, 'fresh Reader gate missing');
mustMatch(/oneClickAnalyze\(key\)/, 'automatic Reader analysis trigger missing');
mustMatch(/JSON\.stringify\(\{ league, date: targetDate, schedule: games \}\)/, 'credit-line request must bind league, date and schedule');
mustMatch(/provider === 'TAI888_READER_AUTO'/, 'Reader provider authority missing');
mustMatch(/credit\?\.readerFresh === true/, 'fresh credit snapshot gate missing');

// V10.4 reference-market flow must be wired into both full analysis and frozen-distribution repricing.
mustMatch(/async function fetchReferenceLines\(games, targetDate = date, targetGames = \[\]\)/, 'target-aware reference-line loader missing');
mustMatch(/requestJSON\('\/api\/reference-lines'/, 'reference-line API request missing');
mustMatch(/REFERENCE_REFRESH_INTERVAL_MS = 2 \* 60 \* 1000/, 'independent references must refresh before five-minute evidence expiry even when Reader hash is unchanged');
mustMatch(/referenceRefreshDue/, 'same-hash Reader polling must not leave expired reference evidence on screen');
mustMatch(/body: JSON\.stringify\(\{ league, date: targetDate, schedule: games \}\)/, 'reference request must bind league, date and official schedule');
mustMatch(/const referenceByPk = new Map/, 'reference markets must be isolated by official gamePk');
mustMatch(/verificationMarkets: foundReference\?\.markets \|\| \[\]/, 'per-game analysis task must retain its signed reference markets');
mustMatch(/verificationMarkets: task\.verificationMarkets \|\| \[\]/, 'full analyze request must send matched reference markets');
mustMatch(/verificationMarkets: referenceByPk\.get\(Number\(item\.game\.gamePk\)\)\?\.markets \|\| item\.verificationMarkets \|\| \[\]/, 'reprice request must refresh or retain matched reference markets');
assert.doesNotMatch(page, /verificationMarkets:\s*\[\]/, 'analyze/reprice must never hard-code an empty verification-market payload');
assert.ok(
  page.indexOf("requestJSON('/api/reference-lines'") < page.indexOf('const tasks = items.filter'),
  'reference markets must be fetched before per-game analysis tasks are built',
);

// Actual-bet ledger and price comparison remain available while formal model scoring is locked.
mustMatch(/betPriceMatches/, 'exact placed-price matching missing');
mustMatch(/compareBetPrice/, 'placed-versus-current price comparison missing');
mustMatch(/summarizeBetLedger/, 'ledger statistics missing');
mustMatch(/目前盤口與水位已經記錄/, 'same-price suppression text missing');
mustMatch(/加注目前盤/, 'reprice add-on action missing');
mustMatch(/記錄實際下注/, 'actual-bet action missing');

// Ranking rows must retain the original item/row and expose the same immutable
// cloud-ledger action as the board instead of becoming a read-only desktop view.
mustMatch(/\.map\(row => \(\{\s*item,\s*row,/, 'ranking entries must retain their source board item and actual market row');
const rankingStart = page.indexOf("{tab === 'ranking' && <section");
const rankingEnd = page.indexOf("{tab === 'bets' && <section", rankingStart);
assert.ok(rankingStart >= 0 && rankingEnd > rankingStart, 'ranking UI section missing');
const rankingUi = page.slice(rankingStart, rankingEnd);
assert.match(rankingUi, /getBetState\(entry\.item,\s*entry\.row\)/, 'ranking action must read the same cloud/local bet state as the board');
assert.match(rankingUi, /betRecordable\(entry\.item,\s*entry\.row,\s*clockNow,\s*bettingEnabled\)/, 'ranking action must enforce the same prestart/fresh Reader write gate');
assert.match(rankingUi, /recordBet\(entry\.item,\s*entry\.row\)/, 'ranking button must call the canonical cloud recordBet flow');
assert.match(rankingUi, /已下注|記錄實際下注/, 'ranking row must visibly expose placed/record action state');

// Fail-closed market coverage and all-direction diagnostic score presentation.
mustMatch(/已開 \{openMarketCount\}\/4 市場/, 'partial-market coverage counter missing');
mustMatch(/資料異常｜不評分/, 'blocked market must fail closed');
mustMatch(/尚未開盤/, 'unopened market state missing');
mustMatch(/AVAILABLE/, 'available market state missing');
mustMatch(/BLOCKED/, 'blocked market state missing');
mustMatch(/UNAVAILABLE/, 'unavailable market state missing');
mustMatch(/row\?\.formulaDiagnosticScore != null/, 'every calculable direction must expose its fixed-formula score');
mustMatch(/formulaScore\.toFixed\(1\)/, 'fixed S score must always render as a number');
mustMatch(/QA BLOCK/, 'QA-blocked directions must remain visibly identified');
mustMatch(/不列排名、不作推薦/, 'QA block must remain isolated from ranking and recommendation');
assert.doesNotMatch(page, /rawShadowScore != null && rawShadowScore >= 7\.2/, 'display must not hide scores below 7.2');
assert.doesNotMatch(page, /Number\(row\?\.weightedEV\) <= 0 \? 'PASS'/, 'negative EV must still display the fixed numeric S score');
mustMatch(/row\.shadowDiagnosticScore != null/, 'ranking must explicitly reject null qualification scores');
mustMatch(/row\.provider === 'TAI888_READER_AUTO'/, 'ranking must accept only Reader-signed actual rows');
mustMatch(/row\.evCalibration\?\.actualReaderEligible === true/, 'ranking must require the server-preserved fresh Reader qualification');
mustMatch(/actualLineFreshNow\(row, clockNow\)/, 'ranking must expire stale Reader prices immediately on the client clock');
mustMatch(/gameIsPrestartNow\(item\.game, clockNow\)/, 'ranking must remove games that have reached scheduled start');
assert.doesNotMatch(page, /invalidateShadowScoreRow\(row, '獨立國際市場報價已超過5分鐘/, 'expired external consensus must remain audit-only');
mustMatch(/return invalidateReaderPriceRow\(row, reason, reason\)/, 'expired or unverified Reader prices must clear W, R and score from the board');
const scoreOnlyInvalidation = page.slice(
  page.indexOf('const invalidateShadowScoreRow'),
  page.indexOf('const invalidateReaderPriceRow'),
);
assert.doesNotMatch(scoreOnlyInvalidation, /lineFresh:\s*false|actualReaderEligible:\s*false|executable:\s*false/, 'external-reference expiry must not invalidate a still-fresh Reader price or hide actual-bet recording');
const readerPriceInvalidation = page.slice(
  page.indexOf('const invalidateReaderPriceRow'),
  page.indexOf('function outcomeText'),
);
assert.match(readerPriceInvalidation, /lineFresh:\s*false/, 'Reader-price invalidation must clear actual-line freshness');
assert.match(readerPriceInvalidation, /actualReaderEligible:\s*false/, 'Reader-price invalidation must clear the server-preserved Reader qualification');
const gameCardGuard = page.slice(page.indexOf('function GameCard'), page.indexOf('function LeagueSetupPanel'));
assert.doesNotMatch(gameCardGuard, /referenceEvidenceFreshNow/, 'external-reference freshness must not hide model W/R');
mustMatch(/row\.scoreAudit\?\.ok === true/, 'ranking must require QA PASS');
mustMatch(/row\.pairAudit\?\.passed !== false/, 'ranking must require pair QA');
mustMatch(/Number\(row\.weightedEV\) > 0/, 'ranking must require positive Raw W EV');
mustMatch(/Number\(row\.robustEV\) > 0/, 'ranking must require positive Robust R EV');
mustMatch(/Number\(row\.shadowDiagnosticScore\) >= 7\.2/, 'ranking must require the 7.2 qualification threshold');
mustMatch(/row\.evCalibration\?\.scenarioStable === true/, 'ranking must require the 5% model-scenario stability gate');
mustMatch(/row\.evCalibration\?\.extreme !== true/, 'ranking must hold uncalibrated positive 15%+ W for review');
mustMatch(/應評 \{expectedDirectionCount\} 方向/, 'per-game expected direction coverage missing');
mustMatch(/已評 \{scoredDirectionCount\}\/\{expectedDirectionCount\}/, 'per-game scored direction coverage missing');
mustMatch(/排名資格：/, 'score qualification reason must be visible');
mustMatch(/資料QA：PASS/, 'data QA must be presented separately from ranking qualification');







mustMatch(/V10\.5\.1相關風險聯合比分模型影子 S 分數/, 'score label must disclose correlated joint-score model semantics');
mustMatch(/模型勝率 \${pct\(row\.modelProbability\)}/, 'probability must be labelled as model probability');
mustMatch(/未校準模型W \${pct\(row\.weightedEV\)}/, 'W must be labelled as uncalibrated model Weighted EV');
mustMatch(/情境保守R \${pct\(row\.robustEV\)}/, 'R must be labelled as scenario Robust EV');
mustMatch(/情境差距 \${pct\(row\.evCalibration\?\.rawScenarioSpread\)}/, 'W/R scenario spread must be visible');
mustMatch(/合格模型影子分數啟用/, 'provider status must report model shadow-score mode');
mustMatch(/Tai888只作成交價/, 'Tai888 execution-price-only role must be visible');
mustMatch(/獨立市場只作可選/, 'independent market must be disclosed as optional audit-only');
assert.doesNotMatch(page, /公式診斷分/, 'website must not expose a second diagnostic-score language');
assert.doesNotMatch(page, /Raw W EV|保守 R EV/, 'website must use the agreed weighted/robust EV labels');
mustMatch(/不產生有效EV、不評分、不列排名/, 'unqualified model or reference evidence must fail closed in the primary UI');
assert.doesNotMatch(page, /原始W \$\{pct\(|原始R \$\{pct\(/, 'primary UI must not expose blocked raw EV percentages');
mustMatch(/聯盟模型重建中｜EV與S分數暫停顯示/, 'unvalidated Asian leagues must hide misleading EV/S values');

// Batch analysis cannot be held indefinitely by the first slow games.
mustMatch(/ANALYSIS_REQUEST_TIMEOUT_MS = 65_000/, 'bounded per-game deadline missing');
mustMatch(/runPool\(tasks, 3/, 'three-worker bounded analysis pool missing');
mustMatch(/重試 \$\{retryIndexes\.length\} 場未完成分析/, 'trailing retry pass missing');
mustMatch(/tasks\[index\]\?\.retryable === false/, 'permanent failures must not be retried');
mustMatch(/running: 1, total: 1/, 'single-request phases must report one active request');

console.log('Page Reader automation, four-league navigation, storage continuity, board authority and all-score presentation PASS');
