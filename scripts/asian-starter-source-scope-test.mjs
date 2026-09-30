import assert from 'node:assert/strict';
import { buildAsianProductionFeatureSnapshot } from '../lib/asian-production-features-v1.js';

const npbGame = { gamePk: 'npb-starter-source-scope', providerGameId: 's2099092400001', officialDate: '2099-09-24',
  gameDate: '2099-09-24T10:00:00Z', awayCode: 'ORI', homeCode: 'LOM', awayTeamId: 708, homeTeamId: 709,
  awayProbable: '九里', homeProbable: 'ルケーシー', awayProbableId: '71775139', homeProbableId: '12345678',
  probableSource: 'NPB_OFFICIAL_SCHEDULE_DETAIL_STARTER' };
const table = (name, id) => `<table><tr><th>選手</th><th>登板</th><th>打者</th><th>投球回</th><th>安打</th><th>四球</th><th>三振</th><th>自責点</th><th>防御率</th></tr>
  <tr><td><a href="/bis/players/${id}.html">${name}</a></td><td>10</td><td>220</td><td>50</td><td>40</td><td>10</td><td>40</td><td>20</td><td>3.60</td></tr></table>`;
const awayTitle = '2099年度 オリックス・バファローズ 個人投手成績（パシフィック・リーグ） | NPB.jp 日本野球機構';
const homeHtml = `<title>2099年度 千葉ロッテマリーンズ 個人投手成績（パシフィック・リーグ） | NPB.jp 日本野球機構</title>${table('ルケーシー', '12345678')}`;
async function buildNpb(title, hasId = true) {
  globalThis.__ASIAN_OFFICIAL_FEATURE_RESPONSE_CACHE_V1__.clear();
  return (await buildAsianProductionFeatureSnapshot({ leagueId: 'NPB',
    game: { ...npbGame, awayProbableId: hasId ? npbGame.awayProbableId : null }, history: [],
    fetchImpl: async url => new Response(url.endsWith('/idp1_b.html') ? `<title>${title}</title>${table('九里 亜蓮', '71775139')}`
      : url.endsWith('/idp1_m.html') ? homeHtml : ''),
  })).featureSnapshot;
}
const valid = await buildNpb(awayTitle);
assert.equal(valid.away.starter.performanceAvailable, true);
assert.equal(valid.away.starter.season.era, 3.6);
assert.equal(valid.home.starter.performanceAvailable, true);
for (const hasId of [true, false]) {
  for (const title of [awayTitle.replace('2099年度', '2098年度'),
    awayTitle.replace('オリックス・バファローズ', '千葉ロッテマリーンズ'), '']) {
    const rejected = await buildNpb(title, hasId);
    assert.equal(rejected.away.starter.name, npbGame.awayProbable);
    assert.equal(rejected.away.starter.id, hasId ? npbGame.awayProbableId : null);
    assert.equal(rejected.away.starter.confirmed, true, 'independent official announcement survives rejected ability page');
    assert.equal(rejected.away.starter.performanceAvailable, false);
    assert.equal(rejected.away.starter.qualityFactor, null);
    assert.equal(rejected.away.starter.throws, null);
    assert.equal(rejected.away.starter.performanceMissingReason, 'NPB_STARTER_STATS_SOURCE_SCOPE_UNVERIFIED');
    assert.equal(rejected.away.starter.performanceIdentityEvidence.status, 'REJECTED');
    assert.equal(rejected.home.starter.performanceAvailable, true);
  }
}

const cpblGame = { gamePk: 'cpbl-starter-profile-scope', providerGameId: '2099-A-360', officialDate: '2099-09-24',
  gameDate: '2099-09-24T10:00:00Z', awayCode: 'UNI', homeCode: 'WCD', awayTeamId: 702, homeTeamId: 705, statusCode: 'S' };
const ids = { away: '0000001111', home: '0000002222' };
const scheduled = { Data: { Game: { GameId: cpblGame.providerGameId, GameStatus: 'SCHEDULED', PreExeDate: cpblGame.gameDate,
  Visiting: { Team: { Code: 'ADD011' }, Hitters: [], Pitchers: [{ PitcherAcnt: ids.away, PitcherName: 'Away Official', RoleType: '先發' }] },
  Home: { Team: { Code: 'AAA011' }, Hitters: [], Pitchers: [{ PitcherAcnt: ids.home, PitcherName: 'Home Official', RoleType: '先發' }] },
} } };
async function buildCpbl(profilePatch = {}, missing = false) {
  globalThis.__ASIAN_OFFICIAL_FEATURE_RESPONSE_CACHE_V1__.clear();
  return buildAsianProductionFeatureSnapshot({ leagueId: 'CPBL', game: cpblGame, history: [],
    fetchImpl: async url => {
      let payload = { Data: [] };
      if (url.endsWith(`/games/${cpblGame.providerGameId}`)) payload = scheduled;
      if (url.endsWith(`/players/${ids.away}`) && !missing) payload = { Data: { Player: { Basic: {
        Acnt: ids.away, CHName: 'Away Official', Team: { Code: 'ADD011' }, PitchingHabbit: 'L', IsForeign: '1', ...profilePatch,
      } } } };
      if (url.endsWith(`/players/${ids.home}`)) payload = { Data: { Player: { Basic: {
        Acnt: ids.home, CHName: 'Home Official', Team: { Code: 'AAA011' }, PitchingHabbit: 'R', IsForeign: '0',
      } } } };
      return new Response(JSON.stringify(payload));
    },
  });
}
const validCpbl = await buildCpbl();
assert.equal(validCpbl.featureSnapshot.away.starter.officialThrows, 'L');
assert.equal(validCpbl.gamePatch.awayProbableThrows, 'L');
assert.equal(validCpbl.featureSnapshot.rules.foreignPlayerConstraint.applies, true);
for (const rejected of [await buildCpbl({ Acnt: '0000009999' }), await buildCpbl({ Team: { Code: 'AAA011' } }), await buildCpbl({}, true)]) {
  const starter = rejected.featureSnapshot.away.starter;
  assert.equal(starter.id, ids.away);
  assert.equal(starter.name, 'Away Official');
  assert.equal(starter.confirmed, true);
  assert.equal(starter.officialThrows, null, 'wrong player/team profile cannot set hand');
  assert.equal(rejected.gamePatch.awayProbableThrows, null);
  assert.equal(rejected.gamePatch.probableSource, 'CPBL_OFFICIAL_CURRENT_GAME_STARTER');
  assert.equal(rejected.featureSnapshot.home.starter.officialThrows, 'R');
  assert.equal(rejected.featureSnapshot.rules.foreignPlayerConstraint.status, 'DIAGNOSTIC_ONLY');
  assert.equal(rejected.featureSnapshot.rules.foreignPlayerConstraint.applies, null, 'unverified profile is not proof of domestic status');
}
const domestic = await buildCpbl({ IsForeign: '0' });
assert.equal(domestic.featureSnapshot.rules.foreignPlayerConstraint.status, 'NOT_APPLICABLE');
assert.equal(domestic.featureSnapshot.rules.foreignPlayerConstraint.applies, false);
assert.equal((await buildCpbl({ IsForeign: '' })).featureSnapshot.rules.foreignPlayerConstraint.applies, null);
globalThis.__ASIAN_OFFICIAL_FEATURE_RESPONSE_CACHE_V1__.clear();
console.log('Asian starter source scope: NPB wrong-team/year ability rejection and CPBL wrong-player/team attribute rejection preserve independent official assignments PASS');
