import fs from 'node:fs';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { rollingSoccerFold,SOCCER_VALIDATION_PROTOCOL } from '../lib/soccer/validation.js';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const retainedOnly=process.argv.includes('--retained-only');
const previous=retainedOnly?JSON.parse(fs.readFileSync('research/soccer/validation.json','utf8')):null;
const metricDrifts=[];
function sameMetricValue(actual,expected,label){
 if(typeof expected==='number'&&Number.isFinite(expected)&&!Number.isInteger(expected)&&typeof actual==='number'&&Number.isFinite(actual)){
  const difference=actual-expected,bound=16*Number.EPSILON*Math.max(1,Math.abs(expected),Math.abs(actual));
  assert.ok(Math.abs(difference)<=bound,`ROLLING_METRIC_FLOAT_CHANGED_${label}`);
  if(difference!==0)metricDrifts.push({label,old:expected,actual,difference,bound});
 }else if(expected&&typeof expected==='object'){
  assert.ok(actual&&typeof actual==='object',`ROLLING_METRIC_SHAPE_CHANGED_${label}`);
  if(Array.isArray(expected))assert.equal(actual.length,expected.length,`ROLLING_METRIC_LENGTH_CHANGED_${label}`);
  for(const key of Object.keys(expected))sameMetricValue(actual[key],expected[key],`${label}.${key}`);
 }else assert.deepEqual(actual,expected,`ROLLING_METRIC_CHANGED_${label}`);
}
function sameMetrics(actual,expected,label){
 for(const key of Object.keys(expected))if(!['games','probabilityAudit'].includes(key))sameMetricValue(actual[key],expected[key],`${label}.${key}`);
 assert.equal(actual.games.length,expected.games.length,'ROLLING_EVALUATION_POPULATION_CHANGED');
 expected.games.forEach((game,i)=>{for(const key of Object.keys(game))sameMetricValue(actual.games[i][key],game[key],`${label}.games.${i}.${key}`);});
}
if(retainedOnly)assert.deepEqual(previous.protocol,SOCCER_VALIDATION_PROTOCOL,'ROLLING_PROTOCOL_CHANGED');
const results={};
for(const league of ['epl','ucl']){
 const {rows}=JSON.parse(gunzipSync(fs.readFileSync(`research/soccer/${league}-history.json.gz`)));const folds=[];
 if(retainedOnly)assert.equal(hash(rows),previous.leagues[league].inputHash,'ROLLING_RETAINED_ROWS_CHANGED');
 for(const year of SOCCER_VALIDATION_PROTOCOL.testYears){const fold=rollingSoccerFold(rows,league,year);folds.push(fold);console.log('ROLLING_FOLD',JSON.stringify({league,year,selected:fold.selected,count:fold.metrics.count,total:fold.metrics.total,logLoss:fold.metrics.logLoss,interval:fold.comparison.interval,intervalBelowZero:fold.comparison.intervalBelowZero}));}
 results[league]={inputHash:hash(rows),folds,repeatableImprovementEstablished:false,interpretation:'Per-year differences are diagnostics; source availability, calibration and betting evidence remain unverified'};
 if(retainedOnly){
  const old=previous.leagues[league];assert.equal(folds.length,old.folds.length,'ROLLING_FOLDS_CHANGED');
  folds.forEach((fold,i)=>{const original=old.folds[i];
   for(const key of ['testYear','selected','trainingHash','trainingCount'])assert.deepEqual(fold[key],original[key],`ROLLING_MODEL_CHANGED_${key}`);
   for(const key of ['trials','paired','comparison'])sameMetricValue(fold[key],original[key],`${league}.${fold.testYear}.${key}`);
   sameMetrics(fold.metrics,original.metrics,`${league}.${fold.testYear}.diagnostic`);sameMetrics(fold.referenceMetrics,original.referenceMetrics,`${league}.${fold.testYear}.reference`);
  });
  console.log('UNCHANGED_ROLLING_GUARD',league,JSON.stringify(folds.map(f=>({testYear:f.testYear,trainingHash:f.trainingHash,selected:f.selected}))));
 }
}
const report={version:'SOCCER-ROLLING-DIAGNOSTIC-ARTIFACT-v2',createdAt:new Date().toISOString(),protocol:SOCCER_VALIDATION_PROTOCOL,probabilityAuditProtocol:results.epl.folds[0].metrics.probabilityAudit.version,leagues:results,promotion:false};
fs.writeFileSync('research/soccer/validation-protocol.json',JSON.stringify(SOCCER_VALIDATION_PROTOCOL,null,2)+'\n');
fs.writeFileSync('research/soccer/validation.json',JSON.stringify(report,null,2)+'\n');
if(retainedOnly)console.log('METRIC_FLOAT_DIFFERENCES',JSON.stringify(metricDrifts));
const compact={...report,leagues:Object.fromEntries(Object.entries(results).map(([league,r])=>[league,{inputHash:r.inputHash,repeatableImprovementEstablished:false,interpretation:r.interpretation,folds:r.folds.map(({paired,metrics,referenceMetrics,...f})=>({...f,pairedCount:paired.length,metrics:{...metrics,games:undefined},referenceMetrics:{...referenceMetrics,games:undefined}}))}]))};
compact.contentHash=hash(compact);fs.writeFileSync('lib/soccer/validation-frozen.js','// Generated rolling retrospective diagnostics. Not a promotion certificate.\nconst data='+JSON.stringify(compact)+';\nexport function soccerValidationArtifacts(){return structuredClone(data);}\n');
