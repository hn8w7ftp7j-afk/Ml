import {nbaMarketDisplayState} from '../lib/nba/market-display-state.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { NBA_TEAM_LABELS } from '../lib/nba/labels.js';
import { analyzeNbaOpening, openingMarket } from '../lib/nba/opening-model.js';
import { openingTraining } from '../lib/nba/opening-training.js';
import { defaultTraining } from '../lib/nba/analysis-training.js';
import { quarterTraining } from '../lib/nba/quarter-training.js';
import { openingBaseline, openingVariableAccepted } from '../lib/nba/opening-core.js';
import { validOpeningResult, nbaResultQuoteCurrent, mergeNbaAnalysisResults } from '../lib/nba/analysis-job-display.js';
import { nbaMarketScore } from '../lib/nba/market-score.js';
import { buildNbaShadowRanking, buildNbaShadowOrder } from '../lib/nba/shadow-ranking.js';
import { loadNbaAnalysis } from '../lib/nba/analysis-service.js';
import { buildNbaAnalysisCapture } from '../lib/nba/analysis-journal.js';
import { validNbaForwardCapture } from '../lib/nba/forward-validation.js';
import { ESPN_NBA_TEAMS } from '../lib/nba/identity.js';

const date='2026-10-21',now=Date.parse('2026-10-20T22:00:00Z'),at=new Date(now).toISOString();
const team=id=>({id:`nba:espn:team:${id}`,sourceId:String(id),abbreviation:ESPN_NBA_TEAMS[id],league:'NBA'});
const game={league:'NBA',id:'nba:espn:game:401999001',sourceId:'401999001',gamePk:401999001,taipeiDate:date,
  season:{year:2027,type:'regular'},seasonType:'regular',home:team(18),away:team(20),neutralSite:false,
  startTime:'2026-10-20T23:00:00Z',status:'scheduled',completed:false,timeConfirmed:true};
const quotes={fullTotal:{line:'232.5',overWater:.94,underWater:.94},fullRunline:{line:'5+75',lineSide:'home',homeWater:.95,awayWater:.95},
  firstHalfTotal:{line:'115+50',overWater:.94,underWater:.94},firstHalfRunline:{line:'2+50',lineSide:'home',homeWater:.95,awayWater:.95}};
const r=analyzeNbaOpening(game,quotes,{regularHistory:defaultTraining.history,halfHistory:quarterTraining.history});
assert.equal(r.status,'ready');assert.equal(r.modelVersion,'nba-regular-cross-season-v1');assert.equal(validOpeningResult(r,date),true);
assert.equal(r.executable,false);assert.equal(r.promotionEligible,false);assert.equal(r.strictPointInTime,false);
assert.equal(r.openingAnalysis.baseline.home.currentGames,0);assert.equal(r.openingAnalysis.baseline.away.currentGames,0);
assert.equal(r.marketAnalyses.fullTotal.status,'insufficient');assert.equal(r.marketAnalyses.firstHalfTotal.status,'insufficient');
for(const key of ['fullRunline','firstHalfRunline']){
  const m=r.marketAnalyses[key];assert.equal(m.status,'ready');assert.equal(m.rebateRate,.015);assert.equal(m.validatedBettingWinRate,null);
  assert.equal(m.sides.home.winProbability,m.sides.away.lossProbability);
  for(const s of Object.values(m.sides)){
    assert.ok(nbaMarketScore(s));assert.ok(Math.abs(s.winProbability+s.lossProbability+s.pushProbability-1)<1e-10);
    assert.equal(s.robustExpectedNet,Math.min(s.expectedNet,...s.scoreEvidence.seasons.map(v=>v.expectedNet)));
    const tampered=structuredClone(s);tampered.scoreEvidence.seasons[0].year=2027;assert.equal(nbaMarketScore(tampered),null);
  }
}
// Exact favorite reversal and the established credit settlement helper parity.
const fixed=Array.from({length:60},(_,i)=>({date:'2026-01-01',year:2026,errors:{fullMargin:0}}));
const m=openingMarket('fullRunline',{line:'3+50',lineSide:'away',awayWater:.95,homeWater:.95},{fullMargin:-3},fixed,date,true,2027);
assert.equal(m.sides.away.winProbability,1);assert.ok(Math.abs(m.sides.away.expectedNet-48.25)<1e-10);
assert.ok(Math.abs(m.sides.home.expectedNet+49.25)<1e-10);assert.equal(nbaMarketScore(m.sides.away),null,'one season cannot manufacture R/S');
assert.equal(analyzeNbaOpening({...game,league:'NHL'},quotes).status,'blocked');
assert.equal(analyzeNbaOpening({...game,seasonType:'preseason'},quotes).status,'blocked');
assert.equal(analyzeNbaOpening({...game,season:{year:2026},taipeiDate:'2026-01-01'},quotes).status,'insufficient','holdout cannot authorize a historical target');
const future=structuredClone(openingTraining);
future.history.push({...future.history[0],gameId:'nba:espn:game:999999999',year:2027,date,homeScore:999,homeHalf:999});
future.features.push({...future.features[0],gameId:'nba:espn:game:999999999',date,year:2027,actual:{fullTotal:999}});
future.observations.push({...future.observations[0],gameId:'nba:espn:game:999999999',date,year:2027,errors:{fullMargin:999}});
assert.deepEqual(analyzeNbaOpening(game,quotes,{trainingData:future}),analyzeNbaOpening(game,quotes),'same-day and future poison excluded');
const conflict={...defaultTraining.history[0],homeScore:999};
assert.equal(analyzeNbaOpening(game,quotes,{regularHistory:[conflict]}).status,'blocked');
const bad=structuredClone(openingTraining);bad.acceptance.fullTotal.accepted=true;
assert.equal(analyzeNbaOpening(game,quotes,{trainingData:bad}).marketAnalyses.fullTotal.status,'insufficient','caller acceptance flag cannot bypass failed holdout');
assert.equal(openingVariableAccepted({...openingTraining.validation.holdout.metrics.fullMargin,modelBrier:NaN}),false);
const baseline=openingBaseline(game,openingTraining.history,openingTraining.priorWeight);
const live={...openingTraining.history.at(-1),gameId:'nba:espn:game:999999991',date:'2026-10-20',year:2027,homeId:game.home.id,awayId:game.away.id,homeScore:120,awayScore:100,homeHalf:63,awayHalf:44};
const updated=openingBaseline(game,[...openingTraining.history,live],openingTraining.priorWeight);
assert.equal(updated.home.currentGames,1);assert.notEqual(updated.fullMargin,baseline.fullMargin,'current regular observations progressively update prior');
const payload={...r,league:'NBA',gameId:game.id,date,observedAt:at},row={game,quote:quotes,canAnalyze:true,observedAt:at,result:payload};
assert.equal(nbaResultQuoteCurrent(row,now),true);assert.equal(buildNbaShadowRanking([row],date,now).entries.length,4);
const ranked=buildNbaShadowRanking([row],date,now).entries;
for(const score of [7,7.1])assert.equal(buildNbaShadowOrder([{...ranked[0],score,expectedNet:2,robustExpectedNet:1}]).length,0);
assert.equal(buildNbaShadowOrder([{...ranked[0],score:7.2,expectedNet:2,robustExpectedNet:1}]).length,1);
assert.equal(buildNbaShadowRanking([{...row,quote:{...quotes,fullRunline:{...quotes.fullRunline,homeWater:1}}}],date,now).entries.length,0);
const batch={league:'NBA',date,results:[{ok:true,task:{nbaQuery:{id:game.sourceId,date,observedAt:at},game},payload}]};
assert.equal(mergeNbaAnalysisResults(batch,[row],date)[0].result.modelVersion,r.modelVersion);
const changed=structuredClone(payload);changed.openingAnalysis.validation.metrics.fullMargin.modelMAE=999;
assert.equal(validOpeningResult(changed,date),false);

// Exercise actual service routing without model injection and without network.
const readerRow={...quotes,league:'NBA',boardDate:date,boardTime:'07:00',captureKey:'nba-opening-fixture',marketStatus:'open',away:game.away,home:game.home};
const snapshot={league:'NBA',boardDate:date,observedAt:at,pageActivityAt:at,games:[readerRow],gameCount:1};
let saves=0;
const service=await loadNbaAnalysis({date,id:game.sourceId,observedAt:at},{now,loadSchedule:async()=>({league:'NBA',status:'ready',qa:{status:'WARNING'},sources:[{status:'ready'}],data:{games:[game]}}),
  analyzeOpeningTotals:null,
  loadReader:async()=>snapshot,loadTraining:async()=>({status:'ready',trainingData:defaultTraining,halfTraining:quarterTraining}),
  saveCapture:async a=>{saves++;const saved=buildNbaAnalysisCapture(a);assert.equal(validNbaForwardCapture({revision:saved.revision,payload:saved.payload,captured_at:at}),true);return{persisted:true,status:'saved',revision:saved.revision,capturedAt:at};}});
assert.equal(service.status,'ready');assert.equal(service.modelVersion,'nba-regular-cross-season-v1');assert.equal(saves,1);
assert.equal(service.scope,'NBA_validated_regular_cross_season_markets');assert.equal(service.persistence.persisted,true);

// Execute the shipped card JSX with actual model outputs and quote bindings.
const file='app/nba/main-workspace.js',source=fs.readFileSync(file,'utf8');
const helpers=source.slice(source.indexOf('const name ='),source.indexOf('const store ='));
const card=source.slice(source.indexOf('export function NbaGameCard'),source.indexOf('export default function')).replace('export function','function');
const {code}=await transform(helpers+card+'\nglobalThis.Card=NbaGameCard;',{filename:'nba-opening-card.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}},module:{type:'commonjs'}});
const scope={nbaMarketDisplayState,React,NBA_TEAM_LABELS,nbaResultQuoteCurrent,nbaMarketScore,NbaBetRecordButton:()=>React.createElement('button',null,'紀錄實際下注')};
vm.createContext(scope);vm.runInContext(code,scope);
const markup=renderToStaticMarkup(React.createElement(scope.Card,{row:{...row,jobState:'ready'},now,busy:false,onAnalyze:()=>{}}));
assert.match(markup,/開季分析/);assert.match(markup,/5\+75/);assert.match(markup,/232\.5/);assert.match(markup,/待驗證/);
assert.doesNotMatch(markup,/0／50|undefined|NaN|歷史節奏|全場大小除以二/);
console.log('PASS NBA opening: 2026 holdout market gates, 2027 warmup routing, exact credit settlement, 1.5% rebate, independent halftime, prior-only errors, no future leakage, source conflict blocking, progressive current inputs, scoring, freshness, ranking, job merging and durable forward capture');
