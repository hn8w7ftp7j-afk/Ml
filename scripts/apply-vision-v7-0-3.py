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
# Front-end image quality, automatic slicing, and partial-success handling.
# ---------------------------------------------------------------------------
path = Path('app/page.js')
text = path.read_text()
text = text.replace("const VERSION = '7.0.2';", "const VERSION = '7.0.3';")

image_pipeline = r'''function canvasDataURL(canvas, quality = 0.9) {
  const webp = canvas.toDataURL('image/webp', quality);
  if (webp.startsWith('data:image/webp')) return webp;
  return canvas.toDataURL('image/jpeg', quality);
}

function renderImageCrop(image, sx, sy, sw, sh, { minimumWidth = 1500, maximumDimension = 2400 } = {}) {
  const sourceMaximum = Math.max(sw, sh);
  const desiredScale = Math.max(1, minimumWidth / Math.max(1, sw));
  const scale = Math.max(0.35, Math.min(2, maximumDimension / Math.max(1, sourceMaximum), desiredScale));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  let data = canvasDataURL(canvas, 0.9);
  if (data.length > 3_000_000) data = canvas.toDataURL('image/jpeg', 0.76);
  return data;
}

async function prepareImage(file) {
  const source = await readDataURL(file);
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      const full = renderImageCrop(image, 0, 0, image.width, image.height, { minimumWidth: 1600, maximumDimension: 2400 });
      const denseBoard = image.width >= 850 && image.height >= 500;
      if (!denseBoard) {
        resolve({ data: full, parts: [full], width: image.width, height: image.height });
        return;
      }

      const segmentCount = image.height / Math.max(1, image.width) > 1.35 ? 3 : 2;
      const cropHeight = Math.min(image.height, Math.ceil((image.height / segmentCount) * 1.36));
      const travel = Math.max(0, image.height - cropHeight);
      const positions = segmentCount === 1
        ? [0]
        : Array.from({ length: segmentCount }, (_, index) => Math.round(travel * index / (segmentCount - 1)));
      const parts = [...new Set(positions)].map(position => renderImageCrop(
        image,
        0,
        position,
        image.width,
        cropHeight,
        { minimumWidth: 1800, maximumDimension: 2300 },
      ));
      resolve({ data: full, parts: parts.length ? parts : [full], width: image.width, height: image.height });
    };
    image.onerror = () => resolve({ data: source, parts: [source], width: 0, height: 0 });
    image.src = source;
  });
}'''
text = replace_between(text, 'async function compressImage(file) {', 'async function requestJSON(', image_pipeline, 'replace image preparation')

choose_images = r'''  async function chooseImages(files) {
    const list = [...(files || [])].slice(0, 8);
    setVisionStatus('正在保留文字清晰度並分段圖片…');
    const rows = [];
    for (let index = 0; index < list.length; index += 1) {
      const file = list[index];
      const prepared = await prepareImage(file);
      rows.push({
        id: uid(),
        name: file.name,
        preview: URL.createObjectURL(file),
        data: prepared.data,
        parts: prepared.parts,
        width: prepared.width,
        height: prepared.height,
        size: file.size,
      });
      setVisionStatus(`正在處理第 ${index + 1} 張，共 ${list.length} 張；此圖分為 ${prepared.parts.length} 區塊`);
    }
    setImages(rows);
    const regions = rows.reduce((sum, row) => sum + Math.max(1, row.parts?.length || 0), 0);
    setVisionStatus(`已準備 ${rows.length} 張圖片，共 ${regions} 個清晰辨識區塊`);
  }'''
text = replace_between(text, '  async function chooseImages(files) {', '  async function recognize() {', choose_images, 'replace chooseImages')

recognize = r'''  async function recognize() {
    if (!images.length || visionBusy) return;
    setVisionBusy(true);
    const all = [];
    const failures = [];
    const models = new Set();
    const tasks = images.flatMap((image, imageIndex) => {
      const parts = Array.isArray(image.parts) && image.parts.length ? image.parts : [image.data];
      return parts.map((data, partIndex) => ({ image, imageIndex, partIndex, partCount: parts.length, data }));
    });

    try {
      for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index];
        setVisionStatus(`人工智慧辨識中：圖片 ${task.imageIndex + 1}/${images.length}，區塊 ${task.partIndex + 1}/${task.partCount}`);
        try {
          const data = await requestJSON('/api/vision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: [task.data], schedule: games, defaultWater: store.settings.fallbackWater }),
          });
          if (data.model) models.add(data.model);
          all.push(...(data.games || []));
        } catch (error) {
          failures.push(`圖片 ${task.imageIndex + 1} 區塊 ${task.partIndex + 1}：${error.message}`);
        }
      }

      const merged = mergeVision(all);
      if (!merged.length) throw new Error(failures[0] || '沒有辨識到任何場次，請改貼盤口文字或裁切更小範圍');
      setParsed(merged);
      setSelected(0);
      const modelText = models.size ? `｜${[...models].join('、')}` : '';
      const partialText = failures.length ? `｜另有 ${failures.length} 個區塊失敗，請在確認頁核對` : '';
      setVisionStatus(`辨識完成：共 ${merged.length} 場${modelText}${partialText}`);
      setTab('confirm');
    } catch (error) {
      setVisionStatus(`辨識失敗：${error.message}`);
    } finally {
      setVisionBusy(false);
    }
  }'''
text = replace_between(text, '  async function recognize() {', '  async function parseText() {', recognize, 'replace recognize')
path.write_text(text)

# ---------------------------------------------------------------------------
# Health/version/config.
# ---------------------------------------------------------------------------
path = Path('app/api/health/route.js')
text = path.read_text()
text = replace_once(text, "import { EXPERT_VERSION } from '../../../lib/expert.js';", "import { EXPERT_VERSION } from '../../../lib/expert.js';\nimport { VISION_VERSION } from '../../../lib/vision.js';", 'health vision import')
text = text.replace("version: '7.0.2'", "version: '7.0.3'")
text = replace_once(text, '    expertVersion: EXPERT_VERSION,', '    expertVersion: EXPERT_VERSION,\n    visionVersion: VISION_VERSION,', 'health vision version')
path.write_text(text)

path = Path('package.json')
path.write_text(path.read_text().replace('"version": "7.0.2"', '"version": "7.0.3"'))
Path('DEPLOYMENT_VERSION').write_text('7.0.3-vision-timeout-repair\n')

path = Path('.env.example')
text = path.read_text()
if 'AI_VISION_MODEL=' not in text:
    text = text.replace('AI_MODEL=google/gemini-2.5-flash', 'AI_MODEL=google/gemini-2.5-flash\nAI_VISION_MODEL=openai/gpt-5-nano')
path.write_text(text)

# ---------------------------------------------------------------------------
# Unit tests for compact vision JSON expansion.
# ---------------------------------------------------------------------------
path = Path('scripts/test.mjs')
text = path.read_text()
text = replace_once(text, "import { fallbackExpertAssessment, sanitizeExpertAssessment } from '../lib/expert.js';", "import { fallbackExpertAssessment, sanitizeExpertAssessment } from '../lib/expert.js';\nimport { VISION_VERSION, buildVisionPrompt, cleanVisionJSON, expandVisionPayload } from '../lib/vision.js';", 'test vision import')
marker = "assert.equal(vision.markets[2].directions[0].pick, '');"
addition = r'''

const compactVision = expandVisionPayload(cleanVisionJSON(JSON.stringify({
  g: [{
    id: 99,
    a: away,
    h: home,
    c: 0.91,
    fr: ['away', '1+50', 0.95, null, 0.88],
    ft: ['8+50', 0.94, 0.94, 0.92],
    r5: null,
    t5: ['4+20', 0.93, null, 0.7],
  }],
})));
assert.equal(compactVision.games.length, 1);
assert.equal(compactVision.games[0].gamePk, 99);
assert.equal(compactVision.games[0].fullRunline.favoriteSide, 'away');
assert.equal(compactVision.games[0].fullRunline.underdogWater, null);
assert.equal(compactVision.games[0].fullTotal.line, '8+50');
assert.equal(compactVision.games[0].first5Runline.line, '');
assert.ok(buildVisionPrompt([{ gamePk: 99, away, home }]).includes('"g"'));
assert.match(VISION_VERSION, /v7\.0\.3$/);'''
text = replace_once(text, marker, marker + addition, 'unit vision assertions')
path.write_text(text)

# ---------------------------------------------------------------------------
# Production smoke: verify real remote image recognition, not only text paths.
# ---------------------------------------------------------------------------
path = Path('scripts/smoke.mjs')
text = path.read_text()
text = replace_once(text, "import assert from 'node:assert/strict';", "import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';", 'smoke fs import')
text = text.replace("const VERSION = '7.0.2';", "const VERSION = '7.0.3';")
text = replace_once(text, "const EXPERT_VERSION = 'GPT-MLB-RESEARCH-LAYER-2026-08-v2.2';", "const EXPERT_VERSION = 'GPT-MLB-RESEARCH-LAYER-2026-08-v2.2';\nconst VISION_VERSION = 'MLB-VISION-2026-08-v7.0.3';", 'smoke vision version')
text = replace_once(text, '        && value.expertVersion === EXPERT_VERSION', '        && value.expertVersion === EXPERT_VERSION\n        && value.visionVersion === VISION_VERSION', 'wait vision version')
text = replace_once(text, 'assert.equal(health.expertVersion, EXPERT_VERSION);', 'assert.equal(health.expertVersion, EXPERT_VERSION);\nassert.equal(health.visionVersion, VISION_VERSION);', 'health vision assertion')
text = text.replace('/第\\s*7\\.0\\.2\\s*版/', '/第\\s*7\\.0\\.3\\s*版/')
origin_marker = "const originHeaders = { 'Content-Type': 'application/json', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };"
vision_smoke = origin_marker + r'''
const visionFixture = readFileSync(new URL('./fixtures/vision-table.b64', import.meta.url), 'utf8').trim();
const visionSchedule = [{
  gamePk: 990001,
  away: '克里夫蘭守護者',
  home: '芝加哥白襪',
  awayEnglish: 'Cleveland Guardians',
  homeEnglish: 'Chicago White Sox',
  gameNumber: 1,
  scheduledInnings: 9,
}];
const visionCapture = await json(`${BASE}/api/vision`, {
  method: 'POST',
  headers: originHeaders,
  body: JSON.stringify({
    images: [`data:image/png;base64,${visionFixture}`],
    schedule: visionSchedule,
    defaultWater: { 全場讓分: 0.95, 全場大小: 0.94, 上半讓分: 0.94, 上半大小: 0.93 },
  }),
}, 150000);
assert.equal(visionCapture.value.visionVersion, VISION_VERSION);
assert.ok(visionCapture.value.model && visionCapture.value.model !== '本地信用盤解析器');
const visionGame = visionCapture.value.games.find(row => Number(row.gamePk) === 990001);
assert.ok(visionGame, '遠端圖片辨識未配對測試賽事');
const visionPicks = (visionGame.markets || []).flatMap(row => row.directions || []).map(row => row.pick).filter(Boolean);
assert.ok(visionPicks.length >= 4, '遠端圖片辨識未取得足夠盤口');
assert.ok(visionPicks.some(pick => pick.includes('8+50') || pick.includes('1+15')), '遠端圖片辨識未讀到核心盤口數字');'''
text = replace_once(text, origin_marker, vision_smoke, 'production vision smoke')
text = replace_once(text, '  expertModel: expertAnalyzed.value.expertAssessment.model,', '  expertModel: expertAnalyzed.value.expertAssessment.model,\n  visionModel: visionCapture.value.model,\n  visionPicks: visionPicks.length,', 'smoke vision output')
path.write_text(text)

# ---------------------------------------------------------------------------
# Documentation.
# ---------------------------------------------------------------------------
path = Path('README.md')
text = path.read_text()
text = text.replace('第 7.0.2 版', '第 7.0.3 版', 1)
text += '''

## 7.0.3 圖片盤口辨識修復

上傳圖片不再把整張密集盤口表壓縮成低畫質後交給單一模型等待 45 秒。手機端會保留文字清晰度，針對密集或長圖自動切成 2～3 個重疊區塊；每個區塊獨立辨識並合併重複場次，部分區塊失敗時仍保留其他成功結果。

後端改用短鍵 JSON，降低十多場盤口的輸出長度；優先使用 `AI_VISION_MODEL` 或 GPT-5 nano，逾時會在 60 秒函式期限內切換其他模型。損壞 JSON 只做文字修復，不再重新傳送圖片。Production smoke 會送入合成信用盤圖片，確認正式站真的能完成遠端視覺辨識。
'''
path.write_text(text)

print('vision v7.0.3 patch applied')
