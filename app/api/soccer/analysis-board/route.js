import { NextResponse } from 'next/server';
import { requireApiAuth,checkRateLimit,rateLimitResponse } from '../../../../lib/security.js';
import { listSoccerAnalysisBoard } from '../../../../lib/soccer/analysis-store.js';
export const dynamic='force-dynamic';
export async function GET(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  const rate=checkRateLimit(request,{id:'soccer-analysis-board',limit:90,windowMs:60000});if(!rate.allowed)return rateLimitResponse(rate);
  const q=new URL(request.url).searchParams,league=q.get('league'),date=q.get('date'),through=q.get('through')||date;
  try{return NextResponse.json({ok:true,league,date,through,results:await listSoccerAnalysisBoard(league,date,through)},{headers:{'Cache-Control':'no-store'}});}
  catch(e){return NextResponse.json({ok:false,error:e.status===400?e.message:'已保存分析暫時無法讀取。'},{status:e.status||503});}
}
