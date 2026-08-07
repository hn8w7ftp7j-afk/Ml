import { NextResponse } from 'next/server';
import { normalizeVisionGame } from '../../../lib/markets.js';
import { buildVisionPrompt, cleanVisionJSON, matchScheduleGame } from '../../../lib/vision.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const MODEL = process.env.AI_MODEL || 'google/gemini-2.5-flash';

async function gateway(key, content, useJsonFormat = true) {
  const body = { model: MODEL, messages: [{ role: 'user', content }], temperature: 0, max_tokens: 6500 };
  if (useJsonFormat) body.response_format = { type: 'json_object' };
  const r = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(26000),
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`AI Gateway ${r.status}: ${raw.slice(0, 400)}`);
  const j = JSON.parse(raw);
  return j?.choices?.[0]?.message?.content || '';
}

async function generateAndParse(key, content, prompt) {
  let output;
  try {
    output = await gateway(key, content, true);
  } catch (error) {
    if (!/400|response_format|unsupported|invalid/i.test(String(error?.message || error))) throw error;
    output = await gateway(key, content, false);
  }
  try {
    return cleanVisionJSON(output);
  } catch {
    const retry = [{ type: 'text', text: `${prompt}\n上一個回答 JSON 格式損壞。這次只回完整合法 JSON，且不要省略最後的括號。` }, ...content.slice(1)];
    return cleanVisionJSON(await gateway(key, retry, false));
  }
}

export async function POST(req) {
  try {
    const key = process.env.AI_GATEWAY_API_KEY;
    if (!key) return NextResponse.json({ ok: false, error: 'AI Gateway 金鑰未設定' }, { status: 500 });
    const body = await req.json();
    const images = Array.isArray(body?.images) ? body.images.slice(0, 2) : [];
    const text = String(body?.text || '').trim();
    const schedule = Array.isArray(body?.schedule) ? body.schedule.slice(0, 25) : [];
    if (!images.length && !text) return NextResponse.json({ ok: false, error: '沒有收到圖片或盤口文字' }, { status: 400 });
    if (images.some(x => typeof x !== 'string' || x.length > 3_000_000)) return NextResponse.json({ ok: false, error: '圖片資料過大，請重新選擇或裁切圖片' }, { status: 413 });

    const prompt = buildVisionPrompt(schedule, Boolean(text));
    const content = [{ type: 'text', text: prompt }];
    if (text) content.push({ type: 'text', text: `盤口文字：\n${text}` });
    for (const url of images) content.push({ type: 'image_url', image_url: { url } });
    const parsed = await generateAndParse(key, content, prompt);
    const rows = (Array.isArray(parsed?.games) ? parsed.games : []).map(raw => {
      const matched = matchScheduleGame(raw, schedule);
      return { ...normalizeVisionGame(raw, matched, Number(body?.defaultWater || .95)), matchedGame: matched || null };
    });
    return NextResponse.json({ ok: true, model: MODEL, games: rows });
  } catch (error) {
    const name = String(error?.name || '');
    const message = /Timeout/i.test(name) ? 'AI 辨識逾時，請重試' : String(error?.message || error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
