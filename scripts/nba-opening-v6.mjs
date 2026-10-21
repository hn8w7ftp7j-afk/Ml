import fs from 'node:fs/promises';
import {openingResearchHistory} from '../lib/nba/opening-research-history.js';
import {openingTraining} from '../lib/nba/opening-training.js';
import {developTotalsV6,createTotalsV6Selection,totalsV6Hash} from '../lib/nba/opening-research-v6.js';

const flags=process.argv.slice(2);
if(flags.length>1||(flags.length&&flags[0]!=='--write-development'))throw Error('Use no arguments or --write-development. This runner never evaluates the 2011 holdout.');
const history=[...openingResearchHistory.history,...openingTraining.history].sort((a,b)=>a.date.localeCompare(b.date)||a.gameId.localeCompare(b.gameId));
const report=developTotalsV6(history,{archiveEvidence:openingResearchHistory,regressionEvidence:openingTraining});
const selection=report.status==='DEVELOPMENT_PASSED_PENDING_FROZEN_EXTERNAL_HOLDOUT'?createTotalsV6Selection(report):null;
if(flags[0]==='--write-development'){
  await fs.writeFile('docs/nba-opening-v6-development.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  if(selection)await fs.writeFile('docs/nba-opening-v6-selection.json',JSON.stringify(selection,null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify({protocolHash:report.protocolHash,status:report.status,targets:report.targets,
  selectionHash:selection?totalsV6Hash(selection):null,independentValidation:report.independentValidation},null,2));
