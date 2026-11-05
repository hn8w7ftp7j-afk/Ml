import { fetchSoccerJson,normalizeSoccerSchedule } from './data.js';
import { soccerLeague } from './contracts.js';
import { soccerMinutesAudit } from './personnel-audit-safe.js';
import { soccerObservationSources } from './source-evidence.js';
import { registerSoccerSourceDocument } from './source-document-store.js';

const clean=v=>typeof v==='string'?v.replace(/[<>\u0000-\u001f]/g,' ').trim().slice(0,160):null;
const unknown=(reason)=>({status:'UNKNOWN',value:null,reason,sourcePublishedAt:null});
const venueText = value => typeof value === 'string' && clean(value) === value && value.length > 0;
const providerId = value => typeof value === 'string' || Number.isSafeInteger(value) ? String(value) : '';

function venueIdentity(node) {
  const id = providerId(node?.id), name = node?.fullName, guid = node?.guid ?? null;
  const city = node?.address?.city ?? null, country = node?.address?.country ?? null;
  if (!/^[1-9]\d{0,15}$/.test(id) || !venueText(name)
    || guid !== null && (typeof guid !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(guid))
    || [city, country].some(value => value !== null && !venueText(value))) return null;
  return { id, name, guid, city, country };
}

function matchContextObservations(payload, game, competition, sources, prestart) {
  const { document } = sources;
  const league = soccerLeague(game.league);
  const summaryUrl = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/summary?event=${game.sourceId}`;
  if (!document.evidence.observedAvailabilityVerified || document.source.url !== summaryUrl
    || providerId(payload.header.id) !== game.sourceId || payload.header.competitions.length !== 1
    || providerId(competition.id) !== game.sourceId) return {};

  const observation = (node, field, value) => {
    const bound = sources.forField(node, field);
    return { status: prestart ? 'PROVIDER_REPORTED' : 'POSTSTART_OBSERVATION', value,
      source: bound.source, sourceEvidence: bound.evidence,
      independentlyConfirmed: false, formalEligible: false, modelEffectApplied: false };
  };
  const metadata = {};
  const venue = payload.gameInfo?.venue ?? competition.venue;
  const identity = venueIdentity(venue);
  const duplicate = payload.gameInfo?.venue != null && competition.venue != null;
  const corroborating = duplicate ? venueIdentity(competition.venue) : null;
  if (identity && (!duplicate || corroborating?.id === identity.id && corroborating.name === identity.name
    && ['guid', 'city', 'country'].every(field => !corroborating[field] || !identity[field] || corroborating[field] === identity[field]))) {
    metadata.venueObservation = observation(venue, 'venueObservation', identity);
  }

  // This exact season/phase pair is present in the retained UCL provider
  // document. Group labels and unknown phase IDs cannot imply a knockout tie.
  const season = payload.header.season, kickoff = Date.parse(game.startTime);
  if (game.league === 'ucl' && season?.year === 2026 && season.type === 14534
    && season.name === '2026-27 UEFA Champions League, League Phase'
    && kickoff >= Date.parse('2026-07-01T00:00:00Z') && kickoff < Date.parse('2027-07-01T00:00:00Z')) {
    metadata.uclPhaseObservation = observation(season, 'uclPhaseObservation', {
      phase: 'LEAGUE_PHASE', providerSeasonYear: season.year, providerSeasonType: season.type, providerSeasonName: season.name,
    });
  }
  return metadata;
}

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
  // Optional provider fields can change shape independently of the verified
  // match identity. Do not turn a malformed roster into a published empty XI.
  const rostersInvalid=payload.rosters!=null&&(!Array.isArray(payload.rosters)
    ||payload.rosters.some(r=>!r||typeof r!=='object'||Array.isArray(r)));
  for(const side of ['home','away']){
    const team=official[side],rosters=(rostersInvalid?[]:payload.rosters||[]).filter(r=>String(r.team?.id)===team.sourceId&&r.homeAway===side);
    if(rosters.length>1)return{ok:false,code:'SOCCER_ROSTER_TEAM_CONFLICT'};
    const roster=rosters[0],players=[];let invalid=false;
    const rosterReason=rostersInvalid?'ROSTER_SOURCE_SCHEMA_UNVERIFIED':roster&&roster.roster==null?'ROSTER_PLAYERS_NOT_PROVIDED'
      :roster&&(!Array.isArray(roster.roster)||roster.roster.length>40)?'ROSTER_PLAYERS_SCHEMA_UNVERIFIED':null;
    for(const p of (rosterReason?[]:roster?.roster||[]).slice(0,40)){
      const id=String(p?.athlete?.id||''),name=clean(p?.athlete?.displayName||p?.athlete?.fullName);
      if(!/^\d{1,16}$/.test(id)||!name||allIds.has(id)||typeof p?.starter!=='boolean'){invalid=true;continue;}allIds.add(id);
      const playerSource=sources.forField(p,`teams.${side}.lineup.${id}`);
      players.push({id,name,starter:p.starter,position:clean(p.position?.displayName||p.position?.name),jersey:clean(p.jersey),expectedMinutes:null,startProbability:null,replacementId:null,actualMinutes:null,sourcePublishedAt:playerSource.source.sourcePublishedAt,source:playerSource.source,sourceEvidence:playerSource.evidence,status:prestart?'PROVIDER_REPORTED':'POSTSTART_OBSERVATION'});
    }
    const starters=players.filter(p=>p.starter),lineupStatus=rosterReason?(rosterReason==='ROSTER_PLAYERS_NOT_PROVIDED'&&roster?.roster===undefined?'NOT_PUBLISHED':'UNKNOWN'):invalid?'IDENTITY_CONFLICT':starters.length===11?(prestart?'PROVIDER_REPORTED_XI':'POSTSTART_XI'):'NOT_PUBLISHED';
    if(invalid)return{ok:false,code:'SOCCER_ROSTER_PLAYER_CONFLICT'};
    const lineup=sources.forField(roster,`teams.${side}.lineup`);
    // A complete provider XI and its fetch receipt are not an independent
    // confirmation or evidence of a historical publication time.
    teams[side]={id:team.id,sourceId:team.sourceId,name:team.name,lineup:{status:lineupStatus,...(rosterReason?{reason:rosterReason}:{}),formation:clean(roster?.formation),starters,bench:players.filter(p=>!p.starter),source:lineup.source,rawSource:lineup.rawSource,sourcePublishedAt:lineup.source.sourcePublishedAt,sourceEvidence:lineup.evidence,independentlyConfirmed:false},
      injuries:availabilityList(payload,roster,team,side,'injuries',sources,official,now),
      suspensions:availabilityList(payload,roster,team,side,'suspensions',sources,official,now),minutes:unknown('MINUTES_MODEL_NOT_VALIDATED')};
  }
  for(const field of ['injuries','suspensions']){
    const homeIds=new Set((teams.home[field].value||[]).map(player=>player.id));
    if((teams.away[field].value||[]).some(player=>homeIds.has(player.id)))for(const side of ['home','away'])teams[side][field]=unknown(`${field==='injuries'?'INJURY':'SUSPENSION'}_CROSS_TEAM_PLAYER_CONFLICT`);
  }
  const referee=sources.forField(payload.gameInfo,'referee');
  const officialsInvalid=payload.gameInfo?.officials!=null&&(!Array.isArray(payload.gameInfo.officials)||payload.gameInfo.officials.some(o=>!o||typeof o!=='object'||Array.isArray(o)));
  const officials=(officialsInvalid?[]:payload.gameInfo?.officials||[]).slice(0,8).map(o=>{
    const bound=sources.forField(o,'referee.official');
    return{name:clean(o.displayName||o.fullName),role:clean(o.position?.displayName||o.type?.text),sourcePublishedAt:bound.source.sourcePublishedAt,source:bound.source,sourceEvidence:bound.evidence};
  }).filter(o=>o.name);
  const recent={},recentMissing={};
  const recentInvalid=payload.lastFiveGames!=null&&(!Array.isArray(payload.lastFiveGames)
    ||payload.lastFiveGames.some(group=>!group||typeof group!=='object'||Array.isArray(group)));
  for(const side of ['home','away']){
    const id=official[side].sourceId,groups=(recentInvalid?[]:payload.lastFiveGames||[]).filter(x=>String(x.team?.id)===id);if(groups.length>1)return{ok:false,code:'SOCCER_RECENT_TEAM_CONFLICT'};
    const events=groups[0]?.events;
    const invalid=recentInvalid||events!=null&&(!Array.isArray(events)||events.some(e=>!e||typeof e!=='object'||Array.isArray(e)));
    recentMissing[side]=invalid?'RECENT_SOURCE_SCHEMA_UNVERIFIED':groups.length===0||events==null?'RECENT_SOURCE_NOT_PROVIDED':null;
    recent[side]=(invalid?[]:events||[]).filter(e=>String(e.id)!==game.sourceId&&[String(e.homeTeamId),String(e.awayTeamId)].includes(id)&&Date.parse(e.gameDate)<now-6*3600000).slice(0,5).map(e=>({eventId:String(e.id),startTime:e.gameDate,competition:clean(e.leagueName||e.competitionName),score:clean(e.score),opponent:clean(e.opponent?.displayName),availability:'PROVIDER_RECENT_LIST_NOT_COMPLETE_WORKLOAD'}));
  }
  const evidence={ok:true,version:'SOCCER-PREMATCH-EVIDENCE-v2',league:league.id,game:official,phase:prestart?'PREMATCH_OBSERVATION':'POSTSTART_AUDIT',observedAt:source?.fetchedAt,source:document.source,rawSource:document.rawSource,sourceEvidence:document.evidence,
    observedAvailabilityVerified:prestart&&document.evidence.observedAvailabilityVerified,
    pointInTimeAvailabilityVerified:prestart&&document.evidence.publishedAvailabilityVerified,
    pointInTimeAvailabilityScope:'CURRENT_FETCHED_DOCUMENT_ONLY_NOT_HISTORICAL_ARCHIVE',historicalAvailabilityVerified:false,
    ...matchContextObservations(payload, official, competition, sources, prestart),
    teams,referee:officials.length?{status:'PROVIDER_REPORTED',officials,source:referee.source,rawSource:referee.rawSource,sourcePublishedAt:referee.source.sourcePublishedAt,sourceEvidence:referee.evidence,independentlyConfirmed:false}:unknown(officialsInvalid?'REFEREE_SOURCE_SCHEMA_UNVERIFIED':'REFEREE_NOT_PROVIDED'),recent,recentMissing,weather:unknown('PREMATCH_FORECAST_NOT_CONNECTED'),xg:unknown('CONSISTENT_XG_HISTORY_NOT_CONNECTED'),travel:unknown('ALL_COMPETITION_TRAVEL_NOT_VERIFIED'),uclContext:unknown(league.id==='ucl'?'ROUND_AGGREGATE_AND_DOMESTIC_STRENGTH_NOT_VERIFIED':'NOT_APPLICABLE'),minutesAudit:rostersInvalid?{status:'UNVERIFIED',reason:'ROSTER_SOURCE_SCHEMA_UNVERIFIED',players:[],teamPlayerMinutes:null,clockBasis:'PROVIDER_REGULATION_SECONDS_EXCLUDES_ADDED_TIME',physicalElapsedMinutesVerified:false,modelEffectApplied:false,teamScope:'BOTH',teamSide:null}:soccerMinutesAudit(payload,official),executable:false};
  return registerSoccerSourceDocument(evidence,payload);
}
export async function fetchSoccerPrematch(game,options={}){
  const league=soccerLeague(game?.league);if(!league||!/^\d{1,16}$/.test(game?.sourceId||''))return{ok:false,code:'SOCCER_SUMMARY_REQUEST_INVALID'};
  const r=await fetchSoccerJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/summary?event=${game.sourceId}`,{...options,ttlMs:30000});
  return r.ok?normalizeSoccerPrematch(r.data,game,r.source,options.now?.()??Date.now()):r;
}
