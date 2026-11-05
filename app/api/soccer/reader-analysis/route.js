import { NextResponse } from 'next/server';
import { requireApiAuth, validateSameOrigin, originErrorResponse, checkRateLimit, rateLimitResponse, readJsonBody } from '../../../../lib/security.js';
import { soccerLeague, validSoccerDate } from '../../../../lib/soccer/contracts.js';
import { loadSoccerReaderSnapshot } from '../../../../lib/soccer/reader-store.js';
import { enqueueSoccerReaderAnalysis } from '../../../../lib/soccer/reader-auto-analysis.js';
import { launchSoccerReaderContinuation } from '../../../../lib/soccer/reader-analysis-launcher.js';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
const response=(body,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function POST(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  if(!validateSameOrigin(request))return originErrorResponse();
  const rate=checkRateLimit(request,{id:'soccer-reader-analysis-resume',limit:4,windowMs:60000});
  if(!rate.allowed)return rateLimitResponse(rate);
  try{
    const body=await readJsonBody(request,1000),league=soccerLeague(body?.league)?.id,date=body?.date;
    if(!body||body.action!=='resume'||body.league!==league||!validSoccerDate(date)
      ||Object.keys(body).some(key=>!['action','league','date'].includes(key)))
      return response({ok:false,error:'只接受已保存原盤的聯盟與日期，不接受盤口、預測或來源時間。'},400);
    const reader=await loadSoccerReaderSnapshot(league,date);
    if(!reader)return response({ok:false,code:'READER_NOT_SAVED',error:'該日期尚未保存原盤。',executable:false},404);
    if(soccerLeague(reader.league)?.id!==league||reader.boardDate!==date)throw Error('SOCCER_READER_RESUME_SCOPE_MISMATCH');
    await enqueueSoccerReaderAnalysis(league,date);
    return response({ok:true,league,date,continuation:await launchSoccerReaderContinuation({league,date}),executable:false});
  }catch(error){
    if(error?.status===400||error?.status===413)return response({ok:false,error:'補存請求格式無效。'},error.status);
    return response({ok:false,error:'盤口預測補存暫時無法啟動；原盤保存狀態不變。',executable:false},503);
  }
}
