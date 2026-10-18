// Read-only real-provider check. No fixture tokens, database writes or betting actions.
import assert from 'node:assert/strict';
import { soccerDate } from '../lib/soccer/contracts.js';
import { fetchSoccerSchedule } from '../lib/soccer/data.js';
import { fetchSoccerPrematch } from '../lib/soccer/prematch.js';
import { buildSoccerAnalysis } from '../lib/soccer/analysis.js';
for(const league of ['epl','ucl']){
 const board=await fetchSoccerSchedule(league,soccerDate(),{windowDays:14,timeoutMs:12000,ttlMs:0});assert.equal(board.ok,true,JSON.stringify({code:board.code,upstream:board.upstreamStatus}));
 let checked=null;for(const game of board.games.filter(g=>g.status==='scheduled'&&Date.parse(g.startTime)>Date.now())){
  const evidence=await fetchSoccerPrematch(game,{timeoutMs:12000,ttlMs:0});assert.equal(evidence.ok,true,JSON.stringify({id:game.id,code:evidence.code}));
  const analysis=buildSoccerAnalysis({evidence});assert.equal(analysis.directions.length,8);assert.equal(analysis.executable,false);assert.equal(evidence.phase,'PREMATCH_OBSERVATION');
  if(analysis.prediction){checked={league,gameId:game.id,date:game.date,source:evidence.source.url,sourceAt:evidence.source.fetchedAt,homeXI:evidence.teams.home.lineup.status,awayXI:evidence.teams.away.lineup.status,predictionStatus:analysis.prediction.status,modelTrainingHash:analysis.prediction.trainingHash,directionCount:analysis.directions.length,executable:false};break;}
 }
 assert.ok(checked,`${league}: no applicable scheduled fixture was verified`);console.log('SOCCER_ANALYSIS_SOURCE_PASS',JSON.stringify(checked));
}
