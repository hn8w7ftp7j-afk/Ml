import assert from 'node:assert/strict';
import { parseKboOfficialSchedulePayload, reconcileKboDailyIdentity, fetchAsianTaipeiSlate } from '../lib/asian-baseball.js';
import { betMatches } from '../lib/bet-ledger.js';

const date = '2026-09-20';
const cases = [
  ['한화', 'LG', '잠실', 'HH', 'LG', 259674639165559, '韓華鷹受讓1-80', '韓華鷹受讓1-85', '大9-50'],
  ['KIA', 'NC', '창원', 'HT', 'NC', 2368057946762375, 'KIA虎受讓1+95', 'KIA虎受讓1+90', '小11+50'],
  ['삼성', '롯데', '사직', 'SS', 'LT', 385418909288904, '樂天巨人受讓3+35', '樂天巨人受讓3+30', '大11+75'],
];
const monthly = { rows: cases.map(([a,h,v], i) => ({ row: [
  ...(i === 0 ? [{ Text: '09.20(일)', Class: 'day' }] : []),
  { Text: '<b>14:00</b>', Class: 'time' },
  { Text: `<span>${a}</span><em>vs</em><span>${h}</span>`, Class: 'play' },
  { Text: '', Class: 'relay' }, { Text: v }, { Text: '-' },
] })) };
const daily = { game: cases.map(([, , ,a,h]) => ({ LE_ID: 1, SEASON_ID: 2026, G_DT: '20260920',
  G_ID: `20260920${a}${h}0`, HEADER_NO: 0, AWAY_ID: a, HOME_ID: h, G_TM: '14:00' })) };
const fallback = parseKboOfficialSchedulePayload(monthly, date);
const original = structuredClone(fallback);
const resolved = reconcileKboDailyIdentity(fallback, daily, date);
assert.deepEqual(fallback, original, 'resolution must not rewrite saved inputs');
for (const c of cases) {
  const game = resolved.find(g => g.gamePk === c[5]);
  assert.ok(game, 'recover the exact production ledger ID from the official daily feed');
  const before = fallback.find(g => g.away === game.away);
  assert.notEqual(before.gamePk, game.gamePk);
  for (const [market, pick, current] of [['全場讓分',c[6],c[7]], ['全場大小',c[8],c[8]]]) {
    const bet = { league:'KBO',date,gamePk:c[5],market,pick };
    assert.equal(betMatches(bet,date,before.gamePk,{market,pick:current},'KBO'),false);
    assert.equal(betMatches(bet,date,game.gamePk,{market,pick:current},'KBO'),true);
    assert.equal(betMatches(bet,date,game.gamePk,{market,pick:current},'NPB'),false);
  }
}
assert.deepEqual(reconcileKboDailyIdentity(resolved, {}, date), resolved, 'published IDs need no fallback');
const fails = payload => assert.throws(() => reconcileKboDailyIdentity(fallback,payload,date),
  e => e.code === 'KBO_OFFICIAL_IDENTITY_UNAVAILABLE');
fails({});
fails({game:[...daily.game,daily.game[0]]});
for (const patch of [{G_DT:'20260921'},{G_TM:'18:30'},{AWAY_ID:'LG',HOME_ID:'HH'},
  {LE_ID:2},{SEASON_ID:2025},{G_ID:'20260920HHLG2'},{HEADER_NO:1}]) {
  fails({game:[{...daily.game[0],...patch},...daily.game.slice(1)]});
}
// Same teams at the same time with two published IDs is ambiguous, never guessed.
fails({game:[...daily.game,{...daily.game[0],G_ID:'20260920HHLG1',HEADER_NO:1}]});
const requests=[];
const slate=await fetchAsianTaipeiSlate('KBO',date,{fetchImpl:async (url,opts)=>{
  requests.push({url:String(url),body:String(opts.body)});
  return {ok:true,status:200,text:async()=>JSON.stringify(String(url).includes('GetKboGameList')?daily:monthly)};
}});
assert.equal(requests.length,2);
assert.match(requests[1].body,/date=20260920/);
assert.deepEqual(slate.map(g=>g.gamePk),resolved.map(g=>g.gamePk));
assert.equal(slate.every(g=>g.identitySourceEvidence.sourceEventIds.length===2),true);
console.log('KBO production six-position reproduction, daily identity recovery, ambiguity and league isolation PASS');
