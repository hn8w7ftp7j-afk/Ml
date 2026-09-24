import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { transform } from 'next/dist/build/swc/index.js';
import { rankingWarningPresentation, rankingStatusText } from '../lib/ranking-display.js';

const informational = '缺少5分鐘內獨立國際市場同賽事同期間價格；外部稽核無資料；不影響模型W/R、S分數與排名';
const wr = '模型W/R差距11.4586個百分點，超過5個百分點參考線；R包含情境下行情形及資料風險扣減，不代表單獨的情境不穩定；保留評分與排名';
const gap = '模型／Tai888去水機率高度分歧 30.38pp';
const extreme = '極高模型EV，建議複核';
const blocked = '盤口身分不符，禁止紀錄';
const warnings = Object.freeze([informational, wr, gap, extreme, blocked, wr]);
const view = rankingWarningPresentation(warnings);
assert.deepEqual(view.visible, ['W/R 差距 11.46 個百分點', '模型與盤口機率差距 30.38pp', extreme, blocked]);
assert.deepEqual(view.details, [informational, wr, gap, extreme, blocked]);
assert.equal(warnings.length, 6, 'saved evidence must not be mutated');
assert.deepEqual(rankingWarningPresentation(), { visible: [], details: [] });
assert.deepEqual(rankingWarningPresentation([null, '', 5]).visible, []);
assert.deepEqual(rankingWarningPresentation(['外部稽核發現盤口錯配']).visible, ['外部稽核發現盤口錯配'], 'unknown external errors stay visible');
assert.deepEqual(rankingWarningPresentation(['模型W/R差距無法核驗']).visible, ['模型W/R差距無法核驗']);
assert.deepEqual(rankingWarningPresentation([`${informational}；盤口錯誤`]).visible, [`${informational}；盤口錯誤`], 'do not hide a notice that also contains another error');
assert.deepEqual(rankingWarningPresentation(['極高模型EV（W +52.2%），建議複核；W、R、S與排名資格照實保留']).visible, ['EV 偏高（W +52.2%），建議複核']);

const eligible = Object.freeze({ qualified: true, qaPassed: true, rankingEligible: true, currentAnalysisExecutable: true });
assert.equal(rankingStatusText(eligible), null, 'do not repeat PASS or ranking eligible on every row');
assert.equal(rankingStatusText({ ...eligible, qualified: false }), '模型檢查未通過');
assert.equal(rankingStatusText({ ...eligible, qaPassed: false }), '資料檢查未通過');
assert.equal(rankingStatusText({ ...eligible, currentAnalysisExecutable: false }), '盤口待複核');
assert.equal(rankingStatusText({ ...eligible, researchPolicy: {} }), '僅供研究');
assert.equal(rankingStatusText({ ...eligible, rankingEligible: false }), '未達排名條件');
assert.equal(rankingStatusText({ ...eligible, rankingEligible: false, row: { rankingQualificationReason: '資料不足' } }), '資料不足');

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const diagnostics = page.slice(page.indexOf('function RankingDiagnostics('), page.indexOf('function ReaderRecovery('));
assert.match(diagnostics, /visible\.map/);
assert.match(diagnostics, /<details className="rankingDetails"><summary>檢查明細<\/summary>/, 'raw notes are available but collapsed by default');
assert.match(diagnostics, /status && <small className="warningText">/);
assert.match(diagnostics, /signedPct\(entry\.weightedEV\)/);
assert.match(diagnostics, /signedPct\(entry\.robustEV\)/);
const rankingUi = page.slice(page.indexOf("{tab === 'ranking' &&"), page.indexOf("{tab === 'bets' &&"));
assert.equal((rankingUi.match(/<RankingDiagnostics entry=\{entry\}/g) || []).length, 2, 'both ranking views use the same compact display');
assert.match(rankingUi, /<details className="rankingDetails rankingSourceDetails"><summary>資料與排序說明/);
assert.doesNotMatch(rankingUi, /此處顯示這一版Reader快照|先按比賽開始時間由早到晚|資料／數學 QA：|排名資格：是/);
assert.equal((rankingUi.match(/evaluateBetAction\(/g) || []).length, 2, 'preserve canonical action guards in both views');
assert.equal((rankingUi.match(/<ReaderRecovery action=/g) || []).length, 2);
// Render the actual JSX, not a duplicate test component.
const compiled = await transform(diagnostics, {
  filename: 'ranking-diagnostics.jsx',
  jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } },
});
const Component = vm.runInNewContext(`${compiled.code}; RankingDiagnostics`, {
  React, rankingWarningPresentation, rankingStatusText,
  signedPct: value => `${value > 0 ? '+' : ''}${(value * 100).toFixed(2)}%`,
});
const html = renderToStaticMarkup(React.createElement(Component, { entry: { ...eligible, weightedEV: 0.52, robustEV: 0.40 }, warnings }));
const $ = load(html);
assert.equal($('details').length, 1);
assert.equal($('details[open]').length, 0);
assert.ok($('details').text().includes(informational));
$('details').remove();
assert.ok($('body').text().includes('W +52.00%'));
assert.ok($('body').text().includes('R +40.00%'));
assert.ok($('body').text().includes(blocked));
assert.ok(!$('body').text().includes(informational));
assert.ok(!$('body').text().includes('PASS'));
const blockedHtml = renderToStaticMarkup(React.createElement(Component, { entry: { ...eligible, qaPassed: false }, warnings: [] }));
assert.ok(blockedHtml.includes('資料檢查未通過'));
console.log('ranking display: presentation and rendered JSX assertions PASS');
