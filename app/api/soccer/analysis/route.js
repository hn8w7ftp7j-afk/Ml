import { NextResponse } from 'next/server';
import { requireApiAuth,validateSameOrigin,originErrorResponse,checkRateLimit,rateLimitResponse,readJsonBody } from '../../../../lib/security.js';
import { soccerLeague,validSoccerDate } from '../../../../lib/soccer/contracts.js';
import { fetchSoccerSchedule } from '../../../../lib/soccer/data.js';
import { fetchSoccerPrematch } from '../../../../lib/soccer/prematch.js';
import { loadSoccerReaderSnapshot } from '../../../../lib/soccer/reader-store.js';
import { buildSoccerAnalysis } from '../../../../lib/soccer/analysis.js';
import { saveSoccerAnalysis,listSoccerAnalysis } from '../../../../lib/soccer/analysis-store.js';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=60;
const response=(body,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  const rate=checkRateLimit(request,{id:'soccer-evidence-history',limit:90,windowMs:60000});if(!rate.allowed)return rateLimitResponse(rate);
  const p=new URL(request.url).searchParams,league=soccerLeague(p.get('league')),date=p.get('date'),eventId=p.get('eventId');
  if(!league||!validSoccerDate(date)||!/^\d{1,16}$/.test(eventId||'')||['league','date','eventId'].some(k=>p.getAll(k).length!==1))return response({ok:false,error:'歷史查詢條件無效'},400);
  try{return response({ok:true,league:league.id,date,gameId:`soccer:${league.id}:${eventId}`,versions:await listSoccerAnalysis(league.id,`soccer:${league.id}:${eventId}`,date)});}catch{return response({ok:false,error:'已保存版本暫時無法讀取'},503);}
}
export async function POST(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  if(!validateSameOrigin(request))return originErrorResponse();
  const rate=checkRateLimit(request,{id:'soccer-evidence-analysis',limit:90,windowMs:60000});if(!rate.allowed)return rateLimitResponse(rate);
  try{
    const raw=await readJsonBody(request,2048),league=soccerLeague(raw?.league),date=raw?.date,eventId=raw?.eventId;
    if(!league||!validSoccerDate(date)||typeof eventId!=='string'||!/^\d{1,16}$/.test(eventId)||Object.keys(raw).some(k=>!['league','date','eventId'].includes(k)))return response({ok:false,error:'足球分析條件無效'},400);
    const board=await fetchSoccerSchedule(league.id,date);if(!board.ok)return response({ok:false,error:'賽程資料暫時無法核對'},503);
    const game=board.games.find(g=>g.sourceId===eventId);if(!game)return response({ok:false,error:'找不到同聯盟同日期的場次'},404);
    const evidence=await fetchSoccerPrematch(game);if(!evidence.ok)return response({ok:false,error:'賽前資料身分或來源核對未通過',code:evidence.code},503);
    let reader=null,readerUnavailable=false;try{reader=await loadSoccerReaderSnapshot(league.id,date);}catch{readerUnavailable=true;}
    let previous;try{previous=(await listSoccerAnalysis(league.id,game.id,date))[0]||null;}catch{}
    const result=buildSoccerAnalysis({evidence,reader,previous});
    try{const saved=await saveSoccerAnalysis(result);return response({...result,...saved,readerUnavailable});}
    catch{return response({...result,persisted:false,readerUnavailable,persistenceError:'本次資料未保存，請稍後重新核對。'});}
  }catch{return response({ok:false,error:'足球資料核對暫時無法完成'},503);}
}
