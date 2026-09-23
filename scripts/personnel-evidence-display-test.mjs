import assert from 'node:assert/strict';
import { assignmentEvidenceView, measurementEvidenceView, personnelAssignmentSummary, personnelNames, lineupOrderText, bullpenRosterView, sourceLineageView, umpireEvidenceView } from '../lib/personnel-evidence-display.js';
import { analysisStarterDisplay } from '../lib/analysis-starter-display.js';
import { buildAnalysisDataAudit } from '../lib/analysis-data-audit-v1.js';
import fs from 'node:fs';

const legacy = { category: 'starter', status: 'observed', identity: { assignmentStatus: 'CONFIRMED', playerNames: ['Old Pitcher'] } };
assert.equal(assignmentEvidenceView(legacy).label, '未核對', 'legacy measured statistics cannot confirm this game assignment');
assert.equal(measurementEvidenceView(legacy).label, '已取得');
const projected = { ...legacy, assignmentEvidence: { status: 'PROJECTED' }, measurementEvidence: { status: 'observed' } };
assert.equal(assignmentEvidenceView(projected).label, '預估');
assert.equal(measurementEvidenceView(projected).label, '已取得', 'projected assignment can still have observed ability');
assert.equal(measurementEvidenceView({ status: 'stale', measurementEvidence: { status: 'observed' } }).label, '舊資料', 'stale source flag remains visible alongside measured statistics');
const official = { category: 'lineup', status: 'missing', assignmentEvidence: { status: 'OFFICIAL_REPORTED' }, measurementEvidence: { status: 'missing' } };
assert.equal(assignmentEvidenceView(official).label, '官方回報');
assert.equal(measurementEvidenceView(official).label, '缺失', 'official names do not fill batting statistics');
assert.equal(personnelAssignmentSummary({ rows: [legacy, projected, official, { category: 'lineup', assignmentEvidence: { status: 'MISSING' } }, { category: 'bullpen', assignmentEvidence: { status: 'OFFICIAL_REPORTED' } }] }), '官方回報 1・預估 1・缺失 1・未核對 1');
assert.deepEqual(personnelNames({ identity: { playerNames: [' A ', 'A'] }, players: [{ name: 'B' }] }), ['A', 'B']);

for (let order = 1; order <= 9; order++) {
  assert.equal(lineupOrderText({ battingOrder: order }, 'MLB'), `${order} 棒`);
  assert.equal(lineupOrderText({ battingOrder: order * 100 }, 'MLB'), `${order} 棒`);
}
assert.equal(lineupOrderText({ battingOrder: 101 }, 'MLB'), '棒次未核對', 'substitute code is not an original starting slot');
assert.equal(lineupOrderText({ battingOrder: 100 }, 'NPB'), '棒次未核對', 'MLB source encoding must not leak across leagues');
assert.equal(lineupOrderText({ battingOrder: null }, 'MLB'), '棒次未保存');
assert.equal(lineupOrderText({}, 'MLB'), '棒次未保存');

const bullpen = { players: [], coverage: { rosterComplete: null }, historicalUsage: { playerNames: ['Historical A', 'Historical B'], appearances: [{ name: 'Historical A' }] } };
const bullpenBefore = structuredClone(bullpen);
assert.equal(bullpenRosterView(bullpen).candidateLabel, '未保存逐人投手名單');
assert.equal(bullpenRosterView(bullpen).historyLabel, '歷史登板 2 人');
assert.equal(bullpenRosterView(bullpen).completeness, '名單完整性未保存');
assert.deepEqual(bullpenRosterView(bullpen).candidates, [], 'history never becomes current roster');
assert.match(bullpenRosterView({ players: [{ name: 'Candidate' }], coverage: { rosterComplete: true } }).note, /不代表本場可出賽/);
assert.deepEqual(bullpen, bullpenBefore);
assert.equal(sourceLineageView({ sourceLineage: { parsedInputComparison: { status: 'SHARED_FIELDS_MATCH', comparedFields: ['era', 'id'], mismatches: [] } } }), '保存欄位一致（2 欄）');
assert.equal(sourceLineageView({ sourceLineage: { parsedInputComparison: { status: 'TRANSFORMED_FIELDS_MATCH', comparedFields: ['era', 'qualityFactor'], mismatches: [], transformedFeatures: ['away.starter'] } } }), '保存欄位與轉換一致（2 欄）');
assert.equal(sourceLineageView({ sourceLineage: { parsedInputComparison: { status: 'TRANSFORMED_FIELDS_MATCH', comparedFields: ['era'], mismatches: ['era'] } } }), '保存欄位有差異', 'a recorded mismatch overrides the transformation status');
assert.equal(sourceLineageView({ sourceLineage: { parsedInputComparison: { status: 'CONFLICT', comparedFields: ['era'], mismatches: [] } } }), '保存欄位有差異', 'explicit conflict remains higher priority');
assert.equal(sourceLineageView({ sourceLineage: { parsedInputComparison: { status: 'CONFLICT', comparedFields: ['id'], mismatches: ['id'] } } }), '保存欄位有差異');
assert.equal(sourceLineageView({ sourceLineage: { parsedInputComparison: { status: 'NOT_COMPARABLE', comparedFields: [] } } }), '保存欄位未核對');
assert.equal(sourceLineageView({ sourceLineage: { parsedInputComparison: { status: 'NOT_VERIFIED', comparedFields: ['id'] } } }), '保存欄位未核對');

assert.equal(umpireEvidenceView({ supportingData: [{ key: 'weather', name: 'Weather station', status: 'observed' }] }).label, '主審未保存');
assert.equal(umpireEvidenceView({ supportingData: [{ key: 'umpire', name: 'Umpire A', status: 'observed', identityStatus: 'REPORTED', meanEffectStatus: 'SAVED_USAGE_REPORTED', usage: [{ usedInMean: false }] }] }).effect, '效果未用於得分中心');
assert.equal(umpireEvidenceView({ supportingData: [{ key: 'umpire', name: 'Umpire A', status: 'observed', identityStatus: 'REPORTED', meanEffectStatus: 'SAVED_USAGE_REPORTED' }] }).effect, '效果使用未記錄');
assert.equal(umpireEvidenceView({ supportingData: [{ key: 'umpire', status: 'missing', identityStatus: 'MISSING' }] }).label, '主審未確認');
assert.equal(umpireEvidenceView({ supportingData: [{ key: 'umpire', name: 'Projected Umpire', status: 'projected', identityStatus: 'PROJECTED' }] }).label, '主審預估');
for (const row of [{ name: 'Legacy projection', status: 'PROJECTED', projected: true }, { name: 'Legacy projection', status: 'CONFIRMED', projected: true }]) {
  assert.equal(umpireEvidenceView({ supportingData: [{ key: 'umpire', ...row }] }).label, '主審預估');
}
for (const row of [{ name: 'Stale name', status: 'MISSING' }, { name: 'Unavailable', status: 'CONFIRMED', available: false }, { name: 'Unknown status' }]) {
  assert.equal(umpireEvidenceView({ supportingData: [{ key: 'umpire', ...row }] }).label, '主審未確認');
}

for (const leagueId of ['MLB', 'KBO', 'CPBL', 'NPB']) {
  const game = { gamePk: '123', gameDate: '2026-09-08T09:00:00Z', leagueId, awayTeamId: 7, homeTeamId: 8, awayProbable: 'Schedule Pitcher' };
  const context = { game: { ...game }, leagueId, away: { starter: { id: '0123', name: 'Saved Pitcher', teamId: 7, identityConfirmed: true, confirmed: true }, upstreamReadiness: { starterIdentity: true } } };
  const item = { game, customData: { context, analysis: { dataAudit: { rows: [{ ...legacy, side: 'away' }] }, results: [{ score: 8.1, modelEV: .2 }] } } };
  const before = structuredClone(item);
  assert.equal(analysisStarterDisplay(item, 'away'), 'Saved Pitcher（當場未核對）');
  item.customData.analysis.dataAudit.rows[0].assignmentEvidence = { status: 'OFFICIAL_REPORTED' };
  assert.equal(analysisStarterDisplay(item, 'away'), 'Saved Pitcher（官方回報）');
  context.away.starter.assignmentStatus = 'PROJECTED_ROTATION_SCENARIO';
  assert.equal(analysisStarterDisplay(item, 'away'), 'Saved Pitcher（輪值推估）', 'projection overrides stale official flags');
  delete context.away.starter.assignmentStatus;
  context.away.starter.teamId = 999;
  assert.equal(analysisStarterDisplay(item, 'away'), 'Schedule Pitcher（賽程人選／未核對）');
  context.away.starter.teamId = 7;
  context.game.gameDate = '2026-09-09T09:00:00Z';
  assert.equal(analysisStarterDisplay(item, 'away'), 'Schedule Pitcher（賽程人選／未核對）');
  assert.deepEqual(item.customData.analysis.results, before.customData.analysis.results, 'display never alters scores');
}
const readerGame = { gamePk: '456', leagueId: 'CPBL', awayTeamId: 9 };
const readerItem = { game: readerGame, customData: { context: { game: { ...readerGame }, leagueId: 'CPBL', away: { starter: { id: '12', name: '測試投手', teamId: 9, assignmentStatus: 'OFFICIAL_CONFIRMED' } } } } };
for (const source of ['SERVER_ATTESTED_TAI888_IDENTITY_VALIDATED_BY_CPBL_ROSTER', 'TAI888_ROSTER_VALIDATED_REPORTED_STARTER']) {
  readerItem.customData.context.away.starter.identitySource = source;
  assert.equal(analysisStarterDisplay(readerItem, 'away'), '測試投手（Reader人選／名冊核對）', 'roster identity evidence remains visible without claiming official game assignment');
  assert.doesNotMatch(analysisStarterDisplay(readerItem, 'away'), /官方/);
}
readerItem.customData.context.away.starter.identitySource = 'TAI888_REPORTED_STARTER';
assert.equal(analysisStarterDisplay(readerItem, 'away'), '測試投手（Reader人選／未核對）');
for (const leagueId of ['MLB', 'KBO', 'CPBL']) assert.equal(analysisStarterDisplay({ game: { leagueId } }, 'away'), '賽程未提供先發');

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/personnel-receipt-audit.json', import.meta.url), 'utf8'));
const fixtureBefore = structuredClone(fixture);
for (const item of fixture.cases) {
  const audit = buildAnalysisDataAudit(item.context, item.profile);
  const starter = audit.rows.find(row => row.key === 'away.starter');
  const bullpen = audit.rows.find(row => row.key === 'away.bullpen');
  const display = bullpenRosterView(bullpen);
  if (item.id.startsWith('cpbl_')) {
    assert.equal(assignmentEvidenceView(starter).label, '預估');
    assert.equal(display.candidates.length, 11);
    assert.equal(display.completeness, '名單完整性未保存');
  } else if (item.id.startsWith('kbo_')) {
    assert.equal(display.candidates.length, 0);
    assert.equal(display.historical.length, 10);
    assert.equal(display.candidateLabel, '未保存逐人投手名單');
  } else if (item.id.startsWith('mlb_')) {
    assert.equal(assignmentEvidenceView(starter).label, '未核對');
    assert.equal(display.candidates.length, 12);
    assert.doesNotMatch(sourceLineageView(starter), /有差異/, 'upstream person season values are not the transformed starts-only inputs');
  }
}
assert.deepEqual(fixture, fixtureBefore, 'real archived inputs and usage declarations stay immutable');
console.log('PASS personnel display: v2/v3 assignment vs measurements, historical roster, umpire, lineage, four-league frozen header and three archived fixtures');
