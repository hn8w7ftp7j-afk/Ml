// Runtime input guard for the frozen historical minutes extractors. The
// extractors and their recorded implementation hashes remain unchanged.
import { soccerMinutesAudit as frozenV1, soccerMinutesAuditV2 as frozenV2,
  SOCCER_MINUTES_AUDIT_V2_VERSION } from './personnel-audit.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (reason, teamSide, v2) => {
  const validScope = [null, 'home', 'away'].includes(teamSide);
  const result = { status:'UNVERIFIED', reason, players:[], teamPlayerMinutes:null,
    clockBasis:'PROVIDER_REGULATION_SECONDS_EXCLUDES_ADDED_TIME', physicalElapsedMinutesVerified:false,
    modelEffectApplied:false, teamScope:validScope?(teamSide===null?'BOTH':'TEAM_ONLY'):'UNVERIFIED',
    teamSide:validScope?teamSide:null };
  return v2?{...result,version:SOCCER_MINUTES_AUDIT_V2_VERSION,
    roleResolutionPolicy:'EXACT_TEXT_OR_UNIQUE_SOURCE_IDS_ACTIVE_STATE_WITH_ROSTER_FLAGS',
    dismissalPolicy:'EXPLICIT_ESPN_TYPE_93_RED_CARD_ONLY_VAR_REVIEW_IS_INFORMATIONAL',
    informationalCardReviewCount:null,stateResolvedSubstitutions:null,
    interpretation:'OBSERVED_POSTMATCH_REGULATION_CLOCK_NOT_FORECAST_OR_PIT_PROOF',
    pointInTimeAvailabilityVerified:false,formalEligible:false,modelEffectApplied:false}:result;
};
function schemaReason(payload,game,teamSide,v2){
  if(!record(payload)||!record(game))return 'MINUTES_INPUT_SCHEMA_UNVERIFIED';
  if(![null,'home','away'].includes(teamSide))return 'AUDIT_TEAM_SCOPE_INVALID';
  // The frozen implementation reports non-final matches before reading arrays.
  if(game.status!=='final')return null;
  if(!Array.isArray(payload.keyEvents)||payload.keyEvents.length>1000)return 'EVENT_TIMELINE_MISSING';
  if(payload.keyEvents.some(event=>!record(event)))return 'EVENT_TIMELINE_SCHEMA_UNVERIFIED';
  if(!Array.isArray(payload.rosters)||payload.rosters.some(group=>!record(group)))return 'ROSTER_SCOPE_INVALID';
  const sides=teamSide===null?['home','away']:[teamSide];
  for(const side of sides){
    if(!record(game[side])||game[side].sourceId==null)return 'ROSTER_SCOPE_INVALID';
    const groups=payload.rosters.filter(group=>String(group.team?.id)===game[side].sourceId&&group.homeAway===side);
    if(groups.length!==1)return 'ROSTER_SCOPE_INVALID';
    const roster=groups[0].roster;
    if(roster==null)return 'ROSTER_PLAYERS_NOT_PROVIDED';
    if(!Array.isArray(roster)||roster.length>40||roster.some(player=>!record(player)))return 'ROSTER_PLAYERS_SCHEMA_UNVERIFIED';
    if(roster.some(player=>player.stats!=null&&(!Array.isArray(player.stats)||player.stats.some(stat=>!record(stat)))))return 'ROSTER_STATS_SCHEMA_UNVERIFIED';
    for(const event of payload.keyEvents.filter(event=>String(event.team?.id)===game[side].sourceId)){
      // Only events consumed as changes/reviews use participant lists. A valid
      // unrelated event on the opposing side cannot invalidate this team audit.
      const kind=typeof event.type?.type==='string'?event.type.type:'';
      if(!/substitution|red-card|yellow-red-card|second-yellow/.test(kind))continue;
      // V2 treats these exact provider VAR types as informational, not as a
      // dismissal; the frozen extractor permits their participant list to be
      // absent. Preserve that behavior while still rejecting malformed lists.
      const review=v2&&({'var---red-card-upgrade':'167','var---red-card-given':'168'})[kind]===String(event.type?.id);
      if(review&&event.participants==null)continue;
      if(event.participants==null)return 'EVENT_PARTICIPANTS_NOT_PROVIDED';
      if(!Array.isArray(event.participants)||event.participants.some(participant=>!record(participant)))return 'EVENT_PARTICIPANTS_SCHEMA_UNVERIFIED';
    }
  }
  return null;
}
function audit(payload,game,options,v2){
  const teamSide=options?.teamSide??null;
  try{
    const reason=schemaReason(payload,game,teamSide,v2);
    if(reason)return invalid(reason,teamSide,v2);
    return (v2?frozenV2:frozenV1)(payload,game,options);
  }catch{return invalid('MINUTES_INPUT_SCHEMA_UNVERIFIED',teamSide,v2);}
}
export const soccerMinutesAudit = (payload,game,options) => audit(payload,game,options,false);
export const soccerMinutesAuditV2 = (payload,game,options) => audit(payload,game,options,true);
