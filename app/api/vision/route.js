import { NextResponse } from 'next/server';

const DEFAULT_MODEL = process.env.AI_MODEL || 'google/gemini-2.5-flash';

function extractJson(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch {}
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch {} }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  throw new Error('AI 回傳內容不是有效 JSON');
}

export async function POST(req) {
  try {
    const key = process.env.AI_GATEWAY_API_KEY;
    if (!key) return NextResponse.json({ ok: false, error: 'AI_GATEWAY_API_KEY 尚未設定' }, { status: 500 });
    const body = await req.json();
    const images = Array.isArray(body?.images) ? body.images.slice(0, 8) : [];
    if (!images.length) return NextResponse.json({ ok: false, error: '沒有收到圖片' }, { status: 400 });

    const prompt = `你是台灣信用盤 MLB 盤口辨識器。只做圖片資料擷取，不做投注推薦。
請從所有圖片中擷取 MLB 場次與四個市場：全場讓分、全場大小、上半讓分、上半大小。
台灣盤口字串務必原樣保留，例如 讓1平、1+50、1-20、0-70、8+50、8-30、受讓2+15。
每個市場最多輸出兩個 directions，依圖片實際看到的兩邊填入；若只看到一邊，第二個 directions 的 pick 請留空，不要捏造。
水位若圖片有 0.940/0.950 等則保留；若沒看到，water=null。每一格提供 confidence 0~1。
只回 JSON：{"games":[{"away":"","home":"","confidence":0,"markets":[{"market":"全場讓分","directions":[{"pick":"","water":0.95,"confidence":0},{"pick":"","water":0.95,"confidence":0}]},{"market":"全場大小","directions":[]},{"market":"上半讓分","directions":[]},{"market":"上半大小","directions":[]}]}]}`;

    const content = [{ type: 'text', text: prompt }];
    for (const url of images) content.push({ type: 'image_url', image_url: { url } });
    const r = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: DEFAULT_MODEL, messages: [{ role: 'user', content }], temperature: 0, max_tokens: 4000 })
    });
    const raw = await r.text();
    if (!r.ok) throw new Error(`AI Gateway ${r.status}: ${raw.slice(0, 500)}`);
    const j = JSON.parse(raw);
    const parsed = extractJson(j?.choices?.[0]?.message?.content || '');
    return NextResponse.json({ ok: true, model: DEFAULT_MODEL, parsed });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500 });
  }
}
