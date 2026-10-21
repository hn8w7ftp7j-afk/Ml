import assert from 'node:assert/strict';
import fs from 'node:fs';
import {openingResearchHistory} from '../lib/nba/opening-research-history.js';
import {buildTotalsV4Observations,totalsV4Probability} from '../lib/nba/opening-research-v4.js';
import {buildOpeningResearchBaselineObservations,openingResearchReadiness} from '../lib/nba/opening-research.js';
import {openingVariableAccepted} from '../lib/nba/opening-core.js';
import {TOTALS_V5_PROTOCOL,TOTALS_V5_PROTOCOL_HASH,totalsV5Hash,totalsV5Candidate,buildTotalsV5Observations,
  totalsV5AsOfRow,totalsV5Distribution,totalsV5Cdf,totalsV5Probability,developTotalsV5,createTotalsV5Selection} from '../lib/nba/opening-research-v5.js';

const history=openingResearchHistory.history.filter(r=>r.year<=2021);
const close=(a,b)=>assert.ok(Math.abs(a-b)<=64*Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
assert.equal(TOTALS_V5_PROTOCOL_HASH,'6ca134f6db97ade0d45a4029255307743eb7f094875baf053fb5e75112caeb50');
assert.deepEqual(TOTALS_V5_PROTOCOL.independentTrainingYears,[2013,2014,2015,2016]);
assert.equal(TOTALS_V5_PROTOCOL.independentHoldoutYear,2017);
assert.ok(Object.isFrozen(TOTALS_V5_PROTOCOL.gates));
for(const target of ['fullTotal','halfTotal']){
  const obs=buildTotalsV5Observations(history,target),points=buildTotalsV4Observations(history,target);
  assert.deepEqual(obs.map(r=>[r.gameId,r.prediction,r.error]),points.map(r=>[r.gameId,r.prediction,r.error]),'V4 MAE point remains exactly locked');
  const rows=obs.filter(r=>r.year===2021),base=buildOpeningResearchBaselineObservations(history,target),first=rows[0];
  for(const r of [first,rows[100],rows.at(-1)]){
    const prior=rows.filter(p=>p.date<r.date),mu=prior.reduce((s,p)=>s+p.pointError,0)/(120+prior.length);
    assert.equal(r.locationCorrection,mu);assert.equal(r.locationSamples,prior.length);
    assert.equal(r.distributionCenter,r.pointPrediction+mu);
    assert.ok(r.locationThrough===null||r.locationThrough<r.date);
    const dist=totalsV5Distribution(r,obs,target);
    assert.ok(dist&&dist.through<r.date);assert.equal(dist.center,r.distributionCenter);
    assert.equal(dist.pointPrediction,r.pointPrediction);assert.equal(dist.locationSamples,r.locationSamples);
    const shape=obs.filter(p=>p.year<r.year&&p.year>=r.year-3&&p.date<r.date&&p.phase===r.phase);
    assert.equal(dist.samples,shape.length);assert.equal(dist.residuals.length,shape.length);
    assert.ok(dist.residuals.every(p=>p.year<r.year&&p.date<r.date));
    const w=p=>2**(-(Date.parse(r.date)-Date.parse(p.date))/86400000/365),sw=shape.reduce((s,p)=>s+w(p),0);
    const weightedMean=shape.reduce((s,p)=>s+w(p)*p.pointError,0)/sw;assert.equal(dist.shapeCenter,weightedMean);
    assert.deepEqual(dist.residuals,shape.map(p=>({gameId:p.gameId,year:p.year,date:p.date,error:p.pointError-weightedMean})));
    const values=Array.from({length:121},(_,i)=>i*4),cdfs=values.map(x=>totalsV5Cdf(dist,x));
    assert.ok(cdfs.every((x,i)=>x>=0&&x<=1&&(!i||x>=cdfs[i-1])),'one coherent monotone distribution across arbitrary quoted lines');
    assert.equal(totalsV5Cdf(dist,-10000),0);assert.equal(totalsV5Cdf(dist,10000),1);
    const p=totalsV5Probability(r,obs,target,base),v4=totalsV4Probability(points.find(p=>p.gameId===r.gameId),points,target,base);
    assert.equal(p.baselineP,v4.baselineP,'canonical baseline probability stays exactly unchanged');
    assert.equal(p.p,1-totalsV5Cdf(dist,p.threshold));
    for(const threshold of [90,100.5,111.25,200,235.5])assert.equal(totalsV5Probability(r,obs,target,base,{threshold}).p,1-totalsV5Cdf(dist,threshold));
    const {actual,error,pointError,distributionError,...scoreFree}=r;
    const forecast=totalsV5AsOfRow(scoreFree,obs,target);
    assert.equal(forecast.pointPrediction,r.pointPrediction);assert.equal(forecast.distributionCenter,r.distributionCenter);
    assert.deepEqual(totalsV5Distribution(forecast,obs,target),dist,'runtime distribution never requires target outcome');
  }
  assert.equal(first.locationCorrection,0);assert.equal(first.locationSamples,0);
  assert.equal(totalsV5Distribution(first,obs.map(r=>({...r,candidateId:'foreign'})),target),null);
  assert.equal(totalsV5Distribution(first,obs.map(r=>({...r,modelVersion:'foreign'})),target),null);
  assert.throws(()=>totalsV5Distribution({...first,fitThrough:first.date},obs,target),/SCOPE/);
  assert.throws(()=>totalsV5Distribution(first,obs,target==='fullTotal'?'halfTotal':'fullTotal'),/SCOPE/);
  const mutated=history.map(r=>r.gameId===first.gameId?{...r,homeScore:r.homeScore+30,homeHalf:r.homeHalf+10}:r);
  const alternate=buildTotalsV5Observations(mutated,target),altBase=buildOpeningResearchBaselineObservations(mutated,target);
  assert.deepEqual(alternate.filter(r=>r.date<=first.date).map(r=>[r.gameId,r.prediction,r.distributionCenter]),obs.filter(r=>r.date<=first.date).map(r=>[r.gameId,r.prediction,r.distributionCenter]));
  const own=alternate.find(r=>r.gameId===first.gameId),ownP=totalsV5Probability(own,alternate,target,altBase),p=totalsV5Probability(first,obs,target,base);
  assert.deepEqual({...ownP,y:null},{...p,y:null},'own label may change outcome, never its forecast or calibration');
  const next=rows.find(r=>r.date>first.date),nextAlt=alternate.find(r=>r.gameId===next.gameId);
  close(nextAlt.locationCorrection-next.locationCorrection,(target==='fullTotal'?30:10)/(120+next.locationSamples));
  assert.notEqual(nextAlt.distributionCenter,next.distributionCenter,'earlier observed labels update later distribution');
  const cutoff=rows[120].date;
  assert.deepEqual(buildTotalsV5Observations(history.filter(r=>r.date<=cutoff),target),obs.filter(r=>r.date<=cutoff),'future labels cannot flow backward');
}
assert.throws(()=>totalsV5Candidate('fullMargin'),/TARGET_INVALID/);
assert.throws(()=>developTotalsV5([{year:2017}]),/DEVELOPMENT_YEAR_SCOPE/);
assert.throws(()=>developTotalsV5(openingResearchHistory.history),/SOURCE_UNVERIFIED/);
const report=JSON.parse(fs.readFileSync('docs/nba-opening-v5-development.json','utf8'));
const selection=JSON.parse(fs.readFileSync('docs/nba-opening-v5-selection.json','utf8'));
assert.equal(report.status,'DEVELOPMENT_PASSED_PENDING_FROZEN_EXTERNAL_HOLDOUT');
assert.equal(report.independentValidation.metrics,null);assert.equal(report.independentValidation.year,2017);
assert.equal(report.executable,false);assert.equal(report.promotionEligible,false);
assert.deepEqual(createTotalsV5Selection(report),selection);
assert.equal(totalsV5Hash(selection),'00ce57501c9da5c2e4ced47571a7437c8a577c9074172139a3f85f27a5ba8269');
for(const target of ['fullTotal','halfTotal'])for(const year of [2021,2022]){
  const metrics=report.targets[target].years[year].metrics;
  assert.equal(openingVariableAccepted(metrics),true);assert.equal(openingResearchReadiness(metrics).readyForIndependentValidation,true);
  const failed={...metrics,modelBrier:metrics.baselineBrier+Number.EPSILON};
  assert.equal(openingVariableAccepted(failed),false,'acceptance uses raw comparisons without replay tolerance');
}
const replay=developTotalsV5(openingResearchHistory.history,{archiveEvidence:openingResearchHistory});
assert.equal(replay.historyHash,report.historyHash);assert.equal(replay.status,report.status);
for(const target of ['fullTotal','halfTotal'])for(const year of [2021,2022]){
  const a=report.targets[target].years[year],b=replay.targets[target].years[year];
  assert.deepEqual(a.reasons,b.reasons);assert.equal(a.passed,b.passed);
  for(const k of Object.keys(a.metrics))if(k==='samples'||k.endsWith('Samples'))assert.equal(a.metrics[k],b.metrics[k]);else close(a.metrics[k],b.metrics[k]);
}
const changed=structuredClone(report);changed.targets.halfTotal.years[2022].metrics.earlyModelMAE=100;
assert.throws(()=>createTotalsV5Selection(changed),/NOT_ACCEPTED/);
console.log('PASS V5 unchanged V4 point, current-season location, phase/version isolation, score-free shared CDF, exact baseline and gates, own/same-date/future counterexamples, frozen development replay; no 2017 metrics');
