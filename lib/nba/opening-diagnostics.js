import { NBA_OPENING_VERSION, openingVariableAccepted } from './opening-core.js';

export const NBA_OPENING_DIAGNOSTICS_VERSION = 'nba-opening-validation-diagnostics-v1';

const variables = Object.freeze({
  fullTotal: 'fullTotal',
  fullRunline: 'fullMargin',
  firstHalfTotal: 'halfTotal',
  firstHalfRunline: 'halfMargin',
});
const number = value => Number.isFinite(value) && value >= 0 ? value : null;

// This is an explanation of the existing release gate, not another model or
// acceptance policy. In particular, probabilitySamples is disclosed but does
// not introduce a new threshold that the shipped gate never required.
export function nbaOpeningValidationDiagnostics({ league = 'NBA', market, metrics, acceptance, validationYear } = {}) {
  const variable = typeof market === 'string' && Object.hasOwn(variables, market) ? variables[market] : null;
  const checks = [];
  const add = (id, label, value, reference, comparison) => {
    const actual = number(value), baseline = number(reference);
    const passed = actual !== null && baseline !== null
      && (comparison === 'at_least' ? actual >= baseline : actual <= baseline);
    checks.push({ id, label, status: passed ? 'PASS' : 'FAIL', actual, baseline,
      delta: actual !== null && baseline !== null ? actual - baseline : null, comparison });
  };
  add('samples', '驗證場次', metrics?.samples, 1000, 'at_least');
  add('earlySamples', '開季驗證場次', metrics?.earlySamples, 100, 'at_least');
  add('modelMAE', '整季平均絕對誤差', metrics?.modelMAE, metrics?.baselineMAE, 'at_most');
  add('earlyModelMAE', '開季平均絕對誤差', metrics?.earlyModelMAE, metrics?.earlyBaselineMAE, 'at_most');
  add('modelBrier', '機率平方誤差（Brier）', metrics?.modelBrier, metrics?.baselineBrier, 'at_most');
  add('modelLogLoss', '機率對數損失（Log Loss）', metrics?.modelLogLoss, metrics?.baselineLogLoss, 'at_most');
  checks.push({ id: 'acceptanceFlag', label: '封存驗證資格', status: acceptance === true ? 'PASS' : 'FAIL',
    actual: typeof acceptance === 'boolean' ? acceptance : null, baseline: true, delta: null, comparison: 'equals' });
  const failedChecks = checks.filter(check => check.status === 'FAIL').map(check => check.id);
  const failureCodes = checks.filter(check => check.status === 'FAIL').map(check =>
    check.id === 'acceptanceFlag' ? 'NBA_OPENING_VALIDATION_NOT_ACCEPTED'
      : check.actual === null || check.baseline === null ? `NBA_OPENING_VALIDATION_${check.id.toUpperCase()}_INVALID`
        : `NBA_OPENING_VALIDATION_${check.id.toUpperCase()}_FAILED`);
  if (league !== 'NBA' || !variable) failureCodes.unshift('NBA_OPENING_DIAGNOSTIC_SCOPE_INVALID');
  const validYear = Number.isInteger(validationYear) && validationYear > 0;
  if (!validYear) failureCodes.push('NBA_OPENING_VALIDATION_YEAR_INVALID');
  const accepted = league === 'NBA' && variable !== null && validYear && acceptance === true && openingVariableAccepted(metrics);
  // Keep an unknown future gate failure visible rather than reporting PASS if
  // its explanatory checks have not yet been extended alongside that gate.
  if (!accepted && !failureCodes.length) failureCodes.push('NBA_OPENING_VALIDATION_GATE_FAILED');
  return {
    version: NBA_OPENING_DIAGNOSTICS_VERSION, league, market: typeof market === 'string' ? market : null,
    variable, modelVersion: NBA_OPENING_VERSION,
    validationYear: validYear ? validationYear : null,
    status: accepted ? 'PASS' : 'FAIL', accepted,
    samples: number(metrics?.samples), earlySamples: number(metrics?.earlySamples),
    probabilitySamples: number(metrics?.probabilitySamples), checks, failedChecks, failureCodes,
  };
}
