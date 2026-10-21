import fs from 'node:fs/promises';
import {openingResearchHistory} from '../lib/nba/opening-research-history.js';
import {evaluateTotalsV4} from '../lib/nba/opening-research-v4.js';

const flags=process.argv.slice(2);
if(flags.length>1||(flags.length&&!['--write'].includes(flags[0])))throw Error('Use no arguments, or --write to create a new development report');
const report=evaluateTotalsV4(openingResearchHistory.history,{archiveEvidence:openingResearchHistory});
if(flags[0]==='--write')await fs.writeFile('docs/nba-opening-v4-development.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({protocolHash:report.protocolHash,targets:report.targets,status:report.status,independentValidation:report.independentValidation},null,2));
