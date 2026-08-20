import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync('app/page.js', 'utf8');
const mustMatch = (pattern, label) => assert.match(page, pattern, label);
mustMatch(/分析排名（驗證中）/, 'ranking tab must use the clear validation label');
assert.doesNotMatch(page, />影子排名</, 'ambiguous shadow ranking label must not be user-facing');

// Release identity and storage continuity. The storage key deliberately stays stable
// so a display-version bump cannot erase local settings or the emergency bet backup.
mustMatch(/const VERSION = '10\.3\.1'/, 'UI must expose the v10.3.1 release');
mustMatch(/const STORAGE = 'sports-positive-ev-v10-0-0'/, 'v10 storage continuity must be preserved');
mustMatch(/sports-positive-ev-bets-backup-v2/, 'bet backup storage must remain enabled');
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
assert.doesNotMatch(page, /league !== 'MLB'|league === 'MLB'/, 'page must not hard-code an MLB-only navigation branch');

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

// Actual-bet ledger and price comparison remain available while formal model scoring is locked.
mustMatch(/betPriceMatches/, 'exact placed-price matching missing');
mustMatch(/compareBetPrice/, 'placed-versus-current price comparison missing');
mustMatch(/summarizeBetLedger/, 'ledger statistics missing');
mustMatch(/目前盤口與水位已經記錄/, 'same-price suppression text missing');
mustMatch(/加注目前盤/, 'reprice add-on action missing');
mustMatch(/記錄實際下注/, 'actual-bet action missing');

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
mustMatch(/row\.scoreAudit\?\.ok === true/, 'ranking must require QA PASS');
mustMatch(/row\.pairAudit\?\.passed !== false/, 'ranking must require pair QA');
mustMatch(/Number\(row\.weightedEV\) > 0/, 'ranking must require positive Raw W EV');
mustMatch(/Number\(row\.robustEV\) > 0/, 'ranking must require positive Robust R EV');
mustMatch(/Number\(row\.shadowDiagnosticScore\) >= 7\.2/, 'ranking must require the 7.2 qualification threshold');
mustMatch(/應評 \{expectedDirectionCount\} 方向/, 'per-game expected direction coverage missing');
mustMatch(/已評 \{scoredDirectionCount\}\/\{expectedDirectionCount\}/, 'per-game scored direction coverage missing');
mustMatch(/排名資格：/, 'score qualification reason must be visible');
mustMatch(/資料QA：PASS/, 'data QA must be presented separately from ranking qualification');
mustMatch(/固定雙EV公式 S 分數/, 'user-facing score label must use the single fixed S-score language');
mustMatch(/加權EV \${pct\(row\.weightedEV\)\}/, 'weighted EV label must be clear');
mustMatch(/穩健EV \${pct\(row\.robustEV\)\}/, 'robust EV label must be clear');
mustMatch(/固定 S 分數啟用/, 'provider status must report fixed S-score mode');
assert.doesNotMatch(page, /公式診斷分/, 'website must not expose a second diagnostic-score language');
assert.doesNotMatch(page, /Raw W EV|保守 R EV/, 'website must use the agreed weighted/robust EV labels');
mustMatch(/原始極端值僅保留於伺服器稽核資料/, 'unqualified extreme EV must be hidden from the primary UI');
assert.doesNotMatch(page, /原始W \$\{pct\(|原始R \$\{pct\(/, 'primary UI must not expose blocked raw EV percentages');
mustMatch(/聯盟模型重建中｜EV與S分數暫停顯示/, 'unvalidated Asian leagues must hide misleading EV/S values');

// Batch analysis cannot be held indefinitely by the first slow games.
mustMatch(/ANALYSIS_REQUEST_TIMEOUT_MS = 65_000/, 'bounded per-game deadline missing');
mustMatch(/runPool\(tasks, 3/, 'three-worker bounded analysis pool missing');
mustMatch(/重試 \$\{retryIndexes\.length\} 場未完成分析/, 'trailing retry pass missing');
mustMatch(/tasks\[index\]\?\.retryable === false/, 'permanent failures must not be retried');
mustMatch(/running: 1, total: 1/, 'single-request phases must report one active request');

console.log('Page Reader automation, four-league navigation, storage continuity, board authority and all-score presentation PASS');
