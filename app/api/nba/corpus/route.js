import { NextResponse } from 'next/server';
import { requireApiAuth, checkRateLimit } from '../../../../lib/security.js';
import {loadNbaCorpus,saveNbaCorpus} from '../../../../lib/nba/corpus-store.js';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const q = (params.get('q') || '').trim().toUpperCase().slice(0,100);
  const status = params.get('status') || 'all';
  if (!['all','included','pending'].includes(status)) return NextResponse.json({error:'INVALID_STATUS'},{status:400});
  const pageRaw=params.get('page')||'1';
  if(!/^[1-9]\d{0,5}$/.test(pageRaw))return NextResponse.json({error:'INVALID_PAGE'},{status:400});
  let report;try{report=await loadNbaCorpus();}catch{return NextResponse.json({error:'研究資料暫時無法讀取'},{status:503,headers:{'Cache-Control':'no-store'}});}
  if(!report)return NextResponse.json({league:'NBA',empty:true},{headers:{'Cache-Control':'no-store'}});
  const matches=report.entries.filter(e=>(!q||`${e.candidateDate} ${e.away} ${e.home} ${e.gameId||''}`.toUpperCase().includes(q))&&(status==='all'||(status==='included')===(e.researchStatus==='included_home_team_chronological_fold')));
  const page=Math.min(Number(pageRaw),Math.max(1,Math.ceil(matches.length/30)));
  const entries=matches.slice((page-1)*30,page*30);
  return NextResponse.json({league:'NBA',generatedAt:report.generatedAt,sourceHash:report.sourceHash,summary:report.summary,metrics:report.candidateSubsetMetrics,limitations:report.limitations,entries,total:matches.length,page,pages:Math.max(1,Math.ceil(matches.length/30))},{headers:{'Cache-Control':'no-store'}});
}
export async function POST(request){
 const denied=await requireApiAuth(request);if(denied)return denied;
 if(request.headers.get('origin')!==new URL(request.url).origin)return NextResponse.json({error:'來源不符'},{status:403});
 const rate=checkRateLimit(request,{id:'nba-corpus-import',limit:4,windowMs:60000});if(!rate.allowed)return NextResponse.json({error:'匯入過於頻繁'},{status:429});
 const text=await request.text();if(Buffer.byteLength(text)>3500000)return NextResponse.json({error:'研究報告過大'},{status:413});
 let payload;try{payload=JSON.parse(text);}catch{return NextResponse.json({error:'JSON 格式錯誤'},{status:400});}
 try{return NextResponse.json({league:'NBA',receipt:await saveNbaCorpus(payload)},{headers:{'Cache-Control':'no-store'}});}catch(e){return NextResponse.json({error:e.code==='NBA_CORPUS_INVALID'?e.message:'研究資料尚未成功保存'},{status:e.code==='NBA_CORPUS_INVALID'?422:503,headers:{'Cache-Control':'no-store'}});}
}
