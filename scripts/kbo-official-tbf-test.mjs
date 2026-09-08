import assert from 'node:assert/strict';
import { parseKboOfficialTbf, parseKboOfficialStarts, kboInningsOuts, kboTbfAcquisitionEligible } from '../lib/kbo-official-tbf.js';
import { buildAsianProductionFeatureSnapshot, starterSnapshot } from '../lib/asian-production-features-v1.js';
import { uncertaintyFor } from '../lib/asian-joint-score-v1.js';

const season = new Date(Date.now() + 9 * 3600000).getUTCFullYear();
const profile = ({ id = '51264', name = '최승용', team = 'OB', year = season, tbf = '461' } = {}) => `
<form id="mainForm" action="./Basic.aspx?playerId=${id}">
<h4 id="h4Team" class="team regular/${year}/emblem_${team}"></h4>
<span id="cph_playerProfile_lblName">${name}</span>
<div class="player_records"><h6>${year} 성적</h6><table>
<thead><tr><th>팀명</th><th>ERA</th><th>G</th><th>TBF</th><th>NP</th><th>IP</th></tr></thead>
<tbody><tr><td>두산</td><td>5.74</td><td>21</td><td>${tbf}</td><td>1771</td><td>100 1/3</td></tr></tbody></table></div></form>`;
const expected = { playerId: '51264', name: '최승용', teamCode: 'OB', season };
const daily = (opts = {}) => profile(opts).replace('Basic.aspx', 'Daily.aspx').replace('<div class="player_records">',
  `<select id="ddlYear"><option selected value="${season}"></option></select><select id="ddlSeries"><option selected value="0"></option></select><div class="player_records">`)
  .replace(/<table>[\s\S]*?<\/table>/, `<table><thead><tr><th>4월</th><th>상대</th><th>구분</th><th>TBF</th><th>IP</th></tr></thead><tbody>${Array.from({ length: 21 }, (_, i) => `<tr><td>04.${String(i + 1).padStart(2, '0')}</td><td>상대팀</td><td>${i < 10 ? '선발' : '구원'}</td><td>${i < 20 ? 20 : Number(opts.tbf || 461) - 400}</td><td>${i < 20 ? '4 2/3' : '7'}</td></tr>`).join('')}</tbody></table>`);
assert.equal(kboInningsOuts('100 1/3'), 301);
assert.equal(kboInningsOuts('2/3'), 2);
assert.equal(kboInningsOuts('0'), 0);
for (const invalid of ['', '4.2', '4 3/3', '-1', '1/2']) assert.equal(kboInningsOuts(invalid), null);
const totals = parseKboOfficialTbf(profile(), expected);
assert.equal(totals.inningsPitched, 100 + 1 / 3);
assert.equal(totals.appearances, 21);
assert.equal(parseKboOfficialStarts(daily(), expected, totals, `${season}-09-08`).gamesStarted, 10);
for (const html of [daily({ year: season - 1 }), daily({ id: '999' }), daily().replace('value="0"', 'value="1"'), daily().replace('구원', 'unknown'), daily().replace('04.02', '04.01'), daily().replace('<td>20</td>', '<td>21</td>')]) {
  assert.equal(parseKboOfficialStarts(html, expected, totals, `${season}-09-08`), null);
}
assert.equal(parseKboOfficialStarts(daily(), expected, totals, `${season}-04-21`), null);
assert.equal(parseKboOfficialStarts(daily(), expected, { ...totals, appearances: 22 }, `${season}-09-08`), null);
assert.equal(parseKboOfficialTbf(profile(), expected).battersFaced, 461);
assert.equal(parseKboOfficialTbf(profile({ tbf: '0' }), expected).battersFaced, 0);
for (const input of [{ id: '999' }, { name: '동명이인' }, { team: 'HH' }, { year: season - 1 }, { tbf: '' }, { tbf: '-1' }, { tbf: '461.2' }, { tbf: '4,61' }]) {
  assert.equal(parseKboOfficialTbf(profile(input), expected), null);
}
assert.equal(parseKboOfficialTbf(profile().replace('TBF', 'BF'), expected), null);
assert.equal(parseKboOfficialTbf(profile().replace('</tbody>', '<tr><td>합계</td></tr></tbody>'), expected), null);
assert.equal(parseKboOfficialTbf(profile().replace('성적', '최근 10경기'), expected), null);
assert.equal(parseKboOfficialTbf(profile().replace('./Basic.aspx', '/Futures/Player/PitcherDetail.aspx'), expected), null);

const now = new Date().toISOString();
const game = { leagueId: 'KBO', officialDate: `${season}-09-08`, gamePk: 123,
  gameDate: new Date(Date.now() + 3600000).toISOString(), providerGameId: 'fixture', awayCode: 'DOO', homeCode: 'HAN', awayTeamId: 604, homeTeamId: 608 };
assert.equal(kboTbfAcquisitionEligible(game, now), true);
assert.equal(kboTbfAcquisitionEligible(game, game.gameDate), false);
assert.equal(kboTbfAcquisitionEligible({ ...game, officialDate: `${season - 1}-09-08` }, now), false);
let profileCalls = 0;
const fetchImpl = async url => {
  let value;
  if (url.includes('Daily.aspx')) return { ok: true, status: 200, text: async () => url.includes('51264') ? daily() : daily({ id: '76715', name: '류현진', team: 'HH', tbf: '503' }) };
  if (url.includes('Basic.aspx')) {
    profileCalls++;
    return { ok: true, status: 200, text: async () => url.includes('51264') ? profile() : profile({ id: '76715', name: '류현진', team: 'HH', tbf: '503' }) };
  }
  if (url.endsWith('GetKboGameList')) value = { game: [{ G_ID: 'fixture', AWAY_ID: 'OB', HOME_ID: 'HH', T_PIT_P_ID: '51264', B_PIT_P_ID: '76715', T_PIT_P_NM: '최승용', B_PIT_P_NM: '류현진', SEASON_ID: season }] };
  else if (url.endsWith('GetPitcherRecordAnalysis')) value = { rows: ['최승용', '류현진'].map(name => ({ row: [`<span class="name">${name}</span><span class="style">좌투</span>`, '4', '1', '20', '5', '', '1.2'].map(Text => ({ Text })) })) };
  else if (url.endsWith('GetTodayGames')) value = {};
  else throw Error(`Unexpected fixture request: ${url}`);
  return { ok: true, status: 200, text: async () => JSON.stringify(value) };
};
globalThis.__ASIAN_OFFICIAL_FEATURE_RESPONSE_CACHE_V1__.clear();
const build = async (g = game, fetcher = fetchImpl) => (await buildAsianProductionFeatureSnapshot({ leagueId: 'KBO', game: g, history: [], fetchImpl: fetcher })).featureSnapshot;
const result = await build();
assert.equal(profileCalls, 2);
for (const [side, count] of [['away', 461], ['home', 503]]) {
  const s = result[side].starter.season;
  assert.equal(s.battersFaced, count);
  assert.equal(s.observedBattersFaced, count);
  assert.equal(s.battersFacedEstimated, false);
  assert.equal(s.battersFacedAcquisitionStatus, 'OFFICIAL_TBF_PARSED');
  assert.equal(s.inningsPitched, 100 + 1 / 3);
  assert.equal(s.inningsPitchedEstimated, false);
  assert.equal(s.appearances, 21);
  assert.equal(s.gamesStarted, 10, '21 appearances must not be mislabeled 21 starts');
  assert.equal(s.gamesStartedAcquisitionStatus, 'OFFICIAL_DAILY_RECONCILED_WITH_SEASON');
  assert.ok(result.sourceEvidence.events.some(e => e.id === s.gamesStartedSourceEvidence.sourceEventId));
  assert.ok(result.sourceEvidence.events.some(e => e.id === s.battersFacedSourceEvidence.sourceEventId && e.contentHash === s.battersFacedSourceEvidence.contentHash));
}
globalThis.__ASIAN_OFFICIAL_FEATURE_RESPONSE_CACHE_V1__.clear();
const unavailable = await build(game, async (...args) => { if (args[0].includes('Basic.aspx')) throw Error('offline'); return fetchImpl(...args); });
assert.equal(unavailable.away.starter.season.battersFacedEstimated, true);
assert.equal(unavailable.away.starter.season.observedBattersFaced, null);
assert.equal(unavailable.away.starter.season.gamesStarted, null);
globalThis.__ASIAN_OFFICIAL_FEATURE_RESPONSE_CACHE_V1__.clear();
const noDaily = await build(game, async (...args) => { if (args[0].includes('Daily.aspx')) throw Error('offline'); return fetchImpl(...args); });
assert.equal(noDaily.away.starter.season.battersFaced, 461);
assert.equal(noDaily.away.starter.season.inningsPitchedEstimated, false);
assert.equal(noDaily.away.starter.season.gamesStarted, null, 'failed daily read must not discard verified IP or invent starts');
profileCalls = 0;
await build({ ...game, gameDate: new Date(Date.now() - 3600000).toISOString() });
assert.equal(profileCalls, 0, 'historical input must not fetch live cumulative TBF');
globalThis.__ASIAN_OFFICIAL_FEATURE_RESPONSE_CACHE_V1__.clear();

const args = { leagueId: 'KBO', game, side: 'away', identity: { id: '51264', name: '최승용', source: 'OFFICIAL' }, referenceEra: 4, stats: { era: 5.74, whip: 1.55, inningsPitched: 88.2, expectedInnings: 4.2 } };
const before = starterSnapshot(args);
const after = starterSnapshot({ ...args, stats: { ...args.stats, battersFaced: 461 } });
assert.ok(after.qualityFactor > before.qualityFactor, 'larger measured sample strengthens this worse-than-baseline observation without tuning weights');
const team = starter => ({ starter, lineup: { official: true }, bullpen: { sampleInnings: 0 } });
assert.ok(uncertaintyFor(team(after)) < uncertaintyFor(team(before)));
console.log('KBO official TBF identity/year/parser, live pipeline receipts, failure fallback and no historical backfill PASS');
