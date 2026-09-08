import assert from 'node:assert/strict';
import { uncertaintyFor } from '../lib/asian-joint-score-v1.js';
import {
  baseballInnings,
  buildAsianProductionFeatureSnapshot,
  bullpenSnapshot,
  detailSide,
  extractAsianStarterEvidence,
  parseCpblGameDetailPayload,
  projectCpblRotationStarter,
  parseKboBoxScorePayload,
  parseKboGameListPayload,
  parseKboStarterAnalysisPayload,
  matchNpbStarterStats,
  matchNpbHitterStats,
  parseNpbBattingStatsHtml,
  parseNpbGameDetailHtml,
  parseNpbPitchingStatsHtml,
  projectedLineup,
  rotationPrediction,
  starterSnapshot,
  validateAsianTeamFeatureOwnership,
} from '../lib/asian-production-features-v1.js';
import { parseNpbProbableStartersHtml, parseNpbScheduleDetailStartersHtml } from '../lib/asian-baseball.js';
import { extraInningsKernelV13 } from '../lib/joint-score-v13.js';

assert.equal(baseballInnings('5', '.2'), 5 + 2 / 3);
assert.equal(baseballInnings('4.1'), 4 + 1 / 3);
for (const missing of [null, undefined, '', '  ', '--']) assert.equal(baseballInnings(missing), null, '缺局數不得變成0');
assert.equal(baseballInnings('0'), 0, '真實零局數必須保留');

const starterArgs = {
  leagueId: 'CPBL', game: { awayTeamId: 701, homeTeamId: 702 }, side: 'away',
  identity: { id: 'real-pitcher', name: '實際投手', source: 'OFFICIAL' }, referenceEra: 4,
  recentStarts: [{ inningsPitched: 5.5 }],
};
const independentAbility = [0.8, 1, 1.3, 1.45].map(qualityFactor => starterSnapshot({
  ...starterArgs, stats: { battersFaced: 500, qualityFactor, woba: qualityFactor * 0.3, leagueWoba: 0.3, performanceMetric: 'WOBA_ALLOWED_RELATIVE_TO_OFFICIAL_PITCHER_SAMPLE' },
}));
const estimatedSample = starterSnapshot({ ...starterArgs, stats: { inningsPitched: 88.2, era: 4, whip: 1.2 } });
assert.equal(estimatedSample.season.observedBattersFaced, null);
assert.ok(Math.abs(estimatedSample.season.effectiveBattersFaced - 374.85) < 1e-10);
assert.equal(estimatedSample.season.sampleSizeEvidence.status, 'ESTIMATED');
assert.equal(estimatedSample.season.sampleSizeEvidence.formula, 'inningsPitched * 4.25');
const reportedSample = starterSnapshot({ ...starterArgs, stats: { battersFaced: 375, era: 4, whip: 1.2 } });
assert.equal(reportedSample.season.observedBattersFaced, 375);
const invalidSample = starterSnapshot({ ...starterArgs, stats: { battersFaced: 374.85, era: 4, whip: 1.2 } });
assert.equal(invalidSample.season.observedBattersFaced, null, 'fractional reported data must never be labelled observed count');
assert.equal(invalidSample.season.sampleSizeEvidence.status, 'INVALID_REPORTED_COUNT');
const teamWithSample = sample => ({ starter: { season: { battersFaced: sample } }, lineup: { official: true }, bullpen: { sampleInnings: 0 } });
const sigmaBefore = uncertaintyFor(teamWithSample(374.85));
const sigmaAfter = uncertaintyFor(teamWithSample(375));
assert.ok(Math.abs((sigmaAfter - sigmaBefore) - (-0.15 / 12000)) < 1e-12);
for (const sample of [0, 12, 30, 374.85, 420, 1000]) {
  assert.ok(uncertaintyFor(teamWithSample(sample + .001)) <= uncertaintyFor(teamWithSample(sample)));
  assert.ok(Math.abs(uncertaintyFor(teamWithSample(sample + .001)) - uncertaintyFor(teamWithSample(sample))) <= .001 / 12000 + 1e-12);
}
assert.equal(new Set(independentAbility.map(row => row.qualityFactor)).size, 4, '四組獨立wOBA能力不能全部被空ERA轉成同一偏強值');
assert.ok(independentAbility.every((row, i) => i === 0 || row.qualityFactor > independentAbility[i - 1].qualityFactor));
assert.ok(independentAbility.every(row => row.season.era === null && row.season.whip === null && row.season.inningsPitched === null));
assert.equal(independentAbility[1].qualityFactor, 1);
assert.equal(starterSnapshot({ ...starterArgs, stats: { battersFaced: 500, era: '', whip: null } }), null, '無能力資料不得變成零ERA明星投手');
const genuineZero = starterSnapshot({ ...starterArgs, stats: { battersFaced: 500, era: 0, whip: 0 } });
assert.equal(genuineZero.season.era, 0);
assert.equal(genuineZero.season.whip, 0);
assert.equal(starterSnapshot({ ...starterArgs, stats: { battersFaced: 500, era: 4, whip: '' } }).performanceMetric, 'ERA');
const blankKbo = parseKboStarterAnalysisPayload({ rows: [{ row: [{ Text: '<span class="name">缺值投手</span>' }, { Text: '' }, { Text: '' }, { Text: '' }, { Text: '' }, { Text: '' }, { Text: '' }] }] });
assert.equal(blankKbo[0].era, null);
assert.equal(blankKbo[0].whip, null);

const hitterTable = parseNpbBattingStatsHtml(`<table><tr><th>Player</th><th>PA</th><th>AB</th><th>H</th><th>AVG</th><th>SLG</th><th>OBP</th></tr>
<tr><td><a href="/bis/eng/players/1001.html">* Measured, Hitter</a></td><td>120</td><td>100</td><td>30</td><td>.300</td><td>.500</td><td>.400</td></tr>
<tr><td>Missing, Stats</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
<tr><td>Zero, Sample</td><td>0</td><td>0</td><td>0</td><td>.000</td><td>.000</td><td>.000</td></tr>
<tr><td>Actual, Zero</td><td>20</td><td>20</td><td>0</td><td>.000</td><td>.000</td><td>.000</td></tr></table>`);
assert.equal(hitterTable[0].officialPlayerId, '1001');
assert.equal(hitterTable[0].ops, 0.9);
assert.equal(hitterTable[1].battingAverage, null);
assert.equal(hitterTable[2].battingAverage, null, '0打數的.000不是有效能力樣本');
assert.equal(hitterTable[3].battingAverage, 0, '真實20打數0安打須保留0');
assert.equal(matchNpbHitterStats(hitterTable, { name: 'Measured' })?.officialPlayerId, '1001');
assert.equal(matchNpbHitterStats([...hitterTable, { name: 'Measured, Another' }], { name: 'Measured' }), null, '同姓打者不能猜測身分');
assert.equal(matchNpbHitterStats(hitterTable, { name: 'Measured', officialPlayerId: 'conflicting-id' }), null);

const cpblRotation = projectCpblRotationStarter([
  {
    game: { gameDate: '2026-08-24T17:05:00+08:00', awayTeamId: 799, homeTeamId: 798 },
    detail: { away: { pitchers: [{ id: 'X1', name: '其他隊客投', starter: true }] }, home: { pitchers: [{ id: 'X2', name: '其他隊主投', starter: true }] } },
  },
  {
    game: { gameDate: '2026-08-24T17:05:00+08:00', awayTeamId: 701, homeTeamId: 702 },
    detail: { away: { pitchers: [{ id: 'P1', name: '輪值甲', starter: true }] }, home: { pitchers: [] } },
  },
  {
    game: { gameDate: '2026-08-22T17:05:00+08:00', awayTeamId: 701, homeTeamId: 703 },
    detail: { away: { pitchers: [{ id: 'P2', name: '輪值乙', starter: true }] }, home: { pitchers: [] } },
  },
  {
    game: { gameDate: '2026-08-28T17:05:00+08:00', awayTeamId: 701, homeTeamId: 704 },
    detail: { away: { pitchers: [{ id: 'R1', name: '昨天先發', starter: true }] }, home: { pitchers: [] } },
  },
], 701, '2026-08-29T17:05:00+08:00');
assert.equal(cpblRotation.id, 'P1', '五天輪值候選應優先於七天前與昨天先發');
assert.equal(cpblRotation.projected, true);
assert.equal(cpblRotation.candidates.some(row => row.id === 'R1'), false, '休息不足的投手不可成為預測先發');
assert.equal(cpblRotation.candidates.some(row => row.id.startsWith('X')), false, '合併對手明細時不得把無關球隊投手串入候選');

const cpblFourDateRotation = projectCpblRotationStarter([{
  game: { gameDate: '2026-08-25T18:35:00+08:00', awayTeamId: 701, homeTeamId: 702 },
  detail: { away: { pitchers: [{ id: 'P3', name: '四日輪值', starter: true, inningsPitched: 6 }] }, home: { pitchers: [] } },
}], 701, '2026-08-29T17:05:00+08:00');
assert.equal(cpblFourDateRotation.id, 'P3', '同屬四個比賽日、僅因開賽時間不同而少於96小時的輪值不可誤刪');

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

const npbScheduleDetail = parseNpbScheduleDetailStartersHtml(`
<table><tbody>
<tr id="date0829"><th>8/29（土）</th><td><div class="team1">阪神</div><div class="team2">巨人</div></td><td><div class="time">18:00</div></td><td><div class="pit">先発：大竹</div><div class="pit">先発：田中将</div></td></tr>
<tr><td><div class="team1">オリックス</div><div class="team2">ソフトバンク</div></td><td><div class="time">18:00</div></td><td><div class="pit">先発：髙島</div><div class="pit">先発：大津</div></td></tr>
<tr id="date0830"><th>8/30（日）</th><td><div class="team1">阪神</div><div class="team2">巨人</div></td><td><div class="pit"></div><div class="pit"></div></td></tr>
</tbody></table>`, '2026-08-29');
assert.deepEqual(npbScheduleDetail.map(row => [row.awayCode, row.homeCode, row.away.name, row.home.name]), [
  ['YOM', 'HAN', '田中将', '大竹'], ['SOF', 'ORI', '大津', '髙島'],
]);
assert.equal(npbScheduleDetail[0].away.source, 'NPB_OFFICIAL_SCHEDULE_DETAIL_STARTER');
assert.equal(matchNpbStarterStats([{ name: '大竹 耕太郎', id: '1' }, { name: '大竹 寛', id: '2' }], { name: '大竹' }), null, '官方簡稱有歧義時必須維持QA BLOCK');
assert.equal(matchNpbStarterStats([{ name: '田中 将大', id: '3' }], { name: '田中将' })?.id, '3', '官方日程簡稱可唯一匹配同隊官方投手表');

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

const makeCpblSide = (teamId, starterId, starterName, date) => ({
  lineup: Array.from({ length: 9 }, (_, index) => ({
    id: `${teamId}-B${index + 1}`, officialPlayerId: `${teamId}-B${index + 1}`,
    name: `${teamId}打者${index + 1}`, order: index + 1, battingAverage: 0.25,
  })),
  pitchers: [
    { id: starterId, officialPlayerId: starterId, name: starterName, starter: true, inningsPitched: 6, earnedRuns: 2, hits: 5, walks: 1, battersFaced: 24 },
    { id: `${teamId}-R-${date}`, officialPlayerId: `${teamId}-R-${date}`, name: `${teamId}後援`, starter: false, inningsPitched: 3, earnedRuns: 1 },
  ],
});
const isolationDetails = [
  { game: { gamePk: 'unrelated', gameDate: '2026-08-27T10:00:00Z', awayTeamId: 900, homeTeamId: 901 }, detail: { away: makeCpblSide(900, 'X1', '他隊先發', '0827'), home: makeCpblSide(901, 'X2', '另隊先發', '0827') } },
  { game: { gamePk: 'own-1', gameDate: '2026-08-24T10:00:00Z', awayTeamId: 701, homeTeamId: 702 }, detail: { away: makeCpblSide(701, 'P1', '本隊先發一', '0824'), home: makeCpblSide(702, 'Q1', '對手先發一', '0824') } },
  { game: { gamePk: 'own-2', gameDate: '2026-08-22T10:00:00Z', awayTeamId: 703, homeTeamId: 701 }, detail: { away: makeCpblSide(703, 'Q2', '對手先發二', '0822'), home: makeCpblSide(701, 'P2', '本隊先發二', '0822') } },
  { game: { gamePk: 'yesterday', gameDate: '2026-08-28T10:00:00Z', awayTeamId: 701, homeTeamId: 704 }, detail: { away: makeCpblSide(701, 'P3', '昨日先發', '0828'), home: makeCpblSide(704, 'Q3', '對手先發三', '0828') } },
];
assert.equal(detailSide(isolationDetails[0].detail, isolationDetails[0].game, 701), null, '未明確命中客隊／主隊必須回傳 null');
const isolatedRotation = rotationPrediction(isolationDetails, 701, '2026-08-29T10:00:00Z', 'CPBL');
assert.deepEqual(isolatedRotation.candidates.map(row => row.id).sort(), ['P1', 'P2'], '不得混入他隊或昨日才先發的投手');
assert.ok(isolatedRotation.candidates.every(row => row.teamId === 701));
const isolatedLineup = projectedLineup(isolationDetails, 701, 'CPBL');
assert.equal(isolatedLineup.asOfGamePk, 'yesterday', '預測打線應按比賽時間選最新一場，不依賴傳入陣列順序');
assert.ok(isolatedLineup.players.every(row => row.teamId === 701 && row.officialPlayerId.startsWith('701-')));
assert.equal(isolatedLineup.statsCoverage, 0, '只有姓名與無樣本分母的AVG不得顯示完整能力');
assert.equal(isolatedLineup.rosterConfirmedToday, false);
assert.equal(isolatedLineup.offensiveIndexIsFallback, true);
const nineHitters = Array.from({ length: 9 }, (_, index) => ({ name: `Hitter${index}`, id: `H${index}` }));
const observedHitting = nineHitters.map((row, index) => ({
  ...row, atBats: index === 0 ? 100 : 10, hits: index === 0 ? 30 : 0,
  battingAverage: index === 0 ? 0.3 : 0, battingStatsScope: 'CURRENT_SEASON',
}));
const measuredLineup = projectedLineup([{ game: { gamePk: 'recent', gameDate: '2026-08-28T10:00:00Z', awayTeamId: 701, homeTeamId: 702 }, detail: { away: { lineup: nineHitters } } }], 701, 'NPB', observedHitting, '2026-08-29T00:00:00Z');
assert.equal(measuredLineup.statsCoverage, 1);
assert.equal(measuredLineup.observedBattingAverage, 30 / 180, '率值須由真實安打及打數合計，不可直接平均不等樣本率值');
assert.equal(measuredLineup.battingStatsObservedAt, '2026-08-29T00:00:00Z');
const isolatedBullpen = bullpenSnapshot(isolationDetails, 701, 'CPBL', 4.3, '2026-08-29T10:00:00Z');
assert.ok(isolatedBullpen.pitcherIds.every(id => id.startsWith('701-')));
assert.equal(bullpenSnapshot([{ game: { awayTeamId: 701, homeTeamId: 702 }, detail: { away: { pitchers: [{ starter: false, inningsPitched: 20, earnedRuns: null }] } } }], 701, 'CPBL', 4.3, '2026-08-29T10:00:00Z'), null, '缺失自責分不能當成0ERA牛棚');
validateAsianTeamFeatureOwnership({
  away: { starter: isolatedRotation, lineup: isolatedLineup, bullpen: isolatedBullpen },
  home: { starter: { teamId: 702, id: 'Q1', candidates: [{ teamId: 702, officialPlayerId: 'Q1' }] }, lineup: { teamId: 702, players: [] }, bullpen: { teamId: 702, pitcherIds: [] } },
}, 701, 702);
assert.throws(() => validateAsianTeamFeatureOwnership({
  away: { starter: { teamId: 701, id: 'DUP', candidates: [{ teamId: 701, officialPlayerId: 'DUP' }] } },
  home: { starter: { teamId: 702, id: 'DUP', candidates: [{ teamId: 702, officialPlayerId: 'DUP' }] } },
}, 701, 702), /ASIAN_CROSS_TEAM_OFFICIAL_PLAYER_ID:DUP/);
assert.throws(() => validateAsianTeamFeatureOwnership({
  away: { lineup: { teamId: 701, players: [{ teamId: 701, officialPlayerId: 'DUP-LINEUP' }] } },
  home: { lineup: { teamId: 702, players: [{ teamId: 702, officialPlayerId: 'DUP-LINEUP' }] } },
}, 701, 702), /ASIAN_CROSS_TEAM_OFFICIAL_PLAYER_ID:DUP-LINEUP/);
assert.throws(() => validateAsianTeamFeatureOwnership({
  away: { bullpen: { teamId: 701, pitcherIds: ['DUP-BULLPEN'] } },
  home: { bullpen: { teamId: 702, pitcherIds: ['DUP-BULLPEN'] } },
}, 701, 702), /ASIAN_CROSS_TEAM_OFFICIAL_PLAYER_ID:DUP-BULLPEN/);
assert.throws(() => validateAsianTeamFeatureOwnership({
  away: { starter: { teamId: 701, id: 'DUP-CROSS-ROLE', candidates: [] } },
  home: { lineup: { teamId: 702, players: [{ teamId: 702, officialPlayerId: 'DUP-CROSS-ROLE' }] } },
}, 701, 702), /ASIAN_CROSS_TEAM_OFFICIAL_PLAYER_ID:DUP-CROSS-ROLE/);

const todayCpblReplay = [
  ['G295', '0000007832', '0000005604'],
  ['G296', '0000007778', '0000006237'],
  ['G297', '0000002274', '0000006497'],
];
for (const [gamePk, awayId, homeId] of todayCpblReplay) {
  assert.notEqual(awayId, homeId, `${gamePk}客主先發官方 ID 不得相同`);
  validateAsianTeamFeatureOwnership({
    away: { starter: { teamId: Number(gamePk.slice(1)) * 10 + 1, id: awayId, candidates: [] } },
    home: { starter: { teamId: Number(gamePk.slice(1)) * 10 + 2, id: homeId, candidates: [] } },
  }, Number(gamePk.slice(1)) * 10 + 1, Number(gamePk.slice(1)) * 10 + 2);
}

const extra = extraInningsKernelV13({
  means: { awayNinth: 0.35, homeNinth: 0.35 },
  gameState: { extraInnings: 3, allowDraw: true },
});
assert.equal(extra.maximumInnings, 3);
assert.equal(extra.allowDrawAtLimit, true);
assert.ok(extra.cells.some(row => row.awayRuns === row.homeRuns && row.probability > 0), '亞洲12局上限必須保留和局機率');
assert.ok(Math.abs(extra.cells.reduce((sum, row) => sum + row.probability, 0) - 1) < 1e-12);

const pastGame = {
  gamePk: 'historical-integrity-audit', providerGameId: 's200101020001', officialDate: '2001-01-02',
  gameDate: '2001-01-02T10:00:00Z', awayTeamId: 701, homeTeamId: 702,
  awayCode: 'YOM', homeCode: 'HAN', venue: 'Tokyo Dome',
};
const historicalOptions = {
  leagueId: 'NPB', game: pastGame,
  history: [
    { ...pastGame, gamePk: 'before', providerGameId: 's200101010001', gameDate: '2001-01-01T10:00:00Z', awayScore: 3, homeScore: 2 },
    { ...pastGame, gamePk: 'after', providerGameId: 's200101030001', gameDate: '2001-01-03T10:00:00Z', awayScore: 30, homeScore: 20 },
  ],
  fetchImpl: async () => ({ ok: true, text: async () => '', json: async () => ({}) }),
};
const observedHistory = (await buildAsianProductionFeatureSnapshot(historicalOptions)).featureSnapshot;
assert.ok(Date.parse(observedHistory.asOf) > Date.parse(pastGame.gameDate), '現在抓年度數據不得把時間偽裝成過去開賽前1秒');
assert.equal(observedHistory.temporalProvenance.historicalReplayEligible, false);
assert.equal(observedHistory.away.teamStrength.currentSeasonGames, 1, '歷史日期後的賽果不得流入賽前特徵');
const cachedHistory = (await buildAsianProductionFeatureSnapshot(historicalOptions)).featureSnapshot;
assert.equal(cachedHistory.asOf, observedHistory.asOf, '快取必須保留真正讀取時間，不能刷新成虛構新時間');
assert.ok(cachedHistory.sourceObservations.every(row => row.fromCache));
assert.deepEqual(cachedHistory.sourceObservations.map(row => row.id), observedHistory.sourceObservations.map(row => row.id));
assert.ok(Object.keys(observedHistory.sourceEvidence.contents).length > 0);
assert.ok(observedHistory.sourceObservations.every(row => row.publishedAt === null && row.dataCutoff === null));

const cpblGame = {
  gamePk: 'cpbl-fallback-integrity', providerGameId: 'cpbl-fallback-integrity',
  officialDate: '2026-08-31', gameDate: '2026-08-31T10:00:00Z',
  awayTeamId: 701, homeTeamId: 702, awayCode: 'CTB', homeCode: 'FUB', venue: '大巨蛋',
};
const cpblHistory = Array.from({ length: 6 }, (_, i) => ({
  ...cpblGame, providerGameId: `cpbl-fallback-past-${i}`, gamePk: `cpbl-fallback-past-${i}`,
  gameDate: `2026-08-${29 - i}T10:00:00Z`, awayScore: 3, homeScore: 2,
}));
const cpblStarterPayload = { Data: { Game: {
  Visiting: { Team: { Code: 'ACN011' }, Pitchers: [{ PitcherAcnt: 'AUDIT-A', PitcherName: '真實客投', RoleType: '先發', InningPitchedCnt: 5, InningPitchedDiv3Cnt: 0, PlateAppearances: 22, EarnedRunCnt: 2, HittingCnt: 5, BasesONBallsCnt: 1 }] },
  Home: { Team: { Code: 'AEO011' }, Pitchers: [{ PitcherAcnt: 'AUDIT-H', PitcherName: '真實主投', RoleType: '先發', InningPitchedCnt: 5, InningPitchedDiv3Cnt: 0, PlateAppearances: 25, EarnedRunCnt: 4, HittingCnt: 8, BasesONBallsCnt: 2 }] },
} } };
const cpblFallbackSnapshot = (await buildAsianProductionFeatureSnapshot({
  leagueId: 'CPBL', game: cpblGame, history: cpblHistory,
  fetchImpl: async url => ({ ok: true, json: async () => {
    if (url.includes('/games/')) return cpblStarterPayload;
    if (url.includes('/players/AUDIT-')) {
      const away = url.endsWith('AUDIT-A');
      return { Data: { Player: { Basic: { Acnt: away ? 'AUDIT-A' : 'AUDIT-H', Team: { Code: away ? 'ACN011' : 'AEO011' }, PitchingHabbit: 'R', IsForeign: '1' } } } };
    }
    return { Data: [] };
  } }),
})).featureSnapshot;
assert.equal(cpblFallbackSnapshot.away.starter.season.era, 3.6, 'wOBA缺失時應用官方球員ID對上真實近期先發資料');
assert.equal(cpblFallbackSnapshot.home.starter.season.era, 7.2);
assert.notEqual(cpblFallbackSnapshot.away.starter.qualityFactor, cpblFallbackSnapshot.home.starter.qualityFactor);
assert.equal(cpblFallbackSnapshot.away.starter.performanceSource, 'CPBL_OFFICIAL_RECENT_INDIVIDUAL_STARTS_REGRESSED');
assert.equal(cpblFallbackSnapshot.rules.foreignPlayerConstraint.status, 'DIAGNOSTIC_ONLY');
assert.equal(cpblFallbackSnapshot.rules.foreignPlayerConstraint.pitcherExitLineupTransitionModeled, false);

console.log('Asian official PIT parsers, relief-only split, starter evidence validation and draw-cap kernel PASS');
