import { fetchSoccerJson,normalizeSoccerSchedule } from './data.js';
import { soccerLeague } from './contracts.js';
import { soccerMinutesAudit } from './personnel-audit.js';

const clean=v=>typeof v==='string'?v.replace(/[<>\u0000-\u001f]/g,' ').trim().slice(0,160):null;
const unknown=(reason)=>({status:'UNKNOWN',value:null,reason,sourcePublishedAt:null});
export function normalizeSoccerPrematch(payload,game,source,now=Date.now()){
  const league=soccerLeague(game?.league),header=payload?.header,competition=header?.competitions?.[0];
  if(!league||String(header?.id)!==game.sourceId||!competition)return{ok:false,code:'SOCCER_SUMMARY_IDENTITY_INVALID'};
  const normalized=normalizeSoccerSchedule({leagues:[header.league],events:[{...header,date:competition.date,status:competition.status}]},league.id,source);
  const official=normalized.games?.[0];
  if(!normalized.ok||!official||official.id!==game.id||official.home.sourceId!==game.home.sourceId||official.away.sourceId!==game.away.sourceId||official.startTime!==game.startTime||official.date!==game.date)return{ok:false,code:'SOCCER_SUMMARY_SCOPE_MISMATCH'};
  const prestart=official.status==='scheduled'&&Date.parse(official.startTime)>now;
  const teams={};const allIds=new Set();
  for(const side of ['home','away']){
    const team=official[side],rosters=(payload.rosters||[]).filter(r=>String(r.team?.id)===team.sourceId&&r.homeAway===side);
    if(rosters.length>1)return{ok:false,code:'SOCCER_ROSTER_TEAM_CONFLICT'};
    const roster=rosters[0],players=[];let invalid=false;
    if(roster?.roster&&(!Array.isArray(roster.roster)||roster.roster.length>40))return{ok:false,code:'SOCCER_ROSTER_SIZE_INVALID'};
    for(const p of (roster?.roster||[]).slice(0,40)){
      const id=String(p.athlete?.id||''),name=clean(p.athlete?.displayName||p.athlete?.fullName);
      if(!/^\d{1,16}$/.test(id)||!name||allIds.has(id)||typeof p.starter!=='boolean'){invalid=true;continue;}allIds.add(id);
      players.push({id,name,starter:p.starter,position:clean(p.position?.displayName||p.position?.name),jersey:clean(p.jersey),expectedMinutes:null,startProbability:null,replacementId:null,actualMinutes:null,sourcePublishedAt:null,status:prestart?'PROVIDER_REPORTED':'POSTSTART_OBSERVATION'});
    }
    const starters=players.filter(p=>p.starter),lineupStatus=invalid?'IDENTITY_CONFLICT':starters.length===11?(prestart?'PROVIDER_REPORTED_XI':'POSTSTART_XI'):'NOT_PUBLISHED';
    if(invalid)return{ok:false,code:'SOCCER_ROSTER_PLAYER_CONFLICT'};
    // Even a complete XI has no source publication time: historical availability is not inferred.
    teams[side]={id:team.id,sourceId:team.sourceId,name:team.name,lineup:{status:lineupStatus,formation:clean(roster?.formation),starters,bench:players.filter(p=>!p.starter),source,sourcePublishedAt:null,independentlyConfirmed:false},injuries:unknown('INJURY_COVERAGE_NOT_VERIFIED'),suspensions:unknown('COMPETITION_ELIGIBILITY_NOT_VERIFIED'),minutes:unknown('MINUTES_MODEL_NOT_VALIDATED')};
  }
  const officials=(payload.gameInfo?.officials||[]).slice(0,8).map(o=>({name:clean(o.displayName||o.fullName),role:clean(o.position?.displayName||o.type?.text),sourcePublishedAt:null})).filter(o=>o.name);
  const recent={};
  for(const side of ['home','away']){
    const id=official[side].sourceId,groups=(payload.lastFiveGames||[]).filter(x=>String(x.team?.id)===id);if(groups.length>1)return{ok:false,code:'SOCCER_RECENT_TEAM_CONFLICT'};
    recent[side]=(groups[0]?.events||[]).filter(e=>String(e.id)!==game.sourceId&&[String(e.homeTeamId),String(e.awayTeamId)].includes(id)&&Date.parse(e.gameDate)<now-6*3600000).slice(0,5).map(e=>({eventId:String(e.id),startTime:e.gameDate,competition:clean(e.leagueName||e.competitionName),score:clean(e.score),opponent:clean(e.opponent?.displayName),availability:'PROVIDER_RECENT_LIST_NOT_COMPLETE_WORKLOAD'}));
  }
  return{ok:true,version:'SOCCER-PREMATCH-EVIDENCE-v2',league:league.id,game:official,phase:prestart?'PREMATCH_OBSERVATION':'POSTSTART_AUDIT',observedAt:source.fetchedAt,source,teams,referee:officials.length?{status:'PROVIDER_REPORTED',officials,source,sourcePublishedAt:null}:unknown('REFEREE_NOT_PROVIDED'),recent,weather:unknown('PREMATCH_FORECAST_NOT_CONNECTED'),xg:unknown('CONSISTENT_XG_HISTORY_NOT_CONNECTED'),travel:unknown('ALL_COMPETITION_TRAVEL_NOT_VERIFIED'),uclContext:unknown(league.id==='ucl'?'ROUND_AGGREGATE_AND_DOMESTIC_STRENGTH_NOT_VERIFIED':'NOT_APPLICABLE'),minutesAudit:soccerMinutesAudit(payload,official),pointInTimeAvailabilityVerified:false,executable:false};
}
export async function fetchSoccerPrematch(game,options={}){
  const league=soccerLeague(game?.league);if(!league||!/^\d{1,16}$/.test(game?.sourceId||''))return{ok:false,code:'SOCCER_SUMMARY_REQUEST_INVALID'};
  const r=await fetchSoccerJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/summary?event=${game.sourceId}`,{...options,ttlMs:30000});
  return r.ok?normalizeSoccerPrematch(r.data,game,r.source,options.now?.()??Date.now()):r;
}
