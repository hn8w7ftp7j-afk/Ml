import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { buildSoccerAnalysis, bindSoccerDistributionIdentity } from '../lib/soccer/analysis.js';
import { soccerResearchArtifacts } from '../lib/soccer/research-frozen.js';
import { soccerHalfTimeArtifacts } from '../lib/soccer/half-time-frozen.js';
import { predictScoreModel } from '../lib/soccer/score-model.js';
import { predictHalfTimeDistribution } from '../lib/soccer/half-time-model.js';

const at='2026-10-18T13:35:00.000Z',now=Date.parse(at);
const withoutScope=distribution=>{
  const {league,gameId,...values}=distribution;
  return values;
};
for(const league of ['epl','ucl']){
  const payload=JSON.parse(fs.readFileSync(`scripts/fixtures/soccer/${league}-summary.json`));
  const source={provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/soccer/${league==='epl'?'eng.1':'uefa.champions'}/summary?event=${payload.header.id}`,
    fetchedAt:at,contentHash:'retained-provider-fixture'};
  const competition=payload.header.competitions[0];
  const game=normalizeSoccerSchedule({leagues:[payload.header.league],events:[{...payload.header,date:competition.date,status:competition.status}]},league,source).games[0];
  const evidence=normalizeSoccerPrematch(payload,game,source,now);
  assert.equal(evidence.ok,true);
  const analysis=buildSoccerAnalysis({evidence,now});
  const rawFT=predictScoreModel(soccerResearchArtifacts().leagues[league].liveModel,{league,startTime:game.startTime,
    homeId:game.home.sourceId,awayId:game.away.sourceId,neutralSite:game.neutralSite});
  const rawHT=predictHalfTimeDistribution(rawFT,soccerHalfTimeArtifacts().leagues[league].liveModel,{league,startTime:game.startTime});
  for(const [period,raw,bound] of [['FT',rawFT,analysis.prediction],['HT',rawHT,analysis.halfTimePrediction]]){
    assert.equal(bound.league,league);
    assert.equal(bound.gameId,game.id);
    assert.equal(bound.period,period==='FT'?'REGULATION_FT':'REGULATION_HT');
    assert.deepEqual(withoutScope(bound),withoutScope(raw),'identity binding preserves the entire numeric distribution and model metadata');
    const before=JSON.stringify(raw);
    assert.deepEqual(bindSoccerDistributionIdentity(raw,game,period),bound);
    assert.equal(JSON.stringify(raw),before,'binding cannot mutate a generator output');
    assert.throws(()=>bindSoccerDistributionIdentity({...raw,league:league==='epl'?'ucl':'epl'},game,period),/SCOPE_MISMATCH/);
    assert.throws(()=>bindSoccerDistributionIdentity({...raw,gameId:`soccer:${league}:999999999`},game,period),/SCOPE_MISMATCH/);
    assert.throws(()=>bindSoccerDistributionIdentity(raw,game,period==='FT'?'HT':'FT'),/SCOPE_MISMATCH/);
    assert.throws(()=>bindSoccerDistributionIdentity(raw,{...game,id:`soccer:${league}:foreign`},period),/IDENTITY_INVALID/);
  }
  assert.equal(analysis.formalScoringEnabled,false);
  assert.equal(analysis.executable,false);
  assert.ok(analysis.directions.every(direction=>direction.score===null&&direction.W===null&&direction.R===null&&direction.eligible===false));
}
console.log('PASS actual EPL/UCL summary → verified game → FT/HT identity binding: exact numeric distributions unchanged, foreign league/game/period rejected, no scoring promotion');
