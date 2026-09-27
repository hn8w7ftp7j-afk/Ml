import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'next/dist/build/swc/index.js';
import * as display from '../lib/probability-display.js';
import { calculateProfit, outcomeSettlementForScore } from '../lib/markets.js';

const events = [[2, 0], [1, 0]].map(([away, home]) => ({
  modelEventProbability: .5,
  calculation: calculateProfit({ stake: 1, water: .94, rebateRate: .015, settlement: outcomeSettlementForScore('客隊讓1-10', away, home, '客隊', '主隊') }),
}));
const row = {
  modelProbability: .5 / .55, equivalentWinProbability: .5, equivalentLossProbability: .05, equivalentPushProbability: .45,
  fullWinProbability: .5, partialLossProbability: .5, fullLossProbability: 0, partialWinProbability: 0, pushProbability: 0, mixedNeutralProbability: 0,
  settlementEvents: events, modelEV: events.reduce((sum, event) => sum + event.modelEventProbability * event.calculation.profit, 0),
};
const before = JSON.stringify(row);
assert.equal(display.probabilityPercent(row.modelProbability), '90.9%');
assert.deepEqual(display.netProfitProbabilities(row), { available: true, reason: null, profit: .5, loss: .5, flat: 0 });
assert.equal(display.profitProbabilityText(row), '50.0%');
assert.equal(JSON.stringify(row), before, 'display cannot mutate saved evidence');
for (const leagueId of ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'NHL']) assert.equal(display.profitProbabilityText({ ...row, leagueId }), '50.0%');

const synthetic = entries => ({ settlementEvents: entries.map(([p, profit]) => ({ modelEventProbability: p, calculation: { profit } })), modelEV: entries.reduce((s, [p, profit]) => s + p * profit, 0) });
assert.deepEqual(display.netProfitProbabilities(synthetic([[.2, .015], [.3, 0], [.5, -.5]])), { available: true, reason: null, profit: .2, flat: .3, loss: .5 });
assert.equal(display.netProfitProbabilities(synthetic([[1, 1e-14]])).profit, 1, 'small positive net payoffs must not be rounded into pushes');
assert.equal(display.netProfitProbabilities(synthetic([[1, 0]])).flat, 1);
for (const bad of [null, {}, { modelProbability: .99 }, { ...row, settlementEvents: [] }, { ...row, modelEV: 2 }, synthetic([[.5, 1]]), synthetic([[1.1, 1], [-.1, -1]]), synthetic([[1, NaN]]), { ...row, settlementEvents: [{ modelEventProbability: '1', calculation: { profit: 1 } }] }]) {
  assert.equal(display.netProfitProbabilities(bad).available, false);
  assert.match(display.profitProbabilityText(bad), /無法計算/);
}
for (const value of [null, undefined, '', NaN, Infinity, -1, 1.1]) assert.equal(display.probabilityPercent(value), '—');

// Render the actual shared JSX, not a hand-built replica, and inspect closed details.
const source = fs.readFileSync('app/probability-details.js', 'utf8');
const compiled = transformSync(source, { filename: 'probability-details.js', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'automatic' } } }, module: { type: 'commonjs' } }).code;
const module = { exports: {} };
const require = createRequire(import.meta.url);
new Function('module', 'exports', 'require', compiled)(module, module.exports, name => name.endsWith('/probability-display.js') ? display : require(name));
export const ProbabilityDetailsForTest = module.exports.default;
const html = renderToStaticMarkup(React.createElement(module.exports.default, { row }));
assert.match(html, /淨獲利 50.0%/);
assert.match(html, /90.9%/);
assert.match(html, /不是獲利機率/);
assert.match(html, /不是保證報酬或統計信賴下限/);
assert.doesNotMatch(html, /<details[^>]*open/);
const legacy = renderToStaticMarkup(React.createElement(module.exports.default, { row: {} }));
assert.match(legacy, /無法計算/);
const page = fs.readFileSync('app/page.js', 'utf8');
for (const target of ['entry.row', 'row']) {
  assert.ok(page.includes(`profitProbabilityText(${target})`));
  assert.ok(page.includes(`<ProbabilityDetails row={${target}}/>`));
}
assert.doesNotMatch(page, /狀態模型等效條件勝率/);
console.log('probability-display: event profit vs equivalent ratio, invalid/legacy evidence, nonmutation and rendered details PASS');
