import assert from 'node:assert/strict';
import fs from 'node:fs';
import { APP_VERSION } from '../lib/app-version.js';

const page = fs.readFileSync('app/page.js', 'utf8');
const css = fs.readFileSync('app/globals.css', 'utf8');
const cloudLedgerSyncPolicy = fs.readFileSync('lib/cloud-ledger-sync-policy.js', 'utf8');
const healthRoute = fs.readFileSync('app/api/health/route.js', 'utf8');
const analyzeRoute = fs.readFileSync('app/api/analyze/route.js', 'utf8');
const betPricesRoute = fs.readFileSync('app/api/bet-prices/route.js', 'utf8');
const readerIngestRoute = fs.readFileSync('app/api/reader/ingest/route.js', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packageLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const mustMatch = (pattern, label) => assert.match(page, pattern, label);
mustMatch(/>全部方向<\//, 'ranking tab must identify the all-direction score output');
mustMatch(/const hasCurrentPrestartGame = board\.some\(item => gameIsPrestartNow\(item\?\.game, stamp\)\)/, '跨盤日必須依是否仍有未開賽場次判斷，不得被昨日已完成快取卡片卡住');
mustMatch(/latest\.boardDate > currentDateRef\.current[\s\S]*!manualDateSelectionRef\.current\.has\(league\)[\s\S]*&& !hasCurrentPrestartGame/, 'Reader只能在該聯盟未手選日期時向前切換新盤日');


// Release identity and storage continuity. The storage key deliberately stays stable
// so a display-version bump cannot erase local settings or the emergency bet backup.
mustMatch(/import \{ APP_VERSION \} from '\.\.\/lib\/app-version\.js'/, 'UI must use the shared release version');
mustMatch(/const VERSION = APP_VERSION/, 'UI badge must use the shared release version');
assert.equal(packageJson.version, '11.8.35', 'package/release identity must match the V11.8.35 current-board bet evidence fix');
assert.equal(packageLock.version, '11.8.34', 'package-lock dependency graph remains unchanged by V11.8.35');
assert.equal(packageLock.packages?.['']?.version, '11.8.34', 'root lockfile dependency graph remains unchanged by V11.8.35');
assert.equal(APP_VERSION, '11.8.35');
mustMatch(/scoreBreakdown\?\.rawScore/, 'a QA-blocked formula must remain visible while ranking and betting stay blocked');
mustMatch(/Reader複核中｜按此排隊分析/, 'manual analysis must stay actionable during an automatic Reader poll');
mustMatch(/queuedAnalysisRef\.current = queued[\s\S]*已排隊，複核完成後會自動開始/, 'a tap during Reader polling must queue analysis and acknowledge the tap');
mustMatch(/queuedForCurrentBoard[\s\S]*void oneClickAnalyze\(\)/, 'queued analysis must start automatically after Reader polling finishes');
mustMatch(/className="heroActionStatus" role="status" aria-live="polite"/, 'mobile controls must expose adjacent live progress feedback');
assert.doesNotMatch(page, /disabled=\{busy \|\| readerPolling \|\| allLeaguePreparing \|\| allLeagueRunning \|\| !analysisEnabled\}/, 'Reader polling must not silently disable the manual analysis button');
assert.match(css, /\.heroActionStatus/, 'queued and running analysis status must remain visible beside the button');
assert.doesNotMatch(page, /if \(row\?\.evCalibration\?\.scenarioStable !== true\) return/, 'W/R scenario spread warning must not block the client ranking verdict');
mustMatch(/const scenarioWarning = row\?\.evCalibration\?\.scenarioStable === false/, 'client ranking verdict must retain the W/R scenario-spread warning');
mustMatch(/const dataQualityWarningOnly = row\?\.scoreBreakdown\?\.dataQualityWarningOnly === true/, 'cached low-quality analysis must be treated as warning-only in the client verdict');
mustMatch(/className="appRefreshButton"[^>]*onClick=\{\(\) => window\.location\.reload\(\)\}>↻ 更新<\//, 'header must provide a one-tap manual update button');
mustMatch(/function requestJSONWithTransientRetry\([\s\S]*delaysMs = \[0, 1500, 4000\][\s\S]*transientAnalysisError\(error\)/, 'Safari transient fetch failures must retry before an all-league batch is marked failed');
mustMatch(/AbortError'[\s\S]*timeoutError\.code = 'REQUEST_TIMEOUT'[\s\S]*function transientAnalysisError\(error\)[\s\S]*REQUEST_TIMEOUT'\) return true/, 'browser request timeouts must retain a stable transient retry code');
mustMatch(/const creditRequestId = uid\(\)[\s\S]*requestJSONWithTransientRetry\('\/api\/credit-lines'[\s\S]*'Idempotency-Key': creditRequestId/, 'Reader credit-line retries must reuse one idempotency key');
assert.match(healthRoute, /const version = APP_VERSION/, 'health endpoint must use the same shared release version as the website');
assert.match(healthRoute, /gameDistributionCacheVersion: GAME_DISTRIBUTION_CACHE_VERSION/, 'health endpoint must expose the game-distribution cache contract');
assert.match(healthRoute, /const ready = readinessReasons\.length === 0/, 'authenticated health must publish a fail-closed Production readiness decision');
assert.match(page, /requestJSON\('\/api\/health', \{\}, 20000, \{ allowApplicationFailure: true \}\)/, 'health readiness false must remain visible instead of being mislabeled as a transport failure');
assert.match(healthRoute, /databaseConfigured = analysisPitDatabaseConfigured\(\)/, 'health readiness must use the same PIT database contract as analysis persistence');
assert.match(healthRoute, /ready,/, 'health must expose readiness to the UI');
assert.match(healthRoute, /readinessReasons,/, 'health must expose actionable readiness reasons to the UI');
assert.match(healthRoute, /readinessBasis: 'CONFIGURATION_ONLY_PERSISTENCE_CONFIRMED_PER_ANALYSIS'/, 'health must not claim a config-only DB check is a live connection probe');
mustMatch(/必要設定已提供｜PIT寫入依逐場狀態/, 'header must not claim the database is connected or a write confirmed from configuration alone');
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
mustMatch(/latest\.boardDate > currentDateRef\.current/, 'Reader forward-only date auto-switch guard missing');
mustMatch(/manualDateSelectionRef\.current\.has\(league\)/, 'Reader date auto-switch must respect per-league manual authority');
mustMatch(/setLeagueBoardDate\(league, latest\.boardDate\)/, 'Reader date auto-switch missing');
mustMatch(/<span className="kicker">v\{VERSION\} 四聯盟 PIT 影子驗證<\/span>/, 'visible model card must use the current app release instead of a stale hard-coded version');
mustMatch(/readerHashKey\(date, readerStatus\?\.payloadHash\)/, 'Reader hash key must include date and payload hash');
mustMatch(/liveReaderHashMatches/, 'live Reader hash confirmation missing');
mustMatch(/const READER_RECHECK_INTERVAL_MS = 30 \* 1000/, 'Reader thirty-second recheck cadence missing');
mustMatch(/setInterval\(refreshReader, READER_RECHECK_INTERVAL_MS\)/, 'Reader status polling interval missing');
mustMatch(/setInterval\(\(\) => pollReaderAndReprice\(\), READER_RECHECK_INTERVAL_MS\)/, 'Reader repricing interval missing');
mustMatch(/touchReaderHeartbeat/, 'same-content Reader heartbeat must refresh freshness without repricing');
assert.doesNotMatch(page, /lastFullAnalysisAtRef/, 'the client must never force a destructive full-board rerun on a timer');

// Reader discovery may refresh status, but entering or reopening the app must
// never start an analysis until the user presses a single- or all-league button.
mustMatch(/manualAnalysisScopesRef/, 'manual analysis session scope guard missing');
mustMatch(/operationBusyRef/, 'operation concurrency guard missing');
mustMatch(/readerPollBusyRef/, 'Reader polling concurrency guard missing');
mustMatch(/readerStatus\?\.fresh/, 'fresh Reader gate missing');
assert.doesNotMatch(page, /Promise\.resolve\(oneClickAnalyze\(key\)\)/, 'fresh Reader status must not automatically start MLB analysis');
assert.doesNotMatch(page, /void oneClickAnalyze\(key\)/, 'restored analysis must remain visible without automatically rerunning the full slate');
mustMatch(/JSON\.stringify\(\{ league, date: targetDate, schedule: games \}\)/, 'credit-line request must bind league, date and schedule');
mustMatch(/provider === 'TAI888_READER_AUTO'/, 'Reader provider authority missing');
mustMatch(/credit\?\.readerFresh === true/, 'fresh credit snapshot gate missing');
mustMatch(/requestJSON\('\/api\/analysis-jobs'/, 'full-board analysis must start one durable server workflow');
mustMatch(/saveBackgroundJob\(/, 'background workflow identity must survive an app close or reload');
mustMatch(/tab !== 'bets' \\|\\| cloudLedgerStatus\\.state !== 'ready'[\\s\\S]*refreshSettlements\\(''\\)[\\s\\S]*\\[storageReady, tab, league, cloudLedgerStatus\\.state\\]/, 'bet ledger must retry automatic settlement after its initial cloud sync becomes ready');
mustMatch(/pollBackgroundJob\([\s\S]*job\.runId,[\s\S]*generation,[\s\S]*targetDate,[\s\S]*tasks\.map/, 'the app must reconnect to the server workflow result with its owned game scope');
assert.doesNotMatch(page, /V10模擬次數|4000（固定）/, 'fake simulation setting must be removed from the UI');

// External markets are fetched only as isolated verification evidence.
mustMatch(/async function fetchReferenceLines\(games, targetDate = date, targetGames = \[\]\)/, 'target-aware reference-line loader missing');
mustMatch(/requestJSON\('\/api\/reference-lines'/, 'client must request the audit-only reference-line API');
mustMatch(/REFERENCE_REFRESH_INTERVAL_MS = 2 \* 60 \* 1000/, 'external evidence must refresh before its five-minute expiry');
mustMatch(/referenceRefreshDue/, 'same-hash Reader polling must still refresh expiring external evidence');
mustMatch(/只作驗證，不改W\/R/, 'the result row must visibly separate external verification from W/R');
mustMatch(/body: JSON\.stringify\(\{ league, date: targetDate, schedule: games \}\)/, 'reference request must bind league, date and official schedule');
mustMatch(/const referenceByPk = new Map/, 'reference markets must be isolated by official gamePk');
mustMatch(/verificationMarkets: referenceByPk\.get\(Number\(item\.game\.gamePk\)\)\?\.markets \|\| item\.verificationMarkets \|\| \[\]/, 'per-game analysis task must retain its signed reference markets');
mustMatch(/verificationMarkets: task\.verificationMarkets \|\| \[\]/, 'full analyze request must send matched reference markets');
mustMatch(/verificationMarkets: referenceByPk\.get\(Number\(item\.game\.gamePk\)\)\?\.markets \|\| item\.verificationMarkets \|\| \[\]/, 'reprice request must refresh or retain matched reference markets');
mustMatch(/restoredBoardNeedsValidationRef\.current\) return undefined/, 'restored partial board must not race a single-board reader reprice');
mustMatch(/missingReaderGameCount > 0[\s\S]*fullSlateRecoveryNeeded = true/, 'reader games missing from the rendered board must trigger full-slate recovery');
mustMatch(/\(fullSlateRecoveryNeeded \|\| queuedForCurrentBoard\) && stillCurrent\(\)[\s\S]*oneClickAnalyze\(\)/, 'full-slate recovery or a queued user tap must run after releasing the reader poll lock');
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
mustMatch(/開賽前最後盤/, 'ledger must label the final verified prestart Reader contract');
mustMatch(/下注時分數/, 'ledger must retain the placed S/W/R beside the closing S/W/R');
mustMatch(/最後盤分數/, 'ledger must display closing S/W/R calculated from the frozen PIT distribution');
mustMatch(/requestJSON\('\/api\/bet-prices'/, 'ledger must refresh Reader price comparisons independently');
assert.match(betPricesRoute, /listCloudBetsByIds/, 'price feed must resolve only requested server-owned tickets');
assert.match(betPricesRoute, /loadReaderSnapshot/, 'price feed must use the Reader snapshot authority');
assert.match(betPricesRoute, /currentReaderPriceForBet/, 'price feed must match the same ticket position');
assert.match(betPricesRoute, /current: status\.fresh \?/, 'stale Reader prices must not be presented as current');
assert.match(betPricesRoute, /verifiedClosingPriceForBet/, 'Closing CLV must require a verified closing snapshot');
assert.match(readerIngestRoute, /updateOpenCloudBetClosingSnapshots/, 'Reader ingest must overwrite the one prestart closing candidate for open bets');
assert.match(readerIngestRoute, /trackOpenBetClosingSnapshots\(refreshed\)/, 'Reader heartbeat must initialize missing pre-v11.6.5 closing candidates without storing a history series');
assert.match(readerIngestRoute, /trackOpenBetClosingSnapshots\(normalized\)/, 'changed Reader payloads must update the latest prestart contract');
mustMatch(/summarizeBetLedger/, 'ledger statistics missing');
mustMatch(/此方向已經記錄；盤口或水位變動也不再新增/, 'single-position bet suppression text missing');
assert.doesNotMatch(page, /加注目前盤/, 'same direction must never expose a reprice add-on action');
mustMatch(/記錄實際下注/, 'actual-bet action missing');
mustMatch(/每筆實際下注金額/, 'stake preset must be labelled as an actual-ledger amount rather than a model Unit');
assert.doesNotMatch(page, />1 Unit 金額</, 'formal Unit is disabled and must not appear as an active setting');
assert.match(page, /unit: null/, 'actual ledger writes must not claim a model Unit');
mustMatch(/不可變帳本/, 'ledger must disclose immutable evidence retention');
mustMatch(/下注證據永久保留；取消只變更狀態，不會刪除/, 'ledger cancellation must preserve original evidence instead of deleting it');
mustMatch(/action: 'cancel'/, 'prestart OPEN bet cancellation action missing');
assert.doesNotMatch(page, /action: 'delete'|action: 'clearLeague'/, 'client must not call unsupported destructive ledger actions');
assert.match(cloudLedgerSyncPolicy, /CLOUD_LEDGER_FAILURE_BACKOFF_MS/, 'DB失敗後必須停止每15秒重打雲端帳本');
assert.match(page, /cloudLedgerAutomaticRefreshAllowed/, '帳本與結算輪詢必須共用可見分頁與退避政策');
assert.match(page, /!\['bets', 'performanceStats'\]\.includes\(tab\)/, '下注紀錄與績效統計頁都必須在帳本 ready 後自動觸發結算');
assert.match(page, /模型分析完成｜PIT未保存、實際下注紀錄暫停/, 'PIT失敗必須保留模型分析並清楚停用 durable bet recording');
assert.match(page, /PIT永久保存未確認｜保留模型分析與排名｜實際下注紀錄暫停/, 'PIT失敗不得取消已完成的模型排名');
assert.match(page, /盤口內容時間：/, 'Reader來源卡必須區分盤口內容時間與服務心跳');

// Ranking rows must retain the original item/row and expose the same immutable
// cloud-ledger action as the board instead of becoming a read-only desktop view.
mustMatch(/return \{ item, row, (?:stableKey, )?gamePk:/, 'ranking entries must retain their source board item and actual market row');
const rankingStart = page.indexOf("{tab === 'ranking' && <section");
const rankingEnd = page.indexOf("{tab === 'betOrder' && <section", rankingStart);
assert.ok(rankingStart >= 0 && rankingEnd > rankingStart, 'ranking UI section missing');
const rankingUi = page.slice(rankingStart, rankingEnd);
assert.match(rankingUi, /getBetState\(entry\.item,\s*entry\.row\)/, 'ranking action must read the same cloud/local bet state as the board');
assert.match(rankingUi, /betRecordable\(entry\.item,\s*entry\.row,\s*clockNow,\s*bettingEnabled,\s*entry\.currentReaderPrice,\s*cloudLedgerActionState === 'ready'\)/, 'ranking action must wait for every durable ledger operation before it can write');
assert.match(rankingUi, /recordBet\(entry\.item,\s*entry\.row\)/, 'ranking button must call the canonical cloud recordBet flow');
assert.match(rankingUi, /\{action\.text\}/, 'ranking row must visibly expose its placed, recordable, or blocked action state');
mustMatch(/text: '已下注 ✓'/, 'placed action label missing');
mustMatch(/text: cancelled \? '重新紀錄下注' : '紀錄實際下注'/, 'recordable and rebet action labels missing');
assert.match(rankingUi, /betActionState/, 'ranking rows must render an explicit enabled or disabled action state');
assert.doesNotMatch(rankingUi, /\(recordable \|\| betState\.latest\) &&/, 'ranking action must never disappear merely because durable recording is temporarily blocked');
mustMatch(/'永久帳本暫停'/, 'ranking action must explain a cloud-ledger outage instead of disappearing');
assert.match(rankingUi, /全部方向/, 'ranking UI must explicitly identify all-direction display');
assert.match(rankingUi, /負EV、R≤0、QA BLOCK與低分方向都不刪除/, 'ranking UI must explain that all analyzed directions remain visible');
assert.match(rankingUi, /Reader覆蓋/, 'ranking UI must disclose Reader slate coverage for cross-snapshot comparisons');
assert.match(rankingUi, /盤口雜湊/, 'ranking UI must expose a short Reader snapshot identity');
assert.match(rankingUi, /不能與其他時點、其他盤口快照混合比較/, 'ranking UI must prevent cross-snapshot score comparisons');
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
assert.match(page, />影子候選順序<\//, 'shadow candidate-order tab must sit beside the ranking tab without implying a formal bet order');
assert.match(page, /buildBetOrderEntries\(shadowRanking\)/, 'bet order must derive from the same immutable Reader ranking entries');
assert.match(page, /groupBetOrderEntries\(shadowBetOrder\)/, 'bet order must group directions by game');
assert.match(betOrderUi, /全場讓分、全場大小、上半讓分、上半大小/, 'bet-order UI must disclose its fixed market order');
assert.match(betOrderUi, /getBetState\(entry\.item, entry\.row\)/, 'bet order must reuse the canonical cloud/local bet state');
assert.match(betOrderUi, /betRecordable\(entry\.item, entry\.row, clockNow, bettingEnabled, entry\.currentReaderPrice, cloudLedgerActionState === 'ready'\)/, 'bet order must wait for every durable ledger operation');
assert.match(betOrderUi, /recordBet\(entry\.item, entry\.row\)/, 'bet-order button must use the canonical cloud record flow');
assert.match(betOrderUi, /\{action\.text\}/, 'bet order must visibly preserve already-recorded and blocked action states');
assert.match(betOrderUi, /betActionState/, 'bet order must expose a disabled reason when a record cannot be persisted');

// Fail-closed market coverage and all-direction diagnostic score presentation.
mustMatch(/已開 \{openMarketCount\}\/4 市場/, 'partial-market coverage counter missing');
mustMatch(/資料異常｜不評分/, 'blocked market must fail closed');
mustMatch(/尚未開盤/, 'unopened market state missing');
mustMatch(/marketState === 'AVAILABLE' \? '已完成分析'/, 'available market state must be translated for the UI');
mustMatch(/marketState === 'BLOCKED' \? '資料異常'/, 'blocked market state must be translated for the UI');
mustMatch(/status === 'UNOPENED' \? '等待開盤'/, 'unopened QA state must be translated instead of leaking the enum');
mustMatch(/readerWaitingSummary/, 'an all-unopened board must collapse to one compact Reader waiting summary');
mustMatch(/尚未開盤｜Reader持續監看/, 'a partial board must collapse each unopened market instead of drawing two blank direction rows');
mustMatch(/const storedFormulaScore = formulaScoreValue\(row\)/, 'every calculable direction must expose its fixed-formula score');
mustMatch(/formulaScore\.toFixed\(1\)/, 'fixed S score must always render as a number');
mustMatch(/QA BLOCK/, 'QA-blocked directions must remain visibly identified');
mustMatch(/模型／Tai888去水機率高度分歧/, '10pp market disagreement must remain visible as a warning');
mustMatch(/資料／數學 QA：\{qaLabel\}/, 'true QA and diagnostic warnings must be displayed separately');
mustMatch(/排名資格：\{rankText\}/, 'ranking qualification must remain visible');
assert.doesNotMatch(page, /正式下注資格：否|不可下注|不下注/, 'front-end model rows must not issue direct no-bet wording');
assert.doesNotMatch(page, /rawShadowScore != null && rawShadowScore >= 7\.2/, 'display must not hide scores below 7.2');
assert.doesNotMatch(page, /Number\(row\?\.weightedEV\) <= 0 \? 'PASS'/, 'negative EV must still display the fixed numeric S score');
mustMatch(/const score = formulaScoreValue\(row\)/, 'ranking must retain the canonical formula score so every analyzed direction can be displayed');
mustMatch(/row\.provider === 'TAI888_READER_AUTO'/, 'ranking must accept only Reader-signed actual rows');
mustMatch(/row\.evCalibration\?\.actualReaderEligible === true/, 'ranking must require the server-preserved captured Reader qualification');
mustMatch(/const currentReaderPrice = readerQualified && capturedReaderContractReady/, 'ranking must calculate captured Reader execution eligibility separately from display');
mustMatch(/比賽已開始｜保留賽前分析與排名｜停止記錄新下注/, 'started games must retain their completed pregame score and ranking while execution is disabled');
mustMatch(/尚無已驗證的Reader盤口｜保留分析/, 'rows without captured Reader evidence must retain their completed score while execution is disabled');
assert.doesNotMatch(page, /invalidateShadowScoreRow\(row, '獨立國際市場報價已超過5分鐘/, 'expired external consensus must remain audit-only');
mustMatch(/clientReaderPriceCurrent: currentReaderPrice/, 'stale Reader rows must retain completed scores and current-price status');
mustMatch(/recordable=\{betRecordable\(item, row, now, betsEnabled, row\.clientReaderPriceCurrent, cloudLedgerState === 'ready'\)\}/, 'bet recording must require captured Reader-price proof and a ready durable ledger calculated by GameCard');
mustMatch(/\{actualLine && <div>/, 'actual Reader directions must retain a visible action even while recording is blocked');
assert.doesNotMatch(page, /item\.readerPayloadHash === readerStatus\?\.payloadHash\s*&&\s*acknowledgedReaderKey/, 'a successfully analyzed current item must not be blocked by an unrelated full-slate acknowledgement');
mustMatch(/function capturedReaderContractReady\(item, row, now = Date\.now\(\)\)[\s\S]*retainedGameIsInactive\(item\)[\s\S]*actualReaderEligible === true/, 'recording must use a completed captured Reader contract while rejecting games removed from the official pregame slate');
assert.doesNotMatch(page, /actualLineFreshNow\(/, 'the client must not re-expire a row after the current Reader hash has already proved identical content; the bet API performs the authoritative line-freshness check');
mustMatch(/pollReaderAndReprice\(\);\s*const timer = window\.setInterval/, 'Reader validation must run immediately instead of waiting for the first interval');
mustMatch(/\}, \[board\.length, date, busy, league, readerEnabled, analysisEnabled, allLeagueRunning\]\);/, 'Reader polling must not restart on every board item update and must stop while all-league analysis runs');
mustMatch(/advanceUnchangedReaderGame\(previous, foundCredit\.markets, credit\.payloadHash, credit\.pageActivityAt, Date\.now\(\), \{[\s\S]*marketCoverage: foundCredit\.marketCoverage,[\s\S]*readerProvenance: foundCredit\.readerProvenance/, 'a mobile reload may resume only when current signed per-game markets and coverage evidence are unchanged');
mustMatch(/return actual\?\.markets\?\.length && !item\.resumedCurrentReaderGame && !item\.preservedCurrentReaderGame/, 'only Reader games with actual market rows may enter the model queue');
mustMatch(/const previousByPk = new Map\(boardRef\.current\.map/, 'manual and automatic refreshes must merge against the latest board instead of a stale React closure');
mustMatch(/shouldPreserveCalculatedAnalysis/, 'a partial or unopened Reader result must not downgrade completed W\/R');
mustMatch(/const retainingPreviousRevision = preservePreviousReaderAnalysis \|\| pendingReaderAnalysis[\s\S]*customMarkets: resumed\?\.customMarkets \|\| \(retainingPreviousRevision \? previous\?\.customMarkets \|\| \[\]/, 'a changed Reader revision must keep the previously analyzed markets until its new distribution commits atomically');
mustMatch(/readerPayloadHash: resumed\?\.readerPayloadHash \|\| null/, 'a queued Reader revision must remain non-executable until analysis succeeds');
mustMatch(/const retainedFinishedItems = \[\.\.\.previousByPk\.values\(\)\][\s\S]*analysisHasCalculatedDirections[\s\S]*readerPayloadHash: null[\s\S]*const items = \[[\s\S]*\.\.\.activeItems\.sort\(byStartTime\)[\s\S]*\.\.\.retainedFinishedItems\.sort\(byStartTime\)/, 'a full-slate refresh must retain old analysis below the current official pregame slate');
mustMatch(/readerResultIsStale/, 'late background results must be rejected when the live Reader hash has advanced');
mustMatch(/function taskReaderStateIsStale\(task\)[\s\S]*readerEvidenceIsOlder\([\s\S]*currentItem\?\.actualSource,[\s\S]*currentItem\?\.latestReaderSource/, 'late success and failure results must respect the newest single-game Reader evidence time');
mustMatch(/commitAnalysisFailure\(task, value\)[\s\S]*taskReaderStateIsStale\(task\)/, 'a late failed background job must not overwrite a newer Reader result');
mustMatch(/commitAnalysisFailure\(task, value\)[\s\S]*readerPayloadHash: null/, 'a failed or terminal background job must immediately revoke Reader execution authority');
mustMatch(/credit\?\.code === 'NO_PRESTART_GAMES'[\s\S]*finalizeReaderBoardAtStart/, 'the client must remove empty waiting cards across the official start boundary');
mustMatch(/credit\?\.code === 'NO_PRESTART_GAMES'[\s\S]*autoAnalyzeHashRef\.current = readerHashKey/, 'a terminal same-hash board must be acknowledged locally instead of retrying every render');
mustMatch(/function markReaderBoardVerificationBlocked\(item\)[\s\S]*readerPayloadHash: null[\s\S]*latestMarketCoverage: \{ openMarkets: 0[\s\S]*preservedCurrentReaderGame: preserve[\s\S]*Reader資料驗證未通過/, 'a blocked Reader board must keep prior scores visibly historical while removing ranking and execution authority');
mustMatch(/credit\?\.blocked === true[\s\S]*current\.map\(markReaderBoardVerificationBlocked\)/, 'both manual and polling blocked-board paths must apply the fail-closed preservation state');
mustMatch(/const waitingForReader = preservePreviousReaderAnalysis[\s\S]*represented && \(!hasOpenRows \|\| coverageRegression\)/, 'an unrepresented previous result must be preserved for display only with a null Reader hash');
mustMatch(/const OFFICIAL_PRESTART_RECHECK_MS = 60 \* 1000/, 'same-hash Reader boards must still revalidate the official prestart state every minute');
mustMatch(/Date\.now\(\) - officialPrestartCheckedAtRef\.current < OFFICIAL_PRESTART_RECHECK_MS/, 'the Reader hash fast path must expire for official postponed and cancelled checks');
mustMatch(/expectedReaderHashes[\s\S]*\/api\/credit-lines[\s\S]*taskEvidenceHash = readerGameEvidenceHash\(row\.task\)[\s\S]*liveEvidenceHash = readerGameEvidenceHash\(liveGame\)[\s\S]*applicableRows\.forEach/, 'a completed background job must re-confirm each game against the current official slate and Reader evidence before applying it');
mustMatch(/catch \(cause\) \{[\s\S]*taskReaderStateIsStale\(rebuildTask\)[\s\S]*commitAnalysisFailure\(rebuildTask, cause\)/, 'a late direct-reprice failure must not overwrite newer Reader evidence');
mustMatch(/const currentBlockedMarkets = new Set\(\(item\.latestMarketCoverage \|\| item\.marketCoverage\)\?\.blockedMarkets \|\| \[\]\)/, 'current BLOCKED coverage must hide preserved directions from ranking');
mustMatch(/function readerAnalysisRevisionReady\(item\)[\s\S]*item\?\.status === 'done'[\s\S]*restoredFromCache !== true[\s\S]*pendingReaderAnalysis !== true[\s\S]*analysisFailure == null/, 'only a fully committed, validated Reader revision may regain ranking or bet authority');
mustMatch(/const currentAnalysisExecutable = readerAnalysisRevisionReady\(item\)[\s\S]*Boolean\(item\.readerPayloadHash\)[\s\S]*!preservedReaderAnalysis/, 'preserved analysis must never regain current ranking or bet authority');
mustMatch(/function capturedReaderContractReady\(item, row, now = Date\.now\(\)\)[\s\S]*item\?\.status === 'done'[\s\S]*item\?\.analysisFailure == null/, 'captured Reader recording must remain fail-closed for unfinished or failed analysis revisions');
const rankingDerivation = page.slice(page.indexOf('const shadowRanking = useMemo'), page.indexOf('const shadowBetOrder = useMemo'));
const rankingFilter = rankingDerivation.slice(rankingDerivation.indexOf('.filter(row'), rankingDerivation.indexOf('.map(row'));
assert.doesNotMatch(rankingFilter, /preservedReaderAnalysis/, 'partial, missing or pending Reader revisions must remain visible in ranking while staying non-executable');
const scoreOnlyInvalidation = page.slice(
  page.indexOf('const invalidateShadowScoreRow'),
  page.indexOf('const invalidateReaderPriceRow'),
);
assert.doesNotMatch(scoreOnlyInvalidation, /lineFresh:\s*false|actualReaderEligible:\s*false|executable:\s*false/, 'external-reference expiry must not invalidate a still-fresh Reader price or hide actual-bet recording');
assert.doesNotMatch(page, /invalidateReaderPriceRow/, 'client time progression must not destroy a completed immutable score');
mustMatch(/recordable = betRecordable\(entry\.item, entry\.row, clockNow, bettingEnabled, entry\.currentReaderPrice, cloudLedgerActionState === 'ready'\)/, 'ranking must enable bet recording only for a captured Reader direction and an idle, ready durable ledger');
mustMatch(/currentReaderPrice === true/, 'canonical bet gate must fail closed unless the caller supplies captured Reader proof');
mustMatch(/cloudLedgerWritable === true/, 'canonical bet gate must fail closed unless the durable ledger is writable');
mustMatch(/const currentReaderPrice = capturedReaderContractReady\(item, row, now\)/, 'recordBet must re-check captured Reader evidence and official prestart state at click time');
const gameCardGuard = page.slice(page.indexOf('function GameCard'), page.indexOf('function LeagueSetupPanel'));
assert.doesNotMatch(gameCardGuard, /referenceEvidenceFreshNow/, 'external-reference freshness must not hide model W/R');
assert.match(css, /html,body\{width:100%;max-width:100%;overflow-x:hidden\}/, 'mobile document must never expand beyond the viewport');
assert.match(css, /\.sourceBanner strong,\.sourceBanner span[^}]*overflow-wrap:anywhere;word-break:break-word/, 'long PIT and upstream diagnostic strings must wrap inside cards');
assert.match(css, /\.scoreRow>\*[^}]*min-width:0;max-width:100%/, 'score grid children must be allowed to shrink on mobile');
assert.match(css, /@media\(max-width:720px\)[\s\S]*\.leagueTabs\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);overflow:visible/, 'mobile league navigation must use a non-scrolling grid');
assert.match(css, /@media\(max-width:720px\)[\s\S]*\.mainTabs\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);overflow:visible/, 'mobile function navigation must not retain a horizontal scroll offset');
assert.match(css, /@media\(max-width:720px\)[\s\S]*\.gameHead\{display:grid;grid-template-columns:minmax\(0,1fr\);gap:10px\}/, 'mobile game headers must stack the status badge below the matchup');
assert.match(css, /\.gameHead \.state\{[^}]*max-width:100%;white-space:normal[^}]*overflow-wrap:anywhere;word-break:break-word/, 'long mobile status badges must wrap inside their game card');
mustMatch(/const qaPassed = directionQaPassed\(row\)/, 'ranking must prefer canonical QA status while preserving legacy fallback');
mustMatch(/row\?\.pairAudit\?\.passed !== false/, 'ranking must require pair QA');
mustMatch(/row\.rankingQualified === true/, 'client ranking must honor the signed backend W\/R, 7.2 and true-QA gates instead of reimplementing them');
assert.doesNotMatch(page, /const rankingEligible = pitConfirmed|const rankingEligible = currentReaderPrice/, 'PIT persistence and current-price recording status must not cancel model ranking');
assert.doesNotMatch(page, /const rankingEligible[\s\S]{0,400}Number\(row\.weightedEV\) > 0/, 'client must not drift from backend Weighted EV ranking policy');
assert.doesNotMatch(page, /const rankingEligible[\s\S]{0,400}Number\(row\.robustEV\) > 0/, 'client must not drift from backend Robust EV ranking policy');
mustMatch(/row\?\.extremeEvReviewRequired === true/, 'W≥20% anomaly review must remain visible without rewriting W\/R');
mustMatch(/應評 \$\{expectedDirectionCount\} 方向/, 'per-game expected direction coverage missing');
mustMatch(/已評 \$\{scoredDirectionCount\}\/\$\{expectedDirectionCount\}/, 'per-game scored direction coverage missing');
mustMatch(/🧪 \{item\.game\.leagueId/, 'shadow candidates must use an explicit laboratory marker instead of formal recommendation icons');
mustMatch(/上游資料狀態/, 'per-game upstream feature status must be visible');
mustMatch(/資料截至/, 'point-in-time data timestamp must be visible');
mustMatch(/輸入雜湊/, 'immutable analysis input hash must be visible');
mustMatch(/市場水位回灌：停用/, 'the UI must state that Tai888 price feedback is disabled');
mustMatch(/排名資格：/, 'score qualification reason must be visible');
mustMatch(/資料／數學 QA：\{qaLabel\}/, 'data QA must be presented separately from diagnostic warnings and ranking qualification');







mustMatch(/狀態模型等效條件勝率 \${pct\(row\.modelProbability\)}（排除等效走水）/, 'resolved-only probability must identify the unmodified state-model probability');
assert.doesNotMatch(page, /provisionalBaseline|連續合理性校準/, 'UI must not describe removed Tai888 probability feedback as active');
mustMatch(/等效贏 \${pct\(row\.equivalentWinProbability\)}／等效輸 \${pct\(row\.equivalentLossProbability\)}／等效走水 \${pct\(row\.equivalentPushProbability\)}/, 'equivalent settlement probabilities used by model probability and W must be visible');
mustMatch(/全贏 \${pct\(row\.fullWinProbability\)}／部分贏 \${pct\(row\.partialWinProbability\)}／純走水 \${pct\(row\.pushProbability\)}／混合中性 \${pct\(row\.mixedNeutralProbability\)}／部分輸 \${pct\(row\.partialLossProbability\)}／全輸 \${pct\(row\.fullLossProbability\)}/, 'all visible settlement probability buckets must be shown');
mustMatch(/模型EV（W）/, 'raw distribution EV must use the fixed public W label');
mustMatch(/穩健EV R \{signedPct\(robustEV\)\}/, 'robust EV must be secondary to S and use the fixed public R label');
mustMatch(/function modelEvValue\(row\)[\s\S]*row\?\.rawWeightedEV/, 'W display must fall back to the raw distribution EV when qualification fields are null');
mustMatch(/function robustEvValue\(row\)[\s\S]*row\?\.rawRobustEV/, 'R display must fall back to the raw robust EV when qualification fields are null');
mustMatch(/情境差距 \${pct\(row\.evCalibration\?\.rawScenarioSpread\)}/, 'W/R scenario spread must be visible');
mustMatch(/S分數、W與R完整顯示/, 'provider status must report S-first display mode');
mustMatch(/Tai888與外部市場都不回灌模型概率/, 'Tai888 and external markets must remain execution/audit inputs only');
assert.doesNotMatch(page, /公式診斷分/, 'website must not expose a second diagnostic-score language');
assert.doesNotMatch(page, /Raw W EV|保守 R EV/, 'website must use the agreed weighted/robust EV labels');
mustMatch(/前台以固定S分數為主/, 'the public presentation must be S-first');
assert.doesNotMatch(page, /不顯示W\/R|不顯示為EV/, 'qualification failures must not suppress calculated EV');

// Batch analysis must leave the mobile lifecycle and reconnect to durable server work.
mustMatch(/ANALYSIS_REQUEST_TIMEOUT_MS = 120_000/, 'Production-safe per-game deadline missing');
mustMatch(/伺服器背景分析中｜可離開App/, 'background execution status must explicitly allow leaving the app');
mustMatch(/loadBackgroundJob\(league, date\)/, 'app reopen must resume the active background job');
mustMatch(/state\.status === 'completed'/, 'client must reload completed server workflow results');
mustMatch(/running: 1, total: 1/, 'single-request phases must report one active request');
mustMatch(/restoredBoardNeedsValidationRef\.current = restoredBoard\.length > 0[\s\S]*manualAnalysisScopesRef\.current\.has/, 'restored scores must wait for a manual analysis action before Reader repricing starts');

console.log('Page Reader automation, four-league navigation, storage continuity, board authority and all-score presentation PASS');
