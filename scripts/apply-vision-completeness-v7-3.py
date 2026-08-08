from pathlib import Path


def one(text, old, new, label):
    if text.count(old) != 1:
        raise SystemExit(f'{label}: {text.count(old)} matches')
    return text.replace(old, new, 1)

p=Path('app/page.js'); t=p.read_text()
t=t.replace("const VERSION = '7.2.1';", "const VERSION = '7.3.0';")
# Dense boards: more overlapping horizontal bands, plus the full image as a separate pass.
old="""      const segmentCount = image.height / Math.max(1, image.width) > 1.35 ? 3 : 2;
      const cropHeight = Math.min(image.height, Math.ceil((image.height / segmentCount) * 1.36));"""
new="""      const ratio = image.height / Math.max(1, image.width);
      const segmentCount = ratio > 1.7 ? 5 : ratio > 1.15 ? 4 : 3;
      const cropHeight = Math.min(image.height, Math.ceil((image.height / segmentCount) * 1.62));"""
t=one(t,old,new,'segment count')
old="""      const parts = [...new Set(positions)].map(position => renderImageCrop(
        image,
        0,
        position,
        image.width,
        cropHeight,
        { minimumWidth: 1800, maximumDimension: 2300 },
      ));
      resolve({ data: full, parts: parts.length ? parts : [full], width: image.width, height: image.height });"""
new="""      const crops = [...new Set(positions)].map(position => renderImageCrop(
        image,
        0,
        position,
        image.width,
        cropHeight,
        { minimumWidth: 1900, maximumDimension: 2400 },
      ));
      // Full-image pass discovers every matchup; overlapping crops recover small market text.
      const parts = [full, ...crops];
      resolve({ data: full, parts, width: image.width, height: image.height });"""
t=one(t,old,new,'full image pass')
# Don't stop at one pass result; track coverage against official schedule and retry the full image if suspiciously incomplete.
old="""    const merged = mergeVision(all);
    if (!merged.length) throw new Error(failures[0] || '沒有辨識到任何場次，請改貼盤口文字或裁切更小範圍');
    setParsed(merged);"""
new="""    let merged = mergeVision(all);
    if (!merged.length) throw new Error(failures[0] || '沒有辨識到任何場次，請改貼盤口文字或裁切更小範圍');

    // Completeness pass: a board screenshot must not silently finish after returning only part of the visible slate.
    const matchedIds = new Set(merged.map(row => String(row.gamePk || '')).filter(Boolean));
    const scheduledIds = new Set((schedule || []).map(row => String(row.gamePk || '')).filter(Boolean));
    const coverage = scheduledIds.size ? matchedIds.size / scheduledIds.size : 1;
    if (sourceImages.length && merged.length < 7 && coverage < 0.70) {
      setVisionStatus(`目前只辨識 ${merged.length} 場，正在執行整張圖完整性補掃…`);
      for (let imageIndex = 0; imageIndex < sourceImages.length; imageIndex += 1) {
        try {
          const data = await requestJSON('/api/vision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: [sourceImages[imageIndex].data], schedule, defaultWater: store.settings.fallbackWater, completenessPass: true }),
          });
          if (data.model) models.add(data.model);
          all.push(...(data.games || []));
        } catch (error) {
          failures.push(`圖片 ${imageIndex + 1} 完整性補掃：${error.message}`);
        }
      }
      merged = mergeVision(all);
    }
    setParsed(merged);"""
t=one(t,old,new,'completeness retry')
# Status explicitly tells user how many official slate games were covered.
old="""    setVisionStatus(`辨識完成 ${merged.length} 場${modelText}${partialText}；開始自動分析所有有效盤口`);"""
new="""    const finalMatched = new Set(merged.map(row => String(row.gamePk || '')).filter(Boolean)).size;
    const scheduleCount = (schedule || []).length;
    const completenessText = scheduleCount ? `｜官方賽程覆蓋 ${finalMatched}/${scheduleCount}` : '';
    setVisionStatus(`辨識完成 ${merged.length} 場${completenessText}${modelText}${partialText}；開始自動分析所有有效盤口`);"""
t=one(t,old,new,'coverage status')
p.write_text(t)

# Vision prompt: force row enumeration before market extraction and return every visible matchup.
p=Path('lib/vision.js'); s=p.read_text().replace("export const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.5';", "export const VISION_VERSION = 'MLB-VISION-2026-08-v7.3.0';")
s=one(s,"6. 至少先輸出能確定的場次；無法看清的市場填 null，不可因部分欄位不清楚而放棄整場。只回單一合法 JSON，不要 Markdown、不要解釋。", "6. 先從圖片最上方一路掃到最下方，逐列列舉每一個可見對戰；每個可配對官方賽程的對戰都必須輸出一筆，即使該場部分市場看不清也不能漏掉。無法看清的市場填 null。\n7. 同一張圖若可見 7 場就必須回 7 場，不得因 token、版面密集或部分欄位不清楚只回前幾場。只回單一合法 JSON，不要 Markdown、不要解釋。",'prompt completeness')
p.write_text(s)

# API gets a dedicated completeness prompt flag and larger output budget.
p=Path('app/api/vision/route.js'); s=p.read_text()
s=s.replace("checkRateLimit(request, { id: 'vision-v7-0-5'", "checkRateLimit(request, { id: 'vision-v7-3'")
s=one(s,"    const text = cleanText(body.text, 40000);", "    const text = cleanText(body.text, 40000);\n    const completenessPass = body.completenessPass === true;",'completeness flag')
# append instruction to prompt where prompt is built
s=s.replace("const prompt = buildVisionPrompt(schedule, Boolean(text));", "const prompt = buildVisionPrompt(schedule, Boolean(text)) + (completenessPass ? '\\n這是完整性補掃：優先確認整張圖所有可見對戰都已列出；市場看不清可 null，但任何可配對賽事都不可漏。' : '');")
p.write_text(s)

# versions
for f,o,n in [('app/api/health/route.js',"version: '7.2.1'","version: '7.3.0'"),('package.json','"version": "7.2.1"','"version": "7.3.0"')]:
 p=Path(f); x=p.read_text(); p.write_text(x.replace(o,n))
Path('DEPLOYMENT_VERSION').write_text('7.3.0-vision-full-slate-completeness\n')
p=Path('README.md'); x=p.read_text().replace('# MLB 長期正期望值分析｜第 7.2.1 版','# MLB 長期正期望值分析｜第 7.3.0 版',1); x+='''\n\n### 7.3.0 整張盤口完整性辨識\n\n密集信用盤圖片改為「整張圖場次發現 + 3～5 個高解析重疊區塊」雙層辨識。整張圖先確保所有可見對戰都被列出，區塊再補盤口小字；若辨識場數相對官方賽程覆蓋明顯不足，會自動再做完整性補掃，不再把只抓到 5 場當作全部完成。\n'''; p.write_text(x)
print('vision completeness v7.3 applied')
