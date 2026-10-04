// Fixed score primitive copied from the archived study; runtime validation lives in analysis-model.js.
export const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
export function predictConservative(game,history,plan){
 const past=history.filter(g=>g.year===game.year&&g.seasonType===game.seasonType&&g.date<game.date);
 const team=id=>past.filter(g=>g.homeId===id||g.awayId===id);
 const home=team(game.homeId),away=team(game.awayId),minimum=plan.model.minimumPriorGamesEachTeam;
 if(home.length<minimum||away.length<minimum)return{status:'insufficient_history',homeHistory:home.length,awayHistory:away.length};
 const league=mean(past.flatMap(g=>[g.homeScore,g.awayScore])),prior=plan.model.priorEquivalentGames;
 const stats=(set,id)=>({attack:(set.reduce((s,g)=>s+(g.homeId===id?g.homeScore:g.awayScore),0)+prior*league)/(set.length+prior),defense:(set.reduce((s,g)=>s+(g.homeId===id?g.awayScore:g.homeScore),0)+prior*league)/(set.length+prior)});
 const h=stats(home,game.homeId),a=stats(away,game.awayId);
 const venuePast=past.filter(g=>!g.neutralSite),advantage=game.neutralSite?0:(mean(venuePast.map(g=>g.homeScore-g.awayScore))??0)/2;
 return{status:'ready',predictedHome:(h.attack+a.defense)/2+advantage,predictedAway:(a.attack+h.defense)/2-advantage,homeHistory:home.length,awayHistory:away.length,trainingThrough:past.at(-1).date,leagueHistory:past.length,priorEquivalentGames:prior};
}
const quantile=(values,nominal)=>{const sorted=[...values].sort((a,b)=>a-b),rank=Math.ceil((sorted.length+1)*nominal);return rank<=sorted.length?sorted[rank-1]:null;};
export function runConservative(history,plan,predict=predictConservative){
 const predictions=[],residuals=[];
 for(const game of [...history].sort((a,b)=>a.date.localeCompare(b.date)||a.gameId.localeCompare(b.gameId))){
  const raw=predict(game,history,plan);if(raw.status!=='ready'){predictions.push({gameId:game.gameId,...raw});continue;}
  const past=residuals.filter(r=>r.year===game.year&&r.seasonType===game.seasonType&&r.date<game.date);
  const calibrated=past.length>=plan.calibration.minimumEarlierPairedResiduals;
  const homeCorrection=calibrated?mean(past.map(r=>r.rawHome)):0,awayCorrection=calibrated?mean(past.map(r=>r.rawAway)):0;
  const h=raw.predictedHome+homeCorrection,a=raw.predictedAway+awayCorrection;
  const intervals=plan.calibration.intervals.map(nominal=>({nominal,samples:past.length,totalRadius:calibrated?quantile(past.map(r=>Math.abs(r.total)),nominal):null,marginRadius:calibrated?quantile(past.map(r=>Math.abs(r.margin)),nominal):null}));
  predictions.push({gameId:game.gameId,date:game.date,seasonType:game.seasonType,...raw,calibratedHome:h,calibratedAway:a,calibrationReady:calibrated,calibrationSamples:past.length,homeCorrection,awayCorrection,calibrationThrough:past.at(-1)?.date??null,intervals});
  residuals.push({year:game.year,seasonType:game.seasonType,date:game.date,rawHome:game.homeScore-raw.predictedHome,rawAway:game.awayScore-raw.predictedAway,total:game.homeScore+game.awayScore-h-a,margin:game.homeScore-game.awayScore-h+a});
 }
 return predictions;
}
