import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { scoreDistribution,fitScoreModel,predictScoreModel,evaluateScoreModel,validateTrainingRows } from '../lib/soccer/score-model.js';
import { soccerResearchArtifacts } from '../lib/soccer/research-frozen.js';
import { normalizeSoccerHistory } from '../lib/soccer/history.js';
const near=(a,b,e=1e-9)=>assert.ok(Math.abs(a-b)<e,`${a} != ${b}`);
for(const [h,a,rho]of [[1.7,.8,0],[1.7,.8,-.1],[.08,.03,.1],[25,20,0]]){
 const d=scoreDistribution(h,a,rho);near(d.retainedMass+d.tailMass,1);assert.ok(d.tailMass<=1e-12);near(Object.values(d.outcomes).reduce((a,b)=>a+b,0),d.retainedMass);assert.ok(d.cells.every(c=>c.probability>=0));near(d.cells.reduce((s,c)=>s+c.home*c.probability,0),h,1e-8);near(d.cells.reduce((s,c)=>s+c.away*c.probability,0),a,1e-8);assert.equal(d.halfTime,null);
}
assert.throws(()=>scoreDistribution(4,3,.5),/DEPENDENCE/);assert.throws(()=>scoreDistribution(0,1),/RATE/);assert.throws(()=>scoreDistribution(1,NaN),/RATE/);
const artifact=soccerResearchArtifacts(),{contentHash,...body}=artifact;
assert.equal(createHash('sha256').update(JSON.stringify(body)).digest('hex'),contentHash);
assert.equal(artifact.formalScoringEnabled,false);assert.equal(artifact.protocol.assumedResultLagHours,24);
for(const league of ['epl','ucl']){
 const history=JSON.parse(gunzipSync(fs.readFileSync(`research/soccer/${league}-history.json.gz`))),r=artifact.leagues[league];
 assert.ok(history.rows.length>500);assert.equal(history.rows.length,r.history.accepted);assert.equal(history.excluded.length,r.history.excludedCount);
 assert.ok(history.rows.every(x=>x.availability==='BACKFILLED_AT_COLLECTION_NOT_PREMATCH_SAVED'));
 const liveRows=history.rows.filter(x=>Date.parse(x.startTime)+86400000<Date.parse(artifact.protocol.liveTrainingBefore));
 const model=fitScoreModel(liveRows,{league,cutoff:artifact.protocol.liveTrainingBefore,...r.selected,maxIterations:6000,tolerance:1e-6});
 assert.equal(model.fit.converged,true);assert.deepEqual(model,r.liveModel,'Frozen coefficients must reproduce from retained history and protocol');
 const testRows=history.rows.filter(x=>x.startTime>=artifact.protocol.validationBefore&&x.startTime<artifact.protocol.testBefore),training=history.rows.filter(x=>Date.parse(x.startTime)+86400000<Date.parse(artifact.protocol.validationBefore));
 const testModel=fitScoreModel(training,{league,cutoff:artifact.protocol.validationBefore,...r.selected,maxIterations:6000,tolerance:1e-6}),metrics=evaluateScoreModel(testModel,testRows);
 assert.equal(metrics.total,r.test.metrics.total);assert.equal(metrics.count,r.test.metrics.count);near(metrics.logLoss,r.test.metrics.logLoss);near(metrics.brier,r.test.metrics.brier);assert.equal(metrics.profit,null);assert.equal(metrics.games.length,testRows.length);
 const game={league,startTime:'2026-10-21T13:00:00Z',homeId:Object.keys(model.coefficients)[0],awayId:Object.keys(model.coefficients)[1]},before=JSON.stringify(model),p=predictScoreModel(model,game);
 assert.equal(p.executable,false);assert.equal(p.status,'RESEARCH_ONLY');assert.equal(JSON.stringify(model),before,'Prediction cannot refit a frozen artifact');
 assert.throws(()=>predictScoreModel(model,{...game,league:league==='epl'?'ucl':'epl'}),/APPLICABLE/);assert.throws(()=>predictScoreModel(model,{...game,homeId:'99999999'}),/TEAM_NOT_TRAINED/);
 assert.throws(()=>fitScoreModel([...training,{...testRows[0],homeGoals:30}],{league,cutoff:artifact.protocol.validationBefore}),/TRAINING_ROW_INVALID/,'Heldout labels cannot enter the earlier fit');
 assert.throws(()=>validateTrainingRows([{...liveRows[0],startTime:'2026-10-17T23:00:00Z'}],league,artifact.protocol.liveTrainingBefore),/ROW_INVALID/,'24h result lag guards matches not completed by cutoff');
 assert.throws(()=>validateTrainingRows([liveRows[0],{...liveRows[0],homeGoals:liveRows[0].homeGoals+1}],league,artifact.protocol.liveTrainingBefore),/REVISION_CONFLICT/);
 console.log(`PASS ${league}: actual retained history -> frozen fit -> 2025 heldout metrics, no refit/foreign league/unknown team/late result/label leakage; ${metrics.count}/${metrics.total} evaluable`);
}
const source={url:'https://fixture.invalid/provider',contentHash:'real-extraction'},payload=JSON.parse(fs.readFileSync('scripts/fixtures/soccer/historic-scoreboard.json'));
assert.equal(normalizeSoccerHistory(payload,'epl',source,2025).rows.length,1);
const extra=structuredClone(payload);extra.events[0].competitions[0].status.type.name='STATUS_FINAL_AFTER_EXTRA_TIME';extra.events[0].competitions[0].status.period=4;assert.equal(normalizeSoccerHistory(extra,'epl',source,2025).excluded[0].reason,'REGULATION_SCORE_UNVERIFIED');
assert.equal(normalizeSoccerHistory(payload,'ucl',source,2025).ok,false);
console.log('PASS soccer math: adaptive tail bounds, probability/mean conservation, invalid dependence rejection, historical regulation/ET separation. No betting-return or completeness claim.');
