from pathlib import Path


def one(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)


def between(text, start_marker, end_marker, replacement, label):
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f'{label}: start marker missing')
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f'{label}: end marker missing')
    return text[:start] + replacement.rstrip() + '\n\n' + text[end:]

# ---------------------------------------------------------------------------
# Vision schema: enumerate and extract in one multimodal response.
# ---------------------------------------------------------------------------
p = Path('lib/vision.js')
t = p.read_text()
t = t.replace("export const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.1';", "export const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.2';")
old_rule = "4. line 的 +50/-80 是卡洞尾數，不是賠付水位。賠付水位是 0.940、0.950。\\n5. 未開盤市場填 null；只看到一邊水位時另一邊必須 null；禁止拿相鄰欄或相鄰場補數字。\\n6. 逐列輸出每一個可見對戰；部分欄位不清楚也不能漏掉整場。只回單一合法 JSON。\\n\\n短鍵格式：\\n{\"g\":[{\"id\":gamePk"
new_rule = "4. line 的 +50/-80 是卡洞尾數，不是賠付水位。賠付水位是 0.940、0.950。必須逐字抄寫，不得把 2+60 改成 2.5，不得把 8-80 改成 8.5。\\n5. 未開盤市場填 null；只看到一邊水位時另一邊必須 null；禁止拿相鄰欄或相鄰場補數字。\\n6. 多張圖片是同一張盤口表的重疊區域，合併去重後輸出；逐列輸出每一個可見對戰，部分欄位不清楚也不能漏掉整場。\\n7. ids 必須先列出所有可見且可配對的 gamePk；g 必須對應這些場次。只回單一合法 JSON。\\n\\n短鍵格式：\\n{\"ids\":[gamePk...],\"g\":[{\"id\":gamePk"
if old_rule not in t:
    raise SystemExit('vision prompt rules marker missing')
t = t.replace(old_rule, new_rule, 1)
p.write_text(t)

# ---------------------------------------------------------------------------
# Vision route: one-pass extraction, stop retry storms on provider 429.
# ---------------------------------------------------------------------------
p = Path('app/api/vision/route.js')
t = p.read_text()
t = t.replace("checkRateLimit(request, { id: 'vision-v8-1', limit: 28, windowMs: 10 * 60 * 1000 })", "checkRateLimit(request, { id: 'vision-v8-2-2', limit: 16, windowMs: 10 * 60 * 1000 })")
old_models = """  return unique([
    process.env.AI_VISION_MODEL,
    'openai/gpt-4o-mini',
    'openai/gpt-4.1-mini',
    'openai/gpt-5-nano',
    process.env.AI_MODEL,
    'google/gemini-2.5-flash',
  ]);"""
new_models = """  return unique([
    process.env.AI_VISION_MODEL,
    'google/gemini-2.5-flash',
    'openai/gpt-4.1-mini',
    'openai/gpt-4o-mini',
    process.env.AI_MODEL,
    'openai/gpt-5-nano',
  ]);"""
t = one(t, old_models, new_models, 'vision model order')

insert_marker = 'async function parseModelOutput(key, model, content, prompt, attemptMs) {'
helper = r'''function expandedVisionPayload(payload) {
  const expanded = expandVisionPayload(payload);
  const ids = unique([
    ...(Array.isArray(payload?.ids) ? payload.ids : []),
    ...(Array.isArray(payload?.gamePks) ? payload.gamePks : []),
    ...(Array.isArray(payload?.g) ? payload.g.map(row => row?.id ?? row?.gamePk) : []),
    ...(Array.isArray(payload?.games) ? payload.games.map(row => row?.gamePk ?? row?.id) : []),
  ]);
  return { ...expanded, visibleGamePks: ids };
}
'''
t = one(t, insert_marker, helper + '\n' + insert_marker, 'insert expanded payload helper')
t = one(t, '    return expandVisionPayload(cleanVisionJSON(output));', '    return expandedVisionPayload(cleanVisionJSON(output));', 'parse primary payload ids')
t = one(t, '    return expandVisionPayload(cleanVisionJSON(repaired));', '    return expandedVisionPayload(cleanVisionJSON(repaired));', 'parse repaired payload ids')

# Do not fan a quota/rate-limit error out across every provider alias.
t = t.replace(
    "    } catch (error) {\n      failures.push(`${model}：${String(error?.message || error)}`.slice(0, 320));\n    }",
    "    } catch (error) {\n      failures.push(`${model}：${String(error?.message || error)}`.slice(0, 320));\n      if (error?.code === 'rate_limited') { error.details = failures; throw error; }\n    }",
    1,
)
t = t.replace(
    "    } catch (error) {\n      failures.push(`${model}：${String(error?.message || error)}`.slice(0, 260));\n    }",
    "    } catch (error) {\n      failures.push(`${model}：${String(error?.message || error)}`.slice(0, 260));\n      if (error?.code === 'rate_limited') { error.details = failures; throw error; }\n    }",
    1,
)

board_function = r'''async function parseBoardEfficient(key, images, schedule, requestedIds = []) {
  const ids = requestedIds.map(String);
  const prompt = ids.length
    ? buildVisionTargetPrompt(schedule, ids)
    : `${buildVisionPrompt(schedule, false)}\n\n這是整張盤口的一次完整掃描。先填 ids，再逐場填 g；不可只輸出前幾場。`;
  const content = [{ type: 'text', text: prompt }];
  for (const image of images.slice(0, 2)) content.push({ type: 'image_url', image_url: { url: image } });
  const result = await generateAndParse(key, content, prompt);
  const allowed = new Set(schedule.map(game => String(game.gamePk)));
  const visible = unique([
    ...(result.parsed?.visibleGamePks || []),
    ...(result.parsed?.games || []).map(row => row?.gamePk),
    ...ids,
  ]).filter(value => allowed.has(String(value)));
  return {
    parsed: result.parsed,
    model: result.model,
    failures: result.failures || [],
    discoveredGamePks: visible,
  };
}'''
t = between(t, 'async function parseBoardByTargets(', 'function sanitizeDefaultWater(', board_function, 'replace multi-call board parser')
t = one(
    t,
    "      if (images.length === 1 && (boardPass || targetGamePks.length)) {\n        const result = await parseBoardByTargets(key, images[0], schedule, targetGamePks);",
    "      if (images.length && (boardPass || targetGamePks.length)) {\n        const result = await parseBoardEfficient(key, images, schedule, targetGamePks);",
    'route efficient board call',
)
old_catch = """    const timedOut = error?.code === 'timeout' || /Timeout|AbortError/i.test(String(error?.name || '')) || /timeout|逾時/i.test(String(error?.message || ''));
    const message = timedOut
      ? '圖片內容較密，系統已自動切換辨識模型但仍逾時；請重新上傳，系統會自動分段處理'
      : String(error?.message || error);"""
new_catch = """    const timedOut = error?.code === 'timeout' || /Timeout|AbortError/i.test(String(error?.name || '')) || /timeout|逾時/i.test(String(error?.message || ''));
    const rateLimited = error?.code === 'rate_limited' || Number(error?.status) === 429;
    const message = rateLimited
      ? '人工智慧辨識服務目前達到供應商速率限制，系統已停止重複扣用請求；請稍後自動重試'
      : timedOut
        ? '圖片內容較密，辨識模型仍逾時；請重新上傳，系統會自動重試'
        : String(error?.message || error);"""
t = one(t, old_catch, new_catch, 'vision catch rate limit')
t = one(
    t,
    "      status: Number(error?.status) || (timedOut ? 504 : 500),\n      headers: { 'Cache-Control': 'no-store' },",
    "      status: rateLimited ? 429 : Number(error?.status) || (timedOut ? 504 : 500),\n      headers: { 'Cache-Control': 'no-store', ...(rateLimited ? { 'Retry-After': '30' } : {}) },",
    'vision response retry after',
)
p.write_text(t)

# ---------------------------------------------------------------------------
# Client: two zoom halves, one API request per image, retries and session cache.
# ---------------------------------------------------------------------------
p = Path('app/page.js')
t = p.read_text()
t = one(t, '  MARKET_ORDER,\n  calculateProfit,', '  MARKET_ORDER,\n  SCORE_CONTRACT_VERSION,\n  calculateProfit,', 'page score contract import')
t = t.replace("const VERSION = '8.2.1';", "const VERSION = '8.2.2';")
old_dense = r'''      const stripHeight = Math.min(image.height, Math.max(180, Math.min(310, Math.round(image.height * 0.34))));
      const step = Math.max(90, Math.round(stripHeight * 0.56));
      const positions = [];
      for (let position = 0; position < image.height; position += step) {
        positions.push(Math.min(position, Math.max(0, image.height - stripHeight)));
        if (position + stripHeight >= image.height) break;
      }
      const crops = [...new Set(positions)].slice(0, 8).map(position => renderImageCrop(
        image,
        0,
        position,
        image.width,
        stripHeight,
        { minimumWidth: 2100, maximumDimension: 2500 },
      ));
      // Full-image pass discovers every matchup; overlapping crops recover small market text.
      const parts = [full, ...crops];
      resolve({ data: full, parts, width: image.width, height: image.height });'''
new_dense = r'''      // Two overlapping high-resolution halves are sent together in one multimodal request.
      // This keeps every row readable while avoiding the old 9-request crop storm.
      const halfHeight = Math.min(image.height, Math.ceil(image.height * 0.60));
      const top = renderImageCrop(image, 0, 0, image.width, halfHeight, { minimumWidth: 2100, maximumDimension: 2500 });
      const bottomY = Math.max(0, image.height - halfHeight);
      const bottom = renderImageCrop(image, 0, bottomY, image.width, halfHeight, { minimumWidth: 2100, maximumDimension: 2500 });
      resolve({ data: full, parts: [top, bottom], width: image.width, height: image.height });'''
t = one(t, old_dense, new_dense, 'dense image halves')

old_request_error = """    if (!response.ok || data.ok === false) throw new Error(data.error || `請求失敗（${response.status}）`);
    return data;"""
new_request_error = """    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || `請求失敗（${response.status}）`);
      error.status = response.status;
      error.details = Array.isArray(data.details) ? data.details : [];
      error.retryAfter = Number(response.headers.get('retry-after')) || 0;
      throw error;
    }
    return data;"""
t = one(t, old_request_error, new_request_error, 'request error metadata')
request_marker = 'function download(name, text, type = \'application/json\') {'
request_helpers = r'''const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function visionFingerprint(images, schedule) {
  const source = `${VERSION}|${(schedule || []).map(game => game.gamePk).join(',')}|${(images || []).join('|')}`;
  if (!globalThis.crypto?.subtle) return source.slice(0, 120);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function requestVisionJSON(payload) {
  const cacheKey = `mlb-vision-${await visionFingerprint(payload.images, payload.schedule)}`;
  try {
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
    if (cached?.visionVersion === 'MLB-VISION-2026-08-v8.2.2' && Array.isArray(cached.games) && cached.games.length) return cached;
  } catch {}

  let lastError = null;
  const delays = [0, 6000, 16000];
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await sleep(delays[attempt]);
    try {
      const data = await requestJSON('/api/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      try { sessionStorage.setItem(cacheKey, JSON.stringify(data)); } catch {}
      return data;
    } catch (error) {
      lastError = error;
      if (![429, 503, 504].includes(Number(error?.status))) throw error;
    }
  }
  throw lastError || new Error('圖片辨識未完成');
}
'''
t = one(t, request_marker, request_helpers + '\n' + request_marker, 'vision retry helpers')

# Remove old score snapshots that produced 0/10 or used another contract.
migrate_marker = 'function migrateSaved() {'
migration_helpers = r'''function scoreSnapshotIsValid(version) {
  const analysis = version?.analysis;
  if (!analysis || analysis.scoreContractVersion !== SCORE_CONTRACT_VERSION || analysis.scoreValidation?.passed !== true) return false;
  return (analysis.results || []).every(result => result.score == null || (
    Number.isFinite(Number(result.score))
    && Number(result.score) >= 3.5
    && Number(result.score) <= 9.4
    && result.scoreAudit?.ok === true
  ));
}

function sanitizeAnalysisHistory(history) {
  return Object.fromEntries(Object.entries(history || {}).map(([lockId, versions]) => [
    lockId,
    (Array.isArray(versions) ? versions : []).filter(scoreSnapshotIsValid),
  ]).filter(([, versions]) => versions.length));
}
'''
t = one(t, migrate_marker, migration_helpers + '\n' + migrate_marker, 'score history sanitizer')
t = one(t, '        analysisHistory: current.analysisHistory || {},', '        analysisHistory: sanitizeAnalysisHistory(current.analysisHistory),', 'sanitize saved score history')

start = t.find('  async function recognizeAndAnalyze(sourceImages, schedule) {')
end = t.find('\n  async function recognize() {', start)
if start < 0 or end < 0:
    raise SystemExit('recognizeAndAnalyze block markers missing')
recognize = r'''  async function recognizeAndAnalyze(sourceImages, schedule) {
    const all = [];
    const failures = [];
    const models = new Set();
    const expectedVisible = new Set();

    for (let index = 0; index < sourceImages.length; index += 1) {
      const image = sourceImages[index];
      const requestImages = (Array.isArray(image.parts) && image.parts.length ? image.parts : [image.data]).slice(0, 2);
      setVisionStatus(`自動辨識全部圖片：圖片 ${index + 1}/${sourceImages.length}；單次合併掃描全部區域`);
      try {
        const data = await requestVisionJSON({
          images: requestImages,
          schedule,
          defaultWater: store.settings.fallbackWater,
          boardPass: true,
        });
        if (data.model) models.add(data.model);
        for (const gamePk of data.discoveredGamePks || []) expectedVisible.add(String(gamePk));
        all.push(...(data.games || []));
      } catch (error) {
        const detail = error?.details?.length ? `｜${error.details[0]}` : '';
        failures.push(`圖片 ${index + 1}：${error.message}${detail}`);
      }
    }

    let merged = mergeVision(all);
    if (!merged.length) throw new Error(failures[0] || '沒有辨識到任何場次，請改貼盤口文字或重新上傳');

    let missingVisible = [...expectedVisible].filter(gamePk => !merged.some(row => String(row.gamePk || '') === gamePk));
    if (missingVisible.length) {
      setVisionStatus(`已找到 ${expectedVisible.size} 個可見對戰，正在一次補抓缺少的 ${missingVisible.length} 場…`);
      for (const image of sourceImages) {
        if (!missingVisible.length) break;
        try {
          const requestImages = (Array.isArray(image.parts) && image.parts.length ? image.parts : [image.data]).slice(0, 2);
          const data = await requestVisionJSON({
            images: requestImages,
            schedule,
            defaultWater: store.settings.fallbackWater,
            targetGamePks: missingVisible,
          });
          if (data.model) models.add(data.model);
          all.push(...(data.games || []));
          merged = mergeVision(all);
          missingVisible = [...expectedVisible].filter(gamePk => !merged.some(row => String(row.gamePk || '') === gamePk));
        } catch (error) {
          failures.push(`精準補掃：${error.message}`);
        }
      }
    }

    if (expectedVisible.size && missingVisible.length) {
      setParsed(merged);
      setSelected(0);
      setVisionStatus(`完整性檢查未通過：圖片可見 ${expectedVisible.size} 場，目前完成 ${expectedVisible.size - missingVisible.length} 場；未發布部分分析`);
      setTab('confirm');
      return;
    }

    setParsed(merged);
    setSelected(0);
    const finalMatched = new Set(merged.map(row => String(row.gamePk || '')).filter(Boolean)).size;
    const expectedCount = expectedVisible.size || finalMatched;
    const completenessText = `｜圖片可見場次覆蓋 ${Math.min(finalMatched, expectedCount)}/${expectedCount}`;
    const modelText = models.size ? `｜模型 ${[...models].join('、')}` : '';
    const partialText = failures.length ? `｜${failures.length} 個重試訊息` : '';
    setVisionStatus(`辨識完成 ${merged.length} 場${completenessText}${modelText}${partialText}；開始自動分析所有有效盤口`);
    await autoAnalyzeAll(merged, failures);
  }'''
t = t[:start] + recognize + t[end:]
p.write_text(t)

# ---------------------------------------------------------------------------
# Versions and durable smoke assertions.
# ---------------------------------------------------------------------------
for file, old, new in [
    ('app/api/health/route.js', "version: '8.2.1'", "version: '8.2.2'"),
    ('package.json', '"version": "8.2.1"', '"version": "8.2.2"'),
]:
    p = Path(file)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'{file}: version marker missing')
    p.write_text(text.replace(old, new, 1))

Path('DEPLOYMENT_VERSION').write_text('8.2.2-efficient-vision-score-cache\n')

p = Path('scripts/test.mjs')
t = p.read_text().replace('assert.match(VISION_VERSION, /v8\\.2\\.1$/);', 'assert.match(VISION_VERSION, /v8\\.2\\.2$/);')
p.write_text(t)

p = Path('scripts/smoke.mjs')
t = p.read_text()
t = t.replace("const VERSION = '8.2.1';", "const VERSION = '8.2.2';")
t = t.replace("const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.1';", "const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.2';")
t = t.replace('/第\\s*8\\.2\\.0\\s*版/', '/第\\s*8\\.2\\.2\\s*版/')
p.write_text(t)

p = Path('README.md')
t = p.read_text().replace('# MLB 長期正期望值分析｜第 8.2.1 版', '# MLB 長期正期望值分析｜第 8.2.2 版', 1)
t += '''\n\n### 8.2.2 單次辨識、速率限制保護與舊分數清除\n\n密集盤口改成兩個重疊高解析半圖於單一多模態請求中合併辨識，不再對同一張圖片連續送出九個裁切請求。場次 ids 與四市場在同一回應完成；只有確實缺場才補掃一次。供應商回傳 429 時立即停止模型輪詢，前端依 Retry-After 自動重試並以 session 雜湊快取相同圖片結果，避免重複耗用。舊版 0／10 或未通過 GPT-COMPOSITE-EVIDENCE-v8.2 驗算的分析快照會在載入時自動移除，不再混入新版結果。\n'''
p.write_text(t)

print('v8.2.2 efficient vision patch applied')
