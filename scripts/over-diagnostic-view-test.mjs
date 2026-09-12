import assert from 'node:assert/strict';
import { csvText, diagnosticView, numberText } from '../lib/over-diagnostic-view.js';

const source = { games: [{ gameId: 17, gameDate: '2026-07-11', away: 'A', home: 'B', cohort: 'original', selected: false, baselineRuns: 4.5, baselineDataVersion: 'league-hash-abc', W: 0.1, R: -0.02, score: 6.7, net: 0,
  offense: { away: { finalFactor: 0.9 }, home: { finalFactor: 1.1 } },
  pitching: { away: { starterFactor: 0.8, scheduledBullpenOuts: 0, terminatedExpectedOuts: null }, home: { starterFactor: 1.2, scheduledBullpenOuts: 12, terminatedExpectedOuts: null } },
  scheduledAwayMean: 3.2, scheduledHomeMean: 4.1, terminatedAwayMean: 3.1, terminatedHomeMean: 3.9,
}], funnel: { stages: [{ label: 'VALID_COMPUTABLE', n: 1, nEvaluated: 0, nMissingOutcome: 1, bias: null, meanNet: null }], transitions: [{ interpretation: 'SAME_MEMBERS', biasDifference: 0, ci: { low: 0, high: 0 } }] } };
const frozen = JSON.stringify(source);
const view = diagnosticView(source);
assert.equal(JSON.stringify(source), frozen, 'display transform may not mutate frozen input');
assert.equal(view.calculationChain.length, 2);
assert.equal(view.calculationChain[0].starterMultiplier, 1.2, 'away offense faces home pitching');
assert.equal(view.calculationChain[1].starterMultiplier, 0.8, 'home offense faces away pitching');
assert.equal(view.calculationChain[0].baselineDataVersion, 'league-hash-abc');
assert.equal(view.calculationChain[0].net, 0, 'zero return is not missing');
assert.equal(view.pitchingAllocation[0].bullpenExpectedOuts, 0);
assert.equal(view.pitchingAllocation[0].terminatedExpectedOuts, null, 'no terminal outs inferred from score');
assert.equal(view.funnel.stages[0].evaluatedN, 0);
assert.equal(view.funnel.stages[0].missingOutcomeN, 1);
assert.equal(view.funnel.stages[0].bias, null);
assert.equal(numberText(null), '未提供');
assert.equal(numberText(0), '0.000');
const csv = csvText([{ pick: '=HYPERLINK("bad")', net: -0.985, unknown: null, chinese: '大9+22.5' }]);
assert(csv.includes("'=HYPERLINK"), 'untrusted strings cannot become spreadsheet formulas');
assert(csv.includes('"-0.985"'), 'numeric losses must remain numeric');
assert(csv.includes('""'), 'missing values are exported empty');
assert(csv.includes('大9+22.5'));
console.log('Diagnostic view PASS: opposing-team identity, immutable inputs, null/zero, missing-outcome denominator and safe CSV.');
