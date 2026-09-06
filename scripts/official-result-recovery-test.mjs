import assert from 'node:assert/strict';
import { parseKboResultLinescore } from '../lib/kbo-result-linescore.js';
import { resolveLegacyAsianResultGame, parseNpbScheduleHtml } from '../lib/asian-baseball.js';
import { isRetryableResultGap } from '../lib/bet-settlement-service.js';

const game = { league: 'KBO', leagueId: 'KBO', statusCode: 'F', officialDate: '2026-09-02',
  gamePk: 1105736002729056, providerGameId: '20260902HTNC0', awayCode: 'KIA', homeCode: 'NCD',
  awayScore: 2, homeScore: 3, gameNumber: 1 };
// Table encoding fixture; inning values independently observed in KBO's Review
// page for 20260902HTNC0. This does not claim to be an archived API response.
const row = values => ({ row: values.map(Text => ({ Text: String(Text) })) });
const table = { headers: [row(Array.from({length:12}, (_, i) => i + 1))], rows: [
  row([0,1,0,0,0,0,1,0,0,'-','-','-']), row([0,0,0,2,0,0,0,0,1,'-','-','-']),
] };
const payloadFor = table => ({ code: '100', END_TM: '21:48',
  A_INITIAL_LK: '/2026/initial_HT_s.png', H_INITIAL_LK: '/2026/initial_NC_s.png',
  table2: JSON.stringify(table), table3: JSON.stringify({rows:[row([2,6,1,5]),row([3,5,3,4])]}) });
const result = parseKboResultLinescore(payloadFor(table), game);
assert.equal(result.innings, 9);
assert.equal(result.awayFirst5, 1);
assert.equal(result.homeFirst5, 2);
assert.equal(result.first5Complete, true);
assert.throws(() => parseKboResultLinescore(payloadFor(table), {...game, homeScore: 4}));
const missing = structuredClone(table); missing.rows[0].row[2].Text = '';
assert.throws(() => parseKboResultLinescore(payloadFor(missing), game));
const illegalX = structuredClone(table); illegalX.rows[0].row[0].Text = 'X';
assert.throws(() => parseKboResultLinescore(payloadFor(illegalX), game));
assert.throws(() => parseKboResultLinescore({...payloadFor(table), END_TM:'-'}, game));
const live = {...game, statusCode:'I'};
assert.equal(parseKboResultLinescore(payloadFor(table), live), live);
assert.throws(() => parseKboResultLinescore({...payloadFor(table), A_INITIAL_LK:'/initial_HH_s.png'}, game));
assert.throws(() => parseKboResultLinescore(payloadFor({...table,rows:[...table.rows,table.rows[0]]}), game));

// Official English scoreboard independently shows LG 8–3 Lotte after seven
// innings on 2026-08-29. These are observed inning values in an API-layout
// fixture, not an archived API response and not authorization to settle it.
const shortened = { ...game, officialDate: '2026-08-29', providerGameId: '20260829LGLT0', awayScore: 8, homeScore: 3 };
const shortenedTable = { headers: [row(Array.from({length:12}, (_, i) => i + 1))], rows: [
  row([0,3,0,0,5,0,0,'-','-','-','-','-']),
  row([0,1,1,0,0,1,0,'-','-','-','-','-']),
] };
const shortenedPayload = { ...payloadFor(shortenedTable), A_INITIAL_LK: '/2026/initial_LG_s.png', H_INITIAL_LK: '/2026/initial_LT_s.png',
  table3: JSON.stringify({rows:[row([8,11,1,7]),row([3,5,0,3])]}) };
assert.throws(() => parseKboResultLinescore(shortenedPayload, shortened), /僅完成 7 局.*等待人工確認/,
  'A verified shortened game must explain its rule hold without becoming a normal nine-inning settlement');

const options = {expectedAway:'KIA虎',expectedHome:'NC恐龍',expectedProviderGameId:'2026-09-02|KIA|NCD|18:30|창원|1|1'};
const bound = resolveLegacyAsianResultGame('KBO', [game], 123, game.officialDate, options);
assert.equal(bound.gamePk,123);
assert.equal(bound.officialGamePk,game.gamePk);
assert.equal(bound.providerGameId,game.providerGameId);
assert.throws(() => resolveLegacyAsianResultGame('KBO',[game,{...game,gamePk:124,gameNumber:2}],123,game.officialDate,options));
assert.equal(resolveLegacyAsianResultGame('KBO',[game],123,'2026-09-03',{}),null);
assert.throws(() => resolveLegacyAsianResultGame('KBO',[game],123,game.officialDate,{...options,expectedAway:'韓華鷹'}));
assert.equal(resolveLegacyAsianResultGame('KBO',[{...game,league:'NPB',leagueId:'NPB'}],123,game.officialDate,options),null);

// Regression for the official card's round field: a postponement is a state,
// not a venue or an unstarted game. Scores must remain absent.
for (const state of ['Postponed', 'Canceled', 'Suspended']) {
  const [postponed] = parseNpbScheduleHtml(`<div class="unit"><span class="team_name">Tokyo Yakult Swallows</span><span class="team_name">Chunichi Dragons</span><div class="round">${state}<br>18:00</div></div>`, '2026-09-06');
  assert.equal(postponed.statusCode, 'D');
  assert.notEqual(postponed.venue, state);
  assert.equal(postponed.awayScore, null);
  assert.equal(postponed.homeScore, null);
}

const gap = {status:'MANUAL_REVIEW',settlementError:'缺少可驗證的前五局正式賽果',resultSnapshot:{final:true}};
assert.equal(isRetryableResultGap(gap),true);
for (const changed of [{status:'CANCELLED'}, {settlement:{}}, {settlementError:'身分衝突'}, {resultSnapshot:{final:false}}]) {
  assert.equal(isRetryableResultGap({...gap,...changed}),false);
}
console.log('Official result recovery: strict identity, inning completeness, live exclusion and retry classification PASS');
