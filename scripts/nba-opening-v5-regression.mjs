import fs from 'node:fs/promises';
import {openingResearchHistory} from '../lib/nba/opening-research-history.js';
import {openingTraining} from '../lib/nba/opening-training.js';
import {validateOpeningHistory} from '../lib/nba/opening-core.js';
import {TOTALS_V5_PROTOCOL,TOTALS_V5_PROTOCOL_HASH,totalsV5Hash,buildTotalsV5Observations,totalsV5Probability,totalsV5Metrics} from '../lib/nba/opening-research-v5.js';
import {buildOpeningResearchBaselineObservations,openingResearchReadiness} from '../lib/nba/opening-research.js';

if(process.argv.length!==2)throw Error('No arguments accepted; only viewed 2023–2026 regression, never independent2017');
const history=[...openingResearchHistory.history,...openingTraining.history].sort((a,b)=>a.date.localeCompare(b.date)||a.gameId.localeCompare(b.gameId));
if(!validateOpeningHistory(history)||history.some(r=>r.year<2018||r.year>2026))throw Error('NBA_TOTALS_V5_REGRESSION_HISTORY_INVALID');
const targets={};
for(const target of ['fullTotal','halfTotal']){
  const observations=buildTotalsV5Observations(history,target),baseline=buildOpeningResearchBaselineObservations(history,target);
  targets[target]={};
  for(const year of TOTALS_V5_PROTOCOL.viewedRegressionYears){
    const rows=observations.filter(r=>r.year===year),probabilities=rows.flatMap(r=>totalsV5Probability(r,observations,target,baseline)||[]);
    const metrics=totalsV5Metrics(rows,probabilities),readiness=openingResearchReadiness(metrics);
    targets[target][year]={role:'VIEWED_CURRENT_ARCHIVE_REGRESSION_NOT_NEW_INDEPENDENT_VALIDATION',metrics,
      passed:readiness.readyForIndependentValidation,reasons:readiness.reasons};
  }
}
const report={version:'nba-opening-v5-current-regression-v1',modelVersion:TOTALS_V5_PROTOCOL.version,
  protocolHash:TOTALS_V5_PROTOCOL_HASH,historyHash:totalsV5Hash(history),
  sourceArchiveHashes:{research:totalsV5Hash(openingResearchHistory),training:totalsV5Hash(openingTraining)},targets,
  status:Object.values(targets).every(t=>Object.values(t).every(r=>r.passed))?'REGRESSION_PASSED_REQUIRES_INDEPENDENT_AND_RUNTIME_REVIEW':'BLOCKED_REGRESSION_FAILED',
  executable:false,promotionEligible:false};
await fs.writeFile('docs/nba-opening-v5-regression.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report,null,2));
