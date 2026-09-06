import assert from 'node:assert/strict';
import { parseKboResultLinescore } from '../lib/kbo-result-linescore.js';
import { resolveLegacyAsianResultGame } from '../lib/asian-baseball.js';
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
const result = parseKboResultLinescore({ nested: JSON.stringify(table) }, game);
assert.equal(result.innings, 9);
assert.equal(result.awayFirst5, 1);
assert.equal(result.homeFirst5, 2);
assert.equal(result.first5Complete, true);
assert.throws(() => parseKboResultLinescore({table}, {...game, homeScore: 4}));
const missing = structuredClone(table); missing.rows[0].row[2].Text = '';
assert.throws(() => parseKboResultLinescore(missing, game));
const illegalX = structuredClone(table); illegalX.rows[0].row[0].Text = 'X';
assert.throws(() => parseKboResultLinescore(illegalX, game));
const live = {...game, statusCode:'I'};
assert.equal(parseKboResultLinescore({table}, live), live);
const conflict = structuredClone(table);
conflict.rows[0] = row([0,0,0,0,0,0,2,0,0,'-','-','-']);
assert.throws(() => parseKboResultLinescore({table, conflict}, game));
assert.throws(() => parseKboResultLinescore({table:{...table,rows:[...table.rows,table.rows[0]]}}, game));

const options = {expectedAway:'KIA虎',expectedHome:'NC恐龍',expectedProviderGameId:'2026-09-02|KIA|NCD|18:30|창원|1|1'};
const bound = resolveLegacyAsianResultGame('KBO', [game], 123, game.officialDate, options);
assert.equal(bound.gamePk,123);
assert.equal(bound.officialGamePk,game.gamePk);
assert.equal(bound.providerGameId,game.providerGameId);
assert.throws(() => resolveLegacyAsianResultGame('KBO',[game,{...game,gamePk:124,gameNumber:2}],123,game.officialDate,options));
assert.equal(resolveLegacyAsianResultGame('KBO',[game],123,'2026-09-03',{}),null);
assert.throws(() => resolveLegacyAsianResultGame('KBO',[game],123,game.officialDate,{...options,expectedAway:'韓華鷹'}));
assert.equal(resolveLegacyAsianResultGame('KBO',[{...game,league:'NPB',leagueId:'NPB'}],123,game.officialDate,options),null);

const gap = {status:'MANUAL_REVIEW',settlementError:'缺少可驗證的前五局正式賽果',resultSnapshot:{final:true}};
assert.equal(isRetryableResultGap(gap),true);
for (const changed of [{status:'CANCELLED'}, {settlement:{}}, {settlementError:'身分衝突'}, {resultSnapshot:{final:false}}]) {
  assert.equal(isRetryableResultGap({...gap,...changed}),false);
}
console.log('Official result recovery: strict identity, inning completeness, live exclusion and retry classification PASS');
