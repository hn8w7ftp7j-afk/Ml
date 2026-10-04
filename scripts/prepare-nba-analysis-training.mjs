import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {gzipSync,gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import {runConservative} from '../lib/nba/analysis-core/score-conservative.js';
import {createScorePredictor} from '../lib/nba/analysis-core/score-recent.js';
import {prequentialTotalCalibration} from '../lib/nba/analysis-core/total-calibration.js';
import {createPaceCalibrationFeatures} from '../lib/nba/analysis-core/pace-features.js';
import {analyzeNbaModel} from '../lib/nba/analysis-model.js';

// Reproducible build step, no network/data fetch. All verified score history is
// retained, including non-evaluation games needed by the expanding estimator.
const source = path.resolve(process.argv[2] ?? '../nba-research-source');
const read = name => JSON.parse(name.endsWith('.gz') ? gunzipSync(fs.readFileSync(path.join(source,name))).toString('utf8') : fs.readFileSync(path.join(source,name),'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = name => sha(fs.readFileSync(path.join(source,name)));
const scorePlan = read('research-evidence/experiment-plan.json'),scoreStudy = read('research-evidence/experiment-plan-v2.json'),paceStudy = read('research-evidence/pace-input-plan-oct4.json');
const historyData = read('data/nba-experiment-history.json'),paceHistorySource=read('data/nba-pace-history.json.gz');
assert.equal(historyData.rows.length,1315);assert.equal(paceHistorySource.rows.length,1315);
assert.equal(paceHistorySource.sourceArchiveSha256,historyData.sourceArchiveSha256);
assert.equal(paceHistorySource.kind,'NBA_VERIFIED_ARCHIVED_PER_GAME_PACE');
const history = historyData.rows.map(({gameId,date,year,seasonType,homeId,awayId,homeScore,awayScore,neutralSite}) => ({gameId,date,year,seasonType,homeId,awayId,homeScore,awayScore,neutralSite}));
const paceHistory={kind:paceHistorySource.kind,sourceArchiveSha256:paceHistorySource.sourceArchiveSha256,sourceArchivedAt:paceHistorySource.sourceArchivedAt,featureVersion:paceHistorySource.featureVersion,rows:paceHistorySource.rows.map(({gameId,date,year,seasonType,homeId,awayId,pace}) => ({gameId,date,year,seasonType,homeId,awayId,pace}))};
const recent=scoreStudy.candidates.find(candidate => candidate.id === 'recent');
const allPredictions=runConservative(history,scorePlan,createScorePredictor(recent,scoreStudy));
const predictions = allPredictions.filter(row => row.status==='ready').map(({gameId,date,seasonType,predictedHome,predictedAway,calibratedHome,calibratedAway,homeCorrection,awayCorrection,calibrationSamples,calibrationThrough}) => ({gameId,date,seasonType,predictedHome,predictedAway,calibratedHome,calibratedAway,homeCorrection,awayCorrection,calibrationSamples,calibrationThrough}));
const predictionMap=new Map(allPredictions.map(row => [row.gameId,row]));
const pairedResiduals=history.filter(game => predictionMap.get(game.gameId)?.status === 'ready').map(game => {
 const p=predictionMap.get(game.gameId);
 return{gameId:game.gameId,date:game.date,year:game.year,seasonType:game.seasonType,rawHome:game.homeScore-p.predictedHome,rawAway:game.awayScore-p.predictedAway};
});
const calibration=prequentialTotalCalibration(history,predictionMap,paceStudy,'pace_rest',{featureBuilder:createPaceCalibrationFeatures(paceHistory)});
const observations=calibration.observations.map(({gameId,date,year,seasonType,features,rawError,error}) => ({gameId,date,year,seasonType,features,rawError,error}));
assert.equal(predictions.length,1243);assert.equal(observations.length,1243);assert.equal(pairedResiduals.length,1243);
assert.deepEqual(Object.fromEntries(['regular','postseason'].map(type=>[type,observations.filter(row=>row.seasonType===type).length])),{regular:1182,postseason:61});
const hashPaths=['research-evidence/experiment-plan.json','research-evidence/experiment-plan-v2.json','research-evidence/pace-input-plan-oct4.json','lib/nba-score-v2.js','lib/nba-conservative.js','lib/nba-pace-input-calibration.js','lib/nba-total-input-calibration.js','lib/nba-local-adaptive.js','lib/nba-simulation.js','data/nba-experiment-history.json','data/nba-pace-history.json.gz','data/nba-experiment-v9.json.gz'];
const training={kind:'NBA_PACE_REST_FIXED_TRAINING',modelVersion:'nba-total-pace-rest-v1',strictPointInTime:false,promotionEligible:false,
 provenance:{sourceRepositoryCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim(),sourceArchiveSha256:historyData.sourceArchiveSha256,sourceArchivedAt:paceHistory.sourceArchivedAt,captureBasis:'archived_after_season_not_verified_pregame_capture',hashes:Object.fromEntries(hashPaths.map(name=>[name,hash(name)])),localCoreHashes:Object.fromEntries(['score-conservative','score-recent','pace-features','total-calibration','credit-total'].map(name=>[name,sha(fs.readFileSync(`lib/nba/analysis-core/${name}.js`))]))},
 scorePlan,scoreStudy,paceStudy,history,paceHistory,predictions,pairedResiduals,observations};
// Prove the runtime adapter reproduces every full-market total in the approved
// archived trial using the same source endpoint waters, not the selected side.
const v9=read('data/nba-experiment-v9.json.gz'),corpus=read('data/nba-corpus.json');
const entries=new Map(corpus.entries.map(entry=>[entry.gameId,entry])),historyMap=new Map(history.map(game=>[game.gameId,game]));
const {oppositeSideWater}=await import(pathToFileURL(path.join(source,'lib/nba-contract-research.js')).href);
let count=0,maxDifference=0;
const close=(actual,expected,label)=>{const difference=Math.abs(actual-expected);maxDifference=Math.max(maxDifference,difference);assert.ok(difference<1e-8,`${label}: ${actual} != ${expected}`);};
for(const row of v9.variants.total_pace_rest.rows.filter(row=>row.market==='total')){
 const game=historyMap.get(row.gameId),waters=oppositeSideWater(entries.get(row.gameId),row);
 const normalized={id:game.gameId,league:'NBA',taipeiDate:game.date,season:{year:game.year,type:game.seasonType},seasonType:game.seasonType,home:{id:game.homeId},away:{id:game.awayId},neutralSite:game.neutralSite};
 const result=analyzeNbaModel(normalized,{line:row.line,overWater:waters.positive,underWater:waters.negative},{trainingData:training});
 assert.equal(result.status,'ready',JSON.stringify(result.issues));
 close(result.prediction.baseTotal,row.predictedQuantity,'base total');close(result.prediction.total,row.totalCalibrationQuantity,'calibrated total');close(result.prediction.correction,row.calibrationAssessment.correction,'correction');
 close(result.assessment.positiveExpectedNet,row.positiveExpectedNet,'over expected net');close(result.assessment.negativeExpectedNet,row.negativeExpectedNet,'under expected net');
 assert.equal(result.assessment.direction,row.direction);assert.equal(result.assessment.calibrationSamples,row.calibrationAssessment.calibrationSamples);assert.equal(result.assessment.distributionSamples,row.distributionSamples);count++;
}
assert.equal(count,867);
const encoded=gzipSync(Buffer.from(JSON.stringify(training)),{level:9}).toString('base64');
const generated=`// Generated by scripts/prepare-nba-analysis-training.mjs from verified source hashes.\n// Server-only: Node decompression and an explicit browser guard. No current-game outcomes.\nimport {gunzipSync} from 'node:zlib';\nif(typeof window!=='undefined')throw new Error('NBA_ANALYSIS_TRAINING_SERVER_ONLY');\nconst freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};\nexport const defaultTraining=freeze(JSON.parse(gunzipSync(Buffer.from('${encoded}','base64')).toString('utf8')));\n`;
fs.writeFileSync('lib/nba/analysis-training.js',generated);
console.log(JSON.stringify({history:history.length,predictions:predictions.length,innovations:observations.length,sameSeasonType:{regular:1182,postseason:61},verifiedV9Totals:count,maximumNumericalDifference:maxDifference,generatedBytes:Buffer.byteLength(generated),generatedSha256:sha(generated),sourceCommit:training.provenance.sourceRepositoryCommit}));
