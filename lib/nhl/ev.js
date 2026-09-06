import { deterministicScore } from '../deterministic-score.js';
import { SETTLEMENT_RULE_VERSION, TAIWAN_CREDIT_REBATE_RATE } from '../taiwan-settlement-v9.js';
import { nhlContractScopeKey, nhlFiniteNumber, nhlGameIdentity, validateNhlMarket } from './contracts.js';
import { nhlPayoffForScore, projectNhlContractScore, validateNhlLinkedPath } from './settlement.js';

export const NHL_EV_VERSION = 'NHL-LINKED-PATH-PAYOFF-EV-v1';
const SUM_TOLERANCE = 1e-9; // Floating point integrity, not a model/EV limit.

export function nhlPayoffCalibrationKey(contract) {
  return JSON.stringify([nhlContractScopeKey(contract), contract?.selection, contract?.pick,
    contract?.water, SETTLEMENT_RULE_VERSION, TAIWAN_CREDIT_REBATE_RATE]);
}

export function auditNhlEvDistribution(distribution) {
  const errors = [];
  if (!distribution || !nhlGameIdentity(distribution.game)) errors.push('DISTRIBUTION_IDENTITY_MISSING');
  if (typeof distribution?.distributionId !== 'string' || !distribution.distributionId) errors.push('DISTRIBUTION_ID_MISSING');
  if (distribution?.qa?.passed === false || distribution?.qa?.status === 'BLOCK') errors.push('NHL_UPSTREAM_MODEL_QA_BLOCK');
  if (!Array.isArray(distribution?.scenarios) || !distribution.scenarios.length) errors.push('SCENARIOS_MISSING');
  const ids = new Set();
  let weightSum = 0;
  for (const scenario of Array.isArray(distribution?.scenarios) ? distribution.scenarios : []) {
    if (!scenario || typeof scenario.id !== 'string' || !scenario.id || ids.has(scenario.id)) errors.push('SCENARIO_ID_INVALID');
    ids.add(scenario?.id);
    if (!nhlFiniteNumber(scenario?.weight) || scenario.weight <= 0) errors.push('SCENARIO_WEIGHT_INVALID');
    else weightSum += scenario.weight;
    if (!Array.isArray(scenario?.paths) || !scenario.paths.length) errors.push('SCENARIO_PATHS_MISSING');
    let probabilitySum = 0;
    for (const path of Array.isArray(scenario?.paths) ? scenario.paths : []) {
      if (!nhlFiniteNumber(path?.probability) || path.probability < 0 || path.probability > 1) errors.push('PATH_PROBABILITY_INVALID');
      else probabilitySum += path.probability;
      errors.push(...validateNhlLinkedPath(path, { gameType: distribution?.gameType ?? distribution?.game?.gameType }).errors);
    }
    if (Math.abs(probabilitySum - 1) > SUM_TOLERANCE) errors.push('PATH_PROBABILITY_SUM_INVALID');
  }
  if (Math.abs(weightSum - 1) > SUM_TOLERANCE) errors.push('SCENARIO_WEIGHT_SUM_INVALID');
  return { ok: errors.length === 0, errors: [...new Set(errors)], weightSum };
}

function calibrationMargin(artifact, distribution, contract) {
  const invalid = () => ({ ok: false, margin: null, error: 'NHL_PAYOFF_OOS_CALIBRATION_MISSING' });
  // A score Brier/error rate is not an EV error. Only held-out observations
  // evaluated with this precise Taiwan payoff, water and rebate may supply it.
  // This artifact is server-owned, not accepted from Reader/client input.
  if (!artifact || artifact.validated !== true || artifact.kind !== 'NHL_PAYOFF_OOS_ERROR'
    || artifact.modelArtifactId !== distribution.modelArtifactId
    || typeof artifact.sourceHash !== 'string' || !artifact.sourceHash
    || typeof artifact.calibrationMethod !== 'string' || !artifact.calibrationMethod
    || !Number.isSafeInteger(artifact.sampleCount) || artifact.sampleCount <= 0
    || artifact.payoffContractKey !== nhlPayoffCalibrationKey(contract)
    || artifact.settlementRuleVersion !== SETTLEMENT_RULE_VERSION
    || artifact.rebateRate !== TAIWAN_CREDIT_REBATE_RATE
    || !nhlFiniteNumber(artifact.modelErrorMarginEV) || artifact.modelErrorMarginEV < 0) return invalid();
  const trainingCutoff = Date.parse(artifact.trainingCutoff);
  const validationStart = Date.parse(artifact.validationStart);
  const validationCutoff = Date.parse(artifact.validationCutoff);
  const quoteAt = Date.parse(contract.observedAt);
  if (![trainingCutoff, validationStart, validationCutoff, quoteAt].every(Number.isFinite)
    || !(trainingCutoff < validationStart && validationStart <= validationCutoff && validationCutoff < quoteAt)) return invalid();
  return { ok: true, margin: artifact.modelErrorMarginEV, sourceHash: artifact.sourceHash };
}

function weightedQuantile(rows, quantile) {
  const sorted = rows.slice().sort((a, b) => a.ev - b.ev);
  let cumulative = 0;
  for (const row of sorted) {
    cumulative += row.weight;
    if (cumulative + Number.EPSILON >= quantile) return row.ev;
  }
  return sorted.at(-1)?.ev ?? null;
}

/** All markets price exactly the same linked scenario paths. Neither water,
 * line changes nor the desired pick can alter the underlying distribution. */
export function evaluateNhlMarkets({ distribution, markets = [], manifest, game,
  calibrationArtifact = null, now = Date.now(), maxAgeMs = null } = {}) {
  const audit = auditNhlEvDistribution(distribution);
  return markets.map(market => {
    const validated = validateNhlMarket(market, { manifest, game: game || distribution?.game, now, maxAgeMs });
    const errors = [...audit.errors, ...validated.errors];
    const warnings = [];
    if (game && nhlGameIdentity(game) !== nhlGameIdentity(distribution?.game)) errors.push('MODEL_GAME_IDENTITY_MISMATCH');
    const base = { version: NHL_EV_VERSION, marketId: market?.marketId ?? null,
      distributionId: distribution?.distributionId ?? null, weightedEV: null, robustEV: null,
      score: null, eligible: false, formalEligible: false, status: 'BLOCK', errors, warnings };
    if (errors.length) return base;
    const contract = validated.contract;
    const scenarioEVs = distribution.scenarios.map(scenario => {
      let ev = 0;
      let winProbability = 0;
      let lossProbability = 0;
      let pushProbability = 0;
      for (const path of scenario.paths) {
        const selectedScore = projectNhlContractScore(path, contract);
        const payout = nhlPayoffForScore(contract, selectedScore);
        if (!payout) { errors.push('PATH_PAYOFF_INVALID'); continue; }
        ev += path.probability * payout.profit;
        winProbability += path.probability * payout.settlement.winFraction;
        lossProbability += path.probability * payout.settlement.lossFraction;
        pushProbability += path.probability * payout.settlement.pushFraction;
      }
      if (![ev, winProbability, lossProbability, pushProbability].every(Number.isFinite)
        || Math.abs(winProbability + lossProbability + pushProbability - 1) > SUM_TOLERANCE) errors.push('PAYOFF_MASS_INVALID');
      return { id: scenario.id, weight: scenario.weight, ev, winProbability, lossProbability, pushProbability };
    });
    if (errors.length) return { ...base, errors: [...new Set(errors)] };
    const weightedEV = scenarioEVs.reduce((sum, row) => sum + row.weight * row.ev, 0);
    const scenarioQ10EV = weightedQuantile(scenarioEVs, 0.10);
    const calibration = calibrationMargin(calibrationArtifact, distribution, contract);
    // Missing calibration remains visible. A guessed zero haircut or a borrowed
    // baseball constant must not be represented as a completed Robust EV.
    const robustEV = calibration.ok ? Math.min(weightedEV, scenarioQ10EV, weightedEV - calibration.margin) : null;
    if (!calibration.ok) errors.push(calibration.error);
    if (robustEV != null && weightedEV - robustEV > 0.05) warnings.push('W_R_SCENARIO_GAP_OVER_5_PERCENT');
    if (nhlFiniteNumber(distribution.dataQuality) && distribution.dataQuality < 0.85) warnings.push('DATA_QUALITY_BELOW_085');
    if (distribution.readyForFormal !== true) warnings.push('NHL_MODEL_SHADOW_ONLY');
    const scoreResult = robustEV == null ? null : deterministicScore({
      weightedEV, robustEV, qaPassed: errors.length === 0, actualWater: true,
      executable: true, crossMarketVerified: false,
    });
    return {
      ...base, status: errors.length ? 'BLOCK' : warnings.length ? 'WARNING' : 'PASS',
      contractIdentity: contract.identity, weightedEV, robustEV, scenarioQ10EV,
      modelErrorMarginEV: calibration.margin, calibrationSourceHash: calibration.sourceHash ?? null,
      score: scoreResult?.score ?? null, scoreResult, scenarioEVs,
      // This release exposes diagnostics, never a formal execution permission.
      candidate: !errors.length && (scoreResult?.score ?? 0) >= 7.2 && weightedEV > 0 && robustEV > 0,
      errors: [...new Set(errors)], warnings,
    };
  });
}
