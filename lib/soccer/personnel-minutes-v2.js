import { normalizeSoccerPersonnelHistory, soccerPersonnelHash } from './personnel-history.js';
import { soccerMinutesAudit, soccerMinutesAuditV2, SOCCER_MINUTES_AUDIT_V2_VERSION } from './personnel-audit.js';

export const SOCCER_PERSONNEL_MINUTES_V2_VERSION='SOCCER-RETAINED-PERSONNEL-MINUTES-OBSERVATION-v2';
const failure=code=>({ok:false,version:SOCCER_PERSONNEL_MINUTES_V2_VERSION,code,observation:null,
  modelEffectApplied:false,pointInTimeAvailabilityVerified:false,formalEligible:false,executable:false});

// Pure, separately versioned derivation from the retained postmatch projection.
// The original row/personnel object, projection hash and source fetch timestamps
// remain unchanged. This is observed participation, never a pregame forecast.
export function normalizeSoccerPersonnelHistoryV2(row,payload,source){
  const original=normalizeSoccerPersonnelHistory(row,payload,source);
  if(!original.ok)return failure(original.code);
  if(source.contentSemantics!=='RETAINED_EXTRACTION_PROJECTION'
    ||!/^[a-f0-9]{64}$/.test(source.originalResponseHash||'')||source.sourcePublishedAt!==null)
    return failure('PERSONNEL_MINUTES_V2_RETAINED_SOURCE_UNVERIFIED');
  const game={status:'final',home:{sourceId:row.homeId},away:{sourceId:row.awayId}};
  const minutes=soccerMinutesAuditV2(payload,game);
  const corrections=[];
  if(original.row.personnel.minutes.status==='REGULATION_CLOCK_RECONSTRUCTED'
    &&minutes.status==='REGULATION_CLOCK_RECONSTRUCTED'){
    const before=soccerMinutesAudit(payload,game),byId=new Map(payload.keyEvents.map(event=>[String(event.id),event]));
    const correctedReviews=Object.values(before.teams).flatMap(team=>team.events.filter(event=>event.type.includes('DISMISSAL'))
      .map(event=>({event,source:byId.get(event.eventId)}))
      .filter(value=>['var---red-card-upgrade','var---red-card-given'].includes(value.source?.type?.type))
      .map(value=>({eventId:value.event.eventId,playerId:value.event.playerId,providerType:value.source.type.type,
        providerTypeId:String(value.source.type.id),sourceText:value.source.text??null,
        originalDismissalSecond:value.event.second,correction:'INFORMATIONAL_REVIEW_DOES_NOT_REMOVE_PLAYER'})));
    if(correctedReviews.length)corrections.push({code:'VAR_REVIEW_MISCLASSIFIED_AS_DISMISSAL',events:correctedReviews});
  }
  const observation={version:SOCCER_PERSONNEL_MINUTES_V2_VERSION,extractorVersion:SOCCER_MINUTES_AUDIT_V2_VERSION,
    league:row.league,eventId:row.eventId,startTime:row.startTime,homeId:row.homeId,awayId:row.awayId,
    period:'REGULATION_FT',source:structuredClone(source),sourceRepresentation:'RETAINED_EXTRACTION_PROJECTION',
    originalHistoryRowHash:soccerPersonnelHash(row),
    originalMinutes:{status:original.row.personnel.minutes.status,reason:original.row.personnel.minutes.reason},corrections,
    minutes,availability:'BACKFILLED_POSTMATCH_OBSERVATION_NOT_PREMATCH_SAVED',sourcePublishedAt:null,
    pointInTimeAvailabilityVerified:false,physicalElapsedMinutesVerified:false,
    modelEffectApplied:false,formalEligible:false,executable:false};
  return{ok:true,version:SOCCER_PERSONNEL_MINUTES_V2_VERSION,observation,
    modelEffectApplied:false,pointInTimeAvailabilityVerified:false,formalEligible:false,executable:false};
}
