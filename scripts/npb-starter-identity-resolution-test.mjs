import assert from 'node:assert/strict';
import { buildAsianProductionFeatureSnapshot, resolveNpbStarterPlayerId } from '../lib/asian-production-features-v1.js';

const game = { gamePk: 'npb-id-resolution', providerGameId: 's2099092400001', officialDate: '2099-09-24',
  gameDate: '2099-09-24T10:00:00Z', awayCode: 'ORI', homeCode: 'LOM', awayTeamId: 708, homeTeamId: 709,
  awayProbable: '九里', homeProbable: 'ルケーシー', awayProbableId: null, homeProbableId: null,
  probableSource: 'NPB_OFFICIAL_SCHEDULE_DETAIL_STARTER' };
const rows = entries => `<table><tr><th>選手</th><th>登板</th><th>打者</th><th>投球回</th><th>安打</th><th>四球</th><th>三振</th><th>自責点</th><th>防御率</th></tr>${entries.map(([name,id]) =>
  `<tr><td>${id ? `<a href="/bis/players/${id}.html">${name}</a>` : name}</td><td>10</td><td>220</td><td>50</td><td>40</td><td>10</td><td>40</td><td>20</td><td>3.60</td></tr>`).join('')}</table>`;
const awayStats = `<title>2099年度 オリックス・バファローズ 個人投手成績（パシフィック・リーグ） | NPB.jp 日本野球機構</title>${rows([['九里 亜蓮', null]])}`;
const homeStats = `<title>2099年度 千葉ロッテマリーンズ 個人投手成績（パシフィック・リーグ） | NPB.jp 日本野球機構</title>${rows([['ルケーシー','12345678']])}`;
const rosterRow = (id,name) => `<tr class="rosterPlayer"><td class="rosterRegister"><a href="/bis/players/${id}.html">${name}</a></td></tr>`;
const awayRoster = `<title>オリックス・バファローズ 2099年度 選手一覧 | NPB.jp 日本野球機構</title><table>${rosterRow('71775139','九里　亜蓮')}</table>`;
const statsEvent = { id: 'stats-event', success: true, contentHash: 'stats-hash', fetchedAt: '2099-09-24T08:00:00Z', url: 'https://npb.jp/bis/2099/stats/idp1_b.html' };
const rosterEvent = { ...statsEvent, id: 'roster-event', contentHash: 'roster-hash', url: 'https://npb.jp/bis/teams/rst_b.html' };
const args = { game, side: 'away', identity: { id: null, name: game.awayProbable, source: game.probableSource },
  statsHtml: awayStats, statsEvent, rosterHtml: awayRoster, rosterEvent };
const resolved = resolveNpbStarterPlayerId(args);
assert.equal(resolved.id, '71775139');
assert.equal(resolved.name, '九里', '公告原名及來源不被身分補全覆蓋');
assert.equal(resolved.source, game.probableSource);
assert.equal(resolved.identityResolutionEvidence.sourceEventId, 'roster-event');
assert.equal(resolved.identityResolutionEvidence.statsSourceEventId, 'stats-event');
assert.equal(resolved.identityResolutionEvidence.publishedAt, null);
assert.equal(resolveNpbStarterPlayerId({ ...args, rosterHtml: '' }), null, '缺正式連結不得生成玩家ID');
assert.equal(resolveNpbStarterPlayerId({ ...args, identity: { ...args.identity, id: 'conflicting-id' } }), null, '不得覆蓋已有官方ID');
assert.equal(resolveNpbStarterPlayerId({ ...args, statsHtml: awayStats.replace('2099年度', '2098年度') }), null);
assert.equal(resolveNpbStarterPlayerId({ ...args, statsHtml: awayStats.replace('オリックス・バファローズ', '千葉ロッテマリーンズ') }), null);
assert.equal(resolveNpbStarterPlayerId({ ...args, statsEvent: { ...statsEvent, url: statsEvent.url.replace('idp1_b', 'idp1_m') } }), null);
assert.equal(resolveNpbStarterPlayerId({ ...args, rosterHtml: awayRoster.replace('2099年度', '2098年度') }), null);
assert.equal(resolveNpbStarterPlayerId({ ...args, rosterHtml: awayRoster.replace('オリックス・バファローズ', '千葉ロッテマリーンズ') }), null);
assert.equal(resolveNpbStarterPlayerId({ ...args, rosterHtml: awayRoster.replace('</table>', `${rosterRow('different','九里 亜蓮')}</table>`) }), null);
assert.equal(resolveNpbStarterPlayerId({ ...args, rosterHtml: awayRoster.replace('九里　亜蓮', '九里 別人') }), null);
assert.equal(resolveNpbStarterPlayerId({ ...args, statsHtml: awayStats.replace('</table>', rows([['九里 別人',null]])+'</table>') }), null, '姓氏有多位正式候選時不可選第一人');
const linked = resolveNpbStarterPlayerId({ ...args, statsHtml: awayStats.replace('九里 亜蓮</td>', '<a href="/bis/players/71775139.html">九里 亜蓮</a></td>'), rosterHtml: null });
assert.equal(linked.id, '71775139');
assert.equal(linked.identityResolutionEvidence.sourceEventId, 'stats-event');

const requested = [];
const result = await buildAsianProductionFeatureSnapshot({ leagueId: 'NPB', game, history: [],
  fetchImpl: async url => { requested.push(url); return { ok: true, status: 200, text: async () =>
    url.endsWith('/idp1_b.html') ? awayStats : url.endsWith('/idp1_m.html') ? homeStats
      : url.endsWith('/rst_b.html') ? awayRoster : '' }; },
});
assert.equal(result.featureSnapshot.away.starter.id, '71775139');
assert.equal(result.featureSnapshot.home.starter.id, '12345678');
assert.equal(result.gamePatch.awayProbableId, '71775139');
assert.equal(result.gamePatch.homeProbableId, '12345678');
assert.equal(result.game.awayProbableId, '71775139');
assert.equal(result.featureSnapshot.away.starter.identitySource, game.probableSource);
assert.equal(result.featureSnapshot.away.starter.identityResolutionEvidence.fullName, '九里 亜蓮');
assert.equal(requested.filter(url => url.includes('/rst_')).length, 1, '僅缺失ID一側讀官方名冊');
assert.ok(result.featureSnapshot.sourceEvidence.events.some(row => row.id === result.featureSnapshot.away.starter.identityResolutionEvidence.sourceEventId));
console.log('NPB unique same-team same-season starter ID completion, roster fallback, ambiguity and source counterexamples PASS');
