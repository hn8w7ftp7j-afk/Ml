import assert from 'node:assert/strict';
import { SOCCER_ACCOUNT_RULE_CONFIRMATION as policy } from '../lib/soccer/account-rule-policy.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { scoreSoccerQuote } from '../lib/soccer/soccer-scoring.js';
import { soccerVerifiedSettlementContract, soccerSettlementContractComplete, soccerSettlementMissingTerms } from '../lib/soccer/settlement-contract.js';
import { soccerSystemScoringReadiness } from '../lib/soccer/system-readiness.js';
import { soccerDate } from '../lib/soccer/contracts.js';
const from=Date.parse(policy.confirmedAt);
for(const league of ['epl','ucl'])for(const period of ['FT','HT'])for(const line of ['1+20','1-20','1平','1.5','0-50','1+50'])for(const kind of ['HANDICAP','TOTAL']){
 const make=now=>{
  const at=new Date(now).toISOString(),startTime=new Date(now+3600000).toISOString();
  const game={id:`soccer:${league}:123`,league,sourceId:'123',date:soccerDate(startTime),startTime,status:'scheduled',home:{sourceId:'359',name:'Arsenal'},away:{sourceId:'364',name:'Liverpool'}};
  const reader={revision:'b'.repeat(64),observationId:'c'.repeat(64),observedAt:at,firstFetchedAt:at,receivedAt:at,persistedAt:at,sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/'};
  const market={unit:'GOALS',kind,period,line,lineSide:kind==='HANDICAP'?'home':null,homeWater:.9,awayWater:.9,overWater:.9,underWater:.9,rawRows:[line+' 0.9','0.9'],periodEvidence:{status:'EXPLICIT',period,sectionTitle:'足球',tableHeaders:[period==='FT'?'全場':'上半場'],marketHeader:period==='FT'?'全場':'上半場'}};
  const quotes=buildSoccerMarketDirections({game,reader,now,matchedGames:[{officialGameId:game.id,league:league.toUpperCase(),boardDate:game.date,prestart:true,matchStatus:'MATCHED',markets:[market]}]}).flatMap(d=>d.quotes);
  assert.equal(quotes.length,2);
  return {game,quotes};
 };
 for(const delta of [-1,0,1]){
  const now=from+delta,{game,quotes}=make(now);
  for(const q of quotes){
   const record={league,period,kind,line,quoteKey:q.key,sourceQuote:q};
   const contract=soccerVerifiedSettlementContract(record);
   if(delta<0){assert.equal(contract,null);continue;}
   assert.equal(contract.status,'USER_CONFIRMED_ACCOUNT_RULES');
   assert.equal(contract.externalSourceVerified,false);assert.equal(contract.quoteKey,q.key);
   assert.equal(soccerSettlementContractComplete(contract,record),true);
   assert.equal(soccerVerifiedSettlementContract({...record,period:period==='FT'?'HT':'FT'}),null);
   assert.equal(soccerVerifiedSettlementContract({...record,sourceQuote:{...q,provenance:{...q.provenance,sourceHost:'evil.invalid'}}}),null);
   const score=scoreSoccerQuote({quote:q,game,now,distribution:{league,gameId:game.id,period:period==='FT'?'REGULATION_FT':'REGULATION_HT',modelVersion:'TEST_ONLY',trainingHash:'d'.repeat(64),retainedMass:1,tailMass:0,cells:[{home:1,away:0,probability:1}]}});
   assert.equal(score.stages.find(s=>s.stage==='SETTLEMENT_CONTRACT').status,'REGISTERED');
   assert.equal(score.conditionalPayoff.ok,true);assert.equal(score.S,null);assert.equal(score.formalScoringEnabled,false);
   const explicit={...contract,version:'SYNTHETIC_REPLAY_ONLY',evidenceRef:'synthetic://explicit-replay'};
   const replay=scoreSoccerQuote({quote:q,game,now,distribution:{league,gameId:game.id,period:period==='FT'?'REGULATION_FT':'REGULATION_HT',modelVersion:'TEST_ONLY',trainingHash:'d'.repeat(64),retainedMass:1,tailMass:0,cells:[{home:1,away:0,probability:1}]},contract:explicit});
   assert.equal(replay.conditionalPayoff.contract.version,'SYNTHETIC_REPLAY_ONLY');
   assert.equal(replay.stages.find(s=>s.stage==='SETTLEMENT_CONTRACT').status,'CONDITIONAL_ONLY');
   assert.equal(replay.S,null,'explicit replay cannot borrow registry approval');
   if(kind==='HANDICAP'&&q.side==='home'){
    const expected={'1+20':.182,'1-20':-.198,'1平':0}[line];
    if(expected!==undefined)assert.ok(Math.abs(score.conditionalPayoff.netEV-expected)<1e-12);
   }
   assert.notEqual(scoreSoccerQuote({quote:{...q,water:1.2},game,now}).stages.find(s=>s.stage==='SETTLEMENT_CONTRACT').status,'REGISTERED');
  }
 }
 const current=soccerSystemScoringReadiness(league,from);
 assert.equal(current.blockers.some(b=>b.code==='SETTLEMENT_CONTRACT'),false);
 assert.equal(current.status,'BLOCKED');
 assert.equal(soccerSystemScoringReadiness(league,from-1).blockers.some(b=>b.code==='SETTLEMENT_CONTRACT'),true);
}
assert.deepEqual(soccerSettlementMissingTerms(from).map(x=>x.code),['CANCELLATION_POSTPONEMENT_ABANDONMENT_AND_CORRECTION_TERMS']);
console.log('PASS account-owner confirmation: both leagues, periods, sides, fractional payoff and rebate, forward-only applicability, original quote binding, wrong scope/source/changed-price rejection, no invented model or historical approval');
