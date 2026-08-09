from pathlib import Path


def one(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

# Final scorer key must survive JSON/text cleanup.
p = Path('lib/final-scorer.js')
s = p.read_text()
s = one(s, "const directionKey = row => `${row?.market || ''}\\u001f${row?.pick || ''}`;", "const directionKey = row => `${row?.market || ''}|||${row?.pick || ''}`;", 'printable direction key')
p.write_text(s)

# Analyze route: deterministic distribution first, GPT latest-instruction judge second.
p = Path('app/api/analyze/route.js')
s = p.read_text()
s = one(s,
"import { applyExpertAssessment, buildExpertAssessment } from '../../../lib/expert.js';",
"import { applyExpertAssessment, buildExpertAssessment } from '../../../lib/expert.js';\nimport { applyFinalScoreAssessment, buildFinalScoreAssessment } from '../../../lib/final-scorer.js';",
'import final scorer')
s = one(s, "export const maxDuration = 60;", "export const maxDuration = 120;", 'increase analyze duration')
s = one(s,
"    const analysis = analyzeMarkets({ context: enrichedContext, markets: activeMarkets, previousMarkets, settings });",
"    const preliminaryAnalysis = analyzeMarkets({ context: enrichedContext, markets: activeMarkets, previousMarkets, settings });\n    const finalScoreAssessment = await buildFinalScoreAssessment({\n      context: enrichedContext,\n      analysis: preliminaryAnalysis,\n      settings,\n      timeoutMs: 42000,\n    });\n    const analysis = applyFinalScoreAssessment({\n      analysis: preliminaryAnalysis,\n      assessment: finalScoreAssessment,\n      settings,\n    });",
'finalize GPT scores')
s = one(s,
"      expertAssessment,\n      analysis,",
"      expertAssessment,\n      finalScoreAssessment,\n      analysis,",
'return final score assessment')
p.write_text(s)

# Version the underlying distribution/rule engine separately from the GPT judge.
p = Path('lib/analysis.js')
s = p.read_text()
s = s.replace("export const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.3.0';", "export const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.4.0';")
s = s.replace("export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.3.0';", "export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.4.0';")
p.write_text(s)

# Use a capable research model before the cheap fallback. Final score still comes from the separate judge.
p = Path('lib/expert.js')
s = p.read_text()
s = one(s,
"  const models = unique([\n    'openai/gpt-5-nano',\n    process.env.AI_ANALYSIS_MODEL,\n    process.env.AI_MODEL,\n    'google/gemini-2.5-flash',\n  ]);",
"  const models = unique([\n    process.env.AI_ANALYSIS_MODEL,\n    'openai/gpt-5.6-terra',\n    'openai/gpt-5.5',\n    'openai/gpt-5.4',\n    process.env.AI_MODEL,\n    'openai/gpt-5-nano',\n    'google/gemini-2.5-flash',\n  ]);",
'upgrade expert model order')
s = s.replace("    const firstAttemptLimit = String(model).includes('gpt-5-nano') ? 10500 : 9000;", "    const firstAttemptLimit = String(model).includes('gpt-5-nano') ? 9000 : 12500;")
p.write_text(s)

# Client: invalidate old local snapshots, use one-at-a-time scoring, and show the real score source.
p = Path('app/page.js')
s = p.read_text()
s = one(s, "const VERSION = '8.3.0';", "const VERSION = '8.4.0';", 'page version')
s = one(s, "const STORAGE = 'mlb-positive-ev-v7';", "const STORAGE = 'mlb-positive-ev-v8-4';", 'new storage namespace')
s = one(s,
"const LEGACY_KEYS = ['mlb-positive-ev-v6-1', 'mlb-positive-ev-v6', 'mlb-positive-ev-v5', 'mlb-positive-ev-v4', 'mlb-positive-ev-v3'];",
"const LEGACY_KEYS = ['mlb-positive-ev-v7', 'mlb-positive-ev-v6-1', 'mlb-positive-ev-v6', 'mlb-positive-ev-v5', 'mlb-positive-ev-v4', 'mlb-positive-ev-v3'];\nconst FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.0';",
'legacy migration and score version')
s = s.replace("cached?.visionVersion === 'MLB-VISION-2026-08-v8.2.2'", "cached?.visionVersion === 'MLB-VISION-2026-08-v8.2.5'")
old_snapshot = """function scoreSnapshotIsValid(version) {
  const analysis = version?.analysis;
  if (!analysis || analysis.scoreContractVersion !== SCORE_CONTRACT_VERSION || analysis.scoreValidation?.passed !== true) return false;
  return (analysis.results || []).every(result => result.score == null || (
    Number.isFinite(Number(result.score))
    && Number(result.score) >= 1
    && Number(result.score) <= 9.4
    && result.scoreAudit?.ok === true
  ));
}"""
new_snapshot = """function scoreSnapshotIsValid(version) {
  const analysis = version?.analysis;
  if (!analysis || analysis.finalScoreVersion !== FINAL_SCORE_VERSION || analysis.scoreValidation?.passed !== true) return false;
  return (analysis.results || []).every(result => result.score == null || (
    Number.isFinite(Number(result.score))
    && Number(result.score) >= 1
    && Number(result.score) <= 9.4
    && result.scoreAudit?.ok === true
    && result.scoreSource === 'GPT 最終 Execution 判讀'
  ));
}"""
s = one(s, old_snapshot, new_snapshot, 'snapshot validator')
s = one(s, '    await runPool(plan.locks, 2, async lock => {', '    await runPool(plan.locks, 1, async lock => {', 'serial final scoring')
s = s.replace('正在取得資料、執行 GPT 研究判讀與聯合情境…', '正在取得資料、建立聯合情境並執行 GPT 最終評分…')
old_note = """            <div className="note">評分驗算：{data.analysis.scoreValidation?.passed ? `通過（${data.analysis.scoreValidation.checkedDirections} 個方向）` : `失敗，已封鎖異常分數（${data.analysis.scoreValidation?.failures?.length || 0} 項）`}｜分布 {data.analysis.scoreValidation?.distributionAudit?.passed ? `通過（${data.analysis.scoreValidation.distributionAudit.uniqueDisplayedScores} 種顯示分數）` : '失敗'}｜{data.analysis.scoreContractVersion}</div>"""
new_note = """            <div className="note">GPT 最終評分：{data.analysis.scoreValidation?.passed ? `通過（${data.analysis.scoreValidation.checkedDirections} 個方向）` : `失敗，已封鎖異常分數（${data.analysis.scoreValidation?.failures?.length || 0} 項）`}｜{data.analysis.finalScoreModel || '模型未回報'}｜無固定 EV 換分公式｜{data.analysis.finalScoreVersion}</div>"""
s = one(s, old_note, new_note, 'analysis score note')
s = one(s,
"    {score != null && <div className=\"classicMeta\">加權 EV {pct(result.weightedEV)}｜穩健 EV {pct(result.robustEV)}｜保守 EV {pct(result.conservativeEV)}｜驗算 {result.scoreAudit?.ok ? '通過' : '失敗'}｜建議 {unit} Unit</div>}",
"    {score != null && <><div className=\"classicMeta\">加權 EV {pct(result.weightedEV)}｜穩健 EV {pct(result.robustEV)}｜保守 EV {pct(result.conservativeEV)}｜驗算 {result.scoreAudit?.ok ? '通過' : '失敗'}｜建議 {unit} Unit</div><div className=\"classicMeta\">GPT 評分：{result.scoreReason || '—'}｜{result.scoreModel || '—'}</div></>}",
'classic GPT reason')
s = one(s,
"      </div><p className=\"note\">未知打線、捕手、主審、牛棚與屋頂不固定扣分；GPT 研究層只提供殘差交互作用與情境權重，不能直接改分。暫估水位只供觀察，不會進正式下注池。</p></div>",
"      </div><p className=\"note\">未知打線、捕手、主審、牛棚與屋頂先進入聯合情境，不固定扣分。程式完成比分分布與 EV 後，由 GPT 依最新 MLB 指令同時比較全部方向給最終分數；禁止固定 EV 換分與重複計分。暫估水位只供觀察，不會進正式下注池。</p></div>",
'settings note')
p.write_text(s)

# Health endpoint exposes the active final judge, not only the old diagnostic score contract.
p = Path('app/api/health/route.js')
s = p.read_text()
s = one(s,
"import { SCORE_CONTRACT_VERSION } from '../../../lib/markets.js';",
"import { SCORE_CONTRACT_VERSION } from '../../../lib/markets.js';\nimport { FINAL_SCORE_VERSION, FINAL_SCORE_INSTRUCTION_VERSION } from '../../../lib/final-scorer.js';",
'health final scorer import')
s = one(s, "    version: '8.3.0',", "    version: '8.4.0',", 'health version')
s = one(s,
"    scoreContractVersion: SCORE_CONTRACT_VERSION,",
"    scoreContractVersion: SCORE_CONTRACT_VERSION,\n    finalScoreVersion: FINAL_SCORE_VERSION,\n    finalScoreInstructionVersion: FINAL_SCORE_INSTRUCTION_VERSION,\n    configuredScoringModel: process.env.AI_SCORING_MODEL || 'openai/gpt-5.6-sol',",
'health final score fields')
p.write_text(s)

# Package and deployment version.
p = Path('package.json')
s = p.read_text()
s = s.replace('"version": "8.3.0"', '"version": "8.4.0"')
s = one(s,
'"test": "node scripts/scoring-parity.mjs && node scripts/test.mjs && node scripts/security-test.mjs"',
'"test": "node scripts/scoring-parity.mjs && node scripts/final-scorer-test.mjs && node scripts/test.mjs && node scripts/security-test.mjs"',
'add final scorer tests')
p.write_text(s)
Path('DEPLOYMENT_VERSION').write_text('8.4.0-gpt-final-execution-judge\n')

# Existing unit tests only need distribution/rules version updates; the old composite is now diagnostic-only.
p = Path('scripts/test.mjs')
s = p.read_text()
s = s.replace("GPT完整指令聯合情境模型-2026-08-v8.3.0", "GPT完整指令聯合情境模型-2026-08-v8.4.0")
s = s.replace("MLB-TW-EXECUTION-2026-08-v8.3.0", "MLB-TW-EXECUTION-2026-08-v8.4.0")
p.write_text(s)

# Production smoke now requires GPT final scoring provenance and latest-instruction audit.
p = Path('scripts/smoke.mjs')
s = p.read_text()
s = s.replace("const VERSION = '8.3.0';", "const VERSION = '8.4.0';")
s = s.replace("const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.3.0';", "const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.4.0';")
s = s.replace("const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.3.0';", "const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.4.0';")
s = one(s,
"const SCORE_CONTRACT_VERSION = 'GPT-COMPOSITE-EVIDENCE-v8.3';",
"const SCORE_CONTRACT_VERSION = 'GPT-COMPOSITE-EVIDENCE-v8.3';\nconst FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.0';",
'smoke final score constant')
s = one(s,
"        && value.scoreContractVersion === SCORE_CONTRACT_VERSION",
"        && value.scoreContractVersion === SCORE_CONTRACT_VERSION\n        && value.finalScoreVersion === FINAL_SCORE_VERSION",
'wait for final scorer')
s = one(s,
"assert.equal(health.scoreContractVersion, SCORE_CONTRACT_VERSION);",
"assert.equal(health.scoreContractVersion, SCORE_CONTRACT_VERSION);\nassert.equal(health.finalScoreVersion, FINAL_SCORE_VERSION);",
'health final scorer assertion')
s = s.replace('/第\\s*8\\.3\\.0\\s*版/', '/第\\s*8\\.4\\.0\\s*版/')
old_analysis_assert = """assert.equal(analysis.scoreContractVersion, SCORE_CONTRACT_VERSION);
assert.equal(analysis.scoreValidation.passed, true);
assert.ok(analysis.results.every(row => row.scoreAudit?.ok === true));"""
new_analysis_assert = """assert.equal(analysis.finalScoreVersion, FINAL_SCORE_VERSION);
assert.equal(analysis.scoreContractVersion, FINAL_SCORE_VERSION);
assert.equal(analysis.scoreValidation.passed, true);
assert.equal(analysis.scoreValidation.noFixedFormula, true);
assert.equal(analysis.scoreValidation.latestInstructionWins, true);
assert.ok(analysis.finalScoreModel);
assert.ok(analysis.results.every(row => row.scoreAudit?.ok === true));
assert.ok(analysis.results.every(row => row.scoreSource === 'GPT 最終 Execution 判讀'));
assert.ok(analysis.results.every(row => row.scoreModel === analysis.finalScoreModel));
assert.ok(analysis.results.every(row => row.scoreBreakdown?.noFixedFormula === true));"""
s = one(s, old_analysis_assert, new_analysis_assert, 'analysis final scorer assertions')
p.write_text(s)

# README records the actual root cause and architecture.
p = Path('README.md')
s = p.read_text()
s = s.replace('# MLB 長期正期望值分析｜第 8.3.0 版', '# MLB 長期正期望值分析｜第 8.4.0 版', 1)
s += '''\n\n## 8.4.0｜最新指令優先的 GPT 最終評分層\n\n根本錯誤已修正：網站先前以自訂複合公式把加權 EV、穩健 EV、保守 EV、資料品質、穩定性、獨立證據與市場分歧再相加一次，既與「最新每日最佳化版取代所有舊指令」衝突，也會把已進入比分分布與 EV 的因素重複計分。\n\n現在的流程是：\n\n1. 程式只負責最新 MLB 資料、聯合情境、同源比分分布、台灣信用盤逐結果結算、加權 EV、穩健 EV、保守 EV 與翻負風險。\n2. 所有實際開盤方向一次送入 GPT 最終 Execution 判讀層共同比較。預設使用 `openai/gpt-5.6-sol`，失敗時依序切換 GPT-5.5、GPT-5.4、GPT-5 與 GPT-5 mini。\n3. GPT 明確禁止固定 EV 換分、禁止再次把資料品質／市場支持加分，並遵守最新硬門檻：加權 EV 非正最高 6.6；穩健 EV 非正最高 7.1；穩健 EV 正值才有資格達 7.2，但保守 EV 不再被錯設成額外硬門檻。\n4. 程式在 GPT 回傳後再做硬門檻、正反方向、完整性與分布退化驗算。驗算失敗即不發布下注分數，不再退回舊自訂公式。\n5. 每一方向保存 GPT 模型、理由、硬上限、校正紀錄與原始 EV 證據；舊版瀏覽器分析快照會被隔離。\n'''
p.write_text(s)

print('v8.4 GPT final scorer patch applied')
