from pathlib import Path


def one(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

p = Path('lib/final-scorer.js')
s = p.read_text()
s = one(s,
"export const FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.1';",
"export const FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.2';",
'final score version')
s = one(s,
"const GATEWAY = 'https://ai-gateway.vercel.sh/v1/chat/completions';",
"const GATEWAY = 'https://ai-gateway.vercel.sh/v1/chat/completions';\nconst OPENAI_CHAT = 'https://api.openai.com/v1/chat/completions';\nconst sleep = milliseconds => new Promise(resolve => setTimeout(resolve, Math.max(0, Math.floor(milliseconds))));",
'add direct endpoint')
s = one(s,
"export function normalizeFinalScoreTimeout(value, fallback = 15000) {\n  const parsed = Number(value);\n  const resolved = Number.isFinite(parsed) ? parsed : Number(fallback);\n  return Math.max(1200, Math.floor(Number.isFinite(resolved) ? resolved : 15000));\n}",
"export function normalizeFinalScoreTimeout(value, fallback = 15000) {\n  const parsed = Number(value);\n  const resolved = Number.isFinite(parsed) ? parsed : Number(fallback);\n  return Math.max(1200, Math.floor(Number.isFinite(resolved) ? resolved : 15000));\n}\n\nexport function parseRetryAfter(value, fallback = 5000) {\n  const text = String(value || '').trim();\n  if (!text) return Math.max(0, Math.floor(fallback));\n  const seconds = Number(text);\n  if (Number.isFinite(seconds)) return Math.max(0, Math.floor(seconds * 1000));\n  const timestamp = Date.parse(text);\n  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());\n  return Math.max(0, Math.floor(fallback));\n}\n\nfunction responseError(label, response, raw) {\n  const detail = clean(raw, 300);\n  const error = new Error(`${label}（${response.status}）${detail ? `：${detail}` : ''}`);\n  error.status = response.status;\n  error.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), 5000);\n  return error;\n}",
'add retry parser')

old_gateway = '''async function gatewayScore(key, model, prompt, timeoutMs) {
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
new_gateway = '''async function gatewayScore(key, models, prompt, timeoutMs) {
  const list = unique(models);
  const primary = list[0];
  const deadline = Date.now() + normalizeFinalScoreTimeout(timeoutMs);
  const request = async jsonFormat => {
    const remaining = deadline - Date.now();
    if (remaining < 1200) throw new Error(`${primary} 最終評分逾時`);
    const body = {
      model: primary,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1800,
      providerOptions: { gateway: { models: list } },
    };
    if (jsonFormat) body.response_format = { type: 'json_object' };
    if (String(primary).startsWith('openai/')) body.reasoning_effort = 'minimal';
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
  if (!result.response.ok && result.response.status === 400 && /response[_ -]?format|json[_ -]?object|provider.?options|unsupported|invalid/i.test(result.raw)) {
    result = await request(false);
  }
  if (!result.response.ok) throw responseError('AI Gateway 最終評分失敗', result.response, result.raw);
  const outer = JSON.parse(result.raw);
  return {
    parsed: cleanGatewayJSON(outer?.choices?.[0]?.message?.content || ''),
    model: clean(outer?.model || primary, 120),
    source: 'vercel-ai-gateway',
  };
}

async function directOpenAIScore(key, prompt, timeoutMs) {
  const model = clean(process.env.OPENAI_SCORING_MODEL || 'gpt-5-mini', 120);
  const deadline = Date.now() + normalizeFinalScoreTimeout(timeoutMs, 18000);
  const request = async jsonFormat => {
    const remaining = deadline - Date.now();
    if (remaining < 1200) throw new Error(`${model} 直接 OpenAI 最終評分逾時`);
    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      reasoning_effort: 'minimal',
      max_completion_tokens: 1800,
    };
    if (jsonFormat) body.response_format = { type: 'json_object' };
    const response = await fetch(OPENAI_CHAT, {
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
  if (!result.response.ok) throw responseError('直接 OpenAI 最終評分失敗', result.response, result.raw);
  const outer = JSON.parse(result.raw);
  return {
    parsed: cleanGatewayJSON(outer?.choices?.[0]?.message?.content || ''),
    model: `direct-openai/${clean(outer?.model || model, 100)}`,
    source: 'direct-openai',
  };
}'''
s = one(s, old_gateway, new_gateway, 'replace gateway with built-in fallback and direct provider')

start = s.index('export async function buildFinalScoreAssessment(')
end = s.index('\nfunction hardCapFor(', start)
old_build = s[start:end]
new_build = '''export async function buildFinalScoreAssessment({ context, analysis, settings = {}, timeoutMs = 50000 }) {
  const gatewayKey = process.env.AI_GATEWAY_API_KEY;
  const directOpenAIKey = process.env.OPENAI_API_KEY;
  const payload = compactPayload(context, analysis, settings);
  if (!payload.directions.length) throw new Error('沒有可供 GPT 最終評分的方向');
  if (!gatewayKey && !directOpenAIKey) {
    throw new Error('GPT 最終評分層無法完成：AI_GATEWAY_API_KEY 與 OPENAI_API_KEY 均未設定');
  }

  const cacheKey = stableCacheKey(payload);
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;

  const prompt = promptFor(payload);
  const deadline = Date.now() + normalizeFinalScoreTimeout(timeoutMs, 50000);
  const failures = [];
  const gatewayModels = unique([
    'openai/gpt-5-mini',
    'openai/gpt-5-nano',
    process.env.AI_SCORING_MODEL,
    'openai/gpt-5',
    'google/gemini-2.5-flash',
  ]);

  const accept = output => {
    const assessment = sanitizeAssessment(output.parsed, payload, output.model);
    assessment.source = output.source;
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
  };

  if (gatewayKey) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining < 5000) break;
      try {
        return accept(await gatewayScore(gatewayKey, gatewayModels, prompt, Math.min(22000, remaining)));
      } catch (error) {
        failures.push(`AI Gateway：${clean(error?.message || error, 260)}`);
        if (Number(error?.status) !== 429 || attempt > 0) break;
        const wait = Math.min(12000, Math.max(3500, finite(error?.retryAfterMs, 5000)));
        if (deadline - Date.now() <= wait + 4500) break;
        await sleep(wait);
      }
    }
  }

  if (directOpenAIKey && deadline - Date.now() >= 4500) {
    try {
      return accept(await directOpenAIScore(directOpenAIKey, prompt, Math.min(20000, deadline - Date.now())));
    } catch (error) {
      failures.push(`直接 OpenAI：${clean(error?.message || error, 260)}`);
    }
  }

  throw new Error(`GPT 最終評分層無法完成：${failures.join('；') || '沒有可用的 GPT 服務'}。若持續出現 429，請檢查 AI Gateway／OpenAI 額度。`);
}
'''
s = s[:start] + new_build + s[end:]
p.write_text(s)

# Health and versions
p = Path('app/api/health/route.js')
s = p.read_text()
s = one(s, "    version: '8.4.1',", "    version: '8.4.2',", 'health version')
s = one(s,
"    aiGatewayConfigured: Boolean(process.env.AI_GATEWAY_API_KEY),",
"    aiGatewayConfigured: Boolean(process.env.AI_GATEWAY_API_KEY),\n    directOpenAIConfigured: Boolean(process.env.OPENAI_API_KEY),",
'health direct key status')
p.write_text(s)

p = Path('app/page.js')
s = p.read_text()
s = one(s, "const VERSION = '8.4.1';", "const VERSION = '8.4.2';", 'page version')
s = one(s,
"const FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.1';",
"const FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.2';",
'client final score version')
p.write_text(s)

p = Path('package.json')
s = p.read_text().replace('"version": "8.4.1"', '"version": "8.4.2"')
p.write_text(s)
Path('DEPLOYMENT_VERSION').write_text('8.4.2-gateway-retry-direct-openai-fallback\n')

p = Path('scripts/smoke.mjs')
s = p.read_text()
s = s.replace("const VERSION = '8.4.1';", "const VERSION = '8.4.2';")
s = s.replace("const FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.1';", "const FINAL_SCORE_VERSION = 'GPT-FINAL-EXECUTION-JUDGE-2026-08-v8.4.2';")
s = s.replace('/第\\s*8\\.4\\.1\\s*版/', '/第\\s*8\\.4\\.2\\s*版/')
p.write_text(s)

p = Path('scripts/final-scorer-test.mjs')
s = p.read_text()
s = one(s,
"  normalizeFinalScoreTimeout,",
"  normalizeFinalScoreTimeout,\n  parseRetryAfter,",
'import retry parser')
s = one(s,
"assert.equal(normalizeFinalScoreTimeout(undefined, 8000), 8000);",
"assert.equal(normalizeFinalScoreTimeout(undefined, 8000), 8000);\nassert.equal(parseRetryAfter('2'), 2000);\nassert.equal(Number.isInteger(parseRetryAfter('2.75')), true);",
'retry parser tests')
p.write_text(s)

p = Path('README.md')
s = p.read_text()
s = s.replace('# MLB 長期正期望值分析｜第 8.4.1 版', '# MLB 長期正期望值分析｜第 8.4.2 版', 1)
s += '''\n\n### 8.4.2 Gateway／Direct OpenAI 雙通道\n\n正式評分先以單一 AI Gateway 請求交由 Gateway 內建模型 fallback，避免連續多個請求放大 429；遇到 429 會依 Retry-After 等待後重試一次。若 Vercel AI Gateway 額度或速率仍不可用，且站台已設定 `OPENAI_API_KEY`，會改走 OpenAI 官方 Chat Completions 的 `gpt-5-mini`。兩條通道共用完全相同的最新 MLB 最終評分指令、JSON 驗證與硬門檻。健康檢查會分別顯示 Gateway 與 Direct OpenAI 是否已設定。\n'''
p.write_text(s)

print('v8.4.2 direct scoring fallback patch applied')
