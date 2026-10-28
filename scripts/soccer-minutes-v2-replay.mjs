import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { normalizeSoccerPersonnelHistoryV2 } from '../lib/soccer/personnel-minutes-v2.js';
import { normalizeSoccerPersonnelHistory } from '../lib/soccer/personnel-history.js';
import { SOCCER_MINUTES_AUDIT_V2_VERSION } from '../lib/soccer/personnel-audit.js';

export const SOCCER_MINUTES_V2_COVERAGE_VERSION='SOCCER-PERSONNEL-MINUTES-V2-COVERAGE-v1';
const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const fileHash=buffer=>createHash('sha256').update(buffer).digest('hex');
const add=(counts,reason)=>{counts[reason||'UNKNOWN']=(counts[reason||'UNKNOWN']||0)+1;};

/** Offline complete-cohort replay: no source request, database or model fit. */
export function replaySoccerMinutesV2({root=repositoryRoot}={}){
  const sourceArtifactHashes={},preservedModelArtifactHashes={},observations=[],leagues={};
  for(const file of ['lib/soccer/research-frozen.js','lib/soccer/half-time-frozen.js','lib/soccer/personnel-frozen.js'])
    preservedModelArtifactHashes[file]=fileHash(fs.readFileSync(path.join(root,file)));
  const read=file=>{
    const body=fs.readFileSync(path.join(root,file));sourceArtifactHashes[file]=fileHash(body);
    return JSON.parse(gunzipSync(body));
  };
  for(const league of ['epl','ucl']){
    const rows=read(`research/soccer/${league}-history.json.gz`).rows;
    const retained=read(`research/soccer/personnel-${league}-history.json.gz`);
    const sources=read(`research/soccer/personnel-${league}-sources.json.gz`);
    const byId=new Map(rows.map(row=>[row.eventId,row]));
    const original=new Map(retained.rows.map(row=>[row.eventId,row]));
    if(byId.size!==rows.length||original.size!==retained.rows.length||retained.excluded.length
      ||sources.length!==rows.length||new Set(sources.map(source=>source.eventId)).size!==sources.length)
      throw Error('PERSONNEL_MINUTES_V2_COHORT_OR_DUPLICATE_CONFLICT');
    const cohort=[],excluded=[],v1Reasons={},v2Reasons={},correctionReasons={};
    let v1Reconstructed=0,v2Reconstructed=0,recovered=0,regressed=0,stateResolvedSubstitutions=0,numericChangesOnOriginalUsableGames=0;
    let originalUsableVarReviewCorrectionGames=0,originalUsableVarReviewCorrectionsWithNoMinuteChange=0;
    for(const record of sources){
      const row=byId.get(record.eventId),saved=original.get(record.eventId);
      if(!row||!saved||record.ok!==true)throw Error('PERSONNEL_MINUTES_V2_RETAINED_SOURCE_MISSING');
      const v1=normalizeSoccerPersonnelHistory(row,record.data,record.source);
      if(!v1.ok||canonical(v1.row)!==canonical(saved))throw Error('PERSONNEL_MINUTES_V2_ORIGINAL_REPLAY_CHANGED');
      const result=normalizeSoccerPersonnelHistoryV2(row,record.data,record.source);
      if(!result.ok){excluded.push({league,eventId:record.eventId,reason:result.code});continue;}
      const observation=result.observation,wasUsable=observation.originalMinutes.status==='REGULATION_CLOCK_RECONSTRUCTED';
      const usable=observation.minutes.status==='REGULATION_CLOCK_RECONSTRUCTED';
      v1Reconstructed+=wasUsable;v2Reconstructed+=usable;recovered+=!wasUsable&&usable;regressed+=wasUsable&&!usable;
      if(!wasUsable)add(v1Reasons,observation.originalMinutes.reason);
      if(!usable)add(v2Reasons,observation.minutes.reason);
      if(usable)stateResolvedSubstitutions+=observation.minutes.stateResolvedSubstitutions;
      if(wasUsable&&usable){
        // The retained v1 row deliberately stores a compact numerical projection.
        const compact=Object.fromEntries(['home','away'].map(side=>[side,{
          sourceId:observation.minutes.teams[side].sourceId,
          teamPlayerMinutes:observation.minutes.teams[side].teamPlayerMinutes,
          players:observation.minutes.teams[side].players.map(player=>({id:player.id,starter:player.starter,
            appeared:player.appeared,regulationClockMinutes:player.regulationClockMinutes})),
        }]));
        const hasVarCorrection=observation.corrections.some(value=>value.code==='VAR_REVIEW_MISCLASSIFIED_AS_DISMISSAL');
        if(hasVarCorrection)originalUsableVarReviewCorrectionGames++;
        if(canonical(compact)!==canonical(saved.personnel.minutes.teams)){
          if(!hasVarCorrection)
            throw Error('PERSONNEL_MINUTES_V2_UNEXPLAINED_NUMERICAL_CHANGE');
          numericChangesOnOriginalUsableGames++;
          add(correctionReasons,'VAR_REVIEW_MISCLASSIFIED_AS_DISMISSAL');
        }else if(hasVarCorrection)originalUsableVarReviewCorrectionsWithNoMinuteChange++;
      }
      cohort.push(observation);observations.push(observation);
    }
    if(excluded.length)throw Error('PERSONNEL_MINUTES_V2_DERIVATION_SOURCE_EXCLUDED');
    if(regressed)throw Error('PERSONNEL_MINUTES_V2_ORIGINAL_USABLE_GAME_REGRESSED');
    leagues[league]={population:rows.length,sourceCount:sources.length,derivationAccepted:cohort.length,
      derivationExcluded:excluded.length,v1Reconstructed,v2Reconstructed,recovered,regressed,
      numericChangesOnOriginalUsableGames,correctedOriginalUsableGames:numericChangesOnOriginalUsableGames,correctionReasons,
      originalUsableVarReviewCorrectionGames,originalUsableVarReviewCorrectionsWithNoMinuteChange,
      unverified:cohort.length-v2Reconstructed,v1Reasons,v2Reasons,
      stateResolvedSubstitutions,inputHistoryRowsHash:hash(rows),derivedObservationsHash:hash(cohort)};
  }
  const implementationArtifactHashes=Object.fromEntries(['lib/soccer/personnel-audit.js','lib/soccer/personnel-minutes-v2.js','scripts/soccer-minutes-v2-replay.mjs']
    .map(file=>[file,fileHash(fs.readFileSync(path.join(root,file)))]));
  const summary={version:SOCCER_MINUTES_V2_COVERAGE_VERSION,extractorVersion:SOCCER_MINUTES_AUDIT_V2_VERSION,
    population:observations.length,sourceArtifactHashes,preservedModelArtifactHashes,implementationArtifactHashes,leagues,
    networkRequests:0,currentModelUnchanged:true,modelEffectApplied:false,pointInTimeAvailabilityVerified:false,
    physicalElapsedMinutesVerified:false,formalEligible:false,executable:false,
    interpretation:'REPLAYED_RETAINED_POSTMATCH_REGULATION_CLOCK_MINUTES_NOT_PREGAME_FORECAST_OR_MODEL_ACCEPTANCE',
    sourceTimestampMeaning:'Original retained postmatch fetch times and hashes remain unchanged; replay creates no new provider fetch receipt.'};
  summary.summaryHash=hash(summary);
  return{version:'SOCCER-PERSONNEL-MINUTES-V2-DERIVED-DATASET-v1',summary,observations,
    modelEffectApplied:false,pointInTimeAvailabilityVerified:false,formalEligible:false,executable:false};
}

function writeNew(file,value){
  if(typeof file!=='string'||!file||path.extname(file)!=='.json')throw Error('PERSONNEL_MINUTES_V2_OUTPUT_JSON_PATH_REQUIRED');
  // wx also rejects a pre-existing symlink; no original history or prior output
  // can be overwritten. The operator must choose an explicit new artifact name.
  const fd=fs.openSync(path.resolve(file),'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');}finally{fs.closeSync(fd);}
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2),options={};
  for(let index=0;index<args.length;index++){
    if(!['--output','--summary-output'].includes(args[index])||options[args[index]]||!args[index+1])
      throw Error('Usage: node scripts/soccer-minutes-v2-replay.mjs [--output NEW.json] [--summary-output NEW-summary.json]');
    options[args[index]]=args[++index];
  }
  const result=replaySoccerMinutesV2();
  // Validate all destinations before creating either new output.
  if(new Set(Object.values(options).map(value=>path.resolve(value))).size!==Object.keys(options).length)
    throw Error('PERSONNEL_MINUTES_V2_OUTPUT_PATHS_MUST_BE_DISTINCT');
  for(const value of Object.values(options))if(path.extname(value)!=='.json'||fs.existsSync(path.resolve(value)))
    throw Error('PERSONNEL_MINUTES_V2_OUTPUT_MUST_BE_A_NEW_JSON_FILE');
  if(options['--output'])writeNew(options['--output'],result);
  if(options['--summary-output'])writeNew(options['--summary-output'],result.summary);
  console.log(JSON.stringify(result.summary,null,2));
}
