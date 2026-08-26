import assert from 'node:assert/strict';
import {
  assessEightDirectionMarketCoverage,
  attachEightDirectionContract,
  DIRECTION_SLOT_DEFINITIONS,
} from '../lib/direction-slots-v1.js';
import { calculateProfit } from '../lib/markets.js';
import { settleTaiwanContract } from '../lib/taiwan-settlement-v9.js';

const game = {
  leagueId: 'MLB',
  gamePk: 991111,
  away: '客隊',
  home: '主隊',
  awayEnglish: 'Away Club',
  homeEnglish: 'Home Club',
};
const row = (market, pick, water = 0.95) => ({
  market,
  pick,
  water,
  sourceType: 'ACTUAL_TW_CREDIT',
  provider: 'TAI888_READER_AUTO',
  lineFresh: true,
  executable: true,
});
const fullBoard = [
  row('全場讓分', '客隊讓1平'), row('全場讓分', '主隊受讓1平'),
  row('全場大小', '大8.5'), row('全場大小', '小8.5'),
  row('上半讓分', '客隊讓0.5'), row('上半讓分', '主隊受讓0.5'),
  row('上半大小', '大4.5'), row('上半大小', '小4.5'),
];

const coverage = assessEightDirectionMarketCoverage(fullBoard, game);
assert.equal(coverage.validRows.length, 8);
assert.equal(coverage.markets.every(item => item.status === 'OPEN'), true);
assert.equal(new Set(coverage.validRows.map(item => item.directionSlotId)).size, 8);
assert.deepEqual(
  coverage.validRows.map(item => item.directionSlotId).sort(),
  DIRECTION_SLOT_DEFINITIONS.map(item => item.slotId).sort(),
);

const resultFor = (source, index) => ({
  ...source,
  modelEV: index % 2 ? -0.051 : 0.032,
  rawWeightedEV: index % 2 ? -0.051 : 0.032,
  weightedEV: index % 2 ? -0.051 : 0.032,
  rawRobustEV: index === 0 ? -0.004 : index % 2 ? -0.061 : 0.012,
  robustEV: index === 0 ? -0.004 : index % 2 ? -0.061 : 0.012,
  distributionCoverage: 1,
  mathematicalIntegrityPassed: true,
  evDoubleCheck: { passed: true },
  evCalibration: index === 0
    ? { qualified: false, reasons: ['QA BLOCK測試'], actualReaderEligible: true }
    : { qualified: true, reasons: [], actualReaderEligible: true },
  scoreAudit: index === 0 ? { ok: false, baseQa: { failures: ['QA BLOCK測試'] } } : { ok: true },
  formulaDiagnosticScore: index === 0 ? null : 7.4,
  rankingQualified: index !== 0,
  distributionId: 'distribution-1',
  distributionHash: 'a'.repeat(64),
});
const analysis = {
  distributionId: 'distribution-1',
  distributionHash: 'a'.repeat(64),
  results: coverage.validRows.map(resultFor),
};
const contracted = attachEightDirectionContract(analysis, coverage, game);
assert.equal(contracted.directionSlots.length, 8);
assert.equal(contracted.calculatedDirectionCount, 8);
assert.equal(contracted.directionSlots.every(slot => slot.status === 'CALCULATED'), true);
assert.equal(contracted.directionSlots.every(slot => slot.distributionId === 'distribution-1'), true, '正反與全場/F5必須共用distribution ID');
assert.equal(contracted.directionSlots.every(slot => slot.distributionHash === 'a'.repeat(64)), true);
const qaBlockedSlot = contracted.directionSlots.find(slot => slot.evCalibration?.qualified === false);
assert.equal(qaBlockedSlot.modelEV, 0.032, 'QA BLOCK仍保留W');
assert.equal(qaBlockedSlot.robustEV, -0.004, 'R≤0仍保留W與R');
assert.equal(qaBlockedSlot.qa.status, 'BLOCK');

const missingRobustResults = coverage.validRows.map(resultFor);
missingRobustResults[0] = { ...missingRobustResults[0], rawRobustEV: null, robustEV: null };
const missingRobust = attachEightDirectionContract({ ...analysis, results: missingRobustResults }, coverage, game);
assert.equal(missingRobust.directionSlots[1].status, 'CALCULATED');
assert.equal(missingRobust.directionSlots[1].modelEV, 0.032, 'R缺失不得隱藏W');
assert.equal(missingRobust.directionSlots[1].robustEV, null);
assert.equal(missingRobust.directionSlots[1].qa.status, 'BLOCK');

const partialCoverage = assessEightDirectionMarketCoverage(fullBoard.slice(0, 2), game);
const partial = attachEightDirectionContract({ ...analysis, results: partialCoverage.validRows.map(resultFor) }, partialCoverage, game);
assert.equal(partial.directionSlots.filter(slot => slot.status === 'CALCULATED').length, 2);
assert.equal(partial.directionSlots.filter(slot => slot.status === 'UNOPENED').length, 6);
assert.equal(partial.directionSlots.filter(slot => slot.status === 'UNOPENED').every(slot => slot.modelEV == null), true);

const duplicateBoard = [
  ...fullBoard,
  row('全場大小', '大8.5', 0.93),
];
const duplicateCoverage = assessEightDirectionMarketCoverage(duplicateBoard, game);
const duplicateMarket = duplicateCoverage.markets.find(item => item.market === '全場大小');
assert.equal(duplicateMarket.status, 'BLOCKED');
assert.match(duplicateMarket.errors.join('|'), /禁止靜默截斷/);
assert.equal(duplicateCoverage.validRows.length, 6, '單一市場錯誤不得阻擋其他三市場');
const isolated = attachEightDirectionContract({
  ...analysis,
  results: duplicateCoverage.validRows.map(resultFor),
}, duplicateCoverage, game);
assert.equal(isolated.directionSlots.filter(slot => slot.status === 'BLOCKED').length, 2);
assert.equal(isolated.directionSlots.filter(slot => slot.status === 'CALCULATED').length, 6);

const missingWater = assessEightDirectionMarketCoverage([
  row('全場大小', '大8.5', null),
  row('全場大小', '小8.5', 0.95),
  ...fullBoard.slice(0, 2),
], game);
assert.equal(missingWater.markets.find(item => item.market === '全場大小').status, 'BLOCKED');
assert.equal(missingWater.markets.find(item => item.market === '全場讓分').status, 'OPEN');

const oneBlankRow = assessEightDirectionMarketCoverage([
  { ...row('上半大小', '', null), integrityError: 'Reader欄位無法辨識' },
], game);
assert.equal(oneBlankRow.markets.find(item => item.market === '上半大小').status, 'BLOCKED');
const threeBlankRows = assessEightDirectionMarketCoverage(Array.from({ length: 3 }, () => (
  { ...row('上半讓分', '', null), integrityError: 'Reader重複空白欄位' }
)), game);
assert.equal(threeBlankRows.markets.find(item => item.market === '上半讓分').status, 'BLOCKED');
assert.match(threeBlankRows.markets.find(item => item.market === '上半讓分').errors.join('|'), /禁止靜默截斷/);

const unopenedCoverage = assessEightDirectionMarketCoverage([], game);
const readerProvenance = {
  provider: 'TAI888_READER_AUTO', sourceType: 'ACTUAL_TW_CREDIT', readerVersion: '2.0.3',
  payloadHash: 'b'.repeat(64), rawBoardHash: 'c'.repeat(64), readerGameMarketHash: 'd'.repeat(64),
  boardDate: '2099-08-12', lineAsOf: '2099-08-11T23:00:00.000Z', marketStatus: 'UNOPENED',
  authorizationStatus: 'SERVER_ATTESTED_READER_SNAPSHOT', integrityOrigin: 'SERVER_SIGNED_READER_PROVENANCE',
  provenanceSignatureVersion: 'test-signature-v1', provenanceSignature: 'signed',
};
const unopened = attachEightDirectionContract({
  results: [], distributionId: 'distribution-unopened', distributionHash: 'e'.repeat(64),
}, unopenedCoverage, game, readerProvenance);
assert.equal(unopened.directionSlots.length, 8);
assert.equal(unopened.directionSlots.every(slot => slot.status === 'UNOPENED'), true);
assert.equal(unopened.directionSlots.every(slot => slot.readerVersion === '2.0.3'), true);
assert.equal(unopened.directionSlots.every(slot => slot.readerGameMarketHash === 'd'.repeat(64)), true);
assert.equal(unopened.directionSlots.every(slot => slot.readerPayloadHash === 'b'.repeat(64)), true);
assert.equal(unopened.directionSlots.every(slot => slot.readerRawBoardHash === 'c'.repeat(64)), true);

// Locked Taiwan-credit regression: 52% full win, 4% push, 44% full loss.
const fullWin = calculateProfit({
  stake: 1,
  water: 0.95,
  settlement: settleTaiwanContract('大0.5', 1, 0),
  rebateRate: 0.015,
}).profit;
const push = calculateProfit({
  stake: 1,
  water: 0.95,
  settlement: settleTaiwanContract('大1平', 1, 0),
  rebateRate: 0.015,
}).profit;
const fullLoss = calculateProfit({
  stake: 1,
  water: 0.95,
  settlement: settleTaiwanContract('大1.5', 1, 0),
  rebateRate: 0.015,
}).profit;
assert.equal(fullWin, 0.965);
assert.equal(push, 0);
assert.equal(fullLoss, -0.985);
const regressionEV = 0.52 * fullWin + 0.04 * push + 0.44 * fullLoss;
assert.ok(Math.abs(regressionEV - 0.0684) < 1e-12);

console.log('Eight-direction W-first contract, market isolation and +6.84% Taiwan settlement regression PASS');
