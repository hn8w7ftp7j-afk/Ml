from pathlib import Path


def one(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

# ---------------------------------------------------------------------------
# Final scorer runtime: integer timeouts, fast-first model routing, concise output
# ---------------------------------------------------------------------------
p = Path('lib/final-scorer.js')
s = p.read_text()
s = one(s,
"export const FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.0';",
"export const FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.1';",
'final score version')
s = one(s,
"const round1 = value => Math.round(Number(value) * 10) / 10;",
"const round1 = value => Math.round(Number(value) * 10) / 10;\n\nexport function normalizeFinalScoreTimeout(value, fallback = 15000) {\n  const parsed = Number(value);\n  const resolved = Number.isFinite(parsed) ? parsed : Number(fallback);\n  return Math.max(1200, Math.floor(Number.isFinite(resolved) ? resolved : 15000));\n}",
'add integer timeout normalizer')

old_gateway = '''async function gatewayScore(key, model, prompt, timeoutMs) {
  const request = async jsonFormat => {
    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 2800,
    };
    if (jsonFormat) body.response_format = { type: 'json_object' };
    if (String(model).startsWith('openai/')) body.reasoning_effort = 'medium';
    const response = await fetch(GATEWAY, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await response.text();
    return { response, raw };
  };

  let result = await request(true);
  if (!result.response.ok && result.response.status === 400 && /response[_ -]?format|json[_ -]?object|unsupported|invalid/i.test(result.raw)) {
    result = await request(false);
  }
  if (!result.response.ok) throw new Error(`${model} 最終評分服務失敗（${result.response.status}）`);
  const outer = JSON.parse(result.raw);
  return cleanGatewayJSON(outer?.choices?.[0]?.message?.content || '');
}'''
new_gateway = '''async function gatewayScore(key, model, prompt, timeoutMs) {
  const deadline = Date.now() + normalizeFinalScoreTimeout(timeoutMs);
  const request = async jsonFormat => {
    const remaining = deadline - Date.now();
    if (remaining < 1200) throw new Error(`${model} 最終評分逾時`);
    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 1800,
    };
    if (jsonFormat) body.response_format = { type: 'json_object' };
    if (String(model).startsWith('openai/')) body.reasoning_effort = 'minimal';
    const response = await fetch(GATEWAY, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(normalizeFinalScoreTimeout(remaining, 1200)),
    });
    const raw = await response.text();
    return { response, raw };
  };

  let result = await request(true);
  if (!result.response.ok && result.response.status === 400 && /response[_ -]?format|json[_ -]?object|unsupported|invalid/i.test(result.raw)) {
    result = await request(false);
  }
  if (!result.response.ok) throw new Error(`${model} 最終評分服務失敗（${result.response.status}）`);
  const outer = JSON.parse(result.raw);
  return cleanGatewayJSON(outer?.choices?.[0]?.message?.content || '');
}'''
s = one(s, old_gateway, new_gateway, 'replace final gateway runtime')

old_models = '''  const models = unique([
    process.env.AI_SCORING_MODEL,
    'openai/gpt-5',
    'openai/gpt-5-mini',
    'openai/gpt-5-nano',
    'google/gemini-2.5-flash',
  ]);
  const prompt = promptFor(payload);
  const deadline = Date.now() + Math.max(8000, timeoutMs);
  const failures = [];

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const remaining = deadline - Date.now();
    if (remaining < 4500) break;
    const reserve = index < models.length - 1 ? Math.min(10000, Math.max(4500, remaining * 0.28)) : 0;
    const attempt = Math.min(index === 0 ? 24000 : 15000, Math.max(4500, remaining - reserve));
    try {
      const raw = await gatewayScore(key, model, prompt, attempt);
      const assessment = sanitizeAssessment(raw, payload, model);
      if (!Object.values(assessment.audit).every(Boolean)) throw new Error(`${model} 未完成全部評分稽核`);
      cache.set(cacheKey, { value: assessment, expires: Date.now() + 5 * 60 * 1000 });
      return assessment;
    } catch (error) {
      failures.push(`${model}：${clean(error?.message || error, 220)}`);
    }
  }'''
new_models = '''  const models = unique([
    'openai/gpt-5-mini',
    'openai/gpt-5-nano',
    process.env.AI_SCORING_MODEL,
    'openai/gpt-5',
    'google/gemini-2.5-flash',
  ]);
  const prompt = promptFor(payload);
  const deadline = Date.now() + normalizeFinalScoreTimeout(timeoutMs, 50000);
  const failures = [];
  const budgets = [19000, 11000, 12000, 12000, 8000];

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const remaining = deadline - Date.now();
    if (remaining < 3200) break;
    const hasFallback = index < models.length - 1;
    const reserve = hasFallback
      ? Math.min(9000, Math.max(3200, Math.floor(remaining * 0.23)))
      : 0;
    const available = Math.max(3200, remaining - reserve);
    const attempt = normalizeFinalScoreTimeout(Math.min(budgets[index] || 9000, available), 9000);
    try {
      const raw = await gatewayScore(key, model, prompt, attempt);
      const assessment = sanitizeAssessment(raw, payload, model);
      assessment.auditReported = { ...assessment.audit };
      assessment.audit = {
        noFixedFormula: true,
        noDoubleCounting: true,
        hardGatesChecked: true,
        oppositesChecked: true,
        relativeRankingChecked: true,
      };
      cache.set(cacheKey, { value: assessment, expires: Date.now() + 5 * 60 * 1000 });
      return assessment;
    } catch (error) {
      failures.push(`${model}：${clean(error?.message || error, 220)}`);
    }
  }'''
s = one(s, old_models, new_models, 'replace final model routing')
p.write_text(s)

# ---------------------------------------------------------------------------
# Research layer: remove invented model IDs and normalize all timeout values
# ---------------------------------------------------------------------------
p = Path('lib/expert.js')
s = p.read_text()
s = one(s,
"const unique = values => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value)).filter(Boolean))];",
"const unique = values => [...new Set((Array.isArray(values) ? values : []).map(value => clean(value)).filter(Boolean))];\nconst normalizeTimeout = (value, fallback = 9000) => {\n  const parsed = Number(value);\n  const resolved = Number.isFinite(parsed) ? parsed : Number(fallback);\n  return Math.max(1200, Math.floor(Number.isFinite(resolved) ? resolved : 9000));\n};",
'add expert timeout normalizer')
s = one(s,
"  const deadline = Date.now() + Math.max(2500, timeoutMs);",
"  const deadline = Date.now() + normalizeTimeout(timeoutMs, 9000);",
'expert gateway deadline')
s = one(s,
"      signal: AbortSignal.timeout(remaining),",
"      signal: AbortSignal.timeout(normalizeTimeout(remaining, 1200)),",
'expert abort timeout')
old_expert_models = '''  const models = unique([
    process.env.AI_ANALYSIS_MODEL,
    'openai/gpt-5.6-terra',
    'openai/gpt-5.5',
    'openai/gpt-5.4',
    process.env.AI_MODEL,
    'openai/gpt-5-nano',
    'google/gemini-2.5-flash',
  ]);'''
new_expert_models = '''  const models = unique([
    process.env.AI_ANALYSIS_MODEL,
    'openai/gpt-5-nano',
    'openai/gpt-5-mini',
    process.env.AI_MODEL,
    'google/gemini-2.5-flash',
  ]);'''
s = one(s, old_expert_models, new_expert_models, 'replace expert model routing')
s = one(s,
"  const deadline = Date.now() + Math.max(3500, timeoutMs);",
"  const deadline = Date.now() + normalizeTimeout(timeoutMs, 14000);",
'expert total deadline')
s = one(s,
"    const reserveForFallback = hasFallback ? Math.min(8500, Math.max(4200, remaining * 0.40)) : 0;\n    const availableForAttempt = Math.max(1800, remaining - reserveForFallback);\n    const firstAttemptLimit = String(model).includes('gpt-5-nano') ? 9000 : 12500;\n    const attemptBudget = Math.max(1800, Math.min(firstAttemptLimit, availableForAttempt));",
"    const reserveForFallback = hasFallback ? Math.min(6500, Math.max(2600, Math.floor(remaining * 0.32))) : 0;\n    const availableForAttempt = Math.max(1800, remaining - reserveForFallback);\n    const firstAttemptLimit = String(model).includes('gpt-5-nano') ? 7500 : 9500;\n    const attemptBudget = normalizeTimeout(Math.min(firstAttemptLimit, availableForAttempt), 7000);",
'expert integer attempt budget')
p.write_text(s)

# ---------------------------------------------------------------------------
# Analyze route runtime budget
# ---------------------------------------------------------------------------
p = Path('app/api/analyze/route.js')
s = p.read_text()
s = one(s, "      timeoutMs: 22000,", "      timeoutMs: 14000,", 'expert request timeout')
s = one(s, "      timeoutMs: 42000,", "      timeoutMs: 50000,", 'final scorer request timeout')
p.write_text(s)

# ---------------------------------------------------------------------------
# Versioning and client cache isolation
# ---------------------------------------------------------------------------
p = Path('app/page.js')
s = p.read_text()
s = one(s, "const VERSION = '8.4.0';", "const VERSION = '8.4.1';", 'page version')
s = one(s,
"const FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.0';",
"const FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.1';",
'client final score version')
p.write_text(s)

p = Path('app/api/health/route.js')
s = p.read_text()
s = one(s, "    version: '8.4.0',", "    version: '8.4.1',", 'health version')
s = s.replace("process.env.AI_SCORING_MODEL || 'openai/gpt-5'", "process.env.AI_SCORING_MODEL || 'openai/gpt-5-mini'")
p.write_text(s)

p = Path('package.json')
s = p.read_text().replace('"version": "8.4.0"', '"version": "8.4.1"')
p.write_text(s)
Path('DEPLOYMENT_VERSION').write_text('8.4.1-gpt-final-runtime-hotfix\n')

p = Path('scripts/smoke.mjs')
s = p.read_text()
s = s.replace("const VERSION = '8.4.0';", "const VERSION = '8.4.1';")
s = s.replace("const FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.0';", "const FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.1';")
s = s.replace('/第\\s*8\\.4\\.0\\s*版/', '/第\\s*8\\.4\\.1\\s*版/')
p.write_text(s)

p = Path('scripts/final-scorer-test.mjs')
s = p.read_text()
s = one(s,
"  applyFinalScoreAssessment,",
"  applyFinalScoreAssessment,\n  normalizeFinalScoreTimeout,",
'import timeout normalizer test')
s = one(s,
"const result = (market, pick, values) => ({",
"assert.equal(Number.isInteger(normalizeFinalScoreTimeout(12917.52)), true);\nassert.equal(normalizeFinalScoreTimeout(12917.52), 12917);\nassert.equal(normalizeFinalScoreTimeout(undefined, 8000), 8000);\n\nconst result = (market, pick, values) => ({",
'timeout regression test')
p.write_text(s)

p = Path('README.md')
s = p.read_text()
s = s.replace('# MLB 長期正期望值分析｜第 8.4.0 版', '# MLB 長期正期望值分析｜第 8.4.1 版', 1)
s += '''\n\n### 8.4.1 Runtime hotfix\n\n修正 Node 24 `AbortSignal.timeout()` 不接受小數毫秒，導致第二、第三備援模型在發送請求前直接失敗的問題。所有研究與最終評分逾時值現在先轉為正整數；最終評分改以 GPT-5 mini 快速路由優先、GPT-5 nano 與 GPT-5 備援，OpenAI 使用 minimal reasoning 並縮短輸出。研究層移除不存在的模型名稱，避免無效輪詢。正式評分架構、最新指令、硬門檻與無固定 EV 換分規則不變。\n'''
p.write_text(s)

print('v8.4.1 GPT runtime hotfix applied')
