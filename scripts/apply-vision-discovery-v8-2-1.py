from pathlib import Path


def one(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

# AI Gateway rejected response_format=json_object for multimodal discovery.
p = Path('app/api/vision/route.js')
t = p.read_text()
t = one(
    t,
    "const output = await gateway(key, model, content, { jsonFormat: true, timeoutMs: 11000, maxTokens: 900 });",
    "const output = await gateway(key, model, content, { jsonFormat: false, timeoutMs: 11000, maxTokens: 900 });",
    'discovery response format',
)
old_rows = '''    const rows = (Array.isArray(parsed?.games) ? parsed.games : []).slice(0, 30).map(raw => {
      const matched = matchScheduleGame(raw, schedule);
      return { ...normalizeVisionGame(raw, matched, defaultWater), matchedGame: matched || null };
    });

    return NextResponse.json({
      ok: true,
      model,
      visionVersion: VISION_VERSION,
      games: rows,
      discoveredGamePks,
      warnings,
    }, { headers: { 'Cache-Control': 'no-store' } });'''
new_rows = '''    const rows = (Array.isArray(parsed?.games) ? parsed.games : []).slice(0, 30).map(raw => {
      const matched = matchScheduleGame(raw, schedule);
      return { ...normalizeVisionGame(raw, matched, defaultWater), matchedGame: matched || null };
    });
    const independentDiscovery = discoveredGamePks.length > 0;
    if (!independentDiscovery) {
      discoveredGamePks = unique(rows.map(row => row.gamePk).filter(Boolean));
      if (discoveredGamePks.length) warnings.push('獨立場次列舉未完成，已使用成功配對列作完整性備援');
    }

    return NextResponse.json({
      ok: true,
      model,
      visionVersion: VISION_VERSION,
      games: rows,
      discoveredGamePks,
      discoverySource: independentDiscovery ? 'independent-board-pass' : discoveredGamePks.length ? 'matched-row-fallback' : 'unavailable',
      warnings,
    }, { headers: { 'Cache-Control': 'no-store' } });'''
t = one(t, old_rows, new_rows, 'vision discovery fallback metadata')
p.write_text(t)

p = Path('lib/vision.js')
t = p.read_text().replace("export const VISION_VERSION = 'MLB-VISION-2026-08-v8.1.0';", "export const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.1';")
p.write_text(t)

for file, old, new in [
    ('app/page.js', "const VERSION = '8.2.0';", "const VERSION = '8.2.1';"),
    ('app/api/health/route.js', "version: '8.2.0'", "version: '8.2.1'"),
    ('package.json', '"version": "8.2.0"', '"version": "8.2.1"'),
]:
    p = Path(file)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'{file}: version marker missing')
    p.write_text(text.replace(old, new, 1))

Path('DEPLOYMENT_VERSION').write_text('8.2.1-score-validation-vision-discovery\n')

p = Path('scripts/test.mjs')
t = p.read_text().replace('assert.match(VISION_VERSION, /v8\\.1\\.0$/);', 'assert.match(VISION_VERSION, /v8\\.2\\.1$/);')
p.write_text(t)

p = Path('scripts/smoke.mjs')
t = p.read_text()
t = t.replace("const VERSION = '8.2.0';", "const VERSION = '8.2.1';")
t = t.replace("const VISION_VERSION = 'MLB-VISION-2026-08-v8.1.0';", "const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.1';")
p.write_text(t)

p = Path('README.md')
t = p.read_text().replace('# MLB 長期正期望值分析｜第 8.2.0 版', '# MLB 長期正期望值分析｜第 8.2.1 版', 1)
t += '''\n\n### 8.2.1 圖片完整性列舉修復\n\n修正 AI Gateway 對多模態場次列舉使用 response_format 時回傳 Invalid input 的問題。獨立場次列舉改用一般多模態輸出後再做嚴格 JSON 清理；若供應商暫時無法完成列舉，API 會以成功配對的場次列作備援並明確標示 discoverySource，不再回傳空白完整性數據。Production smoke 必須以七場密集盤口圖驗證 7/7 場次、四市場盤口與評分驗算。\n'''
p.write_text(t)

print('vision discovery v8.2.1 patch applied')
