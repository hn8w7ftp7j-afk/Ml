import assert from 'node:assert/strict';
import { parseKboOfficialTbf, kboTbfAcquisitionEligible } from '../lib/kbo-official-tbf.js';
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
  assert.ok(result.sourceEvidence.events.some(e => e.id === s.battersFacedSourceEvidence.sourceEventId && e.contentHash === s.battersFacedSourceEvidence.contentHash));
}
globalThis.__ASIAN_OFFICIAL_FEATURE_RESPONSE_CACHE_V1__.clear();
const unavailable = await build(game, async (...args) => { if (args[0].includes('Basic.aspx')) throw Error('offline'); return fetchImpl(...args); });
assert.equal(unavailable.away.starter.season.battersFacedEstimated, true);
assert.equal(unavailable.away.starter.season.observedBattersFaced, null);
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
