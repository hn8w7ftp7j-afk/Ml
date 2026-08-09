from pathlib import Path
import re


def one(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)


def between(text, start, end, replacement, label):
    left = text.find(start)
    if left < 0:
        raise SystemExit(f'{label}: start missing')
    right = text.find(end, left)
    if right < 0:
        raise SystemExit(f'{label}: end missing')
    return text[:left] + replacement.rstrip() + '\n\n' + text[right:]

# ---------------------------------------------------------------------------
# lib/markets.js: exact CEV score, mirrored Taiwan tails, coherent vision rows
# ---------------------------------------------------------------------------
p = Path('lib/markets.js')
t = p.read_text()
score = r'''export function scoreFromCompositeEV(cev, options = {}) {
  const conservative = Number.isFinite(Number(cev)) ? Number(cev) : 0;
  const weightedEV = Number.isFinite(Number(options.weightedEV)) ? Number(options.weightedEV) : conservative;
  const robustEV = Number.isFinite(Number(options.robustEV)) ? Number(options.robustEV) : conservative;
  const integrityWarning = Boolean(options.integrityWarning || options.distributionInvalid);
  const waterEstimated = Boolean(options.waterEstimated);

  // Authoritative MLB execution rule: CEV is the EV posterior 20th percentile.
  let score = clamp(5 + 50 * conservative, 0, 10);
  if (integrityWarning || waterEstimated) score = Math.min(score, 6.6);
  else if (weightedEV <= 0) score = Math.min(score, 6.6);
  else if (robustEV <= 0) score = Math.min(score, 7.1);
  return score;
}'''
t = between(t, 'export function scoreFromCompositeEV(', '// Backward-compatible wrapper', score, 'replace score function')

mirror_helpers = r'''export function mirrorTaiwanLineToken(value) {
  const token = String(value || '').replace(/\s+/g, '');
  const match = token.match(/^(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(平|[+-]\d{1,3})?$/);
  if (!match) return '';
  const base = match[1];
  const modifier = match[2] || '';
  if (!modifier || modifier === '平') return `${base}${modifier}`;
  return `${base}${modifier[0] === '+' ? '-' : '+'}${modifier.slice(1)}`;
}

function sameTaiwanLineBase(leftPick, rightPick) {
  const left = parseTaiwanLine(leftPick);
  const right = parseTaiwanLine(rightPick);
  if (!left.valid || !right.valid || left.legs.length !== right.legs.length) return false;
  return left.legs.every((value, index) => Math.abs(value - right.legs[index]) < 1e-9);
}

function mirroredTaiwanPair(leftPick, rightPick) {
  const left = extractLineToken(leftPick);
  const right = extractLineToken(rightPick);
  return Boolean(left && right && mirrorTaiwanLineToken(left) === right);
}'''
t = one(t, 'export function marketIsOpen(directions) {', mirror_helpers + '\n\nexport function marketIsOpen(directions) {', 'insert mirror helpers')

t = t.replace("      if (extractLineToken(rows[0].pick) !== extractLineToken(rows[1].pick)) errors.push('大小盤兩邊總分線不一致');", "      if (!sameTaiwanLineBase(rows[0].pick, rows[1].pick)) errors.push('大小盤兩邊總分線不一致');\n      else if (!mirroredTaiwanPair(rows[0].pick, rows[1].pick)) errors.push('大小盤正反方向尾數必須鏡像');")
t = t.replace("      if (extractLineToken(rows[0].pick) !== extractLineToken(rows[1].pick)) errors.push('讓分盤兩邊盤口不一致');", "      if (!sameTaiwanLineBase(rows[0].pick, rows[1].pick)) errors.push('讓分盤兩邊盤口不一致');\n      else if (!mirroredTaiwanPair(rows[0].pick, rows[1].pick)) errors.push('讓分盤正反方向尾數必須鏡像');")

normalize = r'''export function normalizeVisionGame(raw, scheduleGame = null, defaultWater = null) {
  const away = scheduleGame?.away || String(raw?.away || '').slice(0, 80);
  const home = scheduleGame?.home || String(raw?.home || '').slice(0, 80);
  const marketMap = [
    ['全場讓分', raw?.fullRunline, 0.95],
    ['全場大小', raw?.fullTotal, 0.94],
    ['上半讓分', raw?.first5Runline, 0.94],
    ['上半大小', raw?.first5Total, 0.93],
  ];

  const markets = marketMap.map(([market, value, standardFallback]) => {
    const fallback = fallbackForMarket(defaultWater, market, standardFallback);
    if (market.includes('大小')) {
      const line = cleanVisionLine(value?.line);
      if (!line || !plausibleMarketLine(market, `大${line}`)) return { market, directions: [{ pick: '', water: null, confidence: 0, integrityError: line ? '盤口數值疑似辨識錯欄' : '' }, { pick: '', water: null, confidence: 0, integrityError: line ? '盤口數值疑似辨識錯欄' : '' }] };
      const oppositeLine = mirrorTaiwanLineToken(line);
      const overActual = hasActualWater(value?.overWater);
      const underActual = hasActualWater(value?.underWater);
      const estimateBoth = !overActual && !underActual;
      return {
        market,
        directions: [
          { pick: `大${line}`, ...visionWater(value?.overWater, fallback, estimateBoth), confidence: clamp(Number(value?.confidence || 0), 0, 1) },
          { pick: `小${oppositeLine}`, ...visionWater(value?.underWater, fallback, estimateBoth), confidence: clamp(Number(value?.confidence || 0), 0, 1) },
        ],
      };
    }

    const line = cleanVisionLine(value?.line);
    const lineSide = value?.lineSide || value?.listedSide || value?.favoriteSide;
    const favorite = lineSide === 'away' ? away : lineSide === 'home' ? home : '';
    const underdog = lineSide === 'away' ? home : lineSide === 'home' ? away : '';
    if (!line || !favorite || !underdog || !plausibleMarketLine(market, `${favorite}讓${line}`)) return { market, directions: [{ pick: '', water: null, confidence: 0, integrityError: line ? '盤口方向或數值疑似辨識錯欄' : '' }, { pick: '', water: null, confidence: 0, integrityError: line ? '盤口方向或數值疑似辨識錯欄' : '' }] };

    const awayWater = hasActualWater(value?.awayWater) ? Number(value.awayWater) : null;
    const homeWater = hasActualWater(value?.homeWater) ? Number(value.homeWater) : null;
    const favoriteWater = lineSide === 'away' ? awayWater : homeWater;
    const underdogWater = lineSide === 'away' ? homeWater : awayWater;
    const resolvedFavoriteWater = hasActualWater(favoriteWater) ? favoriteWater : value?.favoriteWater;
    const resolvedUnderdogWater = hasActualWater(underdogWater) ? underdogWater : value?.underdogWater;
    const favoriteActual = hasActualWater(resolvedFavoriteWater);
    const underdogActual = hasActualWater(resolvedUnderdogWater);
    const estimateBoth = !favoriteActual && !underdogActual;
    const oppositeLine = mirrorTaiwanLineToken(line);
    return {
      market,
      directions: [
        { pick: `${favorite}讓${line}`, ...visionWater(resolvedFavoriteWater, fallback, estimateBoth), confidence: clamp(Number(value?.confidence || 0), 0, 1) },
        { pick: `${underdog}受讓${oppositeLine}`, ...visionWater(resolvedUnderdogWater, fallback, estimateBoth), confidence: clamp(Number(value?.confidence || 0), 0, 1) },
      ],
    };
  });

  return {
    away,
    home,
    gamePk: scheduleGame?.gamePk || raw?.gamePk || null,
    confidence: clamp(Number(raw?.confidence || 0), 0, 1),
    markets,
  };
}'''
start = t.find('export function normalizeVisionGame(')
if start < 0:
    raise SystemExit('normalizeVisionGame missing')
t = t[:start] + normalize + '\n'
p.write_text(t)

# ---------------------------------------------------------------------------
# lib/vision.js: row-oriented schema + discovery and targeted extraction
# ---------------------------------------------------------------------------
p = Path('lib/vision.js')
t = p.read_text().replace("export const VISION_VERSION = 'MLB-VISION-2026-08-v7.3.0';", "export const VISION_VERSION = 'MLB-VISION-2026-08-v8.1.0';")
compact = r'''function compactRunline(value) {
  const source = Array.isArray(value) ? {
    lineSide: value[0], line: value[1], awayWater: value[2], homeWater: value[3], confidence: value[4],
  } : value && typeof value === 'object' ? value : {};
  const lineSide = ['away', 'home'].includes(source.lineSide || source.listedSide || source.favoriteSide)
    ? (source.lineSide || source.listedSide || source.favoriteSide)
    : null;
  const favoriteWater = finiteOrNull(source.favoriteWater);
  const underdogWater = finiteOrNull(source.underdogWater);
  const awayWater = finiteOrNull(source.awayWater ?? (lineSide === 'away' ? favoriteWater : underdogWater));
  const homeWater = finiteOrNull(source.homeWater ?? (lineSide === 'home' ? favoriteWater : underdogWater));
  return {
    lineSide,
    favoriteSide: lineSide,
    line: shortText(source.line, 24),
    awayWater,
    homeWater,
    favoriteWater: lineSide === 'away' ? awayWater : lineSide === 'home' ? homeWater : favoriteWater,
    underdogWater: lineSide === 'away' ? homeWater : lineSide === 'home' ? awayWater : underdogWater,
    confidence: clamp(Number(source.confidence) || 0, 0, 1),
  };
}'''
t = between(t, 'function compactRunline(', 'function compactTotal(', compact, 'compact runline')

prompts = r'''function slateText(schedule) {
  return (schedule || []).map(game => {
    const away = game.awayEnglish ? `${game.away}/${game.awayEnglish}` : game.away;
    const home = game.homeEnglish ? `${game.home}/${game.homeEnglish}` : game.home;
    return `${game.gamePk}:${away}@${home}`;
  }).join('\n');
}

export function buildVisionDiscoveryPrompt(schedule) {
  return `你是 MLB 台灣信用盤圖片的「場次列舉器」。只找圖片中實際可見的對戰，不讀盤口、不做推薦。\n可配對賽事：\n${slateText(schedule) || '未提供'}\n\n從圖片最上方掃到最下方，回傳所有可見且能配對的 gamePk，順序與圖片一致。不能只回前幾場；局部裁切列也要盡量配對。只回 JSON：{"ids":[123,456]}`;
}

export function buildVisionPrompt(schedule, textMode = false) {
  return `你是台灣信用盤 MLB 盤口擷取器。${textMode ? '輸入含盤口文字。' : '輸入含盤口截圖。'}只擷取畫面中實際可見資料，不做推薦。\n可配對賽事：\n${slateText(schedule) || '未提供'}\n\n圖片表格欄位由左到右固定是：時間｜主客隊伍｜讓球｜大小盤｜獨贏｜一輸二贏｜上半讓球｜上半大小。獨贏與一輸二贏欄完全忽略，絕不可把其中數字當成讓分、大小或水位。\n規則：\n1. 客隊在上列、主隊在下列；awayWater 只取客隊列「讓球」欄的 0.xxx，homeWater 只取主隊列同一欄。上半讓球同理，只能取「上半讓球」欄。\n2. 非零讓分 line 印在哪一隊的列，該隊就是 lineSide／讓方；不得按球隊強弱猜。0 盤仍回傳 line 所在列。\n3. 大小 line 是大分方向的完整台灣盤尾數，例如 8-80、7+50、8平；大／小水位只能取同一大小欄的 0.xxx。\n4. line 的 +50/-80 是卡洞尾數，不是賠付水位。賠付水位是 0.940、0.950。\n5. 未開盤市場填 null；只看到一邊水位時另一邊必須 null；禁止拿相鄰欄或相鄰場補數字。\n6. 逐列輸出每一個可見對戰；部分欄位不清楚也不能漏掉整場。只回單一合法 JSON。\n\n短鍵格式：\n{"g":[{"id":gamePk,"a":"客隊","h":"主隊","c":0到1,"fr":["away或home或null","全場讓分line",客隊讓球水位或null,主隊讓球水位或null,信心],"ft":["全場大小line",大分水位或null,小分水位或null,信心],"r5":["away或home或null","上半讓分line",客隊上半讓球水位或null,主隊上半讓球水位或null,信心],"t5":["上半大小line",大分水位或null,小分水位或null,信心]}]}\n市場未開盤時該鍵填 null。`;
}

export function buildVisionTargetPrompt(schedule, targetGamePks) {
  const ids = new Set((targetGamePks || []).map(String));
  const target = (schedule || []).filter(game => ids.has(String(game.gamePk)));
  return `${buildVisionPrompt(target, false)}\n\n這是精準補掃。只輸出上述 ${target.length} 場；在整張圖片中定位各自的兩列，逐欄擷取。若某場確實不在圖片，該場不要輸出。`;
}'''
start = t.find('export function buildVisionPrompt(')
if start < 0:
    raise SystemExit('buildVisionPrompt missing')
t = t[:start] + prompts + '\n'
p.write_text(t)

# ---------------------------------------------------------------------------
# app/api/vision/route.js: full-board discovery then targeted two-game passes
# ---------------------------------------------------------------------------
p = Path('app/api/vision/route.js')
t = p.read_text()
t = t.replace('  buildVisionPrompt,', '  buildVisionDiscoveryPrompt,\n  buildVisionPrompt,\n  buildVisionTargetPrompt,')
t = t.replace("checkRateLimit(request, { id: 'vision-v7-3'", "checkRateLimit(request, { id: 'vision-v8-1'")
focused = r'''async function focusedGenerateAndParse(key, content, prompt) {
  const failures = [];
  const models = modelCandidates().slice(0, 4);
  const deadline = Date.now() + 22000;
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const remaining = deadline - Date.now();
    if (remaining < 2200) break;
    try {
      const parsed = await parseModelOutput(key, model, content, prompt, Math.min(index === 0 ? 12000 : 8000, remaining));
      if (parsed?.games?.length) return { parsed, model, failures };
      failures.push(`${model}：沒有找到目標場次`);
    } catch (error) {
      failures.push(`${model}：${String(error?.message || error)}`.slice(0, 260));
    }
  }
  return { parsed: { games: [] }, model: '', failures };
}

async function discoverVisibleGames(key, image, schedule) {
  const prompt = buildVisionDiscoveryPrompt(schedule);
  const content = [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }];
  const allowed = new Set(schedule.map(game => String(game.gamePk)));
  const failures = [];
  for (const model of modelCandidates().slice(0, 4)) {
    try {
      const output = await gateway(key, model, content, { jsonFormat: true, timeoutMs: 11000, maxTokens: 900 });
      const payload = cleanVisionJSON(output);
      const ids = unique((payload.ids || payload.gamePks || payload.games || []).map(value => typeof value === 'object' ? value.gamePk ?? value.id : value))
        .map(value => String(value))
        .filter(value => allowed.has(value));
      if (ids.length) return { ids, model, failures };
      failures.push(`${model}：場次列舉為空`);
    } catch (error) {
      failures.push(`${model}：${String(error?.message || error)}`.slice(0, 260));
    }
  }
  return { ids: [], model: '', failures };
}

async function parseBoardByTargets(key, image, schedule, requestedIds = []) {
  const discovery = requestedIds.length
    ? { ids: requestedIds.map(String), model: '指定補掃', failures: [] }
    : await discoverVisibleGames(key, image, schedule);
  const ids = discovery.ids;
  if (!ids.length) return { parsed: { games: [] }, model: discovery.model, failures: discovery.failures, discoveredGamePks: [] };
  const chunks = [];
  for (let index = 0; index < ids.length; index += 2) chunks.push(ids.slice(index, index + 2));
  const settled = await Promise.all(chunks.map(async chunk => {
    const prompt = buildVisionTargetPrompt(schedule, chunk);
    const content = [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }];
    return focusedGenerateAndParse(key, content, prompt);
  }));
  const games = settled.flatMap(result => result.parsed?.games || []);
  const models = unique([discovery.model, ...settled.map(result => result.model)]);
  const failures = [...discovery.failures, ...settled.flatMap(result => result.failures || [])];
  return { parsed: { games }, model: models.join('、'), failures, discoveredGamePks: ids };
}'''
t = one(t, 'function sanitizeDefaultWater(value) {', focused + '\n\nfunction sanitizeDefaultWater(value) {', 'insert board parser')
t = one(t, '    const completenessPass = body.completenessPass === true;', "    const completenessPass = body.completenessPass === true;\n    const boardPass = body.boardPass === true;\n    const targetGamePks = (Array.isArray(body.targetGamePks) ? body.targetGamePks : []).map(positiveInteger).filter(Boolean).slice(0, 20);", 'request flags')
t = one(t, '    let warnings = [];', '    let warnings = [];\n    let discoveredGamePks = [];', 'discovered state')
old = '''      const prompt = buildVisionPrompt(schedule, Boolean(text)) + (completenessPass ? '\n這是完整性補掃：優先確認整張圖所有可見對戰都已列出；市場看不清可 null，但任何可配對賽事都不可漏。' : '');
      const content = [{ type: 'text', text: prompt }];
      if (text) content.push({ type: 'text', text: `盤口文字：\n${text}` });
      for (const url of images) content.push({ type: 'image_url', image_url: { url } });
      const result = await generateAndParse(key, content, prompt);
      parsed = result.parsed;
      model = result.model;
      warnings = result.failures || [];'''
new = '''      if (images.length === 1 && (boardPass || targetGamePks.length)) {
        const result = await parseBoardByTargets(key, images[0], schedule, targetGamePks);
        parsed = result.parsed;
        model = result.model;
        warnings = result.failures || [];
        discoveredGamePks = result.discoveredGamePks || [];
      }
      if (!parsed?.games?.length) {
        const prompt = buildVisionPrompt(schedule, Boolean(text)) + (completenessPass ? '\n這是完整性補掃：每個可見對戰都不可漏；市場看不清可 null。' : '');
        const content = [{ type: 'text', text: prompt }];
        if (text) content.push({ type: 'text', text: `盤口文字：\n${text}` });
        for (const url of images) content.push({ type: 'image_url', image_url: { url } });
        const result = await generateAndParse(key, content, prompt);
        parsed = result.parsed;
        model = result.model;
        warnings = [...warnings, ...(result.failures || [])];
      }'''
t = one(t, old, new, 'board parse routing')
t = one(t, '      games: rows,\n      warnings,', '      games: rows,\n      discoveredGamePks,\n      warnings,', 'return discovered ids')
p.write_text(t)

# ---------------------------------------------------------------------------
# app/page.js: upload-first, narrow row strips, coherent market merge, visible coverage
# ---------------------------------------------------------------------------
p = Path('app/page.js')
t = p.read_text().replace("const VERSION = '8.0.0';", "const VERSION = '8.1.0';")
t = t.replace("const [tab, setTab] = useState('today');", "const [tab, setTab] = useState('upload');")
old = '''      const ratio = image.height / Math.max(1, image.width);
      const segmentCount = ratio > 1.7 ? 5 : ratio > 1.15 ? 4 : 3;
      const cropHeight = Math.min(image.height, Math.ceil((image.height / segmentCount) * 1.62));
      const travel = Math.max(0, image.height - cropHeight);
      const positions = segmentCount === 1
        ? [0]
        : Array.from({ length: segmentCount }, (_, index) => Math.round(travel * index / (segmentCount - 1)));
      const crops = [...new Set(positions)].map(position => renderImageCrop(
        image,
        0,
        position,
        image.width,
        cropHeight,
        { minimumWidth: 1900, maximumDimension: 2400 },
      ));'''
new = '''      const stripHeight = Math.min(image.height, Math.max(180, Math.min(310, Math.round(image.height * 0.34))));
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
      ));'''
t = one(t, old, new, 'row strip segmentation')

merge_helpers = r'''function directionQuality(direction) {
  if (!direction) return 0;
  return (String(direction.pick || '').trim() ? 4 : 0)
    + (hasActualWater(direction.water) ? 3 : 0)
    + Math.max(0, Math.min(1, Number(direction.confidence) || 0));
}

function marketQuality(row) {
  if (!row) return -100;
  const directions = Array.isArray(row.directions) ? row.directions.slice(0, 2) : [];
  const errors = validateMarketPair(row.market, directions);
  return directions.reduce((sum, direction) => sum + directionQuality(direction), 0) - errors.length * 8;
}

function mergeVisionMarket(left, right, market) {
  if (!left) return right || { market, directions: [blankDirection(), blankDirection()] };
  if (!right) return left;
  const primary = marketQuality(right) > marketQuality(left) ? right : left;
  const secondary = primary === right ? left : right;
  const directions = [0, 1].map(index => {
    const chosen = { ...blankDirection(), ...(primary.directions?.[index] || {}) };
    const other = secondary.directions?.[index];
    if (!hasActualWater(chosen.water) && other && chosen.pick === other.pick && hasActualWater(other.water)) {
      return { ...chosen, water: Number(other.water), waterEstimated: false, waterMissing: false, confidence: Math.max(Number(chosen.confidence) || 0, Number(other.confidence) || 0) };
    }
    return chosen;
  });
  return { market, directions };
}'''
t = one(t, 'function mergeVision(rows) {', merge_helpers + '\n\nfunction mergeVision(rows) {', 'insert merge quality')
old = '''      markets: MARKET_ORDER.map(market => {
        const left = previous.markets?.find(item => item.market === market);
        const right = row.markets?.find(item => item.market === market);
        return {
          market,
          directions: [0, 1].map(index => {
            const a = left?.directions?.[index];
            const b = right?.directions?.[index];
            if (!a) return b || blankDirection();
            if (!b) return a;
            return Number(b.confidence || 0) > Number(a.confidence || 0) ? b : a;
          }),
        };
      }),'''
new = '''      markets: MARKET_ORDER.map(market => mergeVisionMarket(
        previous.markets?.find(item => item.market === market),
        row.markets?.find(item => item.market === market),
        market,
      )),'''
t = one(t, old, new, 'coherent market merge')
t = one(t, '    const models = new Set();', '    const models = new Set();\n    const expectedVisible = new Set();', 'expected visible set')
t = one(t, "          body: JSON.stringify({ images: [task.data], schedule, defaultWater: store.settings.fallbackWater }),", "          body: JSON.stringify({ images: [task.data], schedule, defaultWater: store.settings.fallbackWater, boardPass: task.partIndex === 0 }),", 'board pass request')
t = one(t, '        if (data.model) models.add(data.model);\n        all.push(...(data.games || []));', "        if (data.model) models.add(data.model);\n        for (const gamePk of data.discoveredGamePks || []) expectedVisible.add(String(gamePk));\n        all.push(...(data.games || []));", 'collect discovered ids')
old_start = '    // Completeness pass: a board screenshot must not silently finish after returning only part of the visible slate.'
old_end = '    setParsed(merged);'
left = t.find(old_start)
right = t.find(old_end, left)
if left < 0 or right < 0:
    raise SystemExit('completeness block missing')
replacement = r'''    // The full-image discovery pass defines how many rows are actually visible in the uploaded board.
    let missingVisible = [...expectedVisible].filter(gamePk => !merged.some(row => String(row.gamePk || '') === gamePk));
    if (missingVisible.length) {
      setVisionStatus(`已找到 ${expectedVisible.size} 個可見對戰，正在補抓缺少的 ${missingVisible.length} 場盤口…`);
      for (const image of sourceImages) {
        if (!missingVisible.length) break;
        try {
          const data = await requestJSON('/api/vision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: [image.data], schedule, defaultWater: store.settings.fallbackWater, targetGamePks: missingVisible }),
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
      setVisionStatus(`完整性檢查未通過：圖片可見 ${expectedVisible.size} 場，目前只完成 ${expectedVisible.size - missingVisible.length} 場；未發布部分分析`);
      setTab('confirm');
      return;
    }
'''
t = t[:left] + replacement + t[right:]
t = t.replace("    const finalMatched = new Set(merged.map(row => String(row.gamePk || '')).filter(Boolean)).size;\n    const scheduleCount = (schedule || []).length;\n    const completenessText = scheduleCount ? `｜官方賽程覆蓋 ${finalMatched}/${scheduleCount}` : '';", "    const finalMatched = new Set(merged.map(row => String(row.gamePk || '')).filter(Boolean)).size;\n    const expectedCount = expectedVisible.size || finalMatched;\n    const completenessText = `｜圖片可見場次覆蓋 ${Math.min(finalMatched, expectedCount)}/${expectedCount}`;")
p.write_text(t)

# ---------------------------------------------------------------------------
# lib/analysis.js: calibrated posterior + exact CEV20 score metadata
# ---------------------------------------------------------------------------
p = Path('lib/analysis.js')
t = p.read_text()
t = t.replace("export const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.0.0';", "export const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.1.0';")
t = t.replace("export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.0.0';", "export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.1.0';")
t = t.replace("      // v8 GPT parity: market price is used for break-even/EV only. It must not overwrite the baseball model's cover probability.\n      calibration.weight = 1;\n      calibration.maximumEdge = 1;\n      calibration.divergenceRisk = 0;\n", '')
t = t.replace('        const calibratedProbability = rawSummary.modelProbability;', '''        const calibratedProbability = marketCalibratedProbability(
          rawSummary.modelProbability,
          marketAnchorProbability,
          calibration.weight,
          calibration.maximumEdge,
        );''')
t = t.replace('      const conservativeEV = Math.min(quantileEV, robust.robustEV);', '      const conservativeEV = quantileEV;')
t = t.replace('        marketCalibrationWeight: 0,', '        marketCalibrationWeight: calibration.weight,')
t = t.replace('        maximumCalibratedProbabilityEdge: null,', '        maximumCalibratedProbabilityEdge: calibration.maximumEdge,')
t = t.replace('        calibratedMarketProbabilityGap: null,', '        calibratedMarketProbabilityGap: marketAnchorProbability == null ? null : Math.abs(modelProbability - marketAnchorProbability),')
t = t.replace('        marketCalibrationApplied: false,', '        marketCalibrationApplied: marketAnchorProbability != null,')
t = t.replace("        outcomeProbabilitiesSource: 'GPT完整資料聯合情境原始比分分布（市場不回灌）',", "        outcomeProbabilitiesSource: '市場先驗與 MLB/GPT 資料調整的聯合情境後驗比分分布',")
t = t.replace('        conservativeEV,\n        rawEV,', "        conservativeEV,\n        cev: conservativeEV,\n        scoreFormulaVersion: 'CEV20-5+50x-v1',\n        rawEV,")
# Enforce the published opposite-direction invariant after score calculation.
needle = '''      const eligiblePair = pair.filter(result => result.betEligible);'''
insert = '''      if (pair.every(result => Number.isFinite(result.score) && result.score > 5.000001)) {
        for (const result of pair) {
          result.integrityWarning = true;
          result.integrityMessage = '同盤相反方向同時高於 5.0，違反 Execution 對向約束';
          result.score = null;
          result.tag = 'ENGINE FAIL｜PASS';
          result.betEligible = false;
          result.unitSuggestion = 0;
        }
      }
      const eligiblePair = pair.filter(result => result.betEligible);'''
t = one(t, needle, insert, 'opposite score invariant')
p.write_text(t)

# Versions
for file, old, new in [
  ('app/api/health/route.js', "version: '8.0.0'", "version: '8.1.0'"),
  ('package.json', '"version": "8.0.0"', '"version": "8.1.0"'),
]:
    p = Path(file); x = p.read_text(); p.write_text(x.replace(old, new))
Path('DEPLOYMENT_VERSION').write_text('8.1.0-complete-vision-gpt-parity\n')

# README
p = Path('README.md')
x = p.read_text().replace('# MLB 長期正期望值分析｜第 8.0.0 版', '# MLB 長期正期望值分析｜第 8.1.0 版', 1)
x += '''\n\n### 8.1.0 完整盤口與 GPT Execution 對齊\n\n首頁直接進入上傳，選圖後自動完成場次列舉、逐場精準盤口擷取與分析。密集表格先用整張圖列舉所有可見 gamePk，再每兩場精準補掃；未達可見場次完整覆蓋時不發布部分分析。讓分水位按客／主列讀取，大小與讓分正反方向的尾數自動鏡像（如大8-80／小8+80、讓2+60／受讓2-60）。評分唯一使用 CEV 第20百分位：Score=clip(5+50×CEV,0,10)，並保留加權EV、穩健EV、完整性與下注資格硬閘門。\n'''
p.write_text(x)

print('complete v8.1 patch applied')
