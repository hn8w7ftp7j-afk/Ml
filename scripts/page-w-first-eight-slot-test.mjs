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
assert.match(page, /allDirectionsUnopened[\s\S]*readerWaitingSummary/, 'an all-unopened game must render one compact waiting state instead of eight blank rows');
assert.match(page, /marketAllUnopened[\s\S]*尚未開盤｜Reader持續監看/, 'a partial game must retain eight-slot data internally while collapsing unopened market rows');
assert.match(page, /marketBlocked[\s\S]*資料異常｜不評分[\s\S]*marketAllUnopened/, 'a true coverage error must render BLOCKED before the compact unopened branch');
assert.match(page, /function directionQaPassed[\s\S]*row\?\.qa\?\.status[\s\S]*=== 'PASS'/, 'canonical qa.status must take precedence over legacy score audit fields');
assert.match(page, /readerProvenance: task\.readerProvenance \|\| null/, 'analyze must carry signed Reader provenance');
assert.match(page, /readerProvenance: actual\.readerProvenance \|\| null/, 'reprice must carry signed Reader provenance');
assert.match(page, /const readerGameByPk = new Map\(\[\.\.\.unopenedByPk, \.\.\.creditByPk\]\)/, 'Reader polling and one-click must include unopened games');
assert.match(page, /marketCoverage: actual\.marketCoverage \|\| current\.marketCoverage \|\| null/, 'reprice must update top-level market coverage');

const resultStart = page.indexOf('function ResultRow(');
const resultEnd = page.indexOf('function DirectionSlotRow(', resultStart);
assert.ok(resultStart >= 0 && resultEnd > resultStart, 'result-row component missing');
const resultRow = page.slice(resultStart, resultEnd);
const orderedLabels = ['S 分數', '模型估計EV W', '保守估計 R', '資料／數學 QA：', '排名資格：'];
let previous = -1;
for (const label of orderedLabels) {
  const position = resultRow.indexOf(label, previous + 1);
  assert.ok(position > previous, `${label} must follow the S-first display order`);
  previous = position;
}
assert.doesNotMatch(resultRow, /不顯示W\/R|不顯示為EV|只留後台/, 'no qualification branch may hide a calculated W/R value');
assert.match(resultRow, /marketResearchRestriction\(row, game\)/, 'research policy must use exact row and game identity');
assert.match(resultRow, /<ResearchMarketBadge policy=\{researchPolicy\}/, 'research rows must show an unmistakable research-only badge');
assert.match(resultRow, /const scoreClass = researchPolicy \? 'researchOnlyScore'/, 'research rows must not retain candidate or strongest styling');
assert.match(resultRow, /action\.kind === 'cancel' \? onCancel\(latest\) : onBet\(row\)/, 'research labeling must retain the original ledger and cancel flow');

const rankingStart = page.indexOf("const shadowRanking = useMemo");
const rankingEnd = page.indexOf('const shadowBetOrder = useMemo', rankingStart);
assert.ok(rankingStart >= 0 && rankingEnd > rankingStart, 'all-direction ranking derivation missing');
const ranking = page.slice(rankingStart, rankingEnd);
assert.match(ranking, /modelEvValue\(row\) != null/, 'all-direction list must retain every finite W, including negative values');
assert.match(ranking, /Number\(right\.score \?\? -Infinity\) - Number\(left\.score \?\? -Infinity\)[\s\S]*Number\(right\.weightedEV \?\? -Infinity\)/, 'all-direction list must sort by S, then W');
assert.doesNotMatch(ranking, /\.filter\([^)]*(rankingQualified|formulaDiagnosticScore|robustEV)/, 'score, R and rank gates must not filter the all-direction W list');
assert.match(ranking, /const rankingEligible = !researchPolicy && currentAnalysisExecutable/, 'research rows must never advertise current ranking eligibility');
assert.match(page, /activeLeague\.id === 'MLB'[\s\S]*MLB 全場大分｜正常保留・持續觀察/, 'homepage research notice must be scoped to MLB');
assert.match(page, /研究回測[\s\S]*歷史模擬｜非實際帳本/, 'research history must be distinguished from actual ledger');

console.log('page S-first eight-slot presentation test passed');
