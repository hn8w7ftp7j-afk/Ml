import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {transform} from 'next/dist/build/swc/index.js';
import {nbaNavigationDate} from '../lib/nba/analysis-ui-policy.js';
import {validNbaJob,NBA_JOB_STORAGE} from '../lib/nba/analysis-job-display.js';

const path=new URL('../app/nba/analysis-panel.js',import.meta.url);
const source=fs.readFileSync(path,'utf8');
const compiled=await transform(source,{filename:path.pathname,jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'automatic'}}},module:{type:'commonjs'}});
const nativeRequire=createRequire(import.meta.url), module={exports:{}};
vm.runInNewContext(compiled.code,{module,exports:module.exports,URLSearchParams,
  require:name=>name.endsWith('.module.css')?{toolbar:'toolbar',muted:'muted'}:nativeRequire(name)});
const Panel=module.exports.default;

for(const date of ['2026-10-05','2026-10-29','2027-03-10']) {
  const markup=renderToStaticMarkup(React.createElement(Panel,{date}));
  const href=markup.match(/href="([^"]+)"/)[1].replaceAll('&amp;','&');
  const destination=new URL(href,'https://fixture.test');
  assert.equal(destination.pathname,'/');
  assert.deepEqual([...destination.searchParams],[['sport','NBA'],['date',date]],'The selected Taipei board date survives the handoff');
  assert.equal(nbaNavigationDate(destination.search),date);
  assert.match(markup,/前往 NBA 盤口分析/);
  assert.match(markup,/S 評分/);
  assert.equal((markup.match(/<a\b/g)||[]).length,1);
}

// Executing the actual component above requires no fetch, independent model
// selection or old response validator. The destination is the existing shared
// four-market board, whose complete contract tests cover its server results.
assert.doesNotMatch(source,/fetch\s*\(|\/api\/nba\/analysis\b|nba-total-pace-rest-v1|validResult\s*\(/);
const workspace=fs.readFileSync(new URL('../app/nba/reader-panel.js',import.meta.url),'utf8');
assert.match(workspace,/<NbaAnalysisPanel\b[^>]*\bdate=\{date\}/);
const main=fs.readFileSync(new URL('../app/nba/main-workspace.js',import.meta.url),'utf8');
for(const search of ['', '?sport=NBA', '?sport=MLB&date=2026-10-29', '?date=2026-10-29',
  '?sport=NBA&date=2026-02-30', '?sport=NBA&date=2026-10-29&date=2026-10-29',
  '?sport=NBA&date=2026-10-29&date=2026-10-30']) assert.equal(nbaNavigationDate(search),null);
assert.equal(nbaNavigationDate('?sport=NBA&date=2028-02-29'),'2028-02-29');

// Execute the real ordered mount effects, including a stale saved job. A
// previous running date must not steal the date explicitly chosen in data.
const navigationEffect=main.match(/useEffect\(\(\) => \{\n    const target = nbaNavigationDate[\s\S]*?\n  \}, \[\]\);/)?.[0];
const restoreEffect=main.match(/useEffect\(\(\) => \{ try \{ const saved = JSON\.parse\(localStorage\.getItem\(NBA_JOB_STORAGE\)[^\n]+/)?.[0];
assert.ok(navigationEffect&&restoreEffect);
assert.ok(main.indexOf(navigationEffect)<main.indexOf(restoreEffect));
for(const savedDate of ['2026-10-28','2026-10-29']) {
  const dates=[],jobs=[],saved={date:savedDate,runId:'run-saved-fixture',status:'running'};
  const context={nbaNavigationDate,validNbaJob,NBA_JOB_STORAGE,explicitDate:{current:false},dateRef:{current:'2026-10-30'},
    window:{location:{search:'?sport=NBA&date=2026-10-29'}},localStorage:{getItem:()=>JSON.stringify(saved)},
    setDate:value=>dates.push(value),setJob:value=>jobs.push(value),useEffect:callback=>callback()};
  vm.runInNewContext(`${navigationEffect}\n${restoreEffect}`,context);
  assert.equal(context.explicitDate.current,true);
  assert.equal(context.dateRef.current,'2026-10-29');
  assert.ok(dates.length>0&&dates.every(value=>value==='2026-10-29'));
  assert.equal(jobs.length,savedDate==='2026-10-29'?1:0);
}
assert.match(main,/export function NbaGameCard/);
assert.match(main,/nbaMarketScore\(estimate\)/);
assert.match(main,/mergeNbaAnalysisResults\(/);
console.log('NBA data analysis entry PASS: preserved board dates, one shared four-market/S workflow, no retired direct-analysis response contract');
