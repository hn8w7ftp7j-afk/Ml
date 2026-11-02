import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encloseSoccerDifferenceDistribution, encloseSoccerDifferencePayoff } from '../lib/soccer/difference-payoff-interval.js';
import { evaluateSoccerQuote } from '../lib/soccer/market-payoff.js';
import { scoreDistribution } from '../lib/soccer/score-model.js';
import { predictHalfTimeDistribution, HALF_TIME_MODEL_VERSION, HALF_TIME_PROTOCOL_VERSION } from '../lib/soccer/half-time-model.js';
const oracle=JSON.parse(fs.readFileSync(new URL('./fixtures/soccer/tails/difference-decimal-oracle.json',import.meta.url)));
assert.equal(oracle.method,'PYTHON_DECIMAL_105_DIGITS_SKELLAM_BESSEL_SERIES_PLUS_EXPLICIT_DC_CORRECTION');
const inside=(interval, expected, label)=>{
  assert.ok(interval&&Number.isFinite(interval.lower)&&Number.isFinite(interval.upper)&&interval.lower<=interval.upper,label);
  const value=Number(expected);assert.ok(interval.lower<=value&&value<=interval.upper,`${label}: ${value} outside [${interval.lower}, ${interval.upper}]`);
};
for(const item of oracle.cases){
  const distribution=scoreDistribution(item.homeRate,item.awayRate,item.rho);
  const quote={period:'FT',kind:'HANDICAP',sourceLine:item.line,direction:item.side,lineSide:item.lineSide,water:item.water,waterFormat:'PROFIT_PER_UNIT'};
  const contract={period:'FT',type:item.mechanic,labelMapping:{home:'Home',away:'Away'},provenance:{status:'ASSUMPTION'},rebate:{rate:item.rebateBasis==='NONE'?0:.01,basis:item.rebateBasis}};
  const before=JSON.stringify(distribution),result=evaluateSoccerQuote({quote,distribution,contract});
  assert.equal(result.ok,true);const certified=result.certifiedDifferencePayoff;assert.ok(certified,item.line);
  assert.equal(certified.sourceVerification,'RECOMPUTED_GENERATOR_PMF_AND_COMPLETE_RECTANGLE');
  assert.equal(certified.infiniteSeriesRemainderIncluded,true);assert.equal(certified.arithmeticRoundingIncluded,true);
  assert.ok(certified.omittedProbabilityUpper>0&&certified.omittedProbabilityUpper<=2e-22);
  for(const field of ['gross','rebate','net'])inside(certified.evBounds[field],item.ev[field],`${JSON.stringify(item)} ${field}`);
  for(const field of Object.keys(item.probabilities))inside(certified.probabilityBounds[field],item.probabilities[field],field);
  assert.ok(certified.evBounds.net.upper-certified.evBounds.net.lower<1e-10,'conservative enclosure is usable at disclosed numerical precision');
  assert.equal(certified.netEV,null);assert.equal(certified.W,null);assert.equal(certified.R,null);assert.equal(certified.S,null);
  assert.equal(certified.accepted,false);assert.equal(certified.formalEligible,false);assert.equal(certified.executable,false);
  assert.equal(result.netEV,null,'a certified interval cannot silently become an exact scalar');
  assert.equal(result.unresolvedTailMass,result.tailMass,'legacy retained-grid receipt remains unchanged');
  assert.equal(JSON.stringify(distribution),before);
}
const ft=scoreDistribution(1.4,1.1,0),q={period:'FT',kind:'HANDICAP',sourceLine:'0',direction:'HOME',lineSide:'home',water:.95,waterFormat:'PROFIT_PER_UNIT'},c={period:'FT',type:'ASIAN_SPLIT',provenance:{status:'ASSUMPTION'},rebate:{rate:.01,basis:'SETTLED_PRINCIPAL'}};
const result=evaluateSoccerQuote({quote:q,distribution:ft,contract:c});
assert.ok((result.evBounds.net.upper-result.evBounds.net.lower)>10*(result.certifiedDifferencePayoff.evBounds.net.upper-result.certifiedDifferencePayoff.evBounds.net.lower),'extreme-score convolution materially tightens this tail bound while including rounding');
for(const change of [d=>{d.cells[0].probability+=1e-14;d.cells[1].probability-=1e-14;},d=>{d.homeRate+=.001;},d=>{d.distributionFamily='CALLER_LABEL';},d=>{d.tolerance=1e-9;}]){
 const changed=structuredClone(ft);change(changed);
 assert.equal(evaluateSoccerQuote({quote:q,distribution:changed,contract:c}).certifiedDifferencePayoff,null,'unaltered canonical PMF is required');
}
const halfModel={version:HALF_TIME_MODEL_VERSION,protocolVersion:HALF_TIME_PROTOCOL_VERSION,league:'epl',period:'REGULATION_HT',cutoff:'2026-01-01T00:00:00Z',shares:{home:.45,away:.43}};
const ht=predictHalfTimeDistribution(scoreDistribution(1.5,1.1,.1),halfModel);
const half=evaluateSoccerQuote({quote:{...q,period:'HT'},distribution:ht,contract:{...c,period:'HT'}});
assert.ok(half.certifiedDifferencePayoff);assert.equal(half.certifiedDifferencePayoff.generator,'POISSON_DIXON_COLES_THINNED');
for(const changed of [{...ht,jointContract:null},{...ht,tailSemantics:'INHERITED_FT_TAIL'}])
 assert.equal(evaluateSoccerQuote({quote:{...q,period:'HT'},distribution:changed,contract:{...c,period:'HT'}}).certifiedDifferencePayoff,null);
// Independent equal-rate symmetry, all differences and omitted mass must
// contain total probability one; reversal maps D to -D without reweighting.
for(const rate of [.001,1.4,30]){
 const d=encloseSoccerDifferenceDistribution({homeRate:rate,awayRate:rate});
 for(const row of d.rows){const reverse=d.rows.find(r=>r.difference===-row.difference);assert.ok(reverse);assert.ok(Math.max(row.lower,reverse.lower)<=Math.min(row.upper,reverse.upper));}
 const lower=d.rows.reduce((s,r)=>s+r.lower,0),upper=d.rows.reduce((s,r)=>s+r.upper,0)+d.omittedProbabilityUpper;
 assert.ok(lower<=1&&upper>=1);
}
const cached=encloseSoccerDifferenceDistribution({homeRate:1.4,awayRate:1.1});cached.rows[0].lower=999;
assert.notEqual(encloseSoccerDifferenceDistribution({homeRate:1.4,awayRate:1.1}).rows[0].lower,999,'cached enclosure is not caller mutable');
for(const value of [0,-1,Infinity,NaN,31])assert.throws(()=>encloseSoccerDifferenceDistribution({homeRate:value,awayRate:1}));
assert.throws(()=>encloseSoccerDifferenceDistribution({homeRate:2,awayRate:2,rho:1}));
assert.throws(()=>encloseSoccerDifferencePayoff({homeRate:1,awayRate:1,water:.9,rebate:c.rebate,settle:()=>null}));
console.log('PASS certified handicap difference payoff: 105-digit independent Skellam/DC oracle incl high rates/credit boundaries/quarters/rebates, outward-rounded exponential and infinite-tail bounds, canonical FT/HT provenance, symmetry/cache/input guards; legacy scalar/formal gates unchanged');
