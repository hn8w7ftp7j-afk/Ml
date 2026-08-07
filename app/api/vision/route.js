import { NextResponse } from 'next/server';

const DEFAULT_MODEL = process.env.AI_MODEL || 'google/gemini-2.5-flash';

function cleanJsonText(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function extractJson(text) {
  const s = cleanJsonText(text);
  try { return JSON.parse(s); } catch {}
  const repaired = s
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  try { return JSON.parse(repaired); } catch {}
  throw new Error('AI 回傳內容不是有效 JSON');
}

function normalizeParsed(parsed) {
  const ORDER = ['全場讓分','全場大小','上半讓分','上半大小'];
  const games = Array.isArray(parsed?.games) ? parsed.games : [];
  return { games: games.map(g => ({
    away: String(g?.away || ''), home: String(g?.home || ''), confidence: Number(g?.confidence || 0),
    markets: ORDER.map(m => {
      const src = Array.isArray(g?.markets) ? g.markets.find(x => x?.market === m) : null;
      const ds = Array.isArray(src?.directions) ? src.directions.slice(0,2) : [];
      while (ds.length < 2) ds.push({pick:'',water:null,confidence:0});
      return { market:m, directions:ds.map(d => ({pick:String(d?.pick||''),water:d?.water==null?null:Number(d.water),confidence:Number(d?.confidence||0)})) };
    })
  })) };
}

const prompt = `你是台灣信用盤 MLB 盤口表格的高精度視覺資料擷取器。只做圖片資料擷取，不做投注推薦。
逐場擷取：全場讓分、全場大小、上半讓分、上半大小；每市場固定兩個方向。
規則：同一場不可串列；讓分兩邊必須是讓/受讓相反方向；大小兩邊必須是相同總分線的大/小；水位獨立放 water；保留台灣格式如 1平、1+50、1-20、0-70、8+50、8-30；看不清楚就空白，不猜數字；禁止只輸出「大」「小」「讓」「受讓」。
最重要：回覆必須是單一、完整、可被 JSON.parse 直接解析的 JSON 物件。不要 markdown、不要 code fence、不要任何解釋、不要省略 closing braces。若圖片很多也要優先保證 JSON 完整，必要時降低文字量。
格式：{"games":[{"away":"","home":"","confidence":0,"markets":[{"market":"全場讓分","directions":[{"pick":"","water":null,"confidence":0},{"pick":"","water":null,"confidence":0}]},{"market":"全場大小","directions":[{"pick":"","water":null,"confidence":0},{"pick":"","water":null,"confidence":0}]},{"market":"上半讓分","directions":[{"pick":"","water":null,"confidence":0},{"pick":"","water":null,"confidence":0}]},{"market":"上半大小","directions":[{"pick":"","water":null,"confidence":0},{"pick":"","water":null,"confidence":0}]}]}]}`;

async function callGateway(key, images, retry=false) {
  const content = [{ type:'text', text: retry ? `${prompt}\n你上一個回答 JSON 格式損壞。這次只輸出合法完整 JSON。` : prompt }];
  for (const url of images) content.push({ type:'image_url', image_url:{url} });
  const r = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
    method:'POST', headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:DEFAULT_MODEL,messages:[{role:'user',content}],temperature:0,max_tokens:8000,response_format:{type:'json_object'}})
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`AI Gateway ${r.status}: ${raw.slice(0,500)}`);
  const j = JSON.parse(raw);
  return j?.choices?.[0]?.message?.content || '';
}

export async function POST(req) {
  try {
    const key = process.env.AI_GATEWAY_API_KEY;
    if (!key) return NextResponse.json({ok:false,error:'AI_GATEWAY_API_KEY 尚未設定'},{status:500});
    const body = await req.json();
    const images = Array.isArray(body?.images) ? body.images.slice(0,8) : [];
    if (!images.length) return NextResponse.json({ok:false,error:'沒有收到圖片'},{status:400});
    let text = await callGateway(key,images,false), parsed;
    try { parsed = extractJson(text); }
    catch { text = await callGateway(key,images,true); parsed = extractJson(text); }
    return NextResponse.json({ok:true,model:DEFAULT_MODEL,parsed:normalizeParsed(parsed)});
  } catch (error) {
    return NextResponse.json({ok:false,error:String(error?.message||error)},{status:500});
  }
}
