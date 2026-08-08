from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


path = Path('lib/expert.js')
text = path.read_text()
text = text.replace("export const EXPERT_VERSION = 'GPT-MLB-RESEARCH-LAYER-2026-08-v2';", "export const EXPERT_VERSION = 'GPT-MLB-RESEARCH-LAYER-2026-08-v2.1';")
text = replace_once(text, '        max_tokens: 3200,', '        max_tokens: 2200,', 'expert token budget')
text = replace_once(
    text,
    "      if (useJsonFormat) body.response_format = { type: 'json_object' };",
    "      if (useJsonFormat) body.response_format = { type: 'json_object' };\n      if (String(model).startsWith('openai/')) body.reasoning_effort = 'low';",
    'OpenAI low reasoning',
)
text = text.replace("export async function buildExpertAssessment({ context, markets, mode = 'auto', timeoutMs = 16000 }) {", "export async function buildExpertAssessment({ context, markets, mode = 'auto', timeoutMs = 24000 }) {")
old_loop = '''  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const remaining = deadline - Date.now();
    if (remaining < 1800) break;
    try {
      const parsed = await gatewayAssessment(key, model, prompt, remaining);
      const result = sanitizeExpertAssessment(parsed, context, model);
      cache.set(keyValue, { value: result, expires: Date.now() + 300000 });
      return result;
    } catch (error) {
      failures.push(`${model}：${String(error?.message || error)}`);
    }
  }'''
# Support both the original for-of loop and the indexed v2 loop.
if old_loop not in text:
    old_loop = '''  for (const model of models) {
    const remaining = deadline - Date.now();
    if (remaining < 1800) break;
    try {
      const parsed = await gatewayAssessment(key, model, prompt, remaining);
      const result = sanitizeExpertAssessment(parsed, context, model);
      cache.set(keyValue, { value: result, expires: Date.now() + 300000 });
      return result;
    } catch (error) {
      failures.push(`${model}：${String(error?.message || error)}`);
    }
  }'''
new_loop = '''  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const remaining = deadline - Date.now();
    if (remaining < 2200) break;
    const hasFallback = index < models.length - 1;
    const reserveForFallback = hasFallback ? Math.min(9000, Math.max(4500, remaining * 0.42)) : 0;
    const availableForAttempt = Math.max(2200, remaining - reserveForFallback);
    const attemptBudget = Math.max(2200, Math.min(index === 0 ? 13000 : remaining, availableForAttempt));
    try {
      const parsed = await gatewayAssessment(key, model, prompt, attemptBudget);
      const result = sanitizeExpertAssessment(parsed, context, model);
      cache.set(keyValue, { value: result, expires: Date.now() + 300000 });
      return result;
    } catch (error) {
      failures.push(`${model}：${String(error?.message || error)}`);
    }
  }'''
text = replace_once(text, old_loop, new_loop, 'per-model fallback loop')
path.write_text(text)

path = Path('app/api/analyze/route.js')
text = path.read_text()
text = text.replace("checkRateLimit(request, { id: 'analyze-v7'", "checkRateLimit(request, { id: 'analyze-v7-0-1'")
text = text.replace("setTimeout(() => reject(new Error('MLB 資料取得逾時，請稍後重試')), 38000)", "setTimeout(() => reject(new Error('MLB 資料取得逾時，請稍後重試')), 32000)")
text = text.replace('timeoutMs: 16000,', 'timeoutMs: 24000,')
path.write_text(text)

path = Path('lib/analysis.js')
text = path.read_text()
text = text.replace("export const MODEL_VERSION = 'GPT研究整合聯合情境模型-2026-08-v7';", "export const MODEL_VERSION = 'GPT研究整合聯合情境模型-2026-08-v7.0.1';")
text = text.replace("export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v7';", "export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v7.0.1';")
path.write_text(text)

path = Path('app/page.js')
text = path.read_text().replace("const VERSION = '7.0.0';", "const VERSION = '7.0.1';")
path.write_text(text)

path = Path('app/api/health/route.js')
text = path.read_text().replace("version: '7.0.0'", "version: '7.0.1'")
path.write_text(text)

path = Path('package.json')
text = path.read_text().replace('"version": "7.0.0"', '"version": "7.0.1"')
path.write_text(text)
Path('DEPLOYMENT_VERSION').write_text('7.0.1-expert-timeout-fallback\n')

path = Path('scripts/smoke.mjs')
text = path.read_text()
text = text.replace("const VERSION = '7.0.0';", "const VERSION = '7.0.1';")
text = text.replace("const MODEL_VERSION = 'GPT研究整合聯合情境模型-2026-08-v7';", "const MODEL_VERSION = 'GPT研究整合聯合情境模型-2026-08-v7.0.1';")
text = text.replace("const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v7';", "const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v7.0.1';")
text = text.replace("const EXPERT_VERSION = 'GPT-MLB-RESEARCH-LAYER-2026-08-v2';", "const EXPERT_VERSION = 'GPT-MLB-RESEARCH-LAYER-2026-08-v2.1';")
text = text.replace('/第\\s*7\\.0\\.0\\s*版/', '/第\\s*7\\.0\\.1\\s*版/')
path.write_text(text)

path = Path('README.md')
text = path.read_text()
text = text.replace('第 7.0.0 版', '第 7.0.1 版', 1)
text = text.replace('GPT研究整合聯合情境模型-2026-08-v7', 'GPT研究整合聯合情境模型-2026-08-v7.0.1')
text += '''

### 7.0.1 研究層逾時修正

OpenAI GPT 研究模型現在只使用有上限的首段時間，系統會預留明確時間給既有 AI 模型備援，不再讓第一個模型耗盡全部研究層期限。OpenAI 模型使用低 reasoning effort 與較小輸出上限；Production required smoke 仍要求至少一個研究模型實際成功，否則不算上線完成。
'''
path.write_text(text)

print('v7 expert timeout repair applied')
