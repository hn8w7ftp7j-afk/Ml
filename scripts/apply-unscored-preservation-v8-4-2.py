from pathlib import Path


def one(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

p = Path('lib/final-scorer.js')
s = p.read_text()
old = '''    const judged = scoreMap.get(directionKey(row));
    row.legacyDiagnosticScore = row.score;
    if (!judged) {
      row.score = null;
      row.betEligible = false;
      row.unitSuggestion = 0;
      row.tag = 'GPT 最終評分缺失｜不評分';
      row.scoreAudit = { ok: false, version: FINAL_SCORE_VERSION, errors: ['缺少 GPT 最終評分方向'], corrections: [] };
      failures.push(`${row.market}｜${row.pick}：缺少 GPT 最終評分`);
      return row;
    }'''
new = '''    const judged = scoreMap.get(directionKey(row));
    row.legacyDiagnosticScore = row.score;

    // Directions that were intentionally not scored upstream (for example a
    // missing water price) are not part of the GPT payload. Preserve their
    // original reason instead of mislabelling them as a GPT failure.
    if (source.score == null) {
      row.score = null;
      row.betEligible = false;
      row.unitSuggestion = 0;
      row.portfolioUnit = 0;
      row.portfolioRole = '';
      row.scoreSource = '上游資料閘門未通過';
      row.scoreReason = source.tag || source.integrityMessage || '不評分';
      row.finalScoreVersion = FINAL_SCORE_VERSION;
      row.scoreAudit = {
        ok: true,
        skipped: true,
        version: FINAL_SCORE_VERSION,
        errors: [],
        corrections: [],
        reason: row.scoreReason,
      };
      return row;
    }

    if (!judged) {
      row.score = null;
      row.betEligible = false;
      row.unitSuggestion = 0;
      row.tag = 'GPT 最終評分缺失｜不評分';
      row.scoreAudit = { ok: false, version: FINAL_SCORE_VERSION, errors: ['缺少 GPT 最終評分方向'], corrections: [] };
      failures.push(`${row.market}｜${row.pick}：缺少 GPT 最終評分`);
      return row;
    }'''
s = one(s, old, new, 'preserve unscored direction')
p.write_text(s)

p = Path('scripts/final-scorer-test.mjs')
s = p.read_text()
marker = """assert.ok(finalized.portfolio.reduce((sum, row) => sum + row.recommendedUnit, 0) <= 2.000001);

console.log(JSON.stringify({"""
addition = """assert.ok(finalized.portfolio.reduce((sum, row) => sum + row.recommendedUnit, 0) <= 2.000001);

const missingWaterRow = {
  ...result('全場大小', '小8+50', { weightedEV: 0, robustEV: 0, conservativeEV: 0, modelProbability: 0.5 }),
  water: null,
  score: null,
  tag: '水位未提供｜不評分',
  betEligible: false,
};
const withMissing = applyFinalScoreAssessment({
  analysis: { ...analysis, results: [...rows, missingWaterRow] },
  assessment,
  settings: { candidateThreshold: 7.2, strongestThreshold: 8.5 },
});
const preserved = withMissing.results.find(row => row.pick === '小8+50');
assert.equal(preserved.score, null);
assert.equal(preserved.tag, '水位未提供｜不評分');
assert.equal(preserved.scoreAudit.ok, true);
assert.equal(preserved.scoreAudit.skipped, true);
assert.equal(withMissing.scoreValidation.passed, true);

console.log(JSON.stringify({"""
s = one(s, marker, addition, 'add missing water regression')
p.write_text(s)

print('unscored direction preservation applied')
