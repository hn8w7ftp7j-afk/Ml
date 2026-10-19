import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pairedBlockDifference,rollingSoccerFold } from '../lib/soccer/validation.js';
import { soccerValidationArtifacts } from '../lib/soccer/validation-frozen.js';
import { soccerResearchArtifacts } from '../lib/soccer/research-frozen.js';
import { evaluateScoreModel,predictScoreModel,soccerScoreLogProbability } from '../lib/soccer/score-model.js';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),a=soccerValidationArtifacts(),{contentHash,...body}=a;
assert.equal(hash(body),contentHash);assert.equal(a.protocol.promotion,false);assert.match(a.protocol.interpretation,/NOT_NEW_UNTOUCHED/);
for(const league of ['epl','ucl']){
 const {rows}=JSON.parse(gunzipSync(fs.readFileSync(`research/soccer/${league}-history.json.gz`)));assert.equal(hash(rows),a.leagues[league].inputHash);assert.equal(a.leagues[league].folds.length,3);assert.equal(a.leagues[league].repeatableImprovementEstablished,false);
 for(const f of a.leagues[league].folds){const valid=f.trials.filter(t=>t.converged&&t.validationCount>0).sort((a,b)=>a.validationLogLoss-b.validationLogLoss)[0];assert.deepEqual(f.selected,{halfLifeDays:valid.halfLifeDays,penalty:valid.penalty});assert.equal(f.metrics.count,f.referenceMetrics.count);assert.equal(f.pairedCount,f.metrics.count);assert.equal(f.formalPromotion,false);assert.equal(f.metrics.profit,null);}
 const final=a.leagues[league].folds.find(f=>f.testYear===2025),original=soccerResearchArtifacts().leagues[league].test.metrics;assert.equal(final.metrics.count,original.count);assert.equal(final.metrics.logLoss,original.logLoss);
}
const rows=JSON.parse(gunzipSync(fs.readFileSync('research/soccer/epl-history.json.gz'))).rows;
const grid={halfLives:[365],penalties:[.01]},fold=rollingSoccerFold(rows,'epl',2023,grid),altered=rows.map(r=>r.startTime>='2023-01-01T00:00:00.000Z'&&r.startTime<'2024-01-01T00:00:00.000Z'?{...r,homeGoals:30,awayGoals:0}:r),again=rollingSoccerFold(altered,'epl',2023,grid);
assert.deepEqual(fold.selected,again.selected);assert.equal(fold.trainingHash,again.trainingHash);assert.deepEqual(fold.trials,again.trials,'heldout labels cannot change an earlier parameter choice');assert.notEqual(fold.metrics.logLoss,again.metrics.logLoss);
const data=Array.from({length:20},(_,i)=>({eventId:String(i+1),startTime:new Date(Date.UTC(2025,0,1+i*7)).toISOString(),difference:i%2?.01:-.01}));
assert.deepEqual(pairedBlockDifference(data),pairedBlockDifference(data));assert.equal(pairedBlockDifference(data).intervalBelowZero,false);assert.equal(pairedBlockDifference([{...data[0],difference:-1}]).status,'INSUFFICIENT_BLOCKS');assert.throws(()=>pairedBlockDifference([data[0],data[0]]),/DUPLICATE/);
const model=soccerResearchArtifacts().leagues.epl.liveModel,ids=Object.keys(model.coefficients),r={eventId:'99999',league:'epl',homeId:ids[0],awayId:ids[1],startTime:'2026-10-21T12:00:00Z',homeGoals:30,awayGoals:0,period:'REGULATION_FT',source:{url:'https://fixture.invalid/score-result',contentHash:'rare-score-fixture'}};
const predicted=predictScoreModel(model,r);assert.equal(predicted.cells.some(c=>c.home===30&&c.away===0),false);
const metrics=evaluateScoreModel(model,[r]);assert.equal(metrics.count,1,'a rare valid score outside the retained grid must not disappear from the test cohort');assert.ok(Number.isFinite(metrics.scoreLogLoss));assert.ok(metrics.scoreLogLoss>50);
const regular={...r,homeGoals:1,awayGoals:0},only=evaluateScoreModel(model,[regular]),mixed=evaluateScoreModel(model,[regular,{...r,homeGoals:-1}]);assert.equal(mixed.count,1);assert.equal(mixed.logLoss,only.logLoss);assert.equal(mixed.brier,only.brier,'invalid rows cannot pollute a numerator before being excluded');
assert.throws(()=>soccerScoreLogProbability(1,-1,1,1),/SCORE_INVALID/);
console.log('PASS rolling validation: frozen source hashes, past-only parameter choice, unchanged choices under mutated future labels, paired game/week bootstrap, full rare-score accounting and invalid-row numerator isolation');
