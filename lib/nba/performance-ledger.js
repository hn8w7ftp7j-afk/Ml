import Decimal from 'decimal.js';
import { normalizeNbaManualBetRecord } from './manual-bet-record.js';
import { nbaManualContractHash, NBA_SETTLEMENT_VERSION } from './manual-bet-settlement.js';
import { parseCreditLine, fractionFor } from './analysis-core/credit-total.js';

export const NBA_PERFORMANCE_LEDGER_SOURCE = 'NBA_MANUAL_V1';
export const NBA_PERFORMANCE_MARKETS = Object.freeze({
  fullRunline: '全場讓分', fullTotal: '全場大小',
  firstHalfRunline: '上半讓分', firstHalfTotal: '上半大小',
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value);
const outcomeFor = fraction => fraction === 0 ? 'PUSH' : fraction === 1 ? 'WIN'
  : fraction === -1 ? 'LOSS' : fraction > 0 ? 'PARTIAL_WIN' : 'PARTIAL_LOSS';

function performanceSettlement(record) {
  const saved = record.settlement;
  const expectedPeriod = record.marketKey.startsWith('firstHalf') ? 'FIRST_HALF' : 'FULL_GAME_INCLUDING_OVERTIME';
  if (!saved || saved.status !== 'SETTLED' || saved.version !== NBA_SETTLEMENT_VERSION
    || saved.contractHash !== nbaManualContractHash(record)
    || saved.evidenceStatus !== 'MANUAL_CONTRACT_VERIFIED_OFFICIAL_RESULT'
    || !finiteNumber(saved.fraction) || Math.abs(saved.fraction) > 1
    || saved.result !== outcomeFor(saved.fraction)
    || ![saved.profit, saved.rebate, saved.effectiveStake].every(finiteNumber)
    || saved.rebate < 0 || saved.effectiveStake < 0
    || saved.scores?.period !== expectedPeriod
    || ![saved.scores?.away, saved.scores?.home].every(score => Number.isSafeInteger(score) && score >= 0)) return null;
  const total = record.marketKey.endsWith('Total');
  const line = parseCreditLine(record.line, total ? 'total' : 'spread');
  const quantity = total ? saved.scores.away + saved.scores.home
    : record.lineSide === 'home' ? saved.scores.home - saved.scores.away : saved.scores.away - saved.scores.home;
  const positive = total ? record.side === 'over' : record.side === record.lineSide;
  if (!Number.isSafeInteger(quantity) || fractionFor(quantity, line, positive) !== saved.fraction) return null;
  // Reconcile the persisted numbers with the immutable native contract using
  // its original Decimal operations. Compare the final persisted number
  // representations: never round, replace or repair saved financial evidence.
  const stake = new Decimal(record.stake);
  const effectiveStake = stake.times(Math.abs(saved.fraction));
  const rebate = effectiveStake.times('0.015');
  const profit = stake.times(Math.max(saved.fraction, 0)).times(record.water)
    .minus(stake.times(Math.max(-saved.fraction, 0))).plus(rebate);
  if (!new Decimal(saved.effectiveStake).equals(effectiveStake.toNumber())
    || !new Decimal(saved.rebate).equals(rebate.toNumber())
    || !new Decimal(saved.profit).equals(profit.toNumber())) return null;
  const gross = new Decimal(saved.profit).minus(saved.rebate).toNumber();
  if ((saved.fraction > 0 && gross < 0) || (saved.fraction < 0 && gross > 0)
    || (saved.fraction === 0 && (saved.profit !== 0 || saved.rebate !== 0))) return null;
  return {
    ...saved,
    outcome: saved.result === 'PARTIAL_WIN' ? 'HALF_WIN'
      : saved.result === 'PARTIAL_LOSS' ? 'HALF_LOSS' : saved.result,
    winFraction: Math.max(saved.fraction, 0), lossFraction: Math.max(-saved.fraction, 0),
    pushFraction: 1 - Math.abs(saved.fraction),
    grossWin: saved.fraction > 0 ? gross : 0,
    grossLoss: saved.fraction < 0 ? gross : 0,
    netProfit: saved.profit,
  };
}

// This is a read-only view of the separate NBA archive. Shared market/slot
// labels are presentation filters; neither baseball settlement nor model/PIT
// eligibility is inferred. Saved financial values are never recalculated.
export function nbaManualPerformanceBet(record) {
  if (!record || !uuid.test(record.id || '') || !Number.isFinite(Date.parse(record.recordedAt || ''))
    || !['OPEN', 'CANCELLED'].includes(record.status || 'OPEN')) return null;
  try { normalizeNbaManualBetRecord({ ...record, alreadyPlaced: true }); }
  catch { return null; }
  const total = record.marketKey.endsWith('Total');
  const half = record.marketKey.startsWith('firstHalf');
  const period = half ? 'FIRST5' : 'FULL';
  const direction = record.side.toUpperCase();
  const parsed = parseCreditLine(record.line, total ? 'total' : 'spread');
  const statRunlineRole = total ? null : parsed.base === 0 ? 'PICKEM'
    : record.side === record.lineSide ? 'GIVING' : 'RECEIVING';
  const pick = total ? `${record.side === 'over' ? '大' : '小'}${record.line}`
    : `${record[record.side]}${record.side === record.lineSide ? '讓' : '受讓'}${record.line}`;
  const settlement = record.settlement ? performanceSettlement(record) : null;
  const cancelled = record.status === 'CANCELLED';
  const unverifiedSettlement = !cancelled && (record.settlement || record.settlementStatus === 'SETTLED') && !settlement;
  return {
    ...record,
    id: `nba-manual:${record.id}`, nativeRecordId: record.id,
    ledgerSource: NBA_PERFORMANCE_LEDGER_SOURCE, league: 'NBA',
    gamePk: Number(record.gameId.split(':').at(-1)),
    market: NBA_PERFORMANCE_MARKETS[record.marketKey],
    slotId: `${period}_${total ? 'TOTAL' : 'RUNLINE'}_${direction}`,
    direction: total ? direction : (record.side === record.lineSide ? 'GIVING' : 'RECEIVING'),
    statDirection: total ? direction : null, statRunlineRole,
    pick, matchup: `${record.away} @ ${record.home}`,
    placedAt: record.recordedAt, gameDate: record.startTime,
    nativeStatus: record.status || 'OPEN',
    status: cancelled ? 'CANCELLED' : unverifiedSettlement ? 'MANUAL_REVIEW' : settlement ? 'SETTLED' : 'OPEN',
    settlement: cancelled ? null : settlement,
    ...(unverifiedSettlement ? { settlementError: 'NBA 保存的結算證據與原合約未通過核對，暫不計入已結算績效。' } : {}),
    betSource: record.source,
    score: null, formulaDiagnosticScore: null, scoreStatus: 'NOT_CAPTURED',
    weightedEV: null, robustEV: null, pitEvidenceVerified: false,
    calibrationEligibility: 'EXCLUDED_MANUAL_CONTRACT',
    executable: false, formalEligible: false, calibrationEligible: false,
  };
}
