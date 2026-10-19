import { soccerLeague,validSoccerDate } from './contracts.js';
export const soccerRecordKey=r=>[r.league,r.date,r.gameId,r.period,r.kind,r.side,r.line,r.lineSide||''].join('|');
const invalid=()=>Object.assign(Error('足球紀錄或原盤識別不正確。'),{status:400});
export function soccerManualRecordFromSnapshot(snapshot,quoteKey){
  const game=snapshot?.evidence?.game;
  if(!game||!soccerLeague(game.league)||!validSoccerDate(game.date)||snapshot.gameId!==game.id||snapshot.league!==game.league||snapshot.date!==game.date
    ||!new RegExp(`^soccer:${game.league}:\\d{1,16}$`).test(game.id)||!Number.isFinite(Date.parse(game.startTime)))throw invalid();
  const q=(snapshot.directions||[]).flatMap(d=>d.quotes||[]).find(q=>q.key===quoteKey);
  if(!q||q.provenance?.gameId!==game.id||q.unit!=='GOALS'||!['FT','HT'].includes(q.period)||!['HANDICAP','TOTAL'].includes(q.kind)
    ||!Number.isFinite(q.water)||q.water<=0||q.water>1000||typeof q.line!=='string'||q.line.length>40
    ||!(q.kind==='TOTAL'?['over','under'].includes(q.side):['home','away'].includes(q.side)&&['home','away'].includes(q.lineSide)))throw invalid();
  return{league:game.league,date:game.date,gameId:game.id,startTime:game.startTime,
    teamIds:['home','away'].every(side=>typeof game[side]?.id==='string'&&new RegExp(`^soccer:${game.league}:team:\\d{1,16}$`).test(game[side].id))?{home:game.home.id,away:game.away.id}:null,
    home:game.home?.name||'主隊',away:game.away?.name||'客隊',period:q.period,kind:q.kind,side:q.side,line:q.line,lineSide:q.lineSide,
    label:q.label,water:q.water,stake:10000,analysisRevision:snapshot.revision,quoteKey:q.key,sourceQuote:q,
    recordType:'SELF_REPORTED',formalEligible:false,calibrationEligible:false,settlementStatus:'UNVERIFIED',rebateRate:0.01,rebateBasis:'TOTAL_PRINCIPAL',executable:false};
}
export function soccerRecordStats(records){
  const active=records.filter(r=>r.status==='OPEN');
  const settled=active.filter(r=>r.settlement?.status==='SETTLED'),decided=settled.filter(r=>r.settlement.outcome!=='PUSH');
  const settledStake=settled.reduce((s,r)=>s+r.stake,0),profit=settled.reduce((s,r)=>s+r.settlement.profit,0);
  return{active:active.length,cancelled:records.filter(r=>r.status==='CANCELLED').length,stake:active.reduce((s,r)=>s+r.stake,0),
    settled:settled.length,pending:active.length-settled.length,settledStake,profit:settled.length?profit:null,roi:settledStake?profit/settledStake:null,
    winRate:decided.length?decided.filter(r=>['FULL_WIN','PARTIAL_WIN'].includes(r.settlement.outcome)).length/decided.length:null,
    winRateBasis:'DECIDED_SETTLED_RECORDS_EXCLUDING_PUSH'};
}
