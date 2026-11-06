import { soccerMatchContextObservations } from '../lib/soccer/match-context-observations.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { evaluateSoccerQuote } from '../lib/soccer/market-payoff.js';
import { scoreDistribution } from '../lib/soccer/score-model.js';
const path='app/soccer/model-development-panel.js';
const source=fs.readFileSync(path,'utf8').replace(/^import .*?;\n/gm,'').replace('export function','function');
const {code}=await transform(source,{filename:path.replace('.js','.jsx'),jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const context=vm.createContext({React,soccerMatchContextObservations});vm.runInContext(code,context);
const game={id:'soccer:epl:123',league:'epl'};
const render=(minutes,conditions,matchXg)=>renderToStaticMarkup(React.createElement(context.SoccerModelDevelopmentPanel,{minutes,conditions,matchXg,game}));
assert.equal(render(null,null),'');
const minutes={version:'SOCCER-PRIOR-PARTICIPATION-MINUTES-RESEARCH-v1',gameId:game.id,league:'epl',formalEligible:false,modelEffectApplied:false,
 validation:{holdout:{model:{games:350,minuteMAE:23.9,logLoss:.75},baseline:{minuteMAE:18.1,logLoss:.80}}},
 teams:{home:{status:'RESEARCH_FORECAST_AVAILABLE',coverage:{recentVerifiedMatches:2},players:[{id:'1',name:'<not HTML>',startProbability:.6,appearanceProbability:.9,expectedMinutes:61.4}]},away:{status:'INSUFFICIENT_PRIOR_OBSERVATIONS'}}};
const conditions={version:'SOCCER-SCHEDULE-CONGESTION-POISSON-RIDGE-RESEARCH-v1',gameId:game.id,league:'epl',formalEligible:false,modelEffectApplied:false,
 validation:{test:{games:375,scoreLogLoss:2.9346},baselineTest:{scoreLogLoss:2.9259}},prediction:{homeRate:1.4,awayRate:1.1}};
const markup=render(minutes,conditions);
assert.match(markup,/&lt;not HTML&gt;/);assert.match(markup,/60\.0%/);assert.match(markup,/90\.0%/);assert.match(markup,/61\.4/);
assert.match(markup,/這一隊尚無分鐘預測/);assert.match(markup,/23\.90 分鐘，對照模型 18\.10 分鐘/);
assert.match(markup,/2\.9346，對照 2\.9259/,'worse measured results must be visible, not described as an improvement');
assert.match(markup,/傷停與出賽資格仍未知/);assert.match(markup,/不代表新的獨立驗收/);assert.match(markup,/尚未完整建模/);
assert.doesNotMatch(markup,/NaN|undefined|正式評分已完成|勝率提高|<not HTML>/);
for(const change of [{gameId:'soccer:ucl:123'},{league:'ucl'},{formalEligible:true},{modelEffectApplied:true},{version:'FORGED'}]) assert.equal(render({...minutes,...change},null),'');
const xg={version:'SOCCER-STATSBOMB-MATCH-XG-RESEARCH-v1',gameId:game.id,league:'epl',formalEligible:false,modelEffectApplied:false,status:'UNKNOWN',researchAvailable:true,
 researchCoverage:{firstMatchDate:'2015-08-08',lastMatchDate:'2016-05-17',games:379},researchMetrics:{test:{games:112,candidate:{mse:.4359},leagueMeanBaseline:{mse:.4606}}}};
assert.match(render(null,null,xg),/2015-08-08 ～ 2016-05-17/);assert.match(render(null,null,xg),/StatsBomb/);
assert.match(render(null,null,xg),/本場仍缺當季/);assert.match(render(null,null,xg),/0\.4359，聯盟均值對照 0\.4606/);
assert.equal(render(null,null,{...xg,gameId:'soccer:ucl:123'}),'');
const marketSource=fs.readFileSync('app/soccer/market-panel.js','utf8').replace(/^import .*$/gm,'').replace(/export function/g,'function');
const compiledMarket=await transform(marketSource,{filename:'market-panel.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const marketContext=vm.createContext({React,soccerMatchContextObservations});vm.runInContext(compiledMarket.code,marketContext);
const payoff=evaluateSoccerQuote({quote:{period:'FT',kind:'HANDICAP',sourceLine:'0',direction:'HOME',lineSide:'home',water:.9,waterFormat:'PROFIT_PER_UNIT'},
 distribution:scoreDistribution(1.4,1.1,0),contract:{period:'FT',type:'CREDIT_BOUNDARY',labelMapping:{home:'Home',away:'Away'},rebate:{rate:.01,basis:'SETTLED_PRINCIPAL'},provenance:{status:'ASSUMPTION'}}});
const certified=payoff.certifiedDifferencePayoff;
assert.ok(certified);
const renderTail=value=>renderToStaticMarkup(React.createElement(marketContext.SoccerCertifiedDifference,{value}));
assert.match(renderTail(certified),/極端比分已納入數值核算/);assert.match(renderTail(certified),/不是正式 R 或 S/);
assert.equal(renderTail({...certified,sourceVerification:'FORGED'}),'');assert.equal(renderTail({...certified,arithmeticRoundingIncluded:false}),'');
console.log('PASS shipped model development UI: exact game/league/version gates, separate research forecasts, unknown squad coverage, visible adverse holdout/baseline comparisons and escaped names');
