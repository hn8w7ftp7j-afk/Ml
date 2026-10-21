import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openingResearchHistory } from '../lib/nba/opening-research-history.js';
import { openingBaseline, openingVariableAccepted } from '../lib/nba/opening-core.js';
import { buildOpeningResearchBaselineObservations, openingResearchReadiness } from '../lib/nba/opening-research.js';
import { TOTALS_V3_PROTOCOL, TOTALS_V3_PROTOCOL_HASH, TOTALS_V3_EXPECTED_PROTOCOL_HASH,
  totalsV3Candidate, buildTotalsV3Observations, totalsV3Probability, totalsV3Metrics, totalsV3Hash,
  createTotalsV3Selection, TOTALS_V3_FROZEN_SELECTION_HASH, TOTALS_V3_RECORDED_HOLDOUT_HASH, evaluateTotalsV3Holdout, assertTotalsV3Replay } from '../lib/nba/opening-research-v3.js';

const history=openingResearchHistory.history.filter(r=>r.year<=2021);
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
assert.equal(TOTALS_V3_PROTOCOL_HASH,TOTALS_V3_EXPECTED_PROTOCOL_HASH);
assert.ok(Object.isFrozen(TOTALS_V3_PROTOCOL.priorWeights));
assert.deepEqual(TOTALS_V3_PROTOCOL.priorWeights,[10,20,40]);
assert.deepEqual(TOTALS_V3_PROTOCOL.kernels,['league_centered','phase_bias_centered','phase_ridge_centered']);
for(const target of ['fullTotal','halfTotal']) {
  const candidate=totalsV3Candidate(target,10,'phase_bias_centered');
  const rows=buildTotalsV3Observations(history,candidate),development=rows.filter(r=>r.year===2021);
  assert.equal(development.length,1080);
  assert.equal(development.filter(r=>r.phase==='early').length,144);
  assert.ok(rows.every(r=>r.featureThrough<r.date&&r.fitThrough<r.date&&(!r.biasThrough||r.biasThrough<r.date)));
  assert.ok(development.every(r=>r.fitThrough<'2020-12-22'&&r.biasThrough<'2020-12-22'));
  assert.ok(development.every(r=>Number.isFinite(r.prediction)&&r.fitSamples>=30));
  assert.ok(development.some(r=>r.bias!==0),'learn a prior-data bias correction, not a display-only edit');
  for(const r of [development[0],development[200],development.at(-1)]) {
    const source=history.find(v=>v.gameId===r.gameId);
    const baseline=openingBaseline({season:{year:r.year},taipeiDate:r.date,home:{id:source.homeId},away:{id:source.awayId}},history,20);
    close(r.baseline,baseline[target]);
    close(r.prediction,r.rawPrediction+r.bias);close(r.error,r.actual-r.prediction);close(r.rawError,r.actual-r.rawPrediction);
  }
  const base=buildOpeningResearchBaselineObservations(history,target),first=development[0];
  const probability=totalsV3Probability(first,rows,candidate,base);
  assert.ok(probability&&probability.through<first.date&&probability.baselineThrough<first.date);
  assert.equal(probability.basis,'candidate_matched_phase_centered_innovations');
  const prior=rows.filter(r=>r.year<first.year&&r.year>=first.year-3&&r.date<first.date&&r.phase===first.phase);
  const w=r=>2**(-(Date.parse(first.date)-Date.parse(r.date))/86400000/365);
  close(probability.residualCenter,prior.reduce((s,r)=>s+w(r)*r.error,0)/prior.reduce((s,r)=>s+w(r),0));
  const rawCandidate=totalsV3Candidate(target,10,'league_centered'),rawRows=buildTotalsV3Observations(history,rawCandidate);
  const raw=totalsV3Probability(rawRows.find(r=>r.gameId===first.gameId),rawRows,rawCandidate,base);
  assert.equal(probability.baselineP,raw.baselineP,'every candidate must use identical benchmark probabilities');
  assert.equal(probability.baselineSamples,raw.baselineSamples);
  assert.equal(totalsV3Probability(first,rows.map(r=>({...r,candidateId:'foreign'})),candidate,base),null);
  assert.equal(totalsV3Probability(first,rows,candidate,base.map(r=>({...r,baselineVersion:'foreign'}))),null);
  assert.throws(()=>totalsV3Probability({...first,fitThrough:first.date},rows,candidate,base),/SCOPE/);
  assert.throws(()=>totalsV3Probability(first,rows,{...candidate,kernel:'league_centered'},base),/MISMATCH/);
  assert.throws(()=>buildTotalsV3Observations(history,{...candidate,priorWeight:5}),/INVALID/);
  assert.throws(()=>buildTotalsV3Observations(history.map((r,i)=>i? r:{...r,league:'NHL'}),candidate),/HISTORY/);

  // Explicit label-mutation counterexamples, not source-authenticated alternate data.
  // A target score cannot affect its own forecast or probability; later dates
  // cannot alter any earlier point forecast. No real 2022 forecasts are made.
  const source=history.find(r=>r.gameId===first.gameId);
  const changed=history.map(r=>r.gameId===first.gameId?{...r,homeScore:r.homeScore+30,homeHalf:r.homeHalf+10}:r);
  const alternate=buildTotalsV3Observations(changed,candidate),altered=alternate.find(r=>r.gameId===first.gameId);
  assert.equal(altered.prediction,first.prediction);assert.deepEqual(altered.fit,first.fit);assert.equal(altered.bias,first.bias);
  const alternateBase=buildOpeningResearchBaselineObservations(changed,target);
  const altProbability=totalsV3Probability(altered,alternate,candidate,alternateBase);
  assert.equal(altProbability.p,probability.p);assert.equal(altProbability.baselineP,probability.baselineP);
  const earlier=rows.filter(r=>r.date<=first.date);
  assert.deepEqual(alternate.filter(r=>r.date<=first.date).map(r=>[r.gameId,r.prediction]),earlier.map(r=>[r.gameId,r.prediction]));
  // New current-season labels can update team/league inputs, never closed-season fits/bias.
  assert.deepEqual(alternate.filter(r=>r.year===2021).map(r=>r.fit),development.map(r=>r.fit));
  assert.deepEqual(alternate.filter(r=>r.year===2021).map(r=>r.bias),development.map(r=>r.bias));
  const future={...history.at(-1),gameId:'nba:espn:game:899999991',date:'2022-04-01',year:2022,homeScore:180,awayScore:170,homeHalf:90,awayHalf:80};
  const appended=buildTotalsV3Observations([...history,future],candidate);
  assert.deepEqual(appended.filter(r=>r.year<=2021),rows,'synthetic future season cannot affect prior observations');
  const probabilities=development.flatMap(r=>totalsV3Probability(r,rows,candidate,base)||[]);
  const metrics=totalsV3Metrics(development,probabilities);
  assert.equal(metrics.probabilitySamples,1080);assert.equal(openingVariableAccepted(metrics),true);
  assert.equal(openingResearchReadiness(metrics).readyForIndependentValidation,true);
  assert.equal(totalsV3Metrics([],[]).modelMAE,null);
  const missing=openingResearchReadiness({...metrics,modelBrier:null});assert.ok(missing.reasons.includes('modelBrier_unavailable'));
}

const report=JSON.parse(fs.readFileSync('docs/nba-opening-v3-development.json','utf8'));
assert.equal(report.protocolHash,TOTALS_V3_PROTOCOL_HASH);
assert.equal(report.developmentHistoryHash,totalsV3Hash(history));
assert.equal(report.holdout.metrics,null);assert.equal(report.promotionEligible,false);assert.equal(report.executable,false);
const selection=JSON.parse(fs.readFileSync('docs/nba-opening-v3-selection.json','utf8'));
assert.equal(totalsV3Hash(selection),TOTALS_V3_FROZEN_SELECTION_HASH);
assert.deepEqual(createTotalsV3Selection(report),selection);
assert.throws(()=>evaluateTotalsV3Holdout(openingResearchHistory.history,{...selection,holdoutYear:2023},{archiveEvidence:openingResearchHistory}),/FROZEN_SELECTION/);
assert.throws(()=>evaluateTotalsV3Holdout(openingResearchHistory.history,selection,{archiveEvidence:{}}),/SOURCE_UNVERIFIED/);
const alteredReport=structuredClone(report);alteredReport.targets.fullTotal.selected=alteredReport.targets.fullTotal.candidates[0].candidate;
assert.throws(()=>createTotalsV3Selection(alteredReport),/SELECTION_MISMATCH/);
for(const target of ['fullTotal','halfTotal']) {
  assert.equal(report.targets[target].candidates.length,9);
  assert.equal(report.targets[target].selected.kernel,'phase_bias_centered');
  assert.equal(report.targets[target].selected.priorWeight,10);
}
for(const file of ['lib/nba/opening-model.js','lib/nba/analysis-service.js','lib/nba/opening-training.js']) {
  assert.doesNotMatch(fs.readFileSync(file,'utf8'),/opening-research-v3/,'unapproved research cannot enter production');
}
const recordedHoldout=JSON.parse(fs.readFileSync('docs/nba-opening-v3-holdout.json','utf8'));
assert.equal(totalsV3Hash(recordedHoldout),TOTALS_V3_RECORDED_HOLDOUT_HASH);
assert.equal(recordedHoldout.status,'BLOCKED_HOLDOUT_FAILED');assert.equal(recordedHoldout.holdoutConsumed,true);assert.equal(recordedHoldout.reselectionAllowed,false);
assert.equal(recordedHoldout.promotionEligible,false);assert.equal(recordedHoldout.executable,false);
for(const target of ['fullTotal','halfTotal']) {
  const value=recordedHoldout.targets[target];
  assert.deepEqual(value.candidate,selection.selected[target].candidate);
  assert.equal(value.passed,false);assert.deepEqual(value.reasons,['earlyModelMAE_worse_than_baseline']);
  assert.equal(openingVariableAccepted(value.metrics),false);
  assert.ok(value.metrics.modelMAE<value.metrics.baselineMAE&&value.metrics.modelBrier<value.metrics.baselineBrier&&value.metrics.modelLogLoss<value.metrics.baselineLogLoss);
}
// Reproduce only the already-consumed, frozen selection. Never score alternate
// holdout candidates or adapt the implementation to improve these metrics.
assert.throws(()=>evaluateTotalsV3Holdout(openingResearchHistory.history,selection,{archiveEvidence:openingResearchHistory,developmentEvidence:report}),/HOLDOUT_EVIDENCE/);
const tiny=structuredClone(recordedHoldout);tiny.targets.fullTotal.metrics.modelLogLoss+=Number.EPSILON;
assert.equal(assertTotalsV3Replay(tiny,recordedHoldout).gateTolerance,0);
for(const mutate of [
  r=>{r.targets.fullTotal.metrics.earlyModelMAE-=.01;},
  r=>{r.targets.fullTotal.metrics.samples--;},
  r=>{r.targets.fullTotal.passed=true;},
  r=>{r.targets.fullTotal.reasons=[];},
  r=>{r.selectionHash='other';},
]) {const changed=structuredClone(recordedHoldout);mutate(changed);assert.throws(()=>assertTotalsV3Replay(changed,recordedHoldout),/REPLAY_MISMATCH/);}
assert.deepEqual(evaluateTotalsV3Holdout(openingResearchHistory.history,selection,{archiveEvidence:openingResearchHistory,developmentEvidence:report,holdoutEvidence:recordedHoldout}),recordedHoldout);
console.log('PASS v3 bounded per-target research: prior-only math/leakage/scope tests, exact frozen development and consumed-holdout replay, unchanged gates, failed early checks preserved and no production activation');
