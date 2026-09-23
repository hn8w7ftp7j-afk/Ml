import assert from 'node:assert/strict';
import { parseTai888Capture } from '../reader/parser.js';
import { selectAuthoritativeBoard } from '../reader/board-selector.js';
import { validateTai888ReaderEnvelope } from '../lib/tai888-reader-parser-v2.js';

const now = new Date('2026-09-23T06:23:32Z');
const cell = pair => ({ pair, lines: pair });
// Synthetic alternative contracts exercise disagreement; they are not actual quotes.
const row = (line, partial = false) => ({ cells: [cell(['09-23', '17:30']),
  cell(['LOG - 樂天巨人', 'HAN - 韓華鷹 [主]']), cell(['1-10 0.940', '0.940']),
  cell([`${line} 大 0.900`, '小 0.940']), cell([]), cell([]),
  cell(partial ? [] : ['0-70 0.930', '0.930']), cell(partial ? [] : ['5.5 大 0.920', '小 0.920'])] });
function candidate(rows, frameId = 0, tabId = 1, league = 'KBO') {
  const capture = { league, sourceHost: 'www.tai888.in', pageUrl: 'https://www.tai888.in/',
    observedAt: now.toISOString(), tables: [{ headers: ['時間', '主客隊伍', '讓球', '大小盤', '獨贏', '一輸二贏', '上半讓球', '上半大小'], rows }],
    diagnostics: { expectedGameCount: 1, gameCount: rows.length, lastMutationAt: now.toISOString() } };
  return { tabId, frameId, active: true, capture, parsed: parseTai888Capture(capture, now) };
}
const select = (...candidates) => selectAuthoritativeBoard(candidates, { now: now.getTime(), league: 'KBO' });
let checks = 0;
for (const partial of [false, true]) {
  for (const reverse of [false, true]) {
    const rows = [row('10平'), row('11+50', partial)];
    if (reverse) rows.reverse();
    const c = candidate(rows);
    assert.ok(c.parsed.parseIssues.length);
    assert.equal(select(c).ok, false, 'same-frame disagreements stop in either order/coverage');
    assert.equal(select(c, candidate([row('10平')], 2)).ok, false, 'another valid frame cannot conceal conflicts');
    assert.throws(() => validateTai888ReaderEnvelope(c.parsed), /盤口解析衝突/);
    checks += 3;
  }
}
assert.equal(select(candidate([row('10平'), row('10平')])).ok, true); checks++;
assert.equal(select(candidate([row('10平'), row('10平', true)])).ok, true); checks++;
const blank = row('10平'); for (const i of [2,3,6,7]) blank.cells[i] = cell([]);
for (const rows of [[blank, row('10平')], [row('10平'), blank]]) {
  assert.equal(select(candidate(rows)).ok, true); checks++;
}
for (const partial of [false, true]) {
  assert.equal(select(candidate([row('10平')]), candidate([row('11+50', partial)], 2)).ok, false); checks++;
  assert.equal(select(candidate([row('10平')]), candidate([row('11+50', partial)], 0, 2)).ok, false); checks++;
}
const normalizedConflict = candidate([row('10平')]);
normalizedConflict.capture.diagnostics.conflictingGameKeys = ['redacted-conflict'];
normalizedConflict.parsed = parseTai888Capture(normalizedConflict.capture, now);
assert.equal(select(normalizedConflict).ok, false); checks++;
assert.throws(() => validateTai888ReaderEnvelope(normalizedConflict.parsed), /盤口解析衝突/); checks++;
assert.equal(select(candidate([row('10平')]), candidate([row('11+50'),row('10平')], 0, 3, 'NPB')).ok, true); checks++;
console.log(`Reader 2.1.22 conflict regression: ${checks} assertions PASS`);
