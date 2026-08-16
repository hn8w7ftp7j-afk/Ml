const finite = value => Number.isFinite(Number(value));

/**
 * Evaluate a candidate allocation directly on joint scenario returns.
 * This avoids a covariance-only approximation and preserves half-win/push/half-loss outcomes.
 */
export function expectedLogGrowth({ states, allocations }) {
  if (!Array.isArray(states) || states.length === 0 || !allocations || typeof allocations !== 'object') {
    return { ok: false, reason: 'PORTFOLIO_INPUT_MISSING' };
  }
  let probabilitySum = 0;
  let objective = 0;
  for (const state of states) {
    if (!finite(state.probability) || Number(state.probability) < 0 || !state.returns) {
      return { ok: false, reason: 'PORTFOLIO_STATE_INVALID' };
    }
    let wealthFactor = 1;
    for (const [betId, fraction] of Object.entries(allocations)) {
      if (!finite(fraction) || Number(fraction) < 0) return { ok: false, reason: 'PORTFOLIO_ALLOCATION_INVALID' };
      const stateReturn = Number(state.returns[betId] ?? 0);
      if (!finite(stateReturn)) return { ok: false, reason: 'PORTFOLIO_RETURN_INVALID' };
      wealthFactor += Number(fraction) * stateReturn;
    }
    if (wealthFactor <= 0) return { ok: false, reason: 'PORTFOLIO_BANKRUPTCY_STATE' };
    probabilitySum += Number(state.probability);
    objective += Number(state.probability) * Math.log(wealthFactor);
  }
  if (Math.abs(probabilitySum - 1) > 1e-6) return { ok: false, reason: 'PORTFOLIO_PROBABILITY_NOT_NORMALIZED' };
  return { ok: true, expectedLogGrowth: objective };
}

/**
 * Deterministic grid optimizer. Production sizing is fail-closed until calibrated policy
 * supplies max fractions, step size, daily/game exposure caps and Kelly fraction.
 */
export function optimizeJointPortfolio({ states, betIds, policy }) {
  if (!policy || !finite(policy.step) || Number(policy.step) <= 0 || !finite(policy.maxPerBet) || !finite(policy.maxTotal)) {
    return { ok: false, reason: 'PORTFOLIO_POLICY_NOT_CALIBRATED' };
  }
  if (!Array.isArray(betIds) || betIds.length === 0) return { ok: false, reason: 'PORTFOLIO_BETS_MISSING' };

  const step = Number(policy.step);
  const maxPerBet = Number(policy.maxPerBet);
  const maxTotal = Number(policy.maxTotal);
  let best = { allocations: Object.fromEntries(betIds.map(id => [id, 0])), expectedLogGrowth: 0 };

  function visit(index, allocations, total) {
    if (index === betIds.length) {
      const result = expectedLogGrowth({ states, allocations });
      if (result.ok && result.expectedLogGrowth > best.expectedLogGrowth) best = { allocations: { ...allocations }, expectedLogGrowth: result.expectedLogGrowth };
      return;
    }
    const id = betIds[index];
    for (let fraction = 0; fraction <= maxPerBet + 1e-12 && total + fraction <= maxTotal + 1e-12; fraction += step) {
      allocations[id] = Number(fraction.toFixed(10));
      visit(index + 1, allocations, total + fraction);
    }
  }
  visit(0, {}, 0);
  return { ok: true, ...best, policyVersion: policy.version || null };
}

export const PORTFOLIO_VERSION = 'MLB-JOINT-PORTFOLIO-2026-08-v10.0.0';
