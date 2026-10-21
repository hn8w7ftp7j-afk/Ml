import fs from 'node:fs/promises';
import { openingResearchHistory } from '../lib/nba/opening-research-history.js';
import { developTotalsV3, createTotalsV3Selection, totalsV3Hash } from '../lib/nba/opening-research-v3.js';

if (process.argv.slice(2).some(arg=>!['--development','--lock-selection'].includes(arg))) throw Error('Only development stage is implemented; holdout requires a separately frozen selection');
const report=developTotalsV3(openingResearchHistory.history,{archiveEvidence:openingResearchHistory});
await fs.writeFile('docs/nba-opening-v3-development.json',JSON.stringify(report,null,2)+'\n');
if (process.argv.includes('--lock-selection')) {
  const selection=createTotalsV3Selection(report);
  await fs.writeFile('docs/nba-opening-v3-selection.json',JSON.stringify(selection,null,2)+'\n');
  console.log(JSON.stringify({stage:'selection_frozen_before_real_holdout',selectionHash:totalsV3Hash(selection),selected:selection.selected},null,2));
  process.exit(0);
}
console.log(JSON.stringify({protocolHash:report.protocolHash,sourceAudit:report.sourceAudit.map(r=>({year:r.year,verified:r.verified})),
  targets:Object.fromEntries(Object.entries(report.targets).map(([target,r])=>[target,{selected:r.selected,
    candidates:r.candidates.map(c=>({prior:c.candidate.priorWeight,kernel:c.candidate.kernel,metrics:c.metrics,reasons:c.readiness.reasons}))}])),holdout:report.holdout},null,2));
