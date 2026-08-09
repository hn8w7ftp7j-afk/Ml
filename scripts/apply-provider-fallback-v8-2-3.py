from pathlib import Path


def one(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

p=Path('app/api/vision/route.js'); t=p.read_text()
old="""  return unique([
    process.env.AI_VISION_MODEL,
    'google/gemini-2.5-flash',
    'openai/gpt-4.1-mini',
    'openai/gpt-4o-mini',
    process.env.AI_MODEL,
    'openai/gpt-5-nano',
  ]);"""
new="""  return unique([
    process.env.AI_VISION_MODEL,
    'zai/glm-4.6v-flash',
    'google/gemini-2.5-flash',
    'openai/gpt-4o-mini',
    'openai/gpt-4.1-mini',
    process.env.AI_MODEL,
    'openai/gpt-5-nano',
  ]).slice(0, 5);"""
t=one(t,old,new,'model candidates')
t=one(t,"const repaired = await gateway(key, 'openai/gpt-5-nano', repairContent, {","const repaired = await gateway(key, model, repairContent, {",'same-provider JSON repair')
old_loop="""  const failures = [];
  let empty = null;

  for (let index = 0; index < models.length; index += 1) {"""
new_loop="""  const failures = [];
  let empty = null;
  let rateLimitedModels = 0;

  for (let index = 0; index < models.length; index += 1) {"""
t=one(t,old_loop,new_loop,'rate limit counter')
old_catch="""    } catch (error) {
      failures.push(`${model}：${String(error?.message || error)}`.slice(0, 320));
      if (error?.code === 'rate_limited') { error.details = failures; throw error; }
    }
  }

  if (empty) return empty;"""
new_catch="""    } catch (error) {
      failures.push(`${model}：${String(error?.message || error)}`.slice(0, 320));
      if (error?.code === 'rate_limited') {
        rateLimitedModels += 1;
        // A free-tier limit may be model/provider specific. Try at most two
        // additional low-cost vision providers, then stop to avoid request storms.
        if (rateLimitedModels >= 3 || index >= 2) { error.details = failures; throw error; }
        continue;
      }
    }
  }

  if (empty) return empty;"""
t=one(t,old_catch,new_catch,'provider fallback catch')
p.write_text(t)

p=Path('lib/vision.js'); t=p.read_text().replace("export const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.2';","export const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.3';"); p.write_text(t)
for f,o,n in [('app/page.js',"const VERSION = '8.2.2';","const VERSION = '8.2.3';"),('app/api/health/route.js',"version: '8.2.2'","version: '8.2.3'"),('package.json','"version": "8.2.2"','"version": "8.2.3"')]:
 p=Path(f); x=p.read_text();
 if o not in x: raise SystemExit(f'{f}: version marker missing')
 p.write_text(x.replace(o,n,1))
Path('DEPLOYMENT_VERSION').write_text('8.2.3-cross-provider-vision-fallback\n')
p=Path('scripts/test.mjs'); x=p.read_text().replace('assert.match(VISION_VERSION, /v8\\.2\\.2$/);','assert.match(VISION_VERSION, /v8\\.2\\.3$/);'); p.write_text(x)
p=Path('scripts/smoke.mjs'); x=p.read_text().replace("const VERSION = '8.2.2';","const VERSION = '8.2.3';").replace("const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.2';","const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.3';").replace('/第\\s*8\\.2\\.2\\s*版/','/第\\s*8\\.2\\.3\\s*版/'); p.write_text(x)
p=Path('README.md'); x=p.read_text().replace('# MLB 長期正期望值分析｜第 8.2.2 版','# MLB 長期正期望值分析｜第 8.2.3 版',1); x+='''\n\n### 8.2.3 跨供應商視覺備援\n\n圖片辨識優先使用低成本 GLM-4.6V-Flash，再依序嘗試 Gemini Flash 與 OpenAI Mini。單一模型回傳 429 不再直接中止整次辨識，但最多只跨三個供應商，避免重複請求風暴。視覺輸出 JSON 修復沿用同一個已成功讀圖的模型，不再另外呼叫不同模型。\n'''; p.write_text(x)
print('v8.2.3 provider fallback patch applied')
