import assert from 'node:assert/strict';
import { loadSoccerAnalysisBoard } from '../lib/soccer/analysis-board.js';
import { matchSoccerReaderGames, soccerReaderGameHasFreshGoalMarket } from '../lib/soccer/reader.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';

const now=Date.parse('2026-10-20T00:00:00.000Z'),at=new Date(now).toISOString();
const stale=new Date(now-180001).toISOString(),future=new Date(now+1).toISOString();
const game=(date,id)=>({id:`soccer:epl:${id}`,sourceId:id,league:'epl',date,
  startTime:`${date}T13:00:00.000Z`,status:'scheduled',
  home:{sourceId:'367',name:'Tottenham Hotspur'},away:{sourceId:'388',name:'Coventry City'}});
const selected=game('2026-10-20','12345'),hinted=game('2026-10-21','12348');
const market=(period,observedAt)=>({kind:'TOTAL',unit:'GOALS',period,line:'3平',overWater:.9,underWater:.95,
  rawRows:['大3平 0.9','小 0.95'],periodEvidence:{period,status:period==='UNKNOWN'?'UNKNOWN':'EXPLICIT',
    sectionTitle:`英格蘭超級聯賽${period==='FT'?' 全場':period==='HT'?' 上半場':''}`,
    tableHeaders:['時間','主客隊伍','讓球','大小','獨贏'],marketHeader:'大小'},
  serverObservation:{observedAt,firstFetchedAt:observedAt,receivedAt:observedAt,persistedAt:observedAt}});
const capture=(markets,observedAt=stale)=>({league:'EPL',isPeriodAggregate:true,observedAt,
  sourceObservations:markets.map(m=>({period:m.period,observedAt:m.serverObservation?.observedAt})),
  games:[{league:'EPL',boardDate:hinted.date,boardTime:'21:00',
    homeKey:globalThis.Tai888SoccerTeams.key(hinted.home.name),awayKey:globalThis.Tai888SoccerTeams.key(hinted.away.name),markets}]});
const mixed=capture([market('FT',at),market('HT',stale),market('UNKNOWN',stale)]);
const original=JSON.stringify(mixed),matched=matchSoccerReaderGames(mixed,[hinted],now);
assert.equal(matched[0].matchStatus,'MATCHED');assert.equal(matched[0].fresh,true);
assert.equal(JSON.stringify(mixed),original,'freshness checks preserve original source times and periods');
const directions=buildSoccerMarketDirections({matchedGames:matched,reader:mixed,game:hinted,now});
assert.ok(directions.find(d=>d.period==='FT'&&d.direction==='TOTAL_OVER').quotes.every(q=>q.fresh));
assert.ok(directions.find(d=>d.period==='HT'&&d.direction==='TOTAL_OVER').quotes.every(q=>!q.fresh));
assert.equal(directions.find(d=>d.period==='FT'&&d.direction==='TOTAL_OVER').quotes[0].provenance.observedAt,at);
assert.equal(directions.find(d=>d.period==='HT'&&d.direction==='TOTAL_OVER').quotes[0].provenance.observedAt,stale);
async function board(snapshot){return loadSoccerAnalysisBoard('EPL',selected.date,{now,upcoming:true,
  loadSchedule:async(_league,date)=>({ok:true,league:{id:'epl'},games:date===selected.date?[selected]:[hinted]}),
  loadReaderDates:async()=>[hinted.date],loadReader:async(_league,date)=>date===hinted.date?snapshot:null});}
assert.equal((await board(mixed)).date,hinted.date,'prefer fresh original market rather than oldest bundle time');
assert.equal((await board(capture([market('FT',stale),market('HT',at)]))).date,hinted.date);
for(const [label,change]of [
  ['all periods stale',s=>{for(const m of s.games[0].markets)m.serverObservation={observedAt:stale};s.observedAt=at;}],
  ['aggregate receipt missing',s=>{for(const m of s.games[0].markets)delete m.serverObservation;s.observedAt=at;}],
  ['market time missing',s=>{for(const m of s.games[0].markets)m.serverObservation={};s.observedAt=at;}],
  ['future observation',s=>{for(const m of s.games[0].markets)m.serverObservation={observedAt:future};}],
  ['future server receipt',s=>{s.games[0].markets[0].serverObservation.receivedAt=future;}],
  ['future persisted time',s=>{s.games[0].markets[0].serverObservation.persistedAt=future;}],
  ['invalid server receipt',s=>{s.games[0].markets[0].serverObservation.persistedAt='invalid';}],
  ['unconfirmed period',s=>{s.games[0].markets=[market('UNKNOWN',at)];}],
  ['forged period assertion',s=>{s.games[0].markets=[market('UNKNOWN',at)];s.games[0].markets[0].period='FT';}],
  ['excluded corner market',s=>{s.games[0].markets[0].periodEvidence.marketHeader='全場角球大小';}],
  ['closed markets',s=>{s.games[0].markets=[];}],['missing markets',s=>{delete s.games[0].markets;}],
  ['unavailable prices',s=>{for(const m of s.games[0].markets){m.overWater=null;m.underWater=null;}}],
  ['non-goal quote',s=>{for(const m of s.games[0].markets)m.unit='CORNERS';}],
  ['moneyline alone',s=>{s.games[0].markets=[{...market('FT',at),kind:'MONEYLINE'}];}],
]){const snapshot=structuredClone(mixed);change(snapshot);
  assert.equal(soccerReaderGameHasFreshGoalMarket(snapshot.games[0],snapshot,now),false,label);
  assert.equal((await board(snapshot)).date,selected.date,`${label} cannot select hinted slate`);}
for(const [label,change]of [
  ['foreign league',s=>{s.league='UCL';}],
  ['reversed teams',s=>{[s.games[0].homeKey,s.games[0].awayKey]=[s.games[0].awayKey,s.games[0].homeKey];}],
  ['different kickoff',s=>{s.games[0].boardTime='22:00';}],
]){const snapshot=structuredClone(mixed);change(snapshot);assert.equal((await board(snapshot)).date,selected.date,label);}
const direct=capture([market('FT',at)],at);delete direct.isPeriodAggregate;delete direct.games[0].markets[0].serverObservation;
assert.equal(soccerReaderGameHasFreshGoalMarket(direct.games[0],direct,now),true);
direct.observedAt=stale;assert.equal(soccerReaderGameHasFreshGoalMarket(direct.games[0],direct,now),false);
assert.equal(soccerReaderGameHasFreshGoalMarket(mixed.games[0],mixed,NaN),false);
console.log('PASS future Reader board uses independently fresh scoped goal originals; stale sibling periods stay stale, closed/unknown/future/foreign/unreceipted quotes cannot select a board and receipts remain unchanged.');
