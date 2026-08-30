import { canonicalBetPosition } from './bet-ledger.js';
import { currentReaderPriceForBet } from './bet-price-feed.js';
import { loadAnalysisPitReplay } from './analysis-pit-snapshot-store-v1.js';
import { repriceMarkets } from './analysis-v11.js';
import { finalizeDeterministicAnalysis } from './deterministic-finalizer-v10.js';

export const BET_CLOSING_LINE_VERSION = 'BASEBALL-BET-CLOSING-LINE-v1.0.0';

const clean = value => String(value || '').trim();
const finite = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

function iso(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function hash(value) {
  const text = clean(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function metricFields(value = {}) {
  return {
    metricStatus: clean(value.metricStatus || 'CALCULATED').slice(0, 40),
    formulaDiagnosticScore: finite(value.formulaDiagnosticScore),
    shadowDiagnosticScore: finite(value.shadowDiagnosticScore),
    weightedEV: finite(value.weightedEV),
    robustEV: finite(value.robustEV),
    scoreStatus: clean(value.scoreStatus).slice(0, 60) || null,
    modelVersion: clean(value.modelVersion).slice(0, 100) || null,
    scoreFormulaVersion: clean(value.scoreFormulaVersion).slice(0, 100) || null,
    distributionHash: hash(value.distributionHash),
    distributionId: clean(value.distributionId).slice(0, 500) || null,
  };
}

function baseSnapshot(bet, row, evidence = {}) {
  const lineAsOf = iso(row?.lineAsOf || evidence?.lineAsOf);
  const gameStart = iso(bet?.gameDate);
  const placedAt = iso(bet?.placedAt);
  const water = finite(row?.water);
  const market = clean(row?.market || bet?.market);
  const pick = clean(row?.pick);
  if (!lineAsOf || !gameStart || !placedAt || !market || !pick || water == null || water <= 0 || water > 5) return null;
  const lineTime = Date.parse(lineAsOf);
  if (lineTime < Date.parse(placedAt) - 10 * 60_000 || lineTime >= Date.parse(gameStart)) return null;
  if (market !== clean(bet?.market) || canonicalBetPosition(pick) !== canonicalBetPosition(bet?.pick)) return null;
  return {
    version: BET_CLOSING_LINE_VERSION,
    verified: true,
    finalizationRule: 'LAST_CHANGED_TAI888_READER_PRICE_STRICTLY_BEFORE_OFFICIAL_FIRST_PITCH',
    provider: 'TAI888_READER_AUTO',
    sourceType: 'ACTUAL_TW_CREDIT',
    market,
    pick,
    water,
    lineAsOf,
    readerPayloadHash: hash(evidence?.payloadHash || evidence?.readerPayloadHash),
    readerRawBoardHash: hash(evidence?.rawBoardHash || evidence?.readerRawBoardHash),
    readerRevision: clean(evidence?.revision || evidence?.readerRevision).slice(0, 200) || null,
    readerGameMarketHash: hash(evidence?.readerGameMarketHash),
  };
}

export function buildPlacedClosingContractSnapshot(bet, metrics = {}) {
  const row = {
    market: bet?.placedContractSnapshot?.market || bet?.market,
    pick: bet?.placedContractSnapshot?.pick || bet?.pick,
    water: bet?.placedContractSnapshot?.water ?? bet?.water,
    lineAsOf: bet?.placedContractSnapshot?.lineAsOf || bet?.lineAsOf,
  };
  const snapshot = baseSnapshot(bet, row, {
    payloadHash: bet?.readerPayloadHash,
    rawBoardHash: bet?.rawBoardHash,
    revision: bet?.readerRevision,
    readerGameMarketHash: metrics?.readerGameMarketHash,
  });
  return snapshot ? { ...snapshot, ...metricFields(metrics) } : null;
}

export function buildReaderClosingContractCandidate(bet, readerSnapshot) {
  const gameStart = Date.parse(bet?.gameDate || '');
  const readerActivity = Date.parse(readerSnapshot?.pageActivityAt || readerSnapshot?.observedAt || '');
  if (!Number.isFinite(gameStart) || !Number.isFinite(readerActivity) || readerActivity >= gameStart) return null;
  const row = currentReaderPriceForBet(bet, readerSnapshot);
  if (!row) return null;
  const game = (readerSnapshot?.games || []).find(item => (
    Number(item?.gamePk || item?.game?.gamePk) === Number(bet?.gamePk)
  ));
  const marketRow = (game?.markets || []).find(item => (
    clean(item?.market) === clean(bet?.market)
    && canonicalBetPosition(item?.pick) === canonicalBetPosition(bet?.pick)
  ));
  return baseSnapshot(bet, row, {
    payloadHash: readerSnapshot?.payloadHash,
    rawBoardHash: readerSnapshot?.rawBoardHash,
    revision: readerSnapshot?.boardDate && readerSnapshot?.payloadHash
      ? `${readerSnapshot.boardDate}:${readerSnapshot.payloadHash}`
      : null,
    readerGameMarketHash: marketRow?.readerGameMarketHash
      || marketRow?.readerProvenance?.readerGameMarketHash
      || game?.readerGameMarketHash
      || game?.readerProvenance?.readerGameMarketHash,
  });
}

export function closingContractNeedsReplacement(previous, candidate) {
  if (!candidate) return false;
  if (!previous || previous?.verified !== true) return true;
  const previousTime = Date.parse(previous?.lineAsOf || '');
  const candidateTime = Date.parse(candidate?.lineAsOf || '');
  if (!Number.isFinite(candidateTime) || (Number.isFinite(previousTime) && candidateTime < previousTime)) return false;
  const priceChanged = clean(previous?.pick) !== clean(candidate.pick)
    || Math.abs(Number(previous?.water) - Number(candidate.water)) > 1e-9;
  return priceChanged;
}

export async function calculateClosingContractMetrics(bet, candidate, {
  loadReplay = loadAnalysisPitReplay,
  reprice = repriceMarkets,
  finalize = finalizeDeterministicAnalysis,
} = {}) {
  const snapshotId = clean(bet?.pitSnapshotId);
  if (!snapshotId) throw new Error('最後盤重算缺少下注PIT快照');
  const replay = await loadReplay({
    league: bet.league,
    snapshotId,
    expected: {
      leagueId: bet.league,
      gamePk: bet.gamePk,
      inputHash: bet.inputHash,
      coreFingerprint: bet.coreFingerprint,
      distributionId: bet.distributionId,
      distributionHash: bet.distributionHash,
    },
  });
  if (!replay?.frozenContext || !replay?.distributionSnapshot) throw new Error('最後盤重算找不到不可變PIT比分分布');
  const marketRow = {
    market: candidate.market,
    pick: candidate.pick,
    water: candidate.water,
    sourceType: 'ACTUAL_TW_CREDIT',
    provider: 'TAI888_READER_AUTO',
    lineAsOf: candidate.lineAsOf,
    lineFresh: true,
    executable: true,
    waterEstimated: false,
    waterMissing: false,
    confidence: 1,
    marketVerification: null,
  };
  const settings = {
    rebateRate: Number.isFinite(Number(bet?.rebateRate)) ? Number(bet.rebateRate) : 0.015,
    candidateThreshold: 7.2,
    strongestThreshold: 8.5,
    expertMode: 'off',
  };
  const preliminary = reprice({
    context: replay.frozenContext,
    markets: [marketRow],
    previousMarkets: [],
    settings,
    distributionSnapshot: replay.distributionSnapshot,
  });
  const finalized = finalize({ analysis: preliminary, game: replay.frozenContext.game, settings });
  const result = (finalized?.results || []).find(row => (
    clean(row?.market) === candidate.market
    && clean(row?.pick) === candidate.pick
    && Math.abs(Number(row?.water) - Number(candidate.water)) <= 1e-9
  ));
  if (!result || !Number.isFinite(Number(result.weightedEV)) || !Number.isFinite(Number(result.robustEV))) {
    throw new Error('最後盤重算沒有產生完整S／W／R');
  }
  return metricFields({
    metricStatus: 'CALCULATED',
    formulaDiagnosticScore: result.formulaDiagnosticScore,
    shadowDiagnosticScore: result.shadowDiagnosticScore,
    weightedEV: result.weightedEV,
    robustEV: result.robustEV,
    scoreStatus: result.scoreStatus,
    modelVersion: replay.versions?.modelVersion,
    scoreFormulaVersion: replay.versions?.scoreFormulaVersion,
    distributionHash: replay.distributionHash,
    distributionId: replay.distributionId,
  });
}

export function closingMetricFailure(error) {
  return {
    ...metricFields({ metricStatus: 'REPRICE_FAILED' }),
    metricError: clean(error?.message || error).slice(0, 300) || '最後盤重算失敗',
  };
}
