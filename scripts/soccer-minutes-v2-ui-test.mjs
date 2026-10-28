import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadSoccerMinutesV2CoverageForTest} from './helpers/soccer-minutes-v2-ui-fixture.mjs';

const summary=JSON.parse(fs.readFileSync('research/soccer/personnel-minutes-v2-coverage.json','utf8'));
const Component=await loadSoccerMinutesV2CoverageForTest(React);
const render=(league,value)=>renderToStaticMarkup(React.createElement(Component,{league,...(value===undefined?{}:{summary:value})}));
for(const league of ['epl','ucl']){
  const before=JSON.stringify(summary),html=render(league),row=summary.leagues[league];
  assert.match(html,/aria-label="歷史分鐘重建覆蓋"/);assert.match(html,/歷史上場分鐘補齊/);
  assert.ok(html.includes(`原可重建 ${row.v1Reconstructed}／${row.population} 場`));
  assert.ok(html.includes(`本次可重建 ${row.v2Reconstructed}／${row.population} 場，補回 ${row.recovered} 場`));
  assert.ok(html.includes(`仍有 ${row.unverified} 場未通過核對`));
  assert.match(html,/換人紀錄與當時場上狀態衝突/);assert.match(html,/紅牌球員身分或重複紀錄衝突/);
  if(league==='ucl')assert.match(html,/缺少可核對的正規時間終場事件/);
  assert.match(html,/目前保留歷史資料的賽後重播/);assert.match(html,/不含實際補時/);
  assert.match(html,/不是賽前預計分鐘，也不證明當時已取得資料/);
  assert.match(html,/新增分鐘觀察尚未納入現行模型/);assert.match(html,/正式 S 評分狀態維持不變/);
  assert.doesNotMatch(html,/undefined|NaN|Infinity|SOURCE_ID|STATE_CONFLICT|IDENTITY_CONFLICT|REGULATION_END/);
  assert.equal(JSON.stringify(summary),before,'presentation cannot mutate source counts or model flags');
  assert.doesNotMatch(html,league==='epl'?/799／805|補回 553/:/2177／2190|補回 930/,'one league never borrows the other league coverage');
}
console.log('PASS actual minutes V2 coverage leaf: EPL/UCL exact reconstructed and recovered denominators, retained exclusion reasons and explicit postmatch/non-PIT/unchanged-model/no-formal-S limits');

for(const edit of [
  value=>{value.version='wrong';},value=>{value.extractorVersion='wrong';},
  value=>{value.formalEligible=true;},value=>{value.modelEffectApplied=true;},
  value=>{value.pointInTimeAvailabilityVerified=true;},value=>{value.currentModelUnchanged=false;},
  value=>{value.physicalElapsedMinutesVerified=true;},
  value=>{value.networkRequests=1;},value=>{value.summaryHash='invalid';},
  value=>{value.sourceArtifactHashes={};},value=>{value.sourceArtifactHashes={source:'invalid'};},
  value=>{value.leagues.epl.population=-1;},value=>{value.leagues.epl.v2Reconstructed=Infinity;},
  value=>{value.leagues.epl.v2Reconstructed=value.leagues.epl.population+1;},
  value=>{value.leagues.epl.recovered++;},value=>{value.leagues.epl.unverified++;},
  value=>{value.leagues.epl.regressed=1;},value=>{value.leagues.epl.stateResolvedSubstitutions=-1;},
  value=>{value.leagues.epl.numericChangesOnOriginalUsableGames=1;},
  value=>{value.leagues.epl.v2Reasons={SUBSTITUTION_STATE_CONFLICT:1};},
  value=>{value.leagues.epl.v2Reasons.SUBSTITUTION_STATE_CONFLICT=-1;},
  value=>{delete value.leagues.epl;},
]){
  const changed=structuredClone(summary);edit(changed);const html=render('epl',changed);
  assert.match(html,/此聯盟尚無可核對的分鐘重建統計/);assert.doesNotMatch(html,/本次可重建|補回 \d+ 場/);
}
for(const league of [undefined,null,'nba','EPL','toString']){
  assert.match(render(league),/此聯盟尚無可核對的分鐘重建統計/);assert.doesNotMatch(render(league),/本次可重建/);
}
const noUcl=structuredClone(summary);delete noUcl.leagues.ucl;
assert.match(render('ucl',noUcl),/此聯盟尚無可核對的分鐘重建統計/);
const unknownReason=structuredClone(summary);
unknownReason.leagues.epl.v2Reasons={UNKNOWN_PRIVATE_SOURCE_REASON:unknownReason.leagues.epl.unverified};
assert.match(render('epl',unknownReason),/其他來源檢核未通過/);assert.doesNotMatch(render('epl',unknownReason),/UNKNOWN_PRIVATE_SOURCE_REASON/);
console.log('PASS minutes V2 coverage fail-closed presentation: wrong versions/promotion flags, invalid counters/reason sums/hashes and missing or unsupported leagues cannot display coverage; unknown reasons remain plain-language');
