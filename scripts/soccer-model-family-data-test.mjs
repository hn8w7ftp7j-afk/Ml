import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { soccerCalibrationShadowFixture } from './helpers/soccer-calibration-shadow-fixture.mjs';
import { predictSoccerCalibrationResearch, soccerCalibrationHash } from '../lib/soccer/calibration-research.js';
import { predictHalfTimeDistribution } from '../lib/soccer/half-time-model.js';
import { soccerModelFamilyHash } from '../lib/soccer/model-family-uncertainty.js';
import { buildSoccerModelFamilyCalibrationDataset, readSoccerModelFamilyCalibrationScope,
  loadSoccerModelFamilyCalibrationDataset } from '../lib/soccer/model-family-data.js';

// Synthetic provider documents and private in-memory receipt callbacks exercise
// the Production adapter; no fixture is written to the real journal or accepted.
const f=soccerCalibrationShadowFixture(3),sha=value=>soccerCalibrationHash(value);
const protocol={registeredAt:f.artifacts.plan.createdAt,calibrationFrom:f.freezeReceipt.frozenAt,
  calibrationBefore:new Date(f.now).toISOString(),alpha:.1};
const check=(record,index=1,documents=f.resultDocuments(record))=>({checkId:sha(index),captureId:record.captureReceipt.captureId,
  league:'epl',checkedAt:new Date(f.now).toISOString(),resultDocuments:documents});
const checks=f.records.map((record,index)=>check(record,index+1));
const build=(changes={},deps={})=>buildSoccerModelFamilyCalibrationDataset({league:'epl',period:'FT',protocol,
  context:f.context(),checks,completeWithinRequestedScope:true,now:f.now,...changes},deps);
const sealed=value=>{const {contentHash,...body}=value;assert.equal(contentHash,soccerModelFamilyHash(body));};
const original=JSON.stringify({records:f.records,checks});
const ft=build(),ht=build({period:'HT'});
assert.equal(ft.observations.length,3);assert.equal(ht.observations.length,3);
assert.equal(ft.confidenceSet.independentRealGames,3);assert.equal(ft.outcomeCohortComplete,true);
assert.equal(ft.baseline.modelHash,f.artifacts.candidate.modelHash);
assert.equal(ht.baseline.modelHash,f.artifacts.candidate.jointHalfTimeModelHash);
assert.equal(ft.baseline.trainingHash,f.artifacts.model.trainingHash);
assert.equal(ht.baseline.trainingHash,sha({fullTimeTrainingHash:f.artifacts.model.trainingHash,
  halfTimeTrainingHash:f.artifacts.halfTimeModel.trainingHash}));
for(let index=0;index<f.records.length;index++) {
  const record=f.records[index],expected=predictSoccerCalibrationResearch({...f.artifacts,game:record.prediction.game,
    now:Date.parse(record.prediction.capturedAt)}),half=predictHalfTimeDistribution(expected.original,f.artifacts.halfTimeModel,
    {league:'epl',startTime:record.prediction.game.startTime});
  assert.equal(ft.observations[index].homeRate,expected.original.homeRate);
  assert.equal(ht.observations[index].awayRate,half.awayRate);
  assert.notEqual(ft.observations[index].homeRate,record.prediction.fullTime.homeRate,
    'source calibration candidate cannot silently replace the exact original FT baseline');
  assert.ok(ft.observations[index].sourceHashes.includes(checks[index].resultDocuments.scoreboard.source.contentHash));
}
for(const result of [ft,ht]) {
  sealed(result);sealed(result.confidenceSet);
  assert.equal(result.sourceModelFreezeVerified,true);
  assert.equal(result.familyProtocolRegistrationVerified,false);
  assert.equal(result.familyProtocolProspectiveVerified,false);
  assert.equal(result.coverageAssumptionsVerified,false);
  assert.equal(result.modelMisspecificationBound,null);
  for(const target of [result,result.confidenceSet])for(const key of ['W','R','S','empiricalErrorMargin'])assert.equal(target[key],null);
  assert.equal(result.formalEligible,false);assert.equal(result.executable,false);
}
assert.deepEqual(build({checks:[...checks,...checks].reverse()}).observations,ft.observations,
  'repeat provider checks, quote counts, and input order cannot increase independent-game information');
const earlierCheck={...checks[0],checkedAt:new Date(f.now-5000).toISOString()};
assert.equal(build({checks:[...checks,earlierCheck]}).observations[0].resultAvailableAt,earlierCheck.checkedAt,
  'the earliest fully verified result receipt is selected independently of replay order');
function duplicateCapture({shiftContext=false}={}) {
  const record=structuredClone(f.records[0]);
  record.prediction.capturedAt='2026-11-01T13:00:00.000Z';
  if(shiftContext)record.prediction.game.startTime='2026-11-02T20:00:00.000Z';
  const forecast=predictSoccerCalibrationResearch({...f.artifacts,game:record.prediction.game,now:Date.parse(record.prediction.capturedAt)});
  record.prediction.fullTime=forecast.fullTime;record.prediction.halfTime=forecast.halfTime;
  record.captureReceipt={...record.captureReceipt,captureId:sha(shiftContext?'shifted':'later'),
    capturedAt:record.prediction.capturedAt,predictionHash:sha(record.prediction)};
  const records=[record,...f.records],context={...f.context(),records,
    verifyCaptureReceipt:({receipt,predictionHash,capturedAt})=>records.some(value=>sha(value.captureReceipt)===sha(receipt)
      &&value.captureReceipt.predictionHash===predictionHash&&value.prediction.capturedAt===capturedAt)};
  return {record,context};
}
const duplicate=duplicateCapture();
const deduped=build({context:duplicate.context,checks:[check(duplicate.record,50),...checks]});
assert.equal(deduped.observations.length,3);
assert.equal(deduped.observations[0].captureId,f.records[0].captureReceipt.captureId,
  'the earliest original pregame receipt wins even when a later one is replayed first');
const shifted=duplicateCapture({shiftContext:true});
assert.equal(build({context:shifted.context,checks:[...checks,check(shifted.record,51)]}).quarantinedGames,1,
  'multiple trusted contexts for one real game cannot mix a selected rate with another kickoff');
assert.equal(JSON.stringify({records:f.records,checks}),original);
assert.equal(build({completeWithinRequestedScope:false}).confidenceSet,null);

const correction=check(f.records[0],10,f.resultDocuments(f.records[0],{homeScore:3}));
for(const period of ['FT','HT']) {
  const result=build({period,checks:[...checks,correction]});
  assert.equal(result.observations.length,2);assert.equal(result.quarantinedGames,1);
  assert.equal(result.outcomeCohortComplete,false);
  assert.deepEqual(result.quarantinedGameIds,[f.records[0].prediction.game.id]);
}
const extra=check(f.records[0],11,f.resultDocuments(f.records[0],{extraPeriod:true}));
assert.equal(build({checks:[...checks,extra]}).quarantinedGames,1,'a later AET proof invalidates earlier normal-final evidence');
const rehash=document=>{document.source.contentHash=createHash('sha256').update(JSON.stringify(document.data)).digest('hex');};
const chronologyNow=f.now+60000;
const timedCheck=(index,documents,sourceAt,checkedAt)=>{
  for(const document of [documents.scoreboard,...documents.summaries]) {
    document.source.fetchedAt=new Date(sourceAt).toISOString();document.source.requestedAt=document.source.fetchedAt;
  }
  return {...check(f.records[0],index,documents),checkedAt:new Date(checkedAt).toISOString()};
};
const withdrawal=timedCheck(60,f.resultDocuments(f.records[0],{live:true,homeScore:4}),f.now+30000,chronologyNow);
const incompleteCorrectionDocuments=f.resultDocuments(f.records[0],{homeScore:3});
for(const team of incompleteCorrectionDocuments.summaries[0].data.header.competitions[0].competitors)delete team.linescores;
rehash(incompleteCorrectionDocuments.summaries[0]);
const incompleteCorrection=timedCheck(61,incompleteCorrectionDocuments,f.now+30000,chronologyNow);
const chronologyBuild=changes=>build({now:chronologyNow,protocol:{...protocol,calibrationBefore:new Date(chronologyNow).toISOString()},...changes});
for(const period of ['FT','HT'])for(const later of [withdrawal,incompleteCorrection])for(const reverse of [false,true]) {
  const history=[...checks,later],result=chronologyBuild({period,checks:reverse?history.reverse():history});
  assert.equal(result.observations.length,2);assert.equal(result.quarantinedGames,1);
  assert.equal(result.outcomeCohortComplete,false);
  assert.ok(result.excludedReasons[later===withdrawal?'CALIBRATION_RESULT_FINAL_WITHDRAWN':'CALIBRATION_RESULT_FT_CORRECTION']);
}
const pendingBeforeFinal=timedCheck(62,f.resultDocuments(f.records[0],{live:true,homeScore:4}),f.now-60000,f.now-50000);
const recheckedOldLive=timedCheck(63,f.resultDocuments(f.records[0],{live:true,homeScore:4}),f.now-60000,chronologyNow);
for(const pending of [pendingBeforeFinal,recheckedOldLive])for(const reverse of [false,true]) {
  const history=[...checks,pending],result=chronologyBuild({checks:reverse?history.reverse():history});
  assert.equal(result.observations.length,3);assert.equal(result.quarantinedGames,0);
}
const forgedWithdrawal=structuredClone(withdrawal);forgedWithdrawal.resultDocuments.summaries[0].source.contentHash='0'.repeat(64);
assert.equal(chronologyBuild({checks:[...checks,forgedWithdrawal]}).quarantinedGames,0);
assert.equal(chronologyBuild({checks:[...checks,{...withdrawal,resultDocuments:null}]}).quarantinedGames,0);
const changed=f.resultDocuments(f.records[0]);
for(const document of [changed.scoreboard,...changed.summaries]) {
  const competition=(document===changed.scoreboard?document.data.events[0]:document.data.header).competitions[0];
  competition.neutralSite=true;rehash(document);
}
assert.equal(build({checks:[...checks,check(f.records[0],12,changed)]}).quarantinedGames,1,'verified context correction quarantines the entire game');
const corrupt=structuredClone(correction);corrupt.resultDocuments.scoreboard.source.contentHash='f'.repeat(64);
assert.equal(build({checks:[...checks,corrupt]}).quarantinedGames,0,'a forged hash cannot manufacture an official correction');
const missing=build({checks:checks.slice(1)});
assert.equal(missing.observations.length,2);assert.equal(missing.outcomeCohortComplete,false);
assert.equal(missing.excludedReasons.MODEL_FAMILY_CAPTURE_WITHOUT_VERIFIED_RESULT,1);
assert.equal(build({context:{...f.context(),verifyFreezeReceipt:()=>false}}).observations.length,0);
assert.equal(build({context:{...f.context(),verifyCaptureReceipt:()=>false}}).observations.length,0);
assert.equal(build({checks:checks.map(value=>({...value,resultDocuments:null,status:'EVALUATED',
  report:{untouchedVerifiedGames:999,coverageAssumptionsVerified:true}}))}).observations.length,0,
  'saved derived reports and VERIFIED flags cannot replace original provider documents');
const forgedContext=f.context();forgedContext.records=structuredClone(forgedContext.records);
forgedContext.records[0].prediction.fullTime.homeRate+=.1;
assert.equal(build({context:forgedContext}).observations.length,2,'mutated saved prediction is not vouched for by the immutable receipt');
assert.throws(()=>build({checks:[{...checks[0],league:'ucl'}]}),/RESULT_SCOPE_INVALID/);
assert.throws(()=>build({checks:[{...checks[0],captureId:'f'.repeat(64)}]}),/RESULT_SCOPE_INVALID/);
assert.throws(()=>build({checks:[{...checks[0],checkedAt:new Date(f.now+1).toISOString()}]}),error=>error.status===409&&/SOURCE_AFTER_AS_OF/.test(error.message));
assert.throws(()=>build({context:{...f.context(),candidate:{...f.artifacts.candidate,jointHalfTimeModelHash:'f'.repeat(64)}}}),/FROZEN_MODEL_SCOPE_INVALID/);
assert.throws(()=>build({league:'ucl'}),/FROZEN_MODEL_SCOPE_INVALID/);
const timed=build({}, {deadline:1,clock:()=>1});
assert.equal(timed.captureReplayComplete,false);assert.equal(timed.observations.length,0);assert.equal(timed.confidenceSet,null);
assert.equal(timed.completeWithinRequestedScope,false);

// The DB adapter owns all source reads. Only the private second argument below
// replaces its stores; its public input never accepts arbitrary observations.
const revision='b'.repeat(64),base={freeze:f.freezeReceipt,captureGames:f.records.length};
function stores({records=f.records,history=checks,historyLimit=100,clock=()=>0,mutateRevision=false}={}) {
  let revisionReads=0,historyReads=0;
  const deps={baseReport:async()=>({...base,captureGames:records.length}),
    readRevision:async()=>({captures:records.length,revision:mutateRevision&&++revisionReads>1?'c'.repeat(64):revision}),
    listCaptureIds:async(_league,{afterSequence,limit})=>{
      const start=Number(afterSequence),selected=records.slice(start,start+limit),complete=start+limit>=records.length;
      return {captureIds:selected.map(record=>record.captureReceipt.captureId),nextSequence:complete?null:String(start+limit),completeWithinRequestedScope:complete};
    },
    loadEvidence:async(_league,{captureIds,limit})=>f.context(captureIds,limit),
    readHistoryPage:async(_league,{captureIds,afterCheckId})=>{
      historyReads++;
      const full=history.filter(value=>captureIds.includes(value.captureId)).sort((a,b)=>a.checkId.localeCompare(b.checkId));
      const remaining=full.filter(value=>value.checkId>afterCheckId),selected=remaining.slice(0,historyLimit),complete=remaining.length<=historyLimit;
      return {checks:selected,nextCheckId:complete?null:selected.at(-1).checkId,completeWithinRequestedScope:complete,
        totalCheckRows:full.length,loadedBytes:1};
    },clock};
  return {deps,get historyReads(){return historyReads;}};
}
const metadata=await readSoccerModelFamilyCalibrationScope({league:'epl',period:'FT',now:f.now},stores().deps);
sealed(metadata);assert.equal(metadata.totalCaptures,3);assert.equal(metadata.sourceRevision,revision);
assert.equal(metadata.sourceModelFreezeVerified,true);assert.equal(metadata.familyProtocolRegistrationVerified,false);
assert.equal(metadata.protocol.declaredAt,new Date(f.now).toISOString());
assert.equal(metadata.protocol.registeredAt,f.artifacts.plan.createdAt);
assert.equal(metadata.registrationInterpretation,'SOURCE_CALIBRATION_PLAN_NOT_FAMILY_PREREGISTRATION');
assert.equal(metadata.protocol.calibrationFrom,f.freezeReceipt.frozenAt);
assert.equal(metadata.protocol.calibrationBefore,new Date(f.now).toISOString());
const scope={league:'epl',period:'FT',now:f.now,protocol:metadata.protocol};
let page=await loadSoccerModelFamilyCalibrationDataset(scope,stores().deps);
sealed(page);assert.equal(page.observations.length,1);assert.equal(page.confidenceSet,null);
assert.deepEqual(page.coverage,{readCaptures:1,nextSequence:'1',complete:false,totalCaptures:3});
page=await loadSoccerModelFamilyCalibrationDataset({...scope,afterSequence:'2',expectedRevision:revision},stores().deps);
assert.equal(page.coverage.complete,true);assert.equal(page.confidenceSet,null,
  'last batch is not a complete dataset and must not fit on its one-game prefix');
page=await loadSoccerModelFamilyCalibrationDataset({...scope,captureLimit:3},stores().deps);
assert.equal(page.coverage.complete,true);assert.equal(page.confidenceSet.independentRealGames,3);sealed(page);
const manyChecks=[checks[0],check(f.records[0],20),check(f.records[0],30)];
const multi=stores({records:f.records.slice(0,1),history:manyChecks,historyLimit:1});
page=await loadSoccerModelFamilyCalibrationDataset(scope,multi.deps);
assert.equal(multi.historyReads,3);assert.equal(page.confidenceSet.independentRealGames,1,
  'all immutable history pages must be read, not only the first saved successful proof');
const lateCorrection=stores({records:f.records.slice(0,1),history:[...manyChecks,correction],historyLimit:1});
page=await loadSoccerModelFamilyCalibrationDataset(scope,lateCorrection.deps);
assert.equal(page.observations.length,0);assert.equal(page.quarantinedGames,1);
await assert.rejects(()=>loadSoccerModelFamilyCalibrationDataset({...scope,expectedRevision:'f'.repeat(64)},stores().deps),error=>error.status===409);
await assert.rejects(()=>loadSoccerModelFamilyCalibrationDataset(scope,stores({mutateRevision:true}).deps),error=>error.status===409);
await assert.rejects(()=>loadSoccerModelFamilyCalibrationDataset({...scope,afterSequence:'1'},stores().deps),/SCOPE_INVALID/);
await assert.rejects(()=>readSoccerModelFamilyCalibrationScope({...scope},stores({mutateRevision:true}).deps),error=>error.status===409);
const malformed=stores({records:f.records.slice(0,1)}).deps;
malformed.readHistoryPage=async()=>({checks:[checks[0]],nextCheckId:'x',completeWithinRequestedScope:false,totalCheckRows:2});
await assert.rejects(()=>loadSoccerModelFamilyCalibrationDataset(scope,malformed),/RESULT_CURSOR_INVALID/);
let ticks=0;
page=await loadSoccerModelFamilyCalibrationDataset({...scope,timeBudgetMs:10},stores({clock:()=>ticks++?100:0}).deps);
assert.equal(page.coverage.readCaptures,0);assert.equal(page.coverage.nextSequence,'0');
assert.equal(page.coverage.complete,false);assert.equal(page.observations.length,0);assert.equal(page.confidenceSet,null);
let phase=0;const replayTimeout=stores({records:f.records.slice(0,1),clock:()=>phase<2?phase++:100}).deps;
page=await loadSoccerModelFamilyCalibrationDataset({...scope,timeBudgetMs:10},replayTimeout);
assert.equal(page.captureReplayComplete,false);assert.equal(page.page.complete,false);
assert.equal(page.coverage.readCaptures,0);assert.equal(page.coverage.nextSequence,'0');
assert.equal(page.observations.length,0);assert.equal(page.confidenceSet,null);

console.log('Soccer model-family DB data adapter: exact FT/HT baseline, immutable source receipts, full correction replay, bounded revision-pinned pages, no prefix fit and no formal promotion PASS; family preregistration/coverage/misspecification NOT VERIFIED');
