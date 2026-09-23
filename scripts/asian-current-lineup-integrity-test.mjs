import assert from 'node:assert/strict';
import {
  buildAsianProductionFeatureSnapshot, currentPersonnelAcquisitionEligible,
  parseCpblCurrentPersonnel, parseCpblGameDetailPayload, parseNpbCurrentLineups,
  parseNpbGameDetailHtml, projectCpblRotationStarter, starterSnapshot,
} from '../lib/asian-production-features-v1.js';

const event = { id: 'pregame-event', success: true, contentHash: 'sha256-fixture', fetchedAt: '2099-09-23T08:00:00Z' };
const game = { gamePk: 'cpbl-current-lineup', providerGameId: '2099-A-350', officialDate: '2099-09-23',
  gameDate: '2099-09-23T10:35:00Z', awayCode: 'CTB', homeCode: 'FUB', awayTeamId: 701, homeTeamId: 704 };
const side = (teamCode, prefix) => ({ Team: { Code: teamCode }, InningScore: [],
  Hitters: Array.from({ length: 9 }, (_, i) => ({ HitterAcnt: `${prefix}${i}`, HitterName: `${prefix}打者${i}`,
    Lineup: i + 1, PlateAppearances: 0, DefendStation: i === 8 ? 'DH' : 'CF', Avg: .300 })),
  Pitchers: [{ PitcherAcnt: `${prefix}P`, PitcherName: `${prefix}先發`, RoleType: '先發',
    PitchCnt: 0, PlateAppearances: 0, InningPitchedCnt: 0, InningPitchedDiv3Cnt: 0 }],
});
const payload = { Data: { Game: { GameId: game.providerGameId, GameStatus: 'SCHEDULED',
  Visiting: side('ACN011', 'A'), Home: side('AEO011', 'H') } } };
const cpbl = parseCpblCurrentPersonnel(payload, game, event);
assert.equal(cpbl.lineups.away.players.length, 9, '公告打線不需要已發生打席');
assert.equal(cpbl.lineups.away.official, true);
assert.equal(cpbl.lineups.away.sourceEvidence.publishedAt, null, '抓取時刻不能假裝官方公布時刻');
assert.equal(cpbl.lineups.away.offensiveIndexIsFallback, true, '零打席AVG不能變成已驗證季打數');
assert.equal(cpbl.starters.away.officialAssignmentConfirmed, true);
assert.equal(parseCpblCurrentPersonnel(payload, game, { ...event, fetchedAt: game.gameDate }), null);
assert.equal(parseCpblCurrentPersonnel(payload, { ...game, statusCode: 'I' }, event), null);
for (const mutate of [
  root => { root.GameId = 'different-game'; },
  root => { root.GameStatus = 'FINISHED'; },
  root => { root.GameStatus = 'START'; },
  root => { root.Home.Team.Code = 'AAA011'; },
  root => { root.Visiting.Hitters[0].PlateAppearances = 1; },
  root => { root.Home.Pitchers[0].PitchCnt = 1; },
]) {
  const changed = structuredClone(payload); mutate(changed.Data.Game);
  assert.equal(parseCpblCurrentPersonnel(changed, game, event), null);
}
for (const mutate of [
  rows => rows.pop(),
  rows => { rows[8].Lineup = 8; },
  rows => { rows[8].HitterAcnt = rows[0].HitterAcnt; },
  rows => { rows[8].DefendStation = '(PH)'; },
  rows => { rows[8].HitterAcnt = ''; },
]) {
  const changed = structuredClone(payload); mutate(changed.Data.Game.Visiting.Hitters);
  assert.ok(!parseCpblCurrentPersonnel(changed, game, event).lineups.away, '不完整/歧義打線不得提升為正式九人');
}
const zeroPaStarter = structuredClone(payload);
zeroPaStarter.Data.Game.Visiting.Hitters.splice(1, 0, { ...zeroPaStarter.Data.Game.Visiting.Hitters[0],
  HitterAcnt: 'SUB', HitterName: '代打', PlateAppearances: 1, DefendStation: '(PH)' });
assert.equal(parseCpblGameDetailPayload(zeroPaStarter).away.lineup[0].id, 'A0', '先發零打席不可被有打席的代打取代');

const npbGame = { ...game, gamePk: 'npb-current-lineup', providerGameId: 's2099092300001',
  awayCode: 'RAK', homeCode: 'NIP' };
const npbUrl = 'https://npb.jp/scores/2099/0923/f-e-23/';
const npbEvent = { ...event, url: npbUrl };
const lineupTable = prefix => `<table>${Array.from({ length: 9 }, (_, i) =>
  `<tr><th>${i + 1}</th><th>${i === 8 ? '投' : '右'}</th><td><a href="/bis/players/${prefix}${i}.html">打者${prefix}${i}</a></td></tr>`).join('')}</table>`;
const npbHtml = `<link rel="canonical" href="${npbUrl}"><div class="line-score"><p class="game_info">【試合開始前】</p></div>
<table id="tablefix_ls"><tbody><tr class="top"><th><span class="flag_e_2099"></span></th><td></td></tr>
<tr class="bottom"><th><span class="flag_f_2099"></span></th><td></td></tr></tbody></table>
<div id="player-order"><div class="half_left">${lineupTable('1')}</div><div class="half_right">${lineupTable('2')}</div></div>`;
const npb = parseNpbCurrentLineups(npbHtml, npbGame, npbEvent);
assert.equal(npb.away.players[8].order, 9);
assert.equal(npb.away.players[8].position, '投', '投手打擊仍是合法第九棒');
assert.equal(npb.home.players[0].officialPlayerId, '20');
assert.equal(parseNpbCurrentLineups(npbHtml, npbGame, { ...npbEvent, fetchedAt: npbGame.gameDate }), null);
for (const changed of [
  npbHtml.replace('試合開始前', '試合終了'), npbHtml.replace('試合開始前', '1回表'),
  npbHtml.replace('flag_e_2099', 'flag_g_2099'), npbHtml.replace('<td></td>', '<td>0</td>'),
  npbHtml.replace('/f-e-23/', '/e-f-23/'),
]) assert.equal(parseNpbCurrentLineups(changed, npbGame, npbEvent), null);
assert.equal(parseNpbCurrentLineups(npbHtml.replace('/players/18.html', '/players/17.html'), npbGame, npbEvent).away, null);

const historicalHtml = `<div id="gmdivtbl"><table><tr><td class="flagteam2"><img src="/bis/images/flag2099_e_1m.gif"></td>
<td class="flagteam2"><img src="/bis/images/flag2099_f_1m.gif"></td></tr></table>
<table class="gmtbltop"><tr><th>AB</th><th>RBI</th></tr>${Array.from({ length: 9 }, (_, i) =>
  `<tr><td class="gmbatter">Starter${i}, ${i === 7 ? 'P' : 'CF'}</td></tr>${i === 0 ? '<tr><td class="gmnxtbatter">Substitute, PH</td></tr>' : ''}`).join('')}</table></div>`;
const historical = parseNpbGameDetailHtml(historicalHtml);
assert.equal(historical.away.teamCode, 'RAK');
assert.equal(historical.home.teamCode, 'NIP');
assert.deepEqual(historical.away.lineup.map(row => row.order), [1,2,3,4,5,6,7,8,9]);
assert.equal(historical.away.lineup[7].name, 'Starter7');
assert.ok(!historical.away.lineup.some(row => row.name === 'Substitute'));

const calls = [];
const feature = (await buildAsianProductionFeatureSnapshot({ leagueId: 'CPBL', game, history: [],
  fetchImpl: async url => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify(url.endsWith(`/games/${game.providerGameId}`) ? payload : { Data: [] }) };
  },
})).featureSnapshot;
assert.equal(feature.away.lineup.assignmentStatus, 'OFFICIAL_CURRENT_GAME_LINEUP');
assert.ok(feature.away.lineup.sourceEvidence.sourceEventId);
assert.ok(feature.sourceEvidence.events.some(row => row.id === feature.away.lineup.sourceEvidence.sourceEventId));
assert.ok(calls.some(url => url.endsWith(`/games/${game.providerGameId}`)));

const npbCalls = [];
const npbFeature = (await buildAsianProductionFeatureSnapshot({ leagueId: 'NPB', game: npbGame, history: [],
  fetchImpl: async url => {
    npbCalls.push(url);
    return { ok: true, status: 200, text: async () => url === npbUrl ? npbHtml
      : url === 'https://npb.jp/scores/2099/0923/' ? `<a href="${npbUrl}">試合速報</a>` : '' };
  },
})).featureSnapshot;
assert.equal(npbFeature.away.lineup.assignmentStatus, 'OFFICIAL_CURRENT_GAME_LINEUP');
assert.equal(npbFeature.home.lineup.players[0].officialPlayerId, '20');
assert.ok(npbCalls.includes(npbUrl), '由官方每日索引發現唯一主客組合並讀取當場');
const cachedNpb = (await buildAsianProductionFeatureSnapshot({ leagueId: 'NPB', game: npbGame, history: [],
  fetchImpl: async () => { throw new Error('cache should retain original receipt'); },
})).featureSnapshot;
assert.equal(cachedNpb.away.lineup.sourceEvidence.fetchedAt, npbFeature.away.lineup.sourceEvidence.fetchedAt);
assert.equal(cachedNpb.away.lineup.sourceEvidence.sourceEventId, npbFeature.away.lineup.sourceEvidence.sourceEventId);

const flippedHistory = { ...npbGame, providerGameId: 's2099092200002', gamePk: 'legacy-inverted-history',
  officialDate: '2099-09-22', gameDate: '2099-09-22T10:35:00Z', awayCode: 'NIP', homeCode: 'RAK',
  awayTeamId: npbGame.homeTeamId, homeTeamId: npbGame.awayTeamId, awayScore: 2, homeScore: 3 };
const noCurrentGame = { ...npbGame, providerGameId: 's2000092300001', officialDate: '2000-09-23', gameDate: '2000-09-23T10:35:00Z' };
const rejectedLegacy = (await buildAsianProductionFeatureSnapshot({ leagueId: 'NPB', game: noCurrentGame,
  history: [{ ...flippedHistory, officialDate: '2000-09-22', gameDate: '2000-09-22T10:35:00Z' }],
  fetchImpl: async url => ({ ok: true, status: 200, text: async () => url.includes('/games/') ? historicalHtml : '' }),
})).featureSnapshot;
assert.equal(rejectedLegacy.away.lineup, null, '舊資料主客顛倒時不得帶入對方歷史打線');
assert.equal(rejectedLegacy.home.lineup, null);

let historicalCurrentRequested = false;
const past = { ...game, providerGameId: '2000-A-350', officialDate: '2000-09-23', gameDate: '2000-09-23T10:35:00Z' };
const pastResult = (await buildAsianProductionFeatureSnapshot({ leagueId: 'CPBL', game: past, history: [],
  fetchImpl: async url => { if (url.endsWith(`/games/${past.providerGameId}`)) historicalCurrentRequested = true;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) }; },
})).featureSnapshot;
assert.equal(historicalCurrentRequested, false, '不抓歷史賽後當作賽前公布資料');
assert.equal(pastResult.away.lineup, null);
assert.equal(currentPersonnelAcquisitionEligible(past, event.fetchedAt), false);

const details = [5,7].map((rest, i) => ({ game: { gamePk: `prior-${i}`, awayTeamId: 701, homeTeamId: 704,
  gameDate: `2099-09-${23-rest}T10:35:00Z` }, detail: { away: { pitchers: [{ id: `P${i}`, name: `投手${i}`,
    starter: true, inningsPitched: 5, battersFaced: 22, earnedRuns: i ? 4 : 1, hits: 5, walks: 1 }] } } }));
const projection = projectCpblRotationStarter(details, 701, game.gameDate);
assert.deepEqual(projection.candidates.map(row => row.era), [1.8,7.2], '候選使用自身能力，不能複製主候選能力');
const starter = starterSnapshot({ leagueId: 'CPBL', game, side: 'away', identity: projection,
  stats: { era: 1.8, inningsPitched: 5, battersFaced: 40, expectedInnings: 5 }, referenceEra: 4 });
assert.equal(starter.identityConfirmed, false);
assert.equal(starter.confirmed, false);
assert.equal(starter.playerIdentityVerified, true);
assert.equal(starter.confidenceCalibrated, false);
assert.equal(starter.candidates.length, 2);
console.log('NPB/CPBL current pregame lineup, identity, zero-PA starters, order, PIT receipts and rotation provenance PASS');
