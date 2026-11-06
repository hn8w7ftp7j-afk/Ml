import { loadSoccerForwardEvidence, readSoccerForwardProtocol } from './forward-validation-service.js';
import { loadSoccerRetrospectiveGameForecasts } from './retrospective-game-forecasts.js';
import { countSoccerRetrospectiveReaderMetadata, SOCCER_READER_METADATA_COUNT_SCOPE } from './retrospective-reader-receipts.js';
import { loadSoccerRetrospectiveGameReaderReceipts } from './retrospective-reader-receipts.js';
import { validateSoccerForwardCapture } from './forward-validation.js';
import { validSoccerDate } from './contracts.js';
import { fetchSoccerRetrospectiveIdentityAudit, soccerRetrospectiveIdentityCandidates } from './retrospective-identity-audit.js';
import { buildSoccerRetrospectivePairDiagnostic } from './retrospective-pair-diagnostic.js';

/** Read-only bounded research diagnostics. Inputs contain scope only. */
export async function readSoccerRetrospectivePairDiagnostic({league,date,gameId}={}, { load=loadSoccerForwardEvidence,
  loadGame=loadSoccerRetrospectiveGameForecasts, readProtocol=readSoccerForwardProtocol,
  readReader=countSoccerRetrospectiveReaderMetadata, validateForecast=validateSoccerForwardCapture,
  readReaderReceipts=loadSoccerRetrospectiveGameReaderReceipts, auditIdentity=fetchSoccerRetrospectiveIdentityAudit,
  now=Date.now() }={}) {
  if(!['epl','ucl'].includes(league)||!validSoccerDate(date)) throw Object.assign(Error('SOCCER_RETROSPECTIVE_SCOPE_INVALID'),{status:400});
  const readerSummary=async()=>{
    try{return await readReader(league,date,{maxRows:1000});}
    catch{return {status:'UNAVAILABLE',reasonCodes:['READER_RECEIPTS_UNAVAILABLE']};}
  };
  const readerCoverage=reader=>reader.status==='COMPLETE'?'COMPLETE_METADATA_COUNT_SINGLE_STATEMENT'
    :reader.status==='UNAVAILABLE'?'UNAVAILABLE':'PARTIAL_BOUNDED_METADATA_COUNT';
  const readerDescription={readerCountScope:SOCCER_READER_METADATA_COUNT_SCOPE,readerContentValidated:false};
  const readerDetails=reader=>({readerCoverage:readerCoverage(reader),...readerDescription,
    readerObservationCount:reader.status==='COMPLETE'?reader.observedCount:null});
  if(gameId!==undefined){
    if(typeof gameId!=='string'||!new RegExp(`^soccer:${league}:\\d{1,16}$`).test(gameId))
      throw Object.assign(Error('SOCCER_RETROSPECTIVE_SCOPE_INVALID'),{status:400});
    const scope={league,date,gameId}, evidence=await loadGame(league,date,gameId);
    const common={scope,dateCoverage:'PARTIAL_SINGLE_GAME',identityScope:'FULL_DATE_OFFICIAL_SCHEDULE_NOT_VERIFIED',
      crossRequestConsistency:'NOT_VERIFIED_SEPARATE_DATABASE_STATEMENTS',formalEligible:false,calibrationEligible:false,
      promotionEligible:false,executable:false,OOS:false,W:null,R:null,S:null};
    if(evidence.status!=='COMPLETE'){
      const reader=await readerSummary();
      return {...common,status:'PARTIAL',league,date,selectedPairCount:null,pairs:[],
      forecastCoverage:'PARTIAL_SINGLE_GAME_CURRENT_PROTOCOL',reasonCodes:[...(evidence.reasonCodes||['GAME_FORECAST_INPUT_INCOMPLETE']),...(reader.reasonCodes||[])],
      observedForecastCount:Number.isSafeInteger(evidence.observedCount)?evidence.observedCount:null,
      forecastCountScope:'BOUNDED_PREFIX_ONLY',...readerDetails(reader),
      pairCountScope:'UNAVAILABLE_IDENTITY_NOT_VERIFIED'};
    }
    const protocol=await readProtocol();
    const validCaptures=evidence.captures.filter(capture=>validateForecast(capture,protocol,now).ok),validForecastCount=validCaptures.length;
    const reader=await readerSummary();
    let laterIdentityAudit={status:'NOT_ATTEMPTED',reason:'NO_VALID_ORIGINAL_FORECAST'};
    // Later source reconciliation is distinct from original-cutoff authority.
    // Keep the saved prediction and Reader clocks unchanged; report only this
    // selected game's bounded research pairs, never active/OOS observations.
    if(validCaptures.length){
      const game=validCaptures[0].snapshot?.evidence?.game;
      let audit;
      try{audit=await auditIdentity(game);}catch{}
      laterIdentityAudit={status:'UNAVAILABLE',reason:audit?.reason||'RETROSPECTIVE_PRIVATE_IDENTITY_RECEIPT_UNVERIFIED'};
      const auditAt=Date.parse(audit?.verifiedAt),pairNow=Math.max(now,auditAt);
      if(Number.isFinite(pairNow)&&soccerRetrospectiveIdentityCandidates(audit,game,pairNow)){
        let receipts;
        try{receipts=await readReaderReceipts(league,date,game,{maxRows:1000});}catch{}
        if(receipts?.status==='COMPLETE'){
          const paired=buildSoccerRetrospectivePairDiagnostic({league,date,protocol,captures:evidence.captures,reader:receipts,identityAudit:audit,now:pairNow});
          return{...common,...paired,scope,dateCoverage:'PARTIAL_SINGLE_GAME',identityAudit:audit,
            forecastCoverage:'COMPLETE_SINGLE_GAME_CURRENT_PROTOCOL_STATEMENT',loadedForecastCount:evidence.captures.length,validForecastCount,
            readerCoverage:'COMPLETE_VALIDATED_ORIGINALS_FROM_FROZEN_MANIFEST',readerCountScope:'VALIDATED_IMMUTABLE_READER_RECEIPTS',
            readerContentValidated:true,readerObservationCount:receipts.observedCount,
            readerOriginalManifestHash:receipts.originalManifestHash,verifiedReaderOriginalCount:receipts.verifiedOriginalCount,readerOriginalPages:receipts.rawPayloadPages,
            verifiedAtOriginalCutoff:false,dateBoardCompletenessVerified:false};
        }
        return{...common,status:'PARTIAL',league,date,identityAudit:audit,validForecastCount,...readerDetails(reader),
          reasonCodes:receipts?.reasonCodes||['READER_VALIDATED_RECEIPTS_UNAVAILABLE'],selectedPairCount:null,uniqueGames:null,pairs:[],
          pairCountScope:'UNAVAILABLE_VALIDATED_READER_INPUT_INCOMPLETE'};
      }
    }
    // A single saved game cannot rule out a second official game with the
    // same team/time identity. Existing individual cohort rows are not an
    // immutable complete scoreboard manifest, so never invoke the matcher.
    return {...common,status:'PARTIAL',league,date,gameDiagnosticStatus:'IDENTITY_UNVERIFIED',
      laterIdentityAudit,
      forecastCoverage:'COMPLETE_SINGLE_GAME_CURRENT_PROTOCOL_STATEMENT',loadedForecastCount:evidence.captures.length,validForecastCount,
      ...readerDetails(reader),
      reasonCodes:['FULL_DATE_OFFICIAL_IDENTITY_NOT_VERIFIED',...(reader.reasonCodes||[])],
      selectedPairCount:null,uniqueGames:null,pairs:[],
      forecastReceiptPrecision:'MICROSECOND_SOURCE_MILLISECOND_CONSERVATIVE_PAIRING',pairCountScope:'UNAVAILABLE_IDENTITY_NOT_VERIFIED'};
  }
  // Do not call the normal initialization path: GET/CLI must never create tables or protocols.
  const evidence=await load({league,date},{ensure:async()=>{},limit:500});
  if(evidence.truncated){
    const reader=await readerSummary();
    return {status:'PARTIAL',league,date,forecastCoverage:'INPUT_EVIDENCE_PARTIAL_BOUNDED_READ',
    excludedReasons:{EVIDENCE_INPUT_INCOMPLETE:1},reasonCodes:['FULL_DATE_OFFICIAL_IDENTITY_NOT_VERIFIED',...(evidence.readCoverage?.reasons||[]),...(reader.reasonCodes||[])],
    loadedForecastCount:Number.isSafeInteger(evidence.readCoverage?.loadedCaptureRows)?evidence.readCoverage.loadedCaptureRows:null,
    forecastCountScope:'LOADED_ROWS_NOT_PROVEN_COMPLETE',...readerDetails(reader),
    crossRequestConsistency:'NOT_VERIFIED_SEPARATE_DATABASE_STATEMENTS',
    selectedPairCount:null,pairs:[],pairCountScope:'UNAVAILABLE_IDENTITY_NOT_VERIFIED',
    formalEligible:false,calibrationEligible:false,promotionEligible:false,executable:false,OOS:false,W:null,R:null,S:null};
  }
  const validForecastCount=evidence.captures.filter(capture=>validateForecast(capture,evidence.protocol,now).ok).length;
  const reader=await readerSummary();
  // Even all saved forecasts do not prove every official schedule candidate
  // was saved. Until a complete original official schedule is available, a
  // unique-match claim would be ungrounded. Do not invoke the pairing engine.
  return {status:'PARTIAL',league,date,forecastCoverage:'NOT_VERIFIED_MULTIPLE_STATEMENTS',
    identityScope:'FULL_DATE_OFFICIAL_SCHEDULE_NOT_VERIFIED',crossRequestConsistency:'NOT_VERIFIED_SEPARATE_DATABASE_STATEMENTS',
    loadedForecastCount:evidence.captures.length,validForecastCount,
    ...readerDetails(reader),
    reasonCodes:['FULL_DATE_OFFICIAL_IDENTITY_NOT_VERIFIED',...(reader.reasonCodes||[])],
    selectedPairCount:null,uniqueGames:null,pairs:[],pairCountScope:'UNAVAILABLE_IDENTITY_NOT_VERIFIED',
    formalEligible:false,calibrationEligible:false,promotionEligible:false,executable:false,OOS:false,W:null,R:null,S:null};
}
