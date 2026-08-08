from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label):
    left = text.find(start)
    if left < 0:
        raise SystemExit(f'{label}: start marker missing')
    right = text.find(end, left)
    if right < 0:
        raise SystemExit(f'{label}: end marker missing')
    return text[:left] + replacement.rstrip() + '\n\n' + text[right:]


# ---------------------------------------------------------------------------
# Vision prompt/version.
# ---------------------------------------------------------------------------
path = Path('lib/vision.js')
text = path.read_text()
text = text.replace("export const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.3';", "export const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.4';")
text = replace_once(
    text,
    '6. 只回單一合法 JSON，不要 Markdown、不要解釋。',
    '6. 至少先輸出能確定的場次；無法看清的市場填 null，不可因部分欄位不清楚而放棄整場。只回單一合法 JSON，不要 Markdown、不要解釋。',
    'vision partial extraction rule',
)
path.write_text(text)

# ---------------------------------------------------------------------------
# Vision route: proven vision-first models, no forced response_format on image
# calls, sanitized diagnostics, and compatibility-oriented image payload.
# ---------------------------------------------------------------------------
path = Path('app/api/vision/route.js')
text = path.read_text()

models = r'''function modelCandidates() {
  return unique([
    process.env.AI_VISION_MODEL,
    'openai/gpt-4o-mini',
    'openai/gpt-4.1-mini',
    'openai/gpt-5-nano',
    process.env.AI_MODEL,
    'google/gemini-2.5-flash',
  ]);
}'''
text = replace_between(text, 'function modelCandidates() {', 'async function gateway(', models, 'replace vision model candidates')

gateway = r'''async function gateway(key, model, content, { jsonFormat = false, timeoutMs = 14000, maxTokens = 2400 } = {}) {
  const body = {
    model,
    messages: [{ role: 'user', content }],
    temperature: 0,
    max_tokens: maxTokens,
  };
  if (jsonFormat) body.response_format = { type: 'json_object' };
  if (/gpt-5/i.test(String(model))) body.reasoning_effort = 'minimal';

  let response;
  try {
    response = await fetch(GATEWAY, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1500, timeoutMs)),
    });
  } catch (error) {
    if (/Timeout|Abort/i.test(String(error?.name || error?.message || error))) {
      const timeout = new Error(`${model} 辨識逾時`);
      timeout.code = 'timeout';
      throw timeout;
    }
    const network = new Error(`${model} 連線失敗`);
    network.code = 'network';
    throw network;
  }

  const raw = await response.text();
  if (!response.ok) {
    let providerMessage = '';
    try { providerMessage = JSON.parse(raw)?.error?.message || ''; }
    catch { providerMessage = raw; }
    providerMessage = String(providerMessage || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
    console.error('AI Gateway vision error', model, response.status, providerMessage);
    const error = new Error(`${model}（${response.status}）${providerMessage ? `：${providerMessage}` : ' 暫時無法使用'}`);
    error.status = response.status;
    if (response.status === 400 && /response[_ -]?format|json[_ -]?object|unsupported|invalid/i.test(`${providerMessage} ${raw}`)) error.code = 'response_format';
    else if (response.status === 429) error.code = 'rate_limited';
    else if (response.status === 401 || response.status === 403) error.code = 'auth';
    throw error;
  }

  let payload;
  try { payload = JSON.parse(raw); }
  catch { throw new Error(`${model} 回傳外層格式錯誤`); }
  const output = payload?.choices?.[0]?.message?.content;
  if (typeof output !== 'string' || !output.trim()) throw new Error(`${model} 未回傳可解析文字`);
  return output;
}'''
text = replace_between(text, 'async function gateway(', 'async function parseModelOutput(', gateway, 'replace gateway')

parse_output = r'''async function parseModelOutput(key, model, content, prompt, attemptMs) {
  const deadline = Date.now() + attemptMs;
  const output = await gateway(key, model, content, {
    jsonFormat: false,
    timeoutMs: attemptMs,
    maxTokens: 2400,
  });

  try {
    return expandVisionPayload(cleanVisionJSON(output));
  } catch (parseError) {
    const remaining = deadline - Date.now();
    if (remaining < 2200) throw new Error(`${model} JSON 解析失敗：${String(parseError?.message || parseError)}`);
    const repairContent = [{
      type: 'text',
      text: `${prompt}\n以下是視覺模型已讀出的內容，只修復成規定的短鍵 JSON；不得重新辨識、不得新增數字：\n${String(output).slice(0, 60000)}`,
    }];
    const repaired = await gateway(key, 'openai/gpt-5-nano', repairContent, {
      jsonFormat: true,
      timeoutMs: Math.min(remaining, 5000),
      maxTokens: 2000,
    });
    return expandVisionPayload(cleanVisionJSON(repaired));
  }
}'''
text = replace_between(text, 'async function parseModelOutput(', 'async function generateAndParse(', parse_output, 'replace parseModelOutput')

generate = r'''async function generateAndParse(key, content, prompt) {
  const models = modelCandidates();
  const deadline = Date.now() + 50000;
  const failures = [];
  let empty = null;

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const remaining = deadline - Date.now();
    if (remaining < 2500) break;
    const reserve = index < models.length - 1 ? Math.min(15000, Math.max(6000, remaining * 0.34)) : 0;
    const preferred = index === 0 ? 17000 : index === 1 ? 14000 : 10000;
    const attemptMs = Math.max(2500, Math.min(preferred, remaining - reserve));
    try {
      const parsed = await parseModelOutput(key, model, content, prompt, attemptMs);
      if (Array.isArray(parsed?.games) && parsed.games.length) return { parsed, model, failures };
      empty = { parsed, model, failures };
      failures.push(`${model}：回傳成功但沒有可確認場次`);
    } catch (error) {
      failures.push(`${model}：${String(error?.message || error)}`.slice(0, 320));
    }
  }

  if (empty) return empty;
  const timedOut = failures.some(value => /逾時|timeout/i.test(value));
  const error = new Error(timedOut
    ? '圖片辨識模型逾時；系統已自動切換其他模型仍未完成'
    : '圖片辨識服務未能完成');
  error.code = timedOut ? 'timeout' : 'vision_failed';
  error.details = failures.slice(0, 8);
  throw error;
}'''
text = replace_between(text, 'async function generateAndParse(', 'function sanitizeDefaultWater(', generate, 'replace generateAndParse')

text = text.replace("checkRateLimit(request, { id: 'vision-v7-0-3'", "checkRateLimit(request, { id: 'vision-v7-0-4'")
text = replace_once(
    text,
    "      for (const url of images) content.push({ type: 'image_url', image_url: { url, detail: 'high' } });",
    "      for (const url of images) content.push({ type: 'image_url', image_url: { url } });",
    'remove cross-provider detail option',
)
old_catch = r'''    return NextResponse.json({ ok: false, error: message }, {
      status: Number(error?.status) || (timedOut ? 504 : 500),
      headers: { 'Cache-Control': 'no-store' },
    });'''
new_catch = r'''    const details = (Array.isArray(error?.details) ? error.details : [])
      .map(value => String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 320))
      .filter(Boolean)
      .slice(0, 8);
    return NextResponse.json({ ok: false, error: message, details }, {
      status: Number(error?.status) || (timedOut ? 504 : 500),
      headers: { 'Cache-Control': 'no-store' },
    });'''
text = replace_once(text, old_catch, new_catch, 'diagnostic catch response')
path.write_text(text)

# ---------------------------------------------------------------------------
# Use JPEG universally for widest Chat Completions provider compatibility.
# ---------------------------------------------------------------------------
path = Path('app/page.js')
text = path.read_text()
text = text.replace("const VERSION = '7.0.3';", "const VERSION = '7.0.4';")
old_canvas = r'''function canvasDataURL(canvas, quality = 0.9) {
  const webp = canvas.toDataURL('image/webp', quality);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', quality);
}'''
new_canvas = r'''function canvasDataURL(canvas, quality = 0.92) {
  return canvas.toDataURL('image/jpeg', quality);
}'''
text = replace_once(text, old_canvas, new_canvas, 'force jpeg image payload')
path.write_text(text)

# ---------------------------------------------------------------------------
# Health/package/version.
# ---------------------------------------------------------------------------
path = Path('app/api/health/route.js')
path.write_text(path.read_text().replace("version: '7.0.3'", "version: '7.0.4'"))
path = Path('package.json')
path.write_text(path.read_text().replace('"version": "7.0.3"', '"version": "7.0.4"'))
Path('DEPLOYMENT_VERSION').write_text('7.0.4-vision-gateway-compatibility\n')

path = Path('.env.example')
text = path.read_text().replace('AI_VISION_MODEL=openai/gpt-5-nano', 'AI_VISION_MODEL=openai/gpt-4o-mini')
path.write_text(text)

# ---------------------------------------------------------------------------
# Tests and Production diagnostics.
# ---------------------------------------------------------------------------
path = Path('scripts/test.mjs')
text = path.read_text().replace('/v7\\.0\\.3$/', '/v7\\.0\\.4$/')
path.write_text(text)

path = Path('scripts/smoke.mjs')
text = path.read_text()
text = text.replace("const VERSION = '7.0.3';", "const VERSION = '7.0.4';")
text = text.replace("const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.3';", "const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.4';")
text = text.replace('/第\\s*7\\.0\\.3\\s*版/', '/第\\s*7\\.0\\.4\\s*版/')
text = replace_once(
    text,
    "  if (!result.ok || value.ok === false) throw new Error(`${url} 失敗（${result.status}）：${value.error || text.slice(0, 300)}`);",
    "  if (!result.ok || value.ok === false) {\n    const detail = Array.isArray(value.details) && value.details.length ? `｜${value.details.join('；')}` : '';\n    throw new Error(`${url} 失敗（${result.status}）：${value.error || text.slice(0, 300)}${detail}`);\n  }",
    'smoke diagnostic details',
)
path.write_text(text)

path = Path('README.md')
text = path.read_text()
text = text.replace('第 7.0.3 版', '第 7.0.4 版', 1)
text += '''

### 7.0.4 視覺模型相容性修正

圖片辨識改以明確支援文件與截圖理解的 GPT-4o mini 優先，再依序切換 GPT-4.1 mini、GPT-5 nano 與既有 Gemini。圖片請求不再強制所有供應商接受 `response_format` 或 OpenAI 專用 `detail` 參數；前端統一輸出高品質 JPEG。失敗回應只附帶經清理的模型與狀態原因，方便正式 smoke 精準找出供應商相容性問題，不包含圖片或秘密資料。
'''
path.write_text(text)

print('vision v7.0.4 patch applied')
