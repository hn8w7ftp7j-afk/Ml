import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { soccerExpectedMinutesArtifacts } from '../lib/soccer/expected-minutes-frozen.js';
import { buildSoccerExpectedMinutesRows, fitSoccerExpectedMinutesModel, predictSoccerExpectedMinutes,
  evaluateSoccerExpectedMinutes, reconcileSoccerExpectedMinutesTeam, soccerExpectedMinutesFeatures,
  buildSoccerExpectedMinutesResearch, soccerExpectedMinutesHash } from '../lib/soccer/expected-minutes-model.js';
import { SOCCER_MINUTES_AUDIT_V2_VERSION } from '../lib/soccer/personnel-audit.js';
import { fitSoccerExpectedMinutesResearch } from './soccer-expected-minutes-build.mjs';
import { replaySoccerMinutesV2 } from './soccer-minutes-v2-replay.mjs';

const DAY=86400000,at=Date.parse('2025-01-01T12:00:00Z'),iso=value=>new Date(value).toISOString();
const players=(offset=0)=>Array.from({length:13},(_,index)=>({id:String(offset+index+1),name:`Player ${offset+index+1}`,
  starter:index<11,appeared:index<12,regulationClockMinutes:index===0?60:index===11?30:index<11?90:0}));
const observation=(eventId,startTime,homePlayers=players())=>({league:'epl',eventId:String(eventId),startTime,
  minutes:{status:'REGULATION_CLOCK_RECONSTRUCTED',teams:{home:{sourceId:'363',players:homePlayers},away:{sourceId:'360',players:players(100)}}}});
const first=observation(1,iso(at)),second=observation(2,iso(at+7*DAY));
// A newcomer appears only in the outcome. Its identity cannot leak into the
// forecast candidate pool; the missing minutes are charged to coverage.
second.minutes.teams.home.players[0]={...second.minutes.teams.home.players[0],id:'9999',name:'Previously unseen'};
const before=JSON.stringify([first,second]);
const dataset=buildSoccerExpectedMinutesRows([second,first]);
assert.equal(dataset.rows.length,26);assert.equal(dataset.rows.some(row=>row.id==='9999'),false);
const absent=dataset.rows.find(row=>row.eventId==='2'&&row.teamId==='363'&&row.id==='1');
assert.equal(absent.targetRole,'NO_APPEARANCE');assert.equal(absent.targetMinutes,0);
assert.equal(dataset.coverage.unseenAppearingPlayers,25); // first game's24 + newcomer
assert.equal(JSON.stringify([first,second]),before);
assert.equal(buildSoccerExpectedMinutesRows([first,observation(3,iso(at+12*3600000))]).rows.length,0,
  'same-day results cannot become prior features under the declared24hour resultlag');
assert.equal(buildSoccerExpectedMinutesRows([first,observation(4,iso(at+15*DAY))]).rows.length,0,
  'old squads outside the live14day window are not silently reused');
assert.throws(()=>buildSoccerExpectedMinutesRows([first,first]),/DUPLICATE/);

const training=Array.from({length:12},(_,index)=>({...dataset.rows[index%26],eventId:String(index+10),
  targetRole:index<6?'STARTER':index<9?'SUBSTITUTE':'NO_APPEARANCE',targetMinutes:index<6?80:index<9?20:0}));
const model=fitSoccerExpectedMinutesModel(training,{league:'epl',shrinkage:5});
const feature=soccerExpectedMinutesFeatures([{eventId:'1',startTime:iso(at),players:players()}])[0];
const prediction=predictSoccerExpectedMinutes(model,feature);
assert.ok(prediction.startProbability>=0&&prediction.appearanceProbability<=1);
assert.ok(Math.abs(prediction.probabilities.reduce((sum,p)=>sum+p,0)-1)<1e-12);
assert.ok(prediction.expectedMinutes>=0&&prediction.expectedMinutes<=90);
const uniform={...feature,key:'UNSEEN',lastRole:'UNSEEN'};
const allSame=fitSoccerExpectedMinutesModel(training.map(row=>({...row,targetRole:'STARTER',targetMinutes:67})),{league:'epl',shrinkage:5});
assert.equal(predictSoccerExpectedMinutes(allSame,uniform).expectedMinutes,67,
  'a constant observed target produces the learnedconstant, not a hardcoded90minutes');

const large=Array.from({length:20},()=>({startProbability:.9,substituteProbability:.05,noAppearanceProbability:.05,
  appearanceProbability:.95,expectedMinutes:85,conditionalStarterMinutes:90,conditionalSubstituteMinutes:80}));
const reconciled=reconcileSoccerExpectedMinutesTeam(large);
assert.ok(reconciled.startFactor<1);
assert.ok(large.reduce((sum,p)=>sum+p.startProbability,0)<=11+1e-12);
assert.ok(large.reduce((sum,p)=>sum+p.expectedMinutes,0)<=990+1e-10);
assert.ok(large.every(p=>Math.abs(p.probabilities.reduce((sum,p)=>sum+p,0)-1)<1e-12));

// Evaluation must use exactly the same reconciled forecast as live rendering.
const evaluationRows=training.map((row,index)=>({...row,eventId:'700',teamId:'363',id:String(index+1)}));
const forecast=evaluationRows.map(row=>({...predictSoccerExpectedMinutes(model,row),row}));
reconcileSoccerExpectedMinutesTeam(forecast);
const oracleMAE=forecast.reduce((sum,p)=>sum+Math.abs(p.expectedMinutes-p.row.targetMinutes),0)/forecast.length;
const metrics=evaluateSoccerExpectedMinutes(model,evaluationRows);
assert.equal(metrics.model.minuteMAE,oracleMAE);

// Change only2025 outcomes: development selection and the frozen diagnostic
// model must remain unchanged. The later live refit may legitimately change.
const chronological=[];
for(const league of['epl','ucl'])for(const year of[2023,2024,2025])for(let index=0;index<3;index++){
  const value=observation(`${year}${index}${league==='epl'?1:2}`,`${year}-02-${String(1+index*7).padStart(2,'0')}T12:00:00Z`);
  value.league=league;chronological.push(value);
}
const frozen=fitSoccerExpectedMinutesResearch(chronological,{createdAt:'2026-11-03T00:00:00Z'});
const changedHoldout=structuredClone(chronological);
changedHoldout.filter(value=>value.startTime.startsWith('2025')).forEach(value=>{
  for(const team of Object.values(value.minutes.teams))for(const player of team.players)player.regulationClockMinutes=player.appeared?10:0;
});
const changedFit=fitSoccerExpectedMinutesResearch(changedHoldout,{createdAt:'2026-11-03T00:00:00Z'});
for(const league of['epl','ucl']){
  assert.equal(frozen.leagues[league].validation.selectedShrinkage,changedFit.leagues[league].validation.selectedShrinkage);
  assert.equal(frozen.leagues[league].validation.diagnosticModelHash,changedFit.leagues[league].validation.diagnosticModelHash);
  assert.notEqual(frozen.leagues[league].validation.holdout.model.minuteMAE,changedFit.leagues[league].validation.holdout.model.minuteMAE);
}

const artifact=soccerExpectedMinutesArtifacts(),{contentHash,...body}=artifact;
assert.equal(contentHash,soccerExpectedMinutesHash(body));
const replay=replaySoccerMinutesV2();
const implementationArtifactHashes=Object.fromEntries(['lib/soccer/expected-minutes-model.js','scripts/soccer-expected-minutes-build.mjs'].map(file=>[file,
  createHash('sha256').update(fs.readFileSync(new URL(`../${file}`,import.meta.url))).digest('hex')]));
assert.deepEqual(artifact,fitSoccerExpectedMinutesResearch(replay.observations,{createdAt:artifact.createdAt,
  sourceArtifactHashes:replay.summary.sourceArtifactHashes,derivedObservationsHash:soccerExpectedMinutesHash(replay.observations),implementationArtifactHashes}),
  'the complete retained V2 cohort reproduces every parameter and diagnostic in the frozen runtime artifact');
assert.equal(artifact.protocol.candidateSelection,'UNION_OF_EARLIER_AUDITED_SQUADS_NOT_CURRENT_TARGET_ROSTER');
for(const league of['epl','ucl']){
  const result=artifact.leagues[league];
  assert.ok(result.model.trainingGames>100);assert.ok(result.validation.holdout.model.games>50);
  assert.equal(result.validation.holdout.reconciliation,'SAME_TEAM_UPPER_BOUND_RECONCILIATION_AS_LIVE_INFERENCE');
  assert.equal(result.validation.testUntouchedVerified,false);assert.equal(result.model.formalEligible,false);
  assert.ok(result.validation.holdoutCandidateCoverage.unseenAppearingPlayers>0);
  assert.equal(result.validation.selectedShrinkage,[...result.validation.trials].sort((a,b)=>a.development.model.logLoss-b.development.model.logLoss||a.shrinkage-b.shrinkage)[0].shrinkage);
}

const now=Math.max(Date.parse(artifact.createdAt)+DAY,Date.parse('2026-11-04T00:00:00Z'));
const game={id:'soccer:epl:777',sourceId:'777',league:'epl',date:iso(now+DAY).slice(0,10),startTime:iso(now+DAY),status:'scheduled',home:{sourceId:'363'},away:{sourceId:'360'}};
const workload=sourceId=>({ok:true,version:'SOCCER-ALL-COMPETITION-WORKLOAD-v2',sourceId,asOf:iso(now-1000),referenceAt:iso(now-1000),
  playerWorkload:{ok:true,version:'SOCCER-OBSERVED-PLAYER-WORKLOAD-v2',extractorVersion:SOCCER_MINUTES_AUDIT_V2_VERSION,
  sourceId,asOf:iso(now),referenceAt:iso(now-1000),matches:[{eventId:'100',sourceId,startTime:iso(now-3*DAY),players:players(sourceId==='363'?0:100),
    competition:{slug:'eng.1'},extractorVersion:SOCCER_MINUTES_AUDIT_V2_VERSION,
    source:{provider:'ESPN',fetchedAt:iso(now-1000),contentHash:'a'.repeat(64),url:'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=100'}}]}});
const evidence={ok:true,game,phase:'PREMATCH_OBSERVATION',workload:{gameId:game.id,target:structuredClone(game),teams:{home:workload('363'),away:workload('360')}}};
const live=buildSoccerExpectedMinutesResearch({evidence,game,now});
assert.equal(live.status,'RESEARCH_FORECAST_AVAILABLE');assert.equal(live.teams.home.players.length,13);
assert.equal(live.teams.home.eligibilityStatus,'UNKNOWN');assert.equal(live.teams.home.coverage.complete,false);
assert.equal(live.formalEligible,false);assert.equal(live.modelEffectApplied,false);
for(const change of[
  value=>{value.workload.teams.home.playerWorkload.sourceId='999';},
  value=>{value.workload.teams.home.sourceId='999';},
  value=>{value.workload.teams.home.asOf=iso(now+1);},
  value=>{value.workload.teams.home.referenceAt=iso(now-2000);},
  value=>{delete value.workload.teams.home.playerWorkload.referenceAt;},
  value=>{value.workload.teams.home.playerWorkload.referenceAt=iso(now-2000);},
  value=>{value.workload.teams.home.playerWorkload.matches[0].source.fetchedAt=iso(now+1000);},
  value=>{value.workload.teams.home.playerWorkload.asOf=iso(now-2000);},
  value=>{value.workload.teams.home.playerWorkload.matches[0].startTime=iso(now);},
  value=>{value.workload.teams.home.playerWorkload.matches[0].competition.slug='uefa.champions';},
  value=>{value.workload.teams.home.playerWorkload.matches[0].source.url+='&other=1';},
]){const copy=structuredClone(evidence);change(copy);const result=buildSoccerExpectedMinutesResearch({evidence:copy,game,now});
  assert.equal(result.teams.home.status,'INSUFFICIENT_PRIOR_OBSERVATIONS');assert.equal(result.teams.away.status,'RESEARCH_FORECAST_AVAILABLE');}
// Identical teams do not make another fixture's workload interchangeable.
const otherFixture={...structuredClone(game),id:'soccer:epl:778',sourceId:'778'};
const borrowedFixture={...structuredClone(evidence),game:otherFixture};
assert.equal(buildSoccerExpectedMinutesResearch({evidence:borrowedFixture,game:otherFixture,now}).teams.home.reason,'EXPECTED_MINUTES_WORKLOAD_SCOPE_MISMATCH');
// The same event can be rescheduled; an old target snapshot must not silently
// satisfy the replacement date/kickoff just because the club and event IDs match.
const rescheduled={...structuredClone(game),date:iso(now+2*DAY).slice(0,10),startTime:iso(now+2*DAY)};
assert.equal(buildSoccerExpectedMinutesResearch({evidence:{...structuredClone(evidence),game:rescheduled},game:rescheduled,now}).teams.home.reason,'EXPECTED_MINUTES_WORKLOAD_SCOPE_MISMATCH');
for(const change of[
  value=>{delete value.workload.gameId;},
  value=>{value.workload.gameId=otherFixture.id;},
  value=>{delete value.workload.target;},
  ...['id','sourceId','league','date','startTime'].map(field=>value=>{value.workload.target[field]='foreign';}),
  value=>{value.workload.target.home.sourceId='999';},
  value=>{value.workload.target.away.sourceId='999';},
]){const copy=structuredClone(evidence);change(copy);const result=buildSoccerExpectedMinutesResearch({evidence:copy,game,now});
  assert.equal(result.teams.home.reason,'EXPECTED_MINUTES_WORKLOAD_SCOPE_MISMATCH');assert.equal(result.teams.away.reason,'EXPECTED_MINUTES_WORKLOAD_SCOPE_MISMATCH');}
for(const field of['sourceId','league','date','startTime','status']){
  const copy=structuredClone(evidence);copy.game[field]='foreign';
  assert.equal(buildSoccerExpectedMinutesResearch({evidence:copy,game,now}).teams.home.reason,'CURRENT_GAME_SCOPE_INVALID');
}
assert.equal(buildSoccerExpectedMinutesResearch({evidence,game,now:Date.parse(artifact.createdAt)-1}).status,'MODEL_NOT_AVAILABLE_AT_CUTOFF');
assert.equal(buildSoccerExpectedMinutesResearch({evidence,game,now:NaN}).status,'MODEL_NOT_AVAILABLE_AT_CUTOFF');
const altered=structuredClone(artifact);altered.leagues.epl.model.shrinkage++;
assert.equal(buildSoccerExpectedMinutesResearch({evidence,game,now,artifacts:altered}).status,'MODEL_NOT_AVAILABLE_AT_CUTOFF');
assert.equal(buildSoccerExpectedMinutesResearch({evidence,game:{...game,home:{sourceId:'999'}},now}).teams.home.status,'INSUFFICIENT_PRIOR_OBSERVATIONS');
console.log('PASS learned expected minutes: prior-only candidates and24h/14day guards, unseen-player coverage, learned role/minute estimates, shared live/holdout physicalupperbounds, real chronological artifact/baseline diagnostics, source/team/time/scope/hash rejection and no formal promotion');
