import assert from 'node:assert/strict';
import fs from 'node:fs';
import {openingV6IndependentHistory} from '../lib/nba/opening-v6-independent-history.js';
import {evaluateTotalsV6Independent,TOTALS_V6_FROZEN_SELECTION_HASH} from '../lib/nba/opening-v6-independent-validation.js';
import {totalsV6Hash} from '../lib/nba/opening-research-v6.js';
import {assertTotalsV3Replay} from '../lib/nba/opening-research-v3.js';
const read=path=>JSON.parse(fs.readFileSync(path,'utf8'));
const selection=read('docs/nba-opening-v6-selection.json'),developmentEvidence=read('docs/nba-opening-v6-development.json');
const recorded=read('docs/nba-opening-v6-independent.json');
assert.equal(totalsV6Hash(selection),TOTALS_V6_FROZEN_SELECTION_HASH);
assert.equal(totalsV6Hash(recorded),'7afaad0d3ad268fcb9eac4a17793ad1c085400a27637c562c6f7f50844417cb8');
assert.equal(recorded.status,'HOLDOUT_PASSED_REQUIRES_CURRENT_REGRESSION_AND_INTEGRATION_REVIEW');
assert.equal(recorded.holdoutConsumed,true);assert.equal(recorded.reselectionAllowed,false);
for(const target of ['fullTotal','halfTotal']){
  assert.equal(recorded.targets[target].passed,true);assert.deepEqual(recorded.targets[target].reasons,[]);
  assert.equal(recorded.targets[target].metrics.samples,1230);assert.equal(recorded.targets[target].metrics.earlySamples,145);
  assert.equal(recorded.targets[target].metrics.earlyModelMAE,recorded.targets[target].metrics.earlyBaselineMAE);
}
const options={archiveEvidence:openingV6IndependentHistory,developmentEvidence,selectionFrozenCommit:recorded.selectionFrozenCommit};
assert.throws(()=>evaluateTotalsV6Independent(openingV6IndependentHistory.history,{...selection,independentHoldoutYear:2010},options),/FROZEN_SELECTION/);
assert.throws(()=>evaluateTotalsV6Independent(openingV6IndependentHistory.history,selection,{...options,selectionFrozenCommit:null}),/FREEZE_COMMIT/);
assert.throws(()=>evaluateTotalsV6Independent(openingV6IndependentHistory.history,selection,{...options,archiveEvidence:{}}),/SOURCE_UNVERIFIED/);
assertTotalsV3Replay(evaluateTotalsV6Independent(openingV6IndependentHistory.history,selection,options),recorded);
console.log('PASS frozen V6 consumed2011 evidence replay, full/half raw gates, deliberate early baseline equality, source/selection/commit rejection and no reselection');
