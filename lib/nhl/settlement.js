import { settleTaiwanContract, settlementProfit, TAIWAN_CREDIT_REBATE_RATE } from '../taiwan-settlement-v9.js';
import { nhlContractScopeKey, nhlFiniteNumber, nhlGameIdentity, nhlSeasonType, validateNhlMarket } from './contracts.js';

export const NHL_SETTLEMENT_VERSION = 'NHL-EXPLICIT-SCOPE-SETTLEMENT-v1';
const score = value => value && Number.isSafeInteger(value.away) && value.away >= 0 && Number.isSafeInteger(value.home) && value.home >= 0;
const equalScore = (left, right) => score(left) && score(right) && left.away === right.away && left.home === right.home;

/** Verify one complete linked outcome; a shootout is one official winner goal,
 * never a count of successful shootout attempts. All markets share this path. */
export function validateNhlLinkedPath(path, { gameType } = {}) {
  const errors = [];
  const periods = path?.periodScores;
  if (!Array.isArray(periods) || periods.length !== 3
    || ![1, 2, 3].every(period => periods.filter(row => row?.period === period && score(row)).length === 1)) errors.push('PERIOD_SCORES_INVALID');
  if (!score(path?.regulation) || !score(path?.final)) errors.push('SCORE_INVALID');
  if (!errors.length) {
    const sum = periods.reduce((total, row) => ({ away: total.away + row.away, home: total.home + row.home }), { away: 0, home: 0 });
    if (!equalScore(sum, path.regulation)) errors.push('PERIOD_REGULATION_MISMATCH');
    const outcome = path.outcome;
    if (!outcome || !['away', 'home'].includes(outcome.winner)
      || typeof outcome.overtime !== 'boolean' || typeof outcome.shootout !== 'boolean') errors.push('OUTCOME_INVALID');
    else {
      if (path.final.away === path.final.home || outcome.winner !== (path.final.away > path.final.home ? 'away' : 'home')) errors.push('WINNER_SCORE_MISMATCH');
      if (outcome.shootout && !outcome.overtime) errors.push('SHOOTOUT_WITHOUT_OVERTIME');
      if (outcome.shootout && nhlSeasonType(gameType) === 'PLAYOFF') errors.push('PLAYOFF_SHOOTOUT_INVALID');
      if (outcome.overtime) {
        if (path.regulation.away !== path.regulation.home) errors.push('OVERTIME_WITHOUT_REGULATION_TIE');
        const expected = { ...path.regulation, [outcome.winner]: path.regulation[outcome.winner] + 1 };
        if (!equalScore(expected, path.final)) errors.push('OT_SO_OFFICIAL_SCORE_MISMATCH');
      } else if (!equalScore(path.regulation, path.final)) errors.push('REGULATION_FINAL_MISMATCH');
    }
  }
  return { ok: !errors.length, errors };
}

export function projectNhlContractScore(path, contract) {
  if (!validateNhlLinkedPath(path).ok) return null;
  if (contract.scoreScope === 'PERIOD' && contract.includesOvertime === false && contract.shootoutRule === 'EXCLUDED') {
    const period = path.periodScores.find(row => row.period === contract.period);
    return period ? { away: period.away, home: period.home } : null;
  }
  if (contract.scoreScope === 'REGULATION' && contract.includesOvertime === false && contract.shootoutRule === 'EXCLUDED') return { ...path.regulation };
  if (contract.scoreScope === 'GAME' && contract.includesOvertime === true) {
    if (contract.shootoutRule === 'OFFICIAL_ONE_GOAL') return { ...path.final };
    if (contract.shootoutRule === 'EXCLUDED') return { ...(path.outcome.shootout ? path.regulation : path.final) };
  }
  return null;
}

export function nhlPayoffForScore(contract, scopedScore, { stake = 1, water = contract?.water, rebateRate = TAIWAN_CREDIT_REBATE_RATE } = {}) {
  if (!score(scopedScore) || !nhlFiniteNumber(stake) || stake <= 0
    || !nhlFiniteNumber(rebateRate) || ![0, TAIWAN_CREDIT_REBATE_RATE].includes(rebateRate)
    || !contract?.taiwanContract?.valid || contract.marketType === 'MONEYLINE') return null;
  const waters = Array.isArray(water) ? water : [water];
  if (!waters.length || waters.some(value => !nhlFiniteNumber(value) || value <= 0)) return null;
  // Resolve the team to exact internal labels before invoking the shared parser's
  // permissive legacy team-name matcher. Display aliases cannot change identity.
  const taiwan = { ...contract.taiwanContract, team: contract.selection === 'away' ? 'NHL_AWAY' : 'NHL_HOME' };
  const settlement = settleTaiwanContract(taiwan, scopedScore.away, scopedScore.home, 'NHL_AWAY', 'NHL_HOME');
  return settlement ? { settlement, ...settlementProfit({ stake, water, settlement, rebateRate }) } : null;
}

export function settleNhlTicket(ticket, result, options = {}) {
  const errors = [];
  if (ticket?.status !== 'OPEN') errors.push('TICKET_NOT_OPEN');
  if (!nhlFiniteNumber(ticket?.stake) || ticket.stake <= 0) errors.push('STAKE_INVALID');
  const checked = validateNhlMarket(ticket?.contract, { ...options, maxAgeMs: null });
  errors.push(...checked.errors);
  if (!result || result.league !== 'NHL' || result.verified !== true
    || typeof result.sourceHash !== 'string' || !result.sourceHash.trim()
    || typeof result.observedAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(result.observedAt)
    || !Number.isFinite(Date.parse(result.observedAt)) || Date.parse(result.observedAt) > (options.now ?? Date.now())) errors.push('OFFICIAL_RESULT_UNVERIFIED');
  if (!nhlGameIdentity(result) || nhlGameIdentity(result) !== nhlGameIdentity(ticket?.contract)) errors.push('RESULT_IDENTITY_MISMATCH');
  const gameType = nhlSeasonType(result?.gameType);
  if (!gameType || gameType !== nhlSeasonType(ticket?.gameType)) errors.push('GAME_TYPE_MISMATCH');
  const isPeriod = checked.contract?.scoreScope === 'PERIOD';
  const completedPeriods = isPeriod && Array.isArray(result?.periodScores)
    ? result.periodScores.filter(row => row?.period === checked.contract.period) : [];
  const completedPeriod = completedPeriods.length === 1 ? completedPeriods[0] : null;
  if (result?.status === 'FINAL') errors.push(...validateNhlLinkedPath(result, { gameType }).errors);
  else if (!isPeriod || !score(completedPeriod) || completedPeriod.complete !== true
    || !['LIVE', 'INTERMISSION'].includes(result?.status)) errors.push('RESULT_NOT_FINAL');
  // Voids/abandonments/corrections require separately authenticated rules;
  // unfinished results stay OPEN. They are never guessed as a loss or a push.
  if (errors.length) return { ok: false, status: ticket?.status ?? 'OPEN', errors: [...new Set(errors)], settlement: null };
  const scopedScore = isPeriod && result.status !== 'FINAL'
    ? { away: completedPeriod.away, home: completedPeriod.home }
    : projectNhlContractScore(result, checked.contract);
  const payout = nhlPayoffForScore(checked.contract, scopedScore, { stake: ticket.stake });
  if (!payout) return { ok: false, status: 'OPEN', errors: ['SETTLEMENT_UNAVAILABLE'], settlement: null };
  return {
    ok: true, status: 'SETTLED', errors: [], version: NHL_SETTLEMENT_VERSION,
    scopedScore, ...payout, resultEvidence: { sourceHash: result.sourceHash, observedAt: result.observedAt },
    contractIdentity: checked.contract.identity, gameType,
    performanceBucket: gameType === 'PRESEASON' ? 'PRESEASON_SHADOW' : 'REGULAR_AND_PLAYOFF',
  };
}

const comparisonStatus = deltas => {
  const positive = deltas.some(value => value > 1e-10);
  const negative = deltas.some(value => value < -1e-10);
  return positive && negative ? 'MIXED' : positive ? 'BETTER' : negative ? 'WORSE' : 'EQUIVALENT';
};

/** Exact payoff ordering over the entire nonnegative integer score domain.
 * Settlement payoffs only change at contract leg thresholds. Evaluate both
 * sides of every threshold and every exact integer threshold, including tails.
 * There is no arbitrary baseball 0..20 score grid or truncation. */
export function compareNhlContracts(placed, current, options = {}) {
  const oldValidation = validateNhlMarket(placed, { ...options, maxAgeMs: null });
  const newValidation = validateNhlMarket(current, { ...options, maxAgeMs: null });
  const fail = reason => ({ version: NHL_SETTLEMENT_VERSION, comparable: false, combinedStatus: 'UNKNOWN', reason });
  if (!oldValidation.ok || !newValidation.ok) return fail('CONTRACT_UNVERIFIED');
  const old = oldValidation.contract;
  const next = newValidation.contract;
  if (nhlGameIdentity(old) !== nhlGameIdentity(next) || nhlContractScopeKey(old) !== nhlContractScopeKey(next)
    || old.selection !== next.selection || old.taiwanContract.direction !== next.taiwanContract.direction) return fail('CONTRACT_POSITION_MISMATCH');
  const total = old.marketType === 'TOTAL';
  const thresholds = [...old.taiwanContract.legs, ...next.taiwanContract.legs]
    .map(value => total || old.taiwanContract.isGiving ? value : -value);
  const points = new Set(total ? [0] : [-1, 0, 1]);
  for (const threshold of thresholds) {
    for (const value of [Math.floor(threshold) - 1, Math.floor(threshold), Math.ceil(threshold), Math.ceil(threshold) + 1]) {
      if (!total || value >= 0) points.add(value);
    }
  }
  const rows = [...points].sort((a, b) => a - b).map(value => {
    const margin = old.selection === 'home' ? -value : value;
    const scopedScore = total ? { away: value, home: 0 } : { away: Math.max(0, margin), home: Math.max(0, -margin) };
    const a = nhlPayoffForScore(old, scopedScore);
    const b = nhlPayoffForScore(next, scopedScore);
    const lineA = nhlPayoffForScore(old, scopedScore, { water: 1, rebateRate: 0 });
    const lineB = nhlPayoffForScore(next, scopedScore, { water: 1, rebateRate: 0 });
    return { value, ...scopedScore, fullDelta: a.profit - b.profit, lineDelta: lineA.profit - lineB.profit };
  });
  return {
    version: NHL_SETTLEMENT_VERSION, comparable: true,
    combinedStatus: comparisonStatus(rows.map(row => row.fullDelta)),
    lineStatus: comparisonStatus(rows.map(row => row.lineDelta)),
    evaluatedBreakpoints: rows, exactIntegerDomain: true,
  };
}

export function summarizeNhlTicketPerformance(tickets = []) {
  const initial = () => ({ count: 0, stake: 0, profit: 0, rebate: 0, roi: null });
  const buckets = { regular: initial(), playoff: initial(), preseasonShadow: initial() };
  let excluded = 0;
  for (const ticket of tickets) {
    if (ticket?.league !== 'NHL' || ticket.status !== 'SETTLED' || ticket.settlement?.ok !== true
      || !nhlFiniteNumber(ticket.stake) || ticket.stake <= 0 || !nhlFiniteNumber(ticket.settlement.profit)
      || !nhlFiniteNumber(ticket.settlement.rebate) || nhlSeasonType(ticket.settlement.gameType) !== nhlSeasonType(ticket.gameType)) { excluded += 1; continue; }
    const gameType = nhlSeasonType(ticket.gameType);
    const bucket = gameType === 'REGULAR' ? buckets.regular : gameType === 'PLAYOFF' ? buckets.playoff
      : gameType === 'PRESEASON' ? buckets.preseasonShadow : null;
    if (!bucket) { excluded += 1; continue; }
    bucket.count += 1;
    bucket.stake += ticket.stake;
    bucket.profit += ticket.settlement.profit;
    bucket.rebate += ticket.settlement.rebate;
  }
  for (const bucket of Object.values(buckets)) if (bucket.stake > 0) bucket.roi = bucket.profit / bucket.stake;
  return { version: NHL_SETTLEMENT_VERSION, ...buckets, excluded };
}
