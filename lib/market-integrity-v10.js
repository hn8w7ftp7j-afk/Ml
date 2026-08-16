const finite = value => Number.isFinite(Number(value));

function sameContract(left, right) {
  return Boolean(left && right &&
    left.gameKey === right.gameKey &&
    left.market === right.market &&
    left.side === right.side &&
    left.line === right.line &&
    left.contractRules === right.contractRules);
}

export function assessMarketIntegrity({ model, execution, sharpReferences = [], nowMs, maxAgeMs }) {
  if (!model || !execution || !finite(model.probability) || !finite(execution.capturedAt) || !finite(nowMs) || !finite(maxAgeMs)) {
    return { status: 'BLOCK', reason: 'MARKET_INTEGRITY_INPUT_MISSING' };
  }
  if (Number(nowMs) - Number(execution.capturedAt) > Number(maxAgeMs)) {
    return { status: 'BLOCK', reason: 'EXECUTION_PRICE_STALE' };
  }

  const comparable = sharpReferences.filter(reference =>
    sameContract(execution, reference) &&
    finite(reference.capturedAt) &&
    Number(nowMs) - Number(reference.capturedAt) <= Number(maxAgeMs) &&
    finite(reference.noVigProbability)
  );

  if (comparable.length === 0) {
    return { status: 'UNVERIFIED', reason: 'NO_FRESH_SHARP_REFERENCE', comparableCount: 0 };
  }

  const consensus = comparable.reduce((sum, reference) => sum + Number(reference.noVigProbability), 0) / comparable.length;
  const modelGap = Number(model.probability) - consensus;
  const movement = comparable
    .filter(reference => finite(reference.previousNoVigProbability))
    .map(reference => Number(reference.noVigProbability) - Number(reference.previousNoVigProbability));
  const meanMovement = movement.length ? movement.reduce((sum, value) => sum + value, 0) / movement.length : null;

  // Classification thresholds are not guessed here. They must be supplied by calibrated policy.
  return {
    status: 'MEASURED',
    comparableCount: comparable.length,
    sharpConsensusProbability: consensus,
    modelVsSharpGap: modelGap,
    sharpMeanMovement: meanMovement,
  };
}

export function classifyMeasuredIntegrity(measured, policy) {
  if (measured?.status !== 'MEASURED') return measured;
  if (!policy || !finite(policy.divergenceGap) || !finite(policy.confirmationMove)) {
    return { ...measured, status: 'UNVERIFIED', reason: 'MARKET_POLICY_NOT_CALIBRATED' };
  }
  const gap = Number(measured.modelVsSharpGap);
  const move = measured.sharpMeanMovement;
  if (Math.abs(gap) >= Number(policy.divergenceGap) && finite(move) && Math.sign(gap) !== Math.sign(Number(move))) {
    return { ...measured, status: 'BLOCK', reason: 'UNEXPLAINED_DIVERGENCE' };
  }
  if (Math.abs(gap) >= Number(policy.divergenceGap) && finite(move) && Math.sign(gap) === Math.sign(Number(move)) && Math.abs(Number(move)) >= Number(policy.confirmationMove)) {
    return { ...measured, status: 'CONFIRMED_DISLOCATION' };
  }
  return { ...measured, status: 'NORMAL' };
}

export const MARKET_INTEGRITY_VERSION = 'MLB-MARKET-INTEGRITY-2026-08-v10.0.0';
