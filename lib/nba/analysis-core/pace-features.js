import {totalCalibrationFeatures} from './total-calibration.js';

// Box-derived historical pace is descriptive postgame data. For a target game,
// this feature uses only prior dated games, never the target's finished boxscore.
const ordered=(a,b)=>a.date.localeCompare(b.date)||a.gameId.localeCompare(b.gameId);
export function createPaceCalibrationFeatures(paceHistory){
 if(paceHistory.kind!=='NBA_VERIFIED_ARCHIVED_PER_GAME_PACE')throw Error('PACE_HISTORY_KIND');
 return(game,quantity,history,study,method)=>{
  if(method!=='pace_rest')throw Error('UNKNOWN_PACE_CALIBRATION_METHOD');
  const {restProxy}=totalCalibrationFeatures(game,quantity,history,study,'rest_gap');
  const side=teamId=>{
   const prior=paceHistory.rows.filter(row=>row.year===game.year&&row.date<game.date&&(row.homeId===teamId||row.awayId===teamId)&&Number.isFinite(row.pace)&&row.pace>0).sort(ordered).slice(-study.paceRecentGames);
   if(prior.length<study.minimumPaceGamesPerTeam)throw Error('PACE_EARLIER_TEAM_GAMES_INSUFFICIENT');
   return{teamId,mean:prior.reduce((sum,row)=>sum+row.pace,0)/prior.length,count:prior.length,priorIds:prior.map(row=>row.gameId),priorDates:prior.map(row=>row.date),through:prior.at(-1).date,seasonTypeFilter:'any'};
  };
  const home=side(game.homeId),away=side(game.awayId),estimatedPace=(home.mean+away.mean)/2;
  const paceProxy={estimatedPace,home,away,through:[home.through,away.through].sort().at(-1),recentGamesPerTeam:study.paceRecentGames,
   sourceBasis:'mean_of_each_teams_prior_box_derived_game_pace_then_mean_of_two_teams',officialMetric:false,strictPointInTime:false,
   provenance:{sourceArchiveSha256:paceHistory.sourceArchiveSha256,sourceArchivedAt:paceHistory.sourceArchivedAt,featureVersion:paceHistory.featureVersion,checkpointIdentityHashVerified:true,boxFeatureRecalculationVerified:true,captureBasis:'archived_after_season_not_verified_pregame_capture'}};
  const features=[1,(estimatedPace-study.paceCenter)/study.paceScale,Number(restProxy.home.backToBack)+Number(restProxy.away.backToBack),(Math.min(restProxy.home.gapDays,study.restGapCapDays)+Math.min(restProxy.away.gapDays,study.restGapCapDays))/2-study.restGapCenterDays];
  if(features.some(value=>!Number.isFinite(value)))throw Error('INVALID_PACE_CALIBRATION_FEATURE');
  return{features,restProxy,paceProxy};
 };
}
