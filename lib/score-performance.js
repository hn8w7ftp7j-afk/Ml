import { QUALITY_GROUPS, qualityGroupForBet, savedVersionForBet } from './performance-evidence-v1.js';
import { filterBetLedgerByPeriod, summarizeBetLedger } from './bet-stats.js';

export const SCORE_PERFORMANCE_VERSION = 'BASEBALL-SCORE-PERFORMANCE-2026-09-v1.1.0';

export const SCORE_BUCKETS = Object.freeze([
  Object.freeze({ id: 'S70_75', label: '7.0–7.5', minTenths: 70, maxTenths: 75 }),
  Object.freeze({ id: 'S76_80', label: '7.6–8.0', minTenths: 76, maxTenths: 80 }),
  Object.freeze({ id: 'S81_85', label: '8.1–8.5', minTenths: 81, maxTenths: 85 }),
  Object.freeze({ id: 'S86_PLUS', label: '8.6+', minTenths: 86, maxTenths: Infinity }),
]);

export const SCORE_PERFORMANCE_MARKETS = Object.freeze([
  '全場讓分',
  '全場大小',
  '上半讓分',
  '上半大小',
]);

const clean = value => String(value || '').trim();

export function scorePerformanceScoreForBet(bet) {
  const status = clean(bet?.scoreStatus).toUpperCase();
  if (status === 'FORMAL_VALIDATED'
    && bet?.score !== null && bet?.score !== undefined && clean(bet.score) !== ''
    && Number.isFinite(Number(bet.score))) return Number(bet.score);

  // Actual bets persist the displayed S value at placement time under this
  // immutable field. Never recalculate it from a later analysis or closing line.
  if ((status === 'SHADOW_DIAGNOSTIC_NOT_FORMAL' || status === 'SHADOW_DIAGNOSTIC_UNCALIBRATED')
    && bet?.formulaDiagnosticScore !== null && bet?.formulaDiagnosticScore !== undefined
    && clean(bet.formulaDiagnosticScore) !== ''
    && Number.isFinite(Number(bet.formulaDiagnosticScore))) return Number(bet.formulaDiagnosticScore);

  return null;
}

function excludedFromPerformance(bet) {
  return clean(bet?.status).toUpperCase() === 'CANCELLED'
    || clean(bet?.performanceEligibility).startsWith('EXCLUDED_');
}

export function scoreBucketIdForBet(bet) {
  const savedScore = scorePerformanceScoreForBet(bet);
  if (savedScore == null) return 'NO_SCORE';
  const scoreTenths = Math.round(savedScore * 10);
  const bucket = SCORE_BUCKETS.find(item => scoreTenths >= item.minTenths && scoreTenths <= item.maxTenths);
  return bucket?.id || 'OUTSIDE_RANGE';
}

function applyBaseFilters(values, { period = 'ALL', league = 'ALL', market = 'ALL', modelVersion = 'ALL', dataVersion = 'ALL', dataQuality = 'ALL', now = Date.now() } = {}) {
  const selectedLeague = clean(league).toUpperCase() || 'ALL';
  const selectedMarket = clean(market) || 'ALL';
  return filterBetLedgerByPeriod(Array.isArray(values) ? values : [], period, now).filter(bet => {
    if (selectedLeague !== 'ALL' && clean(bet?.league).toUpperCase() !== selectedLeague) return false;
    if (selectedMarket !== 'ALL' && clean(bet?.market) !== selectedMarket) return false;
    if (modelVersion !== 'ALL' && savedVersionForBet(bet) !== modelVersion) return false;
    if (dataVersion !== 'ALL' && savedVersionForBet(bet, 'dataVersion') !== dataVersion) return false;
    if (dataQuality !== 'ALL' && qualityGroupForBet(bet) !== dataQuality) return false;
    return true;
  });
}

function summarizeBucket(bets, bucket) {
  const rows = bets.filter(bet => scoreBucketIdForBet(bet) === bucket.id);
  return {
    ...bucket,
    summary: summarizeBetLedger(rows).overall,
  };
}

function attributionGroup(rows, key, label) {
  const games = new Set(rows.map(row => `${row.league}|${row.gamePk}`));
  return { key, label, uniqueGames: games.size, summary: summarizeBetLedger(rows).overall };
}

export function buildScorePerformanceReport(values = [], filters = {}) {
  const filtered = applyBaseFilters(values, filters);
  const performanceBets = filtered.filter(bet => !excludedFromPerformance(bet));
  const scoredBets = performanceBets.filter(bet => SCORE_BUCKETS.some(bucket => bucket.id === scoreBucketIdForBet(bet)));
  const noScoreBets = filtered.filter(bet => clean(bet?.status).toUpperCase() !== 'CANCELLED' && scoreBucketIdForBet(bet) === 'NO_SCORE');
  const outsideRangeBets = performanceBets.filter(bet => scoreBucketIdForBet(bet) === 'OUTSIDE_RANGE');
  const buckets = SCORE_BUCKETS.map(bucket => summarizeBucket(scoredBets, bucket));
  const matrix = SCORE_BUCKETS.map(bucket => ({
    ...bucket,
    markets: Object.fromEntries(SCORE_PERFORMANCE_MARKETS.map(market => [
      market,
      summarizeBetLedger(scoredBets.filter(bet => scoreBucketIdForBet(bet) === bucket.id && clean(bet?.market) === market)).overall,
    ])),
    total: summarizeBetLedger(scoredBets.filter(bet => scoreBucketIdForBet(bet) === bucket.id)).overall,
  }));

  return {
    version: SCORE_PERFORMANCE_VERSION,
    filters: {
      period: clean(filters.period).toUpperCase() || 'ALL',
      league: clean(filters.league).toUpperCase() || 'ALL',
      market: clean(filters.market) || 'ALL',
      modelVersion: filters.modelVersion || 'ALL', dataVersion: filters.dataVersion || 'ALL', dataQuality: filters.dataQuality || 'ALL',
    },
    availableVersions: Object.fromEntries(['modelVersion', 'dataVersion'].map(field => [field, [...new Set((values || []).map(row => savedVersionForBet(row, field)))].sort()])),
    attribution: {
      scope: 'ALL_ELIGIBLE_ACTUAL_BETS_IN_SELECTED_FILTERS',
      versions: [...new Set(performanceBets.map(row => JSON.stringify([savedVersionForBet(row), savedVersionForBet(row, 'dataVersion')])))]
        .map(key => { const [modelVersion, dataVersion] = JSON.parse(key); return { ...attributionGroup(performanceBets.filter(row => savedVersionForBet(row) === modelVersion && savedVersionForBet(row, 'dataVersion') === dataVersion), key, modelVersion), modelVersion, dataVersion }; }),
      quality: Object.entries(QUALITY_GROUPS).map(([key, label]) => attributionGroup(performanceBets.filter(row => qualityGroupForBet(row) === key), key, label)),
    },
    filteredRecordCount: filtered.length,
    performanceRecordCount: performanceBets.length,
    buckets,
    matrix,
    noScore: {
      recordCount: noScoreBets.length,
      bets: noScoreBets,
    },
    outsideRange: {
      recordCount: outsideRangeBets.length,
      bets: outsideRangeBets,
    },
  };
}

export function filterScorePerformanceDetails(values = [], {
  period = 'ALL',
  league = 'ALL',
  market = 'ALL',
  bucketId = 'ALL',
  modelVersion = 'ALL', dataVersion = 'ALL', dataQuality = 'ALL',
  now = Date.now(),
} = {}) {
  const filtered = applyBaseFilters(values, { period, league, market, modelVersion, dataVersion, dataQuality, now });
  const selectedBucket = clean(bucketId).toUpperCase() || 'ALL';
  return filtered.filter(bet => {
    const scoreBucket = scoreBucketIdForBet(bet);
    if (selectedBucket === 'NO_SCORE') {
      return clean(bet?.status).toUpperCase() !== 'CANCELLED' && scoreBucket === 'NO_SCORE';
    }
    if (selectedBucket === 'OUTSIDE_RANGE') {
      return !excludedFromPerformance(bet) && scoreBucket === 'OUTSIDE_RANGE';
    }
    if (excludedFromPerformance(bet)) return false;
    if (selectedBucket === 'ALL') return SCORE_BUCKETS.some(bucket => bucket.id === scoreBucket);
    return scoreBucket === selectedBucket;
  });
}

export function scorePerformanceSampleLabel(summary) {
  const settled = Math.max(0, Number(summary?.settled) || 0);
  // Descriptive UI notice only. It never gates, rewrites, or recalibrates a score or statistic.
  return settled < 30 ? '樣本不足' : '';
}
