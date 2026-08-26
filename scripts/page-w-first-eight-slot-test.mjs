import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');

assert.match(page, /const signedPct = value =>[\s\S]*Number\(value\) > 0 \? '\+' : ''/, 'positive EV must render with a plus sign');
assert.match(page, /firstFiniteNumber\(row\?\.modelEV, row\?\.modelEv, row\?\.rawWeightedEV, row\?\.weightedEV\)/, 'public W must prefer the canonical/raw model value and retain legacy response compatibility');
assert.match(page, /firstFiniteNumber\(row\?\.robustEV, row\?\.robustEv, row\?\.rawRobustEV\)/, 'public R must retain the raw robust fallback');
assert.match(page, /analysis\?\.directionSlots/, 'the board must consume the fixed direction-slot contract');
assert.match(page, /const expectedDirectionCount = 8/, 'every game must report against eight fixed slots');
assert.match(page, /actualRows\.filter\(row => modelEvValue\(row\) != null\)\.length/, 'calculated coverage must count finite W values rather than scores');
assert.match(page, /rows = actualRows\.filter\(row => row\.market === market\)\.sort\(compareDirectionsByScore\)/, 'the two directions in each market must sort by S first');
assert.match(page, /DirectionSlotRow/, 'UNOPENED and BLOCKED slots must have a visible row');
assert.match(page, /status === 'UNOPENED' \? '尚未開盤'/, 'unopened direction slots must be explicit');
assert.match(page, /status === 'BLOCKED'/, 'blocked direction slots must be explicit');
assert.match(page, /function directionQaPassed[\s\S]*row\?\.qa\?\.status[\s\S]*=== 'PASS'/, 'canonical qa.status must take precedence over legacy score audit fields');
assert.match(page, /readerProvenance: task\.readerProvenance \|\| null/, 'analyze must carry signed Reader provenance');
assert.match(page, /readerProvenance: actual\.readerProvenance \|\| null/, 'reprice must carry signed Reader provenance');
assert.match(page, /const readerGameByPk = new Map\(\[\.\.\.unopenedByPk, \.\.\.creditByPk\]\)/, 'Reader polling and one-click must include unopened games');
assert.match(page, /marketCoverage: actual\.marketCoverage \|\| current\.marketCoverage \|\| null/, 'reprice must update top-level market coverage');

const resultStart = page.indexOf('function ResultRow(');
const resultEnd = page.indexOf('function DirectionSlotRow(', resultStart);
assert.ok(resultStart >= 0 && resultEnd > resultStart, 'result-row component missing');
const resultRow = page.slice(resultStart, resultEnd);
const orderedLabels = ['S 分數', '模型EV W', '穩健EV R', '資料／數學 QA：', '排名資格：'];
let previous = -1;
for (const label of orderedLabels) {
  const position = resultRow.indexOf(label, previous + 1);
  assert.ok(position > previous, `${label} must follow the S-first display order`);
  previous = position;
}
assert.doesNotMatch(resultRow, /不顯示W\/R|不顯示為EV|只留後台/, 'no qualification branch may hide a calculated W/R value');

const rankingStart = page.indexOf("const shadowRanking = useMemo");
const rankingEnd = page.indexOf('const shadowBetOrder = useMemo', rankingStart);
assert.ok(rankingStart >= 0 && rankingEnd > rankingStart, 'all-direction ranking derivation missing');
const ranking = page.slice(rankingStart, rankingEnd);
assert.match(ranking, /modelEvValue\(row\) != null/, 'all-direction list must retain every finite W, including negative values');
assert.match(ranking, /Number\(right\.score \?\? -Infinity\) - Number\(left\.score \?\? -Infinity\)[\s\S]*Number\(right\.weightedEV \?\? -Infinity\)/, 'all-direction list must sort by S, then W');
assert.doesNotMatch(ranking, /\.filter\([^)]*(rankingQualified|formulaDiagnosticScore|robustEV)/, 'score, R and rank gates must not filter the all-direction W list');

console.log('page S-first eight-slot presentation test passed');
