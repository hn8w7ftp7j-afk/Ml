import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { buildSoccerAnalysis, soccerAnalysisHash } from '../lib/soccer/analysis.js';
import { soccerQuoteScorePresentation } from '../lib/soccer/score-presentation.js';
import { soccerScoringReadiness, soccerQuoteScoringBlockers } from '../lib/soccer/scoring-readiness.js';

const now=Date.parse('2026-10-18T13:35:00.000Z'),at=new Date(now).toISOString();
const sourceCode=fs.readFileSync('app/soccer/market-panel.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
const {code}=await transform(sourceCode,{filename:'soccer-score-readiness.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const ctx=vm.createContext({React,soccerQuoteScorePresentation,soccerScoringReadiness,soccerQuoteScoringBlockers,SoccerRecordButton:()=>null});
vm.runInContext(code,ctx);
for(const league of ['epl','ucl']){
  const p=JSON.parse(fs.readFileSync(`scripts/fixtures/soccer/${league}-summary.json`));
  const c=p.header.competitions[0],source={provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/soccer/${league==='epl'?'eng.1':'uefa.champions'}/summary?event=${p.header.id}`,fetchedAt:at,contentHash:'retained-provider-fixture'};
  const game=normalizeSoccerSchedule({leagues:[p.header.league],events:[{...p.header,date:c.date,status:c.status}]},league,source).games[0];
  const evidence=normalizeSoccerPrematch(p,game,source,now);
  const reader={league:league.toUpperCase(),boardDate:game.date,observedAt:at,firstFetchedAt:at,receivedAt:at,persistedAt:at,
    observationId:'a'.repeat(64),revision:'b'.repeat(64),sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/fixture',
    games:[{league:league.toUpperCase(),boardDate:game.date,boardTime:new Date(game.startTime).toLocaleTimeString('en-GB',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hour12:false}),homeKey:globalThis.Tai888SoccerTeams.key(game.home.name),awayKey:globalThis.Tai888SoccerTeams.key(game.away.name),
      markets:[{kind:'TOTAL',unit:'GOALS',line:'3+50',overWater:.95,underWater:.91,rawRows:['大3+50 0.95','小0.91'],period:'FT',
        periodEvidence:{period:'FT',status:'EXPLICIT',sectionTitle:league==='epl'?'英超 全場':'歐冠 全場',tableHeaders:['全場大小'],marketHeader:'全場大小'}}]}]};
  const result=buildSoccerAnalysis({evidence,reader,now});
  assert.equal(result.scoreReadiness.status,'SCORING_BLOCKED');
  assert.equal(result.scoreReadiness.quoteCount,2);
  assert.equal(result.scoreReadiness.scoredQuoteCount,0,'real shipped path must report zero, never the synthetic test score');
  assert.ok(result.scoreReadiness.blockers.some(value=>value.code==='SETTLEMENT_CONTRACT'));
  assert.ok(result.scoreReadiness.blockers.some(value=>value.code==='FOOTBALL_UNCERTAINTY'));
  assert.deepEqual(result.scoreReadiness,soccerScoringReadiness(result,now));
  const {analysisHash,...body}=result;
  assert.equal(analysisHash,soccerAnalysisHash(body),'readiness is included in the saved traceable payload');
  assert.equal(result.formalScoringEnabled,false);assert.equal(result.executable,false);
  const before=JSON.stringify(result);
  const markup=renderToStaticMarkup(ctx.SoccerMarketDirections({directions:result.directions,result,game,now}));
  assert.match(markup,/正式評分尚未完成/);
  assert.match(markup,/已收到盤口，但下列評分依據尚未補齊，目前無法產生 S 分數/);
  assert.match(markup,/重新分析目前只會更新比分研究與資料核對/);
  assert.match(markup,/八方向原盤 2 筆；已有 S 分數 0 筆/);
  assert.match(markup,/尚缺足球情境及模型誤差依據/);
  assert.match(markup,/足球派彩及退水適用條款未完整確認/);
  assert.doesNotMatch(markup,/undefined|NaN|Infinity|data-scoring-readiness="SCORES_AVAILABLE"/);
  assert.equal(JSON.stringify(result),before);
  const legacy=structuredClone(result);delete legacy.scoreReadiness;
  assert.deepEqual(soccerScoringReadiness(legacy,now),result.scoreReadiness,'legacy saved results explain their actual scorer stages');
  const changed={...game,startTime:new Date(Date.parse(game.startTime)+3600000).toISOString()};
  assert.ok(soccerScoringReadiness(result,now,changed).blockers.some(item=>item.code==='CONTEXT_CHANGED'));
  const blocked={...result,qaFlag:'BLOCKED'};
  assert.ok(soccerScoringReadiness(blocked,now).blockers.some(item=>item.code==='BLOCKED'));
}
assert.equal(soccerScoringReadiness(null).status,'NO_SCOPED_QUOTES');
assert.equal(soccerScoringReadiness({directions:[null,{}]}).quoteCount,0);
assert.equal(soccerQuoteScoringBlockers(null)[0].code,'SCORING_NOT_RUN');
assert.equal(soccerScoringReadiness({unassignedQuotes:[{},{}]}).unassignedQuoteCount,2);
console.log('PASS actual EPL/UCL model → original quote scoring → hashed readiness → shipped JSX; missing contracts/scenarios stay visible and no S is fabricated');
