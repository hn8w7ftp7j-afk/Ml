import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { rollingSoccerFold,SOCCER_VALIDATION_PROTOCOL } from '../lib/soccer/validation.js';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
fs.writeFileSync('research/soccer/validation-protocol.json',JSON.stringify(SOCCER_VALIDATION_PROTOCOL,null,2)+'\n');
const results={};
for(const league of ['epl','ucl']){
 const {rows}=JSON.parse(gunzipSync(fs.readFileSync(`research/soccer/${league}-history.json.gz`)));const folds=[];
 for(const year of SOCCER_VALIDATION_PROTOCOL.testYears){const fold=rollingSoccerFold(rows,league,year);folds.push(fold);console.log('ROLLING_FOLD',JSON.stringify({league,year,selected:fold.selected,count:fold.metrics.count,total:fold.metrics.total,logLoss:fold.metrics.logLoss,interval:fold.comparison.interval,intervalBelowZero:fold.comparison.intervalBelowZero}));}
 results[league]={inputHash:hash(rows),folds,repeatableImprovementEstablished:false,interpretation:'Per-year differences are diagnostics; source availability, calibration and betting evidence remain unverified'};
}
const report={version:SOCCER_VALIDATION_PROTOCOL.version,createdAt:new Date().toISOString(),protocol:SOCCER_VALIDATION_PROTOCOL,leagues:results,promotion:false};
fs.writeFileSync('research/soccer/validation.json',JSON.stringify(report,null,2)+'\n');
const compact={...report,leagues:Object.fromEntries(Object.entries(results).map(([league,r])=>[league,{inputHash:r.inputHash,repeatableImprovementEstablished:false,interpretation:r.interpretation,folds:r.folds.map(({paired,metrics,referenceMetrics,...f})=>({...f,pairedCount:paired.length,metrics:{...metrics,games:undefined},referenceMetrics:{...referenceMetrics,games:undefined}}))}]))};
compact.contentHash=hash(compact);fs.writeFileSync('lib/soccer/validation-frozen.js','// Generated rolling retrospective diagnostics. Not a promotion certificate.\nconst data='+JSON.stringify(compact)+';\nexport function soccerValidationArtifacts(){return structuredClone(data);}\n');
