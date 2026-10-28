import { fetchSoccerJson,normalizeSoccerSchedule } from './data.js';
import { soccerLeague } from './contracts.js';
import { soccerMinutesAudit } from './personnel-audit.js';
import { soccerObservationSources } from './source-evidence.js';
import { registerSoccerSourceDocument } from './source-document-store.js';

const clean=v=>typeof v==='string'?v.replace(/[<>\u0000-\u001f]/g,' ').trim().slice(0,160):null;
const unknown=(reason)=>({status:'UNKNOWN',value:null,reason,sourcePublishedAt:null});
function availabilityList(payload,roster,team,side,field,sources,game,now){
  const code=field==='injuries'?'INJURY':'SUSPENSION';
  let node,items;
  if(payload[field]!==undefined){
    if(!Array.isArray(payload[field])||payload[field].length>100)return unknown(`${code}_SOURCE_SCHEMA_UNVERIFIED`);
    const groups=payload[field].filter(group=>String(group?.team?.id)===team.sourceId
      &&(group.homeAway===undefined||group.homeAway===side));
    if(groups.length>1)return unknown(`${code}_TEAM_SCOPE_CONFLICT`);
    if(groups.length===1){node=groups[0];items=node[field];}
  }
  if(items===undefined&&roster?.[field]!==undefined){node=roster;items=roster[field];}
  if(items===undefined)return unknown(field==='injuries'?'INJURY_COVERAGE_NOT_VERIFIED':'COMPETITION_ELIGIBILITY_NOT_VERIFIED');
  if(!Array.isArray(items)||items.length>100)return unknown(`${code}_SOURCE_SCHEMA_UNVERIFIED`);
  const bound=sources.forField(node,`teams.${side}.${field}`),seen=new Set(),value=[];
  for(const item of items){
    const id=String(item?.athlete?.id||''),name=clean(item?.athlete?.displayName||item?.athlete?.fullName);
    const suppliedTeam=item?.team?.id??item?.athlete?.team?.id;
    if(!/^\d{1,16}$/.test(id)||!name||seen.has(id)||suppliedTeam!==undefined&&String(suppliedTeam)!==team.sourceId)
      return unknown(`${code}_PLAYER_IDENTITY_UNVERIFIED`);
    seen.add(id);
    const itemSource=sources.forField(item,`teams.${side}.${field}.${id}`);
    value.push({id,name,status:clean(typeof item.status==='string'?item.status:item.status?.type||item.status?.name||item.status?.description),
      description:clean(item.description||item.details?.detail),type:clean(item.details?.type),
      reportedDate:clean(item.date),expectedReturnDate:clean(item.details?.returnDate),
      sourcePublishedAt:itemSource.source.sourcePublishedAt,source:itemSource.source,sourceEvidence:itemSource.evidence});
  }
  return{status:Date.parse(game.startTime)>now&&game.status==='scheduled'?'PROVIDER_REPORTED':'POSTSTART_OBSERVATION',
    value,source:bound.source,rawSource:bound.rawSource,sourcePublishedAt:bound.source.sourcePublishedAt,sourceEvidence:bound.evidence,
    independentlyConfirmed:false,coverage:'PROVIDER_LIST_ONLY_NOT_COMPLETE_ELIGIBILITY',modelEffectApplied:false};
}
export function normalizeSoccerPrematch(payload,game,source,now=Date.now()){
  const league=soccerLeague(game?.league),header=payload?.header,competition=header?.competitions?.[0];
  if(!league||String(header?.id)!==game.sourceId||!competition)return{ok:false,code:'SOCCER_SUMMARY_IDENTITY_INVALID'};
  const normalized=normalizeSoccerSchedule({leagues:[header.league],events:[{...header,date:competition.date,status:competition.status}]},league.id,source);
  const official=normalized.games?.[0];
  if(!normalized.ok||!official||official.id!==game.id||official.home.sourceId!==game.home.sourceId||official.away.sourceId!==game.away.sourceId||official.startTime!==game.startTime||official.date!==game.date)return{ok:false,code:'SOCCER_SUMMARY_SCOPE_MISMATCH'};
  const prestart=official.status==='scheduled'&&Date.parse(official.startTime)>now;
  const sources=soccerObservationSources({node:payload,payload,game:official,source,now}),document=sources.document;
  const teams={};const allIds=new Set();
  for(const side of ['home','away']){
    const team=official[side],rosters=(payload.rosters||[]).filter(r=>String(r.team?.id)===team.sourceId&&r.homeAway===side);
    if(rosters.length>1)return{ok:false,code:'SOCCER_ROSTER_TEAM_CONFLICT'};
    const roster=rosters[0],players=[];let invalid=false;
    if(roster?.roster&&(!Array.isArray(roster.roster)||roster.roster.length>40))return{ok:false,code:'SOCCER_ROSTER_SIZE_INVALID'};
    for(const p of (roster?.roster||[]).slice(0,40)){
      const id=String(p.athlete?.id||''),name=clean(p.athlete?.displayName||p.athlete?.fullName);
      if(!/^\d{1,16}$/.test(id)||!name||allIds.has(id)||typeof p.starter!=='boolean'){invalid=true;continue;}allIds.add(id);
      const playerSource=sources.forField(p,`teams.${side}.lineup.${id}`);
      players.push({id,name,starter:p.starter,position:clean(p.position?.displayName||p.position?.name),jersey:clean(p.jersey),expectedMinutes:null,startProbability:null,replacementId:null,actualMinutes:null,sourcePublishedAt:playerSource.source.sourcePublishedAt,source:playerSource.source,sourceEvidence:playerSource.evidence,status:prestart?'PROVIDER_REPORTED':'POSTSTART_OBSERVATION'});
    }
    const starters=players.filter(p=>p.starter),lineupStatus=invalid?'IDENTITY_CONFLICT':starters.length===11?(prestart?'PROVIDER_REPORTED_XI':'POSTSTART_XI'):'NOT_PUBLISHED';
    if(invalid)return{ok:false,code:'SOCCER_ROSTER_PLAYER_CONFLICT'};
    const lineup=sources.forField(roster,`teams.${side}.lineup`);
    // A complete provider XI and its fetch receipt are not an independent
    // confirmation or evidence of a historical publication time.
    teams[side]={id:team.id,sourceId:team.sourceId,name:team.name,lineup:{status:lineupStatus,formation:clean(roster?.formation),starters,bench:players.filter(p=>!p.starter),source:lineup.source,rawSource:lineup.rawSource,sourcePublishedAt:lineup.source.sourcePublishedAt,sourceEvidence:lineup.evidence,independentlyConfirmed:false},
      injuries:availabilityList(payload,roster,team,side,'injuries',sources,official,now),
      suspensions:availabilityList(payload,roster,team,side,'suspensions',sources,official,now),minutes:unknown('MINUTES_MODEL_NOT_VALIDATED')};
  }
  for(const field of ['injuries','suspensions']){
    const homeIds=new Set((teams.home[field].value||[]).map(player=>player.id));
    if((teams.away[field].value||[]).some(player=>homeIds.has(player.id)))for(const side of ['home','away'])teams[side][field]=unknown(`${field==='injuries'?'INJURY':'SUSPENSION'}_CROSS_TEAM_PLAYER_CONFLICT`);
  }
  const referee=sources.forField(payload.gameInfo,'referee');
  const officials=(payload.gameInfo?.officials||[]).slice(0,8).map(o=>{
    const bound=sources.forField(o,'referee.official');
    return{name:clean(o.displayName||o.fullName),role:clean(o.position?.displayName||o.type?.text),sourcePublishedAt:bound.source.sourcePublishedAt,source:bound.source,sourceEvidence:bound.evidence};
  }).filter(o=>o.name);
  const recent={};
  for(const side of ['home','away']){
    const id=official[side].sourceId,groups=(payload.lastFiveGames||[]).filter(x=>String(x.team?.id)===id);if(groups.length>1)return{ok:false,code:'SOCCER_RECENT_TEAM_CONFLICT'};
    recent[side]=(groups[0]?.events||[]).filter(e=>String(e.id)!==game.sourceId&&[String(e.homeTeamId),String(e.awayTeamId)].includes(id)&&Date.parse(e.gameDate)<now-6*3600000).slice(0,5).map(e=>({eventId:String(e.id),startTime:e.gameDate,competition:clean(e.leagueName||e.competitionName),score:clean(e.score),opponent:clean(e.opponent?.displayName),availability:'PROVIDER_RECENT_LIST_NOT_COMPLETE_WORKLOAD'}));
  }
  const evidence={ok:true,version:'SOCCER-PREMATCH-EVIDENCE-v2',league:league.id,game:official,phase:prestart?'PREMATCH_OBSERVATION':'POSTSTART_AUDIT',observedAt:source?.fetchedAt,source:document.source,rawSource:document.rawSource,sourceEvidence:document.evidence,
    observedAvailabilityVerified:prestart&&document.evidence.observedAvailabilityVerified,
    pointInTimeAvailabilityVerified:prestart&&document.evidence.publishedAvailabilityVerified,
    pointInTimeAvailabilityScope:'CURRENT_FETCHED_DOCUMENT_ONLY_NOT_HISTORICAL_ARCHIVE',historicalAvailabilityVerified:false,
    teams,referee:officials.length?{status:'PROVIDER_REPORTED',officials,source:referee.source,rawSource:referee.rawSource,sourcePublishedAt:referee.source.sourcePublishedAt,sourceEvidence:referee.evidence,independentlyConfirmed:false}:unknown('REFEREE_NOT_PROVIDED'),recent,weather:unknown('PREMATCH_FORECAST_NOT_CONNECTED'),xg:unknown('CONSISTENT_XG_HISTORY_NOT_CONNECTED'),travel:unknown('ALL_COMPETITION_TRAVEL_NOT_VERIFIED'),uclContext:unknown(league.id==='ucl'?'ROUND_AGGREGATE_AND_DOMESTIC_STRENGTH_NOT_VERIFIED':'NOT_APPLICABLE'),minutesAudit:soccerMinutesAudit(payload,official),executable:false};
  return registerSoccerSourceDocument(evidence,payload);
}
export async function fetchSoccerPrematch(game,options={}){
  const league=soccerLeague(game?.league);if(!league||!/^\d{1,16}$/.test(game?.sourceId||''))return{ok:false,code:'SOCCER_SUMMARY_REQUEST_INVALID'};
  const r=await fetchSoccerJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/summary?event=${game.sourceId}`,{...options,ttlMs:30000});
  return r.ok?normalizeSoccerPrematch(r.data,game,r.source,options.now?.()??Date.now()):r;
}
