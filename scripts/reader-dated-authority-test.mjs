import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parseTai888Capture, canonicalReaderPayload, readerMarketProperties, nhlReaderEvidencePayload } from '../reader/parser.js';
import { assessBoardCandidate, selectAuthoritativeBoard, selectAuthoritativeDatedBoards, readerPayloadsByDate, shouldSkipSuccessfulPayload } from '../reader/board-selector.js';
import { normalizeNbaReaderPayload } from '../lib/nba/reader.js';
import { readerSaveReceiptFixture } from './reader-save-receipt-fixture.mjs';

// Synthetic original boards only: this regression does not assert live PC or
// bookmaker coverage. It exercises the shipped parser, selector and worker.
const now = Date.parse('2026-10-09T07:44:00Z'), at = new Date(now).toISOString();
const version = JSON.parse(fs.readFileSync('reader/manifest.json')).version;
const source = fs.readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, '');
const teams = { MLB: ['NYY-洋基', 'BOS-紅襪[主]'], NPB: ['SOF-軟銀鷹', 'NIP-日本火腿[主]'],
  KBO: ['LOG-樂天巨人', 'DOO-斗山熊[主]'], CPBL: ['CTB-中信兄弟', 'UNI-統一獅[主]'], NBA: ['HOU-火箭', 'DAL-獨行俠[主]'] };
const cell = pair => ({ pair, lines: pair });
function board(league, dates, { water = '0.950', locked = false, host = 'tai888.in' } = {}) {
  const quote = pair => cell(locked ? ['-', '-'] : pair);
  return { league, sourceHost: host, pageUrl: `https://${host}/newapp/`, observedAt: at,
    tables: [{ headers: ['時間', '主客隊伍', '全場讓分', '全場大小', '獨贏', '一輸二贏', '上半場讓分', '上半場大小'],
      rows: dates.map(date => ({ cells: [cell([date, '20:05']), cell(teams[league]),
        quote([`2平 ${water}`, '0.950']), quote([`${league === 'NBA' ? '225+50' : '7+50'} 大 0.940`, '小 0.940']),
        cell([]), cell([]), quote(['1平 0.930', '0.930']), quote([`${league === 'NBA' ? '115.5' : '3.5'} 大 0.920`, '小 0.920'])] })) }],
    diagnostics: { gameCount: dates.length, expectedGameCount: dates.length, lastMutationAt: at } };
}
function candidate(capture, tabId = 1, frameId = 0) {
  return { capture, parsed: parseTai888Capture(capture, new Date(now)), tabId, frameId, active: tabId === 1, lastAccessed: tabId };
}
const selectCandidates = (candidates, league) => league === 'NBA'
  ? selectAuthoritativeBoard(candidates, { league, now })
  : selectAuthoritativeDatedBoards(candidates, { league, now });
const select = (captures, league) => selectCandidates(captures.map((b, i) => candidate(b, i + 1)), league);
const winningDates = row => row.boardDates || [row.boardDate];
for (const league of Object.keys(teams)) {
  const today = board(league, ['10-09']), tomorrow = board(league, ['10-10']);
  const unchanged = JSON.stringify([today, tomorrow]);
  assert.equal(assessBoardCandidate(candidate(today), now).ok, true, league);
  assert.equal(selectAuthoritativeBoard([candidate(today), candidate(tomorrow, 2)], { league, now }).ok, league === 'NBA', 'preserve incoming NBA default date authority; other legacy generic calls retain their old behavior');
  const result = select([today, tomorrow], league);
  assert.equal(result.ok, true, league);
  assert.deepEqual(result.selections.map(winningDates), [['2026-10-09'], ['2026-10-10']]);
  assert.equal(JSON.stringify([today, tomorrow]), unchanged, 'date authority leaves original captures unchanged');
  assert.equal(select([today, structuredClone(today)], league).selections.length, 1, 'same-date equal quotes still deduplicate');
  const identityDisagreement = board(league, ['10-09']);
  identityDisagreement.tables[0].rows[0].cells[1] = cell([teams[league][1].replace('[主]', ''), `${teams[league][0]}[主]`]);
  for (const conflicting of [board(league, ['10-09'], { water: '0.960' }), board(league, ['10-09'], { locked: true }), identityDisagreement]) {
    const bad = select([today, tomorrow, conflicting], league);
    assert.equal(bad.ok, false, `${league}: independent date never rescues same-date price or lock disagreement`);
    assert.equal(bad.boardDate, '2026-10-09'); assert.equal(bad.selections.length, 0);
  }
  const invalid = candidate(structuredClone(today)); invalid.parsed.parseIssues = ['conflicting-captured-row'];
  assert.equal(selectCandidates([invalid, candidate(tomorrow, 2)], league).ok, false, 'full-source explicit parser conflicts block the whole league');
}
assert.equal(selectAuthoritativeDatedBoards([], { league: 'EPL', now }).ok, false, 'football uses its separate period-aware authority');
const multi = board('NBA', ['10-09', '10-10'], { host: 'www.tai888.in' });
const activeTomorrow = board('NBA', ['10-10']);
const result = select([activeTomorrow, multi], 'NBA');
assert.equal(result.ok, true);
assert.deepEqual(result.selections.map(row => [row.selected.candidate.tabId, winningDates(row)]), [[2, ['2026-10-09']], [1, ['2026-10-10']]]);
const brokenMulti = candidate(structuredClone(multi)); brokenMulti.parsed.games[1].boardTime = 'bad-time';
const fullValidation = selectCandidates([brokenMulti], 'NBA');
assert.equal(fullValidation.ok, false, 'an invalid row on another date cannot be hidden by date projection');
const changedTomorrow = structuredClone(multi); changedTomorrow.tables[0].rows[1].cells[3].pair[0] = '226平 大 0.940';
assert.equal(select([activeTomorrow, changedTomorrow], 'NBA').ok, false, 'partially overlapping multi-date original detects conflicting date');
const sameTab = selectAuthoritativeDatedBoards([candidate(board('MLB', ['10-09']), 1, 0), candidate(board('MLB', ['10-10']), 1, 2)], { league: 'MLB', now });
assert.equal(sameTab.ok, true, 'different dated frames in the same tab remain independent');

class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
async function workerFlow(captures) {
  const event = { addListener() {} }, state = { deviceId: 'reader-dates-fixture', readerToken: 'synthetic-token' }, uploads = [];
  const chrome = { runtime: { onInstalled: event, onStartup: event, onMessage: event }, alarms: { onAlarm: event },
    tabs: { onUpdated: event, query: async () => captures.map((_, i) => ({ id: i + 1, active: i === 0, lastAccessed: i })),
      sendMessage: async id => ({ ok: true, capture: { readerVersion: version, captures: [captures[id - 1]] } }) },
    webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
    storage: { local: { get: async () => structuredClone(state), set: async value => Object.assign(state, structuredClone(value)), remove: async () => {} } } };
  const worker = vm.createContext({ chrome, Date: Clock, URL, setTimeout, clearTimeout, queueMicrotask, TextEncoder, AbortController, crypto: webcrypto,
    parseTai888Capture, canonicalReaderPayload, readerMarketProperties, nhlReaderEvidencePayload,
    selectAuthoritativeBoard, readerPayloadsByDate, shouldSkipSuccessfulPayload,
    fetch: async (url, options) => {
      const p = JSON.parse(options.body); uploads.push(p);
      assert.equal(p.observedAt, at, 'preserve original observed time');
      assert.ok(p.games.every(game => game.boardDate === p.boardDate));
      if (p.league === 'NBA') {
        assert.equal(url, 'https://mlb-positive-ev.vercel.app/api/nba/reader');
        normalizeNbaReaderPayload(p, { now, deviceId: state.deviceId, headerVersion: version });
      } else assert.equal(url, 'https://mlb-positive-ev.vercel.app/api/reader/ingest');
      return { ok: true, status: 200, text: async () => JSON.stringify(readerSaveReceiptFixture(p)) };
    } });
  vm.runInContext(source, worker); const run = reason => vm.runInContext(`performSync('${reason}')`, worker);
  return { first: await run('manual'), state, uploads, run };
}
for (const league of Object.keys(teams)) {
  const flow = await workerFlow([board(league, ['10-09']), board(league, ['10-10'])]);
  assert.equal(flow.first.ok, true, league);
  assert.deepEqual(flow.uploads.map(row => [row.league, row.boardDate]), [[league, '2026-10-09'], [league, '2026-10-10']]);
  assert.equal(flow.state.readerStatuses[league].dateStatuses.length, 2);
  assert.ok(flow.state.readerStatuses[league].dateStatuses.every(row => row.saveReceipt.status === 'CONFIRMED'));
  flow.uploads.length = 0; await flow.run('alarm');
  assert.equal(flow.uploads.length, 0, `${league}: unchanged acknowledged dates retain independent heartbeat throttles`);
}
const scopeFlow = await workerFlow([activeTomorrow, multi]);
assert.deepEqual(scopeFlow.uploads.map(row => [row.boardDate, row.sourceHost]), [['2026-10-09', 'www.tai888.in'], ['2026-10-10', 'tai888.in']], 'a multi-date original cannot upload a date won by another source');
scopeFlow.uploads.length = 0; await scopeFlow.run('alarm');
assert.equal(scopeFlow.uploads.length, 0, 'each dated acknowledged receipt preserves heartbeat throttle');
const conflictFlow = await workerFlow([board('NBA', ['10-09']), board('NBA', ['10-10']), board('NBA', ['10-09'], { water: '0.960' })]);
assert.equal(conflictFlow.first.ok, false); assert.equal(conflictFlow.uploads.length, 0, 'conflict rejects every date before any POST');
console.log('PASS dated authority across MLB/NPB/KBO/CPBL/NBA: full original validation, cross-date/frame preservation, same-date price/lock conflict rejection, actual worker dated uploads, selected source allow-list, NBA independent normalization and receipt heartbeat; live PC NOT VERIFIED');
