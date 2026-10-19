import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { gzipSync,gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fetchSoccerHistoryYear } from '../lib/soccer/history.js';
import { fitScoreModel,evaluateScoreModel } from '../lib/soccer/score-model.js';

const root=path.resolve('research/soccer'),cache=path.join(root,'sources');fs.mkdirSync(cache,{recursive:true});
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const retainedOnly=process.argv.includes('--retained-only');
const previous=retainedOnly?JSON.parse(fs.readFileSync(path.join(root,'baseline.json'),'utf8')):null;
const metricDrifts=[];
function sameMetricValue(actual,expected,label){
 if(typeof expected==='number'&&Number.isFinite(expected)&&!Number.isInteger(expected)&&typeof actual==='number'&&Number.isFinite(actual)){
  const difference=actual-expected,bound=16*Number.EPSILON*Math.max(1,Math.abs(expected),Math.abs(actual));
  assert.ok(Math.abs(difference)<=bound,`BASELINE_METRIC_FLOAT_CHANGED_${label}`);
  if(difference!==0)metricDrifts.push({label,old:expected,actual,difference,bound});
 }else if(expected&&typeof expected==='object'){
  assert.ok(actual&&typeof actual==='object',`BASELINE_METRIC_SHAPE_CHANGED_${label}`);
  if(Array.isArray(expected))assert.equal(actual.length,expected.length,`BASELINE_METRIC_LENGTH_CHANGED_${label}`);
  for(const key of Object.keys(expected))sameMetricValue(actual[key],expected[key],`${label}.${key}`);
 }else assert.deepEqual(actual,expected,`BASELINE_METRIC_CHANGED_${label}`);
}
// Added audit fields may differ; the previously published metric values and
// original evaluation/exclusion ledger must not change during an audit replay.
function sameMetrics(actual,expected,label){
 for(const key of Object.keys(expected))if(!['games','probabilityAudit'].includes(key))sameMetricValue(actual[key],expected[key],`${label}.${key}`);
 assert.equal(actual.games.length,expected.games.length,'BASELINE_EVALUATION_POPULATION_CHANGED');
 expected.games.forEach((game,i)=>{for(const key of Object.keys(game))sameMetricValue(actual.games[i][key],game[key],`${label}.games.${i}.${key}`);});
}
// Freeze experiment boundaries before fitting; 2025 labels never select a model.
const protocol={version:'SOCCER-RETROSPECTIVE-PROTOCOL-v1',trainingBefore:'2024-01-01T00:00:00.000Z',validationBefore:'2025-01-01T00:00:00.000Z',testBefore:'2026-01-01T00:00:00.000Z',liveTrainingBefore:'2026-10-18T00:00:00.000Z',halfLives:[180,365,730],penalties:[.002,.01],period:'REGULATION_FT',selectionMetric:'validation 1X2 log loss',formalPromotion:false,assumedResultLagHours:24,pointInTimeAvailabilityVerified:false};
if(retainedOnly)assert.equal(previous.protocolHash,hash(protocol),'BASELINE_PROTOCOL_CHANGED');
const results={};
for(const league of ['epl','ucl']){
 const sources=[];let rows,history;
 if(retainedOnly){
  const retained=JSON.parse(gunzipSync(fs.readFileSync(path.join(root,`${league}-history.json.gz`))));
  rows=retained.rows;history=previous.leagues[league].history;
  assert.equal(hash(rows),history.trainingHash,'BASELINE_RETAINED_ROWS_CHANGED');
  assert.deepEqual(retained.excluded,history.excluded,'BASELINE_EXCLUSIONS_CHANGED');
  assert.equal(rows.length,history.accepted,'BASELINE_HISTORY_COUNT_CHANGED');
  console.log('RETAINED_SOURCE',league,rows.length,history.trainingHash);
 }else{for(let year=2021;year<=2026;year++){
  const file=path.join(cache,`${league}-${year}.json`);let r;
  if(fs.existsSync(file))r=JSON.parse(fs.readFileSync(file));if(r?.normalizerVersion!=='SOCCER-HISTORY-v1.1'){r=await fetchSoccerHistoryYear(league,year,{timeoutMs:20000});if(!r.ok)throw Error(JSON.stringify(r));fs.writeFileSync(file,JSON.stringify(r));}
  sources.push(r);console.log('SOURCE',league,year,JSON.stringify(r.coverage));
 }
 rows=sources.flatMap(s=>s.rows).sort((a,b)=>a.startTime.localeCompare(b.startTime));
 history={received:sources.reduce((n,s)=>n+s.coverage.received,0),accepted:rows.length,excluded:sources.flatMap(s=>s.excluded),sources:sources.map(s=>({year:s.year,source:s.source,coverage:s.coverage})),trainingHash:hash(rows)};
 }
 const before=(r,cutoff)=>Date.parse(r.startTime)+86400000<Date.parse(cutoff);
 const training=rows.filter(r=>before(r,protocol.trainingBefore)),validation=rows.filter(r=>r.startTime>=protocol.trainingBefore&&r.startTime<protocol.validationBefore),test=rows.filter(r=>r.startTime>=protocol.validationBefore&&r.startTime<protocol.testBefore);
 const trials=[];for(const halfLifeDays of protocol.halfLives)for(const penalty of protocol.penalties){
  const model=fitScoreModel(training,{league,cutoff:protocol.trainingBefore,halfLifeDays,penalty,maxIterations:6000,tolerance:1e-6});const metrics=evaluateScoreModel(model,validation,{fold:'validation-2024'});trials.push({halfLifeDays,penalty,fit:model.fit,metrics});console.log('TRIAL',league,halfLifeDays,penalty,model.fit.converged,metrics.logLoss,metrics.coverage);
 }
 const eligible=trials.filter(x=>x.fit.converged&&x.metrics.count>0).sort((a,b)=>a.metrics.logLoss-b.metrics.logLoss);if(!eligible.length)throw Error('NO_CONVERGED_VALIDATION_MODEL');
 const selected={halfLifeDays:eligible[0].halfLifeDays,penalty:eligible[0].penalty};
 const fit=(rs,cutoff,dependence=true)=>fitScoreModel(rs,{league,cutoff,...selected,maxIterations:6000,tolerance:1e-6,dependence});
 const testModel=fit(rows.filter(r=>before(r,protocol.validationBefore)),protocol.validationBefore),testMetrics=evaluateScoreModel(testModel,test,{fold:'diagnostic-2025'});
 const independent=fit(rows.filter(r=>before(r,protocol.validationBefore)),protocol.validationBefore,false),independentMetrics=evaluateScoreModel(independent,test,{fold:'diagnostic-2025'});
 const liveModel=fit(rows.filter(r=>before(r,protocol.liveTrainingBefore)),protocol.liveTrainingBefore);
 if(retainedOnly){
  const old=previous.leagues[league];assert.deepEqual(selected,old.selected,'BASELINE_SELECTION_CHANGED');
  assert.deepEqual(liveModel,old.liveModel,'BASELINE_LIVE_MODEL_CHANGED');
  assert.equal(hash(testModel),old.test.modelHash,'BASELINE_TEST_MODEL_CHANGED');
  sameMetrics(testMetrics,old.test.metrics,`${league}.diagnostic`);sameMetrics(independentMetrics,old.test.independentPoisson,`${league}.independent`);
  assert.equal(trials.length,old.trials.length,'BASELINE_TRIAL_COUNT_CHANGED');
  trials.forEach((trial,i)=>{assert.deepEqual(trial.fit,old.trials[i].fit,'BASELINE_TRIAL_FIT_CHANGED');sameMetrics(trial.metrics,old.trials[i].metrics,`${league}.trial.${i}`);});
  console.log('UNCHANGED_MODEL_GUARD',league,JSON.stringify({liveModelHash:hash(liveModel),trainingHash:liveModel.trainingHash,testModelHash:hash(testModel)}));
 }
 // Separate competition fits. No EPL strength parameters are silently reused for UCL.
 results[league]={protocolHash:hash(protocol),selected,trialCount:trials.length,trials,test:{cutoff:protocol.validationBefore,metrics:testMetrics,independentPoisson:independentMetrics,modelHash:hash(testModel),interpretation:'RETROSPECTIVE_SCORE_TEST_NOT_TRADING_OR_PIT_PROOF'},liveModel,history,limitations:['No xG, personnel, weather or referee features fitted','UCL has no domestic-league strength mapping; competition-stage mixture is unadjusted','No half-time model, settlement verification, executable market or betting return','Historical scores backfilled now; historical availability and endpoint completeness are unverified','Unseen teams fail closed; coverage and excluded fixtures are retained','Single chronological split only; rolling walk-forward, uncertainty intervals and market baseline remain unverified']};
 if(!retainedOnly)fs.writeFileSync(path.join(root,`${league}-history.json.gz`),gzipSync(JSON.stringify({rows,excluded:results[league].history.excluded}),{mtime:0}));
 console.log('RESEARCH',league,JSON.stringify({selected,testCount:testMetrics.count,total:testMetrics.total,logLoss:testMetrics.logLoss,brier:testMetrics.brier,liveConverged:liveModel.fit.converged}));
}
const artifact={version:'SOCCER-RESEARCH-ARTIFACT-v2',createdAt:new Date().toISOString(),protocol,protocolHash:hash(protocol),probabilityAuditProtocol:results.epl.test.metrics.probabilityAudit.version,leagues:results,formalScoringEnabled:false,executable:false};
fs.writeFileSync(path.join(root,'protocol.json'),JSON.stringify(protocol,null,2)+'\n');
fs.writeFileSync(path.join(root,'baseline.json'),JSON.stringify(artifact,null,2)+'\n');
console.log('SAVED',path.join(root,'baseline.json'));
if(retainedOnly)console.log('METRIC_FLOAT_DIFFERENCES',JSON.stringify(metricDrifts));

const frozen={version:artifact.version,createdAt:artifact.createdAt,protocol:artifact.protocol,protocolHash:artifact.protocolHash,probabilityAuditProtocol:artifact.probabilityAuditProtocol,formalScoringEnabled:false,executable:false,leagues:Object.fromEntries(Object.entries(results).map(([league,r])=>[league,{selected:r.selected,liveModel:r.liveModel,test:{...r.test,metrics:{...r.test.metrics,games:undefined},independentPoisson:{...r.test.independentPoisson,games:undefined}},history:{received:r.history.received,accepted:r.history.accepted,excludedCount:r.history.excluded.length,sources:r.history.sources},limitations:r.limitations}]))};
frozen.contentHash=hash(frozen);fs.writeFileSync('lib/soccer/research-frozen.js','// Generated by scripts/soccer-research-build.mjs; retrospective research only.\nconst data='+JSON.stringify(frozen)+';\nexport function soccerResearchArtifacts(){return structuredClone(data); }\n');
