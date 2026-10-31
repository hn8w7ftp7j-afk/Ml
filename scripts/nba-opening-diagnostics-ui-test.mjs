import {nbaMarketDisplayState} from '../lib/nba/market-display-state.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { NBA_TEAM_LABELS } from '../lib/nba/labels.js';
import { analyzeNbaOpening } from '../lib/nba/opening-model.js';
import { nbaResultQuoteCurrent } from '../lib/nba/analysis-job-display.js';
import { nbaMarketScore } from '../lib/nba/market-score.js';

// Execute the actual shipped JSX, including its diagnostic formatter, without
// substituting a test-only component or changing the score/quote contracts.
const source = fs.readFileSync('app/nba/main-workspace.js', 'utf8');
const helpers = source.slice(source.indexOf('const name ='), source.indexOf('const store ='));
const card = source.slice(source.indexOf('export function NbaGameCard'), source.indexOf('export default function')).replace('export function', 'function');
const { code } = await transform(helpers + card + '\nglobalThis.Card=NbaGameCard;globalThis.Validation=NbaMarketValidation;globalThis.view=openingValidationView;', {
  filename: 'nba-opening-diagnostics-card.jsx',
  jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } },
  module: { type: 'commonjs' },
});
const scope = { nbaMarketDisplayState, React, NBA_TEAM_LABELS, nbaResultQuoteCurrent, nbaMarketScore,
  NbaBetRecordButton: () => React.createElement('button', null, '紀錄實際下注') };
vm.createContext(scope);
vm.runInContext(code, scope);

const date = '2026-10-21', now = Date.parse('2026-10-20T22:00:00Z'), observedAt = new Date(now).toISOString();
const team = (id, abbreviation) => ({ id: `nba:espn:team:${id}`, sourceId: String(id), abbreviation, league: 'NBA' });
const game = { league: 'NBA', id: 'nba:espn:game:401999001', sourceId: '401999001', gamePk: 401999001, taipeiDate: date,
  season: { year: 2027, type: 'regular' }, seasonType: 'regular', home: team(19, 'ORL'), away: team(1, 'ATL'),
  neutralSite: false, startTime: '2026-10-20T23:00:00Z', status: 'scheduled', completed: false, timeConfirmed: true };
const quotes = { fullTotal: { line: '235.5', overWater: .94, underWater: .94 },
  fullRunline: { line: '3-50', lineSide: 'home', homeWater: .95, awayWater: .95 } };
const resultFor = quote => ({ ...analyzeNbaOpening(game, quote), league: 'NBA', gameId: game.id, date, observedAt });
const rowFor = (result, quote = quotes) => ({ game, quote, result, canAnalyze: true, observedAt, jobState: result?.status });
const render = row => renderToStaticMarkup(React.createElement(scope.Card, { row, now, busy: false, onAnalyze: () => {} }));
const marketBlock = (markup, label, nextLabel) => markup.split(`<h3>${label}｜`)[1]?.split(`<h3>${nextLabel}｜`)[0] || '';

const result = resultFor(quotes);
assert.equal(result.status, 'ready');
assert.equal(result.marketAnalyses.fullTotal.status, 'insufficient');
assert.equal(result.marketAnalyses.fullRunline.status, 'ready');
const markup = render(rowFor(result));
assert.match(markup, /部分市場已分析/);
assert.match(markup, /全場讓分已產生估計/);
assert.match(markup, /全場大小待驗證，暫不計分/);
assert.doesNotMatch(markup, /0／50|undefined|NaN|Infinity/);
const total = marketBlock(markup, '全場大小', '全場讓分');
assert.match(total, /^235\.5/);
assert.match(total, /開季平均誤差（MAE）、機率誤差（Brier）、機率誤差（Log Loss）未通過/);
assert.equal((total.match(/<small>S 分數<\/small>—/g) || []).length, 2, 'both total sides retain blank scores');
assert.doesNotMatch(total, /估計勝率|估計明細|>W /, 'failed total market cannot acquire estimates or W/R/S');
assert.match(total, /驗證 1230 場，開季 145 場；機率驗證 1230 場/);
assert.match(total, /15\.57<\/td><td>14\.71/, 'early MAE model and baseline are shown in that order');
assert.match(total, /0\.25495<\/td><td>0\.25005/, 'Brier model and baseline remain distinct');
assert.match(total, /0\.70327<\/td><td>0\.69325/, 'Log Loss model and baseline remain distinct');
assert.match(total, /全季平均誤差（MAE）<\/th><td>15\.23<\/td><td>15\.33<\/td><td[^>]*>通過/, 'do not claim every metric failed');
assert.doesNotMatch(total.split('<details')[0], /市場驗證狀態/, 'acceptance flag is not a fourth statistical failure');
const margin = marketBlock(markup, '全場讓分', '上半大小');
for (const estimate of Object.values(result.marketAnalyses.fullRunline.sides)) {
  assert.ok(nbaMarketScore(estimate), 'existing accepted market scoring is unchanged');
  assert.ok(margin.includes(nbaMarketScore(estimate).score.toFixed(1)));
  assert.ok(margin.includes(`W ${estimate.expectedNet.toFixed(2)}%`));
}
assert.equal((markup.match(/歷史驗證數據/g) || []).length, 1, 'unopened halftime markets do not inherit validation failures');

// Diagnostics are collapsed by default and have table semantics and a bounded
// horizontal scroll surface, rather than overflowing a narrow phone card.
assert.match(total, /<details class="rankingDetails"><summary>未通過原因與驗證數據<\/summary>/);
assert.doesNotMatch(total, /<details[^>]*\bopen(?:[=> ]|$)/);
assert.match(total, /max-width:100%;overflow-x:auto/);
assert.match(total, /<table style="min-width:380px;width:100%" aria-label="全場大小歷史驗證數據">/);
assert.match(total, /<th scope="col">模型／現況<\/th>/);
assert.match(total, /<th scope="row">開季平均誤差（MAE）<\/th>/);
assert.match(total, /場數須達基準；誤差不得高於基準/);

// A totals-only rejection is a validation failure, not a nonexistent 0/50
// same-season training shortage. Keep the original quote and rows visible.
const totalQuotes = { fullTotal: quotes.fullTotal };
const totalsOnly = resultFor(totalQuotes);
assert.equal(totalsOnly.status, 'insufficient');
const rejected = render(rowFor(totalsOnly, totalQuotes));
assert.match(rejected, /市場驗證未通過/);
assert.match(rejected, /開季市場驗證未通過｜原盤口已保留/);
assert.match(rejected, /全場大小｜235\.5/);
assert.doesNotMatch(rejected, /0／50|筆同季樣本|估計勝率|>W /);

// Missing metrics stay unknown. Neither nulls nor malformed/scoped foreign
// diagnostics may turn into zeros or another market's purported failures.
const diagnostic = structuredClone(result.marketAnalyses.fullTotal.validationDiagnostics);
const missing = structuredClone(diagnostic);
missing.samples = null;
missing.earlySamples = null;
missing.probabilitySamples = null;
missing.checks.find(check => check.id === 'modelBrier').actual = null;
const missingMarkup = renderToStaticMarkup(React.createElement(scope.Validation, { diagnostics: missing, market: 'fullTotal' }));
assert.match(missingMarkup, /驗證 未提供 場，開季 未提供 場；機率驗證 未提供 場/);
assert.match(missingMarkup, /機率誤差（Brier）<\/th><td>未提供<\/td>/);
assert.doesNotMatch(missingMarkup, /NaN|undefined|Infinity|驗證 0 場/);
for (const change of [{ league: 'MLB' }, { market: 'firstHalfTotal' }, { variable: 'halfTotal' },
  { version: 'unrecognized' }, { modelVersion: 'other-model' }, { checks: [] }]) {
  assert.equal(scope.view({ ...diagnostic, ...change }, 'fullTotal'), null);
}
const duplicate = structuredClone(diagnostic);
duplicate.checks.push(duplicate.checks[0]);
assert.equal(scope.view(duplicate, 'fullTotal'), null);
assert.equal(renderToStaticMarkup(React.createElement(scope.Validation, { diagnostics: result.marketAnalyses.fullRunline.validationDiagnostics, market: 'fullRunline' })), '');
const noDiagnostic = structuredClone(totalsOnly);
delete noDiagnostic.marketAnalyses.fullTotal.validationDiagnostics;
const fallback = render(rowFor(noDiagnostic, totalQuotes));
assert.match(fallback, /此開季市場尚未通過歷史驗證/);
assert.doesNotMatch(fallback, /歷史驗證數據|0\.25495/);
const blocked = resultFor({ fullTotal: { ...quotes.fullTotal, line: 'invalid' } });
const blockedMarkup = render(rowFor(blocked, { fullTotal: { ...quotes.fullTotal, line: 'invalid' } }));
assert.match(blockedMarkup, /盤口格式、讓分方或雙邊水位未核對/);
assert.doesNotMatch(blockedMarkup, /未通過原因與驗證數據/, 'a blocked quote keeps its own cause');
assert.doesNotMatch(blockedMarkup, /市場驗證未通過/, 'a format-blocked quote is not described as a failed validation');
const unopened = render(rowFor(resultFor({}), {}));
assert.match(unopened, /尚無可分析市場/);
assert.doesNotMatch(unopened, /市場驗證未通過|未通過原因與驗證數據|待驗證，暫不計分/, 'no quote does not mean a failed validation');
const unanalysed = render({ ...rowFor(null), jobState: undefined });
assert.match(unanalysed, /待補分析/);
assert.doesNotMatch(unanalysed, /部分市場已分析/);
assert.doesNotMatch(unanalysed, /歷史驗證數據|開季平均誤差|0\.25495/);

// A newly received total must not inherit the successful spread job status.
const oldMissing = structuredClone(result);
oldMissing.generatedAt = '2026-10-20T21:45:00Z';
oldMissing.quotes.fullTotal = null;
oldMissing.marketAnalyses.fullTotal = {status:'unavailable',reason:'此盤口尚未開盤'};
const recoveredQuote = render(rowFor(oldMissing));
const pendingTotal = marketBlock(recoveredQuote, '全場大小', '全場讓分');
assert.match(pendingTotal, /此市場已有盤口，但尚無對應分析/);
assert.match(pendingTotal, /待補分析/);
assert.doesNotMatch(pendingTotal, /已分析|此盤口尚未開盤|估計勝率|>W /);
assert.match(recoveredQuote, /尚未收到此市場的有效盤口；不代表莊家尚未開盤/);
assert.match(recoveredQuote, /<span class="state unopened">部分市場已分析<\/span>/, 'a ready spread cannot imply that the newly received total was analysed');
assert.match(recoveredQuote, /全場大小待補分析。請按「分析全部 NBA」或本場分析按鈕補齊/);
assert.match(recoveredQuote, /盤口 10\/21\s+06:00｜分析 10\/21\s+05:45/, 'quote observation and analysis generation have separate visible timestamps');
for (const [jobState, label] of [['running', '分析中'], ['queued', '排隊中'], ['failed', '分析失敗'], ['blocked', '核對未通過']]) {
  const ongoing = render({ ...rowFor(oldMissing), jobState });
  assert.match(ongoing, new RegExp(`<span class="state [^"]*">${label}<\\/span>`), 'gap display cannot conceal an active job or its failure');
}

// The screenshot case: stored analysis had no half markets, then Reader sent
// both half contracts. Display the gap while preserving every earlier value.
const halfQuotes = { ...quotes, firstHalfTotal: { line: '123.5', overWater: .93, underWater: .93 },
  firstHalfRunline: { line: '2.5', lineSide: 'away', homeWater: .94, awayWater: .94 } };
const before = JSON.stringify(result);
const halfGap = render(rowFor(result, halfQuotes));
assert.match(halfGap, /<span class="state unopened">部分市場已分析<\/span>/);
assert.match(halfGap, /上半大小、上半讓分待補分析/);
for (const [label, nextLabel] of [['上半大小', '上半讓分'], ['上半讓分', 'unused']]) {
  const block = marketBlock(halfGap, label, nextLabel);
  assert.match(block, /待補分析/);
  assert.doesNotMatch(block, /估計勝率|>W /, 'display must not synthesize estimates for a newly received quote');
}
assert.equal(JSON.stringify(result), before, 'coverage display never mutates stored model estimates');
console.log('PASS NBA diagnostic UI: shipped JSX, actual failed checks and baselines, mixed readiness, totals-only rows, unchanged accepted scores, new-market gaps and distinct observation/analysis times, missing/foreign/unavailable/blocked states and collapsed responsive table semantics');
