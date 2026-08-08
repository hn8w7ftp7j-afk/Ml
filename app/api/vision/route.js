import { NextResponse } from 'next/server';
import { normalizeVisionGame } from '../../../lib/markets.js';
import { buildVisionPrompt, cleanVisionJSON, matchScheduleGame } from '../../../lib/vision.js';
import { checkRateLimit, cleanText, originErrorResponse, rateLimitResponse, readJsonBody, requireApiAuth, validateSameOrigin, positiveInteger } from '../../../lib/security.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const MODEL = process.env.AI_MODEL || 'google/gemini-2.5-flash';
const DATA_URL = /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/;

async function gateway(key, content, useJsonFormat = true) {
  const body = { model: MODEL, messages: [{ role: 'user', content }], temperature: 0, max_tokens: 6500 };
  if (useJsonFormat) body.response_format = { type: 'json_object' };
  const response = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(26000),
  });
  const raw = await response.text();
  if (!response.ok) {
    console.error('AI Gateway error', response.status, raw.slice(0, 200));
    if (response.status === 429) throw new Error('AI 服務目前請求過多，請稍後重試');
    if (response.status === 401 || response.status === 403) throw new Error('AI 服務授權失敗，請檢查金鑰');
    throw new Error('AI 服務暫時無法使用');
  }
  const payload = JSON.parse(raw);
  return payload?.choices?.[0]?.message?.content || '';
}

async function generateAndParse(key, content, prompt) {
  let output;
  try {
    output = await gateway(key, content, true);
  } catch (error) {
    if (!/response_format|unsupported|invalid/i.test(String(error?.message || error))) throw error;
    output = await gateway(key, content, false);
  }
  try {
    return cleanVisionJSON(output);
  } catch {
    const retry = [{ type: 'text', text: `${prompt}\n上一個回答 JSON 格式損壞。這次只回完整合法 JSON，且不要省略最後的括號。` }, ...content.slice(1)];
    return cleanVisionJSON(await gateway(key, retry, false));
  }
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request); if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'vision', limit: 12, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const key = process.env.AI_GATEWAY_API_KEY;
    if (!key) return NextResponse.json({ ok: false, error: 'AI Gateway 金鑰未設定' }, { status: 503 });
    const body = await readJsonBody(request, 3_900_000);
    const images = Array.isArray(body.images) ? body.images.slice(0, 2) : [];
    const text = cleanText(body.text, 40000);
    const schedule = (Array.isArray(body.schedule) ? body.schedule : []).slice(0, 25).map(game => ({
      gamePk: positiveInteger(game?.gamePk), away: cleanText(game?.away, 80), home: cleanText(game?.home, 80),
      gameDate: cleanText(game?.gameDate, 40), status: cleanText(game?.status, 60), venue: cleanText(game?.venue, 100),
      awayTeamId: positiveInteger(game?.awayTeamId), homeTeamId: positiveInteger(game?.homeTeamId),
      awayProbableId: positiveInteger(game?.awayProbableId), homeProbableId: positiveInteger(game?.homeProbableId), venueId: positiveInteger(game?.venueId),
      awayProbable: cleanText(game?.awayProbable, 80), homeProbable: cleanText(game?.homeProbable, 80),
    })).filter(game => game.gamePk && game.away && game.home);
    if (!images.length && !text) return NextResponse.json({ ok: false, error: '沒有收到圖片或盤口文字' }, { status: 400 });
    if (images.some(value => typeof value !== 'string' || value.length > 2_800_000 || !DATA_URL.test(value))) {
      return NextResponse.json({ ok: false, error: '圖片格式或大小不符合要求，請重新選擇或裁切圖片' }, { status: 413 });
    }
    const prompt = buildVisionPrompt(schedule, Boolean(text));
    const content = [{ type: 'text', text: prompt }];
    if (text) content.push({ type: 'text', text: `盤口文字：\n${text}` });
    for (const url of images) content.push({ type: 'image_url', image_url: { url } });
    const parsed = await generateAndParse(key, content, prompt);
    const defaultWater = Math.max(0.5, Math.min(1.5, Number(body.defaultWater) || 0.95));
    const rows = (Array.isArray(parsed?.games) ? parsed.games : []).slice(0, 30).map(raw => {
      const matched = matchScheduleGame(raw, schedule);
      return { ...normalizeVisionGame(raw, matched, defaultWater), matchedGame: matched || null };
    });
    return NextResponse.json({ ok: true, model: MODEL, games: rows }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const timedOut = /Timeout|AbortError/i.test(String(error?.name || '')) || /timeout|逾時/i.test(String(error?.message || ''));
    const message = timedOut ? 'AI 辨識逾時，請重試' : String(error?.message || error);
    return NextResponse.json({ ok: false, error: message }, { status: Number(error?.status) || 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
