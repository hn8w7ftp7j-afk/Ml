import assert from 'node:assert/strict';
import { buildSoccerReturnErrorDataset, buildSoccerReturnErrorDatasetHydrated, fitSoccerReturnErrorResearch,
  summarizeSoccerReturnErrorDatasets, mergeSoccerReturnErrorDiagnostics, SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL } from '../lib/soccer/return-error-model.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { evaluateSoccerMarketReturnCapture } from '../lib/soccer/market-return-validation.js';
import { evaluateSoccerForwardCapture, soccerForwardHash } from '../lib/soccer/forward-validation.js';
import { fixtureCapture, changed, resultFor, protocol, active, observed, after, iso } from './helpers/soccer-forward-fixture.mjs';

// Synthetic fixtures exercise the real adapters, payoff and settlement engine.
// They are never written as empirical production data or accepted artifacts.
const DAY=86400000;
const trustedContract=record=>({provider:'TAI888',version:'SYNTHETIC_TEST_ONLY',status:'SOURCE_TERMS_VERIFIED',evidenceRef:'synthetic://test-only',
  verifiedAt:iso(active-2000),league:record.league,period:record.period,kind:record.kind,line:record.line,type:'CREDIT_BOUNDARY',
  scope:'REGULATION_FT_WITH_STOPPAGE_NO_EXTRA_TIME_OR_PENALTIES',normalFinalOnly:true,abnormalStatusPolicy:'MANUAL_REVIEW',
  bindingEvidenceRef:'synthetic://account-binding',effectiveFrom:iso(active-10000),effectiveUntil:iso(active+100*DAY),
  rebate:{rate:.01,basis:'SETTLED_PRINCIPAL',appliesTo:{FULL_WIN:true,PARTIAL_WIN:true,PUSH:false,PARTIAL_LOSS:true,FULL_LOSS:true}}});
const captures=[],evaluations=[],checks=[];
for(let day=0;day<14;day++){
  const shift=time=>iso(Date.parse(time)+day*DAY);
  const capture=changed(fixtureCapture({id:String(1000+day),sequence:day+1}),value=>{
    const p=value.snapshot,g=p.evidence.game;
    for(const key of ['runStartedAt','observedAt','analysisCutoff'])p[key]=shift(p[key]);
    value.capturedAt=shift(value.capturedAt);g.startTime=shift(g.startTime);g.date=g.startTime.slice(0,10);p.date=g.date;value.date=g.date;
    for(const source of [p.evidence.source,p.evidence.scheduleSource,p.inputVersions.scheduleSourceVersion,g.source])source.fetchedAt=shift(source.fetchedAt);
    p.inputVersions.evidenceFetchedAt=p.evidence.source.fetchedAt;
    const receipt={revision:'b'.repeat(64),observationId:'c'.repeat(64),observedAt:p.analysisCutoff,
      firstFetchedAt:p.analysisCutoff,receivedAt:p.analysisCutoff,persistedAt:p.analysisCutoff,sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/'};
    const market={period:'FT',kind:'TOTAL',unit:'GOALS',line:'2.5',overWater:.95,underWater:.9,rawRows:['大2.5 0.95','小0.9'],
      periodEvidence:{period:'FT',status:'EXPLICIT',sectionTitle:'英格蘭超級聯賽',tableHeaders:['全場'],marketHeader:'全場大小'}};
    p.directions=buildSoccerMarketDirections({reader:receipt,game:g,now:Date.parse(p.analysisCutoff),matchedGames:[{officialGameId:g.id,
      league:'EPL',boardDate:g.date,matchStatus:'MATCHED',prestart:true,markets:[market]}]});
  });
  const result=resultFor(capture),at=after+day*DAY;
  result.observedAt=iso(at);result.sources.forEach(source=>{source.fetchedAt=iso(at);});
  result.fullTime={home:day%2?1:2,away:day%2?0:1,period:'REGULATION_FT'};
  result.resultHash=soccerForwardHash(['synthetic-result',day,result.fullTime]);
  const evaluation=evaluateSoccerForwardCapture(capture,protocol,result,at);
  assert.equal(evaluation.status,'EVALUATED');
  evaluation.marketReturnValidation=evaluateSoccerMarketReturnCapture({capture,protocol,result,now:at,resolveContract:trustedContract});
  assert.equal(evaluation.marketReturnValidation.status,'OBSERVED');
  captures.push(capture);evaluations.push(evaluation);checks.push({captureId:capture.captureId,checkedAt:iso(at),resultEvidence:result,marketReturnEvidenceHash:evaluation.marketReturnValidation.evidenceHash});
}
const now=Date.parse('2026-11-03T00:00:00.000Z');
const evidence={protocol,captures,evaluations,checks,truncated:false,readCoverage:{status:'COMPLETE_WITHIN_REQUESTED_SCOPE'},incompleteResultCaptureIds:[]};
const dataset=buildSoccerReturnErrorDataset(evidence,{now,resolveContract:trustedContract});
assert.equal(dataset.observedGames,14);assert.equal(dataset.observedQuoteReturns,28);
assert.equal(dataset.R,null);assert.equal(dataset.accepted,false);
const otherModel=changed(captures[0],value=>{
  value.captureId=soccerForwardHash('synthetic-second-legitimate-model');value.captureSequence='100';
  value.snapshot.prediction.trainingHash=soccerForwardHash('synthetic-second-training');
  value.snapshot.inputVersions.modelTrainingHash=value.snapshot.prediction.trainingHash;
});
const otherResult=structuredClone(checks[0].resultEvidence);
otherResult.fullTime={home:0,away:0,period:'REGULATION_FT'};otherResult.halfTime={home:0,away:0,period:'REGULATION_HT',verified:true};
otherResult.resultHash=soccerForwardHash('synthetic-conflicting-other-model-result');
const otherEvaluation=evaluateSoccerForwardCapture(otherModel,protocol,otherResult,after);
assert.equal(otherEvaluation.status,'EVALUATED');
otherEvaluation.marketReturnValidation=evaluateSoccerMarketReturnCapture({capture:otherModel,protocol,result:otherResult,now:after,resolveContract:trustedContract});
const otherDataset=buildSoccerReturnErrorDataset({...evidence,captures:[otherModel],evaluations:[otherEvaluation],
  checks:[{captureId:otherModel.captureId,checkedAt:iso(after),resultEvidence:otherResult,marketReturnEvidenceHash:otherEvaluation.marketReturnValidation.evidenceHash}]},{now,resolveContract:trustedContract});
assert.equal(otherDataset.observedQuoteReturns,2);assert.equal(otherDataset.quarantinedGames,0,'each independently built cohort can be internally consistent');
const conflictingFit=fitSoccerReturnErrorResearch({datasets:[dataset,otherDataset],now});
assert.equal(conflictingFit.observedQuoteReturns,26);assert.equal(conflictingFit.observedGames,13);assert.equal(conflictingFit.quarantinedGames,1);
const conflictingSummary=summarizeSoccerReturnErrorDatasets([dataset,otherDataset]);
assert.equal(conflictingSummary.observedQuoteReturns,26);assert.equal(conflictingSummary.observedGames,13);assert.equal(conflictingSummary.quarantinedGames,1,'result corrections cross model, variant and economic observation identities');
const laterEquivalent=structuredClone(evaluations[0]);
laterEquivalent.marketReturnValidation.checkedAt=iso(after+4*DAY);
const unorderedHistory=buildSoccerReturnErrorDataset({...evidence,evaluations:[laterEquivalent,...[...evaluations].reverse()],
  checks:[...checks,{...checks[0],checkedAt:iso(after+4*DAY)}]},{now,resolveContract:trustedContract});
assert.deepEqual(unorderedHistory,dataset,'later equivalent checks and array ordering cannot erase earliest valid persisted return evidence');
const delayedPersistence=buildSoccerReturnErrorDataset({...evidence,checks:checks.map((row,index)=>index?row:{...row,checkedAt:iso(after+4*DAY)})},{now,resolveContract:trustedContract});
assert.ok(delayedPersistence.observations.filter(row=>row.gameId===captures[0].gameId).every(row=>row.checkedAt===iso(after+4*DAY)), 'runtime evaluation timestamps cannot backdate a later database receipt');
const before=JSON.stringify(evidence);
const candidate={...SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL,trainingBefore:'2026-10-21T00:00:00Z',
  calibrationBefore:'2026-10-30T00:00:00Z',testBefore:'2026-11-02T00:00:00Z'};
const fit=fitSoccerReturnErrorResearch({datasets:[dataset],protocol:candidate,now});
assert.equal(fit.status,'NOT_ACCEPTED_RESEARCH_FIT');assert.equal(fit.groups.length,2);
for(const group of fit.groups){
  assert.equal(group.train.games,2);assert.equal(group.calibration.games,9);assert.equal(group.test.games,3);
  assert.equal(group.calibrationRank,9);assert.ok(Number.isFinite(group.realizedReturnBandRadius));
  assert.equal(group.testUntouchedVerified,false);assert.equal(group.accepted,false);assert.equal(group.R,null);
  assert.ok(group.missing.includes('DURABLE_PRETEST_MODEL_RECEIPT_MISSING'));
}
assert.deepEqual(fit,fitSoccerReturnErrorResearch({datasets:[dataset],protocol:candidate,now}),'fitting is deterministic');
assert.equal(JSON.stringify(evidence),before,'research cannot mutate archived predictions or results');
const noData=fitSoccerReturnErrorResearch({evidence:{protocol,captures:[],evaluations:[],checks:[]},now});
assert.equal(noData.status,'NOT_ACCEPTED_MISSING_DATA');assert.equal(noData.groups.length,0);assert.equal(noData.empiricalErrorMargin,null);
assert.ok(noData.missingReasons.RETURN_ERROR_OBSERVED_NET_RETURNS_MISSING);
assert.ok(noData.missingReasons.RETURN_ERROR_SPLIT_PROTOCOL_NOT_SPECIFIED);
const noContracts=buildSoccerReturnErrorDataset(evidence,{now});
assert.equal(noContracts.observedQuoteReturns,0,'unregistered source terms cannot be fitted merely from caller OBSERVED flags');
assert.ok(noContracts.excludedReasons.RETURN_ERROR_EXACT_RETURN_RECOMPUTE_FAILED);
const noSource=buildSoccerReturnErrorDataset({...evidence,checks:[]},{now,resolveContract:trustedContract});
assert.equal(noSource.observedQuoteReturns,0);assert.ok(noSource.excludedReasons.RETURN_ERROR_ORIGINAL_RESULT_EVIDENCE_MISSING);
const incomplete=buildSoccerReturnErrorDataset({...evidence,incompleteResultCaptureIds:[captures[0].captureId]},{now,resolveContract:trustedContract});
assert.equal(incomplete.observedGames,13);assert.equal(incomplete.quarantinedGames,1);
const correction=structuredClone(evaluations[0]);correction.actualScore={home:0,away:0};
const corrected=buildSoccerReturnErrorDataset({...evidence,evaluations:[...evaluations,correction]},{now,resolveContract:trustedContract});
assert.equal(corrected.observedGames,13,'any actual-score correction quarantines the entire real game');
const tampered=structuredClone(evidence);tampered.evaluations[0].marketReturnValidation.observations[0].realizedNetReturn=999;
assert.equal(buildSoccerReturnErrorDataset(tampered,{now,resolveContract:trustedContract}).observedGames,13,'changed sealed evidence is quarantined');
const partial=buildSoccerReturnErrorDataset({...evidence,truncated:true},{now,resolveContract:trustedContract});
assert.equal(fitSoccerReturnErrorResearch({datasets:[partial],protocol:candidate,now}).groups.length,0,'a partial requested range is never promoted into a fitted full cohort');
const short={...dataset,observations:dataset.observations.filter(row=>Date.parse(row.kickoff)<Date.parse('2026-10-25T00:00Z'))};
delete short.contentHash;short.contentHash=soccerForwardHash(short);
const unsupported=fitSoccerReturnErrorResearch({datasets:[short],protocol:candidate,now});
assert.ok(unsupported.groups.every(group=>group.realizedReturnBandRadius===null),'finite calibration rank support determines availability; no zero fallback');
let hydrated=0;
const streamed=await buildSoccerReturnErrorDatasetHydrated(evidence,{now,resolveContract:trustedContract,hydrateCapture:async id=>{hydrated++;return captures.find(value=>value.captureId===id);}});
assert.deepEqual(streamed,dataset);assert.equal(hydrated,14,'hydrate one capture once while processing its correlated quote rows');
const oneGame={...evidence,captures:[captures[0]],evaluations:[evaluations[0]],checks:[checks[0]],readCoverage:{status:'COMPLETE_WITHIN_REQUESTED_GAME'}};
const oneGameDataset=await buildSoccerReturnErrorDatasetHydrated(oneGame,{now,resolveContract:trustedContract,hydrateCapture:async()=>captures[0]});
assert.equal(oneGameDataset.coverage.completeWithinRequestedScope,true,'the private scanner complete-game unit is admissible internally');
assert.equal(oneGameDataset.observedQuoteReturns,2);
const prefixFit=fitSoccerReturnErrorResearch({datasets:[oneGameDataset],protocol:candidate,now,requestedScopeComplete:false});
assert.equal(prefixFit.requestedScopeComplete,false);assert.equal(prefixFit.groups.length,0,'complete games in an unfinished range never become a complete-range fit');
const futureCheck=structuredClone(evidence);futureCheck.evaluations[0].marketReturnValidation.checkedAt='2026-12-01T00:00:00Z';
const futureDataset=buildSoccerReturnErrorDataset(futureCheck,{now,resolveContract:trustedContract});
assert.equal(futureDataset.excludedReasons.RETURN_ERROR_CHECK_TIME_INVALID,2);
assert.equal(futureDataset.excludedReasons.RETURN_ERROR_TERMS_NOT_KNOWN_AT_PREDICTION,undefined,'future checks are not mislabeled as missing source terms');
const duplicated=fitSoccerReturnErrorResearch({datasets:[dataset,dataset],protocol:candidate,now});
assert.equal(duplicated.observedQuoteReturns,28);assert.equal(duplicated.observedGames,14,'duplicating a dataset cannot inflate the game count');
const duplicateCapture={...captures[0],captureId:soccerForwardHash('synthetic-heartbeat-receipt'),captureSequence:'1000'};
const heartbeat=buildSoccerReturnErrorDataset({...evidence,captures:[...captures,duplicateCapture]},{now,resolveContract:trustedContract});
assert.equal(heartbeat.observedQuoteReturns,28);assert.equal(heartbeat.duplicateEconomicObservations,2,'unchanged economic prices are not independent return samples');
const alteredTest=structuredClone(dataset);
alteredTest.observations.filter(row=>Date.parse(row.kickoff)>=Date.parse(candidate.calibrationBefore)).forEach(row=>{row.realizedNetReturn+=10;row.predictionError+=10;});
delete alteredTest.contentHash;alteredTest.contentHash=soccerForwardHash(alteredTest);
const alteredFit=fitSoccerReturnErrorResearch({datasets:[alteredTest],protocol:candidate,now});
assert.deepEqual(alteredFit.groups.map(group=>group.parameterHash),fit.groups.map(group=>group.parameterHash),'test outcomes cannot train or calibrate the error model');
assert.notDeepEqual(alteredFit.groups.map(group=>group.test.mae),fit.groups.map(group=>group.test.mae));
assert.ok(fitSoccerReturnErrorResearch({datasets:[dataset],protocol:candidate,now,verifyFrozenModelReceipt:()=>true}).groups.every(group=>!group.testUntouchedVerified),'candidate protocol cannot be declared preregistered by a model-only receipt flag');
const summary=summarizeSoccerReturnErrorDatasets([dataset,dataset]);
assert.equal(summary.observedQuoteReturns,28);assert.equal(summary.checkedQuoteObservations,28);assert.equal(summary.uncheckedQuoteObservations,0);
assert.ok(!JSON.stringify(summary).includes('rawRows')&&!JSON.stringify(summary).includes('www.tai888.in')&&!JSON.stringify(summary).includes(captures[0].gameId),'public diagnostic projection contains counts only');
assert.deepEqual(mergeSoccerReturnErrorDiagnostics([summary]),summary);
assert.equal(mergeSoccerReturnErrorDiagnostics([{...summary,checkedQuoteObservations:999}]).completeWithinRequestedScope,false);
const {buildSoccerReturnErrorArtifact}=await import('./soccer-return-error-build.mjs');
let pages=0;
const cli=await buildSoccerReturnErrorArtifact(['--database','--from','2026-10-19','--through','2026-11-02','--as-of','2026-11-03T00:00:00Z'],{
  scan:async(_scope,options)=>{
    const part=pages++===0?0:1;
    assert.equal(options.cursor,part?'synthetic-private-cursor':null);
    const ids=part?captures.slice(7):captures.slice(0,7),chosen=new Set(ids.map(value=>value.captureId));
    await options.onGameEvidence({...evidence,captures:ids,evaluations:evaluations.filter(row=>chosen.has(row.captureId)),
      checks:checks.filter(row=>chosen.has(row.captureId)),readCoverage:{status:'COMPLETE_WITHIN_REQUESTED_GAME'}},
      {now,hydrateCapture:async id=>captures.find(value=>value.captureId===id)});
    return{report:{complete:Boolean(part),scan:{nextCursor:part?null:'synthetic-private-cursor',processedGames:part?14:7}}};
  },
});
assert.equal(pages,2);assert.equal(cli.datasetHashes.length,2);assert.equal(cli.requestedScopeComplete,true);
assert.equal(cli.observedQuoteReturns,0,'CLI uses real server contract registry, never the test resolver');
assert.equal(cli.R,null);assert.equal(cli.accepted,false);
assert.equal(cli.missingReasons.RETURN_ERROR_EXACT_RETURN_RECOMPUTE_FAILED,28);
console.log('PASS return-error research: exact sealed-source recompute, economic dedup, whole-game correction quarantine, chronological train/calibration/test, game-balanced errors, supported order-statistic bands, no test fitting, missing-data nulls and bounded capture hydration; no acceptance or formal R');
