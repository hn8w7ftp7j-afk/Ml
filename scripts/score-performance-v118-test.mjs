import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeBetLedger } from '../lib/bet-stats.js';
import {
  SCORE_BUCKETS,
  buildScorePerformanceReport,
  filterScorePerformanceDetails,
  scoreBucketIdForBet,
  scorePerformanceScoreForBet,
} from '../lib/score-performance.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settled = (id, league, market, score, outcome, netProfit, values = {}) => ({
  id,
  league,
  date: values.date || '2026-08-31',
  gamePk: values.gamePk || 900000 + Number(String(id).replace(/\D/g, '') || 0),
  matchup: `${league} away 對 home`,
  market,
  pick: values.pick || '主隊讓1平',
  water: values.water || 0.95,
  placedAt: values.placedAt || '2026-08-31T04:00:00.000Z',
  status: 'SETTLED',
  score: values.scoreStatus === 'FORMAL_VALIDATED' ? score : null,
  formulaDiagnosticScore: values.scoreStatus === 'FORMAL_VALIDATED' ? null : score,
  scoreStatus: values.scoreStatus || 'SHADOW_DIAGNOSTIC_NOT_FORMAL',
  weightedEV: values.weightedEV ?? 0.04,
  robustEV: values.robustEV ?? 0.02,
  stake: values.stake || 10000,
  settlement: {
    outcome,
    winFraction: values.winFraction ?? (outcome === 'WIN' ? 1 : outcome === 'HALF_WIN' ? 0.5 : 0),
    lossFraction: values.lossFraction ?? (outcome === 'LOSS' ? 1 : outcome === 'HALF_LOSS' ? 0.5 : 0),
    grossWin: values.grossWin ?? Math.max(0, netProfit),
    grossLoss: values.grossLoss ?? Math.min(0, netProfit),
    rebate: values.rebate ?? 150,
    netProfit,
  },
});

const ledger = [
  settled('1', 'MLB', '全場讓分', 7.0, 'WIN', 9650),
  settled('2', 'MLB', '全場大小', 7.5, 'LOSS', -9850),
  settled('3', 'NPB', '上半讓分', 7.6, 'HALF_WIN', 4825, { winFraction: 0.5, rebate: 75 }),
  settled('4', 'NPB', '上半大小', 8.0, 'HALF_LOSS', -4925, { lossFraction: 0.5, rebate: 75 }),
  settled('5', 'KBO', '全場讓分', 8.1, 'PUSH', 0),
  settled('6', 'KBO', '全場大小', 8.5, 'WIN', 9650),
  settled('7', 'CPBL', '上半讓分', 8.6, 'LOSS', -9850),
  settled('8', 'CPBL', '上半大小', 9.0, 'WIN', 9650),
  { ...settled('9', 'MLB', '全場讓分', 8.7, 'WIN', 9999), status: 'OPEN', settlement: null },
  { ...settled('10', 'MLB', '全場讓分', 8.7, 'WIN', 9999), status: 'CANCELLED' },
  { ...settled('11', 'MLB', '全場讓分', null, 'WIN', 9999), scoreStatus: 'LEGACY_INVALID', status: 'MANUAL_REVIEW', settlement: null, performanceEligibility: 'EXCLUDED_UNVERIFIABLE_LEGACY' },
  settled('12', 'MLB', '全場讓分', 6.9, 'WIN', 9650),
];

assert.deepEqual(SCORE_BUCKETS.map(row => row.label), ['7.0–7.5', '7.6–8.0', '8.1–8.5', '8.6+']);
assert.equal(scoreBucketIdForBet({ score: 7.0, scoreStatus: 'FORMAL_VALIDATED' }), 'S70_75');
assert.equal(scoreBucketIdForBet({ score: 7.5, scoreStatus: 'FORMAL_VALIDATED' }), 'S70_75');
assert.equal(scoreBucketIdForBet({ score: 7.6, scoreStatus: 'FORMAL_VALIDATED' }), 'S76_80');
assert.equal(scoreBucketIdForBet({ score: 8.0, scoreStatus: 'FORMAL_VALIDATED' }), 'S76_80');
assert.equal(scoreBucketIdForBet({ score: 8.1, scoreStatus: 'FORMAL_VALIDATED' }), 'S81_85');
assert.equal(scoreBucketIdForBet({ score: 8.5, scoreStatus: 'FORMAL_VALIDATED' }), 'S81_85');
assert.equal(scoreBucketIdForBet({ score: 8.6, scoreStatus: 'FORMAL_VALIDATED' }), 'S86_PLUS');
assert.equal(scoreBucketIdForBet({ score: 8.9, scoreStatus: 'LEGACY_INVALID' }), 'NO_SCORE', '後補或無效分數不得進入績效區間');
assert.equal(scoreBucketIdForBet({ score: null, scoreStatus: 'FORMAL_VALIDATED' }), 'NO_SCORE');
assert.equal(scorePerformanceScoreForBet({ formulaDiagnosticScore: 8.1, scoreStatus: 'SHADOW_DIAGNOSTIC_NOT_FORMAL' }), 8.1, '必須讀取下注當下永久保存的實際S欄位');
assert.equal(scoreBucketIdForBet({ formulaDiagnosticScore: 7.6, scoreStatus: 'SHADOW_DIAGNOSTIC_NOT_FORMAL' }), 'S76_80');
assert.equal(scoreBucketIdForBet({ formulaDiagnosticScore: 8.8, scoreStatus: 'LEGACY_INVALID' }), 'NO_SCORE', '無效舊資料即使殘留數字也不得污染區間');
assert.equal(scoreBucketIdForBet({ closingContractSnapshot: { formulaDiagnosticScore: 8.8 }, scoreStatus: 'SHADOW_DIAGNOSTIC_NOT_FORMAL' }), 'NO_SCORE', '不得用後來的收盤或重新分析分數補值');

const immutableBefore = structuredClone(ledger);
const originalStats = summarizeBetLedger(ledger);
const report = buildScorePerformanceReport(ledger, { period: 'ALL', league: 'ALL', market: 'ALL', now: '2026-08-31T05:00:00.000Z' });
assert.deepEqual(ledger, immutableBefore, '分數績效不得修改原帳本物件或欄位');
assert.deepEqual(summarizeBetLedger(ledger), originalStats, '新增分數頁前後，既有績效統計必須完全一致');

const bucketCounts = Object.fromEntries(report.buckets.map(row => [row.id, row.summary.bets]));
assert.deepEqual(bucketCounts, { S70_75: 2, S76_80: 2, S81_85: 2, S86_PLUS: 3 }, '每筆有效下注只能進入唯一分數區間，OPEN可計下注數');
const high = report.buckets.find(row => row.id === 'S86_PLUS').summary;
assert.equal(high.settled, 2, '未結算不得進入已結算樣本');
assert.equal(high.wins, 1);
assert.equal(high.losses, 1);
assert.equal(high.totalStake, 20000, '未結算本金不得進入ROI分母');
assert.equal(high.netPnl, -200, '淨利只可來自既有SETTLED結算');
assert.equal(high.roi, -0.01);
assert.equal(report.noScore.recordCount, 1, '舊資料缺有效下注時S分數必須獨立列為無分數資料');
assert.equal(report.outsideRange.recordCount, 1, '有效但不在指定區間的分數不得污染四個區間');
assert.ok(!report.buckets.some(row => row.summary.cancelled > 0), 'CANCELLED不得進入有效分數績效');

const mlbRunline = buildScorePerformanceReport(ledger, { period: 'ALL', league: 'MLB', market: '全場讓分' });
assert.equal(mlbRunline.filteredRecordCount, 5);
assert.equal(mlbRunline.buckets.find(row => row.id === 'S70_75').summary.bets, 1);
assert.equal(mlbRunline.buckets.find(row => row.id === 'S86_PLUS').summary.bets, 1);
assert.ok(mlbRunline.matrix.every(row => row.markets['上半讓分'].bets === 0), '全場與上半市場不得互相污染');
assert.ok(mlbRunline.buckets.every(row => row.summary.key === 'ALL'));

const npbDetails = filterScorePerformanceDetails(ledger, { period: 'ALL', league: 'NPB', market: 'ALL', bucketId: 'S76_80' });
assert.deepEqual(npbDetails.map(row => row.id), ['3', '4'], '聯盟與分數交叉篩選不得跨聯盟污染');
const noScoreDetails = filterScorePerformanceDetails(ledger, { period: 'ALL', league: 'ALL', market: 'ALL', bucketId: 'NO_SCORE' });
assert.deepEqual(noScoreDetails.map(row => row.id), ['11']);

const page = fs.readFileSync(path.join(root, 'app/page.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app/ledger.css'), 'utf8');
const scoreUiStart = page.indexOf('function ScorePerformanceDashboard');
const scoreUiEnd = page.indexOf('function diagnosticVerdict', scoreUiStart);
const scoreUi = page.slice(scoreUiStart, scoreUiEnd);
assert.ok(scoreUiStart > 0 && scoreUiEnd > scoreUiStart);
assert.doesNotMatch(scoreUi, /requestJSON|fetch\(|method:\s*['"]POST|setBets|refreshSettlements|onCancel/, '分數績效元件必須保持純讀取，不得呼叫寫入、取消或結算');
assert.match(page, />今日盤口<[\s\S]*>影子排名<[\s\S]*>下注紀錄<[\s\S]*>分數績效<[\s\S]*>績效統計<[\s\S]*>設定</, '主頁籤順序必須符合產品規格');
assert.match(css, /\.scorePerformancePanel\s*\{[\s\S]*overflow:\s*hidden/, '分數績效面板不得擴張整個頁面寬度');
assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.scoreMatrixDesktop\s*\{[\s\S]*display:\s*none[\s\S]*\.scoreMatrixMobile\s*\{[\s\S]*display:\s*grid/, '手機矩陣必須改用卡片版，不得依賴橫向表格捲動');

console.log('Score performance v11.8: immutable score buckets, filters, matrix, read-only isolation and mobile layout PASS');
