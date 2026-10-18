import assert from 'node:assert/strict';
import { soccerSettlementReview } from '../lib/soccer/settlement-review.js';
for(const line of ['1平','1.5','1+50','1-50'])for(const lineSide of ['home','away']){const r=soccerSettlementReview({unit:'GOALS',kind:'HANDICAP',line,lineSide,homeWater:.63,awayWater:1.27});assert.equal(r.executable,false);assert.equal(r.period,null);assert.equal(r.rebateRate,null);assert.equal(r.rows.length,9);for(const row of r.rows)for(const o of row.outcomes)assert.equal(o.winFraction+o.lossFraction+o.pushFraction,1);}
const plus=soccerSettlementReview({unit:'GOALS',kind:'TOTAL',line:'3+50',overWater:.64,underWater:1.28}),minus=soccerSettlementReview({unit:'GOALS',kind:'TOTAL',line:'3-50',overWater:1.08,underWater:.78});
assert.equal(plus.rows[3].outcomes[0].winFraction,.5);assert.equal(plus.rows[3].outcomes[1].lossFraction,.5);assert.equal(minus.rows[3].outcomes[0].lossFraction,.5);assert.equal(minus.rows[3].outcomes[1].winFraction,.5);assert.notDeepEqual(plus.rows[3],minus.rows[3]);
assert.equal(soccerSettlementReview({unit:'GOALS',kind:'HANDICAP',line:'1.5',lineSide:'home',homeWater:1.18,awayWater:.73}).rows.find(r=>r.value===1).outcomes[0].lossFraction,1);
assert.throws(()=>soccerSettlementReview({unit:'GOALS',kind:'TOTAL',line:'3+150',overWater:1,underWater:1}),/INVALID/,'credit percentages cannot be silently capped');assert.throws(()=>soccerSettlementReview({unit:'GOALS',kind:'TOTAL',line:'3',overWater:null,underWater:1}),/PRICE/);assert.throws(()=>soccerSettlementReview({unit:'GOALS',kind:'MONEYLINE',line:'3'}),/MARKET/);
console.log('PASS soccer settlement review: original credit strings, mirrored per-score fractions, decimal handicap, +50/-50 distinction, explicit unverified period/rebate, no default water or execution');

assert.throws(()=>soccerSettlementReview({unit:'CORNERS',kind:'TOTAL',line:'10平',overWater:.84,underWater:.96}),/MARKET_INVALID/);
