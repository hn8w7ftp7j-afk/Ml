import assert from 'node:assert/strict';
import {defaultTraining} from '../lib/nba/analysis-training.js';
import {quarterTraining} from '../lib/nba/quarter-training.js';
import {preseasonTraining} from '../lib/nba/preseason-training.js';
import {buildLiveNbaTraining} from '../lib/nba/live-training.js';
import {validateNbaLiveHistoryRow} from '../lib/nba/live-history.js';
import {analyzeNbaRegularMarkets} from '../lib/nba/regular-markets.js';
import {createLiveHistoryFixture,resealLiveHistoryFixture} from './fixtures/nba-live-history-fixture.mjs';

const options={beforeDate:'2026-10-08',seasonYear:2027};
const dateAfter=(date,days)=>new Date(Date.parse(`${date}T00:00:00Z`)+days*86400000).toISOString().slice(0,10);
const empty=buildLiveNbaTraining([],options);
assert.equal(empty.status,'ready');assert.equal(empty.provenance.active,false);
assert.equal(empty.provenance.status,'archive_only');assert.equal(empty.provenance.liveGames,0);
assert.equal(empty.trainingData,defaultTraining);assert.equal(empty.halfTraining,quarterTraining);assert.equal(empty.preseasonTrainingData,preseasonTraining);

// Synthetic calendar/identity variants are explicitly test-only. Every variant
// retains a real, complete final box and an official/provider identity crosswalk.
const rows=Array.from({length:96},(_,index)=>{
 const{row}=createLiveHistoryFixture({date:dateAfter('2026-07-01',index),year:2027,gameId:String(401899000+index)});
 // Keep actual final scores unchanged, but vary how many were scored before
 // halftime. This rules out manufacturing halves by dividing full scores.
 if(index%2===0){row.game.home.periodScores[1].score+=10;row.game.home.periodScores[3].score-=10;row.homeHalf+=10;resealLiveHistoryFixture(row);}
 validateNbaLiveHistoryRow(row);return row;
});
const updated=buildLiveNbaTraining(rows,options);
assert.equal(updated.status,'ready',JSON.stringify(updated.issues));
assert.equal(updated.provenance.active,true);
assert.equal(updated.provenance.status,'ready');assert.equal(updated.provenance.liveGames,96);
assert.deepEqual(updated.provenance.fullChangedGroups,['2027:regular']);
assert.deepEqual(updated.provenance.halfChangedGroups,['2027:regular']);
assert.equal(updated.trainingData.modelVersion,defaultTraining.modelVersion);
assert.equal(updated.trainingData.scorePlan,defaultTraining.scorePlan);assert.equal(updated.trainingData.scoreStudy,defaultTraining.scoreStudy);assert.equal(updated.trainingData.paceStudy,defaultTraining.paceStudy);
assert.equal(updated.trainingData.provenance.sourceArchiveSha256,defaultTraining.provenance.sourceArchiveSha256);
assert.equal(updated.halfTraining.provenance.sourceArchiveSha256,defaultTraining.provenance.sourceArchiveSha256);
assert.equal(updated.provenance.strictPointInTime,false);assert.equal(updated.provenance.promotionEligible,false);
assert.equal(updated.trainingData.observations.filter(row=>row.year===2027&&row.seasonType==='regular').length,93);
assert.equal(updated.halfTraining.observations.filter(row=>row.year===2027&&row.seasonType==='regular').length,93);
assert.ok(updated.halfTraining.history.filter(row=>row.year===2027).every(row=>row.homeScore===row.homeHalf&&row.awayScore===row.awayHalf&&/^[a-f0-9]{64}$/.test(row.checkpointSha256)));
for(const key of ['predictions','pairedResiduals','observations']){
 const oldIds=new Set(defaultTraining[key].map(row=>row.gameId));
 assert.deepEqual(updated.trainingData[key].filter(row=>oldIds.has(row.gameId)),defaultTraining[key]);
 assert.ok(defaultTraining[key].every(old=>updated.trainingData[key].find(row=>row.gameId===old.gameId)===old),'Unchanged frozen innovations retain their original row objects');
}
for(const key of ['pairedResiduals','observations'])assert.deepEqual(updated.halfTraining[key].filter(row=>row.year===2026),quarterTraining[key]);

const normalized={id:'nba:espn:game:401999998',league:'NBA',taipeiDate:options.beforeDate,season:{year:2027,type:'regular'},seasonType:'regular',home:{id:rows[0].homeId},away:{id:rows[0].awayId},neutralSite:false};
const quotes={fullTotal:{line:'230.5',overWater:.95,underWater:.95},fullRunline:{line:'8+20',lineSide:'home',homeWater:.95,awayWater:.95},firstHalfTotal:{line:'119.5',overWater:.95,underWater:.95},firstHalfRunline:{line:'20.5',lineSide:'home',homeWater:.95,awayWater:.95}};
const analyze=training=>analyzeNbaRegularMarkets(normalized,quotes,{trainingData:training.trainingData,halfTraining:training.halfTraining});
const model=analyze(updated);
assert.equal(model.status,'ready',JSON.stringify(model.issues));
for(const market of Object.values(model.marketAnalyses))assert.equal(market.status,'ready');
assert.ok(Math.abs(model.regularAnalysis.halfTotal-model.regularAnalysis.fullTotal/2)>1,'Actual independently fitted halftime totals differ from full/2');
assert.ok(Math.abs(model.regularAnalysis.halfMargin-model.regularAnalysis.fullMargin/2)>1,'Actual independently fitted halftime margins differ from full/2');
assert.equal(model.executable,false);assert.equal(model.strictPointInTime,false);assert.equal(model.promotionEligible,false);

const tooEarly=buildLiveNbaTraining(rows,{...options,beforeDate:'2026-08-22'});
assert.equal(tooEarly.status,'ready');
assert.equal(tooEarly.trainingData.observations.filter(row=>row.year===2027).length,49);
assert.deepEqual(updated.trainingData.observations.filter(row=>row.year===2027&&row.date<'2026-08-22'),tooEarly.trainingData.observations.filter(row=>row.year===2027),'Later outcomes cannot alter earlier prequential full-total errors');
assert.deepEqual(updated.halfTraining.observations.filter(row=>row.year===2027&&row.date<'2026-08-22'),tooEarly.halfTraining.observations.filter(row=>row.year===2027),'Later outcomes cannot alter earlier independently fitted half errors');
const insufficient=analyzeNbaRegularMarkets({...normalized,taipeiDate:'2026-08-22'},quotes,{trainingData:tooEarly.trainingData,halfTraining:tooEarly.halfTraining});
assert.equal(insufficient.status,'insufficient','A new season cannot borrow 2026 residuals to clear the 50-sample gate');

const sameDate=createLiveHistoryFixture({date:'2026-10-07',year:2027,gameId:'401899997'}).row;
const future=createLiveHistoryFixture({date:'2026-10-07',year:2028,gameId:'401899996'}).row;
const cutoff={beforeDate:'2026-10-07',seasonYear:2027};
const before=buildLiveNbaTraining(rows,cutoff);
const injected=buildLiveNbaTraining([...rows,sameDate,future],cutoff);
assert.equal(injected.status,'ready');
assert.deepEqual(injected,before,'Same-date, future-year rows cannot alter predictions, errors, or provenance');
const onlyExcluded=buildLiveNbaTraining([sameDate,future],cutoff);
assert.equal(onlyExcluded.trainingData,defaultTraining);assert.equal(onlyExcluded.halfTraining,quarterTraining);assert.equal(onlyExcluded.preseasonTrainingData,preseasonTraining);
assert.deepEqual(buildLiveNbaTraining([...rows].reverse(),options),updated,'Arrival order does not affect model rebuilding');
assert.deepEqual(buildLiveNbaTraining([...rows,structuredClone(rows[0])],options),updated,'Identical append-only repeats do not weight one game twice');
const fixedClock=Date.parse('2026-10-08T00:00:00Z');
assert.deepEqual(buildLiveNbaTraining(rows,{...options,now:fixedClock}),updated);
assert.deepEqual(buildLiveNbaTraining(rows,{...options,now:()=>fixedClock}),updated);
assert.equal(buildLiveNbaTraining([rows[0]],{...options,now:Date.parse('2026-06-30T00:00:00Z')}).issues[0].code,'NBA_LIVE_HISTORY_INVALID','Capture time is checked against the injected trusted clock');

const corrupted=structuredClone(rows[0]);corrupted.homeScore++;
const invalid=buildLiveNbaTraining([corrupted],options);
assert.equal(invalid.status,'blocked','Every record must pass full evidence and outcome hash validation');assert.equal(invalid.issues[0].code,'NBA_LIVE_HISTORY_INVALID');
const conflicting=structuredClone(rows[0]);conflicting.game.home.periodScores[1].score--;conflicting.game.home.periodScores[3].score++;conflicting.homeHalf--;resealLiveHistoryFixture(conflicting);validateNbaLiveHistoryRow(conflicting);
const blocked=buildLiveNbaTraining([rows[0],conflicting],options);
assert.equal(blocked.status,'blocked');assert.equal(blocked.issues[0].code,'NBA_LIVE_TRAINING_DUPLICATE_GAME_CONFLICT');assert.equal(blocked.trainingData,null);
const frozenConflict=createLiveHistoryFixture().row;frozenConflict.game.neutralSite=true;frozenConflict.neutralSite=true;resealLiveHistoryFixture(frozenConflict);validateNbaLiveHistoryRow(frozenConflict);
assert.equal(buildLiveNbaTraining([frozenConflict],options).issues[0].code,'NBA_LIVE_TRAINING_FROZEN_SCORE_CONFLICT');

// Preseason inputs supply earlier pace/rest history, but never regular score or
// calibration samples. The fixed preseason model still fits actual half scores.
const preseasonRow=createLiveHistoryFixture({date:'2026-06-29',year:2027,seasonType:'preseason',gameId:'401899995'}).row;
const crossType=buildLiveNbaTraining([...rows,preseasonRow],options);
assert.equal(crossType.status,'ready',JSON.stringify(crossType.issues));
assert.ok(crossType.trainingData.paceHistory.rows.some(row=>row.gameId===preseasonRow.gameId));
assert.ok(crossType.trainingData.history.some(row=>row.gameId===preseasonRow.gameId));
assert.equal(crossType.trainingData.observations.filter(row=>row.year===2027&&row.seasonType==='regular').length,93);
assert.equal(crossType.trainingData.observations.filter(row=>row.year===2027&&row.seasonType==='preseason').length,0);
assert.equal(crossType.provenance.preseasonRebuilt,true);
assert.ok(crossType.preseasonTrainingData.history.some(row=>row.gameId===preseasonRow.gameId&&row.homeHalf===preseasonRow.homeHalf));
assert.equal(crossType.preseasonTrainingData.modelVersion,preseasonTraining.modelVersion);

console.log(JSON.stringify({status:'PASS',verifiedSyntheticGames:rows.length,newSeasonResiduals:93,markets:4,sameDateFutureIsolation:true,unchangedFrozenInnovations:true,actualHalfScores:true,conflictsBlocked:true}));
