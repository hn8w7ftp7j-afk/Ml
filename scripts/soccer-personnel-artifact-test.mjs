import assert from 'node:assert/strict';
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {normalizeSoccerPersonnelHistory,soccerPersonnelHash} from '../lib/soccer/personnel-history.js';
import {fitSoccerPersonnelModel,evaluateSoccerPersonnelModel} from '../lib/soccer/personnel-model.js';
import {soccerPersonnelArtifacts} from '../lib/soccer/personnel-frozen.js';
import {soccerResearchArtifacts} from '../lib/soccer/research-frozen.js';
import {fitScoreModel,validateTrainingRows} from '../lib/soccer/score-model.js';

const root='research/soccer',load=file=>JSON.parse(gunzipSync(fs.readFileSync(`${root}/${file}`))),a=soccerPersonnelArtifacts(),{contentHash,...body}=a,original=soccerResearchArtifacts(),protocol=JSON.parse(fs.readFileSync(`${root}/personnel-protocol.json`)),collection=JSON.parse(fs.readFileSync(`${root}/personnel-collection.json`)),report=JSON.parse(fs.readFileSync(`${root}/personnel-baseline.json`));
assert.equal(contentHash,soccerPersonnelHash(body));assert.equal(a.protocolHash,soccerPersonnelHash(protocol));assert.equal(a.collectionHash,soccerPersonnelHash(collection));assert.equal(collection.protocolHash,a.protocolHash);assert.equal(a.formalEnabled,false);
const before=(r,t)=>Date.parse(r.startTime)+86400000<Date.parse(t);
for(const league of ['epl','ucl']){
 const originalRows=load(`${league}-history.json.gz`).rows,{rows,excluded}=load(`personnel-${league}-history.json.gz`),sources=load(`personnel-${league}-sources.json.gz`),model=a.leagues[league].model,byId=new Map(originalRows.map(r=>[r.eventId,r]));
 assert.equal(originalRows.length,rows.length+excluded.length);assert.equal(rows.length,collection.leagues[league].accepted);assert.equal(sources.length,rows.length);assert.equal(collection.leagues[league].rowsHash,soccerPersonnelHash(rows));
 assert.equal(collection.leagues[league].inputHash,soccerPersonnelHash(originalRows));
 const observed=new Map(rows.map(r=>[r.eventId,r]));
 for(const source of sources){assert.equal(source.source.contentHash,soccerPersonnelHash(source.data));assert.match(source.source.originalResponseHash,/^[a-f0-9]{64}$/);assert.equal(source.source.sourcePublishedAt,null);const replay=normalizeSoccerPersonnelHistory(byId.get(source.eventId),source.data,source.source);assert.equal(replay.ok,true);assert.deepEqual(replay.row,observed.get(source.eventId));}
 assert.equal(model.baselineHash,soccerPersonnelHash(original.leagues[league].liveModel));assert.deepEqual(model.baselineModel,original.leagues[league].liveModel);assert.equal(model.formalEnabled,false);assert.equal(a.leagues[league].defaultDistribution,'UNCHANGED_BASELINE');assert.equal(a.leagues[league].challengerDisplayOnly,true);
 const training=validateTrainingRows(rows.filter(r=>before(r,protocol.liveTrainingBefore)),league,protocol.liveTrainingBefore);assert.equal(model.trainingHash,soccerPersonnelHash(training));
 const reproduced=fitSoccerPersonnelModel(training,{league,cutoff:protocol.liveTrainingBefore,baselineModel:original.leagues[league].liveModel,penalty:a.leagues[league].selectedPenalty});assert.deepEqual(reproduced,model,'retained true source rows must reproduce the live shadow model exactly');
 const valid=report.leagues[league].validation.trials.filter(t=>t.fit.converged&&t.common.count>0&&Number.isFinite(t.common.logLoss)).sort((x,y)=>x.common.logLoss-y.common.logLoss||x.penalty-y.penalty);assert.equal(a.leagues[league].selectedPenalty,valid[0].penalty);
 assert.equal(a.leagues[league].validationPreferredModel,valid[0].common.logLoss<report.leagues[league].validation.reference.logLoss?'XI_CHALLENGER':'UNCHANGED_BASELINE');
 const diagnosticBaseline=fitScoreModel(originalRows.filter(r=>before(r,protocol.validationBefore)),{league,cutoff:protocol.validationBefore,...original.leagues[league].selected,maxIterations:6000,tolerance:1e-6}),diagnosticModel=fitSoccerPersonnelModel(rows.filter(r=>before(r,protocol.validationBefore)),{league,cutoff:protocol.validationBefore,baselineModel:diagnosticBaseline,penalty:a.leagues[league].selectedPenalty});
 const diagnosticRows=originalRows.filter(r=>r.startTime>=protocol.validationBefore&&r.startTime<protocol.diagnosticBefore).map(r=>observed.get(r.eventId)||r),replay=evaluateSoccerPersonnelModel(diagnosticModel,diagnosticRows,{fold:'personnel-retrospective-2025'});
 for(const key of ['sample','count','excluded','coverage','logLoss','brier','scoreLogLoss','baseline','probabilityAudit','games'])assert.deepEqual(replay[key],report.leagues[league].diagnostic[key],`retained diagnostic changed: ${league}/${key}`);
 assert.equal(replay.count,replay.baseline.count);assert.equal(replay.count,replay.probabilityAudit.cohort.used);assert.equal(replay.games.length,diagnosticRows.length);
 console.log(`PASS ${league}: ${sources.length} real source projections replay exactly; original baseline and live shadow coefficients/hashes are unchanged; all ${diagnosticRows.length} diagnostic fixtures stay in the denominator (${replay.count} usable)`);
}
console.log('PASS personnel artifacts: reproducible source/extraction/model/calibration chain, validation-only penalty choice, paired ablation, complete exclusion cohort, no formal promotion or historical PIT claim');
