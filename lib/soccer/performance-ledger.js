import Decimal from 'decimal.js';
import { validSoccerDate } from './contracts.js';
import { parseTaiwanContract } from '../taiwan-settlement-v9.js';
import { soccerManualContractHash, settleSoccerManualRecord, SOCCER_MANUAL_SETTLEMENT_VERSION } from './manual-settlement.js';
import { soccerVerifiedSettlementContract } from './settlement-contract.js';

export const SOCCER_PERFORMANCE_LEDGER_SOURCE = 'SOCCER_MANUAL_V1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const outcome = { FULL_WIN: 'WIN', FULL_LOSS: 'LOSS', PARTIAL_WIN: 'HALF_WIN', PARTIAL_LOSS: 'HALF_LOSS', PUSH: 'PUSH' };

function performanceSettlement(record) {
  const saved = record.settlement;
  if (!saved || saved.status !== 'SETTLED' || saved.contractHash !== soccerManualContractHash(record)
    || saved.stake !== record.stake || !finite(saved.profit) || !Number.isFinite(Date.parse(saved.settledAt || ''))) return null;
  if (saved.source === 'SELF_REPORTED_USER_CONFIRMED') {
    if (saved.version !== 'SOCCER-ACCOUNT-SELF-REPORT-v1' || saved.rebateTreatment !== 'INCLUDED'
      || !new Decimal(saved.profit).times(100).isInteger()
      || new Decimal(saved.profit).times(100).abs().gt(Number.MAX_SAFE_INTEGER)) return null;
    // An account amount proves neither the outcome nor the rebate split. Keep
    // its exact saved net amount without inventing effective win-rate weights.
    return { ...saved, outcome: null, winFraction: null, lossFraction: null, pushFraction: null,
      grossWin: null, grossLoss: null, rebate: null, netProfit: saved.profit };
  }
  if (saved.version !== SOCCER_MANUAL_SETTLEMENT_VERSION) return null;
  const terms = soccerVerifiedSettlementContract(record);
  const verified = settleSoccerManualRecord({ ...record,
    ...(saved.identityEvidence ? { identityEvidence: saved.identityEvidence } : {}),
  }, saved.resultEvidence, terms, Date.parse(saved.settledAt));
  if (verified.status !== 'SETTLED' || !outcome[saved.outcome]
    || ['contractHash', 'contractVersion', 'contractEvidenceRef', 'resultHash', 'outcome',
      'winFraction', 'lossFraction', 'pushFraction', 'stake', 'grossProfit', 'rebate', 'profit',
      'rebateRate', 'rebateBasis'].some(key => saved[key] !== verified[key])
    || ['home', 'away', 'period'].some(key => saved.scores?.[key] !== verified.scores?.[key])) return null;
  return { ...saved, outcome: outcome[saved.outcome],
    grossWin: saved.grossProfit > 0 ? saved.grossProfit : 0,
    grossLoss: saved.grossProfit < 0 ? saved.grossProfit : 0, netProfit: saved.profit };
}

// Presentation-only adapter. Original soccer identities, settlement evidence,
// amounts and one-percent rules remain in the native archive and calculator.
export function soccerManualPerformanceBet(record) {
  if (!record || !uuid.test(record.id || '') || !['epl', 'ucl'].includes(record.league)
    || !validSoccerDate(record.date) || !new RegExp(`^soccer:${record.league}:\\d{1,16}$`).test(record.gameId || '')
    || !['FT', 'HT'].includes(record.period) || !['HANDICAP', 'TOTAL'].includes(record.kind)
    || !['OPEN', 'CANCELLED'].includes(record.status)
    || !Number.isFinite(Date.parse(record.recordedAt || '')) || !Number.isFinite(Date.parse(record.startTime || ''))
    || !finite(record.stake) || record.stake <= 0 || !finite(record.water) || record.water <= 0 || record.water > 1000
    || typeof record.line !== 'string' || record.line.length > 40
    || !['home', 'away'].every(side => typeof record[side] === 'string' && record[side].trim())) return null;
  const total = record.kind === 'TOTAL', half = record.period === 'HT';
  if (total ? !['over', 'under'].includes(record.side) || record.lineSide != null
    : !['home', 'away'].includes(record.side) || !['home', 'away'].includes(record.lineSide)) return null;
  if (record.teamIds != null && (!['home', 'away'].every(side =>
    new RegExp(`^soccer:${record.league}:team:\\d{1,16}$`).test(record.teamIds?.[side] || ''))
    || record.teamIds.home === record.teamIds.away)) return null;
  const pick = total ? `${record.side === 'over' ? '大' : '小'}${record.line}`
    : `${record[record.side]}${record.side === record.lineSide ? '讓' : '受讓'}${record.line}`;
  const parsed = parseTaiwanContract(pick);
  if (!parsed.valid) return null;
  const period = half ? 'FIRST5' : 'FULL', direction = record.side.toUpperCase();
  const cancelled = record.status === 'CANCELLED';
  let settlement = null;
  try { settlement = record.settlement ? performanceSettlement(record) : null; } catch { /* invalid evidence stays under review */ }
  const invalidSettlement = !cancelled && (record.settlement || record.settlementStatus === 'SETTLED') && !settlement;
  return { ...record, id: `soccer-manual:${record.league}:${record.id}`, nativeRecordId: record.id,
    nativeLeague: record.league, league: record.league.toUpperCase(), ledgerSource: SOCCER_PERFORMANCE_LEDGER_SOURCE,
    market: `${half ? '上半' : '全場'}${total ? '大小' : '讓分'}`,
    slotId: `${period}_${total ? 'TOTAL' : 'RUNLINE'}_${direction}`,
    direction: total ? direction : record.side === record.lineSide ? 'GIVING' : 'RECEIVING',
    statDirection: total ? direction : null,
    statRunlineRole: total ? null : parsed.legs.every(line => line === 0) ? 'PICKEM'
      : record.side === record.lineSide ? 'GIVING' : 'RECEIVING',
    pick, matchup: `${record.away} @ ${record.home}`, placedAt: record.recordedAt, gameDate: record.startTime,
    nativeStatus: record.status, status: cancelled ? 'CANCELLED' : invalidSettlement ? 'MANUAL_REVIEW' : settlement ? 'SETTLED' : 'OPEN',
    settlement: cancelled ? null : settlement,
    ...(invalidSettlement ? { settlementError: '足球保存的結算證據與原合約未通過核對，暫不計入已結算績效。' }
      : !settlement && record.settlementCheck?.reason ? { settlementError: `足球賽果待確認：${record.settlementCheck.reason}` } : {}),
    betSource: 'SELF_REPORTED', score: null, formulaDiagnosticScore: null, scoreStatus: 'NOT_CAPTURED',
    weightedEV: null, robustEV: null, pitEvidenceVerified: false, calibrationEligibility: 'EXCLUDED_MANUAL_CONTRACT',
    formalEligible: false, calibrationEligible: false, executable: false,
  };
}
