import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { evaluateSoccerQuote } from './market-payoff.js';
import { soccerSettlementContractComplete, soccerSettlementMissingTerms } from './settlement-contract.js';
export const SOCCER_MANUAL_SETTLEMENT_VERSION = 'SOCCER-VERIFIED-TERMS-SETTLEMENT-v1';
const keys = ['league', 'date', 'gameId', 'startTime', 'teamIds', 'period', 'kind', 'side', 'line', 'lineSide', 'water', 'stake', 'analysisRevision', 'quoteKey'];
export const soccerOriginalContract = record => Object.fromEntries(keys.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]]));
export const soccerManualContractHash = record => createHash('sha256').update(JSON.stringify(keys.map(key => record[key] ?? null))).digest('hex');
const pending = (reason, extra = {}) => ({ status: 'PENDING', reason, version: SOCCER_MANUAL_SETTLEMENT_VERSION, ...extra });
export function settleSoccerManualRecord(record, result, contract = null, now = Date.now()) {
  if (record?.status !== 'OPEN') return pending('RECORD_CANCELLED');
  const contractHash = soccerManualContractHash(record);
  const teamIds = record.teamIds || record.identityEvidence?.teamIds;
  if (!['epl', 'ucl'].includes(record.league) || !['HT', 'FT'].includes(record.period)
    || !Number.isFinite(record.stake) || record.stake <= 0 || !Number.isFinite(record.water) || record.water <= 0
    || !teamIds?.home || !teamIds?.away || teamIds.home === teamIds.away) return pending('ORIGINAL_CONTRACT_INVALID', { contractHash });
  if (!result?.ok || result.verified !== true || result.status !== 'NORMAL_FINAL_CROSSCHECKED') return pending(result?.reason || 'RESULT_NOT_VERIFIED', { contractHash });
  if (result.gameId !== record.gameId || result.league !== record.league || result.date !== record.date || result.startTime !== record.startTime
    || !['home', 'away'].every(side => result.teamIds?.[side] === teamIds[side])) return pending('RESULT_RECORD_IDENTITY_MISMATCH', { contractHash });
  const scores = record.period === 'HT' ? result.halfTime : result.fullTime;
  if (!scores || scores.period !== (record.period === 'HT' ? 'REGULATION_HT' : 'REGULATION_FT')
    || !['home', 'away'].every(side => Number.isSafeInteger(scores[side]) && scores[side] >= 0)) return pending('RESULT_PERIOD_SCORE_UNVERIFIED', { contractHash, resultHash: result.resultHash });
  if (!soccerSettlementContractComplete(contract, record) || Date.parse(contract.verifiedAt) > now) return pending('SOCCER_SOURCE_CONTRACT_UNVERIFIED', {
    contractHash, resultHash: result.resultHash, resultEvidence: result,
    missing: soccerSettlementMissingTerms(now).map(term=>term.code), missingTerms: soccerSettlementMissingTerms(now), resultStatus: 'RESULT_VERIFIED_CONTRACT_PENDING',
  });
  const quote = { kind: record.kind, direction: record.side?.toUpperCase(), sourceLine: record.line, lineSide: record.lineSide,
    period: record.period, water: record.water, waterFormat: 'PROFIT_PER_UNIT' };
  const calculation = evaluateSoccerQuote({ quote, distribution: { period: scores.period, retainedMass: 1, tailMass: 0, cells: [{ home: scores.home, away: scores.away, probability: 1 }] },
    contract: { type: contract.type, period: contract.period, rebate: { rate: 0, basis: 'NONE' },
      labelMapping: { home: '主隊', away: '客隊' }, provenance: { status: 'VERIFIED', evidenceRef: contract.evidenceRef } } });
  if (!calculation.ok || calculation.rows.length !== 1) return pending('CONTRACT_PAYOFF_NOT_CALCULABLE', { contractHash, resultHash: result.resultHash });
  const row = calculation.rows[0], stake = new Decimal(record.stake);
  const settledFraction = contract.rebate.basis === 'SETTLED_PRINCIPAL'
    ? new Decimal(row.winFraction).plus(row.lossFraction) : new Decimal(1);
  const rebate = contract.rebate.appliesTo[row.outcome] ? stake.times(settledFraction).times('0.01') : new Decimal(0);
  const gross = stake.times(row.winFraction).times(record.water).minus(stake.times(row.lossFraction));
  return { status: 'SETTLED', version: SOCCER_MANUAL_SETTLEMENT_VERSION, contractHash, contractVersion: contract.version,
    contractEvidenceRef: contract.evidenceRef, resultHash: result.resultHash, resultEvidence: result,
    outcome: row.outcome, winFraction: row.winFraction, lossFraction: row.lossFraction, pushFraction: row.pushFraction,
    scores: { home: scores.home, away: scores.away, period: scores.period }, stake: record.stake,
    grossProfit: gross.toNumber(), rebate: rebate.toNumber(), profit: gross.plus(rebate).toNumber(),
    rebateRate: 0.01, rebateBasis: contract.rebate.basis, settledAt: new Date(now).toISOString(),
    formalEligible: false, calibrationEligible: false, executable: false };
}
