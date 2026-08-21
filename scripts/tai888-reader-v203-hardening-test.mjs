import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { canonicalReaderPayload, parseTai888Capture } from '../reader/parser.js';
import {
  assessBoardCandidate,
  selectAuthoritativeBoard,
  shouldSkipSuccessfulPayload,
  validateStandardReaderGame,
} from '../reader/board-selector.js';

const normalizerSource = fs.readFileSync(new URL('../reader/row-normalizer.js', import.meta.url), 'utf8');
const normalizerContext = { globalThis: {} };
vm.createContext(normalizerContext);
vm.runInContext(normalizerSource, normalizerContext);
const normalizer = normalizerContext.globalThis.Tai888RowNormalizer;
assert.ok(normalizer?.normalizeRowRecords);

const spans = {
  time: [0, 80], teams: [80, 260], runline: [260, 380], total: [380, 500],
  moneyline: [500, 580], oneLoseTwoWin: [580, 700], first5Runline: [700, 820], first5Total: [820, 940],
};
const labels = ['時間', '主客隊伍', '讓球', '大小盤', '獨贏', '一輸二贏', '上半讓球', '上半大小'];

function cell(text, left, right, top, rows = null) {
  const value = String(text || '');
  return {
    text: value,
    lines: rows ? rows.map(row => row.text) : value ? [value] : [],
    rows: rows || (value ? [{ text: value, top, left }] : []),
    left, right, top, bottom: top + 20,
  };
}

function record(order, top, cells, text = '') {
  return {
    order, top, bottom: top + 20,
    text: text || cells.map(item => item.text).filter(Boolean).join(' '),
    cells: cells.filter(item => item.text),
  };
}

const header = record(0, 0, Object.values(spans).map((span, index) => cell(labels[index], ...span, 0)));
const league = record(1, 25, [cell('聯盟：MLB 美國職棒（1）', 0, 940, 25)]);
assert.equal(normalizer.isStandardLeagueRow('走地中：聯盟 MLB 美國職棒（3）'), false);
assert.equal(normalizer.isStandardLeagueRow('滾球：聯盟 MLB 美國職棒（3）'), false);
assert.equal(normalizer.isStandardLeagueRow('聯盟：MLB 美國職棒（10）'), true);
const duplicateAwayRows = [
  { text: 'BAL-巴爾的摩金鶯 投手[右]', top: 50, left: 80 },
  { text: 'BAL-巴爾的摩金鶯 投手[右]', top: 62, left: 80 },
];
const away = record(2, 50, [
  cell('08-15', ...spans.time, 50),
  cell('BAL-巴爾的摩金鶯 投手[右]', ...spans.teams, 50, duplicateAwayRows),
  cell('0.950', ...spans.runline, 50),
  cell('9+30 大 0.490', ...spans.total, 50),
  cell('0.990', ...spans.moneyline, 50),
  cell('1.5 0.530', ...spans.oneLoseTwoWin, 50),
  cell('0.940', ...spans.first5Runline, 50),
  cell('4+50 大 0.930', ...spans.first5Total, 50),
]);
const home = record(3, 72, [
  cell('01:10', ...spans.time, 72),
  cell('MIN-明尼蘇達雙城［ 主 ］ 投手[右]', ...spans.teams, 72),
  cell('1+95 0.950', ...spans.runline, 72),
  cell('小 1.830', ...spans.total, 72),
  cell('0.760', ...spans.moneyline, 72),
  cell('1.5 1.660', ...spans.oneLoseTwoWin, 72),
  cell('0-20 0.940', ...spans.first5Runline, 72),
  cell('小 0.930', ...spans.first5Total, 72),
]);

const liveLeague = record(1, 25, [cell('走地中：聯盟 MLB 美國職棒（1）', 0, 940, 25)]);
const liveAway = structuredClone(away);
const liveHome = structuredClone(home);
const pregameLeague = structuredClone(league);
const pregameAway = structuredClone(away);
const pregameHome = structuredClone(home);
liveAway.order = 2;
liveHome.order = 3;
pregameLeague.order = 4;
pregameAway.order = 5;
pregameHome.order = 6;
const liveAndPregame = normalizer.normalizeRowRecords(
  [header, liveLeague, liveAway, liveHome, pregameLeague, pregameAway, pregameHome],
  { documentLooksStandardMlb: true },
);
assert.equal(liveAndPregame.diagnostics.expectedGameCount, 1);
assert.equal(liveAndPregame.diagnostics.gameCount, 1, 'in-play MLB section must not be merged into the pre-game board');

const normalized = normalizer.normalizeRowRecords([header, league, away, home], { documentLooksStandardMlb: true });
assert.equal(normalized.diagnostics.expectedGameCount, 1);
assert.equal(normalized.diagnostics.gameCount, 1, 'wrapped duplicate team text must be deduplicated');

const capture = {
  sourceHost: 'www1.tai888.in',
  pageUrl: 'https://www1.tai888.in/newapp/#/BS',
  pageTitle: '泰8',
  observedAt: '2026-08-14T17:00:00.000Z',
  tables: normalized.tables,
  diagnostics: {
    ...normalized.diagnostics,
    lastMutationAt: '2026-08-14T16:59:59.000Z',
  },
};
const parsed = parseTai888Capture(capture, new Date('2026-08-14T17:00:00.000Z'));
assert.equal(parsed.games.length, 1);
assert.equal(parsed.games[0].awayCode, 'BAL');
assert.equal(parsed.games[0].homeCode, 'MIN');
assert.equal(parsed.games[0].fullRunline.lineSide, 'home');
assert.equal(parsed.games[0].fullTotal.line, '9+30');
assert.equal(parsed.games[0].fullTotal.overWater, 0.49);
assert.equal(parsed.games[0].fullTotal.underWater, 1.83);
assert.equal(validateStandardReaderGame(parsed.games[0]).directionCount, 8);
assert.equal(validateStandardReaderGame(parsed.games[0]).ok, true);

// Tai888 can keep a hidden responsive/other-league measurement copy before
// the visible MLB odds row. DOM order must never let that identity-only copy
// turn a genuinely open game into a locked game.
const identityOnlyRow = structuredClone(normalized.tables[0].rows[0]);
for (const index of [2, 3, 6, 7]) identityOnlyRow.cells[index].pair = ['', ''];
const visibleAfterHidden = parseTai888Capture({
  ...capture,
  tables: [{
    headers: normalized.tables[0].headers,
    rows: [identityOnlyRow, normalized.tables[0].rows[0]],
  }],
}, new Date('2026-08-14T17:00:00Z'));
assert.equal(visibleAfterHidden.games.length, 1);
assert.equal(visibleAfterHidden.games[0].marketStatus, 'open', 'visible odds must outrank an earlier hidden identity-only duplicate');
assert.equal(validateStandardReaderGame(visibleAfterHidden.games[0]).directionCount, 8);
assert.deepEqual(visibleAfterHidden.parseIssues, [], 'blank responsive duplicate must not become a price conflict');

const hiddenAfterVisible = parseTai888Capture({
  ...capture,
  tables: [{
    headers: normalized.tables[0].headers,
    rows: [normalized.tables[0].rows[0], identityOnlyRow],
  }],
}, new Date('2026-08-14T17:00:00Z'));
assert.equal(hiddenAfterVisible.games[0].marketStatus, 'open', 'duplicate selection must not depend on DOM order');
assert.equal(validateStandardReaderGame(hiddenAfterVisible.games[0]).directionCount, 8);

const sameBandCells = [
  cell('08-20 01:10', ...spans.time, 50, [
    { text: '08-20 01:10', top: 50, left: spans.time[0] },
    { text: '08-20 01:10', top: 50, left: spans.time[0] + 2 },
  ]),
  cell('BAL-巴爾的摩金鶯 MIN-明尼蘇達雙城［ 主 ］', ...spans.teams, 50, [
    { text: 'BAL-巴爾的摩金鶯', top: 50, left: spans.teams[0] },
    { text: 'MIN-明尼蘇達雙城［ 主 ］', top: 50, left: spans.teams[0] + 90 },
  ]),
  cell('0.950 1+95 0.950', ...spans.runline, 50, [
    { text: '0.950', top: 50, left: spans.runline[0] },
    { text: '1+95 0.950', top: 50, left: spans.runline[0] + 50 },
  ]),
  cell('9+30 大 0.940 小 0.940', ...spans.total, 50, [
    { text: '9+30 大 0.940', top: 50, left: spans.total[0] },
    { text: '小 0.940', top: 50, left: spans.total[0] + 55 },
  ]),
  cell('0.990 0.760', ...spans.moneyline, 50, [
    { text: '0.990', top: 50, left: spans.moneyline[0] },
    { text: '0.760', top: 50, left: spans.moneyline[0] + 35 },
  ]),
  cell('1.5 0.530 1.5 1.660', ...spans.oneLoseTwoWin, 50, [
    { text: '1.5 0.530', top: 50, left: spans.oneLoseTwoWin[0] },
    { text: '1.5 1.660', top: 50, left: spans.oneLoseTwoWin[0] + 55 },
  ]),
  cell('0.940 0-20 0.940', ...spans.first5Runline, 50, [
    { text: '0.940', top: 50, left: spans.first5Runline[0] },
    { text: '0-20 0.940', top: 50, left: spans.first5Runline[0] + 45 },
  ]),
  cell('4+50 大 0.930 小 0.930', ...spans.first5Total, 50, [
    { text: '4+50 大 0.930', top: 50, left: spans.first5Total[0] },
    { text: '小 0.930', top: 50, left: spans.first5Total[0] + 55 },
  ]),
];
const sameBand = record(2, 50, sameBandCells);
const sameBandNormalized = normalizer.normalizeRowRecords([header, league, sameBand], { documentLooksStandardMlb: true });
const sameBandParsed = parseTai888Capture({ ...capture, tables: sameBandNormalized.tables }, new Date('2026-08-14T17:00:00Z'));
assert.equal(sameBandParsed.games.length, 1, 'same-Y responsive team rows must remain one game');
assert.equal(validateStandardReaderGame(sameBandParsed.games[0]).directionCount, 8, 'same-Y responsive odds must map to distinct sides');
assert.equal(sameBandParsed.games[0].marketStatus, 'open');

const ambiguousRunlineTables = structuredClone(normalized.tables);
ambiguousRunlineTables[0].rows[0].cells[2].pair = ['1+95 0.950', '1+95 0.950'];
const ambiguousRunline = parseTai888Capture({ ...capture, tables: ambiguousRunlineTables }, new Date('2026-08-14T17:00:00Z'));
assert.equal(ambiguousRunline.games[0].fullRunline, null, 'two line owners must be rejected');

const noDirectionTables = structuredClone(normalized.tables);
noDirectionTables[0].rows[0].cells[3].pair = ['9+30 0.940', '0.940'];
const noDirectionTotal = parseTai888Capture({ ...capture, tables: noDirectionTables }, new Date('2026-08-14T17:00:00Z'));
assert.equal(noDirectionTotal.games[0].fullTotal, null, 'row order must not invent over/under direction');

const inconsistentTotalTables = structuredClone(normalized.tables);
inconsistentTotalTables[0].rows[0].cells[3].pair = ['9+30 大 0.940', '8+30 小 0.940'];
const inconsistentTotal = parseTai888Capture({ ...capture, tables: inconsistentTotalTables }, new Date('2026-08-14T17:00:00Z'));
assert.equal(inconsistentTotal.games[0].fullTotal, null, 'conflicting total lines must be rejected');

const wrongSplitHome = structuredClone(home);
wrongSplitHome.cells[0] = cell('08-15', ...spans.time, 72);
const invalidSplit = normalizer.normalizeRowRecords([header, league, away, wrongSplitHome], { documentLooksStandardMlb: true });
assert.equal(invalidSplit.diagnostics.gameCount, 0, 'split rows require away date followed by home time');

const conflictingAway = structuredClone(away);
conflictingAway.order = 4;
conflictingAway.top = 100;
conflictingAway.bottom = 120;
conflictingAway.cells[3] = cell('8+30 大 0.940', ...spans.total, 100);
const conflictingHome = structuredClone(home);
conflictingHome.order = 5;
conflictingHome.top = 122;
conflictingHome.bottom = 142;
const conflictingNormalized = normalizer.normalizeRowRecords(
  [header, league, away, home, conflictingAway, conflictingHome],
  { documentLooksStandardMlb: true },
);
assert.equal(conflictingNormalized.diagnostics.gameCount, 1);
assert.equal(conflictingNormalized.diagnostics.conflictingGameKeys.length, 1, 'conflicting duplicate rows must not be silently deduplicated');

const secondGame = structuredClone(parsed.games[0]);
secondGame.awayCode = 'BOS';
secondGame.homeCode = 'TOR';
secondGame.boardTime = '07:07';
const payloadA = { ...parsed, games: [parsed.games[0], secondGame] };
const payloadB = { ...parsed, games: [secondGame, parsed.games[0]] };
assert.equal(canonicalReaderPayload(payloadA), canonicalReaderPayload(payloadB), 'canonical payload must ignore DOM row order');

function candidate({
  tabId = 1,
  frameId = 0,
  active = true,
  expected = 2,
  games = payloadA.games,
  activity = '2026-08-14T16:59:59.000Z',
  lastAccessed = 100,
} = {}) {
  return {
    tabId, frameId, active, lastAccessed,
    capture: {
      ...capture,
      observedAt: '2026-08-14T17:00:00.000Z',
      tables: [{ headers: labels, rows: [{}] }],
      diagnostics: {
        expectedGameCount: expected,
        gameCount: games.length,
        lastMutationAt: activity,
        documentLooksStandardMlb: true,
      },
    },
    parsed: {
      ...parsed,
      boardDate: '2026-08-15',
      games: structuredClone(games),
      parseIssues: [],
    },
  };
}

const now = Date.parse('2026-08-14T17:00:00.000Z');
const completeFrame = candidate({ frameId: 9 });
assert.equal(assessBoardCandidate(completeFrame, now).ok, true);
const duplicatedDomFrame = candidate({ frameId: 8 });
duplicatedDomFrame.capture.diagnostics.gameCount = duplicatedDomFrame.parsed.games.length * 2;
const duplicatedAssessment = assessBoardCandidate(duplicatedDomFrame, now);
assert.equal(duplicatedAssessment.ok, true, 'duplicate responsive DOM nodes must use canonical parsed game count');
assert.equal(duplicatedAssessment.rawDetectedGameCount, 4);
assert.equal(duplicatedAssessment.detectedGameCount, 2);

const partialFrameA = candidate({ frameId: 1, games: [payloadA.games[0]], expected: 2 });
const partialFrameB = candidate({ frameId: 2, games: [payloadA.games[1]], expected: 2 });
const noFlatMap = selectAuthoritativeBoard([partialFrameA, partialFrameB], { now });
assert.equal(noFlatMap.ok, true, '同一分頁的重複 partial frames 選一個權威 frame，且不得 flat-map 合併');
assert.equal(noFlatMap.selected.candidate.parsed.games.length, 1);

const selected = selectAuthoritativeBoard([partialFrameA, completeFrame], { now });
assert.equal(selected.ok, true);
assert.equal(selected.selected.candidate.frameId, 9);
assert.equal(selected.selected.candidate.parsed.games.length, 2);

const hiddenComplete = candidate({ tabId: 2, active: false, frameId: 3, lastAccessed: 50 });
const activeIncomplete = candidate({ tabId: 1, active: true, games: [payloadA.games[0]], expected: 2 });
const activeFailClosed = selectAuthoritativeBoard([hiddenComplete, activeIncomplete], { now });
assert.equal(activeFailClosed.ok, false, '可用分頁內容不一致時不得由 active tab 靜默覆蓋');
assert.equal(activeFailClosed.error, 'conflicting-duplicate-tabs');

const stale = candidate({ activity: '2026-08-14T16:56:00.000Z' });
const backgroundAssessment = assessBoardCandidate(stale, now);
assert.equal(backgroundAssessment.ok, true, 'a freshly captured background tab must not fail only because its odds did not mutate');
assert.equal(backgroundAssessment.pageActivityAt, '2026-08-14T16:56:00.000Z', '只有市場內容變動時間可作為可執行新鮮度');
assert.equal(backgroundAssessment.marketActivityAt, '2026-08-14T16:56:00.000Z', 'market mutation time remains available for audit');

const captureConflict = candidate();
captureConflict.capture.diagnostics.conflictingGameKeys = ['BAL|MIN|08-15|01:10'];
assert.equal(assessBoardCandidate(captureConflict, now).ok, true, 'duplicate DOM prices select one canonical game instead of blocking the board');
assert.equal(assessBoardCandidate(captureConflict, now).ignoredDuplicateGameCount, 1);

const missingMarket = candidate();
missingMarket.parsed.games[0].first5Total = null;
const partialMarketAssessment = assessBoardCandidate(missingMarket, now);
assert.equal(partialMarketAssessment.ok, true, 'a half-open event must not block complete games');
assert.equal(partialMarketAssessment.candidate.parsed.games[0].marketStatus, 'open');
assert.ok(partialMarketAssessment.candidate.parsed.games[0].fullRunline, 'available full-game odds must remain executable');
assert.equal(partialMarketAssessment.candidate.parsed.games[0].first5Total, null, 'a missing market must remain missing and must not be fabricated');

const explicitlyLocked = candidate();
explicitlyLocked.parsed.games[0] = {
  ...explicitlyLocked.parsed.games[0],
  marketStatus: 'locked',
  fullRunline: null,
  fullTotal: null,
  first5Runline: null,
  first5Total: null,
};
assert.equal(assessBoardCandidate(explicitlyLocked, now).ok, true, 'an explicitly locked event may have no markets');

const fakeLocked = structuredClone(explicitlyLocked);
fakeLocked.parsed.games[0].marketStatus = 'open';
assert.equal(assessBoardCandidate(fakeLocked, now).ok, false, 'missing markets without explicit DOM lock evidence must fail closed');

const extremeWater = candidate();
extremeWater.parsed.games[0].fullTotal.overWater = 0.49;
extremeWater.parsed.games[0].fullTotal.underWater = 1.83;
assert.equal(assessBoardCandidate(extremeWater, now).ok, true, 'Tai888 extreme water remains a valid executable price');

const invalidWater = candidate();
invalidWater.parsed.games[0].fullTotal.overWater = 0;
assert.equal(assessBoardCandidate(invalidWater, now).ok, false, 'all eight directions require valid water');

const conflictingFrame = candidate({ frameId: 10 });
conflictingFrame.parsed.games[0].fullTotal.overWater = 0.95;
const conflict = selectAuthoritativeBoard([completeFrame, conflictingFrame], { now });
assert.equal(conflict.ok, true, 'duplicate host/iframe observations must resolve to one authoritative frame');
assert.equal(conflict.selected.candidate.frameId, 9);
assert.equal(conflict.ignoredDuplicateFrameCount, 1);

assert.equal(shouldSkipSuccessfulPayload({
  reason: 'alarm', payloadHash: 'new', lastSuccessfulPayloadHash: 'old', lastSuccessfulSyncAt: now, now,
}), false, 'a failed new hash remains retryable because only the successful hash is compared');
assert.equal(shouldSkipSuccessfulPayload({
  reason: 'alarm', payloadHash: 'same', lastSuccessfulPayloadHash: 'same', lastSuccessfulSyncAt: now - 10_000, now,
}), true);
assert.equal(shouldSkipSuccessfulPayload({
  reason: 'manual', payloadHash: 'same', lastSuccessfulPayloadHash: 'same', lastSuccessfulSyncAt: now, now,
}), false, 'manual sync always reaches ingest');

const contentSource = fs.readFileSync(new URL('../reader/tai888-content.js', import.meta.url), 'utf8');
assert.match(contentSource, /activityByLeague/);
assert.match(contentSource, /fingerprintByLeague/);
assert.match(contentSource, /lastMutationAt: new Date\(activityAt\)\.toISOString\(\)/);
assert.match(contentSource, /function mutationTouchesMarketBoard\(mutation, marketElements\)/, 'same-price refresh must require mutation evidence inside a parsed market board');
assert.match(contentSource, /function marketMutationElements\(\)/, 'refresh evidence must be restricted to actual odds rows');
assert.match(contentSource, /record\.cells\.length < 4 \|\| record\.cells\.length > 16/, 'broad page containers and tiny status widgets must not renew market activity');
assert.match(contentSource, /waterToken\.test\(cell\.text\)/, 'refresh evidence must contain visible odds-water cells');
assert.match(contentSource, /captureAll\(\{ verifiedBoardRefreshAt \}\)/, 'verified board refresh must renew activity without requiring a price change');
assert.match(contentSource, /verifiedBoardRefreshAt > 0 \|\| before\[league\] !== fingerprintByLeague\[league\]/, 'verified same-price board refresh must notify the background heartbeat');
assert.match(contentSource, /function latestTai888NetworkRefreshAt\(\)/, 'same-price liveness may use recent same-origin Tai888 network evidence');
assert.match(contentSource, /\['fetch', 'xmlhttprequest'\]/, 'only fetch/XHR resource activity may renew a static board');
assert.match(contentSource, /url\.origin !== location\.origin/, 'cross-origin resources must not renew Tai888 board activity');
assert.match(contentSource, /now - completedAt <= 120000/, 'network evidence must itself remain recent');
assert.match(contentSource, /function mutationTouchesRefreshIndicator\(mutation\)/, 'Tai888 refresh countdown mutations may prove a live board');
assert.match(contentSource, /每\\s\*60\\s\*秒更新/, 'refresh evidence must target the visible Tai888 60-second refresh indicator');
assert.doesNotMatch(contentSource, /capture\(\)[\s\S]{0,200}verifiedBoardRefreshAt/, 'popup capture must not manufacture board refresh evidence');
assert.doesNotMatch(contentSource, /document\.body\?\.innerText/);
assert.match(contentSource, /hasExplicitMarketLock/);
assert.match(contentSource, /img\[src\*="lock" i\]/);
assert.match(contentSource, /marketLocked: hasExplicitMarketLock\(element\)/);

console.log('Tai888 Reader 2.0.3 hardening: strict contracts, multiframes, completeness, liveness and retry semantics PASS');
