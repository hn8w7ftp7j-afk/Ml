import fs from 'node:fs/promises';
import {openingResearchHistory} from '../lib/nba/opening-research-history.js';
import {openingTraining} from '../lib/nba/opening-training.js';
import {totalsV6Hash,TOTALS_V6_PROTOCOL_HASH} from '../lib/nba/opening-research-v6.js';
import {OPENING_V6_INDEPENDENT_REVIEWED_ARCHIVE_SHA256} from '../lib/nba/opening-v6-independent-evidence.js';
import {verifyTotalsV6IndependentEvidence,verifyTotalsV6RegressionEvidence} from '../lib/nba/opening-totals-v6-runtime.js';
if(process.argv.length!==2)throw Error('No arguments: package only recorded frozen independent and development evidence');
const read=async path=>JSON.parse(await fs.readFile(path,'utf8'));
const independent=await read('docs/nba-opening-v6-independent.json'),development=await read('docs/nba-opening-v6-development.json');
const independentHash=totalsV6Hash(independent),developmentHash=totalsV6Hash(development);
const history=[...openingResearchHistory.history,...openingTraining.history].sort((a,b)=>a.date.localeCompare(b.date)||a.gameId.localeCompare(b.gameId));
const pins={expectedSha256:independentHash,expectedArchiveSha256:OPENING_V6_INDEPENDENT_REVIEWED_ARCHIVE_SHA256,expectedSourceHistoryHash:independent.sourceHistoryHash};
if(independent.selectionFrozenCommit!=='9756419da65c06369166cbae1119ff8c39b3f2f8'
  ||independent.protocolHash!==TOTALS_V6_PROTOCOL_HASH||independent.developmentReportHash!==developmentHash
  ||independent.status!=='HOLDOUT_PASSED_REQUIRES_CURRENT_REGRESSION_AND_INTEGRATION_REVIEW')throw Error('NBA_TOTALS_V6_RELEASE_EVIDENCE_INVALID');
for(const target of ['fullTotal','halfTotal']){
  if(!verifyTotalsV6IndependentEvidence(independent,{...pins,target,targetSeasonYear:2027}).accepted
    ||!verifyTotalsV6RegressionEvidence(development,{expectedSha256:developmentHash,expectedHistoryHash:totalsV6Hash(history),target}).accepted)throw Error('NBA_TOTALS_V6_RELEASE_MARKET_FAILED');
}
const output=`// Generated from frozen, independently evaluated evidence; do not hand-edit.\nimport {createHash} from 'node:crypto';\nif(typeof window!=='undefined')throw Error('NBA_TOTALS_V6_RELEASE_SERVER_ONLY');\nconst freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};\nexport const openingTotalsV6IndependentHash='${independentHash}';\nexport const openingTotalsV6DevelopmentHash='${developmentHash}';\nexport const openingTotalsV6Independent=freeze(${JSON.stringify(independent)});\nexport const openingTotalsV6Development=freeze(${JSON.stringify(development)});\nconst hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');\nif(hash(openingTotalsV6Independent)!==openingTotalsV6IndependentHash||hash(openingTotalsV6Development)!==openingTotalsV6DevelopmentHash)throw Error('NBA_TOTALS_V6_RELEASE_HASH_MISMATCH');\n`;
const path='lib/nba/opening-totals-v6-evidence.js';
try{await fs.writeFile(path,output,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;if(await fs.readFile(path,'utf8')!==output)throw Error('NBA_TOTALS_V6_RELEASE_EVIDENCE_DRIFT');}
console.log(JSON.stringify({saved:path,independentHash,developmentHash,marketsVerified:2,unchangedGates:true}));
