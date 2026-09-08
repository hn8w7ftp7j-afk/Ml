import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseKboOfficialLineup } from '../lib/kbo-official-lineup.js';
import { parseKboBoxScorePayload, bullpenSnapshot, buildAsianProductionFeatureSnapshot } from '../lib/asian-production-features-v1.js';

const year = new Date(Date.now() + 9 * 3600000).getUTCFullYear();
const game = { leagueId: 'KBO', providerGameId: `${year}0908OBHH0`, officialDate: `${year}-09-08`,
  gameDate: new Date(Date.now() + 3600000).toISOString(), gamePk: 123, awayCode: 'DOO', homeCode: 'HAN', awayTeamId: 604, homeTeamId: 608 };
const teams = { away: 'OB', home: 'HH' };
const table = prefix => JSON.stringify({ rows: Array.from({ length: 9 }, (_, i) => ({ row: [String(i + 1), '포수', `${prefix}${i}`, '99'].map(Text => ({ Text })) })) });
const fixture = () => [[{ LINEUP_CK: true }], [{ LE_ID: 1, SR_ID: 0, SEASON_ID: year, G_ID: game.providerGameId, T_ID: 'HH' }],
  [{ LE_ID: 1, SR_ID: 0, SEASON_ID: year, G_ID: game.providerGameId, T_ID: 'OB' }], [table('Home')], [table('Away')]];
const parsed = parseKboOfficialLineup(fixture(), game, teams);
assert.equal(parsed.away.players[0].name, 'Away0');
assert.equal(parsed.home.players[0].name, 'Home0');
assert.equal(parsed.away.official, true);
assert.equal(parsed.away.fullStatsCoverage, false);
assert.equal(parsed.away.offensiveIndex, 1, 'do not silently convert supplied WAR to a model index');
for (const mutate of [p => { p[0][0].LINEUP_CK = false; }, p => { p[0][0].LINEUP_CK = 'true'; },
  p => { p[1][0].G_ID = 'other'; }, p => { p[2][0].T_ID = 'HH'; }, p => { p[1][0].SEASON_ID--; },
  p => { p[1][0].SR_ID = 1; }, p => { p[4][0] = '{bad'; },
  p => { const t = JSON.parse(p[4][0]); t.rows.pop(); p[4][0] = JSON.stringify(t); },
  p => { const t = JSON.parse(p[4][0]); t.rows[1].row[0].Text = '1'; p[4][0] = JSON.stringify(t); }]) {
  const p = fixture(); mutate(p); assert.equal(parseKboOfficialLineup(p, game, teams), null);
}

const headers = ['선수명', '등판', '결과', '승', '패', '세', '이닝', '타자', '투구수', '타수', '피안타', '홈런', '4사구', '삼진', '실점', '자책'];
const pitchRow = (name, role, ip, pc = '12') => ({ row: [name, role, '', '', '', '', ip, '4', pc, '3', '1', '0', '2', '1', '1', '1'].map(Text => ({ Text })) });
const pt = { headers: [{ row: headers.map(Text => ({ Text })) }], rows: [pitchRow('starter', '선발', '5'),
  pitchRow('third', '6.1', '1/3'), pitchRow('twoThirds', '6.2', '2/3'), pitchRow('mixed', '7.1', '2 1/3'),
  pitchRow('zero', '9.1', '0'), pitchRow('unknown', '?', '2'), pitchRow('invalid', '8.1', '-1')] };
const box = parseKboBoxScorePayload({ arrPitcher: [{ table: JSON.stringify(pt) }] });
assert.equal(box.away.pitchers.length, 6);
assert.equal(box.away.pitchers[1].inningsPitched, 1 / 3);
assert.equal(box.away.pitchers[2].inningsPitched, 2 / 3);
assert.equal(box.away.pitchers[3].inningsPitched, 7 / 3);
assert.equal(box.away.pitchers[1].pitchCount, 12);
assert.equal(box.away.pitchers[1].walks, null, '4사구 includes HBP and must not be called walks');
assert.equal(box.away.pitchers[1].walksAndHitByPitch, 2);
const past = { ...game, gamePk: 122, gameDate: new Date(Date.now() - 86400000).toISOString() };
const bp = bullpenSnapshot([{ game: past, detail: box }], 604, 'KBO', 4.3, game.gameDate);
assert.equal(bp.usageAppearances.length, 4, 'unknown role is not relief; zero-out appearance is retained');
assert.ok(Math.abs(bp.sampleInnings - 10 / 3) < 1e-12);
assert.equal(bp.observedPitchCount, 48);
assert.equal(bp.usageCoverage.complete, false);
assert.equal(bp.usageCoverage.pitchCountsAvailable, true);
pt.headers[0].row[8].Text = 'UNKNOWN';
assert.equal(parseKboBoxScorePayload({ arrPitcher: [{ table: JSON.stringify(pt) }] }).away.pitchers[1].pitchCount, null);

let calls = 0, flag = true, missingStarters = false;
const fetchImpl = async url => {
  let value;
  if (url.endsWith('GetKboGameList')) value = { game: [{ G_ID: game.providerGameId, AWAY_ID: 'OB', HOME_ID: 'HH', SEASON_ID: year,
    T_PIT_P_ID: missingStarters ? null : 51264, B_PIT_P_ID: missingStarters ? null : 76715, T_PIT_P_NM: '최승용', B_PIT_P_NM: '류현진', GAME_STATE_SC: '1' }] };
  else if (url.endsWith('GetPitcherRecordAnalysis')) value = { rows: [] };
  else if (url.endsWith('GetTodayGames')) value = {};
  else if (url.endsWith('GetLineUpAnalysis')) { calls++; value = fixture(); value[0][0].LINEUP_CK = flag; }
  else if (url.endsWith('GetBoxScoreScroll')) value = { arrPitcher: [{ table: JSON.stringify(pt) }] };
  else throw Error(`unexpected request ${url}`);
  return { ok: true, status: 200, text: async () => JSON.stringify(value) };
};
const build = async (g, history = []) => {
  globalThis.__ASIAN_OFFICIAL_FEATURE_RESPONSE_CACHE_V1__.clear();
  return (await buildAsianProductionFeatureSnapshot({ leagueId: 'KBO', game: g, history, fetchImpl })).featureSnapshot;
};
const live = await build(game);
assert.equal(live.away.lineup.official, true);
const receipt = live.away.lineup.sourceEvidence;
assert.ok(live.sourceEvidence.events.some(e => e.id === receipt.sourceEventId && e.contentHash === receipt.contentHash));
flag = false;
assert.equal((await build(game)).away.lineup, null);
calls = 0;
await build({ ...game, gameDate: new Date(Date.now() - 1000).toISOString() });
assert.equal(calls, 0, 'do not backfill historical lineup from live endpoint');
flag = true; missingStarters = true;
assert.equal((await build(game)).away.lineup.official, true, 'lineup collection does not depend on starter availability');
pt.headers[0].row[8].Text = '투구수';
const history = [1, 2].map(i => ({ ...past, gamePk: 120 - i, providerGameId: `past${i}`, officialDate: `${year}-09-06`,
  gameDate: new Date(Date.now() - i * 86400000).toISOString(), awayScore: 3, homeScore: 2 }));
const historical = await build(game, history);
assert.equal(historical.away.bullpen.usageAppearances.length, 8);
for (const row of historical.away.bullpen.usageAppearances) {
  const expectedHash = createHash('sha256').update(String(new URLSearchParams({ leId: '1', srId: '0', seasonId: String(year), gameId: row.providerGameId }))).digest('hex');
  assert.equal(row.sourceEvidence.requestBodyHash, expectedHash);
  assert.ok(historical.sourceEvidence.events.some(e => e.id === row.sourceEvidence.sourceEventId && e.requestBodyHash === expectedHash));
}
globalThis.__ASIAN_OFFICIAL_FEATURE_RESPONSE_CACHE_V1__.clear();
console.log('KBO confirmed lineup identity/flag/receipts/time and relief thirds/pitch counts/unknown-role tests PASS');
