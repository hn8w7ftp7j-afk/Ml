import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {openingV6IndependentHistory} from '../lib/nba/opening-v6-independent-history.js';
import {evaluateTotalsV6Independent} from '../lib/nba/opening-v6-independent-validation.js';
const [flag,commit]=process.argv.slice(2);
if(flag!=='--frozen-commit'||!/^[a-f0-9]{40}$/.test(commit||'')||process.argv.length!==4)throw Error('Use --frozen-commit <exact pushed commit SHA>');
for(const path of ['lib/nba/opening-research-v4.js','lib/nba/opening-research-v6.js','lib/nba/opening-research.js','lib/nba/opening-core.js',
  'lib/nba/opening-v6-independent-history.js','lib/nba/opening-v6-independent-evidence.js',
  'lib/nba/opening-v6-independent-validation.js','docs/nba-opening-v6-development.json','docs/nba-opening-v6-selection.json']){
  const committed=execFileSync('git',['show',`${commit}:${path}`],{maxBuffer:5*1024*1024});
  if(!committed.equals(await fs.readFile(path)))throw Error(`NBA_TOTALS_V6_UNCOMMITTED_FREEZE_DRIFT:${path}`);
}
const selection=JSON.parse(await fs.readFile('docs/nba-opening-v6-selection.json','utf8'));
const developmentEvidence=JSON.parse(await fs.readFile('docs/nba-opening-v6-development.json','utf8'));
const path='docs/nba-opening-v6-independent.json';
try{await fs.access(path);throw Error('NBA_TOTALS_V6_HOLDOUT_ALREADY_RECORDED: never overwrite consumed evidence');}catch(e){if(e.code!=='ENOENT')throw e;}
const report=evaluateTotalsV6Independent(openingV6IndependentHistory.history,selection,
  {archiveEvidence:openingV6IndependentHistory,developmentEvidence,selectionFrozenCommit:commit});
await fs.writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({selectionFrozenCommit:commit,status:report.status,targets:report.targets},null,2));
