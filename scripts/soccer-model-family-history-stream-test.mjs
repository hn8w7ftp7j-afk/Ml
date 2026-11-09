import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { soccerCalibrationShadowFixture } from './helpers/soccer-calibration-shadow-fixture.mjs';
import { soccerModelFamilyHash } from '../lib/soccer/model-family-uncertainty.js';
import { loadSoccerModelFamilyCalibrationDataset } from '../lib/soccer/model-family-data.js';

// Synthetic original provider documents exercise the real adapter's streaming
// replay boundary. Only one original page is generated at a time; these rows
// are never written to the Production journal or accepted for formal scoring.
const fixture=soccerCalibrationShadowFixture(1),record=fixture.records[0],MiB=1024*1024;
const totalChecks=70,sourceRevision='b'.repeat(64),checkId=index=>index.toString(16).padStart(64,'0');
const protocol={registeredAt:fixture.artifacts.plan.createdAt,calibrationFrom:fixture.freezeReceipt.frozenAt,
  calibrationBefore:new Date(fixture.now).toISOString(),alpha:.1};
const scope={league:'epl',period:'FT',now:fixture.now,protocol,captureLimit:1,timeBudgetMs:50000};
const bodyHash=document=>{document.source.contentHash=createHash('sha256').update(JSON.stringify(document.data)).digest('hex');};
const sealed=value=>{const {contentHash,...body}=value;assert.equal(contentHash,soccerModelFamilyHash(body));};

function originalHistory({correctLast=false,stopAfterPages=null,changeRevision=false}={}) {
  let pages=0,loadedBytes=0,maxPageBytes=0,revisionReads=0;
  const dependencies={
    baseReport:async()=>({freeze:fixture.freezeReceipt,captureGames:1}),
    listCaptureIds:async(_league,{afterSequence,limit})=>{
      assert.equal(afterSequence,'0');assert.equal(limit,1);
      return {captureIds:[record.captureReceipt.captureId],nextSequence:null,completeWithinRequestedScope:true};
    },
    loadEvidence:async(_league,{captureIds,limit})=>fixture.context(captureIds,limit),
    readRevision:async()=>({captures:1,revision:changeRevision&&++revisionReads>1?'c'.repeat(64):sourceRevision}),
    clock:()=>stopAfterPages!==null&&pages>=stopAfterPages?60000:0,
    readHistoryPage:async(_league,{captureIds,afterCheckId})=>{
      assert.deepEqual(captureIds,[record.captureReceipt.captureId]);
      assert.equal(afterCheckId,pages===0?'':checkId(pages));
      assert.ok(pages<totalChecks,'a complete immutable history is not scanned twice');
      const index=++pages,documents=fixture.resultDocuments(record,correctLast&&index===totalChecks?{homeScore:3}:{});
      documents.scoreboard.data.syntheticRevision=index;
      documents.scoreboard.data.syntheticProviderPadding='x'.repeat(MiB);
      bodyHash(documents.scoreboard);
      const check={checkId:checkId(index),captureId:record.captureReceipt.captureId,league:'epl',
        checkedAt:new Date(fixture.now).toISOString(),resultDocuments:documents};
      const bytes=Buffer.byteLength(JSON.stringify(check));loadedBytes+=bytes;maxPageBytes=Math.max(maxPageBytes,bytes);
      const complete=index===totalChecks;
      return {checks:[check],nextCheckId:complete?null:check.checkId,completeWithinRequestedScope:complete,
        totalCheckRows:totalChecks,loadedBytes:bytes};
    },
  };
  return {dependencies,stats:()=>({pages,loadedBytes,maxPageBytes})};
}

const completeHistory=originalHistory();
const complete=await loadSoccerModelFamilyCalibrationDataset(scope,completeHistory.dependencies);
const completeStats=completeHistory.stats();
assert.equal(completeStats.pages,totalChecks);
assert.ok(completeStats.loadedBytes>64*MiB,'the original hashed provider documents exceed the old accumulated 64MiB ceiling');
assert.ok(completeStats.maxPageBytes<3*MiB,'the source boundary keeps every resident original page bounded');
assert.deepEqual(complete.coverage,{readCaptures:1,nextSequence:null,complete:true,totalCaptures:1});
assert.equal(complete.observations.length,1);assert.equal(complete.confidenceSet.independentRealGames,1);
assert.equal(complete.page.readResultCheckRows,totalChecks);assert.equal(complete.quarantinedGames,0);
assert.equal(complete.page.readResultBytes,completeStats.loadedBytes);
assert.equal(complete.page.maxResidentResultPageBytes,completeStats.maxPageBytes);
assert.equal(complete.page.retainedResultProofs,1);
assert.ok(complete.page.retainedResultProofBytes>0&&complete.page.retainedResultProofBytes<32*1024,
  'a retained proof consists of compact scores, source hashes and original receipt identity, not full provider documents');
assert.equal(complete.formalEligible,false);assert.equal(complete.confidenceSet.coverageAssumptionsVerified,false);
assert.equal(complete.W,null);assert.equal(complete.R,null);assert.equal(complete.S,null);sealed(complete);

const correctedHistory=originalHistory({correctLast:true});
const corrected=await loadSoccerModelFamilyCalibrationDataset({...scope,period:'HT'},correctedHistory.dependencies);
assert.equal(correctedHistory.stats().pages,totalChecks);
assert.ok(correctedHistory.stats().loadedBytes>64*MiB);
assert.equal(corrected.coverage.complete,true);assert.equal(corrected.quarantinedGames,1);
assert.equal(corrected.observations.length,0);assert.equal(corrected.confidenceSet.independentRealGames,0,
  'a correction in the final original page removes the entire earlier game from both periods');
assert.equal(corrected.outcomeCohortComplete,false);
assert.ok(corrected.excludedReasons.CALIBRATION_RESULT_FT_CORRECTION>0);sealed(corrected);
assert.ok(corrected.page.retainedResultProofs<=1);assert.ok(corrected.page.retainedResultProofBytes<32*1024);
assert.equal(corrected.page.readResultBytes,correctedHistory.stats().loadedBytes);

const partialHistory=originalHistory({correctLast:true,stopAfterPages:totalChecks-1});
const partial=await loadSoccerModelFamilyCalibrationDataset(scope,partialHistory.dependencies);
assert.equal(partialHistory.stats().pages,totalChecks-1);
assert.ok(partialHistory.stats().loadedBytes>64*MiB);
assert.deepEqual(partial.coverage,{readCaptures:0,nextSequence:'0',complete:false,totalCaptures:1});
assert.equal(partial.observations.length,0);assert.equal(partial.confidenceSet,null);
assert.equal(partial.completeWithinRequestedScope,false);assert.equal(partial.page.complete,false);sealed(partial);
assert.ok(partial.page.retainedResultProofs<=1);assert.ok(partial.page.retainedResultProofBytes<32*1024);

const movedHistory=originalHistory({changeRevision:true});
await assert.rejects(()=>loadSoccerModelFamilyCalibrationDataset(scope,movedHistory.dependencies),error=>error.status===409,
  'a fully scanned original history still cannot escape its immutable source revision');
assert.equal(movedHistory.stats().pages,totalChecks);

console.log('PASS model-family original-history streaming: >64MiB source documents across bounded resident pages, one independent game, final-page whole-game correction quarantine, deadline zero-prefix and revision-pinned replay; no formal promotion');
