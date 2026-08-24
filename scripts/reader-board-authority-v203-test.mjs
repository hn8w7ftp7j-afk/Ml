import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  MAX_TAI888_TABS,
  selectAuthoritativeBoard,
  withinTai888TabScanLimit,
} from '../reader/board-selector.js';

const NOW = Date.parse('2026-08-14T17:00:00.000Z');

assert.equal(MAX_TAI888_TABS, Number.POSITIVE_INFINITY);
assert.equal(withinTai888TabScanLimit(4), true);
assert.equal(withinTai888TabScanLimit(5), true, 'a fifth non-board tab must not stop four league captures');
assert.equal(withinTai888TabScanLimit(-1), false);
assert.equal(withinTai888TabScanLimit('4'), false);

function game(overWater = 0.94) {
  return {
    awayCode: 'BAL',
    homeCode: 'MIN',
    boardDate: '2026-08-15',
    boardTime: '01:10',
    fullRunline: { lineSide: 'home', line: '1+95', awayWater: 0.95, homeWater: 0.95 },
    fullTotal: { line: '9+30', overWater, underWater: 0.94 },
    first5Runline: { lineSide: 'home', line: '0-20', awayWater: 0.94, homeWater: 0.94 },
    first5Total: { line: '4+50', overWater: 0.93, underWater: 0.93 },
  };
}

function candidate({ tabId, active, overWater = 0.94, complete = true, lastAccessed = 100 }) {
  const games = complete ? [game(overWater)] : [];
  return {
    tabId,
    frameId: 0,
    active,
    lastAccessed,
    capture: {
      sourceHost: 'www1.tai888.in',
      pageUrl: 'https://www1.tai888.in/newapp/#/BS',
      observedAt: '2026-08-14T17:00:00.000Z',
      tables: [{ headers: ['時間', '主客隊伍', '讓球', '大小盤'], rows: [{}] }],
      diagnostics: {
        expectedGameCount: 1,
        gameCount: games.length,
        lastMutationAt: '2026-08-14T16:59:59.000Z',
      },
    },
    parsed: {
      version: 'TAI888-READER-DOM-v2.0.3',
      sourceHost: 'www1.tai888.in',
      boardDate: '2026-08-15',
      games,
      parseIssues: [],
    },
  };
}

const activeComplete = candidate({ tabId: 1, active: true, lastAccessed: 200 });
const hiddenSameBoard = candidate({ tabId: 2, active: false, lastAccessed: 300 });
const hiddenPreferred = selectAuthoritativeBoard(
  [activeComplete, hiddenSameBoard],
  { now: NOW, preferredTabId: 2 },
);
assert.equal(hiddenPreferred.ok, true);
assert.equal(hiddenPreferred.authorityTabId, 1, 'an inactive preferred tab must not outrank the active tab');

const activeIncomplete = candidate({ tabId: 1, active: true, complete: false, lastAccessed: 200 });
const inactiveCanRescue = selectAuthoritativeBoard(
  [activeIncomplete, hiddenSameBoard],
  { now: NOW, preferredTabId: 2 },
);
assert.equal(inactiveCanRescue.ok, true, 'an incomplete active duplicate must not block a complete league tab');
assert.equal(inactiveCanRescue.authorityTabId, 2);

const hiddenDifferentBoard = candidate({ tabId: 2, active: false, overWater: 0.95, lastAccessed: 300 });
const conflictingTabs = selectAuthoritativeBoard(
  [activeComplete, hiddenDifferentBoard],
  { now: NOW },
);
assert.equal(conflictingTabs.ok, false, '內容不一致的同聯盟可用分頁必須整批停止');
assert.equal(conflictingTabs.error, 'conflicting-duplicate-tabs');

const staleBoard = candidate({ tabId: 9, active: true });
staleBoard.capture.diagnostics.lastMutationAt = '2026-08-14T16:54:59.000Z';
const staleSelection = selectAuthoritativeBoard([staleBoard], { now: NOW });
assert.equal(staleSelection.ok, true, '完整DOM盤面重新讀取成功時，相同價格不得在五分鐘後誤判過期');
assert.equal(staleSelection.selected.pageActivityAt, staleBoard.capture.observedAt);

const staleObservation = candidate({ tabId: 10, active: true });
staleObservation.capture.observedAt = '2026-08-14T16:58:59.000Z';
const staleObservationSelection = selectAuthoritativeBoard([staleObservation], { now: NOW });
assert.equal(staleObservationSelection.ok, false, '沒有新的DOM回應時仍必須判定為失聯');
assert.match(staleObservationSelection.assessed.flatMap(row => row.issues || []).join('｜'), /stale-observation/);

const otherDate = candidate({ tabId: 3, active: false, overWater: 0.95 });
otherDate.parsed.boardDate = '2026-08-16';
otherDate.parsed.games[0].boardDate = '2026-08-16';
const separateDates = selectAuthoritativeBoard([activeComplete, otherDate], { now: NOW });
assert.equal(separateDates.ok, false, '同聯盟不同盤日的可用分頁仍屬衝突，必須要求只保留正確盤日');
assert.equal(separateDates.error, 'conflicting-duplicate-tabs');

const backgroundSource = fs.readFileSync(new URL('../reader/background.js', import.meta.url), 'utf8');
assert.match(
  backgroundSource,
  /sender\?\.tab\?\.active === true \? sender\.tab\.id : null/,
  'a mutation sender may only become preferred while its tab is active',
);
assert.match(
  backgroundSource,
  /tab\.active === true \? tabId : null/,
  'an inactive tab load may not become preferred either',
);
assert.match(backgroundSource, /selectAuthoritativeBoard\(own, \{ now: Date\.now\(\), preferredTabId, league \}\)/);
assert.doesNotMatch(backgroundSource, /!withinTai888TabScanLimit\(tabs\.length\)/);
assert.match(backgroundSource, /for \(const tab of tabs\)/);
assert.doesNotMatch(backgroundSource, /tabs\.slice\(0,\s*4\)/);
assert.match(backgroundSource, /if \(!selection\.ok\)/);

console.log('Reader board authority: duplicate tabs and host/iframe boards deduplicated PASS');
