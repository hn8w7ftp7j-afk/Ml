import assert from 'node:assert/strict';
import {
  baseballInnings,
  extractAsianStarterEvidence,
  parseCpblGameDetailPayload,
  parseKboBoxScorePayload,
  parseKboGameListPayload,
  parseKboStarterAnalysisPayload,
  matchNpbStarterStats,
  parseNpbGameDetailHtml,
  parseNpbPitchingStatsHtml,
} from '../lib/asian-production-features-v1.js';
import { parseNpbProbableStartersHtml } from '../lib/asian-baseball.js';
import { extraInningsKernelV13 } from '../lib/joint-score-v13.js';

assert.equal(baseballInnings('5', '.2'), 5 + 2 / 3);
assert.equal(baseballInnings('4.1'), 4 + 1 / 3);

const npbPitching = parseNpbPitchingStatsHtml(`
<table class="tablefix2"><thead><tr><th>選手</th><th>登板</th><th>セーブ</th><th>ホールド</th><th>打者</th><th>投球回</th><th>安打</th><th>四球</th><th>三振</th><th>自責点</th><th>防御率</th></tr></thead><tbody>
<tr><td class="left-hand"><sup>*</sup>測試 左投</td><td>20</td><td>0</td><td>0</td><td>420</td><td><span class="integer">101</span><span class="fraction">.2</span></td><td>84</td><td>25</td><td>95</td><td>32</td><td>2.83</td></tr>
</tbody></table>`);
assert.equal(npbPitching.length, 1);
assert.equal(npbPitching[0].throws, 'L');
assert.equal(npbPitching[0].inningsPitched, 101 + 2 / 3);
assert.ok(Math.abs(npbPitching[0].whip - 109 / (101 + 2 / 3)) < 1e-12);

const npbProbables = parseNpbProbableStartersHtml(`
<h4>8月28日の予告先発投手</h4>
<section class="starting_wrap_cl"><div class="unit cl_1">
  <div class="team_left"><img src="/img/common/logo/2026/logo_t_m.gif"><a href="/bis/players/13315153.html">村上　頌樹</a></div>
  <div class="team_right"><img src="/img/common/logo/2026/logo_g_m.gif"><a href="/bis/players/23725150.html">Ｓ．ハワード</a></div>
  <div class="info">（甲子園）18:00</div>
</div></section>
<section class="starting_wrap_pl"><div class="unit pl_1">
  <div class="team_left"><img src="/img/common/logo/2026/logo_b_m.gif"><a href="/bis/players/43545159.html">Ａ．エスピノーザ</a></div>
  <div class="team_right"><img src="/img/common/logo/2026/logo_h_m.gif"><a href="/bis/players/13115159.html">前田　悠伍</a></div>
  <div class="info">（京セラD大阪）18:00</div>
</div></section>`, '2026-08-28');
assert.deepEqual(npbProbables.map(row => [row.awayCode, row.homeCode]), [['YOM', 'HAN'], ['SOF', 'ORI']]);
assert.deepEqual(npbProbables[1].away, { name: '前田 悠伍', id: '13115159', source: 'NPB_OFFICIAL_PROBABLE_STARTER' });

const npbOfficialShape = parseNpbPitchingStatsHtml(`
<table><tbody>
<tr><th>選手</th><th>登板</th><th>勝利</th><th>敗北</th><th>セーブ</th><th>ホールド</th><th>打者</th><th>投球回</th><th>安打</th><th>四球</th><th>三振</th><th>自責点</th><th>防御率</th></tr>
<tr><td>ハワード</td><td>6</td><td>3</td><td>0</td><td>0</td><td>0</td><td>137</td><td><span class="integer">34</span><span class="decimal">.1</span></td><td>26</td><td>10</td><td>40</td><td>5</td><td>1.31</td></tr>
<tr><td><sup>*</sup><a href="/bis/players/99990001.html">公式 左投</a></td><td>20</td><td>8</td><td>4</td><td>0</td><td>1</td><td>420</td><td><span class="integer">101</span><span class="decimal">.2</span></td><td>84</td><td>25</td><td>95</td><td>32</td><td>2.83</td></tr>
</tbody></table>`);
assert.equal(npbOfficialShape.length, 2, 'NPB投手表不得依賴table class或thead');
assert.equal(npbOfficialShape[0].inningsPitched, 34 + 1 / 3, 'NPB正式decimal局數不得截成整數');
assert.ok(Math.abs(npbOfficialShape[0].whip - 36 / (34 + 1 / 3)) < 1e-12);
assert.equal(npbOfficialShape[1].id, '99990001');
assert.equal(npbOfficialShape[1].throws, 'L', 'NPB姓名前星號代表左投');
assert.equal(matchNpbStarterStats(npbOfficialShape, { name: 'Ｓ．ハワード', id: '23725150' })?.name, 'ハワード');
assert.equal(matchNpbStarterStats(npbOfficialShape, { name: '公告姓名格式不同', id: '99990001' })?.name, '公式 左投', '官方player id必須優先於姓名');

const npbDetail = parseNpbGameDetailHtml(`
<div id="gmdivinfo"><table><tr><td>Tokyo Dome</td></tr></table></div>
<div id="gmdivtbl">
<table class="gmtbltop"><tr class="gmstats"><th></th><th>AB</th><th>H</th><th>RBI</th></tr><tr class="gmstats"><td class="gmbatter">Away One, SS</td><td>4</td><td>1</td><td>0</td></tr></table>
<table class="gmtbltop"><tr class="gmstats"><th></th><th>AB</th><th>H</th><th>RBI</th></tr><tr class="gmstats"><td class="gmbatter">Home One, CF</td><td>4</td><td>2</td><td>1</td></tr></table>
<table class="gmtbltop"><tr class="gmstats"><th></th><th>IP</th><th></th><th>BF</th></tr><tr class="gmstats"><td class="gmpitcher">Away Starter</td><td>6</td><td></td><td>23</td><td>5</td><td>1</td><td>0</td><td>6</td><td>2</td></tr><tr class="gmstats"><td class="gmpitcher">Away Relief</td><td>1</td><td></td><td>4</td><td>1</td><td>0</td><td>0</td><td>1</td><td>0</td></tr></table>
<table class="gmtbltop"><tr class="gmstats"><th></th><th>IP</th><th></th><th>BF</th></tr><tr class="gmstats"><td class="gmpitcher">Home Starter</td><td>7</td><td></td><td>26</td><td>4</td><td>2</td><td>0</td><td>7</td><td>1</td></tr></table>
</div>`);
assert.equal(npbDetail.venue, 'Tokyo Dome');
assert.equal(npbDetail.away.pitchers[0].starter, true);
assert.equal(npbDetail.away.pitchers[1].starter, false);
assert.equal(npbDetail.away.lineup[0].name, 'Away One');

const gameListRow = { G_ID: '20990818HTLG0', AWAY_ID: 'HT', HOME_ID: 'LG', T_PIT_P_ID: 1, B_PIT_P_ID: 2 };
assert.equal(parseKboGameListPayload({ game: [gameListRow] }, '', 'KIA', 'LGT'), gameListRow);

const kboStarter = parseKboStarterAnalysisPayload({ rows: [
  { row: [
    { Text: "<span class='name'>左先發</span><span class='style'>좌투좌타</span>" },
    { Text: '3.20' }, { Text: '2.1' }, { Text: '20' }, { Text: '5.4' }, { Text: '12' }, { Text: '1.18' },
  ] },
  { row: [
    { Text: "<span class='name'>右先發</span><span class='style'>우투우타</span>" },
    { Text: '4.10' }, { Text: '1.5' }, { Text: '19' }, { Text: '5.1' }, { Text: '9' }, { Text: '1.32' },
  ] },
] });
assert.deepEqual(kboStarter.map(row => row.throws), ['L', 'R']);
assert.equal(kboStarter[0].expectedInnings, 5.4);

const kboTable = rows => JSON.stringify({ rows: rows.map(values => ({ row: values.map(Text => ({ Text })) })) });
const kboBox = parseKboBoxScorePayload({
  arrHitter: [
    { table1: kboTable([['1', '유', 'Away Batter'], ['2', '우', 'Away Two']]) },
    { table1: kboTable([['1', '중', 'Home Batter']]) },
  ],
  arrPitcher: [
    { table: kboTable([['Away Starter', '선발', '', '', '', '', '5.2', '24', '95', '22', '6', '1', '2', '7', '3', '3'], ['Away Relief', '6.1', '', '', '', '', '1', '4', '15', '4', '1', '0', '0', '1', '0', '0']]) },
    { table: kboTable([['Home Starter', '선발', '', '', '', '', '6', '25', '100', '23', '5', '0', '2', '6', '2', '2']]) },
  ],
});
assert.equal(kboBox.away.pitchers[0].starter, true);
assert.equal(kboBox.away.pitchers[1].starter, false);
assert.equal(kboBox.away.pitchers[0].inningsPitched, 5 + 2 / 3);

const cpbl = parseCpblGameDetailPayload({ Data: { Game: {
  Field: { Abbe: '大巨蛋' },
  Visiting: {
    Team: { Code: 'ACN011' },
    Hitters: [{ Lineup: 1, PlateAppearances: 4, HitterAcnt: 'B1', HitterName: '客隊一棒', DefendStation: 'CF', Avg: 0.300 }],
    Pitchers: [
      { RoleType: '先發', PitcherAcnt: 'P1', PitcherName: '客隊先發', InningPitchedCnt: 5, InningPitchedDiv3Cnt: 2, PlateAppearances: 23, EarnedRunCnt: 2 },
      { RoleType: '中繼', PitcherAcnt: 'P2', PitcherName: '客隊後援', InningPitchedCnt: 1, InningPitchedDiv3Cnt: 1, PlateAppearances: 5, EarnedRunCnt: 0 },
    ],
  },
  Home: { Team: { Code: 'AAA011' }, Hitters: [], Pitchers: [] },
} } });
assert.equal(cpbl.venue, '大巨蛋');
assert.equal(cpbl.away.pitchers[0].starter, true);
assert.equal(cpbl.away.pitchers[1].starter, false);
assert.equal(cpbl.away.pitchers[0].inningsPitched, 5 + 2 / 3);

const evidence = extractAsianStarterEvidence([
  { rawText: '08-27 | 台鋼雄鷹 艾速特[右] | 富邦悍將[主] 陳仕朋[左] | 大8平' },
], { away: '台鋼雄鷹', home: '富邦悍將' });
assert.deepEqual([evidence.away.name, evidence.away.throws, evidence.home.name, evidence.home.throws], ['艾速特', 'R', '陳仕朋', 'L']);
const placeholder = extractAsianStarterEvidence([{ rawText: '中信兄弟 投手[右] | 統一7-ELEVEn獅[主] 投手[右]' }], { away: '中信兄弟', home: '統一7-ELEVEn獅' });
assert.equal(placeholder.away, null);
assert.equal(placeholder.home, null);

const extra = extraInningsKernelV13({
  means: { awayNinth: 0.35, homeNinth: 0.35 },
  gameState: { extraInnings: 3, allowDraw: true },
});
assert.equal(extra.maximumInnings, 3);
assert.equal(extra.allowDrawAtLimit, true);
assert.ok(extra.cells.some(row => row.awayRuns === row.homeRuns && row.probability > 0), '亞洲12局上限必須保留和局機率');
assert.ok(Math.abs(extra.cells.reduce((sum, row) => sum + row.probability, 0) - 1) < 1e-12);

console.log('Asian official PIT parsers, relief-only split, starter evidence validation and draw-cap kernel PASS');
