import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync('app/page.js', 'utf8');
assert.match(page, /const VERSION = '9\.7\.0'/);
assert.match(page, /sports-positive-ev-v9-7-0/);
assert.match(page, /sports-positive-ev-v9-6-0/);
assert.match(page, /mlb-positive-ev-v9-4-4/);
assert.match(page, /betPriceMatches/);
assert.match(page, /compareBetPrice/);
assert.match(page, /summarizeBetLedger/);
assert.match(page, /import \{ LEAGUE_IDS, leagueConfig, normalizeLeagueId \} from '\.\.\/lib\/leagues\.js'/);
assert.match(page, /activeLeague: normalizeLeagueId\(own\.activeLeague\)/);
assert.match(page, /saveCompactStore\(\{ settings, bets, activeLeague: league \}\)/);
assert.match(page, /const analysisEnabled = activeLeague\.capabilities\.analysis === true/);
assert.match(page, /const readerEnabled = activeLeague\.capabilities\.reader === true/);
assert.match(page, /const bettingEnabled = activeLeague\.capabilities\.bets === true/);
assert.match(page, /const shadowMode = activeLeague\.status === 'shadow'/);
assert.match(page, /\[date, league\]/);
assert.doesNotMatch(page, /league !== 'MLB'|league === 'MLB'/);

// Reader authority, date isolation, freshness and immutable revision remain intact.
assert.match(page, /if \(!readerEnabled \|\| !analysisEnabled\) return undefined/);
assert.match(page, /scheduleEndpoint\}\?league=\$\{encodeURIComponent\(league\)\}/);
assert.match(page, /JSON\.stringify\(\{ league, date: targetDate, schedule: games \}\)/);
assert.match(page, /setInterval\(refreshReader, 30000\)/);
assert.match(page, /\/api\/reader\/status\?league=\$\{encodeURIComponent\(league\)\}/);
assert.match(page, /latest\.boardDate !== currentDateRef\.current/);
assert.match(page, /setDate\(latest\.boardDate\)/);
assert.match(page, /readerStatus\?\.payloadHash/);
assert.match(page, /rawBoardHash/);
assert.match(page, /autoAnalyzeHashRef/);
assert.match(page, /shouldAcknowledgeReaderHash/);
assert.match(page, /readerCoverageCounts/);
assert.match(page, /30 \* 60 \* 1000/);
assert.match(page, /verificationMarkets: \[\]/);
assert.match(page, /Tai888實際盤已下架/);
assert.match(page, /confirmLiveReaderHash/);
assert.match(page, /readerRevisionKey/);
assert.match(page, /creditRevisionRef/);
assert.match(page, /pageActivityAt: credit\.pageActivityAt/);
assert.match(page, /item\.readerPayloadHash === readerStatus\?\.payloadHash/);
assert.match(page, /readerPayloadHash: available \? credit\.payloadHash : null/);
assert.match(page, /setAcknowledgedReaderKey\(completedKey\)/);
assert.match(page, /Reader 最新盤面版本尚未承認/);
assert.match(page, /disabled=\{busy\} onChange=\{event => setDate/);
assert.match(page, /credit\?\.provider === 'TAI888_READER_AUTO' && credit\?\.readerFresh === true/);
assert.match(page, /credit\.provider !== 'TAI888_READER_AUTO'/);

// Shadow mode may record a real user bet, but never turns a legacy model number into a formal score.
assert.match(page, /function betRecordable\(item, row, now = Date\.now\(\), betsEnabled = true\)/);
assert.match(page, /gameIsPrestartNow\(item\?\.game, now\)/);
assert.match(page, /row\?\.sourceType === 'ACTUAL_TW_CREDIT'/);
assert.match(page, /row\?\.waterEstimated !== true/);
assert.match(page, /actualLineFreshNow\(row, now\)/);
const betRecordableSource = page.slice(page.indexOf('function betRecordable('), page.indexOf('function compactAnalysisData('));
assert.doesNotMatch(betRecordableSource, /row\.score|7\.2|formalBetEligibility|shadow/);
assert.match(page, /正式模型分數已停用/);
assert.match(page, /正式下注排名已停用/);
assert.match(page, /v9\.4\.4資料鏈已作廢/);
assert.match(page, /score: null/);
assert.match(page, /scoreStatus: 'LEGACY_INVALID'/);
assert.match(page, /betSource: 'MANUAL'/);
assert.match(page, /analysisMode: 'SHADOW'/);
assert.match(page, /legacyDiagnosticScore/);
assert.match(page, /模型分數未列入績效/);
assert.doesNotMatch(page, /校準等值勝率/);
assert.doesNotMatch(page, /正式EV/);

// Exact same price is suppressed; line/water changes use settlement-based comparison and allow an additional ticket.
assert.match(page, /const exact = betState\?\.exact/);
assert.match(page, /compareBetPrice\(\{ bet: latest, row, game/);
assert.match(page, /已下注\$\{betState\?\.records\?\.length > 1/);
assert.match(page, /'加注目前盤'/);
assert.match(page, /'紀錄實際下注'/);
assert.match(page, /comparison\.lineLabel/);
assert.match(page, /comparison\.waterLabel/);
assert.match(page, /下注時：\{latest\.pick\}/);
assert.match(page, /目前：\{row\.pick\}/);
assert.match(page, /state\.exact/);
assert.match(page, /目前盤口與水位已經記錄/);

// Cloud ledger is server-authoritative, supports immutable ticket IDs, settlement refresh and statistics.
assert.match(page, /requestJSON\('\/api\/bets'/);
assert.match(page, /function mergeBetCollections\(first, second\)/);
assert.match(page, /BET_BACKUP_STORAGE/);
assert.match(page, /action: 'merge'/);
assert.match(page, /action: 'upsert'/);
assert.match(page, /action: 'delete', betId: bet\.id/);
assert.match(page, /action: 'settleOpen'/);
assert.match(page, /更新全部賽果/);
assert.match(page, /績效統計/);
assert.match(page, /SummaryCards/);
assert.match(page, /allStats\.groups/);
assert.match(page, /wins\}勝／\{group\.losses\}敗／\{group\.pushes\}走/);
assert.match(page, /ROI \{pct\(group\.roi\)\}/);
assert.match(page, /readerPayloadHash/);
assert.match(page, /readerRevision/);
assert.match(page, /placedContractSnapshot/);
assert.match(page, /settlementRuleVersion/);

const recordBetSource = page.slice(page.indexOf('async function recordBet('), page.indexOf('async function deleteBet('));
assert.doesNotMatch(recordBetSource, /formalBetEligibility|row\.score\s*>?=|shadowMode\)/);
assert.match(recordBetSource, /betIdentity\(date, item\.game\.gamePk, row, league\)/);
assert.match(recordBetSource, /betPositionIdentity\(date, item\.game\.gamePk, row, league\)/);
assert.match(recordBetSource, /if \(!betRecordable\(item, row, Date\.now\(\), bettingEnabled\)\)/);
assert.match(recordBetSource, /已雲端記錄實際下注/);

assert.doesNotMatch(page, /['"]\/api\/reference-lines/);
assert.doesNotMatch(page, />上傳盤口</);
assert.doesNotMatch(page, /運彩賠率/);

const analyze = fs.readFileSync('app/api/analyze/route.js', 'utf8');
const reprice = fs.readFileSync('app/api/reprice/route.js', 'utf8');
for (const source of [analyze, reprice]) {
  assert.match(source, /applyMarketFreshness/);
  assert.match(source, /applyIndependentMarketVerification/);
  assert.match(source, /verificationMarkets/);
  assert.match(source, /sourceTemplateVersion/);
  assert.match(source, /authorizationStatus/);
}

const finalizer = fs.readFileSync('lib/deterministic-finalizer.js', 'utf8');
assert.match(finalizer, /FORMAL_SCORING_ENABLED = false/);
assert.match(finalizer, /scoreStatus = 'LEGACY_INVALID'/);
assert.match(finalizer, /row\.score = null/);
assert.match(finalizer, /formalRecommendationsEnabled: false/);

const betRoute = fs.readFileSync('app/api/bets/route.js', 'utf8');
assert.match(betRoute, /settleOpenCloudBets/);
assert.match(betRoute, /cloudBetStats/);
assert.match(betRoute, /body\.betId \|\| body\.positionIdentity/);

const credit = fs.readFileSync('app/api/credit-lines/route.js', 'utf8');
assert.match(credit, /readerSnapshotMatchesFullOfficialSlate/);
assert.match(credit, /snapshotRows\.length !== slate\.length/);
assert.match(credit, /unopenedGames/);
assert.doesNotMatch(credit, /loadTai888VisibleText/);

const visionRoute = fs.readFileSync('app/api/vision/route.js', 'utf8');
assert.match(visionRoute, /VISION_IMPORT_REMOVED/);
assert.match(visionRoute, /status: 410/);

console.log('Baseball v9.7 Shadow safety, Reader revision, settlement-based price comparison, cloud ledger and statistics audit PASS');
