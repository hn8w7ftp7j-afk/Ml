import { NextResponse } from 'next/server';
import { requireApiAuth,validateSameOrigin,originErrorResponse,checkRateLimit,rateLimitResponse,readJsonBody } from '../../../../lib/security.js';
import { soccerLeague,validSoccerDate } from '../../../../lib/soccer/contracts.js';
import { listSoccerAnalysis } from '../../../../lib/soccer/analysis-store.js';
import { listSoccerRunHistory, getSoccerCurrentResearchStatus } from '../../../../lib/soccer/journal.js';
import { analyzeSoccerGame, loadSoccerCurrentAnalysis, validSoccerAnalysisQuery } from '../../../../lib/soccer/analysis-service.js';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=60;
const response=(body,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  const rate=checkRateLimit(request,{id:'soccer-evidence-history',limit:90,windowMs:60000});if(!rate.allowed)return rateLimitResponse(rate);
  const p=new URL(request.url).searchParams,league=soccerLeague(p.get('league')),date=p.get('date'),eventId=p.get('eventId'),view=p.get('view');
  if(!league||!validSoccerDate(date)||!validSoccerAnalysisQuery({league:league?.id,date,eventId})||['league','date','eventId'].some(k=>p.getAll(k).length!==1)||p.getAll('view').length>1||(view!==null&&view!=='current')||[...p.keys()].some(k=>!['league','date','eventId','view'].includes(k)))return response({ok:false,error:'歷史查詢條件無效'},400);
  try{
    const gameId=`soccer:${league.id}:${eventId}`;
    if(view==='current')return response({ok:true,league:league.id,date,gameId,currentResearch:await getSoccerCurrentResearchStatus(league.id,date,gameId)});
    const [versions,runs,current,currentResearch]=await Promise.all([listSoccerAnalysis(league.id,gameId,date),listSoccerRunHistory(league.id,date,gameId),loadSoccerCurrentAnalysis(league.id,date,eventId),getSoccerCurrentResearchStatus(league.id,date,gameId)]);
    return response({ok:true,league:league.id,date,gameId,versions,runs,...current,currentResearch});
  }catch{return response({ok:false,error:'已保存版本暫時無法讀取'},503);}
}
export async function POST(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  if(!validateSameOrigin(request))return originErrorResponse();
  const rate=checkRateLimit(request,{id:'soccer-evidence-analysis',limit:90,windowMs:60000});if(!rate.allowed)return rateLimitResponse(rate);
  try{
    const raw=await readJsonBody(request,2048);
    const result=await analyzeSoccerGame(raw);
    return response(result.payload,result.status);
  }catch{return response({ok:false,error:'足球資料核對暫時無法完成',code:'SOCCER_ANALYSIS_OR_STORAGE_FAILED',analysisStatus:'FAILED',qaFlag:'BLOCKED',selectionResult:null,publishedCurrent:false,journalPersisted:false,formalScoringEnabled:false,executable:false},503);}
}
