import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { soccerScoringReadiness } from '../lib/soccer/scoring-readiness.js';
import { soccerScenarioScore } from '../lib/soccer/scenario-score.js';
import { deterministicScore } from '../lib/deterministic-score.js';
import { analyzeSoccerConditionalQuote } from '../lib/soccer/conditional-analysis.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { scoreSoccerQuote } from '../lib/soccer/soccer-scoring.js';
import { buildSoccerAnalysis } from '../lib/soccer/analysis.js';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { soccerDate } from '../lib/soccer/contracts.js';
const at='2026-10-18T13:35:00.000Z',now=Date.parse(at);
const payload=JSON.parse(fs.readFileSync('scripts/fixtures/soccer/epl-summary.json'));
const source={provider:'ESPN',url:'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=401878769',fetchedAt:at,contentHash:'retained-provider-fixture'};
const event=payload.header.competitions[0];
const game=normalizeSoccerSchedule({leagues:[payload.header.league],events:[{...payload.header,date:event.date,status:event.status}]},'epl',source).games[0];
const receipt={revision:'b'.repeat(64),observationId:'c'.repeat(64),observedAt:at,firstFetchedAt:at,receivedAt:at,persistedAt:at,sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/'};
const markets=['FT','HT'].flatMap(period=>['HANDICAP','TOTAL'].map(kind=>({unit:'GOALS',kind,period,line:'1.5',lineSide:kind==='HANDICAP'?'home':null,homeWater:.9,awayWater:.9,overWater:.9,underWater:.9,rawRows:['1.5 0.9','0.9'],periodEvidence:{period,status:'EXPLICIT',sectionTitle:'英格蘭超級聯賽',tableHeaders:[period==='FT'?'全場':'上半場'],marketHeader:period==='FT'?'全場':'上半場'}})));
const matched={officialGameId:game.id,league:'EPL',boardDate:game.date,prestart:true,matchStatus:'MATCHED',markets};
const quotes=buildSoccerMarketDirections({game,reader:receipt,now,matchedGames:[matched]}).flatMap(d=>d.quotes);
assert.equal(quotes.length,8);
const grid=period=>({league:'epl',gameId:game.id,period:period==='FT'?'REGULATION_FT':'REGULATION_HT',modelVersion:'TEST_ONLY',trainingHash:'d'.repeat(64),trainedThrough:'2026-10-17T00:00:00Z',cells:[{home:2,away:0,probability:.6},{home:0,away:0,probability:.4}],retainedMass:1,tailMass:0});

for(const quote of quotes){
 const scenarios=[.5,.5].map((weight,i)=>({id:`s${i}`,weight,league:game.league,gameId:game.id,period:quote.period,distribution:{...grid(quote.period),cells:[{home:2,away:0,probability:i===0?.2:.8},{home:0,away:0,probability:i===0?.8:.2}]}}));
 const research={status:'RESEARCH_ONLY',formalEnabled:false,executable:false,createdAt:'2026-10-17T00:00:00Z',artifactHash:'a'.repeat(64),protocolHash:'b'.repeat(64),periods:{[quote.period]:{status:'RESEARCH_SCENARIOS_AVAILABLE',attempted:2,count:2,failed:0,weightsRenormalized:false,scenarios}}};
 const input={quote,distribution:grid(quote.period),game,research,now};
 const r=soccerScenarioScore(input);
 assert.equal(r.status,'PARAMETER_SENSITIVITY_ONLY',JSON.stringify(r));
 assert.equal(r.scenarioCount,2); assert.equal(r.weightSum,1);
 const expected=scenarios.map(s=>analyzeSoccerConditionalQuote({...input,distribution:s.distribution}).exactNetReturn);
 assert.ok(Math.abs(r.meanNetReturn-(expected[0]+expected[1])/2)<1e-12);
 assert.equal(r.stressReturn,Math.min(...expected));
 const point=deterministicScore({weightedEV:(expected[0]+expected[1])/2,robustEV:Math.min(...expected),executable:false}).score;
 assert.ok(r.scoreLower<=point&&point<=r.scoreUpper);
 assert.equal(r.score,r.scoreLower===r.scoreUpper?r.scoreLower:null);
 for(const key of ['W','R','S','modelErrorMargin'])assert.equal(r[key],null);
 assert.equal(r.formalEligible,false);assert.equal(r.executable,false);
 const reject=mutate=>{const x=structuredClone(input);mutate(x);assert.equal(soccerScenarioScore(x).status,'UNAVAILABLE');};
 reject(x=>x.research.periods[quote.period].failed=1);
 reject(x=>x.research.periods[quote.period].scenarios.pop());
 reject(x=>x.research.periods[quote.period].scenarios[0].weight=.1);
 reject(x=>x.research.periods[quote.period].scenarios[0].league='ucl');
 reject(x=>x.research.periods[quote.period].scenarios[0].id='s1');
 reject(x=>x.research.createdAt='2027-01-01T00:00:00Z');
 reject(x=>x.now+=180001);
 reject(x=>x.research.periods[quote.period].scenarios[0].distribution.tailMass=.1);
}
console.log('PASS scenario score: real quote adaptation, all eight sides, direct payoff oracle, weighted lower-tail convention, original fixed formula, source freshness, league/period isolation, incomplete/tail rejection and no formal authority');

const uiSource=fs.readFileSync('app/soccer/market-panel.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
const {code}=await transform(uiSource,{filename:'soccer-market-ui.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const ctx=vm.createContext({React,Date});vm.runInContext(code,ctx);
const q=structuredClone(quotes[0]),distribution=grid(q.period);
q.conditionalAnalysis=analyzeSoccerConditionalQuote({quote:q,distribution,game,now});
q.scoring={provenance:{distributionHash:q.conditionalAnalysis.distributionHash}};
const scenarios=[{id:'only',weight:1,league:game.league,gameId:game.id,period:q.period,distribution}];
const research={status:'RESEARCH_ONLY',formalEnabled:false,executable:false,createdAt:'2026-10-17T00:00:00Z',artifactHash:'a'.repeat(64),protocolHash:'b'.repeat(64),periods:{[q.period]:{status:'RESEARCH_SCENARIOS_AVAILABLE',attempted:1,count:1,failed:0,weightsRenormalized:false,scenarios}}};
q.scenarioScore=soccerScenarioScore({quote:q,distribution,game,research,now});
const result={gameId:game.id,league:game.league,evidence:{game},prediction:distribution,observedAt:at,scenarioResearch:research};
const render=(quote=q,time=now)=>renderToStaticMarkup(ctx.SoccerConditionalAnalysis({quote,result,game,now:time}));
assert.match(render(),/情境試算分數/);assert.ok(render().includes(q.scenarioScore.scoreLower.toFixed(1)));assert.match(render(),/／10/);
assert.match(render(),/不是正式 S、不列正式排名/);
assert.match(render(q,now+180001),/歷史情境試算分數/);
for(const field of ['gameId','sourceQuoteKey','artifactHash','baselineDistributionHash']){
 const changed=structuredClone(q);changed.scenarioScore[field]='forged';assert.doesNotMatch(render(changed),/aria-label="情境試算分數"/);
}
const forged=structuredClone(q);forged.scenarioScore.S=8;assert.doesNotMatch(render(forged),/aria-label="情境試算分數"/);
console.log('PASS real scenario score JSX: numeric display, explicit limits, saved historical label, quote/game/model/artifact binding and formal-field tamper rejection');

// Actual committed scenario artifacts through the production analysis builder.
const liveAt='2026-11-01T08:00:00Z',liveNow=Date.parse(liveAt),future=structuredClone(payload);
future.header.competitions[0].date='2026-11-02T12:00:00Z';future.header.date=future.header.competitions[0].date;
const liveSource={...source,fetchedAt:liveAt};
const futureGame=normalizeSoccerSchedule({leagues:[future.header.league],events:[{...future.header,date:future.header.date,status:future.header.competitions[0].status}]},'epl',liveSource).games[0];
const liveReader={...receipt,observedAt:liveAt,firstFetchedAt:liveAt,receivedAt:liveAt,persistedAt:liveAt,league:'EPL',games:[{league:'EPL',boardDate:futureGame.date,boardTime:'20:00',homeKey:globalThis.Tai888SoccerTeams.key(futureGame.home.name),awayKey:globalThis.Tai888SoccerTeams.key(futureGame.away.name),markets}]};
const generated=buildSoccerAnalysis({evidence:normalizeSoccerPrematch(future,futureGame,liveSource,liveNow),reader:liveReader,now:liveNow});
const generatedQuotes=generated.directions.flatMap(d=>d.quotes);assert.equal(generatedQuotes.length,8);
for(const q of generatedQuotes){
 assert.equal(q.scenarioScore.status,'PARAMETER_SENSITIVITY_ONLY',JSON.stringify(q.scenarioScore));
 assert.equal(q.scenarioScore.scenarioCount,16);
 assert.ok(q.scenarioScore.scoreLower>=1&&q.scenarioScore.scoreUpper<=10);
 assert.ok(q.scenarioScore.scoreLower<=q.scenarioScore.scoreUpper);
 assert.equal(q.scoring.S,null);assert.equal(q.scenarioScore.formalEligible,false);
 const view=renderToStaticMarkup(ctx.SoccerConditionalAnalysis({quote:q,result:generated,game:futureGame,now:liveNow}));
 assert.match(view,/情境試算分數/);
}
console.log('PASS actual frozen 16-scenario FT/HT production analysis: all eight real adapted markets get bound-preserving numeric scores and real JSX, formal S and eligibility remain unchanged');
