import { loadSoccerForwardEvidence } from './forward-validation-service.js';
import { diagnoseSoccerRetrospectivePairs } from './retrospective-pair-diagnostic.js';
import { validSoccerDate } from './contracts.js';

/** Read-only bounded research diagnostics. Inputs contain scope only. */
export async function readSoccerRetrospectivePairDiagnostic({league,date}={}, { load=loadSoccerForwardEvidence,
  diagnose=diagnoseSoccerRetrospectivePairs, now=Date.now() }={}) {
  if(!['epl','ucl'].includes(league)||!validSoccerDate(date)) throw Object.assign(Error('SOCCER_RETROSPECTIVE_SCOPE_INVALID'),{status:400});
  // Do not call the normal initialization path: GET/CLI must never create tables or protocols.
  const evidence=await load({league,date},{ensure:async()=>{},limit:500});
  if(evidence.truncated) return {status:'PARTIAL',league,date,forecastCoverage:'PARTIAL_BOUNDED_READ',
    excludedReasons:{FORECAST_INPUT_INCOMPLETE:1},reasonCodes:evidence.readCoverage?.reasons||[],
    selectedPairCount:0,formalEligible:false,calibrationEligible:false,promotionEligible:false,executable:false,OOS:false,W:null,R:null,S:null};
  return diagnose({league,date,protocol:evidence.protocol,captures:evidence.captures,now});
}
