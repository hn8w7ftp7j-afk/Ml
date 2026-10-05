import assert from 'node:assert/strict';
import { nbaMarketScore, NBA_SCORE_EVIDENCE_VERSION } from '../lib/nba/market-score.js';
import { deterministicScore, SCORE_FORMULA_VERSION, scoreBoundaryAudit } from '../lib/deterministic-score.js';
import { analyzeNbaPreseason } from '../lib/nba/preseason-model.js';
const side=(w, nets)=>({ expectedNet:w,robustExpectedNet:Math.min(w,...nets),scoreEvidence:{version:NBA_SCORE_EVIDENCE_VERSION,basis:'minimum_prior_preseason_season_expected_net',seasons:nets.map((expectedNet,i)=>({year:2024+i,samples:35,expectedNet}))}});
for(const s of [side(-5,[-8,-2]),side(5,[-3,7]),side(1,[.5,2]),side(3,[1,2]),side(5,[3,6]),side(10,[6,12]),side(30,[25,32])]){
 const score=nbaMarketScore(s),input={weightedEV:s.expectedNet/100,robustEV:s.robustExpectedNet/100,executable:false,qaPassed:true,actualWater:true};
 assert.deepEqual(score,deterministicScore(input));assert.equal(score.formulaVersion,SCORE_FORMULA_VERSION);assert.equal(scoreBoundaryAudit(score,input).ok,true);assert.equal(score.formulaEligible,false);assert.equal(score.formalEligible,false);
}
assert.equal(nbaMarketScore(side(5,[-3,7])).score<=7.1,true);
assert.equal(nbaMarketScore(side(30,[25,32])).score,8.9);
assert.equal(nbaMarketScore({...side(5,[2,3]),robustExpectedNet:4}),null);
assert.equal(nbaMarketScore(side(5,[3])),null);
assert.equal(nbaMarketScore({expectedNet:5,winProbability:.75}),null);
const game={league:'NBA',id:'nba:espn:game:401999001',seasonType:'preseason',season:{year:2027},taipeiDate:'2026-10-06',home:{id:'nba:espn:team:1'},away:{id:'nba:espn:team:29'}};
const result=analyzeNbaPreseason(game,{fullTotal:{line:'232.5',overWater:.94,underWater:.94},fullRunline:{line:'3平',lineSide:'home',homeWater:.95,awayWater:.95}});
for(const market of Object.values(result.marketAnalyses).filter(x=>x.status==='ready'))for(const s of Object.values(market.sides)){
 assert.equal(s.scoreEvidence.seasons.length,3);assert.equal(s.robustExpectedNet,Math.min(s.expectedNet,...s.scoreEvidence.seasons.map(x=>x.expectedNet)));assert.ok(s.scoreEvidence.seasons.every(x=>x.year<=2026&&x.samples>=30));assert.ok(nbaMarketScore(s));
}
console.log('NBA S score PASS: shared MLB formula, decimal W/R units, conservative prior-season stress minimum, no R invention, threshold bounds and non-executable eligibility');
