import assert from 'node:assert/strict';
import fs from 'node:fs';
import {openingResearchHistory} from '../lib/nba/opening-research-history.js';
import {buildOpeningResearchBaselineObservations,openingResearchReadiness} from '../lib/nba/opening-research.js';
import {openingVariableAccepted} from '../lib/nba/opening-core.js';
import {TOTALS_V4_PROTOCOL_HASH,totalsV4Candidate,buildTotalsV4Observations,totalsV4Probability,evaluateTotalsV4} from '../lib/nba/opening-research-v4.js';

assert.equal(TOTALS_V4_PROTOCOL_HASH,'0e95ea0df2b35bb02917e2e905e267418dd6a58ae40dc361e35cd38f455737fe');
const history=openingResearchHistory.history.filter(r=>r.year<=2021);
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
for(const target of ['fullTotal','halfTotal']) {
  const all=buildTotalsV4Observations(history,target),rows=all.filter(r=>r.year===2021),first=rows[0],later=rows.find(r=>r.correctionSamples>100);
  assert.equal(rows.length,1080);assert.ok(later);
  assert.equal(first.correctionSamples,0);assert.equal(first.correction,0);assert.equal(first.correctionThrough,null);
  assert.equal(first.fit.intercept,0);assert.notEqual(first.discardedHistoricalIntercept,0);
  for(const r of rows) {
    const prior=rows.filter(p=>p.date<r.date);
    assert.equal(r.correctionSamples,prior.length);
    close(r.correction,prior.reduce((s,p)=>s+p.rawError,0)/(120+prior.length));
    close(r.prediction,r.feature.leagueEstimate+r.fit.slope*(r.feature.baseline-r.feature.leagueEstimate)+r.correction);
    assert.ok(r.featureThrough<r.date&&r.fitThrough<r.date&&(!r.correctionThrough||r.correctionThrough<r.date));
  }
  const base=buildOpeningResearchBaselineObservations(history,target),p=totalsV4Probability(first,all,target,base);
  assert.ok(p&&p.through<first.date&&p.baselineThrough<first.date);
  assert.equal(totalsV4Probability(first,all.map(r=>({...r,candidateId:'foreign'})),target,base),null);
  assert.throws(()=>totalsV4Probability({...first,correctionThrough:first.date},all,target,base),/SCOPE_INVALID/);
  assert.throws(()=>totalsV4Probability(first,all,target==='fullTotal'?'halfTotal':'fullTotal',base),/SCOPE_INVALID/);

  // Counterexamples: a changed label affects later updates, never any target
  // forecast or calibration on its own date. Future results cannot flow back.
  const changed=history.map(r=>r.gameId===first.gameId?{...r,homeScore:r.homeScore+30,homeHalf:r.homeHalf+10}:r);
  const alt=buildTotalsV4Observations(changed,target),altBase=buildOpeningResearchBaselineObservations(changed,target);
  const own=alt.find(r=>r.gameId===first.gameId);
  assert.equal(own.prediction,first.prediction);
  const altP=totalsV4Probability(own,alt,target,altBase);
  assert.deepEqual({...altP,y:null},{...p,y:null},'observed outcome may change; forecast distribution cannot');
  assert.deepEqual(alt.filter(r=>r.date<=first.date).map(r=>[r.gameId,r.prediction]),all.filter(r=>r.date<=first.date).map(r=>[r.gameId,r.prediction]));
  const next=rows.find(r=>r.date>first.date),altNext=alt.find(r=>r.gameId===next.gameId);
  close(altNext.correction-next.correction,(target==='fullTotal'?30:10)/(120+next.correctionSamples));
  assert.notEqual(altNext.prediction,next.prediction,'new season evidence changes actual model output');
  const cutoff=later.date,truncated=buildTotalsV4Observations(history.filter(r=>r.date<=cutoff),target);
  assert.deepEqual(truncated,all.filter(r=>r.date<=cutoff));
  assert.deepEqual(buildTotalsV4Observations([...history].reverse(),target),all);
  assert.equal(totalsV4Candidate(target).candidateId,first.candidateId);
}
assert.throws(()=>totalsV4Candidate('fullMargin'),/TARGET_INVALID/);
assert.throws(()=>evaluateTotalsV4(openingResearchHistory.history),/SOURCE_UNVERIFIED/);
const reportPath='docs/nba-opening-v4-development.json';
if(fs.existsSync(reportPath)) {
  const report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
  const replay=evaluateTotalsV4(openingResearchHistory.history,{archiveEvidence:openingResearchHistory});
  assert.equal(report.protocolHash,TOTALS_V4_PROTOCOL_HASH);
  assert.equal(report.historyHash,replay.historyHash);
  assert.equal(report.status,'BLOCKED_DEVELOPMENT_AND_INDEPENDENT_VALIDATION');
  assert.equal(report.status,replay.status);
  assert.equal(report.executable,false);assert.equal(report.promotionEligible,false);
  assert.deepEqual(report.independentValidation,{status:'NOT_STARTED',samples:0});
  for(const target of ['fullTotal','halfTotal'])for(const year of [2021,2022]) {
    const a=report.targets[target].years[year],b=replay.targets[target].years[year];
    assert.equal(a.role,'VIEWED_DEVELOPMENT_NOT_INDEPENDENT');
    assert.equal(a.historicalGatesPassed,openingVariableAccepted(a.metrics));
    assert.deepEqual(a.reasons,openingResearchReadiness(a.metrics).reasons);
    assert.deepEqual(a.reasons,b.reasons);assert.equal(a.historicalGatesPassed,b.historicalGatesPassed);
    for(const key of Object.keys(a.metrics)) {
      if(key.endsWith('Samples')||key==='samples')assert.equal(a.metrics[key],b.metrics[key]);
      else if(a.metrics[key]===null)assert.equal(b.metrics[key],null);
      else close(a.metrics[key],b.metrics[key]);
    }
  }
}
for(const path of ['lib/nba/opening-model.js','lib/nba/analysis-service.js','lib/nba/opening-training.js'])assert.doesNotMatch(fs.readFileSync(path,'utf8'),/opening-research-v4/);
console.log('PASS v4 season-reset/online correction, same-date/own-label/future leakage counterexamples, source scope, unchanged gates, blocked production');
