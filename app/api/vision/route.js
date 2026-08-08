import { NextResponse } from 'next/server';
import { normalizeVisionGame } from '../../../lib/markets.js';
import { buildVisionPrompt, cleanVisionJSON, matchScheduleGame, normalizeTeamName } from '../../../lib/vision.js';
import { checkRateLimit, cleanText, originErrorResponse, rateLimitResponse, readJsonBody, requireApiAuth, validateSameOrigin, positiveInteger } from '../../../lib/security.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const MODEL = process.env.AI_MODEL || 'google/gemini-2.5-flash';
const DATA_URL = /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const TOKEN_SOURCE = '(\\d+(?:\\.\\d+)?(?:\/\\d+(?:\\.\\d+)?)?(?:平|[+-]\\d{1,3})?)';
const WATER_RE = /(?:^|[^\d])(0?\.\d{2,3}|1\.\d{2,3})(?!\d)/g;

function waters(line) {
  return [...String(line || '').matchAll(WATER_RE)].map(match => Number(match[1])).filter(value => Number.isFinite(value) && value >= 0.5 && value <= 1.5);
}

function containsTeam(line, team) {
  const left = normalizeTeamName(line), right = normalizeTeamName(team);
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
  return { favoriteSide, line: token, favoriteWater: values[0] ?? null, underdogWater: values[1] ?? values[0] ?? null, confidence: favoriteSide ? 1 : 0.55 };
}

function parseTotalLine(line) {
  const token = String(line || '').match(new RegExp(`(?:大|小)${TOKEN_SOURCE}`, 'i'))?.[1] || '';
  if (!token) return { line: '', overWater: null, underWater: null, confidence: 0 };
  const values = waters(line);
  return { line: token, overWater: values[0] ?? null, underWater: values[1] ?? values[0] ?? null, confidence: 1 };
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

async function gateway(key, content, useJsonFormat = true, timeoutMs = 45000) {
  const body = { model: MODEL, messages: [{ role: 'user', content }], temperature: 0, max_tokens: 6500 };
  if (useJsonFormat) body.response_format = { type: 'json_object' };
  let response;
  try {
    response = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (/Timeout|Abort/i.test(String(error?.name || error?.message || error))) {
      const timeout = new Error('人工智慧辨識逾時，請重試'); timeout.code = 'timeout'; throw timeout;
    }
    const network = new Error('人工智慧服務連線失敗，請稍後重試'); network.code = 'network'; throw network;
  }
  const raw = await response.text();
  if (!response.ok) {
    console.error('AI Gateway error', response.status, raw.slice(0, 240));
    const error = new Error('人工智慧服務暫時無法使用');
    error.status = response.status;
    if (response.status === 400 && /response[_ -]?format|json[_ -]?object|unsupported|invalid/i.test(raw)) error.code = 'response_format';
    else if (response.status === 429) { error.code = 'rate_limited'; error.message = '人工智慧服務目前請求過多，請稍後重試'; }
    else if (response.status === 401 || response.status === 403) { error.code = 'auth'; error.message = '人工智慧服務授權失敗，請檢查金鑰'; }
    throw error;
  }
  const payload = JSON.parse(raw);
  return payload?.choices?.[0]?.message?.content || '';
}

async function generateAndParse(key, content, prompt) {
  let output;
  try {
    output = await gateway(key, content, true, 45000);
  } catch (error) {
    if (error?.code !== 'response_format') throw error;
    output = await gateway(key, content, false, 45000);
  }
  try {
    return cleanVisionJSON(output);
  } catch {
    const retry = [{ type: 'text', text: `${prompt}\n上一個回答格式損壞。這次只回完整合法 JSON，且不要省略最後括號。` }, ...content.slice(1)];
    return cleanVisionJSON(await gateway(key, retry, false, 12000));
  }
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'vision', limit: 12, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 3_900_000);
    const images = Array.isArray(body.images) ? body.images.slice(0, 2) : [];
    const text = cleanText(body.text, 40000);
    const schedule = (Array.isArray(body.schedule) ? body.schedule : []).slice(0, 25).map(game => ({
      gamePk: positiveInteger(game?.gamePk),
      away: cleanText(game?.away, 80), home: cleanText(game?.home, 80),
      awayEnglish: cleanText(game?.awayEnglish, 80), homeEnglish: cleanText(game?.homeEnglish, 80),
      gameDate: cleanText(game?.gameDate, 40), status: cleanText(game?.status, 60), venue: cleanText(game?.venue, 100),
      awayTeamId: positiveInteger(game?.awayTeamId), homeTeamId: positiveInteger(game?.homeTeamId),
      awayProbableId: positiveInteger(game?.awayProbableId), homeProbableId: positiveInteger(game?.homeProbableId), venueId: positiveInteger(game?.venueId),
      awayProbable: cleanText(game?.awayProbable, 80), homeProbable: cleanText(game?.homeProbable, 80),
    })).filter(game => game.gamePk && game.away && game.home);
    if (!images.length && !text) return NextResponse.json({ ok: false, error: '沒有收到圖片或盤口文字' }, { status: 400 });
    if (images.some(value => typeof value !== 'string' || value.length > 2_800_000 || !DATA_URL.test(value))) {
      return NextResponse.json({ ok: false, error: '圖片格式或大小不符合要求，請重新選擇或裁切圖片' }, { status: 413 });
    }
    const defaultWater = Math.max(0.5, Math.min(1.5, Number(body.defaultWater) || 0.95));
    let parsed = !images.length && text ? localTextParse(text, schedule) : null;
    let model = parsed ? '本地信用盤解析器' : MODEL;
    if (!parsed) {
      const key = process.env.AI_GATEWAY_API_KEY;
      if (!key) return NextResponse.json({ ok: false, error: '人工智慧金鑰未設定' }, { status: 503 });
      const prompt = buildVisionPrompt(schedule, Boolean(text));
      const content = [{ type: 'text', text: prompt }];
      if (text) content.push({ type: 'text', text: `盤口文字：\n${text}` });
      for (const url of images) content.push({ type: 'image_url', image_url: { url } });
      parsed = await generateAndParse(key, content, prompt);
    }
    const rows = (Array.isArray(parsed?.games) ? parsed.games : []).slice(0, 30).map(raw => {
      const matched = matchScheduleGame(raw, schedule);
      return { ...normalizeVisionGame(raw, matched, defaultWater), matchedGame: matched || null };
    });
    return NextResponse.json({ ok: true, model, games: rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const timedOut = error?.code === 'timeout' || /Timeout|AbortError/i.test(String(error?.name || '')) || /timeout|逾時/i.test(String(error?.message || ''));
    const message = timedOut ? '人工智慧辨識逾時，請重試' : String(error?.message || error);
    return NextResponse.json({ ok: false, error: message }, { status: Number(error?.status) || 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
