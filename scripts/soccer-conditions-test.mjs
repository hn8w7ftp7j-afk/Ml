import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildSoccerConditionsRows,fitSoccerConditionsResearch,fitSoccerConditionsPoisson,soccerConditionsMetrics,soccerConditionsCovariates,soccerConditionsHash } from '../lib/soccer/conditions-model.js';
import { soccerConditionsArtifacts } from '../lib/soccer/conditions-frozen.js';
import { buildSoccerConditionsResearch } from '../lib/soccer/conditions-research.js';

// Independent analytical Poisson intercept MLE: lambda = arithmetic mean.
// No fitter-internal objective or gradient is used as the reference.
const outcomes=[0,1,2,3,4,0,1,2,3,4,0,1,2,3,4];
const mle=fitSoccerConditionsPoisson(outcomes.map(y=>({y,offset:0,x:[1,0,0,0,0,0]})),.1);
assert.ok(Math.abs(Math.exp(mle.coefficients[0])-2)<1e-9);
assert.ok(mle.coefficients.slice(1).every(value=>value===0));
const metrics=soccerConditionsMetrics([{eventId:'1',homeGoals:1,awayGoals:1,baselineRates:{homeRate:1,awayRate:1},homeX:[1,0,0,0,0,0],awayX:[1,0,0,0,0,0]}]);
assert.equal(metrics.scoreLogLoss,2);assert.equal(metrics.goalMAE,0);
assert.throws(()=>soccerConditionsCovariates({kickoffGapHours:0,observedFixtures14d:1},{kickoffGapHours:72,observedFixtures14d:2},false,true));

// Actual retained provider rows, fixed date holdout and complete frozen replay.
const artifact=soccerConditionsArtifacts(),{contentHash,...body}=artifact;
assert.equal(contentHash,soccerConditionsHash(body));
for(const league of ['epl','ucl']){
  const input=JSON.parse(gunzipSync(fs.readFileSync(`research/soccer/${league}-history.json.gz`))).rows;
  const replay=fitSoccerConditionsResearch(input,league);
  assert.deepEqual(replay,artifact.leagues[league]);
  assert.ok(replay.validation.train.games>200);assert.ok(replay.validation.validation.games>100);assert.ok(replay.validation.test.games>150);
  assert.equal(replay.validation.testUsedForSelection,false);assert.equal(replay.validation.testUntouchedVerified,false);
  assert.equal(replay.accepted,false);assert.equal(replay.formalEligible,false);assert.equal(replay.historicalPointInTimeVerified,false);
  assert.equal(replay.R,null);
  const future=structuredClone(input),testAfter=Date.parse('2025-01-01T00:00:00Z');
  for(const row of future)if(Date.parse(row.startTime)>=testAfter){row.homeGoals=99;row.awayGoals=97;}
  const early=buildSoccerConditionsRows(input,league,{before:'2025-01-01T00:00:00Z'}),unchanged=buildSoccerConditionsRows(future,league,{before:'2025-01-01T00:00:00Z'});
  assert.deepEqual(early,unchanged,'future holdout outcomes cannot alter training/validation offsets or congestion features');
  const duplicate=[...input,input[0]];assert.throws(()=>buildSoccerConditionsRows(duplicate,league),/DUPLICATE/);
}
assert.ok(artifact.leagues.epl.validation.deltaScoreLogLoss>0,'the worse EPL holdout must remain visible, not relabeled improvement');

const now=Date.parse(artifact.createdAt)+1000,iso=value=>new Date(value).toISOString();
const game={id:'soccer:epl:9999991',sourceId:'9999991',league:'epl',startTime:iso(now+86400000),status:'scheduled',neutralSite:false,home:{sourceId:'363'},away:{sourceId:'360'}};
const makeTeam=(side,old=3*86400000)=>{
  const sourceId=game[side].sourceId,opponent=game[side==='home'?'away':'home'].sourceId;
  const record={eventId:side==='home'?'9999981':'9999982',startTime:iso(now-old),status:'COMPLETED',homeAway:side,competition:{slug:'eng.1'},opponent:{sourceId:opponent}};
  return {ok:true,sourceId,asOf:iso(now),recentCompleted:[record],lastKnownCompleted:record,sources:[{provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/${sourceId}/schedule?season=2026`,fetchedAt:iso(now-1000),contentHash:'a'.repeat(64)}]};
};
const evidence={ok:true,phase:'PREMATCH_OBSERVATION',game,workload:{gameId:game.id,teams:{home:makeTeam('home'),away:makeTeam('away')}}};
const before=JSON.stringify(evidence),live=buildSoccerConditionsResearch({evidence,game,now});
assert.equal(live.status,'RESEARCH_CHALLENGER_AVAILABLE');assert.ok(live.prediction.homeRate>0);assert.ok(live.prediction.awayRate>0);
assert.equal(live.features.home.observedFixtures14d,1);assert.equal(live.features.home.kickoffGapHours,96);
assert.equal(live.features.home.completeCoverageVerified,false);assert.equal(live.features.home.physicalRestHours,null);assert.equal(live.features.home.travelDistanceKm,null);
assert.equal(live.formalEligible,false);assert.equal(live.modelEffectApplied,false);assert.equal(live.appliedToMainScore,false);assert.equal(live.prediction.period,'REGULATION_FT');
assert.ok(live.absentEffects.includes('WEATHER_FORECAST_NOT_CONNECTED'));assert.equal(JSON.stringify(evidence),before);
// Preserve the latest same-competition game beyond the recent-history window.
const longGap=structuredClone(evidence);
for(const side of ['home','away']){
  const prior={...makeTeam(side,21*86400000).lastKnownCompleted};
  const team=longGap.workload.teams[side];
  team.recentCompleted=[];
  team.lastKnownCompleted={...team.lastKnownCompleted,competition:{slug:'eng.league_cup'}};
  team.lastKnownCompletedByCompetition={'eng.1':prior};
}
const recovered=buildSoccerConditionsResearch({evidence:longGap,game,now});
assert.equal(recovered.status,'RESEARCH_CHALLENGER_AVAILABLE');
assert.equal(recovered.features.home.kickoffGapHours,22*24);
assert.equal(recovered.features.home.observedFixtures14d,0);
assert.equal(recovered.formalEligible,false);
assert.equal(recovered.modelEffectApplied,false);
const absent=structuredClone(longGap);
delete absent.workload.teams.home.lastKnownCompletedByCompetition;
assert.equal(buildSoccerConditionsResearch({evidence:absent,game,now}).prediction,null);
const wrongCompetition=structuredClone(longGap);
wrongCompetition.workload.teams.home.lastKnownCompletedByCompetition['eng.1'].competition.slug='uefa.champions';
assert.equal(buildSoccerConditionsResearch({evidence:wrongCompetition,game,now}).prediction,null);
const conflict=structuredClone(longGap);
conflict.workload.teams.home.recentCompleted=[{...conflict.workload.teams.home.lastKnownCompletedByCompetition['eng.1'],startTime:iso(now-20*86400000)}];
assert.equal(buildSoccerConditionsResearch({evidence:conflict,game,now}).prediction,null);
const intervening=structuredClone(evidence);
intervening.workload.teams.home.scheduledBeforeTarget=[{eventId:'9999971',startTime:iso(now+12*3600000),status:'SCHEDULED',competition:{slug:'eng.1'}}];
const blockedPlan=buildSoccerConditionsResearch({evidence:intervening,game,now});
assert.equal(blockedPlan.prediction,null,'an announced intervening match cannot turn the last completed kickoff into the target next-game gap');
assert.ok(blockedPlan.missing.includes('CONDITIONS_INTERVENING_SAME_COMPETITION_FIXTURE_PENDING'));
assert.equal(blockedPlan.features.home.pendingFixtures[0].eventId,'9999971');
assert.equal(blockedPlan.formalEligible,false);
const foreignPlan=structuredClone(intervening);foreignPlan.workload.teams.home.scheduledBeforeTarget[0].competition.slug='uefa.champions';
assert.deepEqual(buildSoccerConditionsResearch({evidence:foreignPlan,game,now}).prediction,live.prediction,
  'foreign-competition plans do not enter same-competition trained covariates or pretend to be completed workload');
for(const mutate of [
  value=>{value.workload.gameId='soccer:epl:9999';},
  value=>{value.workload.teams.home.sourceId='9999';},
  value=>{value.workload.teams.home.sources[0].fetchedAt=iso(now+1);},
  value=>{value.workload.teams.home.asOf=iso(now+1);},
  value=>{value.workload.teams.home.sources[0].url='https://example.org/schedule';},
  value=>{value.workload.teams.home.recentCompleted[0].startTime=iso(now+1);},
  value=>{value.workload.teams.home.recentCompleted[0].competition.slug='esp.1';},
  value=>{value.workload.teams.home.recentCompleted=[];value.workload.teams.home.lastKnownCompleted=null;},
  value=>{value.phase='POSTSTART_AUDIT';},
]){const bad=structuredClone(evidence);mutate(bad);const output=buildSoccerConditionsResearch({evidence:bad,game,now});assert.equal(output.prediction,null);assert.equal(output.formalEligible,false);}
const late=structuredClone(evidence);late.workload.teams.home.recentCompleted.push({...late.workload.teams.home.recentCompleted[0],startTime:iso(now-2*86400000)});
assert.equal(buildSoccerConditionsResearch({evidence:late,game,now}).prediction,null,'conflicting schedule revisions cannot create features');
assert.equal(buildSoccerConditionsResearch({evidence,game,now:Date.parse(artifact.createdAt)-1}).prediction,null,'a later generated model cannot become available in an older snapshot');
console.log('PASS conditions model: analytical Poisson MLE oracle, actual EPL/UCL chronological frozen replay and visible worse holdout, future-outcome isolation, separate live source-backed congestion challenger, team/time/source/competition/conflict guards, no physical-rest/weather/travel/PIT or formal-score fabrication');
