import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadOfficialNbaEvidence, NBA_OFFICIAL_ESPN_SCORE_CONFLICT } from '../lib/nba/official.js';
import { nbaFinalPlayScore } from '../lib/nba/final-play-score.js';
import { normalizeNbaManualBetRecord } from '../lib/nba/manual-bet-record.js';
import { settleNbaManualBet, nbaManualContractHash } from '../lib/nba/manual-bet-settlement.js';
import { nbaManualRecordStats } from '../lib/nba/manual-bet-stats.js';
import { archiveNbaManualSettlement, listNbaManualBetRecords } from '../lib/nba/manual-bet-store.js';
import { settleOpenNbaManualRecords } from '../lib/nba/manual-bet-settlement-service.js';
const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/nba-official-0022500003.json', import.meta.url)));
const game = JSON.parse(fs.readFileSync(new URL('./fixtures/nba-onoff-401809234.json', import.meta.url))).game;
const now = Date.parse('2026-10-06T20:00:00Z');
const official = await loadOfficialNbaEvidence(game, [], { now: () => now, fetchImpl: async url => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:url.includes('/games?')?raw.schedule:{game:raw.game}}})}</script>`) });
assert.equal(official.status, 'partial'); // no player crosswalk needed for checked scores
const result = {data:{game},sources:[{provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${game.sourceId}`,status:'ready',hash:'a'.repeat(64),fetchedAt:new Date(now).toISOString()}]};
const total = game.away.score + game.home.score;
const base = {alreadyPlaced:true,gameId:game.id,date:game.taipeiDate,startTime:game.startTime,away:game.away.name,home:game.home.name,marketKey:'fullTotal',side:'over',line:`${total}+35.5`,water:.94,stake:10000};
const record = {...normalizeNbaManualBetRecord(base),id:'11111111-1111-4111-8111-111111111111',status:'OPEN'};
const settled = settleNbaManualBet(record,result,official,now);
assert.equal(settled.status,'SETTLED'); assert.equal(settled.result,'PARTIAL_WIN');
assert.equal(settled.fraction,.355); assert.equal(settled.profit,3390.25); assert.equal(settled.rebate,53.25);
assert.equal(settled.contractHash,nbaManualContractHash(record)); assert.equal(settled.calibrationEligible,false);
const settle = patch => settleNbaManualBet({...record,...normalizeNbaManualBetRecord({...base,...patch})},result,official,now);
assert.equal(settle({side:'under'}).profit,-3496.75);
assert.equal(settle({line:`${total}平`}).profit,0);
assert.equal(settle({line:`${total-1}.5`}).profit,9550);
assert.equal(settle({line:`${total+1}.5`}).profit,-9850);
const halfTotal = ['away','home'].reduce((sum,side)=>sum+game[side].periodScores.slice(0,2).reduce((a,p)=>a+p.score,0),0);
assert.equal(settle({marketKey:'firstHalfTotal',line:`${halfTotal}平`}).result,'PUSH');
const margin=game.home.score-game.away.score, giver=margin>=0?'home':'away';
assert.equal(settle({marketKey:'fullRunline',side:giver,lineSide:giver,line:`${Math.abs(margin)}+25`}).profit,2387.5);
assert.equal(settle({marketKey:'fullRunline',side:giver==='home'?'away':'home',lineSide:giver,line:`${Math.abs(margin)}+25`}).profit,-2462.5);
const halfMargin=game.home.periodScores.slice(0,2).reduce((a,p)=>a+p.score,0)-game.away.periodScores.slice(0,2).reduce((a,p)=>a+p.score,0);
const halfGiver=halfMargin>=0?'home':'away';
assert.equal(settle({marketKey:'firstHalfRunline',side:halfGiver,lineSide:halfGiver,line:`${Math.abs(halfMargin)}平`}).result,'PUSH');
for (const mutate of [g=>g.id='nba:espn:game:999',g=>g.taipeiDate='2025-10-24',g=>g.startTime='2025-10-23T01:00:00Z',g=>g.status='live',g=>g.statusText='Forfeit',g=>g.away.periodScores.pop(),g=>g.home.periodScores[0].score++,g=>g.home.id=g.away.id]) {
 const bad=structuredClone(result);mutate(bad.data.game);assert.equal(settleNbaManualBet(record,bad,official,now).status,'PENDING');
}
assert.equal(settleNbaManualBet({...record,status:'CANCELLED'},result,official,now).status,'PENDING');
assert.equal(settleNbaManualBet({...record,startTime:null},result,official,now).status,'PENDING');
assert.equal(settleNbaManualBet(record,{...result,sources:result.sources.map(s=>({...s,status:'stale'}))},official,now).status,'PENDING');
assert.equal(settleNbaManualBet(record,result,{...official,status:'blocked'},now).status,'PENDING');
assert.equal(settleNbaManualBet(record,result,official,now+16*60000).status,'PENDING');
// Overtime changes full-game settlement, never the first-half quantity.
const ot=structuredClone(result);for(const side of ['away','home']){ot.data.game[side].periodScores.push({period:5,score:5});ot.data.game[side].score+=5;}
const otRaw=structuredClone(raw.game);for(const side of ['away','home']){otRaw[`${side}Team`].periods.push({period:5,score:5});otRaw[`${side}Team`].score+=5;}
const otOfficial=await loadOfficialNbaEvidence(ot.data.game,[],{now:()=>now,fetchImpl:async url=>new Response(`<script id="__NEXT_DATA__">${JSON.stringify({props:{pageProps:url.includes('/games?')?raw.schedule:{game:otRaw}}})}</script>`)});
assert.equal(settleNbaManualBet(record,ot,otOfficial,now).result,'WIN');
assert.equal(settleNbaManualBet({...record,marketKey:'firstHalfTotal',line:`${halfTotal}平`},ot,otOfficial,now).result,'PUSH');
let writes=0, saved;
const db=async(strings,...values)=>{const sql=strings.join('?');if(sql.includes('INSERT INTO')){if(saved)return[];writes++;saved=JSON.parse(values[1]);return[{payload:saved}];}return saved?[{payload:saved}]:[];};
const original=structuredClone(record);
assert.equal((await archiveNbaManualSettlement(record,settled,{db,prepareSchema:false})).created,true);
assert.equal((await archiveNbaManualSettlement(record,{...settled,settledAt:'changed'},{db,prepareSchema:false})).created,false);
assert.equal(writes,1);assert.deepEqual(record,original);
await assert.rejects(archiveNbaManualSettlement({...record,line:'300平'},settled,{db,prepareSchema:false}),/mismatch/);
const records=await listNbaManualBetRecords(record.date,{db:async()=>[{payload:record,settlement:saved}],prepareSchema:false});
assert.equal(records[0].settlementStatus,'SETTLED');assert.equal(records[0].evidenceStatus,'MANUAL_UNVERIFIED');
const stats=nbaManualRecordStats([...records,{...record,id:'cancelled',status:'CANCELLED',settlement:{...settled,profit:999999}},{...record,id:'pending'}]);
assert.equal(stats.settled,1);assert.equal(stats.pending,1);assert.equal(stats.profit,3390.25);assert.equal(stats.roi,.339025);
let loads=0,officialLoads=0,archives=0;
const summary=await settleOpenNbaManualRecords({now:()=>now,list:async()=>[record,{...record,id:'other',side:'under'}],load:async()=>{loads++;return result;},official:async()=>{officialLoads++;return official;},archive:async(r,s)=>{archives++;return{settlement:s};}});
assert.equal(loads,1);assert.equal(officialLoads,1);assert.equal(archives,2);assert.equal(summary.settled,2);
const future=await settleOpenNbaManualRecords({now:()=>now,list:async()=>[{...record,startTime:new Date(now+60000).toISOString()}],load:async()=>{throw Error('future game must not be fetched');}});
assert.equal(future.pending,1);assert.equal(future.reasons.NOT_STARTED,1);

// Projections from the 2026-11-12 Taipei games. Both ESPN headers carried
// internally consistent, incorrect period and final scores for one team.
const conflictGames = [
  { id: '401909973', officialId: '0022600224', slug: 'orl-vs-uta', start: '02:00', actualStart: '02:11:20', end: '04:31:09',
    away: ['19', 'ORL', 'Orlando Magic', 1610612753], home: ['26', 'UTAH', 'Utah Jazz', 1610612762],
    scores: [[29, 34], [66, 59], [85, 85], [123, 106]], sequence: [179, 364, 568, 733, 734], wrong: ['home', 3, 2] },
  { id: '401909974', officialId: '0022600225', slug: 'gsw-vs-hou', start: '02:30', actualStart: '02:42:48', end: '05:09:28',
    away: ['9', 'GS', 'Golden State Warriors', 1610612744], home: ['10', 'HOU', 'Houston Rockets', 1610612745],
    scores: [[20, 35], [48, 56], [76, 85], [105, 115]], sequence: [176, 347, 550, 727, 728], wrong: ['away', 2, 3] },
];
const conflictNow = Date.parse('2026-11-12T06:00:00.000Z');
for (const sample of conflictGames) {
  const time = hhmmss => `2026-11-12T${hhmmss}.000Z`;
  const startTime = time(`${sample.start}:00`);
  const team = ([id, abbreviation, name]) => ({ id: `nba:espn:team:${id}`, sourceId: id, abbreviation, name });
  const header = { id: `nba:espn:game:${sample.id}`, sourceId: sample.id, league: 'NBA', status: 'final',
    statusText: 'Final', completed: true, startTime, taipeiDate: '2026-11-12', season: { year: 2027 }, seasonType: 'regular',
    away: team(sample.away), home: team(sample.home) };
  const terminalPlay = (index, final = false) => ({ id: `${sample.id}${sample.sequence[final ? 4 : index]}`,
    type: final ? { id: '402', text: 'End Game' } : { id: '412', text: 'End Period' }, period: { number: index + 1 },
    awayScore: sample.scores[index][0], homeScore: sample.scores[index][1], clock: { displayValue: '0.0' }, scoringPlay: false });
  const plays = [...sample.scores.map((_, index) => terminalPlay(index)), terminalPlay(3, true)];
  const playScore = nbaFinalPlayScore(header, plays);
  assert.ok(playScore);
  const [wrongSide, wrongPeriod, difference] = sample.wrong;
  for (const side of ['away', 'home']) Object.assign(header[side], structuredClone(playScore[side]));
  header[wrongSide].score += difference;
  header[wrongSide].periodScores[wrongPeriod - 1].score += difference;

  for (const mutate of [
    rows => rows.splice(1, 1), rows => rows.splice(1, 0, structuredClone(rows[1])), rows => rows.pop(),
    rows => rows.push(structuredClone(rows.at(-1))), rows => { rows[1].type.id = '402'; },
    rows => { rows[1].awayScore = String(rows[1].awayScore); }, rows => { rows[1].awayScore = -1; },
    rows => { rows[1].period.number = 4; }, rows => { rows[1].clock.displayValue = '0.1'; },
    rows => { rows[1].id = '9999999991'; }, rows => { rows.at(-1).homeScore++; },
  ]) {
    const changed = structuredClone(plays); mutate(changed);
    assert.equal(nbaFinalPlayScore(header, changed), null);
  }

  const officialTeam = side => ({ teamId: sample[side][3],
    teamTricode: { UTAH: 'UTA', GS: 'GSW' }[sample[side][1]] || sample[side][1],
    score: playScore[side].score, periods: playScore[side].periodScores, players: [] });
  const box = { gameId: sample.officialId, gameStatus: 3, gameTimeUTC: startTime,
    awayTeamId: sample.away[3], homeTeamId: sample.home[3], awayTeam: officialTeam('away'), homeTeam: officialTeam('home') };
  const card = { leagueId: '00', gameId: sample.officialId, seasonType: 'Regular Season', seasonYear: '2026-27',
    gameStatus: 3, gameTimeUtc: startTime, actualStartTimeUTC: time(sample.actualStart), actualEndTimeUTC: time(sample.end),
    awayTeam: officialTeam('away'), homeTeam: officialTeam('home'), shareUrl: `https://www.nba.com/game/${sample.slug}-${sample.officialId}` };
  const source = { provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${sample.id}`,
    status: 'ready', hash: 'b'.repeat(64), fetchedAt: new Date(conflictNow).toISOString() };
  const ticket = { ...normalizeNbaManualBetRecord({ ...base, gameId: header.id, date: header.taipeiDate,
    away: header.away.name, home: header.home.name, startTime, line: '225.5' }), id: record.id, status: 'OPEN' };
  const readResult = { data: { game: header, settlementPlayScore: playScore }, sources: [source] };
  let writes = [];
  const originalHeader = structuredClone(header);
  async function run(officialCard, bet = ticket, data = readResult) {
    const officialOptions = [];
    writes = [];
    const summary = await settleOpenNbaManualRecords({
      now: () => conflictNow, list: async () => [bet],
      load: async (_, options) => { assert.equal(options.includeSettlementPlayScore, true); return data; },
      official: async (selected, players, options) => {
        officialOptions.push(options);
        const fetchImpl = async url => {
          const pageProps = url.includes('/games?') ? { selectedDate: '2026-11-11',
            gameCardFeed: { modules: [{ cards: [{ cardData: officialCard }] }] } } : { game: box };
          return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps } })}</script>`);
        };
        const result = await loadOfficialNbaEvidence(selected, players, { ...options, fetchImpl, now: () => conflictNow });
        if (officialOptions.length === 1) assert.equal(result.conflictBasis, NBA_OFFICIAL_ESPN_SCORE_CONFLICT);
        return result;
      },
      archive: async (_, settlement) => { writes.push(settlement); return { settlement }; },
    });
    return { summary, officialOptions };
  }

  const resolved = await run(card);
  assert.deepEqual(resolved.officialOptions, [{}, { expectedScheduledStartTime: startTime }]);
  assert.equal(resolved.summary.settled, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].fullScores, { away: playScore.away.score, home: playScore.home.score });
  assert.equal(writes[0].settlementScoreEvidence.espnHeader[wrongSide].score, originalHeader[wrongSide].score);
  assert.equal(writes[0].settlementScoreEvidence.espnFinalPlays.endGamePlayId, plays.at(-1).id);
  assert.deepEqual(header, originalHeader);
  assert.equal(writes[0].startTimeVerification.sourceRefs.length, 2);
  const changedSchedule = structuredClone(card);
  changedSchedule[`${wrongSide}Team`].score++;
  changedSchedule[`${wrongSide}Team`].periods[wrongPeriod - 1].score++;
  assert.equal((await run(changedSchedule)).summary.pending, 1);
  assert.equal(writes.length, 0);
  assert.equal((await run(card, { ...ticket, startTime: null })).summary.pending, 1);
  assert.equal((await run(card, ticket, { ...readResult, data: { game: header } })).summary.pending, 1);
}
console.log('NBA verified manual settlement PASS: real official score crosscheck, four markets, credit decimal tails, OT/half separation, fail-closed source/identity, append-only idempotence, original contract preservation, active-only stats and one fetch per game');
