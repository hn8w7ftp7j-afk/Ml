// TEST PROCESS ONLY. Historical arithmetic regression fixtures model an
// independently certified schedule that Production does not currently have.
// This loader is passed explicitly to selected synthetic Node test processes;
// no runtime route, CLI or environment variable enables it. Real admission is
// independently exercised without this loader in soccer-analysis-identity-test.
console.error('SYNTHETIC TEST ONLY: schedule authority is mocked; no Production identity verification or acceptance.');
const moduleUrl = 'data:text/javascript,' + encodeURIComponent(`
export function registerSoccerScheduleIdentityBoard(board){return board;}
export const SOCCER_READER_IDENTITY_PROOF_VERSION='SOCCER-COMPLETE-SCHEDULE-IDENTITY-v1';
export function soccerCompleteScheduleAuthorityVerified(board,game) { return board?.coverage?.identityComplete===true; }
export function createVerifiedSoccerScheduleIdentityEvidence(board,game,source,now) {
  if(!soccerCompleteScheduleAuthorityVerified(board,game)||!source?.contentHash)return null;
  return { version:SOCCER_READER_IDENTITY_PROOF_VERSION,status:'COMPLETE_SCHEDULE_IDENTITY_VERIFIED',league:game.league,gameId:game.id,date:game.date,sourceHash:source.contentHash,verifiedAt:new Date(now).toISOString() };
}
export function soccerReaderIdentityVerified(snapshot) {
  const p=snapshot?.readerIdentityEvidence,g=snapshot?.evidence?.game,s=snapshot?.inputVersions?.scheduleSourceVersion;
  const at=Date.parse(p?.verifiedAt),cutoff=Date.parse(snapshot?.analysisCutoff);
  return Boolean(p?.version===SOCCER_READER_IDENTITY_PROOF_VERSION&&p.status==='COMPLETE_SCHEDULE_IDENTITY_VERIFIED'
    &&p.league===snapshot?.league&&p.gameId===snapshot?.gameId&&p.date===snapshot?.date
    &&g?.id===p.gameId&&g?.league===p.league&&g?.date===p.date
    &&/^[a-f0-9]{64}$/.test(p.sourceHash||'')&&p.sourceHash===s?.contentHash
    &&Number.isFinite(at)&&Number.isFinite(cutoff)&&at<=cutoff);
}`);

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') return nextResolve('next/server.js', context);
  if (specifier.endsWith('/reader-identity-proof.js') || specifier === './reader-identity-proof.js') {
    return { url: moduleUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
