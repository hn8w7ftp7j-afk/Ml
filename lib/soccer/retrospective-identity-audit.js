import { fetchSoccerSchedule } from './data.js';
import { soccerCompleteScheduleAuthorityVerified } from './reader-identity-proof.js';
import { soccerForwardHash } from './forward-validation.js';
import { soccerTeamLabel } from './team-labels.js';
import { soccerReaderMatchTeamKey } from './reader-team-identity.js';

// This later audit cannot issue the original-cutoff Reader identity proof.
// Only this process's normal schedule adapter can supply its candidate pages.
const receipts=new WeakMap();
const version='SOCCER-RETROSPECTIVE-SOURCE-IDENTITY-AUDIT-v1';
const restrictions={verifiedAtOriginalCutoff:false,providerCompletenessVerified:false,independentlyConfirmed:false,
  dateBoardCompletenessVerified:false,formalEligible:false,calibrationEligible:false,promotionEligible:false,executable:false,OOS:false};
const identity=game=>({id:game?.id,sourceId:game?.sourceId,league:game?.league,date:game?.date,startTime:game?.startTime,
  neutralSite:game?.neutralSite,home:{id:game?.home?.id,sourceId:game?.home?.sourceId,label:soccerTeamLabel(game?.home)},
  away:{id:game?.away?.id,sourceId:game?.away?.sourceId,label:soccerTeamLabel(game?.away)}});
const source=value=>({provider:value?.provider,url:value?.url,contentHash:value?.contentHash,fetchedAt:value?.fetchedAt});
const unavailable=reason=>({version,status:'UNAVAILABLE',reason,...restrictions});

export async function fetchSoccerRetrospectiveIdentityAudit(game,{now=Date.now,fetchImpl,timeoutMs=8000}={}){
  if(typeof now!=='function'||!Number.isFinite(now())||!game||!['epl','ucl'].includes(game.league))return unavailable('RETROSPECTIVE_IDENTITY_SCOPE_INVALID');
  // Read current historical pages. Never supply the old decision as a fetch
  // clock, reuse its source hash, or insert this audit into an old snapshot.
  let board;
  try{board=await fetchSoccerSchedule(game.league,game.date,{now,fetchImpl,timeoutMs,ttlMs:0});}
  catch{return unavailable('RETROSPECTIVE_IDENTITY_SOURCE_UNAVAILABLE');}
  const verifiedAt=now(),sources=board?.sources?.map(source);
  if(!Number.isFinite(verifiedAt)||!soccerCompleteScheduleAuthorityVerified(board,game)||!Array.isArray(sources)||sources.length!==2
    ||sources.some(row=>!Number.isFinite(Date.parse(row.fetchedAt))||Date.parse(row.fetchedAt)>verifiedAt||verifiedAt-Date.parse(row.fetchedAt)>180000))
    return unavailable('RETROSPECTIVE_IDENTITY_SOURCE_OR_GAME_UNVERIFIED');
  const matching=board.games.filter(candidate=>candidate.startTime===game.startTime&&['home','away'].every(side=>
    soccerReaderMatchTeamKey(soccerTeamLabel(candidate[side]))===soccerReaderMatchTeamKey(soccerTeamLabel(game[side]))));
  if(matching.length!==1||matching[0].id!==game.id)return unavailable('RETROSPECTIVE_IDENTITY_CANDIDATES_AMBIGUOUS');
  const body={version,status:'LATER_SOURCE_SCOPED_IDENTITY_VERIFIED',league:game.league,date:game.date,gameId:game.id,
    verifiedAt:new Date(verifiedAt).toISOString(),originalGameIdentityHash:soccerForwardHash(identity(game)),
    sourceScope:'TWO_RETURNED_PROVIDER_UTC_DATE_PAGES_NOT_UNIVERSAL_SCHEDULE_COMPLETENESS',
    sourceDates:[...board.coverage.sourceDates],sources,sourceManifestHash:board.source.contentHash,
    identityScope:'UNIQUE_AMONG_RETURNED_PROVIDER_DATE_PAGES',...restrictions};
  const audit={...body,contentHash:soccerForwardHash(body)};
  receipts.set(audit,{hash:audit.contentHash,board,gameHash:body.originalGameIdentityHash,verifiedAt});
  return audit;
}

// JSON, recomputed hashes and injected Boolean flags cannot authorize pairing.
// Returned candidates stay private and retain their actual current status.
export function soccerRetrospectiveIdentityCandidates(audit,game,now=Date.now()){
  const receipt=receipts.get(audit),{contentHash,...body}=audit||{};
  if(!receipt||contentHash!==receipt.hash||contentHash!==soccerForwardHash(body)||!Number.isFinite(now)||receipt.verifiedAt>now||now-receipt.verifiedAt>=180000
    ||body.sources.some(row=>now-Date.parse(row.fetchedAt)>=180000)
    ||receipt.gameHash!==soccerForwardHash(identity(game))||!soccerCompleteScheduleAuthorityVerified(receipt.board,game))return null;
  return receipt.board.games;
}
