import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { loadSoccerShotXgResearchUiForTest } from './helpers/soccer-shot-xg-ui-fixture.mjs';
const shotXgUi=await loadSoccerShotXgResearchUiForTest(React);
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { buildSoccerAnalysis } from '../lib/soccer/analysis.js';
import { buildSoccerRequirementAudit } from '../lib/soccer/requirements.js';
import { soccerMatchContextObservations } from '../lib/soccer/match-context-observations.js';

const find = (audit,key) => audit.layers.flatMap(layer=>layer.items).find(item=>item.key===key);
function fixture(league, poststart=false) {
  const payload=JSON.parse(fs.readFileSync(new URL(`./fixtures/soccer/${league}-summary.json`,import.meta.url)));
  const competition=payload.header.competitions[0],now=Date.parse(competition.date)+(poststart?60000:-60000);
  const source={provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/soccer/${payload.header.league.slug}/summary?event=${payload.header.id}`,
    fetchedAt:new Date(now).toISOString(),contentHash:createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
  const game=normalizeSoccerSchedule({leagues:[payload.header.league],events:[{...payload.header,date:competition.date,status:competition.status}]},league,source).games[0];
  return {evidence:normalizeSoccerPrematch(payload,game,source,now),now};
}
const src=fs.readFileSync('app/soccer/model-development-panel.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
const compiled=await transform(src,{filename:'model-development.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const ctx=vm.createContext({...shotXgUi,React,soccerMatchContextObservations});vm.runInContext(compiled.code,ctx);
function render(evidence) {
  const game=evidence.game,conditions={version:'SOCCER-SCHEDULE-CONGESTION-POISSON-RIDGE-RESEARCH-v1',gameId:game.id,league:game.league,formalEligible:false,modelEffectApplied:false};
  return renderToStaticMarkup(React.createElement(ctx.SoccerModelDevelopmentPanel,{conditions,evidence,game}));
}
for(const league of ['epl','ucl']) {
  const {evidence,now}=fixture(league),before=JSON.stringify(evidence);
  assert.equal(evidence.ok,true);
  const context=soccerMatchContextObservations(evidence),audit=buildSoccerRequirementAudit({evidence});
  assert.equal(context.venue.id,evidence.venueObservation.value.id);
  assert.equal(find(audit,'weatherVenue').status,'PARTIAL');
  assert.equal(find(audit,'weatherVenue').modelUsage,'OBSERVED_ONLY');
  assert.match(find(audit,'weatherVenue').reason,/球場名稱與身分.*天氣預報.*待補/);
  const markup=render(evidence);
  assert.ok(markup.includes(context.venue.name));
  assert.match(markup,/旅行、天氣.*尚未完整建模/);
  assert.equal(audit.formalReady,false);
  if(league==='ucl') {
    assert.equal(context.uclPhase.phase,'LEAGUE_PHASE');
    assert.equal(find(audit,'competition').status,'PARTIAL');
    assert.match(find(audit,'competition').reason,/聯賽階段.*總比分不適用.*尚未驗證/);
    assert.match(markup,/來源記載賽事階段：歐冠聯賽階段/);
    const analysis=buildSoccerAnalysis({evidence,now});
    assert.ok(analysis.missing.some(item=>item.label==='歐冠跨聯賽強度與階段效果'&&item.reason==='UCL_DOMESTIC_STRENGTH_AND_PHASE_EFFECTS_UNVERIFIED'));
    assert.ok(!analysis.missing.some(item=>item.label==='歐冠階段、回合與跨聯賽強度'));
    assert.equal(analysis.formalScoringEnabled,false);assert.equal(analysis.W,undefined);
  } else assert.equal(context.uclPhase,null);
  const legacy=structuredClone(evidence);delete legacy.venueObservation;delete legacy.uclPhaseObservation;
  assert.equal(find(buildSoccerRequirementAudit({evidence:legacy}),'weatherVenue').status,'UNKNOWN');
  if(league==='ucl')assert.equal(find(buildSoccerRequirementAudit({evidence:legacy}),'competition').status,'UNKNOWN');
  assert.doesNotMatch(render(legacy),/來源記載場地|來源記載賽事階段/);
  for(const mutate of [
    e=>{e.venueObservation.source.scope.gameId='soccer:ucl:999';},
    e=>{e.venueObservation.source.scope.league=league==='ucl'?'epl':'ucl';},
    e=>{e.venueObservation.source.contentHash='0'.repeat(64);},
    e=>{e.venueObservation.source.fetchedAt=new Date(now+60000).toISOString();},
    e=>{e.venueObservation.sourceEvidence.observedAvailabilityVerified=false;},
    e=>{e.venueObservation.sourceEvidence.field='uclPhaseObservation';},
    e=>{e.venueObservation.formalEligible=true;},
    e=>{e.venueObservation.value.name='<invalid>';},
  ]) {
    const wrong=structuredClone(evidence);mutate(wrong);
    assert.equal(soccerMatchContextObservations(wrong).venue,null);
    assert.equal(find(buildSoccerRequirementAudit({evidence:wrong}),'weatherVenue').status,'UNKNOWN');
    assert.doesNotMatch(render(wrong),/來源記載場地/);
  }
  const wrongGame=structuredClone(evidence.game);wrongGame.startTime=new Date(Date.parse(wrongGame.startTime)+60000).toISOString();
  assert.equal(soccerMatchContextObservations(evidence,wrongGame).venue,null);
  if(league==='ucl')for(const mutate of [
    e=>{e.uclPhaseObservation.value.providerSeasonType=999;},
    e=>{e.uclPhaseObservation.value.providerSeasonYear=2025;},
    e=>{e.uclPhaseObservation.source.scope.gameId='soccer:ucl:999';},
    e=>{e.uclPhaseObservation.source.contentHash='0'.repeat(64);},
    e=>{e.uclPhaseObservation.modelEffectApplied=true;},
  ]) {
    const wrong=structuredClone(evidence);mutate(wrong);
    assert.equal(soccerMatchContextObservations(wrong).uclPhase,null);
    assert.equal(find(buildSoccerRequirementAudit({evidence:wrong}),'competition').status,'UNKNOWN');
    assert.doesNotMatch(render(wrong),/來源記載賽事階段/);
  }
  const after=fixture(league,true).evidence;
  assert.equal(soccerMatchContextObservations(after).poststart,true);
  assert.match(find(buildSoccerRequirementAudit({evidence:after}),'weatherVenue').reason,/賽後來源/);
  assert.match(render(after),/賽後來源記載場地/);
  assert.equal(JSON.stringify(evidence),before,'audit and UI do not modify normalized source evidence');
}
console.log('PASS bound EPL/UCL match context: real normalizer → partial requirements → actual JSX, wrong event/league/source/time/phase rejected, poststart explicit, legacy unknown and formal gates unchanged');
