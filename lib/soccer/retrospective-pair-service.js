import { loadSoccerForwardEvidence, readSoccerForwardProtocol } from './forward-validation-service.js';
import { loadSoccerRetrospectiveGameForecasts } from './retrospective-game-forecasts.js';
import { loadSoccerRetrospectiveReaderReceipts } from './retrospective-reader-receipts.js';
import { validateSoccerForwardCapture } from './forward-validation.js';
import { validSoccerDate } from './contracts.js';

/** Read-only bounded research diagnostics. Inputs contain scope only. */
export async function readSoccerRetrospectivePairDiagnostic({league,date,gameId}={}, { load=loadSoccerForwardEvidence,
  loadGame=loadSoccerRetrospectiveGameForecasts, readProtocol=readSoccerForwardProtocol,
  readReader=loadSoccerRetrospectiveReaderReceipts, validateForecast=validateSoccerForwardCapture,
  now=Date.now() }={}) {
  if(!['epl','ucl'].includes(league)||!validSoccerDate(date)) throw Object.assign(Error('SOCCER_RETROSPECTIVE_SCOPE_INVALID'),{status:400});
  const readerSummary=async()=>{
    try{return await readReader(league,date,{maxRows:1000});}
    catch{return {status:'UNAVAILABLE',reasonCodes:['READER_RECEIPTS_UNAVAILABLE']};}
  };
  const readerCoverage=reader=>reader.status==='COMPLETE'?'COMPLETE_SINGLE_STATEMENT'
    :reader.status==='UNAVAILABLE'?'UNAVAILABLE':'PARTIAL_BOUNDED_READ';
  if(gameId!==undefined){
    if(typeof gameId!=='string'||!new RegExp(`^soccer:${league}:\\d{1,16}$`).test(gameId))
      throw Object.assign(Error('SOCCER_RETROSPECTIVE_SCOPE_INVALID'),{status:400});
    const scope={league,date,gameId}, evidence=await loadGame(league,date,gameId);
    const common={scope,dateCoverage:'PARTIAL_SINGLE_GAME',identityScope:'FULL_DATE_OFFICIAL_SCHEDULE_NOT_VERIFIED',
      crossRequestConsistency:'NOT_VERIFIED_SEPARATE_DATABASE_STATEMENTS',formalEligible:false,calibrationEligible:false,
      promotionEligible:false,executable:false,OOS:false,W:null,R:null,S:null};
    if(evidence.status!=='COMPLETE')return {...common,status:'PARTIAL',league,date,selectedPairCount:null,pairs:[],
      forecastCoverage:'PARTIAL_SINGLE_GAME',reasonCodes:evidence.reasonCodes||['GAME_FORECAST_INPUT_INCOMPLETE'],
      observedForecastCount:Number.isSafeInteger(evidence.observedCount)?evidence.observedCount:null,
      forecastCountScope:'BOUNDED_PREFIX_ONLY',readerObservationCount:null,
      pairCountScope:'UNAVAILABLE_IDENTITY_NOT_VERIFIED'};
    const protocol=await readProtocol();
    const validForecastCount=evidence.captures.filter(capture=>validateForecast(capture,protocol,now).ok).length;
    const reader=await readerSummary();
    // A single saved game cannot rule out a second official game with the
    // same team/time identity. Existing individual cohort rows are not an
    // immutable complete scoreboard manifest, so never invoke the matcher.
    return {...common,status:'PARTIAL',league,date,gameDiagnosticStatus:'IDENTITY_UNVERIFIED',
      forecastCoverage:'COMPLETE_SINGLE_GAME_STATEMENT',loadedForecastCount:evidence.captures.length,validForecastCount,
      readerCoverage:readerCoverage(reader),
      readerObservationCount:reader.status==='COMPLETE'?reader.observedCount:null,
      reasonCodes:['FULL_DATE_OFFICIAL_IDENTITY_NOT_VERIFIED',...(reader.reasonCodes||[])],
      selectedPairCount:null,uniqueGames:null,pairs:[],
      forecastReceiptPrecision:'MICROSECOND_SOURCE_MILLISECOND_CONSERVATIVE_PAIRING',pairCountScope:'UNAVAILABLE_IDENTITY_NOT_VERIFIED'};
  }
  // Do not call the normal initialization path: GET/CLI must never create tables or protocols.
  const evidence=await load({league,date},{ensure:async()=>{},limit:500});
  if(evidence.truncated) return {status:'PARTIAL',league,date,forecastCoverage:'PARTIAL_BOUNDED_READ',
    excludedReasons:{FORECAST_INPUT_INCOMPLETE:1},reasonCodes:['FULL_DATE_OFFICIAL_IDENTITY_NOT_VERIFIED',...(evidence.readCoverage?.reasons||[])],
    loadedForecastCount:Number.isSafeInteger(evidence.readCoverage?.loadedCaptureRows)?evidence.readCoverage.loadedCaptureRows:null,
    forecastCountScope:'BOUNDED_PREFIX_ONLY',readerObservationCount:null,
    selectedPairCount:null,pairs:[],pairCountScope:'UNAVAILABLE_IDENTITY_NOT_VERIFIED',
    formalEligible:false,calibrationEligible:false,promotionEligible:false,executable:false,OOS:false,W:null,R:null,S:null};
  const validForecastCount=evidence.captures.filter(capture=>validateForecast(capture,evidence.protocol,now).ok).length;
  const reader=await readerSummary();
  // Even all saved forecasts do not prove every official schedule candidate
  // was saved. Until a complete original official schedule is available, a
  // unique-match claim would be ungrounded. Do not invoke the pairing engine.
  return {status:'PARTIAL',league,date,forecastCoverage:'NOT_VERIFIED_MULTIPLE_STATEMENTS',
    identityScope:'FULL_DATE_OFFICIAL_SCHEDULE_NOT_VERIFIED',crossRequestConsistency:'NOT_VERIFIED_SEPARATE_DATABASE_STATEMENTS',
    loadedForecastCount:evidence.captures.length,validForecastCount,
    readerCoverage:readerCoverage(reader),
    readerObservationCount:reader.status==='COMPLETE'?reader.observedCount:null,
    reasonCodes:['FULL_DATE_OFFICIAL_IDENTITY_NOT_VERIFIED',...(reader.reasonCodes||[])],
    selectedPairCount:null,uniqueGames:null,pairs:[],pairCountScope:'UNAVAILABLE_IDENTITY_NOT_VERIFIED',
    formalEligible:false,calibrationEligible:false,promotionEligible:false,executable:false,OOS:false,W:null,R:null,S:null};
}
