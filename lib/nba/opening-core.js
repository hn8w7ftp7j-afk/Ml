import { validDate } from './identity.js';
export const NBA_OPENING_VERSION = 'nba-regular-cross-season-v1';
export const OPENING_VARIABLES = ['fullTotal','fullMargin','halfTotal','halfMargin'];
export const OPENING_MARKETS = ['fullTotal','fullRunline','firstHalfTotal','firstHalfRunline'];
export function openingVariableAccepted(m){
  return !!m&&['samples','earlySamples','modelMAE','baselineMAE','earlyModelMAE','earlyBaselineMAE','modelBrier','baselineBrier','modelLogLoss','baselineLogLoss'].every(k=>Number.isFinite(m[k])&&m[k]>=0)
    &&m.samples>=1000&&m.earlySamples>=100&&m.modelMAE<=m.baselineMAE&&m.earlyModelMAE<=m.earlyBaselineMAE&&m.modelBrier<=m.baselineBrier&&m.modelLogLoss<=m.baselineLogLoss;
}
const mean = xs => xs.reduce((s,x)=>s+x,0)/xs.length;
const teamId = id => /^nba:espn:team:(?:[1-9]|[12]\d|30)$/.test(id||'');
const order = (a,b) => a.date.localeCompare(b.date)||a.gameId.localeCompare(b.gameId);

export function validateOpeningHistory(history) {
  const ids=new Set();
  return Array.isArray(history)&&history.length>0&&history.every(r=>{
    if(!/^nba:espn:game:[1-9]\d+$/.test(r?.gameId||'')||ids.has(r.gameId)||!validDate(r.date)
      ||!Number.isInteger(r.year)||![''+r.year,''+(r.year-1)].includes(r.date.slice(0,4))||r.seasonType!=='regular'
      ||!teamId(r.homeId)||!teamId(r.awayId)||r.homeId===r.awayId||typeof r.neutralSite!=='boolean'
      ||![r.homeScore,r.awayScore,r.homeHalf,r.awayHalf].every(n=>Number.isInteger(n)&&n>=0)
      ||r.homeHalf>r.homeScore||r.awayHalf>r.awayScore||!/^[a-f0-9]{64}$/.test(r.checkpointSha256||''))return false;
    ids.add(r.gameId);return true;
  });
}

function stats(rows,id) {
  const selected=rows.filter(r=>r.homeId===id||r.awayId===id);
  const sum=(half,opponent)=>selected.reduce((s,r)=>{
    const side=(r.homeId===id)!==opponent?'home':'away';
    return s+r[side+(half?'Half':'Score')];
  },0);
  return{games:selected.length,fullFor:sum(false,false),fullAgainst:sum(false,true),halfFor:sum(true,false),halfAgainst:sum(true,true)};
}

// Previous-season strength is a transparent prior. Current-season observations
// update it; neither a same-day result nor a preseason/playoff result may enter.
export function openingBaseline(game,history,priorWeight=10) {
  const year=game.season?.year,date=game.taipeiDate;
  const previous=history.filter(r=>r.year===year-1&&r.date<date);
  const current=history.filter(r=>r.year===year&&r.date<date);
  const team=id=>{
    const old=stats(previous,id),fresh=stats(current,id);
    if(old.games<20)return null;
    const out={priorGames:old.games,currentGames:fresh.games};
    for(const key of ['fullFor','fullAgainst','halfFor','halfAgainst'])out[key]=(priorWeight*old[key]/old.games+fresh[key])/(priorWeight+fresh.games);
    return out;
  };
  const home=team(game.home?.id),away=team(game.away?.id);
  if(!home||!away)return null;
  const hp=(home.fullFor+away.fullAgainst)/2,ap=(away.fullFor+home.fullAgainst)/2;
  const hh=(home.halfFor+away.halfAgainst)/2,ah=(away.halfFor+home.halfAgainst)/2;
  return{fullTotal:hp+ap,fullMargin:hp-ap,halfTotal:hh+ah,halfMargin:hh-ah,home,away,
    priorSeasonYear:year-1,priorWeight,through:history.filter(r=>[year-1,year].includes(r.year)&&r.date<date).sort(order).at(-1)?.date};
}

export function fitOpening(features,baseline,ridgePenalty=1000) {
  if(features.length<30)return null;
  return Object.fromEntries(OPENING_VARIABLES.map(key=>{
    const xs=features.map(r=>r.baseline[key]),ys=features.map(r=>r.actual[key]),xbar=mean(xs),ybar=mean(ys);
    const slope=xs.reduce((s,x,i)=>s+(x-xbar)*(ys[i]-ybar),0)/(ridgePenalty+xs.reduce((s,x)=>s+(x-xbar)**2,0));
    return[key,{value:ybar+slope*(baseline[key]-xbar),slope,intercept:ybar-slope*xbar}];
  }));
}

export function buildOpeningTraining(history,{priorWeight=10,ridgePenalty=1000}={}) {
  if(!validateOpeningHistory(history))throw Error('NBA_OPENING_ARCHIVE_INVALID');
  const features=[],observations=[],rows=[...history].sort(order);
  for(const r of rows){
    const baseline=openingBaseline({season:{year:r.year},taipeiDate:r.date,home:{id:r.homeId},away:{id:r.awayId}},rows,priorWeight);
    if(!baseline)continue;
    const actual={fullTotal:r.homeScore+r.awayScore,fullMargin:r.homeScore-r.awayScore,halfTotal:r.homeHalf+r.awayHalf,halfMargin:r.homeHalf-r.awayHalf};
    // Match production exactly: coefficients train on closed earlier seasons;
    // the current season updates team inputs, not its own fitted coefficients.
    const prior=features.filter(f=>f.date<r.date&&f.year<r.year),fit=fitOpening(prior,baseline,ridgePenalty);
    if(fit)observations.push({gameId:r.gameId,date:r.date,year:r.year,errors:Object.fromEntries(OPENING_VARIABLES.map(k=>[k,actual[k]-fit[k].value])),
      prediction:Object.fromEntries(OPENING_VARIABLES.map(k=>[k,fit[k].value])),actual,baseline:Object.fromEntries(OPENING_VARIABLES.map(k=>[k,baseline[k]])),
      currentGames:{home:baseline.home.currentGames,away:baseline.away.currentGames},trainedThrough:prior.at(-1).date,trainedSamples:prior.length});
    features.push({gameId:r.gameId,date:r.date,year:r.year,baseline:Object.fromEntries(OPENING_VARIABLES.map(k=>[k,baseline[k]])),actual});
  }
  return{modelVersion:NBA_OPENING_VERSION,features,observations,priorWeight,ridgePenalty};
}
