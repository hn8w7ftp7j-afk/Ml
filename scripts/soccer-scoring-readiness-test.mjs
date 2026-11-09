import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { buildSoccerAnalysis, soccerAnalysisHash } from '../lib/soccer/analysis.js';
import { soccerScenarioArtifacts } from '../lib/soccer/scenario-frozen.js';
import { soccerDate } from '../lib/soccer/contracts.js';
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
  // Positive arithmetic fixture models the service's separately bound schedule.
  evidence.scheduleSource={...source,url:`https://site.api.espn.com/apis/site/v2/sports/soccer/${league==='epl'?'eng.1':'uefa.champions'}/scoreboard?dates=${game.date.replaceAll('-','')}`,contentHash:'synthetic-scoreboard-source'};
  const reader={league:league.toUpperCase(),boardDate:game.date,observedAt:at,firstFetchedAt:at,receivedAt:at,persistedAt:at,
    observationId:'a'.repeat(64),revision:'b'.repeat(64),sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/fixture',
    games:[{league:league.toUpperCase(),boardDate:game.date,boardTime:new Date(game.startTime).toLocaleTimeString('en-GB',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hour12:false}),homeKey:globalThis.Tai888SoccerTeams.key(game.home.name),awayKey:globalThis.Tai888SoccerTeams.key(game.away.name),
      markets:[{kind:'TOTAL',unit:'GOALS',line:'3+50',overWater:.95,underWater:.91,rawRows:['大3+50 0.95','小0.91'],period:'FT',
        periodEvidence:{period:'FT',status:'EXPLICIT',sectionTitle:league==='epl'?'英超 全場':'歐冠 全場',tableHeaders:['全場大小'],marketHeader:'全場大小'}}]}]};
  const schedule={ok:true,league:{id:game.league},date:game.date,until:game.date,games:[game],coverage:{complete:true,identityComplete:true}};
  const result=buildSoccerAnalysis({evidence,reader,schedule,now});
  assert.equal(result.scoreReadiness.status,'SCORING_BLOCKED');
  assert.equal(result.scoreReadiness.quoteCount,2);
  assert.equal(result.scoreReadiness.scoredQuoteCount,0,'real shipped path must report zero, never the synthetic test score');
  assert.equal(result.scoringSystemReadiness.status,'BLOCKED');
  assert.equal(result.scoringSystemReadiness.league,league);
  assert.ok(result.scoringSystemReadiness.blockers.some(value=>value.code==='RUNTIME_INPUTS'));
  assert.equal(result.scoreReadiness.evidenceReadiness.status,'BLOCKED');
  assert.ok(result.scoreReadiness.blockers.some(value=>value.code==='PREDICTION_INPUT_UNAVAILABLE'));
  const formalBlockers=result.directions.flatMap(direction=>direction.quotes.flatMap(quote=>soccerQuoteScoringBlockers(quote.scoring)));
  assert.ok(formalBlockers.some(value=>value.code==='SETTLEMENT_CONTRACT'));
  assert.ok(formalBlockers.some(value=>value.code==='FOOTBALL_UNCERTAINTY'));
  assert.deepEqual(result.scoreReadiness,soccerScoringReadiness(result,now));
  const {analysisHash,...body}=result;
  assert.equal(analysisHash,soccerAnalysisHash(body),'readiness is included in the saved traceable payload');
  assert.equal(result.formalScoringEnabled,false);assert.equal(result.executable,false);
  const before=JSON.stringify(result);
  const markup=renderToStaticMarkup(ctx.SoccerMarketDirections({directions:result.directions,result,game,now}));
  assert.match(markup,/預測計算尚未完成/);
  assert.match(markup,/本次預測所需的來源、期間或計算內容仍待核對/);
  assert.match(markup,/更新有效原盤並重新分析/);
  assert.match(markup,/八方向原盤 2 筆；已有 S 分數 0 筆/);
  assert.match(markup,/預測所需的盤口、比分分布或計算內容尚未通過核對/);
  assert.match(markup,/目前符合排名 0 筆/);
  assert.match(markup,/只登記你已自行完成的下注，不代表通過排名/);
  assert.equal(result.scoreReadiness.qualifiedQuoteCount,0);
  assert.equal(result.scoreReadiness.historicalScoreCount,0);
  assert.equal(result.scoreReadiness.blockers.find(b=>b.code==='PREDICTION_INPUT_UNAVAILABLE').owner,'CURRENT_DATA');
  assert.doesNotMatch(markup,/undefined|NaN|Infinity|data-scoring-readiness="SCORES_AVAILABLE"/);
  assert.equal(JSON.stringify(result),before);
  const legacy=structuredClone(result);delete legacy.scoreReadiness;
  assert.deepEqual(soccerScoringReadiness(legacy,now),result.scoreReadiness,'legacy saved results explain their actual scorer stages');
  const changed={...game,startTime:new Date(Date.parse(game.startTime)+3600000).toISOString()};
  assert.ok(soccerScoringReadiness(result,now,changed).blockers.some(item=>item.code==='CONTEXT_CHANGED'));
  const blocked={...result,qaFlag:'BLOCKED'};
  assert.ok(soccerScoringReadiness(blocked,now).blockers.some(item=>item.code==='BLOCKED'));
  // Real source-trained scenario generator → saved compact analysis → actual JSX,
  // including an upcoming fixture without any Reader prices.
  const scenarioNow=Date.parse(soccerScenarioArtifacts().createdAt)+1000;
  const scenarioStart=new Date(scenarioNow+86400000).toISOString();
  const upcoming={...game,startTime:scenarioStart,date:soccerDate(scenarioStart),status:'scheduled'};
  const futureEvidence={...evidence,game:upcoming,phase:'PREMATCH_OBSERVATION',source:{...evidence.source,fetchedAt:new Date(scenarioNow).toISOString()}};
  const research=buildSoccerAnalysis({evidence:futureEvidence,reader:null,now:scenarioNow});
  assert.equal(research.scenarioResearch.status,'RESEARCH_ONLY');
  const scenarioMarkup=renderToStaticMarkup(ctx.SoccerScenarioResearch({result:research,game:upcoming,now:scenarioNow}));
  assert.match(scenarioMarkup,/本場參數變動研究/);
  for(const period of ['FT','HT']){
    const row=research.scenarioResearch.periods[period];
    assert.ok(row.count>0);
    assert.ok(scenarioMarkup.includes(`${period==='FT'?'全場':'上半場'}：已計算 ${row.count}／${row.attempted} 組`));
    assert.ok(scenarioMarkup.includes(row.parameterRanges.homeRate.min.toFixed(3)));
    assert.equal(Object.hasOwn(row,'scenarios'),false,'saved UI summary cannot duplicate score grids');
  }
  assert.equal(renderToStaticMarkup(ctx.SoccerScenarioResearch({result:research,game:{...upcoming,neutralSite:!upcoming.neutralSite},now:scenarioNow})), '');
  assert.match(scenarioMarkup,/不是信賴區間/);assert.match(scenarioMarkup,/預測 S 使用本次模型情境/);assert.match(scenarioMarkup,/完整模型誤差尚未驗證/);
  assert.equal(research.formalScoringEnabled,false);assert.equal(research.directions.flatMap(d=>d.quotes).length,0);
  assert.ok(research.scoreReadiness.evidenceReadiness.blockers.length>0,'missing formal model evidence must remain visible without any Reader quote');
  assert.ok(research.scoreReadiness.evidenceReadiness.blockers.some(item=>item.field==='weather'));
  assert.deepEqual(soccerScoringReadiness(research,scenarioNow+180001).evidenceReadiness,research.scoreReadiness.evidenceReadiness,
    'later viewing does not rewrite evidence availability at the saved analysis cutoff');
  const noQuotesMarkup=renderToStaticMarkup(ctx.SoccerMarketDirections({result:research,game:upcoming,now:scenarioNow}));
  assert.match(noQuotesMarkup,/本場參數變動研究/,'actual research work remains visible before original prices arrive');
  assert.match(noQuotesMarkup,/本次分析的正式資料缺項/);
  assert.match(noQuotesMarkup,/更新 Reader 不會補齊下列模型資料/);
  assert.match(renderToStaticMarkup(ctx.SoccerScenarioResearch({result:research,game:upcoming,now:scenarioNow+180001})),/已保存的參數變動研究/);
  for(const patch of [{gameId:'soccer:epl:999'},{formalEnabled:true},{createdAt:scenarioStart},{artifactHash:'invalid'}])
    assert.equal(renderToStaticMarkup(ctx.SoccerScenarioResearch({result:{...research,scenarioResearch:{...research.scenarioResearch,...patch}},game:upcoming,now:scenarioNow})), '');

}
assert.equal(soccerScoringReadiness(null).status,'NO_SCOPED_QUOTES');
assert.equal(soccerScoringReadiness({directions:[null,{}]}).quoteCount,0);
assert.equal(soccerQuoteScoringBlockers(null)[0].code,'SCORING_NOT_RUN');
assert.equal(soccerScoringReadiness({unassignedQuotes:[{},{}]}).unassignedQuoteCount,2);
console.log('PASS actual EPL/UCL model → original quote scoring → hashed readiness → shipped JSX; missing contracts/scenarios stay visible and no S is fabricated');

const noBundle=soccerQuoteScoringBlockers({inputBundle:{code:'SOCCER_SCORING_BUNDLE_MISSING'},stages:[{stage:'READER_QUOTE',status:'PASS'}]});
assert.equal(noBundle[0].owner,'SYSTEM');assert.match(noBundle[0].nextAction,/不需要使用者反覆更新 Reader/);
assert.equal(soccerQuoteScoringBlockers({inputBundle:{code:'__proto__'},stages:[{}]}).some(b=>b.code==='__proto__'),false);
