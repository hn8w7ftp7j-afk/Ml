import { NextResponse } from 'next/server';
import { requireApiAuth,validateSameOrigin,originErrorResponse,checkRateLimit,rateLimitResponse,readJsonBody } from '../../../../lib/security.js';
import { loadSoccerAnalysisRevision } from '../../../../lib/soccer/analysis-store.js';
import { listSoccerManualRecords,archiveSoccerManualRecord,changeSoccerManualRecordStatus } from '../../../../lib/soccer/manual-record-store.js';
export const dynamic='force-dynamic';
const response=(body,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
const fail=e=>response({ok:false,error:e.status===400?e.message:'永久帳本暫時無法讀寫，請重試。'},e.status||503);
export async function GET(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  const rate=checkRateLimit(request,{id:'soccer-record-read',limit:90,windowMs:60000});if(!rate.allowed)return rateLimitResponse(rate);
  const q=new URL(request.url).searchParams,league=q.get('league'),date=q.get('date'),through=q.get('through')||date;
  try{return response({ok:true,league,date,through,records:await listSoccerManualRecords(league,date,{through})});}catch(e){return fail(e);}
}
export async function POST(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  if(!validateSameOrigin(request))return originErrorResponse();
  const rate=checkRateLimit(request,{id:'soccer-record-write',limit:60,windowMs:60000});if(!rate.allowed)return rateLimitResponse(rate);
  try{
    const b=await readJsonBody(request,3000);
    if(['cancel','restore'].includes(b.action))return response({ok:true,...await changeSoccerManualRecordStatus(b.league,b.date,b.id,b.action)});
    if(b.action!=='record')return response({ok:false,error:'不支援的紀錄操作。'},400);
    if(b.alreadyPlaced!==true)return response({ok:false,error:'僅可記錄你已自行完成的下注。'},400);
    // Client submits identifiers only; price, period, stake and teams come from the immutable server snapshot.
    const snapshot=await loadSoccerAnalysisRevision(b.league,b.gameId,b.date,b.revision);
    return response({ok:true,...await archiveSoccerManualRecord(snapshot,b.quoteKey)});
  }catch(e){return fail(e);}
}
