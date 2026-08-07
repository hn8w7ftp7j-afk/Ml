import { NextResponse } from 'next/server';
import { normalizeVisionGame } from '../../../lib/markets.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const MODEL = process.env.AI_MODEL || 'google/gemini-2.5-flash';

function cleanJSON(text) {
  let s=String(text||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/i,'');
  const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a)s=s.slice(a,b+1);
  s=s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replace(/,\s*([}\]])/g,'$1').replace(/[“”]/g,'"');
  return JSON.parse(s);
}

function fuzzyGame(raw,schedule){
  if(!Array.isArray(schedule)||!schedule.length)return null;
  if(raw?.gamePk){const x=schedule.find(g=>String(g.gamePk)===String(raw.gamePk));if(x)return x}
  const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const a=norm(raw?.away),h=norm(raw?.home);
  let best=null,score=0;
  for(const g of schedule){const ga=norm(g.away),gh=norm(g.home);let s=0;if(a&&(ga.includes(a)||a.includes(ga)))s+=1;if(h&&(gh.includes(h)||h.includes(gh)))s+=1;if(s>score){score=s;best=g}}
  return score>=1?best:null;
}

function prompt(schedule,textMode){
  const slate=(schedule||[]).map(g=>`${g.gamePk}: ${g.away} @ ${g.home}`).join('\n');
  return `你是台灣信用盤 MLB 盤口擷取器。${textMode?'使用者提供的是盤口文字。':'使用者提供的是盤口截圖。'}只擷取資料，不做投注推薦。
今天可配對的 MLB 賽事：\n${slate||'未提供'}

逐場輸出以下精簡結構：
- gamePk：能配對時填上方編號，否則 null
- away/home：球隊名稱
- fullRunline/first5Runline：favoriteSide 只能是 away、home 或 null；line 保留台灣格式（例 1平、1+50、1-20、0-70）；favoriteWater/underdogWater 為 0.940 等水位
- fullTotal/first5Total：line 保留台灣格式（例 8+50、8-30）；overWater/underWater 為水位
- confidence 0~1

重要：盤口數字不能和水位混淆。同一場不得串到相鄰場。看不清楚用空字串或 null，不猜數字。只回合法完整 JSON，不要 markdown。
格式：{"games":[{"gamePk":null,"away":"","home":"","confidence":0,"fullRunline":{"favoriteSide":null,"line":"","favoriteWater":null,"underdogWater":null,"confidence":0},"fullTotal":{"line":"","overWater":null,"underWater":null,"confidence":0},"first5Runline":{"favoriteSide":null,"line":"","favoriteWater":null,"underdogWater":null,"confidence":0},"first5Total":{"line":"","overWater":null,"underWater":null,"confidence":0}}]}`;
}

async function gateway(key,content,useJsonFormat=true){
  const body={model:MODEL,messages:[{role:'user',content}],temperature:0,max_tokens:6500};
  if(useJsonFormat)body.response_format={type:'json_object'};
  const r=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(55000)});
  const raw=await r.text();if(!r.ok)throw new Error(`AI Gateway ${r.status}: ${raw.slice(0,400)}`);
  const j=JSON.parse(raw);return j?.choices?.[0]?.message?.content||'';
}

export async function POST(req){
  try{
    const key=process.env.AI_GATEWAY_API_KEY;if(!key)return NextResponse.json({ok:false,error:'AI Gateway 金鑰未設定'},{status:500});
    const body=await req.json();const images=Array.isArray(body?.images)?body.images.slice(0,2):[];const text=String(body?.text||'').trim();const schedule=Array.isArray(body?.schedule)?body.schedule.slice(0,25):[];
    if(!images.length&&!text)return NextResponse.json({ok:false,error:'沒有收到圖片或盤口文字'},{status:400});
    const content=[{type:'text',text:prompt(schedule,!!text)}];if(text)content.push({type:'text',text:`盤口文字：\n${text}`});for(const url of images)content.push({type:'image_url',image_url:{url}});
    let output,parsed;
    try{output=await gateway(key,content,true);parsed=cleanJSON(output)}catch(first){
      const retry=[{type:'text',text:`${prompt(schedule,!!text)}\n上一個回答格式錯誤，這次務必只回完整合法 JSON。`},...content.slice(1)];
      output=await gateway(key,retry,false);parsed=cleanJSON(output);
    }
    const rows=(Array.isArray(parsed?.games)?parsed.games:[]).map(raw=>{const matched=fuzzyGame(raw,schedule);return {...normalizeVisionGame(raw,matched,Number(body?.defaultWater||.95)),matchedGame:matched||null}});
    return NextResponse.json({ok:true,model:MODEL,games:rows});
  }catch(error){return NextResponse.json({ok:false,error:String(error?.name==='TimeoutError'?'AI 辨識逾時，請重試':error?.message||error)},{status:500})}
}
