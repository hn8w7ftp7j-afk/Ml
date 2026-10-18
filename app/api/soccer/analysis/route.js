import { NextResponse } from 'next/server';
import { requireApiAuth,validateSameOrigin,originErrorResponse,checkRateLimit,rateLimitResponse,readJsonBody } from '../../../../lib/security.js';
import { soccerLeague,validSoccerDate } from '../../../../lib/soccer/contracts.js';
import { fetchSoccerSchedule } from '../../../../lib/soccer/data.js';
import { fetchSoccerPrematch } from '../../../../lib/soccer/prematch.js';
import { fetchSoccerWorkload } from '../../../../lib/soccer/workload.js';
import { loadSoccerReaderSnapshot } from '../../../../lib/soccer/reader-store.js';
import { buildSoccerAnalysis,soccerAnalysisHash } from '../../../../lib/soccer/analysis.js';
import { saveSoccerAnalysis,listSoccerAnalysis } from '../../../../lib/soccer/analysis-store.js';
import { beginSoccerAnalysisRun,finishSoccerAnalysisRun,listSoccerRunHistory,recordSoccerCohort,getSoccerCurrentResearchStatus } from '../../../../lib/soccer/journal.js';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=60;
const response=(body,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  const rate=checkRateLimit(request,{id:'soccer-evidence-history',limit:90,windowMs:60000});if(!rate.allowed)return rateLimitResponse(rate);
  const p=new URL(request.url).searchParams,league=soccerLeague(p.get('league')),date=p.get('date'),eventId=p.get('eventId'),view=p.get('view');
  if(!league||!validSoccerDate(date)||!/^\d{1,16}$/.test(eventId||'')||['league','date','eventId'].some(k=>p.getAll(k).length!==1)||p.getAll('view').length>1||(view!==null&&view!=='current')||[...p.keys()].some(k=>!['league','date','eventId','view'].includes(k)))return response({ok:false,error:'歷史查詢條件無效'},400);
  try{
    const gameId=`soccer:${league.id}:${eventId}`;
    const currentResearch=await getSoccerCurrentResearchStatus(league.id,date,gameId);
    if(view==='current')return response({ok:true,league:league.id,date,gameId,currentResearch});
    const [versions,runs]=await Promise.all([listSoccerAnalysis(league.id,gameId,date),listSoccerRunHistory(league.id,date,gameId)]);
    return response({ok:true,league:league.id,date,gameId,versions,runs,currentResearch});
  }catch{return response({ok:false,error:'已保存版本暫時無法讀取'},503);}
}
export async function POST(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  if(!validateSameOrigin(request))return originErrorResponse();
  const rate=checkRateLimit(request,{id:'soccer-evidence-analysis',limit:90,windowMs:60000});if(!rate.allowed)return rateLimitResponse(rate);
  let run=null;
  const failure=async(error,status,analysisStatus='INSUFFICIENT_DATA',code=null)=>{
    let journalPersisted=false;
    if(run){try{await finishSoccerAnalysisRun(run,{analysisStatus,qaFlag:'BLOCKED',reasons:[code||'SOCCER_SOURCE_UNAVAILABLE']});journalPersisted=true;}catch{}}
    return response({ok:false,error,code,analysisRunId:run?.runId||null,analysisStatus,qaFlag:'BLOCKED',selectionResult:null,
      publishedCurrent:false,journalPersisted,formalScoringEnabled:false,executable:false},status);
  };
  try{
    const raw=await readJsonBody(request,2048),league=soccerLeague(raw?.league),date=raw?.date,eventId=raw?.eventId;
    if(!league||!validSoccerDate(date)||typeof eventId!=='string'||!/^\d{1,16}$/.test(eventId)||Object.keys(raw).some(k=>!['league','date','eventId'].includes(k)))return response({ok:false,error:'足球分析條件無效'},400);
    run=await beginSoccerAnalysisRun({league:league.id,date,gameId:`soccer:${league.id}:${eventId}`});
    const board=await fetchSoccerSchedule(league.id,date);if(!board.ok)return failure('賽程資料暫時無法核對',503,'INSUFFICIENT_DATA',board.code);
    await recordSoccerCohort(board.games);
    const game=board.games.find(g=>g.sourceId===eventId);if(!game)return failure('找不到同聯盟同日期的場次',404,'INSUFFICIENT_DATA','SOCCER_GAME_NOT_FOUND');
    const [evidence,workload]=await Promise.all([
      fetchSoccerPrematch(game),
      fetchSoccerWorkload(game,{timeoutMs:8000}).catch(()=>({ok:false,status:'INCOMPLETE',teams:{},sources:[],modelEffectApplied:false,executable:false})),
    ]);
    if(!evidence.ok)return failure('賽前資料身分或來源核對未通過',503,'INSUFFICIENT_DATA',evidence.code);
    evidence.workload=workload;
    let reader=null,readerUnavailable=false;try{reader=await loadSoccerReaderSnapshot(league.id,date);}catch{readerUnavailable=true;}
    let previous;try{previous=(await listSoccerAnalysis(league.id,game.id,date))[0]||null;}catch{}
    const built=buildSoccerAnalysis({evidence,reader,previous});
    const {analysisHash:discardedHash,...body}=built;
    const evidenceExpiry=Date.parse(evidence.source.fetchedAt)+180000;
    const validUntil=new Date(body.status==='RESEARCH_ONLY'?Math.min(evidenceExpiry,Date.parse(game.startTime)):evidenceExpiry).toISOString();
    const result={...body,analysisRunId:run.runId,qualificationVersion:run.requestSeq,
      quoteGeneration:run.quoteGeneration,runStartedAt:run.startedAt,validUntil};
    result.analysisHash=soccerAnalysisHash(result);
    const saved=await saveSoccerAnalysis(result);
    const publication=await finishSoccerAnalysisRun(run,{analysisStatus:result.analysisStatus,qaFlag:result.qaFlag,
      selectionResult:result.selectionResult,revision:saved.revision,
      validUntil,reasons:result.predictionReason?[result.predictionReason]:[]});
    // A quote or newer run can invalidate publication before this response is
    // delivered. Failure to recheck is uncertainty, not permission to reuse it.
    let currentResearch=null;try{currentResearch=await getSoccerCurrentResearchStatus(league.id,date,game.id);}catch{}
    const publishedCurrent=publication.publishedCurrent&&currentResearch?.publishedCurrent===true&&currentResearch.revision===saved.revision&&currentResearch.analysisRunId===run.runId;
    return response({...result,...saved,...publication,publishedCurrent,currentResearch,readerUnavailable,journalPersisted:true});
  }catch{return failure('足球資料核對暫時無法完成',503,'FAILED','SOCCER_ANALYSIS_OR_STORAGE_FAILED');}
}
