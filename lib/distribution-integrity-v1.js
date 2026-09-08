// Period-scoped PMF evidence. Existing stricter payoff tolerances remain intact.
export const DISTRIBUTION_MASS_TOLERANCE = 1e-9;
export function auditScoreCells(cells, { period, allowTie = false } = {}) {
  const errors = []; let mass = 0; let tie = 0;
  const margins = { awayWin: 0, homeBy1: 0, homeBy2: 0, homeBy3Plus: 0 };
  const seen = new Set();
  if (!Array.isArray(cells) || !cells.length) errors.push('EMPTY_DISTRIBUTION');
  for (const cell of cells || []) {
    const { awayRuns: a, homeRuns: h, probability: p } = cell;
    if (!Number.isInteger(a) || !Number.isInteger(h) || a < 0 || h < 0) errors.push('INVALID_SCORE');
    if (!Number.isFinite(p) || p < 0 || p > 1) { errors.push('INVALID_PROBABILITY'); continue; }
    const key = `${a}:${h}`; if (seen.has(key)) errors.push('DUPLICATE_SCORE_CELL'); seen.add(key);
    mass += p;
    if (a === h) tie += p;
    else if (a > h) margins.awayWin += p;
    else if (h - a === 1) margins.homeBy1 += p;
    else if (h - a === 2) margins.homeBy2 += p;
    else margins.homeBy3Plus += p;
  }
  if (Math.abs(mass - 1) > DISTRIBUTION_MASS_TOLERANCE) errors.push('INVALID_PROBABILITY_MASS');
  if (!allowTie && tie > DISTRIBUTION_MASS_TOLERANCE) errors.push('UNRESOLVED_TERMINAL_TIE');
  return { scope: 'PERIOD', period, passed: errors.length === 0, errors: [...new Set(errors)], mass, tie, margins,
    tolerance: DISTRIBUTION_MASS_TOLERANCE, pathLegality: 'NOT_PROVEN_BY_TERMINAL_CELLS_ALONE' };
}
export function auditScenarioDistributions(scenarios, resolve, { allowFullTie = false } = {}) {
  const result = { version: 'SCOPED-DISTRIBUTION-QA-v1', matchErrors: [], periods: {} };
  const weights = (scenarios || []).map(s => s.weight);
  if (!weights.length || weights.some(w => !Number.isFinite(w) || w < 0) || Math.abs(weights.reduce((a,b)=>a+b,0)-1) > DISTRIBUTION_MASS_TOLERANCE) result.matchErrors.push('INVALID_SCENARIO_WEIGHTS');
  for (const first5 of [true, false]) {
    const period = first5 ? 'FIRST5' : 'FULL';
    const rows = (scenarios || []).map((s,index) => ({ index, weight: s.weight, ...auditScoreCells(resolve(s,first5).cells, { period, allowTie: first5 || allowFullTie }) }));
    result.periods[period] = { passed: !result.matchErrors.length && rows.length > 0 && rows.every(r=>r.passed),
      errors: [...new Set([...result.matchErrors,...rows.flatMap(r=>r.errors)])],
      mass: rows.reduce((sum,r)=>sum+r.weight*r.mass,0), tie: rows.reduce((sum,r)=>sum+r.weight*r.tie,0),
      margins: Object.fromEntries(['awayWin','homeBy1','homeBy2','homeBy3Plus'].map(k=>[k,rows.reduce((sum,r)=>sum+r.weight*r.margins[k],0)])),
      scenarioFailures: rows.filter(r=>!r.passed), tolerance: DISTRIBUTION_MASS_TOLERANCE };
  }
  return result;
}
