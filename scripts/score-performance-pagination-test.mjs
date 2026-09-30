import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { transform } from 'next/dist/build/swc/index.js';
import * as scorePerformance from '../lib/score-performance.js';
import { BET_PERIODS, hasUnverifiedFirst5Settlement } from '../lib/bet-stats.js';
import { QUALITY_GROUPS, qualityGroupForBet, savedVersionForBet } from '../lib/performance-evidence-v1.js';

// Execute the shipped JSX component and its real filtering/statistics helpers.
// This catches rendering all rows even when an unrelated paginator exists.
const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const source = page.slice(page.indexOf('function ScorePerformanceMetrics('), page.indexOf('function diagnosticVerdict('));
const { code } = await transform(source, {
  filename: 'score-performance.jsx',
  jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } },
});

function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...nodes(value.props?.children)];
}
function label(value) {
  if (Array.isArray(value)) return value.map(label).join('');
  if (value == null || typeof value === 'boolean') return '';
  return typeof value === 'object' ? label(value.props?.children) : String(value);
}
function harness(initialBets) {
  const state = [], effects = [], memos = [];
  let stateIndex = 0, effectIndex = 0, memoIndex = 0, dirty = false, pending = [], tree;
  let bets = initialBets;
  const context = vm.createContext({
    ...scorePerformance, React, QUALITY_GROUPS, qualityGroupForBet, savedVersionForBet,
    BET_PERIODS, hasUnverifiedFirst5Settlement,
    LEAGUE_IDS: ['MLB', 'NPB', 'KBO', 'CPBL'], leagueConfig: id => ({ shortLabel: id }),
    pct: value => value == null ? '—' : String(value), moneyText: String,
    translateTeamText: String, waterText: String, statusText: String, outcomeText: String,
    localTime: String, compactModelMetrics: () => '',
    useMemo: (fn, deps) => {
      const index = memoIndex++;
      if (!memos[index] || deps.some((value, i) => !Object.is(value, memos[index].deps[i]))) {
        memos[index] = { deps: [...deps], value: fn() };
      }
      return memos[index].value;
    },
    useState: initial => {
      const index = stateIndex++;
      if (!(index in state)) state[index] = initial;
      return [state[index], value => {
        const next = typeof value === 'function' ? value(state[index]) : value;
        if (!Object.is(next, state[index])) { state[index] = next; dirty = true; }
      }];
    },
    useEffect: (setup, deps) => {
      const index = effectIndex++;
      if (!effects[index] || deps.some((value, i) => !Object.is(value, effects[index][i]))) {
        effects[index] = [...deps]; pending.push(setup);
      }
    },
  });
  vm.runInContext(code, context);
  const render = () => {
    let repeats = 0;
    do {
      assert.ok(repeats++ < 5, 'filter reset must stabilize');
      stateIndex = 0; effectIndex = 0; memoIndex = 0; pending = []; dirty = false;
      tree = context.ScorePerformanceDashboard({ bets, cloudLedgerStatus: { state: 'ready' } });
      pending.forEach(setup => setup());
    } while (dirty);
    return nodes(tree);
  };
  const rows = () => render().filter(node => node.props?.className === 'betRow scorePerformanceBetRow');
  const nav = () => render().find(node => node.type === 'nav' && node.props?.['aria-label'] === '分數績效明細分頁');
  const change = action => { action(); return render(); };
  return {
    render, rows, nav, change,
    replace: next => { bets = next; return render(); },
    next: () => change(() => nodes(nav()).find(node => node.type === 'button' && label(node) === '下一頁').props.onClick()),
    previous: () => change(() => nodes(nav()).find(node => node.type === 'button' && label(node) === '上一頁').props.onClick()),
    choose: (aria, text) => change(() => {
      const scope = render().find(node => node.props?.['aria-label'] === aria);
      nodes(scope).find(node => node.type === 'button' && label(node).startsWith(text)).props.onClick();
    }),
    select: (aria, value) => change(() => render().find(node => node.type === 'select' && node.props?.['aria-label'] === aria).props.onChange({ target: { value } })),
  };
}

const placedAt = new Date().toISOString();
const bets = Array.from({ length: 1230 }, (_, i) => ({
  id: `pagination-${i}`, league: i % 2 ? 'MLB' : 'NPB', date: placedAt.slice(0, 10), gamePk: i + 1,
  market: i % 3 ? '全場大小' : '上半大小', pick: '大8.5', water: 0.95, stake: 10000,
  placedAt, status: 'SETTLED', scoreStatus: 'SHADOW_DIAGNOSTIC_NOT_FORMAL', formulaDiagnosticScore: 8.8,
  modelVersion: i % 2 ? 'v1' : 'v2', dataVersion: i % 2 ? 'd1' : 'd2',
  settlement: { outcome: 'WIN', winFraction: 1, lossFraction: 0, pushFraction: 0,
    grossWin: 9500, grossLoss: 0, rebate: 150, netProfit: 9650 },
}));
const immutable = JSON.stringify(bets);
const ui = harness(bets);
const summaries = () => ui.render().filter(node => node.props?.className?.startsWith('scoreBucketCard'))
  .flatMap(node => nodes(node).filter(child => child.type?.name === 'ScorePerformanceMetrics').map(child => child.props.summary));
const originalSummaries = JSON.stringify(summaries());
assert.equal(ui.rows().length, 50, 'a 1230-ticket score view must render only one bounded detail page');
assert.equal(ui.rows()[0].key, bets[0].id);
assert.match(label(ui.nav()), /第 1／25 頁/);
assert.equal(nodes(ui.nav()).find(node => label(node) === '上一頁').props.disabled, true);
ui.next();
assert.equal(ui.rows()[0].key, bets[50].id);
assert.equal(JSON.stringify(summaries()), originalSummaries, 'page changes must preserve all-history bucket financial totals');
for (let i = 1; i < 24; i += 1) ui.next();
assert.equal(ui.rows().length, 30);
assert.equal(ui.rows()[0].key, bets[1200].id);
assert.equal(nodes(ui.nav()).find(node => label(node) === '下一頁').props.disabled, true);
ui.previous();
assert.equal(ui.rows()[0].key, bets[1150].id);

for (const changeFilter of [
  () => ui.choose('分數績效期間', '今日'),
  () => ui.choose('分數績效聯盟', 'MLB'),
  () => ui.choose('分數績效市場', '全場大小'),
  () => ui.select('績效模型版本', 'v1'),
  () => ui.select('績效資料版本', 'd1'),
  () => ui.select('績效資料品質', 'UNKNOWN'),
  () => ui.change(() => ui.render().find(node => node.props?.className?.startsWith('scoreBucketCard') && label(node).startsWith('8.6+')).props.onClick()),
]) {
  ui.next();
  changeFilter();
  assert.match(label(ui.nav()), /第 1／\d+ 頁/, 'each real filter handler must reset detail pagination');
  assert.equal(ui.rows().length, 50);
}
ui.next();
const retained = bets.filter(bet => bet.league === 'MLB' && bet.market === '全場大小').slice(0, 75);
ui.replace(retained);
assert.equal(ui.rows().length, 25, 'shrinking a ledger preserves a valid last page');
ui.replace(retained.slice(0, 25));
assert.equal(ui.rows().length, 25);
assert.equal(ui.nav(), undefined, 'one-page and empty scopes need no pagination controls');
ui.replace([]);
assert.equal(ui.rows().length, 0);

// Quarantined no-score evidence remains visible on its explicit read-only
// branch, but never enters the financial score buckets; cancelled rows stay out.
const legacy = bets.slice(0, 160).map((bet, i) => ({ ...bet, id: `legacy-${i}`, scoreStatus: 'LEGACY_INVALID',
  formulaDiagnosticScore: null, status: 'MANUAL_REVIEW', settlement: null,
  performanceEligibility: i < 120 ? 'EXCLUDED_UNVERIFIABLE_LEGACY' : null }));
const legacyUi = harness([...legacy, { ...legacy[0], id: 'cancelled', status: 'CANCELLED' }]);
legacyUi.change(() => legacyUi.render().find(node => node.type === 'button' && label(node).startsWith('無分數資料')).props.onClick());
assert.equal(legacyUi.rows().length, 50);
assert.match(label(legacyUi.nav()), /第 1／4 頁/);
assert.ok(legacyUi.rows().every(row => label(row).includes('未列入已結算績效')));
const report = scorePerformance.buildScorePerformanceReport(legacy);
assert.equal(report.noScore.recordCount, 160);
assert.equal(report.performanceRecordCount, 40);
assert.ok(report.buckets.every(bucket => bucket.summary.bets === 0 && bucket.summary.netPnl === 0));
assert.equal(JSON.stringify(bets), immutable, 'all navigation and filtering must leave immutable tickets unchanged');
console.log('Score performance actual JSX: bounded 1230-ticket rendering, all scope resets, stable totals, live shrink and excluded no-score evidence PASS');
