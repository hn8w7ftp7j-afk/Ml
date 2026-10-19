import { createHash } from 'node:crypto';
import { soccerLeague } from './contracts.js';
import { soccerMinutesAudit } from './personnel-audit.js';

export const SOCCER_PERSONNEL_HISTORY_VERSION='SOCCER-RETAINED-XI-HISTORY-v1';
export const soccerPersonnelHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id=value=>typeof value==='string'&&/^\d{1,16}$/.test(value);
const fail=code=>({ok:false,code,modelEffectApplied:false});

/** Retain precisely the public fields needed to replay XI/minute extraction. */
export function soccerPersonnelSourceProjection(payload){
  return {header:payload?.header&&{id:payload.header.id,league:payload.header.league&&{id:payload.header.league.id,slug:payload.header.league.slug},competitions:payload.header.competitions?.map(c=>({id:c.id,date:c.date,status:c.status,competitors:c.competitors?.map(t=>({id:t.id,homeAway:t.homeAway,score:t.score,team:{id:t.team?.id}}))}))},format:payload?.format,
    rosters:payload?.rosters?.map(r=>({team:{id:r.team?.id},homeAway:r.homeAway,formation:r.formation,roster:r.roster?.map(p=>({athlete:{id:p.athlete?.id,displayName:p.athlete?.displayName,fullName:p.athlete?.fullName},starter:p.starter,subbedIn:p.subbedIn,subbedOut:p.subbedOut,stats:p.stats?.filter(s=>s.name==='redCards')}))})),
    keyEvents:payload?.keyEvents?.map(e=>({id:e.id,type:e.type,period:e.period,clock:e.clock,team:e.team&&{id:e.team.id},participants:e.participants?.map(p=>({athlete:{id:p.athlete?.id}})),text:e.text}))};
}

/** This is retrospective observed XI/participation, never historical prematch availability. */
export function normalizeSoccerPersonnelHistory(row,payload,source){
  const league=soccerLeague(row?.league),c=payload?.header?.competitions?.[0];
  if(!league||!id(row?.eventId)||!id(row?.homeId)||!id(row?.awayId)||row.homeId===row.awayId||row.period!=='REGULATION_FT'||!Number.isFinite(Date.parse(row.startTime)))return fail('PERSONNEL_HISTORY_ROW_INVALID');
  const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/summary?event=${row.eventId}`;
  if(source?.provider!=='ESPN'||source.url!==url||!Number.isFinite(Date.parse(source.fetchedAt))||source.contentHash!==soccerPersonnelHash(payload))return fail('PERSONNEL_HISTORY_SOURCE_INVALID');
  if(String(payload.header?.id)!==row.eventId||String(payload.header?.league?.id)!==league.espnId||payload.header?.league?.slug!==league.espnSlug||payload.header?.competitions?.length!==1||String(c?.id)!==row.eventId||Date.parse(c.date)!==Date.parse(row.startTime))return fail('PERSONNEL_HISTORY_SCOPE_MISMATCH');
  if(c.status?.type?.name!=='STATUS_FULL_TIME'||c.status?.type?.completed!==true||(c.status.period!=null&&Number(c.status.period)!==2)||payload.format?.regulation?.periods!==2||payload.format?.regulation?.clock!==2700||payload.keyEvents?.some(e=>Number(e.period?.number)>2))return fail('PERSONNEL_HISTORY_REGULATION_UNVERIFIED');
  if(!Array.isArray(c.competitors)||c.competitors.length!==2||!Array.isArray(payload.rosters)||payload.rosters.length!==2)return fail('PERSONNEL_HISTORY_TEAMS_INVALID');
  const teams={},seen=new Set();
  for(const side of ['home','away']){
    const expected=row[`${side}Id`],matches=c.competitors.filter(t=>t.homeAway===side),rosters=payload.rosters.filter(r=>r.homeAway===side&&String(r.team?.id)===expected);
    if(matches.length!==1||String(matches[0].team?.id)!==expected||String(matches[0].id)!==expected||Number(matches[0].score?.value??matches[0].score)!==row[`${side}Goals`]||rosters.length!==1||!Array.isArray(rosters[0].roster)||rosters[0].roster.length>40)return fail('PERSONNEL_HISTORY_TEAM_IDENTITY_MISMATCH');
    const players=rosters[0].roster;
    for(const p of players){const player=String(p.athlete?.id||'');if(!id(player)||seen.has(player)||typeof p.starter!=='boolean')return fail('PERSONNEL_HISTORY_PLAYER_IDENTITY_INVALID');seen.add(player);}
    const starters=players.filter(p=>p.starter).map(p=>String(p.athlete.id)).sort();
    if(starters.length!==11)return fail('PERSONNEL_HISTORY_STARTING_XI_INCOMPLETE');
    teams[side]={sourceId:expected,starters,formation:rosters[0].formation||null};
  }
  let minutes;
  try{minutes=soccerMinutesAudit(payload,{status:'final',home:{sourceId:row.homeId},away:{sourceId:row.awayId}});}catch{minutes={status:'UNVERIFIED',reason:'PERSONNEL_HISTORY_MINUTES_SCHEMA_INVALID'};}
  return {ok:true,version:SOCCER_PERSONNEL_HISTORY_VERSION,row:{...row,personnel:{version:SOCCER_PERSONNEL_HISTORY_VERSION,source,teams,availability:'BACKFILLED_POSTMATCH_XI_NOT_PREMATCH_SAVED',sourcePublishedAt:null,pointInTimeAvailabilityVerified:false,minutes:{status:minutes.status,reason:minutes.reason||null,clockBasis:minutes.clockBasis||null,teams:minutes.status==='REGULATION_CLOCK_RECONSTRUCTED'?Object.fromEntries(['home','away'].map(side=>[side,{sourceId:row[`${side}Id`],teamPlayerMinutes:minutes.teams[side].teamPlayerMinutes,players:minutes.teams[side].players.map(p=>({id:p.id,starter:p.starter,appeared:p.appeared,regulationClockMinutes:p.regulationClockMinutes}))}])):null},modelEffectApplied:false}}};
}
