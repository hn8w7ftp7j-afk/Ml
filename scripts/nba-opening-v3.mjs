import fs from 'node:fs/promises';
import { openingResearchHistory } from '../lib/nba/opening-research-history.js';
import { developTotalsV3, createTotalsV3Selection, totalsV3Hash, evaluateTotalsV3Holdout, assertTotalsV3Replay, TOTALS_V3_FROZEN_SELECTION_HASH } from '../lib/nba/opening-research-v3.js';

const flags=process.argv.slice(2);
if (flags.length!==1||!['--development','--lock-selection','--holdout'].includes(flags[0])) throw Error('Use exactly one stage: --development, --lock-selection or --holdout');
if (flags[0]==='--holdout') {
  const selection=JSON.parse(await fs.readFile('docs/nba-opening-v3-selection.json','utf8'));
  const developmentEvidence=JSON.parse(await fs.readFile('docs/nba-opening-v3-development.json','utf8'));
  const holdoutEvidence=JSON.parse(await fs.readFile('docs/nba-opening-v3-holdout.json','utf8'));
  const report=evaluateTotalsV3Holdout(openingResearchHistory.history,selection,{archiveEvidence:openingResearchHistory,developmentEvidence,holdoutEvidence});
  console.log(JSON.stringify(report,null,2));
  process.exit(0);
}
const report=developTotalsV3(openingResearchHistory.history,{archiveEvidence:openingResearchHistory});
const recorded=JSON.parse(await fs.readFile('docs/nba-opening-v3-development.json','utf8'));
const replay=assertTotalsV3Replay(report,recorded);
if (process.argv.includes('--lock-selection')) {
  const selection=createTotalsV3Selection(recorded);
  if(totalsV3Hash(selection)!==TOTALS_V3_FROZEN_SELECTION_HASH)throw Error('NBA_TOTALS_V3_FROZEN_SELECTION_MISMATCH');
  console.log(JSON.stringify({stage:'verify_previously_frozen_selection_not_new_holdout',selectionHash:totalsV3Hash(selection),selected:selection.selected,replay},null,2));
  process.exit(0);
}
console.log(JSON.stringify({protocolHash:report.protocolHash,sourceAudit:report.sourceAudit.map(r=>({year:r.year,verified:r.verified})),
  targets:Object.fromEntries(Object.entries(report.targets).map(([target,r])=>[target,{selected:r.selected,
    candidates:r.candidates.map(c=>({prior:c.candidate.priorWeight,kernel:c.candidate.kernel,metrics:c.metrics,reasons:c.readiness.reasons}))}])),holdout:report.holdout},null,2));
