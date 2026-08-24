import assert from 'node:assert/strict';
import fs from 'node:fs';
import { APP_VERSION } from '../lib/app-version.js';

const page = fs.readFileSync('app/page.js', 'utf8');
const healthRoute = fs.readFileSync('app/api/health/route.js', 'utf8');
const analyzeRoute = fs.readFileSync('app/api/analyze/route.js', 'utf8');
const betPricesRoute = fs.readFileSync('app/api/bet-prices/route.js', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packageLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const mustMatch = (pattern, label) => assert.match(page, pattern, label);
mustMatch(/模型影子排名/, 'ranking tab must identify model shadow output');


// Release identity and storage continuity. The storage key deliberately stays stable
// so a display-version bump cannot erase local settings or the emergency bet backup.
mustMatch(/import \{ APP_VERSION \} from '\.\.\/lib\/app-version\.js'/, 'UI must use the shared release version');
mustMatch(/const VERSION = APP_VERSION/, 'UI badge must use the shared release version');
assert.equal(packageJson.version, '10.9.4', 'package/release identity must match the V10.9.4 UI');
assert.equal(packageLock.version, '10.9.4', 'package-lock release identity must match V10.9.4');
assert.equal(packageLock.packages?.['']?.version, '10.9.4', 'root lockfile package must match V10.9.4');
assert.equal(APP_VERSION, '10.9.4');
assert.match(healthRoute, /const version = APP_VERSION/, 'health endpoint must use the same shared release version as the website');
assert.match(healthRoute, /gameDistributionCacheVersion: GAME_DISTRIBUTION_CACHE_VERSION/, 'health endpoint must expose the game-distribution cache contract');
assert.doesNotMatch(analyzeRoute, /simulationsPerScenario:\s*4000/, 'analyze API must not retain the fake simulation count');
assert.match(analyzeRoute, /getOrBuildGameDistribution/, 'analyze API must reuse the same-game core distribution');
mustMatch(/const STORAGE = 'sports-positive-ev-v10-0-0'/, 'v10 storage continuity must be preserved');
mustMatch(/sports-positive-ev-bets-backup-v2/, 'bet backup storage must remain enabled');
mustMatch(/const READER_DOWNLOAD_PATH = '\/downloads\/Tai888-Reader-v2\.1\.19-VERIFIED-RESCAN\.zip'/, 'Reader download must point at the packaged production artifact');
mustMatch(/href=\{READER_DOWNLOAD_PATH\}/, 'Reader download link must use the packaged production path');
assert.ok(fs.existsSync('public/downloads/Tai888-Reader-v2.1.19-VERIFIED-RESCAN.zip'), 'Reader production zip must exist');
assert.ok(fs.existsSync('public/downloads/Tai888-Reader-v2.1.19-VERIFIED-RESCAN.zip.sha256'), 'Reader checksum must exist');
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
mustMatch(/readerHashKey\(date, readerStatus\?\.payloadHash\)/, 'Reader hash key must include date and payload hash');
mustMatch(/liveReaderHashMatches/, 'live Reader hash confirmation missing');
mustMatch(/const READER_RECHECK_INTERVAL_MS = 30 \* 1000/, 'Reader thirty-second recheck cadence missing');
mustMatch(/setInterval\(refreshReader, READER_RECHECK_INTERVAL_MS\)/, 'Reader status polling interval missing');
mustMatch(/setInterval\(\(\) => pollReaderAndReprice\(\), READER_RECHECK_INTERVAL_MS\)/, 'Reader repricing interval missing');
mustMatch(/touchReaderHeartbeat/, 'same-content Reader heartbeat must refresh freshness without repricing');
assert.doesNotMatch(page, /lastFullAnalysisAtRef/, 'the client must never force a destructive full-board rerun on a timer');

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
mustMatch(/initialAnalysisConcurrency\(league\)/, 'full-board concurrency must be league-aware for mobile reliability');
mustMatch(/runPool\(tasks, analysisConcurrency,/, 'full-board analysis must use the bounded league concurrency');
mustMatch(/runPool\(retryIndexes, 1,/, 'failed analyses must retry serially instead of repeating a mobile request burst');
assert.doesNotMatch(page, /V10模擬次數|4000（固定）/, 'fake simulation setting must be removed from the UI');

// External-market requests are disabled; analysis keeps an explicit empty audit payload.
mustMatch(/async function fetchReferenceLines\(games, targetDate = date, targetGames = \[\]\)/, 'target-aware reference-line loader missing');
assert.doesNotMatch(page, /requestJSON\('\/api\/reference-lines'/, 'client must not request disabled external-market APIs');
mustMatch(/message: '外部市場稽核未使用；不影響模型評分與排名。'/, 'disabled external-market status missing');
assert.doesNotMatch(page, /referenceRefreshDue/, 'disabled external references must not force same-hash Reader repricing');
mustMatch(/body: JSON\.stringify\(\{ league, date: targetDate, schedule: games \}\)/, 'reference request must bind league, date and official schedule');
mustMatch(/const referenceByPk = new Map/, 'reference markets must be isolated by official gamePk');
mustMatch(/verificationMarkets: foundReference\?\.markets \|\| \[\]/, 'per-game analysis task must retain its signed reference markets');
mustMatch(/verificationMarkets: task\.verificationMarkets \|\| \[\]/, 'full analyze request must send matched reference markets');
mustMatch(/verificationMarkets: referenceByPk\.get\(Number\(item\.game\.gamePk\)\)\?\.markets \|\| item\.verificationMarkets \|\| \[\]/, 'reprice request must refresh or retain matched reference markets');
assert.doesNotMatch(page, /verificationMarkets:\s*\[\]/, 'analyze/reprice must never hard-code an empty verification-market payload');
mustMatch(/後台重新驗證中｜保留目前分數/, 'full refresh must retain completed scores on screen');
mustMatch(/更新失敗｜保留上一版結果/, 'failed refresh must retain the previous completed result');
assert.doesNotMatch(page, /系統將自動重新分析/, 'a failed Reader acknowledgement must not trigger a full-board retry loop');

// Actual-bet ledger and price comparison remain available while formal model scoring is locked.
mustMatch(/betPriceMatches/, 'exact placed-price matching missing');
mustMatch(/compareBetPrice/, 'placed-versus-current price comparison missing');
mustMatch(/BetPriceComparison/, 'placed-versus-current comparison UI missing');
mustMatch(/即時 Reader 比較/, 'live Reader comparison must be visibly separated');
mustMatch(/下注時盤口/, 'placed line and water must remain visible in comparison UI');
mustMatch(/Reader目前盤口/, 'current Reader line and water must remain visible in comparison UI');
mustMatch(/Closing CLV/, 'verified Closing comparison must use a separate UI section');
mustMatch(/洞口的 u 差不是 CLV 百分比/, 'key-hole payoff delta must not be mislabeled as CLV percent');
mustMatch(/requestJSON\('\/api\/bet-prices'/, 'ledger must refresh Reader price comparisons independently');
assert.match(betPricesRoute, /listCloudBets/, 'price feed must resolve server-owned tickets');
assert.match(betPricesRoute, /loadReaderSnapshot/, 'price feed must use the Reader snapshot authority');
assert.match(betPricesRoute, /currentReaderPriceForBet/, 'price feed must match the same ticket position');
assert.match(betPricesRoute, /current: status\.fresh \?/, 'stale Reader prices must not be presented as current');
assert.match(betPricesRoute, /verifiedClosingPriceForBet/, 'Closing CLV must require a verified closing snapshot');
mustMatch(/summarizeBetLedger/, 'ledger statistics missing');
mustMatch(/此方向已經記錄；盤口或水位變動也不再新增/, 'single-position bet suppression text missing');
assert.doesNotMatch(page, /加注目前盤/, 'same direction must never expose a reprice add-on action');
mustMatch(/記錄實際下注/, 'actual-bet action missing');

// Ranking rows must retain the original item/row and expose the same immutable
// cloud-ledger action as the board instead of becoming a read-only desktop view.
mustMatch(/return \{ item, row, gamePk:/, 'ranking entries must retain their source board item and actual market row');
const rankingStart = page.indexOf("{tab === 'ranking' && <section");
const rankingEnd = page.indexOf("{tab === 'betOrder' && <section", rankingStart);
assert.ok(rankingStart >= 0 && rankingEnd > rankingStart, 'ranking UI section missing');
const rankingUi = page.slice(rankingStart, rankingEnd);
assert.match(rankingUi, /getBetState\(entry\.item,\s*entry\.row\)/, 'ranking action must read the same cloud/local bet state as the board');
assert.match(rankingUi, /betRecordable\(entry\.item,\s*entry\.row,\s*clockNow,\s*bettingEnabled\)/, 'ranking action must enforce the same prestart/fresh Reader write gate');
assert.match(rankingUi, /recordBet\(entry\.item,\s*entry\.row\)/, 'ranking button must call the canonical cloud recordBet flow');
assert.match(rankingUi, /已下注|記錄實際下注/, 'ranking row must visibly expose placed/record action state');
assert.match(rankingUi, /全部方向/, 'ranking UI must explicitly identify all-direction display');
assert.match(rankingUi, /不再只顯示7\.2以上或可下注方向/, 'ranking UI must explain that non-bettable directions remain visible');
assert.match(rankingUi, /排名資格：否/, 'ranking UI must label non-qualified directions instead of filtering them out');
mustMatch(/BET_PERIODS/, 'ledger quick period controls missing');
mustMatch(/BetLedgerDashboard/, 'unified four-league ledger dashboard missing');
mustMatch(/selectedLeague=\{betLeague\}/, 'ledger league drill-down state missing');
mustMatch(/selectedMarket=\{betMarket\}/, 'ledger market drill-down state missing');
mustMatch(/選擇聯盟範圍/, 'ledger must expose aggregate and per-league scopes');
mustMatch(/\{leagueLabel\}｜四種市場輸贏/, 'each league scope must expose its own four-market summary');

const betOrderStart = page.indexOf("{tab === 'betOrder' && <section");
const betOrderEnd = page.indexOf("{tab === 'bets' && <BetLedgerDashboard", betOrderStart);
assert.ok(betOrderStart >= 0 && betOrderEnd > betOrderStart, 'bet-order UI section missing');
const betOrderUi = page.slice(betOrderStart, betOrderEnd);
assert.match(page, />下注順序<\//, 'bet-order tab must sit beside the ranking tab');
assert.match(page, /buildBetOrderEntries\(shadowRanking\)/, 'bet order must derive from the same immutable Reader ranking entries');
assert.match(page, /groupBetOrderEntries\(shadowBetOrder\)/, 'bet order must group directions by game');
assert.match(betOrderUi, /全場讓分、全場大小、上半讓分、上半大小/, 'bet-order UI must disclose its fixed market order');
assert.match(betOrderUi, /getBetState\(entry\.item, entry\.row\)/, 'bet order must reuse the canonical cloud/local bet state');
assert.match(betOrderUi, /betRecordable\(entry\.item, entry\.row, clockNow, bettingEnabled\)/, 'bet order must enforce the canonical prestart/fresh Reader gate');
assert.match(betOrderUi, /recordBet\(entry\.item, entry\.row\)/, 'bet-order button must use the canonical cloud record flow');
assert.match(betOrderUi, /已下注 ✓/, 'bet order must visibly preserve already-recorded positions');

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
mustMatch(/row\.formulaDiagnosticScore != null/, 'ranking must retain formula score fallback so every analyzed direction can be displayed');
mustMatch(/row\.provider === 'TAI888_READER_AUTO'/, 'ranking must accept only Reader-signed actual rows');
mustMatch(/row\.evCalibration\?\.actualReaderEligible === true/, 'ranking must require the server-preserved fresh Reader qualification');
mustMatch(/const currentReaderPrice = gamePrestart/, 'ranking must calculate current Reader execution eligibility separately from display');
mustMatch(/比賽已開始｜保留賽前分析｜停止下注與目前排名資格/, 'started games must retain their completed pregame score while execution is disabled');
mustMatch(/Reader盤口等待最新驗證｜保留上一版分析/, 'stale Reader prices must retain their completed score while execution is disabled');
assert.doesNotMatch(page, /invalidateShadowScoreRow\(row, '獨立國際市場報價已超過5分鐘/, 'expired external consensus must remain audit-only');
mustMatch(/clientReaderPriceCurrent: currentReaderPrice/, 'stale Reader rows must retain completed scores and current-price status');
mustMatch(/recordable=\{betRecordable\(item, row, now, betsEnabled\)\}/, 'every prestart actual Reader direction with real water must expose bet recording');
assert.doesNotMatch(page, /item\.readerPayloadHash === readerStatus\?\.payloadHash\s*&&\s*acknowledgedReaderKey/, 'a successfully analyzed current item must not be blocked by an unrelated full-slate acknowledgement');
mustMatch(/item\.readerPayloadHash === readerStatus\?\.payloadHash\s*&&\s*actualLineFreshNow\(row, clockNow\)/, 'ranking must use per-item current hash and live line freshness');
mustMatch(/pollReaderAndReprice\(\);\s*const timer = window\.setInterval/, 'Reader validation must run immediately instead of waiting for the first interval');
mustMatch(/\}, \[board\.length, date, busy, league, readerEnabled, analysisEnabled\]\);/, 'Reader polling must not restart on every board item update');
mustMatch(/advanceUnchangedReaderGame\(previous, foundCredit\.markets, credit\.payloadHash, credit\.pageActivityAt\)/, 'a mobile reload must resume past completed unchanged games');
mustMatch(/actual\?\.markets\?\.length && !item\.resumedCurrentReaderGame/, 'completed unchanged games must not be requeued from the first game');
const scoreOnlyInvalidation = page.slice(
  page.indexOf('const invalidateShadowScoreRow'),
  page.indexOf('const invalidateReaderPriceRow'),
);
assert.doesNotMatch(scoreOnlyInvalidation, /lineFresh:\s*false|actualReaderEligible:\s*false|executable:\s*false/, 'external-reference expiry must not invalidate a still-fresh Reader price or hide actual-bet recording');
assert.doesNotMatch(page, /invalidateReaderPriceRow/, 'client time progression must not destroy a completed immutable score');
mustMatch(/recordable = betRecordable\(entry\.item, entry\.row, clockNow, bettingEnabled\)/, 'ranking must expose bet recording for every prestart actual Reader direction');
const gameCardGuard = page.slice(page.indexOf('function GameCard'), page.indexOf('function LeagueSetupPanel'));
assert.doesNotMatch(gameCardGuard, /referenceEvidenceFreshNow/, 'external-reference freshness must not hide model W/R');
mustMatch(/const qaPassed = row\.scoreAudit\?\.ok === true/, 'ranking must preserve QA PASS as a visible qualification flag');
mustMatch(/row\.pairAudit\?\.passed !== false/, 'ranking must require pair QA');
mustMatch(/Number\(row\.weightedEV\) > 0/, 'ranking eligibility must still require positive Weighted EV without hiding other directions');
mustMatch(/Number\(row\.robustEV\) > 0/, 'ranking eligibility must still require positive Robust EV without hiding other directions');
mustMatch(/score != null && score >= 7\.2/, 'ranking eligibility must retain the 7.2 threshold without filtering lower scores from display');
mustMatch(/row\.evCalibration\?\.scenarioStable === true/, 'ranking eligibility must retain the model-scenario stability gate without hiding unstable directions');
assert.doesNotMatch(page, /row\.evCalibration\?\.extreme !== true/, 'ranking must not use a 15% cliff after continuous plausibility calibration');
mustMatch(/應評 \{expectedDirectionCount\} 方向/, 'per-game expected direction coverage missing');
mustMatch(/已評 \{scoredDirectionCount\}\/\{expectedDirectionCount\}/, 'per-game scored direction coverage missing');
mustMatch(/排名資格：/, 'score qualification reason must be visible');
mustMatch(/資料QA：PASS/, 'data QA must be presented separately from ranking qualification');







mustMatch(/V10\.6狀態感知相關風險聯合比分模型影子 S 分數/, 'score label must disclose state-aware correlated joint-score model semantics');
mustMatch(/\$\{provisionalBaseline \? '連續合理性校準' : '狀態模型'\}等效條件勝率 \${pct\(row\.modelProbability\)}（排除等效走水）/, 'resolved-only probability must distinguish continuous plausibility calibration from state-model probability');
mustMatch(/等效贏 \${pct\(row\.equivalentWinProbability\)}／等效輸 \${pct\(row\.equivalentLossProbability\)}／等效走水 \${pct\(row\.equivalentPushProbability\)}/, 'equivalent settlement probabilities used by model probability and W must be visible');
mustMatch(/全贏 \${pct\(row\.fullWinProbability\)}／部分贏 \${pct\(row\.partialWinProbability\)}／純走水 \${pct\(row\.pushProbability\)}／混合中性 \${pct\(row\.mixedNeutralProbability\)}／部分輸 \${pct\(row\.partialLossProbability\)}／全輸 \${pct\(row\.fullLossProbability\)}/, 'all visible settlement probability buckets must be shown');
mustMatch(/模型診斷W \${pct\(row\.weightedEV\)}/, 'W must be labelled as an unvalidated model diagnostic');
mustMatch(/保守診斷R \${pct\(row\.robustEV\)}/, 'R must be labelled as an unvalidated conservative diagnostic');
mustMatch(/情境差距 \${pct\(row\.evCalibration\?\.rawScenarioSpread\)}/, 'W/R scenario spread must be visible');
mustMatch(/合格模型影子分數啟用/, 'provider status must report model shadow-score mode');
mustMatch(/Tai888只作成交價/, 'Tai888 execution-price-only role must be visible');
mustMatch(/獨立市場只作可選/, 'independent market must be disclosed as optional audit-only');
assert.doesNotMatch(page, /公式診斷分/, 'website must not expose a second diagnostic-score language');
assert.doesNotMatch(page, /Raw W EV|保守 R EV/, 'website must use the agreed weighted/robust EV labels');
mustMatch(/不產生有效EV、不評分、不列排名/, 'unqualified model or reference evidence must fail closed in the primary UI');
assert.doesNotMatch(page, /原始W \$\{pct\(|原始R \$\{pct\(/, 'primary UI must not expose blocked raw EV percentages');
mustMatch(/聯盟模型重建中｜EV與S分數暫停顯示/, 'unvalidated Asian leagues must hide misleading EV/S values');

// Batch analysis cannot be held indefinitely or overload a mobile connection.
mustMatch(/ANALYSIS_REQUEST_TIMEOUT_MS = 120_000/, 'Production-safe per-game deadline missing');
mustMatch(/runPool\(tasks, analysisConcurrency/, 'bounded league-aware analysis pool missing');
mustMatch(/重試 \$\{retryIndexes\.length\} 場未完成分析/, 'trailing retry pass missing');
mustMatch(/tasks\[index\]\?\.retryable === false/, 'permanent failures must not be retried');
mustMatch(/running: 1, total: 1/, 'single-request phases must report one active request');
mustMatch(/const key = readerHashKey\(date, readerStatus\?\.payloadHash\)/, 'restored board must bind validation to the current Reader revision');
mustMatch(/window\.setTimeout\(\(\) => oneClickAnalyze\(key\), 250\)/, 'restored partial board must rebuild the full official slate instead of repricing only cached games');

console.log('Page Reader automation, four-league navigation, storage continuity, board authority and all-score presentation PASS');
