import { NextResponse } from 'next/server';
import { normalizeVisionGame } from '../../../lib/markets.js';
import {
  VISION_VERSION,
  buildVisionDiscoveryPrompt,
  buildVisionPrompt,
  buildVisionTargetPrompt,
  cleanVisionJSON,
  expandVisionPayload,
  matchScheduleGame,
  normalizeTeamName,
} from '../../../lib/vision.js';
import {
  checkRateLimit,
  cleanText,
  originErrorResponse,
  positiveInteger,
  rateLimitResponse,
  readJsonBody,
  requireApiAuth,
  validateSameOrigin,
} from '../../../lib/security.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const GATEWAY = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const IMAGE_DATA_URL = /^data:image\/(jpeg|jpg|png|webp);base64,([\s\S]+)$/i;
const TOKEN_SOURCE = '(\\d+(?:\\.\\d+)?(?:\/\\d+(?:\\.\\d+)?)?(?:平|[+-]\\d{1,3})?)';
const WATER_RE = /(?:^|[^\d])(0?\.\d{2,3}|1\.\d{2,3})(?!\d)/g;
const unique = values => [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];

function canonicalImageDataURL(value) {
  if (typeof value !== 'string') return '';
  const match = value.match(IMAGE_DATA_URL);
  if (!match) return '';

  let encoded = String(match[2] || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!encoded || encoded.length < 32 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return '';
  const remainder = encoded.length % 4;
  if (remainder === 1) return '';
  if (remainder) encoded += '='.repeat(4 - remainder);

  let bytes;
  try { bytes = Buffer.from(encoded, 'base64'); }
  catch { return ''; }
  if (!bytes.length || bytes.length > 2_400_000) return '';

  let mime = '';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) mime = 'png';
  else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'jpeg';
  else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'webp';
  if (!mime) return '';

  return `data:image/${mime};base64,${bytes.toString('base64')}`;
}

function waters(line) {
  return [...String(line || '').matchAll(WATER_RE)]
    .map(match => Number(match[1]))
    .filter(value => Number.isFinite(value) && value >= 0.5 && value <= 1.5);
}

function containsTeam(line, team) {
  const left = normalizeTeamName(line);
  const right = normalizeTeamName(team);
  return Boolean(left && right && (left.includes(right) || (right.length >= 2 && right.includes(left))));
}

function aliases(game, side) {
  return [game?.[side], game?.[`${side}English`]].filter(Boolean);
}

function lineContainsSide(line, game, side) {
  return aliases(game, side).some(name => containsTeam(line, name));
}

function escaped(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseRunlineLine(line, game) {
  const token = String(line || '').match(new RegExp(`(?:受讓|讓)${TOKEN_SOURCE}`, 'i'))?.[1] || '';
  if (!token) return { favoriteSide: null, line: '', favoriteWater: null, underdogWater: null, confidence: 0 };
  const beforeGiving = String(line).split(/受讓|讓/)[0] || '';
  let favoriteSide = null;
  if (lineContainsSide(beforeGiving, game, 'away')) favoriteSide = 'away';
  else if (lineContainsSide(beforeGiving, game, 'home')) favoriteSide = 'home';
  else if (aliases(game, 'away').some(name => new RegExp(`${escaped(name)}\\s*讓`, 'i').test(line))) favoriteSide = 'away';
  else if (aliases(game, 'home').some(name => new RegExp(`${escaped(name)}\\s*讓`, 'i').test(line))) favoriteSide = 'home';
  const values = waters(line);
  return {
    favoriteSide,
    line: token,
    favoriteWater: values[0] ?? null,
    underdogWater: values[1] ?? null,
    confidence: favoriteSide ? 1 : 0.55,
  };
}

function parseTotalLine(line) {
  const token = String(line || '').match(new RegExp(`(?:大|小)${TOKEN_SOURCE}`, 'i'))?.[1] || '';
  if (!token) return { line: '', overWater: null, underWater: null, confidence: 0 };
  const values = waters(line);
  return { line: token, overWater: values[0] ?? null, underWater: values[1] ?? null, confidence: 1 };
}

function localTextParse(text, schedule) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length || !schedule.length) return null;
  const headers = [];
  for (let index = 0; index < lines.length; index += 1) {
    const game = schedule.find(item => lineContainsSide(lines[index], item, 'away') && lineContainsSide(lines[index], item, 'home'));
    if (game) headers.push({ index, game });
  }
  if (!headers.length && schedule.length === 1) headers.push({ index: 0, game: schedule[0] });

  const games = [];
  for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
    const { index, game } = headers[headerIndex];
    const end = headers[headerIndex + 1]?.index ?? lines.length;
    const block = lines.slice(index, end);
    const find = patterns => block.find(line => patterns.some(pattern => pattern.test(line))) || '';
    const fullRunline = parseRunlineLine(find([/全場.*讓分/i, /全場讓分/i]), game);
    const fullTotal = parseTotalLine(find([/全場.*大小/i, /全場大小/i]));
    const first5Runline = parseRunlineLine(find([/上半.*讓分/i, /前五.*讓分/i, /前5.*讓分/i]), game);
    const first5Total = parseTotalLine(find([/上半.*大小/i, /前五.*大小/i, /前5.*大小/i]));
    if (![fullRunline.line, fullTotal.line, first5Runline.line, first5Total.line].some(Boolean)) continue;
    games.push({ gamePk: game.gamePk, away: game.away, home: game.home, confidence: 1, fullRunline, fullTotal, first5Runline, first5Total });
  }
  return games.length ? { games } : null;
}

function modelCandidates() {
  return unique([
    process.env.AI_VISION_MODEL,
    'openai/gpt-4o-mini',
    'openai/gpt-4.1-mini',
    'openai/gpt-5-nano',
    process.env.AI_MODEL,
    'google/gemini-2.5-flash',
  ]);
}

async function gateway(key, model, content, { jsonFormat = false, timeoutMs = 14000, maxTokens = 2400 } = {}) {
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
}

async function parseModelOutput(key, model, content, prompt, attemptMs) {
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
}

async function generateAndParse(key, content, prompt) {
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
}

async function focusedGenerateAndParse(key, content, prompt) {
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
      const output = await gateway(key, model, content, { jsonFormat: false, timeoutMs: 11000, maxTokens: 900 });
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
}

function sanitizeDefaultWater(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Number(item)]));
  }
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0.5, Math.min(1.5, number)) : null;
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request);
    if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'vision-v8-1', limit: 28, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);

    const body = await readJsonBody(request, 4_500_000);
    const rawImages = Array.isArray(body.images) ? body.images.slice(0, 2) : [];
    const images = rawImages.map(canonicalImageDataURL);
    const text = cleanText(body.text, 40000);
    const completenessPass = body.completenessPass === true;
    const boardPass = body.boardPass === true;
    const targetGamePks = (Array.isArray(body.targetGamePks) ? body.targetGamePks : []).map(positiveInteger).filter(Boolean).slice(0, 20);
    const schedule = (Array.isArray(body.schedule) ? body.schedule : []).slice(0, 25).map(game => ({
      gamePk: positiveInteger(game?.gamePk),
      away: cleanText(game?.away, 80),
      home: cleanText(game?.home, 80),
      awayEnglish: cleanText(game?.awayEnglish, 80),
      homeEnglish: cleanText(game?.homeEnglish, 80),
      gameDate: cleanText(game?.gameDate, 40),
      officialDate: cleanText(game?.officialDate, 20),
      status: cleanText(game?.status, 60),
      statusCode: cleanText(game?.statusCode, 10),
      doubleHeader: cleanText(game?.doubleHeader, 10),
      gameNumber: positiveInteger(game?.gameNumber) || 1,
      scheduledInnings: positiveInteger(game?.scheduledInnings) || 9,
      venue: cleanText(game?.venue, 100),
      venueEnglish: cleanText(game?.venueEnglish, 100),
      awayTeamId: positiveInteger(game?.awayTeamId),
      homeTeamId: positiveInteger(game?.homeTeamId),
      awayProbableId: positiveInteger(game?.awayProbableId),
      homeProbableId: positiveInteger(game?.homeProbableId),
      venueId: positiveInteger(game?.venueId),
      awayProbable: cleanText(game?.awayProbable, 80),
      homeProbable: cleanText(game?.homeProbable, 80),
    })).filter(game => game.gamePk && game.away && game.home);

    if (!rawImages.length && !text) return NextResponse.json({ ok: false, error: '沒有收到圖片或盤口文字' }, { status: 400 });
    if (rawImages.length !== images.filter(Boolean).length || images.some(value => value.length > 3_200_000)) {
      return NextResponse.json({ ok: false, error: '圖片格式或大小不符合要求，請重新選擇或裁切圖片' }, { status: 413 });
    }

    const defaultWater = sanitizeDefaultWater(body.defaultWater);
    let parsed = !images.length && text ? localTextParse(text, schedule) : null;
    let model = parsed ? '本地信用盤解析器' : '';
    let warnings = [];
    let discoveredGamePks = [];

    if (!parsed) {
      const key = process.env.AI_GATEWAY_API_KEY;
      if (!key) return NextResponse.json({ ok: false, error: '人工智慧金鑰未設定' }, { status: 503 });
      if (images.length === 1 && (boardPass || targetGamePks.length)) {
        const result = await parseBoardByTargets(key, images[0], schedule, targetGamePks);
        parsed = result.parsed;
        model = result.model;
        warnings = result.failures || [];
        discoveredGamePks = result.discoveredGamePks || [];
      }
      if (!parsed?.games?.length) {
        const prompt = buildVisionPrompt(schedule, Boolean(text)) + (completenessPass ? `\n這是完整性補掃：每個可見對戰都不可漏；市場看不清可 null。` : '');
        const content = [{ type: 'text', text: prompt }];
        if (text) content.push({ type: 'text', text: `盤口文字：
${text}` });
        for (const url of images) content.push({ type: 'image_url', image_url: { url } });
        const result = await generateAndParse(key, content, prompt);
        parsed = result.parsed;
        model = result.model;
        warnings = [...warnings, ...(result.failures || [])];
      }
    }

    const rows = (Array.isArray(parsed?.games) ? parsed.games : []).slice(0, 30).map(raw => {
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
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const timedOut = error?.code === 'timeout' || /Timeout|AbortError/i.test(String(error?.name || '')) || /timeout|逾時/i.test(String(error?.message || ''));
    const message = timedOut
      ? '圖片內容較密，系統已自動切換辨識模型但仍逾時；請重新上傳，系統會自動分段處理'
      : String(error?.message || error);
    const details = (Array.isArray(error?.details) ? error.details : [])
      .map(value => String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 320))
      .filter(Boolean)
      .slice(0, 8);
    return NextResponse.json({ ok: false, error: message, details }, {
      status: Number(error?.status) || (timedOut ? 504 : 500),
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
