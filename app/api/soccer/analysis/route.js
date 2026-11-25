import { NextResponse } from 'next/server';
import { requireApiAuth,validateSameOrigin,originErrorResponse,checkRateLimit,rateLimitResponse,readJsonBody } from '../../../../lib/security.js';
import { soccerLeague,validSoccerDate } from '../../../../lib/soccer/contracts.js';
import { listSoccerAnalysis,loadSoccerHistoricalPrediction } from '../../../../lib/soccer/analysis-store.js';
import { listSoccerRunHistory, getSoccerCurrentResearchStatus } from '../../../../lib/soccer/journal.js';
import { analyzeSoccerGame, loadSoccerCurrentAnalysis, validSoccerAnalysisQuery } from '../../../../lib/soccer/analysis-service.js';
import { soccerMatchCard, SOCCER_MATCH_CARD_MEDIA_TYPE } from '../../../../lib/soccer/match-card-transport.js';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=60;
function response(body,status=200,matchCard=false){
  const headers={'Cache-Control':'no-store',Vary:'Accept'};
  if(matchCard){
    headers['Content-Type']=SOCCER_MATCH_CARD_MEDIA_TYPE;
    body=Array.isArray(body.versions)
      ? {...body,versions:body.versions.map(soccerMatchCard),currentVersion:soccerMatchCard(body.currentVersion)}
      : soccerMatchCard(body);
  }
  return NextResponse.json(body,{status,headers});
}
async function fullResponse(body,matchCard=false,latest=body.currentVersion||body.versions?.[0]){
  // A historical read has no authority over the active result. Preserve the
  // verified current response even if this independent lookup is unavailable.
  try{return response({...body,historicalPrediction:await loadSoccerHistoricalPrediction(latest)},200,matchCard);}
  catch{return response({...body,historicalPrediction:null,historicalPredictionReadFailed:true},200,matchCard);}
}
export async function GET(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  const rate=checkRateLimit(request,{id:'soccer-evidence-history',limit:90,windowMs:60000});if(!rate.allowed)return rateLimitResponse(rate);
  const p=new URL(request.url).searchParams,league=soccerLeague(p.get('league')),date=p.get('date'),eventId=p.get('eventId'),view=p.get('view'),knownRevision=p.get('revision');
  if(!league||!validSoccerDate(date)||!validSoccerAnalysisQuery({league:league?.id,date,eventId})||['league','date','eventId'].some(k=>p.getAll(k).length!==1)||p.getAll('view').length>1||p.getAll('revision').length>1||(view!==null&&!['current','head'].includes(view))||(knownRevision!==null&&(view!=='current'||!/^[a-f0-9]{64}$/.test(knownRevision)))||[...p.keys()].some(k=>!['league','date','eventId','view','revision'].includes(k)))return response({ok:false,error:'歷史查詢條件無效'},400);
  try{
    const gameId=`soccer:${league.id}:${eventId}`;
    const matchCard=request.headers.get('accept')===SOCCER_MATCH_CARD_MEDIA_TYPE;
    if(view==='current'){
      const currentResearch=await getSoccerCurrentResearchStatus(league.id,date,gameId);
      if(knownRevision!==null&&currentResearch?.publishedCurrent===true&&currentResearch.revision!==knownRevision){
        // A changed head travels together with its same-query receipt. The
        // browser can replace both atomically instead of first revoking its
        // old result and then downloading the new result in a second request.
        const current=await loadSoccerCurrentAnalysis(league.id,date,eventId);
        if(current.currentVersion)return fullResponse({ok:true,league:league.id,date,gameId,versions:[],runs:[],...current},matchCard);
        // Repricing/expiry may have invalidated the head between the two reads.
        // Never reuse the earlier ACTIVE receipt with an absent full result.
        return response({ok:true,league:league.id,date,gameId,currentResearch:await getSoccerCurrentResearchStatus(league.id,date,gameId)});
      }
      return response({ok:true,league:league.id,date,gameId,currentResearch});
    }
    if(view==='head'){
      // Board recovery needs one full result and the latest attempt, not the
      // entire history on every poll. Preserve the historical fallback when a
      // refresh is pending, failed, or expired; qualification remains read-only.
      const [current,runs]=await Promise.all([loadSoccerCurrentAnalysis(league.id,date,eventId),
        listSoccerRunHistory(league.id,date,gameId,{limit:1})]);
      // The full version and its qualification receipt must come from the same
      // head read. A separately read receipt can refer to a newer publication
      // and incorrectly invalidate the version being delivered to the browser.
      const [currentResearch,versions]=current.currentVersion?[current.currentResearch,[]]:
        await Promise.all([getSoccerCurrentResearchStatus(league.id,date,gameId),
          listSoccerAnalysis(league.id,gameId,date,{limit:1})]);
      return fullResponse({ok:true,league:league.id,date,gameId,versions,runs,...current,currentResearch},matchCard);
    }
    const [versions,runs,current,currentResearch]=await Promise.all([listSoccerAnalysis(league.id,gameId,date),listSoccerRunHistory(league.id,date,gameId),loadSoccerCurrentAnalysis(league.id,date,eventId),getSoccerCurrentResearchStatus(league.id,date,gameId)]);
    return fullResponse({ok:true,league:league.id,date,gameId,versions,runs,...current,currentResearch});
  }catch{return response({ok:false,error:'已保存版本暫時無法讀取'},503);}
}
export async function POST(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  if(!validateSameOrigin(request))return originErrorResponse();
  const rate=checkRateLimit(request,{id:'soccer-evidence-analysis',limit:90,windowMs:60000});if(!rate.allowed)return rateLimitResponse(rate);
  try{
    const raw=await readJsonBody(request,2048);
    const result=await analyzeSoccerGame(raw);
    const body=result.payload;
    const matchCard=request.headers.get('accept')===SOCCER_MATCH_CARD_MEDIA_TYPE;
    if(matchCard&&result.status===200&&body.persisted&&body.predictionContext?.mode==='PREDICTION'){
      return fullResponse(body,true,body);
    }
    return response(body,result.status,matchCard);
  }catch{return response({ok:false,error:'足球資料核對暫時無法完成',code:'SOCCER_ANALYSIS_OR_STORAGE_FAILED',analysisStatus:'FAILED',qaFlag:'BLOCKED',selectionResult:null,publishedCurrent:false,journalPersisted:false,formalScoringEnabled:false,executable:false},503);}
}
