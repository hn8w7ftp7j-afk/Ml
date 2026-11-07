import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { shotXgResearchForGame } from '../lib/soccer/shot-xg-research-view.js';
import { soccerShotXgResearchArtifacts } from '../lib/soccer/shot-xg-frozen.js';
import { soccerDate } from '../lib/soccer/contracts.js';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { buildSoccerAnalysis } from '../lib/soccer/analysis.js';
import { loadSoccerShotXgResearchUiForTest } from './helpers/soccer-shot-xg-ui-fixture.mjs';

const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const seal=value=>{const {contentHash,...body}=value;return {...body,contentHash:createHash('sha256').update(canonical(body)).digest('hex')};};
const bundle=soccerShotXgResearchArtifacts(),at=Date.parse(bundle.createdAt),now=at+1000;
const startTime=new Date(now+86400000).toISOString();
// Synthetic event context, actual published corpus/report. No engineering game
// is presented as a real match observation or a formal source receipt.
const game={id:'soccer:epl:123',sourceId:'123',league:'epl',date:soccerDate(startTime),startTime,
  home:{id:'soccer:epl:team:1',sourceId:'1'},away:{id:'soccer:epl:team:2',sourceId:'2'}};
const original=canonical(bundle),view=shotXgResearchForGame(game,{now});
assert.equal(view.status,'RESEARCH_AVAILABLE');assert.equal(view.gameId,game.id);assert.equal(view.analysisCutoff,new Date(now).toISOString());
assert.deepEqual(view.report,bundle.reports.epl);assert.equal(view.report.sourceCollection.sourceMatches,380);
assert.equal(view.report.rawRowsIncluded,false);assert.equal(view.report.fittedCoefficientsIncluded,false);
assert.equal(Object.hasOwn(view.report,'models'),false);assert.equal(Object.hasOwn(view.report,'observations'),false);
for(const flag of ['accepted','formalEligible','calibrationEligible','promotionEligible','modelEffectApplied','executable','currentSeasonModelApplied'])assert.equal(view[flag],false);
for(const key of ['W','R','S'])assert.equal(view[key],null);
assert.equal(canonical(bundle),original,'projection cannot mutate the frozen authority');
assert.deepEqual(shotXgResearchForGame(game,{now,artifacts:structuredClone(bundle)}),view,'byte-equivalent copies of the genuine frozen artifact are accepted');
assert.equal(shotXgResearchForGame(game,{now:at-1}).status,'NOT_AVAILABLE_AT_CUTOFF');
assert.equal(shotXgResearchForGame(game,{now:at-1}).report,null);
assert.equal(shotXgResearchForGame(game,{now:at}).status,'RESEARCH_AVAILABLE','the exact real availability boundary is usable');

const reject=change=>{const altered=structuredClone(bundle);change(altered);if(altered.reports?.epl)altered.reports.epl=seal(altered.reports.epl);const forged=seal(altered);
  const result=shotXgResearchForGame(game,{now,artifacts:forged});assert.equal(result.status,'ARTIFACT_INVALID');assert.equal(result.report,null);};
for(const key of ['accepted','formalEligible','calibrationEligible','promotionEligible','modelEffectApplied','executable']){
  reject(value=>{value[key]=true;});reject(value=>{value.reports.epl[key]=true;});
}
for(const key of ['historicalAvailabilityVerified','independentUntouchedTestVerified','currentSeasonCoverageVerified','uclCoverageVerified'])reject(value=>{value.reports.epl[key]=true;});
reject(value=>{value.createdAt=new Date(at-86400000).toISOString();value.reports.epl.createdAt=value.createdAt;value.reports.epl.availableAt=value.createdAt;});
reject(value=>{value.createdAt=new Date(now+86400000).toISOString();});
reject(value=>{value.reports.epl.createdAt=new Date(now+86400000).toISOString();});
reject(value=>{value.reports.epl.availableAt=new Date(now+86400000).toISOString();});
reject(value=>{value.reports.epl.coordinateContract='GUESSED_METRIC_PITCH';});
reject(value=>{value.reports.epl.protocol.trainingBefore='2020-01-01';});
reject(value=>{value.reports.epl.synthetic=true;});
reject(value=>{value.reports.epl.sourceAuthenticationVerified=false;});
reject(value=>{value.reports.epl.rawRowsIncluded=true;});
reject(value=>{value.reports.epl.league='ucl';});
assert.equal(shotXgResearchForGame(game,{now,artifacts:{...bundle,contentHash:'0'.repeat(64)}}).status,'ARTIFACT_INVALID');
for(const artifacts of [null,{},[],{version:bundle.version}])assert.equal(shotXgResearchForGame(game,{now,artifacts}).status,'ARTIFACT_INVALID');
const changed=shotXgResearchForGame(game,{now});changed.report.coverage.sourceMatches=999;
assert.equal(shotXgResearchForGame(game,{now}).report.coverage.sourceMatches,bundle.reports.epl.coverage.sourceMatches);
const uclGame={...game,id:'soccer:ucl:123',league:'ucl',home:{...game.home,id:'soccer:ucl:team:1'},away:{...game.away,id:'soccer:ucl:team:2'}};
const ucl=shotXgResearchForGame(uclGame,{now});assert.equal(ucl.status,'NO_LEAGUE_COHORT');assert.equal(ucl.report,null);
for(const change of [{sourceId:123},{id:'soccer:epl:999'},{league:'nba'},{date:'2026-02-30'},{date:'2000-01-01'},{startTime:'2026-11-08 12:00:00'},
  {home:{sourceId:1}},{away:{sourceId:2}},{away:{sourceId:game.home.sourceId}}])assert.equal(shotXgResearchForGame({...game,...change},{now}),null);
for(const invalidNow of [NaN,Infinity,'2026-11-07',8.64e15+1])assert.equal(shotXgResearchForGame(game,{now:invalidNow}),null);

const {SoccerShotXgResearchPanel,soccerShotXgViewRenderable}=await loadSoccerShotXgResearchUiForTest(React);
assert.equal(soccerShotXgViewRenderable(view,game,view.analysisCutoff),true);
const markup=renderToStaticMarkup(React.createElement(SoccerShotXgResearchPanel,{view,game,analysisCutoff:view.analysisCutoff}));
assert.match(markup,/來源清單 380 場/);assert.match(markup,/2241/);assert.match(markup,/0\.2986/);assert.match(markup,/0\.2988/);
assert.equal(soccerShotXgViewRenderable(view,game,new Date(at-1).toISOString()),false,'later genuine report cannot be borrowed into the same fixture older analysis');
assert.equal(soccerShotXgViewRenderable(view,game,undefined),false);
assert.equal(soccerShotXgViewRenderable(view,{...game,startTime:new Date(now+2*86400000).toISOString()},view.analysisCutoff),false);
assert.equal(soccerShotXgViewRenderable(ucl,uclGame,ucl.analysisCutoff),true);
const uclMarkup=renderToStaticMarkup(React.createElement(SoccerShotXgResearchPanel,{view:ucl,game:uclGame,analysisCutoff:ucl.analysisCutoff}));
assert.match(uclMarkup,/本聯盟尚無符合/);assert.doesNotMatch(uclMarkup,/2241|0\.2986|380 場/);
const unavailable=shotXgResearchForGame(game,{now:at-1});
assert.equal(soccerShotXgViewRenderable(unavailable,game,unavailable.analysisCutoff),true);
assert.match(renderToStaticMarkup(React.createElement(SoccerShotXgResearchPanel,{view:unavailable,game,analysisCutoff:unavailable.analysisCutoff})),/本次分析時間尚不可用/);
const analysisSource=fs.readFileSync('lib/soccer/analysis.js','utf8');
assert.match(analysisSource,/shotXgResearchForGame\(game,\{now\}\)/);assert.match(analysisSource,/matchXgResearch,shotXgResearch,halfTimePrediction/);
// Replay genuine provider payloads at the current artifact cutoff. These are
// historical fixtures observed in a test replay, never newly fetched matches.
function replay(league,cutoff){
  const payload=JSON.parse(fs.readFileSync(new URL(`./fixtures/soccer/${league}-summary.json`,import.meta.url)));
  const competition=payload.header.competitions[0];
  const source={provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/soccer/${payload.header.league.slug}/summary?event=${payload.header.id}`,
    fetchedAt:new Date(cutoff).toISOString(),contentHash:createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
  const normalizedGame=normalizeSoccerSchedule({leagues:[payload.header.league],events:[{...payload.header,date:competition.date,status:competition.status}]},league,source).games[0];
  const evidence=normalizeSoccerPrematch(payload,normalizedGame,source,cutoff);assert.equal(evidence.ok,true);
  const before=JSON.stringify(evidence),analysis=buildSoccerAnalysis({evidence,now:cutoff});
  assert.equal(JSON.stringify(evidence),before,'display attachment cannot mutate provider evidence');
  assert.equal(analysis.analysisCutoff,source.fetchedAt);assert.equal(analysis.observedAt,source.fetchedAt);
  assert.equal(analysis.shotXgResearch.analysisCutoff,analysis.analysisCutoff);
  assert.deepEqual(analysis.shotXgResearch.gameContext,{sourceId:normalizedGame.sourceId,date:normalizedGame.date,startTime:normalizedGame.startTime,
    homeSourceId:normalizedGame.home.sourceId,awaySourceId:normalizedGame.away.sourceId});
  assert.equal(analysis.formalScoringEnabled,false);assert.equal(analysis.executable,false);
  assert.equal(analysis.prediction,null,'replayed poststart payload cannot acquire a prematch distribution');
  assert.ok(analysis.directions.every(direction=>direction.W===null&&direction.R===null&&direction.score===null&&direction.eligible===false&&direction.executable===false));
  for(const key of ['W','R','S'])assert.equal(analysis.shotXgResearch[key],null);
  assert.equal(soccerShotXgViewRenderable(analysis.shotXgResearch,normalizedGame,analysis.analysisCutoff),true);
  return analysis;
}
const currentEpl=replay('epl',now),currentUcl=replay('ucl',now),olderEpl=replay('epl',at-1);
assert.equal(currentEpl.shotXgResearch.status,'RESEARCH_AVAILABLE');
assert.deepEqual(currentEpl.shotXgResearch.report,bundle.reports.epl);
assert.equal(currentUcl.shotXgResearch.status,'NO_LEAGUE_COHORT');assert.equal(currentUcl.shotXgResearch.report,null);
assert.equal(olderEpl.shotXgResearch.status,'NOT_AVAILABLE_AT_CUTOFF');assert.equal(olderEpl.shotXgResearch.report,null);
assert.equal(soccerShotXgViewRenderable(currentEpl.shotXgResearch,olderEpl.evidence.game,olderEpl.analysisCutoff),false,
  'real same-game newer projection cannot be borrowed into an older saved analysis');
console.log('PASS real frozen shot-xG display projection: pinned artifact identity, future/backdated/forged-source rejection, exact game/cutoff binding, UCL no-cohort isolation and actual JSX; no current npxG or formal authority');
