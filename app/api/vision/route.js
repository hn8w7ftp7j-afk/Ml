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

    const prompt = `你是台灣信用盤 MLB 盤口表格的高精度視覺資料擷取器。只做圖片資料擷取，不做投注推薦，不推測圖片中不存在的數字。

目標：逐場讀取圖片中的 MLB 信用盤，輸出四個市場，每個市場固定兩個方向：全場讓分、全場大小、上半讓分、上半大小。

重要讀表規則：
1. 先辨識每一場的兩支球隊與同一橫列的資料，絕對不可把相鄰場次的盤口混在一起。
2. 台灣信用盤通常一個市場只有一個盤口數字顯示在其中一側；另一側可能只顯示方向文字或留白。你必須依同一市場的對向關係補齊「方向」，但不可捏造新的盤口數字。
3. 讓分市場：若圖片顯示一方「1+75」，另一方即為相反方向的同一條讓分合約。請輸出可讀的兩邊，例如「主隊讓1+75」與「客隊受讓1+75」；若無法可靠判斷哪隊讓分，pick 留空並降低 confidence，不能只輸出裸的「1+75」。
4. 大小市場：例如圖片顯示「5+80」且左右列分別代表大/小，請輸出「大5+80」與「小5+80」，不能輸出一邊「5+80大」而另一邊只有「小」。全場大小同理。
5. 盤口字串必須保留台灣格式，例如：讓1平、受讓1平、讓1+50、受讓1+50、讓1-20、受讓1-20、0-70、0+70、大8+50、小8+50、大8-30、小8-30。
6. 不要把水位併進 pick。水位只能放 water。圖片若顯示 0.940 / 0.950 / 0.930，輸出數值 0.94 / 0.95 / 0.93。
7. 四個 markets 必須固定存在；每個 market 的 directions 必須固定兩筆。看不清楚時使用 pick:"", water:null, confidence 低值，不可省略陣列元素。
8. 對向一致性檢查：同一大小盤兩邊的總分線必須相同；同一讓分盤兩邊必須是讓/受讓的相反方向。若輸出不符合，請在回 JSON 前自行修正。
9. 禁止輸出只有「大」「小」「讓」「受讓」而沒有盤口數字的 pick；若盤口數字真的看不清楚，該 pick 應留空。
10. 球隊名稱盡量輸出 MLB 英文正式名稱；不確定可保留圖片縮寫，但不得猜錯隊伍。

只回 JSON，不要 markdown，不要解釋。格式必須完全符合：
{"games":[{"away":"","home":"","confidence":0,"markets":[{"market":"全場讓分","directions":[{"pick":"","water":null,"confidence":0},{"pick":"","water":null,"confidence":0}]},{"market":"全場大小","directions":[{"pick":"","water":null,"confidence":0},{"pick":"","water":null,"confidence":0}]},{"market":"上半讓分","directions":[{"pick":"","water":null,"confidence":0},{"pick":"","water":null,"confidence":0}]},{"market":"上半大小","directions":[{"pick":"","water":null,"confidence":0},{"pick":"","water":null,"confidence":0}]}]}]}`;

    const content = [{ type: 'text', text: prompt }];
    for (const url of images) content.push({ type: 'image_url', image_url: { url } });
    const r = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: DEFAULT_MODEL, messages: [{ role: 'user', content }], temperature: 0, max_tokens: 6000 })
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
