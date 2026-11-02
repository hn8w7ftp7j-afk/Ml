import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { replaySoccerMinutesV2 } from './soccer-minutes-v2-replay.mjs';
import { buildSoccerExpectedMinutesRows, fitSoccerExpectedMinutesModel, evaluateSoccerExpectedMinutes,
  soccerExpectedMinutesHash, SOCCER_EXPECTED_MINUTES_VERSION } from '../lib/soccer/expected-minutes-model.js';

const restrictions={formalEligible:false,modelEffectApplied:false,pointInTimeAvailabilityVerified:false,executable:false};
export function fitSoccerExpectedMinutesResearch(observations,{createdAt=new Date().toISOString(),sourceArtifactHashes={},implementationArtifactHashes={},derivedObservationsHash=null}={}){
  const protocol={version:SOCCER_EXPECTED_MINUTES_VERSION,recordedAt:createdAt,
    interpretation:'RETROSPECTIVE_DEVELOPMENT_AND_DESCRIPTIVE_HOLDOUT_NOT_HISTORICAL_PIT_OR_UNTOUCHED_PROSPECTIVE_TEST',
    trainingBefore:'2024-01-01T00:00:00.000Z',developmentBefore:'2025-01-01T00:00:00.000Z',holdoutBefore:'2026-01-01T00:00:00.000Z',
    liveTrainingBefore:'2026-10-18T00:00:00.000Z',assumedResultLagHours:24,priorWindowDays:14,maximumPriorMatches:3,
    candidateSelection:'UNION_OF_EARLIER_AUDITED_SQUADS_NOT_CURRENT_TARGET_ROSTER',
    model:'HIERARCHICALLY_SHRUNK_PREVIOUS_ROLE_AND_RECENT_PARTICIPATION_TRANSITIONS_WITH_LEARNED_ROLE_CONDITIONAL_MINUTES',
    shrinkageCandidates:[1,5,20,100],selection:'DEVELOPMENT_EQUAL_GAME_MULTICLASS_LOG_LOSS_THEN_SMALLER_SHRINKAGE',
    reconciliation:'UPPER_BOUNDS_ONLY_MAX11_EXPECTED_STARTERS_MAX990_EXPECTED_REGULATION_MINUTES_NO_INVENTED_ENTRANTS',
    ...restrictions};
  const leagues={};
  for(const league of['epl','ucl']){
    const dataset=buildSoccerExpectedMinutesRows(observations.filter(value=>value.league===league));
    const before=(row,value)=>Date.parse(row.startTime)<Date.parse(value);
    const train=dataset.rows.filter(row=>before(row,protocol.trainingBefore));
    const development=dataset.rows.filter(row=>!before(row,protocol.trainingBefore)&&before(row,protocol.developmentBefore));
    const holdout=dataset.rows.filter(row=>!before(row,protocol.developmentBefore)&&before(row,protocol.holdoutBefore));
    const trials=protocol.shrinkageCandidates.map(shrinkage=>{const model=fitSoccerExpectedMinutesModel(train,{league,shrinkage});
      return{shrinkage,trainingModelHash:soccerExpectedMinutesHash(model),development:evaluateSoccerExpectedMinutes(model,development)};});
    if(!development.length||!holdout.length)throw Error('EXPECTED_MINUTES_CHRONOLOGICAL_EVALUATION_MISSING');
    const selected=[...trials].sort((a,b)=>a.development.model.logLoss-b.development.model.logLoss||a.shrinkage-b.shrinkage)[0];
    const diagnosticTrain=dataset.rows.filter(row=>before(row,protocol.developmentBefore));
    const diagnosticModel=fitSoccerExpectedMinutesModel(diagnosticTrain,{league,shrinkage:selected.shrinkage});
    const liveRows=dataset.rows.filter(row=>before(row,protocol.liveTrainingBefore)&&Date.parse(row.startTime)+86400000<Date.parse(createdAt));
    const model=fitSoccerExpectedMinutesModel(liveRows,{league,shrinkage:selected.shrinkage});
    leagues[league]={model,coverage:dataset.coverage,validation:{trainingGames:new Set(train.map(row=>row.eventId)).size,
      trainingPlayerTargets:train.length,developmentGames:new Set(development.map(row=>row.eventId)).size,
      diagnosticTrainingGames:diagnosticModel.trainingGames,selectedShrinkage:selected.shrinkage,trials,
      holdout:evaluateSoccerExpectedMinutes(diagnosticModel,holdout),holdoutCandidateCoverage:dataset.coverageByYear['2025'],diagnosticModelHash:soccerExpectedMinutesHash(diagnosticModel),
      holdoutModelFrozenBefore:'2025-01-01T00:00:00.000Z',
      holdoutInterpretation:protocol.interpretation,testUntouchedVerified:false,
      sourceAvailability:'BACKFILLED_POSTMATCH_OBSERVATIONS_WITH_ASSUMED_24H_RESULT_LAG_NOT_ACTUAL_HISTORICAL_FETCH_AVAILABILITY',...restrictions}};
  }
  const body={version:SOCCER_EXPECTED_MINUTES_VERSION,createdAt,protocol,sourceArtifactHashes,implementationArtifactHashes,derivedObservationsHash,leagues,
    limitations:['Candidate identities come from prior observed squads; unknown eligibility, injuries, transfers and new entrants are not supplied by the model.',
      'Minutes use the provider regulation clock, excluding physical stoppage time and extra time.',
      'Training and live input use same-league observed matches only; incomplete histories remain partial coverage.',
      'Historical rosters/results were backfilled; 2025 was already inspected in other research and is not a new untouched test.',
      'Probabilities and expected minutes are research forecasts, not an eleven-player lineup or a joint physically simulated substitution scenario.',
      'No causal player/replacement effect or score-rate change has been established.'],...restrictions};
  return{...body,contentHash:soccerExpectedMinutesHash(body)};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  if(process.argv.slice(2).some(value=>value!=='--write-runtime')||process.argv.filter(value=>value==='--write-runtime').length>1)
    throw Error('Usage: node scripts/soccer-expected-minutes-build.mjs [--write-runtime]');
  const replay=replaySoccerMinutesV2();
  const result=fitSoccerExpectedMinutesResearch(replay.observations,{sourceArtifactHashes:replay.summary.sourceArtifactHashes,
    implementationArtifactHashes:Object.fromEntries(['lib/soccer/expected-minutes-model.js','scripts/soccer-expected-minutes-build.mjs'].map(file=>[file,
      createHash('sha256').update(fs.readFileSync(new URL(`../${file}`,import.meta.url))).digest('hex')])),
    derivedObservationsHash:soccerExpectedMinutesHash(replay.observations)});
  if(process.argv.includes('--write-runtime')){
    fs.writeFileSync(new URL('../lib/soccer/expected-minutes-frozen.js',import.meta.url),
      `// Generated from retained V2 participation; retrospective research, never model acceptance.\nconst data=${JSON.stringify(result)};\nexport function soccerExpectedMinutesArtifacts(){return structuredClone(data);}\n`);
  }
  console.log(JSON.stringify({version:result.version,contentHash:result.contentHash,createdAt:result.createdAt,
    leagues:Object.fromEntries(Object.entries(result.leagues).map(([league,value])=>[league,{coverage:value.coverage,
      liveTrainingGames:value.model.trainingGames,selectedShrinkage:value.model.shrinkage,holdout:value.validation.holdout}])),...restrictions},null,2));
}
