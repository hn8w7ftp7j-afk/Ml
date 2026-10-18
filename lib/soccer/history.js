import { normalizeSoccerSchedule, fetchSoccerJson } from './data.js';
import { soccerLeague } from './contracts.js';

export function normalizeSoccerHistory(payload,leagueValue,source,year){
  const league=soccerLeague(leagueValue),normalized=normalizeSoccerSchedule(payload,leagueValue,source);
  if(!normalized.ok)return normalized;
  if(!Number.isInteger(year)||year<2000||year>2100)return{ok:false,code:'SOCCER_HISTORY_YEAR_INVALID'};
  const rows=[],excluded=[];const raw=new Map(payload.events.map(x=>[String(x.id),x]));
  for(const game of normalized.games){
    const event=raw.get(game.sourceId),competition=event.competitions[0],status=event.status||competition.status,type=status?.type;
    let reason=null;
    if(Number(game.startTime.slice(0,4))!==year)reason='OUTSIDE_REQUESTED_UTC_YEAR';
    else if(game.status!=='final')reason='NOT_FINAL';
    // A shootout/extra-time total is never silently treated as the 90-minute score.
    else if(type?.name!=='STATUS_FULL_TIME'||Number(status.period)!==2||[event.status,competition.status].filter(Boolean).some(s=>s.type?.name!=='STATUS_FULL_TIME'||Number(s.period)!==2)||competition.format?.regulation?.periods!==2)reason='REGULATION_SCORE_UNVERIFIED';
    if(reason){excluded.push({eventId:game.sourceId,startTime:game.startTime,reason});continue;}
    rows.push({league:league.id,eventId:game.sourceId,startTime:game.startTime,season:event.season?.year||null,stage:event.season?.type||null,homeId:game.home.sourceId,awayId:game.away.sourceId,homeName:game.home.name,awayName:game.away.name,homeGoals:game.home.score,awayGoals:game.away.score,neutralSite:game.neutralSite,period:'REGULATION_FT',halfTime:game.halfTime?{home:game.halfTime.home,away:game.halfTime.away}:null,source,availability:'BACKFILLED_AT_COLLECTION_NOT_PREMATCH_SAVED'});
  }
  return{ok:true,normalizerVersion:'SOCCER-HISTORY-v1.1',league:league.id,year,rows,excluded,source,coverage:{received:normalized.games.length,accepted:rows.length,excluded:excluded.length,providerCompletenessVerified:false},missing:['YEAR_ENDPOINT_COMPLETENESS_NOT_INDEPENDENTLY_VERIFIED','SOURCE_PUBLICATION_TIME_UNAVAILABLE']};
}
export async function fetchSoccerHistoryYear(leagueValue,year,options={}){
  const league=soccerLeague(leagueValue);if(!league||!Number.isInteger(year)||year<2000||year>2100)return{ok:false,code:'SOCCER_HISTORY_SCOPE_INVALID'};
  const r=await fetchSoccerJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/scoreboard?dates=${year}&limit=1000`,{...options,ttlMs:0});
  return r.ok?normalizeSoccerHistory(r.data,league.id,r.source,year):r;
}
