import { parseTaiwanContract, settleTaiwanContract, SETTLEMENT_RULE_VERSION } from '../taiwan-settlement-v9.js';

export const SOCCER_MARKET_PAYOFF_VERSION = 'SOCCER-CONDITIONAL-PAYOFF-v1';
const EPS = 1e-10;
const OUTCOMES = ['FULL_WIN', 'PARTIAL_WIN', 'PUSH', 'PARTIAL_LOSS', 'FULL_LOSS'];
const PERIODS = { FT: 'REGULATION_FT', HT: 'REGULATION_HT' };
const REBATE_BASES = ['NONE', 'SETTLED_PRINCIPAL', 'TOTAL_PRINCIPAL', 'LOSS_PRINCIPAL'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 240;
const baseResult = () => ({ version: SOCCER_MARKET_PAYOFF_VERSION,
  unit: 'NET_PROFIT_PER_1_STAKE', stakeUnit: 1,
  costScope: 'REBATE_INCLUDED_OTHER_COSTS_NOT_MODELED',
  formalScoringEnabled: false, eligible: false, executable: false,
  W: null, R: null, S: null,
});
const unavailable = (code, missing = []) => ({ ...baseResult(), ok: false, status: 'NOT_CALCULABLE',
  code, missing, grossEV: null, netEV: null, retainedEV: null, evBounds: null,
  probabilities: null, rows: [],
});

function validateContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return ['contract'];
  const missing = [];
  if (!['CREDIT_BOUNDARY', 'ASIAN_SPLIT'].includes(contract.type)) missing.push('contract.type');
  if (!Object.hasOwn(PERIODS, contract.period)) missing.push('contract.period');
  if (!contract.rebate || !finite(contract.rebate.rate) || contract.rebate.rate < 0 || contract.rebate.rate > 1) missing.push('contract.rebate.rate');
  if (!REBATE_BASES.includes(contract.rebate?.basis)) missing.push('contract.rebate.basis');
  if (contract.rebate?.basis === 'NONE' && contract.rebate.rate !== 0) missing.push('contract.rebate.NONE_requires_zero_rate');
  if (!['VERIFIED', 'ASSUMPTION'].includes(contract.provenance?.status)) missing.push('contract.provenance.status');
  return missing;
}

function distributionRows(distribution, period) {
  if (!distribution || distribution.period !== PERIODS[period] || !Array.isArray(distribution.cells) ||
      !distribution.cells.length || distribution.cells.length > 100000 ||
      !finite(distribution.retainedMass) || distribution.retainedMass < 0 || distribution.retainedMass > 1 + EPS ||
      !finite(distribution.tailMass) || distribution.tailMass < 0 || distribution.tailMass > 1) return null;
  const seen = new Set();
  let retainedMass = 0;
  for (const row of distribution.cells) {
    if (!row || ![row.home, row.away].every(x => Number.isSafeInteger(x) && x >= 0 && x <= 1000) ||
        !finite(row.probability) || row.probability < 0 || row.probability > 1) return null;
    const key = `${row.home}:${row.away}`;
    if (seen.has(key)) return null;
    seen.add(key);
    retainedMass += row.probability;
  }
  if (retainedMass > 1 + EPS || Math.abs(retainedMass - distribution.retainedMass) > EPS ||
      Math.abs(retainedMass + distribution.tailMass - 1) > EPS) return null;
  // A tiny under-allocation is still unresolved probability, even when it falls
  // within the comparison tolerance. It cannot become an exact EV by declaring
  // tailMass=0. No cell is rescaled to force a total of one.
  return { cells: distribution.cells, retainedMass,
    tailMass: Math.max(distribution.tailMass, Math.max(0, 1 - retainedMass)),
    declaredTailMass: distribution.tailMass,
    numericalMassError: retainedMass + distribution.tailMass - 1 };
}

function rebateFor(fractions, rebate) {
  const basis = rebate.basis === 'TOTAL_PRINCIPAL' ? 1
    : rebate.basis === 'SETTLED_PRINCIPAL' ? fractions.winFraction + fractions.lossFraction
      : rebate.basis === 'LOSS_PRINCIPAL' ? fractions.lossFraction : 0;
  return rebate.rate * basis;
}

function outcomeFor({ winFraction: win, lossFraction: loss, pushFraction: push }) {
  if (Math.abs(win - 1) <= EPS) return 'FULL_WIN';
  if (Math.abs(loss - 1) <= EPS) return 'FULL_LOSS';
  if (Math.abs(push - 1) <= EPS) return 'PUSH';
  if (win > 0 && loss === 0 && push > 0) return 'PARTIAL_WIN';
  if (loss > 0 && win === 0 && push > 0) return 'PARTIAL_LOSS';
  return null;
}

function creditSettlement(quote, contract) {
  // Credit suffix signs are passed unchanged into the existing credit engine.
  // .25/.75 are NOT interpreted as a single credit leg or silently converted.
  const match = quote.sourceLine.match(/^(\d+(?:\.\d+)?)(平|[+-]\d{1,3})?$/);
  if (!match) return null;
  const line = Number(match[1]);
  if (!Number.isFinite(line) || line > 1000 || !Number.isInteger(line * 2) ||
      (match[2] && !Number.isInteger(line)) ||
      Number(match[2]?.match(/[+-](\d+)$/)?.[1] || 0) > 100) return null;
  let pick;
  const mapping = contract.labelMapping;
  if (quote.kind === 'HANDICAP') {
    if (!text(mapping?.home) || !text(mapping?.away) || mapping.home === mapping.away) return null;
    const side = quote.direction === 'HOME' ? 'home' : 'away';
    pick = `${mapping[side]}${quote.lineSide === side ? '讓' : '受讓'}${quote.sourceLine}`;
  } else pick = `${quote.direction === 'OVER' ? '大' : '小'}${quote.sourceLine}`;
  const parsed = parseTaiwanContract(pick, { period: contract.period, marketType: quote.kind });
  if (!parsed.valid || parsed.legs.length !== 1) return null;
  return { ruleVersion: SETTLEMENT_RULE_VERSION, legs: parsed.legs,
    settle: row => settleTaiwanContract(parsed, row.away, row.home, mapping?.away || '', mapping?.home || ''),
  };
}

function asianSettlement(quote) {
  // sourceLine is the raw nonnegative magnitude. HANDICAP lineSide identifies
  // the giving team, avoiding a guessed sign conversion from an unscoped label.
  if (!/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/.test(quote.sourceLine)) return null;
  const values = quote.sourceLine.split('/').map(Number);
  if (values.some(value => !finite(value) || value < 0 || value > 1000)) return null;
  let legs;
  if (values.length === 2) {
    if (values.some(value => !Number.isInteger(value * 2)) || Math.abs(values[0] - values[1]) !== 0.5) return null;
    legs = values;
  } else {
    const value = values[0], quarters = value * 4;
    if (!Number.isInteger(quarters)) return null;
    legs = Number.isInteger(value * 2) ? [value] : [(quarters - 1) / 4, (quarters + 1) / 4];
  }
  return { ruleVersion: 'EXPLICIT-ASIAN-SPLIT-v1', legs,
    settle: row => {
      let winFraction = 0, lossFraction = 0, pushFraction = 0;
      const perLeg = legs.map(line => {
        let delta;
        if (quote.kind === 'TOTAL') delta = quote.direction === 'OVER' ? row.home + row.away - line : line - row.home - row.away;
        else {
          const side = quote.direction === 'HOME' ? 'home' : 'away';
          const margin = side === 'home' ? row.home - row.away : row.away - row.home;
          delta = margin + (quote.lineSide === side ? -line : line);
        }
        const allocation = 1 / legs.length;
        const winShare = delta > 0 ? 1 : 0, lossShare = delta < 0 ? 1 : 0, pushShare = delta === 0 ? 1 : 0;
        winFraction += allocation * winShare; lossFraction += allocation * lossShare; pushFraction += allocation * pushShare;
        return { line, allocation, winShare, lossShare, pushShare };
      });
      return { winFraction, lossFraction, pushFraction, coverage: winFraction + lossFraction + pushFraction, legs: perLeg };
    },
  };
}

/**
 * Conditional arithmetic only. No source-rule approval, model calibration,
 * candidate promotion, or formal W/R/S is inferred from these calculations.
 * A missing contract never creates implicit zero-rebate or period assumptions.
 */
export function evaluateSoccerQuote({ quote, distribution, contract } = {}) {
  const missing = validateContract(contract);
  if (missing.length) return unavailable('SOCCER_PAYOFF_CONTRACT_INCOMPLETE', missing);
  if (!quote || !['HANDICAP', 'TOTAL'].includes(quote.kind) || !text(quote.sourceLine) ||
      quote.sourceLine.trim() !== quote.sourceLine || quote.period !== contract.period ||
      !finite(quote.water) || quote.water <= 0 || quote.water > 1000 || quote.waterFormat !== 'PROFIT_PER_UNIT' ||
      (quote.kind === 'HANDICAP' && (!['HOME', 'AWAY'].includes(quote.direction) || !['home', 'away'].includes(quote.lineSide))) ||
      (quote.kind === 'TOTAL' && !['OVER', 'UNDER'].includes(quote.direction))) return unavailable('SOCCER_PAYOFF_QUOTE_INVALID');
  const grid = distributionRows(distribution, contract.period);
  if (!grid) return unavailable('SOCCER_PAYOFF_DISTRIBUTION_INVALID');
  const engine = contract.type === 'CREDIT_BOUNDARY' ? creditSettlement(quote, contract) : asianSettlement(quote);
  if (!engine) return unavailable('SOCCER_PAYOFF_MECHANIC_OR_LABELS_UNSUPPORTED');
  const probabilities = Object.fromEntries(OUTCOMES.map(key => [key, 0]));
  const partial = new Map(), rows = [];
  let gross = 0, rebate = 0, net = 0;
  for (const score of grid.cells) {
    const result = engine.settle(score);
    if (!result || ![result.winFraction, result.lossFraction, result.pushFraction].every(x => finite(x) && x >= 0 && x <= 1) ||
        Math.abs(result.coverage - 1) > EPS) return unavailable('SOCCER_PAYOFF_SETTLEMENT_INVALID');
    const outcome = outcomeFor(result);
    if (!outcome) return unavailable('SOCCER_PAYOFF_OUTCOME_UNSUPPORTED');
    const grossPerUnit = result.winFraction * quote.water - result.lossFraction;
    const rebatePerUnit = rebateFor(result, contract.rebate), netPerUnit = grossPerUnit + rebatePerUnit;
    probabilities[outcome] += score.probability;
    if (outcome === 'PARTIAL_WIN' || outcome === 'PARTIAL_LOSS') {
      const fraction = outcome === 'PARTIAL_WIN' ? result.winFraction : result.lossFraction;
      const key = `${outcome}:${fraction}`;
      const item = partial.get(key) || { outcome, fraction, probability: 0 };
      item.probability += score.probability; partial.set(key, item);
    }
    gross += score.probability * grossPerUnit;
    rebate += score.probability * rebatePerUnit;
    net += score.probability * netPerUnit;
    rows.push({ home: score.home, away: score.away, probability: score.probability, outcome,
      winFraction: result.winFraction, lossFraction: result.lossFraction, pushFraction: result.pushFraction,
      legs: result.legs, grossPerUnit, rebatePerUnit, netPerUnit });
  }
  const corners = [
    { winFraction: 1, lossFraction: 0 }, { winFraction: 0, lossFraction: 1 }, { winFraction: 0, lossFraction: 0 },
  ].map(fractions => {
    const g = fractions.winFraction * quote.water - fractions.lossFraction;
    const r = rebateFor(fractions, contract.rebate);
    return { gross: g, rebate: r, net: g + r };
  });
  const range = key => ({ min: Math.min(...corners.map(x => x[key])), max: Math.max(...corners.map(x => x[key])) });
  const ranges = { gross: range('gross'), rebate: range('rebate'), net: range('net') };
  const bound = (contribution, key) => ({ lower: contribution + grid.tailMass * ranges[key].min,
    upper: contribution + grid.tailMass * ranges[key].max });
  return { ...baseResult(), ok: true,
    status: contract.provenance.status === 'ASSUMPTION' ? 'UNVERIFIED_ASSUMPTION' : 'CONDITIONAL_CONTRACT_ARITHMETIC',
    contractProvenance: { ...contract.provenance }, verificationScope: 'CALLER_SUPPLIED_CONTRACT_NOT_MODEL_ACCEPTANCE',
    quote: { ...quote }, contract: { ...contract, rebate: { ...contract.rebate }, labelMapping: contract.labelMapping ? { ...contract.labelMapping } : null },
    period: contract.period, mechanic: contract.type, ruleVersion: engine.ruleVersion, lineLegs: engine.legs,
    retainedMass: grid.retainedMass, tailMass: grid.tailMass, declaredTailMass: grid.declaredTailMass,
    numericalMassError: grid.numericalMassError,
    normalization: 'UNCONDITIONAL_RETAINED_MASS_NOT_RENORMALIZED', probabilityTolerance: EPS,
    probabilities, partialOutcomes: [...partial.values()],
    probabilityBounds: Object.fromEntries(OUTCOMES.map(key => [key, {
      lower: probabilities[key], upper: Math.min(1, probabilities[key] + grid.tailMass),
    }])),
    retainedEV: { gross, rebate, net },
    grossEV: grid.tailMass === 0 ? gross : null, netEV: grid.tailMass === 0 ? net : null,
    evBounds: { gross: bound(gross, 'gross'), rebate: bound(rebate, 'rebate'), net: bound(net, 'net') },
    tailUncertainty: { mass: grid.tailMass, payoffRanges: ranges,
      maxAbsoluteNetContribution: grid.tailMass * Math.max(Math.abs(ranges.net.min), Math.abs(ranges.net.max)),
      interpretation: 'OMITTED_SCORE_MASS_ONLY_NOT_MODEL_CONFIDENCE_INTERVAL' }, rows,
  };
}
