import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {openingIndependentHistory} from '../lib/nba/opening-independent-history.js';
import {evaluateTotalsV5Independent} from '../lib/nba/opening-v5-independent-validation.js';

const [flag,commit]=process.argv.slice(2);
if(flag!=='--frozen-commit'||!/^[a-f0-9]{40}$/.test(commit||'')||process.argv.length!==4)throw Error('Use --frozen-commit <exact pushed commit SHA>');
// The held-out evaluation cannot run with a locally altered model/selection.
for(const path of ['lib/nba/opening-research-v4.js','lib/nba/opening-research-v5.js',
  'lib/nba/opening-research.js','lib/nba/opening-core.js',
  'lib/nba/opening-independent-history.js','lib/nba/opening-independent-evidence.js',
  'lib/nba/opening-v5-independent-validation.js','docs/nba-opening-v5-development.json','docs/nba-opening-v5-selection.json']){
  const committed=execFileSync('git',['show',`${commit}:${path}`],{maxBuffer:5*1024*1024});
  if(!committed.equals(await fs.readFile(path)))throw Error(`NBA_TOTALS_V5_UNCOMMITTED_FREEZE_DRIFT:${path}`);
}
const selection=JSON.parse(await fs.readFile('docs/nba-opening-v5-selection.json','utf8'));
const developmentEvidence=JSON.parse(await fs.readFile('docs/nba-opening-v5-development.json','utf8'));
const path='docs/nba-opening-v5-independent.json';
try{await fs.access(path);throw Error('NBA_TOTALS_V5_HOLDOUT_ALREADY_RECORDED: replay via tests, never overwrite consumed evidence');}catch(e){if(e.code!=='ENOENT')throw e;}
const report=evaluateTotalsV5Independent(openingIndependentHistory.history,selection,
  {archiveEvidence:openingIndependentHistory,developmentEvidence,selectionFrozenCommit:commit});
await fs.writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({selectionFrozenCommit:commit,status:report.status,targets:report.targets},null,2));
