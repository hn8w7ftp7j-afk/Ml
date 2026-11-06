// Real production identity gate: never run this test with the synthetic loader.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { deterministicScore, SCORE_FORMULA_VERSION } from '../lib/deterministic-score.js';
import { soccerQuoteScorePresentation } from '../lib/soccer/score-presentation.js';
import { soccerScoringReadiness, soccerQuoteScoringBlockers } from '../lib/soccer/scoring-readiness.js';
import { candidateFixture } from './helpers/soccer-candidate-fixture.mjs';
import { soccerReaderIdentityVerified } from '../lib/soccer/reader-identity-proof.js';

const now=Date.parse('2026-10-20T00:00:00Z'), at=new Date(now).toISOString();
const game={id:'soccer:epl:123',sourceId:'123',league:'epl',date:'2026-10-20',status:'scheduled',startTime:new Date(now+3600000).toISOString(),home:{name:'Home',sourceId:'359'},away:{name:'Away',sourceId:'364'}};
const W=.0435,R=.024,score=deterministicScore({weightedEV:W,robustEV:R,actualWater:true,qaPassed:true,executable:false}).score;
const result=candidateFixture({gameId:game.id,league:game.league,date:game.date,observedAt:at,persisted:true,publishedCurrent:true,analysisStatus:'COMPLETED',evidence:{game},formalScoringEnabled:true,qualification:{eligible:true},directions:[{period:'FT',direction:'TOTAL_OVER',eligible:true,score,W,R,qaFlag:'WARN',quotes:[{key:'original-quote',period:'FT',unit:'GOALS',kind:'TOTAL',side:'over',line:'3+50',lineSide:null,water:.95,fresh:true,prestart:true,provenance:{gameId:game.id,observedAt:at}}]}]},now);
const quote=result.directions[0].quotes[0];quote.scoring.scoreFormulaVersion=SCORE_FORMULA_VERSION;
assert.equal(soccerReaderIdentityVerified(result),false,'forged serialized proof cannot become authority');
const source=fs.readFileSync('app/soccer/market-panel.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
const {code}=await transform(source,{filename:'soccer-score-identity.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const ctx=vm.createContext({React,Date,soccerQuoteScorePresentation,soccerScoringReadiness,soccerQuoteScoringBlockers,SoccerRecordButton:()=>null});vm.runInContext(code,ctx);
for(const variant of ['legacy','forged']){
  const snapshot=structuredClone(result);if(variant==='legacy')delete snapshot.readerIdentityEvidence;
  const direction=snapshot.directions[0],q=direction.quotes[0],before=JSON.stringify(snapshot);
  for(const asOf of [now,now+180000]){
    const display=soccerQuoteScorePresentation({result:snapshot,direction,quote:q,displayGame:game,now:asOf});
    assert.deepEqual(display,{score,W,R,status:'IDENTITY_UNVERIFIED',label:'歷史值・場次身分未驗證，不列排名',tone:'muted',eligible:false});
    const readiness=soccerScoringReadiness(snapshot,asOf,game);
    assert.equal(readiness.scoredQuoteCount,0);assert.equal(readiness.qualifiedQuoteCount,0);
    assert.equal(readiness.historicalScoreCount,1);assert.equal(readiness.status,'SCORING_BLOCKED');
    assert.ok(readiness.blockers.some(b=>b.code==='READER_IDENTITY_UNVERIFIED'));
    const markup=renderToStaticMarkup(ctx.SoccerMarketDirections({directions:snapshot.directions,result:snapshot,game,now:asOf}));
    assert.match(markup,/歷史值・場次身分未驗證，不列排名/);assert.match(markup,/已有 S 分數 0 筆/);
    assert.match(markup,/目前符合排名 0 筆/);assert.doesNotMatch(markup,/正式評分已計算|通過排名門檻/);
  }
  assert.equal(JSON.stringify(snapshot),before,'audit and rendering cannot rewrite saved numbers');
}
console.log('PASS real identity gate: legacy and forged saved scores remain labeled historical, excluded from current score readiness and ranking without rewriting S/W/R');
