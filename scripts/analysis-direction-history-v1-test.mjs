import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ANALYSIS_DIRECTION_HISTORY_VERSION,
  ANALYSIS_DIRECTION_SLOTS,
  ANALYSIS_DIRECTION_STAKE_BASIS,
  buildChangedAnalysisDirectionSettlements,
  buildAnalysisDirectionHistory,
  loadAnalysisDirectionHistory,
  normalizeAnalysisDirectionSlots,
  persistAnalysisDirectionHistory,
  persistAnalysisDirectionHistoryBestEffort,
  replayAnalysisDirectionHistory,
  runAnalysisDirectionSettlementTasks,
  settleAnalysisDirectionRecord,
  summarizeAnalysisDirectionHistory,
  validateAnalysisDirectionHistory,
} from '../lib/analysis-direction-history-v1.js';
import { SETTLEMENT_RULE_VERSION } from '../lib/taiwan-settlement-v9.js';
import { MODEL_EV_FORMULA_VERSION, ROBUST_EV_VERSION } from '../lib/analysis-v11.js';
import { DIRECTION_SLOT_CONTRACT_VERSION } from '../lib/direction-slots-v1.js';

const hash = character => character.repeat(64);
const game = {
  leagueId: 'MLB',
  gamePk: 991188,
  gameNumber: 1,
  gameDate: '2099-08-26T10:00:00.000Z',
  officialDate: '2099-08-26',
  awayTeamId: 11,
  homeTeamId: 22,
  away: 'Away',
  home: 'Home',
};
const snapshotRecord = {
  snapshotId: `MLB:${game.gamePk}:FULL:${hash('a')}`,
  parentSnapshotId: null,
  analysisType: 'FULL',
  leagueId: 'MLB',
  gameIdentity: game,
  gameStart: game.gameDate,
  dataAsOf: '2099-08-26T07:55:00.000Z',
  analysisAsOf: '2099-08-26T08:05:00.000Z',
  lineAsOf: '2099-08-26T08:04:00.000Z',
  inputHash: hash('a'),
  priceFingerprint: hash('b'),
  distributionId: 'MLB:991188:frozen-joint-score',
  distributionHash: hash('c'),
  versions: {
    modelVersion: 'MLB-MODEL-v1',
    rulesVersion: 'MLB-RULES-v1',
    dataVersion: 'DATA-v1',
    scoreFormulaVersion: 'SCORE-v1',
    settlementRuleVersion: SETTLEMENT_RULE_VERSION,
    uncertaintySetVersion: 'UNCERTAINTY-v1',
    modelEvFormulaVersion: MODEL_EV_FORMULA_VERSION,
    robustEvVersion: ROBUST_EV_VERSION,
    directionSlotContractVersion: DIRECTION_SLOT_CONTRACT_VERSION,
    repriceVersion: null,
  },
};

const pickBySlot = {
  FULL_RUNLINE_HOME: 'Home讓1',
  FULL_RUNLINE_AWAY: 'Away受讓1',
  FULL_TOTAL_OVER: '大8.5',
  FULL_TOTAL_UNDER: '小8.5',
  FIRST5_RUNLINE_HOME: 'Home讓0.5',
  FIRST5_RUNLINE_AWAY: 'Away受讓0.5',
  FIRST5_TOTAL_OVER: '大4.5',
  FIRST5_TOTAL_UNDER: '小4.5',
};

function allCalculatedSlots(overrides = {}) {
  return ANALYSIS_DIRECTION_SLOTS.map((definition, index) => ({
    ...definition,
    status: 'CALCULATED',
    coverageStatus: 'OPEN',
    coverageErrors: [],
    pick: pickBySlot[definition.slotId],
    water: 0.95 - index * 0.001,
    modelEV: 0.08 - index * 0.02,
    robustEV: 0.04 - index * 0.02,
    robustVariants: [{ id: 'test-conservative-lower', value: 0.04 - index * 0.02 }],
    qaStatus: index === 2 ? 'BLOCK' : 'PASS',
    qaReasons: index === 2 ? ['外部QA只影響排名'] : [],
    score: index === 2 ? null : 7.5,
    rankingEligible: index !== 2,
    betEligible: false,
    readerVersion: '2.2.0 EIGHT DIRECTIONS',
    readerPayloadHash: hash('d'),
    readerRawBoardHash: hash('e'),
    readerGameMarketHash: hash('f'),
    readerBoardDate: game.officialDate,
    lineAsOf: snapshotRecord.lineAsOf,
    sourceType: 'ACTUAL_TW_CREDIT',
    ...overrides[definition.slotId],
  }));
}

const analysis = {
  leagueId: 'MLB',
  directionSlots: allCalculatedSlots(),
  marketCoverage: [
    { market: '全場讓分', status: 'OPEN', rowCount: 2, errors: [] },
    { market: '全場大小', status: 'OPEN', rowCount: 2, errors: [] },
    { market: '上半讓分', status: 'OPEN', rowCount: 2, errors: [] },
    { market: '上半大小', status: 'OPEN', rowCount: 2, errors: [] },
  ],
};

const history = buildAnalysisDirectionHistory({ snapshotRecord, analysis });
assert.equal(history.historySchemaVersion, ANALYSIS_DIRECTION_HISTORY_VERSION);
assert.equal(history.records.length, 8);
assert.equal(new Set(history.records.map(row => row.slotId)).size, 8);
assert.deepEqual(history.records.map(row => row.slotIndex), [1, 2, 3, 4, 5, 6, 7, 8]);
assert.equal(history.records.filter(row => row.status === 'CALCULATED').length, 8);
assert.equal(history.records[2].qaStatus, 'BLOCK');
assert.equal(history.records[2].modelEV, 0.04, 'QA BLOCK不得刪除W');
assert.equal(history.records[2].robustEV, 0, 'R<=0仍必須完整保存');
assert.equal(history.records[0].readerVersion, '2.2.0 EIGHT DIRECTIONS');
assert.equal(history.records[0].readerPayloadHash, hash('d'));
assert.equal(history.records[0].readerRawBoardHash, hash('e'));
assert.equal(history.records[0].readerGameMarketHash, hash('f'));
assert.equal(history.records[0].distributionHash, snapshotRecord.distributionHash);
assert.equal(history.records[0].modelEvFormulaVersion, MODEL_EV_FORMULA_VERSION);
assert.equal(history.records[0].robustEvVersion, ROBUST_EV_VERSION);
assert.equal(history.records[0].directionSlotContractVersion, DIRECTION_SLOT_CONTRACT_VERSION);
assert.equal(history.records[0].stakeBasis, ANALYSIS_DIRECTION_STAKE_BASIS);
assert.equal(validateAnalysisDirectionHistory(history).historyHash, history.historyHash);

const replay = replayAnalysisDirectionHistory(history);
assert.equal(replay.directionSlots.length, 8);
assert.deepEqual(replay.directionSlots.map(row => row.slotId), ANALYSIS_DIRECTION_SLOTS.map(row => row.slotId));
assert.deepEqual(replay.directionSlots.map(row => row.modelEV), history.records.map(row => row.modelEV));
assert.equal(replay.distributionHash, snapshotRecord.distributionHash);

assert.throws(() => normalizeAnalysisDirectionSlots({ directionSlots: analysis.directionSlots.slice(0, 7) }, game), /8個槽位/);
assert.throws(() => normalizeAnalysisDirectionSlots({
  directionSlots: [...analysis.directionSlots.slice(0, 7), { ...analysis.directionSlots[0] }],
}, game), /duplicate|coverage/);
assert.throws(() => buildAnalysisDirectionHistory({
  snapshotRecord,
  analysis: { ...analysis, directionSlots: allCalculatedSlots({ FULL_TOTAL_OVER: { modelEV: null } }) },
}), /CALCULATED.*W/);
assert.throws(() => buildAnalysisDirectionHistory({
  snapshotRecord,
  analysis: { ...analysis, directionSlots: allCalculatedSlots({ FULL_TOTAL_OVER: { robustVariants: [] } }) },
}), /R或保守情境來源/);
assert.throws(() => buildAnalysisDirectionHistory({
  snapshotRecord,
  analysis: {
    ...analysis,
    directionSlots: allCalculatedSlots({ FULL_TOTAL_OVER: { lineAsOf: '2099-08-26T08:06:00.000Z' } }),
  },
}), /Reader.*PIT/);

const missingRobustHistory = buildAnalysisDirectionHistory({
  snapshotRecord: { ...snapshotRecord, inputHash: hash('9'), snapshotId: `MLB:${game.gamePk}:FULL:${hash('9')}` },
  analysis: { ...analysis, directionSlots: allCalculatedSlots({ FULL_RUNLINE_HOME: { robustEV: null } }) },
});
assert.equal(missingRobustHistory.records[0].status, 'CALCULATED');
assert.equal(missingRobustHistory.records[0].modelEV, 0.08, 'R暫時缺失不得隱藏已計算W');
assert.equal(missingRobustHistory.records[0].robustEV, null);

const partialSlots = allCalculatedSlots({
  FULL_TOTAL_OVER: {
    status: 'BLOCKED', coverageStatus: 'BLOCKED', coverageErrors: ['重複方向'],
    pick: null, water: null, modelEV: null, robustEV: null,
  },
  FULL_TOTAL_UNDER: {
    status: 'BLOCKED', coverageStatus: 'BLOCKED', coverageErrors: ['重複方向'],
    pick: null, water: null, modelEV: null, robustEV: null,
  },
  FIRST5_TOTAL_OVER: {
    status: 'UNOPENED', coverageStatus: 'UNOPENED', coverageErrors: [],
    pick: null, water: null, modelEV: null, robustEV: null,
  },
  FIRST5_TOTAL_UNDER: {
    status: 'UNOPENED', coverageStatus: 'UNOPENED', coverageErrors: [],
    pick: null, water: null, modelEV: null, robustEV: null,
  },
});
const partialHistory = buildAnalysisDirectionHistory({
  snapshotRecord: { ...snapshotRecord, inputHash: hash('1'), snapshotId: `MLB:${game.gamePk}:FULL:${hash('1')}` },
  analysis: { ...analysis, directionSlots: partialSlots },
});
assert.equal(partialHistory.records.length, 8);
assert.equal(partialHistory.records.filter(row => row.status === 'CALCULATED').length, 4);
assert.equal(partialHistory.records.filter(row => row.status === 'BLOCKED').length, 2);
assert.equal(partialHistory.records.filter(row => row.status === 'UNOPENED').length, 2);
assert.ok(partialHistory.records.filter(row => row.status !== 'CALCULATED').every(row => row.modelEV == null && row.robustEV == null));

const readerlessPartialSlots = partialSlots.map(slot => {
  const {
    readerVersion, readerPayloadHash, readerRawBoardHash, readerGameMarketHash,
    readerBoardDate, lineAsOf, provider, ...rest
  } = slot;
  return rest;
});
const inheritedReaderHistory = buildAnalysisDirectionHistory({
  snapshotRecord: { ...snapshotRecord, inputHash: hash('7'), snapshotId: `MLB:${game.gamePk}:FULL:${hash('7')}` },
  analysis: {
    ...analysis,
    directionSlots: readerlessPartialSlots,
    marketProvider: 'TAI888_READER_AUTO',
  },
  readerSnapshot: {
    provider: 'TAI888_READER_AUTO',
    readerVersion: '2.2.0 SLATE',
    payloadHash: hash('4'),
    rawBoardHash: hash('5'),
    gameMarketHash: hash('6'),
    boardDate: game.officialDate,
    lineAsOf: snapshotRecord.lineAsOf,
  },
});
assert.ok(inheritedReaderHistory.records.every(record => record.readerVersion === '2.2.0 SLATE'));
assert.ok(inheritedReaderHistory.records.every(record => record.readerPayloadHash === hash('4')));
assert.ok(inheritedReaderHistory.records.every(record => record.readerRawBoardHash === hash('5')));
assert.ok(inheritedReaderHistory.records.every(record => record.readerGameMarketHash === hash('6')));
assert.ok(inheritedReaderHistory.records.every(record => record.readerLineAsOf === snapshotRecord.lineAsOf));
assert.equal(inheritedReaderHistory.records.filter(record => record.status === 'UNOPENED').length, 2,
  'Reader完整slate的未開盤槽位也必須繼承Reader lineage');

const repriceSnapshot = {
  ...snapshotRecord,
  snapshotId: `MLB:${game.gamePk}:PRICE_ONLY_REPRICE:${hash('2')}`,
  parentSnapshotId: snapshotRecord.snapshotId,
  analysisType: 'PRICE_ONLY_REPRICE',
  inputHash: hash('2'),
  priceFingerprint: hash('3'),
  analysisAsOf: '2099-08-26T08:15:00.000Z',
  lineAsOf: '2099-08-26T08:14:00.000Z',
  versions: { ...snapshotRecord.versions, repriceVersion: 'REPRICE-v1' },
};
const repriced = buildAnalysisDirectionHistory({ snapshotRecord: repriceSnapshot, analysis });
assert.equal(repriced.records[0].parentSnapshotId, snapshotRecord.snapshotId);
assert.ok(repriced.records.every(record => record.lineAsOf === repriceSnapshot.lineAsOf), '方向PIT時間必須與父快照精確一致');
assert.equal(repriced.records[0].distributionHash, history.records[0].distributionHash, '價格重算必須沿用distribution hash');
assert.notEqual(repriced.records[0].directionResultId, history.records[0].directionResultId, '每個快照的方向歷史必須獨立');

const officialResult = {
  league: 'MLB',
  gamePk: game.gamePk,
  gameNumber: game.gameNumber,
  officialDate: game.officialDate,
  awayTeamId: game.awayTeamId,
  homeTeamId: game.homeTeamId,
  away: game.away,
  home: game.home,
  final: true,
  status: 'Final',
  statusEnglish: 'Final',
  awayRuns: 4,
  homeRuns: 5,
  awayFirst5: 2,
  homeFirst5: 3,
  innings: 9,
  first5Complete: true,
  provider: 'OFFICIAL_TEST',
  sourceRecord: '991188',
};
const settlementEvents = history.records.map(record => settleAnalysisDirectionRecord(record, officialResult, {
  settledAt: '2099-08-26T14:00:00.000Z',
}));
assert.equal(settlementEvents.length, 8);
assert.ok(settlementEvents.every(Boolean), '所有CALCULATED方向都要自動結算');
assert.ok(settlementEvents.every(event => event.status === 'SETTLED'));
assert.ok(settlementEvents.every(event => event.stake === 10_000));
assert.ok(settlementEvents.every(event => event.settlementRuleVersion === SETTLEMENT_RULE_VERSION));
assert.equal(settlementEvents[0].selectedPeriod, 'FULL_GAME');
assert.equal(settlementEvents[4].selectedPeriod, 'FIRST5');
assert.equal(settlementEvents[0].selectedAwayRuns, 4);
assert.equal(settlementEvents[4].selectedAwayRuns, 2);
assert.equal(settleAnalysisDirectionRecord(history.records[0], { final: false }), null);
assert.equal(settleAnalysisDirectionRecord(partialHistory.records[2], officialResult), null, 'BLOCKED方向不得產生假結算');

const missingFirst5 = { ...officialResult, awayFirst5: null, homeFirst5: null };
const fullSettlement = settleAnalysisDirectionRecord(history.records[0], missingFirst5);
const first5Review = settleAnalysisDirectionRecord(history.records[4], missingFirst5);
assert.equal(fullSettlement.status, 'SETTLED');
assert.equal(first5Review.status, 'MANUAL_REVIEW');
assert.match(first5Review.settlementError, /前五局/);
const unverifiedFirst5 = settleAnalysisDirectionRecord(history.records[4], {
  ...officialResult,
  first5Complete: false,
});
assert.equal(unverifiedFirst5.status, 'MANUAL_REVIEW', 'F5不得只憑全場已打五局推定為官方完整比分');
assert.match(unverifiedFirst5.settlementError, /前五局/);
const incompleteIdentity = settleAnalysisDirectionRecord(history.records[0], {
  ...officialResult,
  officialDate: '',
  gameNumber: null,
  awayTeamId: null,
  away: '',
});
assert.equal(incompleteIdentity.status, 'MANUAL_REVIEW');
assert.match(incompleteIdentity.settlementError, /日期|場次|客隊/);
const firstEvent = settlementEvents[0];
const missingSourceRecord = settleAnalysisDirectionRecord(history.records[0], {
  ...officialResult,
  sourceRecord: '',
});
assert.equal(missingSourceRecord.status, 'MANUAL_REVIEW');
assert.notEqual(missingSourceRecord.officialResultHash, firstEvent?.officialResultHash,
  '後續補齊sourceRecord必須改變正式賽果hash');

const unchanged = buildChangedAnalysisDirectionSettlements([{
  record: history.records[0],
  latestSettlementId: firstEvent.settlementId,
  latestOfficialResultHash: firstEvent.officialResultHash,
}], officialResult);
assert.equal(unchanged.events.length, 0, '相同正式賽果hash不得重複append結算');
assert.equal(unchanged.skippedUnchanged, 1);
const correctedResult = { ...officialResult, awayRuns: 6, homeRuns: 5, providerRevision: 'CORRECTION-2' };
const corrected = buildChangedAnalysisDirectionSettlements([{
  record: history.records[0],
  latestSettlementId: firstEvent.settlementId,
  latestOfficialResultHash: firstEvent.officialResultHash,
}], correctedResult);
assert.equal(corrected.events.length, 1);
assert.equal(corrected.events[0].supersedesSettlementId, firstEvent.settlementId);
assert.notEqual(corrected.events[0].officialResultHash, firstEvent.officialResultHash);
const reverted = buildChangedAnalysisDirectionSettlements([{
  record: history.records[0],
  latestSettlementId: corrected.events[0].settlementId,
  latestOfficialResultHash: corrected.events[0].officialResultHash,
}], officialResult);
assert.equal(reverted.events.length, 1, '正式賽果回復到過去hash仍必須append新的superseding event');
assert.equal(reverted.events[0].supersedesSettlementId, corrected.events[0].settlementId);
assert.notEqual(reverted.events[0].settlementId, firstEvent.settlementId);

let workerActive = 0;
let observedWorkerConcurrency = 0;
const bounded = await runAnalysisDirectionSettlementTasks(Array.from({ length: 8 }, (_, index) => index), async () => {
  workerActive += 1;
  observedWorkerConcurrency = Math.max(observedWorkerConcurrency, workerActive);
  await new Promise(resolve => setTimeout(resolve, 3));
  workerActive -= 1;
}, { concurrency: 3, timeBudgetMs: 1_000 });
assert.equal(bounded.completed, 8);
assert.ok(observedWorkerConcurrency <= 3 && bounded.maxActive <= 3, '自動結算必須遵守併發上限');
const budgeted = await runAnalysisDirectionSettlementTasks(Array.from({ length: 10 }, (_, index) => index), async () => {
  await new Promise(resolve => setTimeout(resolve, 10));
}, { concurrency: 2, timeBudgetMs: 2 });
assert.equal(budgeted.timeBudgetExhausted, true);
assert.ok(budgeted.deferred >= 8, '時間預算耗盡後必須保留未啟動場次供下次續跑');

const stats = summarizeAnalysisDirectionHistory(history.records.map((record, index) => ({
  record,
  settlement: settlementEvents[index],
})));
assert.equal(stats.overall.sampleSize, 8);
assert.equal(stats.overall.totalStake, 80_000);
assert.ok(Number.isFinite(stats.overall.totalProfit));
assert.ok(Number.isFinite(stats.overall.roi));
assert.ok(stats.groups.some(group => group.league === 'MLB' && group.market === '全場讓分'));
assert.ok(stats.groups.some(group => group.rSign === 'NON_POSITIVE'));
assert.ok(stats.groups.some(group => group.qaStatus === 'BLOCK'));
assert.ok(stats.groups.every(group => group.wBand && group.lineType && group.leadBand));
const missingRSettlement = settleAnalysisDirectionRecord(missingRobustHistory.records[0], officialResult);
const missingRStats = summarizeAnalysisDirectionHistory([{
  record: missingRobustHistory.records[0],
  settlement: missingRSettlement,
}]);
assert.equal(missingRStats.groups[0].rSign, 'MISSING', 'R=null不得混入NON_POSITIVE');

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalDatabaseV2Url = process.env.DATABASE_V2_URL;
delete process.env.DATABASE_URL;
delete process.env.DATABASE_V2_URL;
const unavailable = await persistAnalysisDirectionHistory(history);
assert.equal(unavailable.stored, false);
assert.equal(unavailable.reason, 'DATABASE_NOT_CONFIGURED');
const degraded = await persistAnalysisDirectionHistoryBestEffort({ snapshotRecord, analysis });
assert.equal(degraded.status, 'UNAVAILABLE');
assert.equal(degraded.confirmed, false);
assert.equal(history.records[2].modelEV, 0.04, '永久保存不可用時不得改寫W');
await assert.rejects(() => loadAnalysisDirectionHistory(snapshotRecord.snapshotId), /DATABASE_URL/);
if (originalDatabaseUrl == null) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = originalDatabaseUrl;
if (originalDatabaseV2Url == null) delete process.env.DATABASE_V2_URL;
else process.env.DATABASE_V2_URL = originalDatabaseV2Url;

const migration = fs.readFileSync(new URL('../database/0007_analysis_direction_history.sql', import.meta.url), 'utf8');
assert.match(migration, /unique \(snapshot_id, slot_id\)/i);
assert.match(migration, /unique \(snapshot_id, slot_index\)/i);
assert.match(migration, /status in \('CALCULATED', 'UNOPENED', 'BLOCKED'\)/i);
assert.match(migration, /reader_version text/i);
assert.match(migration, /reader_payload_hash char\(64\)/i);
assert.match(migration, /distribution_hash char\(64\)/i);
assert.match(migration, /model_ev_formula_version text not null/i);
assert.match(migration, /robust_ev_version text not null/i);
assert.match(migration, /direction_slot_contract_version text not null/i);
assert.match(migration, /parent_snapshot_id text references baseball_analysis_pit_snapshots/i);
assert.match(migration, /away_team_id bigint not null/i);
assert.match(migration, /created_at < game_start/i);
assert.match(migration, /validate_baseball_analysis_direction_pit_insert/i);
assert.match(migration, /before insert on baseball_analysis_direction_results/i);
assert.match(migration, /pit\.distribution_hash is distinct from new\.distribution_hash/i);
assert.match(migration, /pit\.line_as_of is distinct from new\.line_as_of/i);
assert.match(migration, /idx_analysis_direction_settlement_root/i);
assert.match(migration, /idx_analysis_direction_settlement_child/i);
assert.match(migration, /validate_baseball_analysis_direction_settlement_insert/i);
assert.match(migration, /before update or delete/i, '分析與結算歷史必須append-only');

const historySource = fs.readFileSync(new URL('../lib/analysis-direction-history-v1.js', import.meta.url), 'utf8');
assert.match(historySource, /payloadLocation: 'record_payload'/, '完整方向payload只可傳輸一次');
assert.doesNotMatch(historySource, /result_payload:\s*record\.resultPayload/, '不得把完整resultPayload重複寫入兩個JSONB欄位');

assert.match(historySource, /ANALYSIS_DIRECTION_HISTORY_BOUND_MISMATCH/, '八方向靜默綁定失敗必須留下結構化診斷');
assert.match(historySource, /bindingMismatches/, '八方向寫入未確認必須回傳失配欄位名稱');
assert.equal(historySource.includes('jsonColumn('), false, '八方向診斷不得依賴其他模組的私有JSON helper');
assert.match(
  historySource,
  /diagnoseDirectionParentBinding[\s\S]*game_start IS NOT DISTINCT FROM[\s\S]*versions->>'directionSlotContractVersion' IS NOT DISTINCT FROM[\s\S]*game_start > NOW\(\) AS "preGame"/,
  '八方向診斷必須使用與實際bound相同的PostgreSQL比較語意',
);
assert.match(historySource, /missingSlotIds/, '八方向診斷必須列出缺少的方向槽位');
assert.match(
  historySource,
  /ON CONFLICT \(direction_result_id\) DO NOTHING RETURNING direction_result_id/,
  '八方向寫入只可忽略同一列識別的冪等衝突，其他唯一鍵衝突必須明確失敗',
);

assert.match(historySource, /to_char\(analysis_as_of AT TIME ZONE 'UTC'/, '方向歷史必須先讀取資料庫凍結父PIT的微秒時間');
assert.match(historySource, /canonicalRecord\.recordHash = sha256\(recordHashPayload\(canonicalRecord\)\)/, '父PIT時間正規化後必須重新簽章方向列');
assert.match(historySource, /p\.analysis_as_of = i\.analysis_as_of/, '方向列與父PIT分析時間必須維持完全相等');
assert.match(historySource, /parent_analysis_as_of AS analysis_as_of, parent_data_as_of AS data_as_of/, '方向列必須寫入父PIT的精確時間');

console.log('analysis-direction-history-v1 tests passed');
