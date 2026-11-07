import { createHash } from 'node:crypto';

export const SOCCER_WYSCOUT_SHOT_SOURCE_VERSION = 'SOCCER-WYSCOUT-SHOT-SOURCE-v1';
export const SOCCER_WYSCOUT_COORDINATE_CONTRACT = 'WYSCOUT_ATTACK_RIGHT_UNIT_SQUARE-v1';
const actualProvider = 'WYSCOUT_OPEN_DATA';
const syntheticProvider = 'SYNTHETIC_ENGINEERING_FIXTURE';
const restrictions = Object.freeze({ accepted:false, formalEligible:false, modelEffectApplied:false,
  executable:false, historicalAvailabilityVerified:false, independentUntouchedTestVerified:false, W:null,R:null,S:null });
const canonical = value => JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export const soccerWyscoutShotHash = value => createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const capabilities = new WeakMap();
const finite = value => typeof value==='number'&&Number.isFinite(value);
const integer = value => Number.isSafeInteger(value)&&value>=0;
const instant = value => typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)?Date.parse(value):NaN;
const fail = reason => ({ok:false,version:SOCCER_WYSCOUT_SHOT_SOURCE_VERSION,reason,...restrictions});
const deepFreeze = value => {if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(deepFreeze);Object.freeze(value);}return value;};

// Reviewed original Figshare v1 ZIPs, their English members, and a deterministic
// full-pass projection. No source URL, supplied licence flag, or recomputed hash
// of arbitrary caller data can acquire this actual-source identity.
export const SOCCER_WYSCOUT_SOURCE_CONTRACT = deepFreeze({
  collectionDoi:'10.6084/m9.figshare.c.4415000.v5',
  license:'CC BY 4.0', licenseUrl:'https://creativecommons.org/licenses/by/4.0/',
  attribution:'Pappalardo, Luca; Massucco, Emanuele (2019): Soccer match event dataset. Wyscout. Figshare.',
  eventsArticle:'10.6084/m9.figshare.7770599.v1',matchesArticle:'10.6084/m9.figshare.7770422.v1',
  eventsZipSha256:'877e015b716ffdeea18f04418e3f24fed307ed03c37ff305cabe1f47c4822a45',
  matchesZipSha256:'c8f92bb7533e5c127e043cee764c991b5c25b4f5e70a65be931baae0b1765ce9',
  originalEventsSha256:'301599543aa1a7fa457bb8ef33c9fe860bf81dca65d418d618d68abcda3defad',
  documents:{
    events:{url:'https://ndownloader.figshare.com/files/14464685',hash:'627c31f38e33e90dd0cfeff07ba5527e69c191f31801dce2b6b504c83f38480c',
      representation:'DETERMINISTIC_NATIVE_EVENT_PROJECTION',archiveMember:'events_England.json',
      originalZipSha256:'877e015b716ffdeea18f04418e3f24fed307ed03c37ff305cabe1f47c4822a45',
      originalMemberSha256:'301599543aa1a7fa457bb8ef33c9fe860bf81dca65d418d618d68abcda3defad',
      projectionVersion:'WYSCOUT_FULL_PASS_NATIVE_SHOT_PROJECTION-v1'},
    matches:{url:'https://ndownloader.figshare.com/files/14464622',hash:'620725c2e6a58b4db3e574ed6c559136477451d81af543f8a06bd85c3da3fe29',
      representation:'ORIGINAL_ZIP_MEMBER',archiveMember:'matches_England.json',
      originalZipSha256:'c8f92bb7533e5c127e043cee764c991b5c25b4f5e70a65be931baae0b1765ce9',
      originalMemberSha256:'620725c2e6a58b4db3e574ed6c559136477451d81af543f8a06bd85c3da3fe29'},
    eventMapping:{url:'https://ndownloader.figshare.com/files/21385245',hash:'ce7bafb341b36ab4c6093bf1c09c967e9cea10d4223724a1fc679086e5d16842',representation:'DECODED_UTF8_RESPONSE'},
    tagMapping:{url:'https://ndownloader.figshare.com/files/21385239',hash:'e0bc1bd8ff6ea5339586fdfc3e8e9b285a4a18f1ae2f5868ccc9ec9cecc8a922',representation:'DECODED_UTF8_RESPONSE'},
  },
});

function readDocument(doc,kind,synthetic,now){
  const text=doc?.text,inputSource=doc?.source;
  const source=Object.fromEntries(['provider','url','contentHash','fetchedAt','representation','archiveMember',
    'originalZipSha256','originalMemberSha256','projectionVersion'].map(key=>[key,inputSource?.[key]]));
  if(typeof text!=='string'||Buffer.byteLength(text)>8*1024*1024||typeof source.url!=='string'
    ||source.provider!==(synthetic?syntheticProvider:actualProvider)
    ||soccerWyscoutShotHash(text)!==source.contentHash
    ||!Number.isFinite(instant(source.fetchedAt))||instant(source.fetchedAt)>now)return null;
  const pinned=SOCCER_WYSCOUT_SOURCE_CONTRACT.documents[kind];
  if(!synthetic&&(source.url!==pinned.url||source.contentHash!==pinned.hash
    ||Object.entries(pinned).some(([key,value])=>!['url','hash'].includes(key)&&source[key]!==value)))return null;
  if(synthetic){try{if(new URL(source.url).hostname!=='fixture.invalid')return null;}catch{return null;}}
  return {text,source};
}
function mapping(text){
  const rows=text.trim().split(/\r?\n/).map(row=>row.split(','));
  return new Map(rows.slice(1).map(row=>[row[0],row]));
}
function sourceKickoff(match){
  if(typeof match.dateutc!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(match.dateutc))return null;
  // The official Wyscout contract explicitly defines dateutc as UTC. Also
  // cross-check the separate local date carrying its own GMT offset.
  const utc=Date.parse(match.dateutc.replace(' ','T')+'Z');
  if(!Number.isFinite(utc)||new Date(utc).toISOString().slice(0,19)!==match.dateutc.replace(' ','T')
    ||typeof match.date!=='string'||!/GMT[+-]\d{1,2}(?::?\d{2})?$/.test(match.date))return null;
  const local=Date.parse(match.date.replace(' at ',' '));
  return Number.isFinite(local)&&local===utc?new Date(utc).toISOString():null;
}

/** Private model input from fixed, authentic open-data bytes. The explicit
 * synthetic-provider branch exercises exactly the parser in engineering tests;
 * it never claims actual source authentication or an accepted predictive model. */
export function normalizeSoccerWyscoutShotDataset({eventsDocument,matchesDocument,eventsMappingDocument,tagsMappingDocument,now=Date.now()}={}){
  const provider=eventsDocument?.source?.provider,synthetic=provider===syntheticProvider;
  if(!finite(now)||(!synthetic&&provider!==actualProvider))return fail('WYSCOUT_SOURCE_SCOPE_INVALID');
  // Genuine byte validation happened in this process now. Caller-declared
  // fetch clocks or an old historical match date cannot backdate that fact.
  if(!synthetic)now=Date.now();
  const docs={events:readDocument(eventsDocument,'events',synthetic,now),matches:readDocument(matchesDocument,'matches',synthetic,now),
    eventMapping:readDocument(eventsMappingDocument,'eventMapping',synthetic,now),tagMapping:readDocument(tagsMappingDocument,'tagMapping',synthetic,now)};
  if(Object.values(docs).some(value=>!value))return fail('WYSCOUT_SOURCE_DOCUMENT_UNVERIFIED');
  let stream,index;try{stream=JSON.parse(docs.events.text);index=JSON.parse(docs.matches.text);}catch{return fail('WYSCOUT_SOURCE_JSON_INVALID');}
  const tagsMap=mapping(docs.tagMapping.text),eventRows=docs.eventMapping.text.trim().split(/\r?\n/).slice(1).map(row=>row.split(','));
  const required=[[10,100,'Shot','Shot'],[3,33,'Free Kick','Free kick shot'],[3,35,'Free Kick','Penalty']];
  if(required.some(row=>!eventRows.some(actual=>JSON.stringify(actual)===JSON.stringify(row.map(String))))
    ||tagsMap.get('101')?.[2]!=='Goal'||tagsMap.get('102')?.[2]!=='Own goal')return fail('WYSCOUT_MAPPING_CONTRACT_INVALID');
  if(!Array.isArray(index)||!index.length||index.length>1000||!Array.isArray(stream?.events)
    ||stream.events.length>50000||!integer(stream.totalEvents)||stream.totalEvents<stream.events.length
    ||stream.uniqueEventIds!==stream.totalEvents||stream.projectionVersion!=='WYSCOUT_FULL_PASS_NATIVE_SHOT_PROJECTION-v1')return fail('WYSCOUT_SOURCE_COHORT_INVALID');
  if(!synthetic&&(index.length!==380||stream.totalEvents!==643150||stream.originalZipSha256!==SOCCER_WYSCOUT_SOURCE_CONTRACT.eventsZipSha256
    ||stream.originalMemberSha256!==SOCCER_WYSCOUT_SOURCE_CONTRACT.originalEventsSha256))return fail('WYSCOUT_PINNED_COHORT_INCOMPLETE');
  const games=new Map(),quarantine=new Map();
  const reject=(id,reason,details={})=>{if(!quarantine.has(id))quarantine.set(id,{matchId:String(id),reason,...details});};
  for(const raw of index){
    if(!integer(raw?.wyId)||raw.wyId<1||games.has(raw.wyId))return fail('WYSCOUT_MATCH_ID_CONFLICT');
    const kickoff=sourceKickoff(raw),entries=Object.entries(raw.teamsData||{}),sides={};
    if(raw.competitionId!==364||raw.seasonId!==181150||raw.status!=='Played'||raw.duration!=='Regular'||!kickoff
      ||Date.parse(kickoff)>=now||entries.length!==2||entries.some(([key,team])=>!integer(team?.teamId)||String(team.teamId)!==key
        ||!['home','away'].includes(team.side)||sides[team.side]||(sides[team.side]=team,false)
        ||!integer(team.score)||!integer(team.scoreHT)||team.scoreHT>team.score||team.scoreET!==0||team.scoreP!==0)){
      reject(raw.wyId,'WYSCOUT_MATCH_SCOPE_OR_TIME_INVALID');
    }
    games.set(raw.wyId,{raw,kickoff,sides,shots:[],goals:{home:0,away:0},halfGoals:{home:0,away:0},periods:new Set()});
  }
  const ids=new Set(),counts={standardShots:0,directFreeKickShots:0,penaltyShots:0,ownGoals:0,goalkeeperGoalTagsIgnored:0};
  for(const event of stream.events){
    if(!integer(event?.id)||event.id<1||ids.has(event.id))return fail('WYSCOUT_EVENT_ID_CONFLICT');ids.add(event.id);
    const game=games.get(event.matchId);if(!game)return fail('WYSCOUT_EVENT_MATCH_OUTSIDE_INDEX');
    const side=['home','away'].find(value=>game.sides[value]?.teamId===event.teamId),period={'1H':1,'2H':2}[event.matchPeriod];
    if(!side||!period||!finite(event.eventSec)||event.eventSec<0||!Array.isArray(event.tags)
      ||event.tags.some(tag=>!integer(tag?.id)||!tagsMap.has(String(tag.id)))
      ||new Set(event.tags.map(tag=>tag.id)).size!==event.tags.length){reject(event.matchId,'WYSCOUT_EVENT_IDENTITY_PERIOD_OR_TAG_INVALID');continue;}
    const tags=new Set(event.tags.map(tag=>tag.id)),goal=tags.has(101),own=tags.has(102);
    const shot=event.eventId===10&&event.subEventId===100,free=event.eventId===3&&event.subEventId===33,penalty=event.eventId===3&&event.subEventId===35;
    if(event.eventId===10&&!shot||event.subEventName==='Penalty'&&!penalty||event.subEventName==='Free kick shot'&&!free
      ||(shot||free||penalty)&&!required.some(([id,sub,name,subName])=>event.eventId===id&&event.subEventId===sub&&event.eventName===name&&event.subEventName===subName)){
      reject(event.matchId,'WYSCOUT_SHOT_TYPE_CONFLICT');continue;
    }
    if(goal&&own){reject(event.matchId,'WYSCOUT_GOAL_OWN_GOAL_CONFLICT');continue;}
    if(own){const beneficiary=side==='home'?'away':'home';game.goals[beneficiary]++;if(period===1)game.halfGoals[beneficiary]++;counts.ownGoals++;}
    if(!shot&&!free&&!penalty){if(goal&&event.eventId===9)counts.goalkeeperGoalTagsIgnored++;else if(goal)reject(event.matchId,'WYSCOUT_UNKNOWN_SCORING_EVENT');continue;}
    counts[shot?'standardShots':free?'directFreeKickShots':'penaltyShots']++;
    if(own){reject(event.matchId,'WYSCOUT_OWN_GOAL_SHOT_TARGET_UNSUPPORTED');continue;}
    const pos=event.positions?.[0];
    if(!pos||![pos.x,pos.y].every(value=>finite(value)&&value>=0&&value<=100)){reject(event.matchId,'WYSCOUT_SHOT_START_COORDINATES_INVALID');continue;}
    if(goal){game.goals[side]++;if(period===1)game.halfGoals[side]++;}
    game.periods.add(period);game.shots.push({shotId:String(event.id),teamId:String(event.teamId),period,x:pos.x/100,y:pos.y/100,goal,penalty,
      shotType:shot?'OPEN_SHOT':free?'DIRECT_FREE_KICK_SHOT':'PENALTY',eventSec:event.eventSec});
  }
  for(const [id,game] of games){
    if(quarantine.has(id))continue;
    if(![1,2].every(period=>game.periods.has(period)))reject(id,'WYSCOUT_SHOT_PERIOD_COVERAGE_UNVERIFIED');
    for(const side of ['home','away'])if(game.goals[side]!==game.sides[side].score||game.halfGoals[side]!==game.sides[side].scoreHT)
      reject(id,'WYSCOUT_SCORE_RECONCILIATION_CONFLICT',{side,sourceScore:game.sides[side].score,shotAndOwnGoalScore:game.goals[side],
        sourceHalfTimeScore:game.sides[side].scoreHT,shotAndOwnGoalHalfTimeScore:game.halfGoals[side]});
  }
  const matches=[...games].filter(([id])=>!quarantine.has(id)).map(([id,game])=>({matchId:String(id),kickoff:game.kickoff,
    matchDate:game.kickoff.slice(0,10),teams:{home:String(game.sides.home.teamId),away:String(game.sides.away.teamId)},
    shots:game.shots.sort((a,b)=>a.period-b.period||a.eventSec-b.eventSec||a.shotId.localeCompare(b.shotId))})).sort((a,b)=>a.kickoff.localeCompare(b.kickoff)||a.matchId.localeCompare(b.matchId));
  if(!matches.length)return fail('WYSCOUT_NO_ELIGIBLE_MATCHES');
  const sourceHashes=Object.values(docs).map(doc=>doc.source.contentHash),sourceManifestHash=soccerWyscoutShotHash({contract:SOCCER_WYSCOUT_SOURCE_CONTRACT,sourceHashes});
  const completedAt=synthetic?now:Date.now();
  const dataset={ok:true,version:SOCCER_WYSCOUT_SHOT_SOURCE_VERSION,provider,league:'epl',season:'2017/2018',synthetic,
    sourceAuthenticationVerified:!synthetic,coordinateContract:SOCCER_WYSCOUT_COORDINATE_CONTRACT,
    sourceManifestHash,sourceHashes,sourceProvenance:Object.entries(docs).map(([kind,doc])=>({kind,...doc.source})),
    latestFetchedAt:new Date(Math.max(...Object.values(docs).map(doc=>instant(doc.source.fetchedAt)))).toISOString(),
    normalizedAt:new Date(completedAt).toISOString(),sourceAttribution:synthetic?{license:null,description:'Explicit synthetic engineering fixture, not observed football data'}:SOCCER_WYSCOUT_SOURCE_CONTRACT,
    coverage:{sourceMatches:index.length,eligibleMatches:matches.length,quarantinedMatches:quarantine.size,sourceEvents:stream.totalEvents,
      retainedNativeEvents:stream.events.length,fullPublishedCohortVerified:!synthetic,currentSeasonCoverage:false,uclCoverage:false,
      shotUniverse:counts,eligibleShots:matches.reduce((n,m)=>n+m.shots.length,0),eligibleNonPenaltyShots:matches.reduce((n,m)=>n+m.shots.filter(s=>!s.penalty).length,0)},
    quarantined:[...quarantine.values()],matches,...restrictions};
  deepFreeze(dataset);
  const signature=soccerWyscoutShotHash(dataset);
  capabilities.set(dataset,{signature,sourceAvailableAt:synthetic?now:Date.now(),synthetic});
  return dataset;
}

export function validateSoccerWyscoutShotDataset(dataset){
  const proof=capabilities.get(dataset);
  if(!proof||proof.signature!==soccerWyscoutShotHash(dataset))return {ok:false,reason:'WYSCOUT_PRIVATE_SOURCE_CAPABILITY_MISSING_OR_CHANGED'};
  return {ok:true,availableAt:new Date(proof.sourceAvailableAt).toISOString(),sourceAvailableAt:proof.sourceAvailableAt,trustedDatasetAvailableAt:proof.sourceAvailableAt,synthetic:proof.synthetic,
    sourceAuthenticationVerified:!proof.synthetic,sourceManifestHash:dataset.sourceManifestHash};
}
