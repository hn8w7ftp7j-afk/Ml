import assert from 'node:assert/strict';
import fs from 'node:fs';
import {openingTraining} from '../lib/nba/opening-training.js';
import {openingResearchHistory} from '../lib/nba/opening-research-history.js';
import {buildTotalsV4Observations,totalsV4Probability} from '../lib/nba/opening-research-v4.js';
import {buildOpeningResearchBaselineObservations,openingResearchReadiness} from '../lib/nba/opening-research.js';
import {openingVariableAccepted} from '../lib/nba/opening-core.js';
import {TOTALS_V6_PROTOCOL,TOTALS_V6_PROTOCOL_HASH,totalsV6Hash,totalsV6Candidate,buildTotalsV6Observations,
  totalsV6AsOfRow,totalsV6Distribution,totalsV6Cdf,totalsV6Probability,developTotalsV6,createTotalsV6Selection} from '../lib/nba/opening-research-v6.js';

const history=openingResearchHistory.history.filter(r=>r.year<=2021);
const close=(a,b)=>assert.ok(Math.abs(a-b)<=64*Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
assert.equal(TOTALS_V6_PROTOCOL_HASH,'01bd869099a83f1113e499732ebc6bac10be5f716961ca7ef02aa793f09ce795');
assert.deepEqual(TOTALS_V6_PROTOCOL.independentTrainingYears,[2007,2008,2009,2010]);
assert.equal(TOTALS_V6_PROTOCOL.independentHoldoutYear,2011);
assert.ok(Object.isFrozen(TOTALS_V6_PROTOCOL.gates));
for(const target of ['fullTotal','halfTotal']){
  const obs=buildTotalsV6Observations(history,target),points=buildTotalsV4Observations(history,target);
  assert.deepEqual(obs.map(r=>[r.gameId,r.rawPrediction,r.rawError,r.correction]),points.map(r=>[r.gameId,r.rawPrediction,r.rawError,r.correction]),'V4 mature raw forecast/correction remain locked');
  for(const r of obs){const v4=points.find(p=>p.gameId===r.gameId);assert.equal(r.prediction,r.phase==='early'?r.baseline:v4.prediction);assert.equal(r.pointError,r.actual-r.prediction);assert.equal(r.inheritedV4PointPrediction,v4.prediction);assert.equal(r.inheritedV4PointError,v4.error);}
  const rows=obs.filter(r=>r.year===2021),base=buildOpeningResearchBaselineObservations(history,target),first=rows[0];
  for(const r of [first,rows[100],rows.at(-1)]){
    const prior=rows.filter(p=>p.date<r.date),mu=prior.reduce((s,p)=>s+p.pointError,0)/(120+prior.length);
    assert.equal(r.locationCorrection,mu);assert.equal(r.locationSamples,prior.length);
    assert.equal(r.distributionCenter,r.pointPrediction+mu);
    assert.ok(r.locationThrough===null||r.locationThrough<r.date);
    const dist=totalsV6Distribution(r,obs,target);
    assert.ok(dist&&dist.through<r.date);assert.equal(dist.center,r.distributionCenter);
    assert.equal(dist.pointPrediction,r.pointPrediction);assert.equal(dist.locationSamples,r.locationSamples);
    const shape=obs.filter(p=>p.year<r.year&&p.year>=r.year-3&&p.date<r.date&&p.phase===r.phase);
    assert.equal(dist.samples,shape.length);assert.equal(dist.residuals.length,shape.length);
    assert.ok(dist.residuals.every(p=>p.year<r.year&&p.date<r.date));
    const w=p=>2**(-(Date.parse(r.date)-Date.parse(p.date))/86400000/365),sw=shape.reduce((s,p)=>s+w(p),0);
    const weightedMean=shape.reduce((s,p)=>s+w(p)*p.pointError,0)/sw;assert.equal(dist.shapeCenter,weightedMean);
    assert.deepEqual(dist.residuals,shape.map(p=>({gameId:p.gameId,year:p.year,date:p.date,error:p.pointError-weightedMean})));
    const values=Array.from({length:121},(_,i)=>i*4),cdfs=values.map(x=>totalsV6Cdf(dist,x));
    assert.ok(cdfs.every((x,i)=>x>=0&&x<=1&&(!i||x>=cdfs[i-1])),'one coherent monotone distribution across arbitrary quoted lines');
    assert.equal(totalsV6Cdf(dist,-10000),0);assert.equal(totalsV6Cdf(dist,10000),1);
    const p=totalsV6Probability(r,obs,target,base),v4=totalsV4Probability(points.find(p=>p.gameId===r.gameId),points,target,base);
    assert.equal(p.baselineP,v4.baselineP,'canonical baseline probability stays exactly unchanged');
    assert.equal(p.p,1-totalsV6Cdf(dist,p.threshold));
    for(const threshold of [90,100.5,111.25,200,235.5])assert.equal(totalsV6Probability(r,obs,target,base,{threshold}).p,1-totalsV6Cdf(dist,threshold));
    const {actual,error,pointError,distributionError,...scoreFree}=r;
    const forecast=totalsV6AsOfRow(scoreFree,obs,target);
    assert.equal(forecast.pointPrediction,r.pointPrediction);assert.equal(forecast.distributionCenter,r.distributionCenter);
    assert.deepEqual(totalsV6Distribution(forecast,obs,target),dist,'runtime distribution never requires target outcome');
  }
  assert.equal(first.locationCorrection,0);assert.equal(first.locationSamples,0);
  assert.equal(totalsV6Distribution(first,obs.map(r=>({...r,candidateId:'foreign'})),target),null);
  assert.equal(totalsV6Distribution(first,obs.map(r=>({...r,modelVersion:'foreign'})),target),null);
  assert.throws(()=>totalsV6Distribution({...first,fitThrough:first.date},obs,target),/SCOPE/);
  assert.throws(()=>totalsV6Distribution(first,obs,target==='fullTotal'?'halfTotal':'fullTotal'),/SCOPE/);
  const mutated=history.map(r=>r.gameId===first.gameId?{...r,homeScore:r.homeScore+30,homeHalf:r.homeHalf+10}:r);
  const alternate=buildTotalsV6Observations(mutated,target),altBase=buildOpeningResearchBaselineObservations(mutated,target);
  assert.deepEqual(alternate.filter(r=>r.date<=first.date).map(r=>[r.gameId,r.prediction,r.distributionCenter]),obs.filter(r=>r.date<=first.date).map(r=>[r.gameId,r.prediction,r.distributionCenter]));
  const own=alternate.find(r=>r.gameId===first.gameId),ownP=totalsV6Probability(own,alternate,target,altBase),p=totalsV6Probability(first,obs,target,base);
  assert.deepEqual({...ownP,y:null},{...p,y:null},'own label may change outcome, never its forecast or calibration');
  const next=rows.find(r=>r.date>first.date),nextAlt=alternate.find(r=>r.gameId===next.gameId);
  close(nextAlt.locationCorrection-next.locationCorrection,(target==='fullTotal'?30:10)/(120+next.locationSamples));
  assert.notEqual(nextAlt.distributionCenter,next.distributionCenter,'earlier observed labels update later distribution');
  const cutoff=rows[120].date;
  assert.deepEqual(buildTotalsV6Observations(history.filter(r=>r.date<=cutoff),target),obs.filter(r=>r.date<=cutoff),'future labels cannot flow backward');
}
assert.throws(()=>totalsV6Candidate('fullMargin'),/TARGET_INVALID/);
assert.throws(()=>developTotalsV6([{year:2011}]),/DEVELOPMENT_YEAR_SCOPE/);
assert.throws(()=>developTotalsV6(openingResearchHistory.history),/SOURCE_UNVERIFIED/);
const report=JSON.parse(fs.readFileSync('docs/nba-opening-v6-development.json','utf8'));
const selection=JSON.parse(fs.readFileSync('docs/nba-opening-v6-selection.json','utf8'));
assert.equal(report.status,'DEVELOPMENT_PASSED_PENDING_FROZEN_EXTERNAL_HOLDOUT');
assert.equal(report.independentValidation.metrics,null);assert.equal(report.independentValidation.year,2011);
assert.equal(report.executable,false);assert.equal(report.promotionEligible,false);
assert.deepEqual(createTotalsV6Selection(report),selection);
assert.match(totalsV6Hash(selection),/^[a-f0-9]{64}$/);
for(const target of ['fullTotal','halfTotal'])for(const year of [2021,2022,2023,2024,2025,2026]){
  const metrics=report.targets[target].years[year].metrics;
  assert.equal(openingVariableAccepted(metrics),true);assert.equal(openingResearchReadiness(metrics).readyForIndependentValidation,true);
  const failed={...metrics,modelBrier:metrics.baselineBrier+Number.EPSILON};
  assert.equal(openingVariableAccepted(failed),false,'acceptance uses raw comparisons without replay tolerance');
}
const allHistory=[...openingResearchHistory.history,...openingTraining.history].sort((a,b)=>a.date.localeCompare(b.date)||a.gameId.localeCompare(b.gameId));
const replay=developTotalsV6(allHistory,{archiveEvidence:openingResearchHistory,regressionEvidence:openingTraining});
assert.equal(replay.historyHash,report.historyHash);assert.equal(replay.status,report.status);
for(const target of ['fullTotal','halfTotal'])for(const year of [2021,2022,2023,2024,2025,2026]){
  const a=report.targets[target].years[year],b=replay.targets[target].years[year];
  assert.deepEqual(a.reasons,b.reasons);assert.equal(a.passed,b.passed);
  for(const k of Object.keys(a.metrics))if(k==='samples'||k.endsWith('Samples'))assert.equal(a.metrics[k],b.metrics[k]);else close(a.metrics[k],b.metrics[k]);
}
const changed=structuredClone(report);changed.targets.halfTotal.years[2022].metrics.earlyModelMAE=100;
assert.throws(()=>createTotalsV6Selection(changed),/NOT_ACCEPTED/);
console.log('PASS V6 early baseline/mature V4 hybrid point, current-season location, phase/version isolation, score-free shared CDF, exact baseline and gates, own/same-date/future counterexamples, frozen development replay; no 2011 metrics');

