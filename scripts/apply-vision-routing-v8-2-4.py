from pathlib import Path


def one(text, old, new, label):
    count=text.count(old)
    if count!=1: raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old,new,1)

p=Path('app/api/vision/route.js'); t=p.read_text()
old="""  return unique([
    process.env.AI_VISION_MODEL,
    'zai/glm-4.6v-flash',
    'google/gemini-2.5-flash',
    'openai/gpt-4o-mini',
    'openai/gpt-4.1-mini',
    process.env.AI_MODEL,
    'openai/gpt-5-nano',
  ]).slice(0, 5);"""
new="""  return unique([
    process.env.AI_VISION_MODEL,
    'alibaba/qwen3.6-27b',
    'zai/glm-4.5v',
    'zai/glm-4.6v-flash',
    'google/gemini-2.5-flash',
    'openai/gpt-4o-mini',
    process.env.AI_MODEL,
  ]).slice(0, 5);"""
t=one(t,old,new,'vision candidates')
old_body="""  if (jsonFormat) body.response_format = { type: 'json_object' };
  if (/gpt-5/i.test(String(model))) body.reasoning_effort = 'minimal';"""
new_body="""  if (jsonFormat) body.response_format = { type: 'json_object' };
  if (/gpt-5/i.test(String(model))) body.reasoning_effort = 'minimal';
  // OCR/table extraction does not benefit from long hidden reasoning. The
  // OpenAI-compatible gateway accepts this for reasoning-capable providers;
  // providers that ignore it still receive the same deterministic prompt.
  if (/^(?:zai|alibaba)\//i.test(String(model))) body.reasoning = { enabled: false };"""
t=one(t,old_body,new_body,'disable vision reasoning')
t=t.replace('  const deadline = Date.now() + 50000;','  const deadline = Date.now() + 58000;',1)
old_timing="""    const reserve = index < models.length - 1 ? Math.min(15000, Math.max(6000, remaining * 0.34)) : 0;
    const preferred = index === 0 ? 17000 : index === 1 ? 14000 : 10000;
    const attemptMs = Math.max(2500, Math.min(preferred, remaining - reserve));"""
new_timing="""    const reserve = index < models.length - 1 ? Math.min(18000, Math.max(7000, remaining * 0.28)) : 0;
    const preferred = index === 0 ? 28000 : index === 1 ? 21000 : index === 2 ? 16000 : 10000;
    const attemptMs = Math.max(3000, Math.min(preferred, remaining - reserve));"""
t=one(t,old_timing,new_timing,'vision attempt timing')
p.write_text(t)

p=Path('lib/vision.js'); x=p.read_text().replace("export const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.3';","export const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.4';"); p.write_text(x)
for f,o,n in [('app/page.js',"const VERSION = '8.2.3';","const VERSION = '8.2.4';"),('app/api/health/route.js',"version: '8.2.3'","version: '8.2.4'"),('package.json','"version": "8.2.3"','"version": "8.2.4"')]:
 p=Path(f); x=p.read_text();
 if o not in x: raise SystemExit(f'{f}: version marker missing')
 p.write_text(x.replace(o,n,1))
Path('DEPLOYMENT_VERSION').write_text('8.2.4-qwen-glm-vision-routing\n')
p=Path('scripts/test.mjs'); x=p.read_text().replace('assert.match(VISION_VERSION, /v8\\.2\\.3$/);','assert.match(VISION_VERSION, /v8\\.2\\.4$/);'); p.write_text(x)
p=Path('scripts/smoke.mjs'); x=p.read_text().replace("const VERSION = '8.2.3';","const VERSION = '8.2.4';").replace("const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.3';","const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.4';").replace('/第\\s*8\\.2\\.3\\s*版/','/第\\s*8\\.2\\.4\\s*版/'); p.write_text(x)
p=Path('README.md'); x=p.read_text().replace('# MLB 長期正期望值分析｜第 8.2.3 版','# MLB 長期正期望值分析｜第 8.2.4 版',1); x+='''\n\n### 8.2.4 低延遲表格視覺路由\n\n密集盤口優先路由至原生表格與視覺能力較強的 Qwen 3.6 27B，再以 GLM-4.5V、GLM-4.6V-Flash、Gemini Flash 與 OpenAI Mini 備援。表格擷取關閉可關閉的長思考模式，第一與第二模型提供較完整的處理時間，同時保留總請求 58 秒與最多三個供應商的上限。\n'''; p.write_text(x)
print('v8.2.4 vision routing patch applied')
