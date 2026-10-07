import {defaultTraining} from './analysis-training.js';
import {quarterTraining} from './quarter-training.js';
import {preseasonTraining} from './preseason-training.js';
import {validateNbaLiveHistoryRow} from './live-history.js';
import {validDate} from './identity.js';
import {runConservative} from './analysis-core/score-conservative.js';
import {createScorePredictor} from './analysis-core/score-recent.js';
import {prequentialTotalCalibration} from './analysis-core/total-calibration.js';
import {createPaceCalibrationFeatures} from './analysis-core/pace-features.js';
import {buildPreseasonTraining} from './preseason-core.js';

const order=(a,b)=>a.date.localeCompare(b.date)||a.gameId.localeCompare(b.gameId);
const group=row=>`${row.year}:${row.seasonType}`;
const scoreTypes=new Set(['regular','postseason']);
const identityKeys=['gameId','date','year','seasonType','homeId','awayId','neutralSite'];
const scoreKeys=[...identityKeys,'homeScore','awayScore'];
const halfKeys=[...identityKeys,'homeHalf','awayHalf'];
const same=(a,b,keys)=>keys.every(key=>a[key]===b[key]);
const fail=code=>{throw new Error(code);};
const fullRow=row=>Object.fromEntries(scoreKeys.map(key=>[key,row[key]]));
const halfRow=row=>({...fullRow(row),homeScore:row.homeHalf,awayScore:row.awayHalf,homeHalf:row.homeHalf,awayHalf:row.awayHalf,checkpointSha256:row.checkpointSha256});
const paceRow=row=>({gameId:row.gameId,date:row.date,year:row.year,seasonType:row.seasonType,homeId:row.homeId,awayId:row.awayId,pace:row.pace});

function mergeRows(existing,incoming,keys,code){
 const byId=new Map();
 for(const row of existing){
  const prior=byId.get(row.gameId);
  if(prior&&!same(prior,row,keys))fail(code);
  if(!prior)byId.set(row.gameId,row);
 }
 const added=[];
 for(const row of incoming){
  const prior=byId.get(row.gameId);
  if(prior){if(!same(prior,row,keys))fail(code);continue;}
  byId.set(row.gameId,row);added.push(row);
 }
 return{rows:added.length?[...byId.values()].sort(order):existing,added};
}

function readyPredictions(history,training){
 const recent=training.scoreStudy?.candidates?.find(candidate=>candidate.id==='recent');
 if(!recent||recent.ridgePenalty!==10||recent.halfLifeDays!==30)fail('NBA_LIVE_TRAINING_FIXED_SCORE_SPEC');
 return runConservative(history,training.scorePlan,createScorePredictor(recent,training.scoreStudy));
}

function pairedRows(history,byId){
 return history.filter(row=>byId.get(row.gameId)?.status==='ready').map(row=>{
  const prediction=byId.get(row.gameId);
  return{gameId:row.gameId,date:row.date,year:row.year,seasonType:row.seasonType,rawHome:row.homeScore-prediction.predictedHome,rawAway:row.awayScore-prediction.predictedAway};
 });
}

function replaceGroups(existing,replacements,changed,history){
 const byId=new Map(history.map(row=>[row.gameId,row]));
 const keep=existing.filter(row=>{
  const source=byId.get(row.gameId);
  if(!source)fail('NBA_LIVE_TRAINING_INNOVATION_IDENTITY_MISSING');
  return!changed.has(group(source));
 });
 return[...keep,...replacements].sort(order);
}

function rebuildFull(training,history,paceHistory,changed){
 if(!changed.size)return history===training.history&&paceHistory===training.paceHistory?training:{...training,history,paceHistory};
 const predictions=[],pairedResiduals=[],observations=[];
 for(const key of [...changed].sort()){
  const selected=history.filter(row=>group(row)===key);
  const all=readyPredictions(selected,training),byId=new Map(all.map(row=>[row.gameId,row]));
  predictions.push(...all.filter(row=>row.status==='ready').map(({gameId,date,seasonType,predictedHome,predictedAway,calibratedHome,calibratedAway,homeCorrection,awayCorrection,calibrationSamples,calibrationThrough})=>({gameId,date,seasonType,predictedHome,predictedAway,calibratedHome,calibratedAway,homeCorrection,awayCorrection,calibrationSamples,calibrationThrough})));
  pairedResiduals.push(...pairedRows(selected,byId));
  // Score fitting is scoped to one year/type. Rest and pace may legitimately
  // inspect other earlier types, never the target or same-date outcome.
  const calibrated=prequentialTotalCalibration(history.filter(row=>row.year===selected[0]?.year),byId,training.paceStudy,'pace_rest',{featureBuilder:createPaceCalibrationFeatures(paceHistory)});
  observations.push(...calibrated.observations.map(({gameId,date,year,seasonType,features,rawError,error})=>({gameId,date,year,seasonType,features,rawError,error})));
 }
 return{...training,history,paceHistory,
  predictions:replaceGroups(training.predictions,predictions,changed,history),
  pairedResiduals:replaceGroups(training.pairedResiduals,pairedResiduals,changed,history),
  observations:replaceGroups(training.observations,observations,changed,history)};
}

function rebuildHalf(half,full,history,changed){
 if(!changed.size)return history===half.history?half:{...half,history};
 const pairedResiduals=[],observations=[];
 for(const key of [...changed].sort()){
  const selected=history.filter(row=>group(row)===key),all=readyPredictions(selected,full),byId=new Map(all.map(row=>[row.gameId,row]));
  pairedResiduals.push(...pairedRows(selected,byId));
  for(const row of selected){const prediction=byId.get(row.gameId);if(prediction?.status!=='ready')continue;
   observations.push({gameId:row.gameId,date:row.date,year:row.year,seasonType:row.seasonType,total:row.homeScore+row.awayScore-prediction.calibratedHome-prediction.calibratedAway,margin:row.homeScore-row.awayScore-prediction.calibratedHome+prediction.calibratedAway});
  }
 }
 return{...half,history,
  pairedResiduals:replaceGroups(half.pairedResiduals,pairedResiduals,changed,history),
  observations:replaceGroups(half.observations,observations,changed,history)};
}

/** Pure rebuilding of the existing fixed models from verified finished games.
 * These records are future-target historical inputs, not retroactive pregame
 * captures, new model-selection evidence, or verified betting profitability.
 */
export function buildLiveNbaTraining(rows,{beforeDate,seasonYear,trainingData=defaultTraining,halfTraining=quarterTraining,preseasonTrainingData=preseasonTraining,now=Date.now}={}){
 try{
  const clock=typeof now==='function'?now():now;
  if(!Array.isArray(rows)||!validDate(beforeDate)||!Number.isInteger(seasonYear)||seasonYear<1947||seasonYear>2200||!Number.isFinite(clock))fail('NBA_LIVE_TRAINING_REQUEST_INVALID');
  for(const row of rows)validateNbaLiveHistoryRow(row,clock);
  if(trainingData?.kind!=='NBA_PACE_REST_FIXED_TRAINING'||trainingData.modelVersion!=='nba-total-pace-rest-v1'||halfTraining?.kind!=='NBA_QUARTER_SCORE_FIXED_TRAINING'||preseasonTrainingData?.kind!=='NBA_PRESEASON_FIXED_TRAINING'||![trainingData?.history,trainingData?.predictions,trainingData?.pairedResiduals,trainingData?.observations,trainingData?.paceHistory?.rows,halfTraining?.history,halfTraining?.pairedResiduals,halfTraining?.observations,preseasonTrainingData?.history].every(Array.isArray))fail('NBA_LIVE_TRAINING_BASE_INVALID');
  if(halfTraining.provenance?.sourceArchiveSha256!==trainingData.provenance?.sourceArchiveSha256)fail('NBA_LIVE_TRAINING_ARCHIVE_ORIGIN_MISMATCH');
  const excluded=new Set(trainingData.scorePlan?.trainingExclusions??[]);
  const eligible=rows.filter(row=>row.date<beforeDate&&row.year<=seasonYear&&!excluded.has(row.gameId)).sort((a,b)=>order(a,b)||a.recordHash.localeCompare(b.recordHash));
  const selected=mergeRows([],eligible,[...scoreKeys,'homeHalf','awayHalf','pace'],'NBA_LIVE_TRAINING_DUPLICATE_GAME_CONFLICT').rows;
  const provenance={kind:'NBA_VERIFIED_LIVE_TRAINING',status:'archive_only',active:false,beforeDate,seasonYear,strictPointInTime:false,promotionEligible:false,
   captureBasis:'official_and_provider_verified_finished_games_acquired_after_game_not_retroactive_pregame_snapshots',
   eligibleGames:selected.length,liveGames:selected.length,recordHashes:selected.map(row=>row.recordHash),
   fullChangedGroups:[],halfChangedGroups:[],preseasonRebuilt:false,frozenSourceArchiveSha256:trainingData.provenance?.sourceArchiveSha256??null,
   validationBasis:'frozen_archive_metrics_remain_archive_only_not_live_forward_validation'};
  if(!selected.length)return{status:'ready',trainingData,halfTraining,preseasonTrainingData,provenance,issues:[]};
  // A live record cannot silently contradict either frozen full-score corpus.
  for(const archive of [trainingData.history,preseasonTrainingData.history]){
   const existingFull=new Map(archive.map(row=>[row.gameId,row]));
   for(const row of selected){const archived=existingFull.get(row.gameId);if(archived&&!same(archived,row,scoreKeys))fail('NBA_LIVE_TRAINING_FROZEN_SCORE_CONFLICT');}
  }
  const full=mergeRows(trainingData.history,selected.map(fullRow),scoreKeys,'NBA_LIVE_TRAINING_FULL_SCORE_CONFLICT');
  const half=mergeRows(halfTraining.history,selected.filter(row=>scoreTypes.has(row.seasonType)).map(halfRow),halfKeys,'NBA_LIVE_TRAINING_HALF_SCORE_CONFLICT');
  const paced=mergeRows(trainingData.paceHistory.rows,selected.map(paceRow),['gameId','date','year','seasonType','homeId','awayId','pace'],'NBA_LIVE_TRAINING_PACE_CONFLICT');
  const preseason=mergeRows(preseasonTrainingData.history,selected.filter(row=>['regular','preseason'].includes(row.seasonType)).map(row=>({...fullRow(row),homeHalf:row.homeHalf,awayHalf:row.awayHalf})),scoreKeys,'NBA_LIVE_TRAINING_PRESEASON_SCORE_CONFLICT');
  // Existing preseason rows must also agree on actual first-half outcomes.
  const preexisting=new Map(preseasonTrainingData.history.filter(row=>row.seasonType==='preseason').map(row=>[row.gameId,row]));
  for(const row of selected){const prior=preexisting.get(row.gameId);if(prior&&!same(prior,row,halfKeys))fail('NBA_LIVE_TRAINING_PRESEASON_HALF_CONFLICT');}
  const fullChanged=new Set(full.added.filter(row=>scoreTypes.has(row.seasonType)).map(group));
  // A newly retained preseason pace/rest input can affect later regular or
  // playoff innovations, but no earlier date and no unrelated season year.
  for(const added of [...full.added,...paced.added])for(const row of full.rows)if(scoreTypes.has(row.seasonType)&&row.year===added.year&&row.date>added.date)fullChanged.add(group(row));
  const halfChanged=new Set(half.added.map(group));
  let nextFull=rebuildFull(trainingData,full.rows,paced.added.length?{...trainingData.paceHistory,rows:paced.rows}:trainingData.paceHistory,fullChanged);
  let nextHalf=rebuildHalf(halfTraining,trainingData,half.rows,halfChanged);
  let nextPreseason=preseasonTrainingData;
  if(preseason.added.length){nextPreseason={...preseasonTrainingData,history:preseason.rows,...buildPreseasonTraining(preseason.rows)};provenance.preseasonRebuilt=true;}
  provenance.fullChangedGroups=[...fullChanged].sort();provenance.halfChangedGroups=[...halfChanged].sort();
  provenance.active=nextFull!==trainingData||nextHalf!==halfTraining||nextPreseason!==preseasonTrainingData;
  provenance.status=provenance.active?'ready':'archive_only';
  provenance.added={full:full.added.length,half:half.added.length,pace:paced.added.length,preseason:preseason.added.length};
  if(nextFull!==trainingData)nextFull={...nextFull,provenance:{...trainingData.provenance,liveHistory:provenance}};
  if(nextHalf!==halfTraining)nextHalf={...nextHalf,provenance:{...halfTraining.provenance,liveHistory:provenance}};
  if(nextPreseason!==preseasonTrainingData)nextPreseason={...nextPreseason,provenance:{...preseasonTrainingData.provenance,liveHistory:provenance}};
  return{status:'ready',trainingData:nextFull,halfTraining:nextHalf,preseasonTrainingData:nextPreseason,provenance,issues:[]};
 }catch(error){const code=error?.code?.startsWith('NBA_')?error.code:error?.message?.startsWith('NBA_')?error.message:'NBA_LIVE_TRAINING_REBUILD_FAILED';return{status:'blocked',trainingData:null,halfTraining:null,preseasonTrainingData:null,provenance:null,issues:[{code,message:'NBA 已驗證歷史與固定模型重建未通過核對；未使用有衝突的歷史資料。'}]};}
}
