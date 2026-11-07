import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { NBA_TEAM_LABELS } from '../lib/nba/labels.js';
import { nbaResultQuoteCurrent, validNbaJob, isNbaOpeningModelVersion } from '../lib/nba/analysis-job-display.js';
import { nbaMarketDisplayState } from '../lib/nba/market-display-state.js';
import { nbaMarketScore } from '../lib/nba/market-score.js';
import { analyzeNbaOpening } from '../lib/nba/opening-model.js';
import { buildNbaShadowRanking, buildNbaPreviousRanking, buildNbaShadowOrder, NBA_RANK_MARKETS } from '../lib/nba/shadow-ranking.js';
import { ALL_LEAGUE_TERMINAL_STATUSES, allLeaguePreflightFailureState } from '../lib/all-league-analysis-v117.js';

const source = fs.readFileSync('app/nba/main-workspace.js', 'utf8');
const compiled = await transform(source.replace(/^import .*;\n/gm, '')
  .replace('export function NbaGameCard', 'function NbaGameCard')
  .replace('export default function NbaMainWorkspace', 'function NbaMainWorkspace')
  + '\nglobalThis.Card=NbaGameCard;globalThis.Main=NbaMainWorkspace;', {
  filename: 'nba-schedule-readonly-shipped.jsx',
  jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } },
  module: { type: 'commonjs' },
});
const date = '2026-10-29', now = Date.parse('2026-10-28T21:20:00Z'), at = new Date(now).toISOString();
const team = (id, abbreviation) => ({ id: `nba:espn:team:${id}`, sourceId: String(id), abbreviation, league: 'NBA' });
const game = { id: 'nba:espn:game:401909881', sourceId: '401909881', league: 'NBA', taipeiDate: date,
  season: { year: 2027, type: 'regular' }, seasonType: 'regular', neutralSite: false,
  startTime: '2026-10-28T23:00:00.000Z', status: 'scheduled', completed: false, timeConfirmed: true,
  away: team(14, 'MIA'), home: team(1, 'ATL') };
const quote = { fullRunline: { line: '2+25', lineSide: 'home', homeWater: .95, awayWater: .95 } };
const result = { ...analyzeNbaOpening(game, quote), league: 'NBA', gameId: game.id, date,
  game, observedAt: at, generatedAt: at, persistence: { persisted: true } };
const row = { game, quote, canAnalyze: true, observedAt: at, pageActivityAt: at, result, jobState: 'ready' };
const original = JSON.stringify(result);
let stateOverrides = {}, stateIndex = 0;
const scope = { React, NBA_TEAM_LABELS, nbaResultQuoteCurrent, nbaMarketDisplayState, nbaMarketScore, validNbaJob,
  taipeiDate: () => date, dynamic: () => () => null,
  useState: initial => { const index = stateIndex++; return [Object.hasOwn(stateOverrides, index)
    ? stateOverrides[index] : typeof initial === 'function' ? initial() : initial, () => {}]; },
  useEffect: () => {}, useMemo: callback => callback(), useRef: initial => ({ current: initial }),
  buildNbaBetReminder: () => ({ candidates: [], quotesCurrent: false, analysisGameCount: 0 }),
  nbaOpeningMarketCoverage: () => ({}),
  NbaBetRecordButton: () => React.createElement('button', { 'data-test': 'record' }, '紀錄實際下注'),
  NbaBetRecordProvider: ({ children }) => React.createElement(React.Fragment, null, children),
  NbaBetRecords: () => null, NbaShadowRanking: () => null, AnalysisNotificationControl: () => null, AllLeagueProgress: () => null,
};
vm.createContext(scope); vm.runInContext(compiled.code, scope);
const card = value => renderToStaticMarkup(React.createElement(scope.Card, { row: value, now, busy: false, onAnalyze: () => {} }));
const freshMarkup = card(row);
assert.match(freshMarkup, /data-test="record"/);
assert.doesNotMatch(freshMarkup, /已保存分析｜賽程待核對/);
assert.match(freshMarkup, /<button class="secondary">重新分析這一場<\/button>/);

// The persisted market owns a quote even when the current board has none.
// Read-only behavior must gate those archived prices, not just row.quote.
for (const flags of [{ readOnly: true }, { scheduleVerified: false }, { readOnly: true, scheduleVerified: false }]) {
  for (const currentQuote of [null, quote]) {
    const markup = card({ ...row, ...flags, quote: currentQuote, canAnalyze: true });
    assert.match(markup, /已保存分析｜賽程待核對/);
    assert.match(markup, /目前賽程與盤口尚未核對/);
    assert.match(markup, /全場讓分｜2\+25/);
    assert.match(markup, /水位 0\.95/);
    assert.doesNotMatch(markup, /data-test="record"|紀錄實際下注/);
    assert.match(markup, /<button class="secondary" disabled="">重新分析這一場<\/button>/);
    assert.doesNotMatch(markup, /state done|請按「分析全部 NBA」|目前 Reader 盤口：等待開盤/);
  }
}
assert.equal(JSON.stringify(result), original, 'retained presentation cannot mutate saved analysis or prices');
assert.match(card({ ...row, canAnalyze: false }), /data-test="record"/,
  'ordinary manually recorded completed bets retain the existing independent ledger flow');

const renderMain = readOnly => {
  stateIndex = 0; stateOverrides = { 0: date, 1: [{ ...row, ...(readOnly ? { readOnly: true, scheduleVerified: false, quote: null } : {}) }],
    7: game.sourceId, 11: now, 12: readOnly ? 'unverified' : 'fresh', 13: readOnly };
  return renderToStaticMarkup(React.createElement(scope.Main, { active: true, otherBusy: false,
    onBusyChange: () => {}, onDateChange: () => {}, onAnalyzeAll: () => {} }));
};
const readonlyMain = renderMain(true), normalMain = renderMain(false);
assert.match(readonlyMain, /<button class="primary giant" disabled="">分析全部 NBA<\/button>/);
assert.match(readonlyMain, /<button class="primary" disabled="">只分析這一場<\/button>/);
assert.match(readonlyMain, /已保存分析｜賽程暫時無法核對/);
assert.doesNotMatch(readonlyMain, /<strong>盤口已同步<\/strong>|data-test="record"/);
assert.match(readonlyMain, /<button class="secondary allLeagueAnalyzeButton">一鍵分析全部聯盟<\/button>/,
  'one unavailable league does not block independent leagues');
assert.match(normalMain, /<button class="primary giant">分析全部 NBA<\/button>/);
assert.match(normalMain, /<button class="primary">只分析這一場<\/button>/);
assert.match(normalMain, /data-test="record"/);

// Execute the actual load boundary. A no-fallback source error must mark a
// currently displayed earlier row read-only; recovery must restore fresh data.
const startLoad = source.indexOf('  async function load(target =');
const endLoad = source.indexOf('\n  useEffect(() => { if (trackBoard', startLoad);
const loadSource = source.slice(startLoad, endLoad);
const state = { rows: [row], readOnly: false, reader: 'fresh', error: '' };
let response = Object.assign(Error('schedule unavailable'), { code: 'NBA_SCHEDULE_UNAVAILABLE' });
const ctx = { requestRevision: { current: 0 }, dateRef: { current: date }, explicitDate: { current: false }, jobRef: { current: null },
  setLoading: () => {}, setError: value => { state.error = value; }, setReadOnlyBoard: value => { state.readOnly = value; },
  setReaderStatus: value => { state.reader = value; }, setReaderCoverage: () => {}, setRows: value => { state.rows = typeof value === 'function' ? value(state.rows) : value; },
  loadNbaUpcomingBoard: async () => { if (response instanceof Error) throw response; return response; },
  api: () => { throw Error('unexpected transport'); }, setDate: () => {}, onDateChange: () => {}, setProgress: () => {}, setSelected: () => {},
};
vm.createContext(ctx); vm.runInContext(loadSource + '\nglobalThis.loadBoard=load;', ctx);
await ctx.loadBoard(date);
assert.equal(state.readOnly, true); assert.equal(state.reader, 'unverified');
assert.equal(state.rows[0].readOnly, true); assert.equal(state.rows[0].scheduleVerified, false);
assert.equal(state.rows[0].quote, null); assert.equal(state.rows[0].result, result);
response = { date, readerStatus: 'unverified', readOnly: true, scheduleStatus: 'unavailable', rows: [{ ...row, readOnly: true, scheduleVerified: false, quote: null }] };
await ctx.loadBoard(date); assert.equal(state.readOnly, true);
response = { date, readerStatus: 'fresh', rows: [{ ...row, result: null }] };
await ctx.loadBoard(date);
assert.equal(state.readOnly, false); assert.equal(state.reader, 'fresh');
assert.equal(state.rows[0].readOnly, undefined); assert.equal(state.rows[0].scheduleVerified, undefined);
assert.equal(state.rows[0].quote, quote); assert.equal(state.rows[0].result, result);

const startAction = source.indexOf('  async function start(id =');
const endAction = source.indexOf('\n  const changeDate =', startAction);
const actionSource = source.slice(startAction, endAction);
for (const flags of [{ readOnly: true }, { scheduleStatus: 'unavailable' }]) {
  const calls = [], action = { operation: { current: false }, busy: false, dateRef: { current: date }, notification: { current: null },
    setStarting: () => {}, setError: () => {}, setProgress: () => {}, setMessage: value => calls.push(value),
    prepareNbaNotification: () => {}, load: async () => ({ ...flags, tasks: [{ nbaQuery: { id: game.sourceId } }] }),
    api: async () => { throw Error('a read-only board must never POST a model job'); },
  };
  vm.createContext(action); vm.runInContext(actionSource + '\nglobalThis.startBoard=start;', action);
  await action.startBoard();
  assert.ok(calls.includes('NBA 賽程暫時無法核對，已保存分析僅供查閱。'));
  assert.equal(action.operation.current, false);
}

// The previous-analysis ranking is a separate action entry point. Render its
// shipped JSX with the actual current/previous ranking builders and quotes.
const rankingSource = fs.readFileSync('app/nba/shadow-ranking.js', 'utf8');
const rankingCompiled = await transform(rankingSource.replace(/^import .*;\n/gm, '')
  .replace('export default function NbaShadowRanking', 'function NbaShadowRanking')
  + '\nglobalThis.Ranking=NbaShadowRanking;', {
  filename: 'nba-schedule-readonly-ranking.jsx',
  jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } },
  module: { type: 'commonjs' },
});
let rankingView = 'ranking';
const rankingScope = { React, NBA_TEAM_LABELS, buildNbaShadowRanking, buildNbaPreviousRanking, buildNbaShadowOrder,
  NBA_RANK_MARKETS, isNbaOpeningModelVersion, NbaBetRecordButton: scope.NbaBetRecordButton,
  useState: initial => [initial === 'ranking' ? rankingView : initial, () => {}],
};
vm.createContext(rankingScope); vm.runInContext(rankingCompiled.code, rankingScope);
const rank = (value, boardReadOnly = false) => renderToStaticMarkup(React.createElement(rankingScope.Ranking,
  { rows: [value], date, now, busy: false, readOnly: boardReadOnly, onAnalyze: () => {} }));
assert.ok(buildNbaShadowRanking([row], date, now).entries.length > 0, 'accepted saved spread must exercise real ranking entries');
assert.match(rank(row), /data-test="record"/);
assert.match(rank(row), /<button class="mini secondary">重新分析<\/button>/);
for (rankingView of ['ranking', 'order']) {
  for (const [value, boardReadOnly] of [
    [{ ...row, readOnly: true }, false], [{ ...row, scheduleVerified: false }, false], [row, true],
  ]) {
    const markup = rank(value, boardReadOnly);
    assert.match(markup, /賽程待核對的賽事僅供查閱已保存分析/);
    assert.match(markup, /0 場分析/);
    assert.doesNotMatch(markup, /data-test="record"|rankActionStack|<button[^>]*>重新分析<\/button>/);
    assert.ok(buildNbaPreviousRanking([{ ...value, readOnly: true }], date, now).entries.length > 0);
  }
}
rankingView = 'ranking';
assert.match(rank({ ...row, readOnly: true }), /已保存分析｜賽程待核對/);
assert.match(rank({ ...row, readOnly: true }), /全場讓分/);
assert.match(rank({ ...row, readOnly: true }), /水位 0\.95/);
assert.equal(JSON.stringify(result), original);

// All-league preflight must finish this league with a source failure, while the
// orchestration's existing per-league catch can continue the healthy leagues.
const page = fs.readFileSync('app/page.js', 'utf8');
const batchStart = page.indexOf('  async function prepareNbaBatch(');
const batchEnd = page.indexOf('\n  async function prepareNhlBatch(', batchStart);
const prepareSource = page.slice(batchStart, batchEnd);
for (const flags of [{ readOnly: true }, { scheduleStatus: 'unavailable' }]) {
  const scopes = [], batchScope = {
    nbaExplicitDateRef: { current: false },
    loadNbaUpcomingBoard: async () => ({ date, ...flags, emptyReason: 'schedule_unavailable', tasks: [] }),
    setNbaDate: value => scopes.push(value), setNbaPreparedScope: value => scopes.push(value),
  };
  vm.createContext(batchScope); vm.runInContext(prepareSource + '\nglobalThis.prepare=prepareNbaBatch;', batchScope);
  let failure;
  try { await batchScope.prepare(date); } catch (cause) { failure = cause; }
  assert.equal(failure?.code, 'NBA_SCHEDULE_UNAVAILABLE');
  const display = allLeaguePreflightFailureState(failure);
  assert.equal(display.status, 'failed');
  assert.ok(ALL_LEAGUE_TERMINAL_STATUSES.includes(display.status), 'source unavailability cannot leave an unknown nonterminal league');
  assert.match(display.message, /已保存分析可查看/);
  assert.equal(scopes.length, 0, 'failed preflight cannot overwrite a valid prepared date scope');
}
const normalScopes = [], normalBatch = {
  nbaExplicitDateRef: { current: false }, loadNbaUpcomingBoard: async () => ({ date, tasks: [{ id: 'actual-task' }], readerStatus: 'fresh', emptyReason: null }),
  setNbaDate: value => normalScopes.push(value), setNbaPreparedScope: value => normalScopes.push(value),
};
vm.createContext(normalBatch); vm.runInContext(prepareSource + '\nglobalThis.prepare=prepareNbaBatch;', normalBatch);
assert.equal((await normalBatch.prepare(date)).tasks[0].id, 'actual-task');
assert.equal(normalScopes.length, 2);
console.log('PASS shipped NBA retained-board, ranking JSX/actions, load/start and all-league preflight: saved quotes stay visible, read-only labels, no manual record/current claim/analysis actions, fresh recovery and league isolation; source failure preserves original analysis and reaches an explicit terminal state.');
