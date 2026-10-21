import fs from 'node:fs/promises';
import {openingResearchHistory} from '../lib/nba/opening-research-history.js';
import {developTotalsV5,createTotalsV5Selection,totalsV5Hash} from '../lib/nba/opening-research-v5.js';

const flags=process.argv.slice(2);
if(flags.length>1||(flags.length&&flags[0]!=='--write-development'))throw Error('Use no arguments or --write-development. This runner never evaluates the 2017 holdout.');
const report=developTotalsV5(openingResearchHistory.history,{archiveEvidence:openingResearchHistory});
const selection=report.status==='DEVELOPMENT_PASSED_PENDING_FROZEN_EXTERNAL_HOLDOUT'?createTotalsV5Selection(report):null;
if(flags[0]==='--write-development'){
  await fs.writeFile('docs/nba-opening-v5-development.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  if(selection)await fs.writeFile('docs/nba-opening-v5-selection.json',JSON.stringify(selection,null,2)+'\n',{flag:'wx'});
}
console.log(JSON.stringify({protocolHash:report.protocolHash,status:report.status,targets:report.targets,
  selectionHash:selection?totalsV5Hash(selection):null,independentValidation:report.independentValidation},null,2));
