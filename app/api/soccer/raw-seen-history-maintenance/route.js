import { NextResponse } from 'next/server';
import { requireApiAuth, validateSameOrigin, originErrorResponse, checkRateLimit, rateLimitResponse, readJsonBody } from '../../../../lib/security.js';
import { RAW_HISTORY_MAINTENANCE_SCHEMA, RAW_HISTORY_MAINTENANCE_FLAGS, getRawSeenHistoryProgress, drainRawSeenHistoryIndex } from '../../../../lib/soccer/raw-seen-history-maintenance.js';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const invalid=()=>Object.assign(Error('RAW_HISTORY_INDEX_QUERY_INVALID'),{status:400,code:'RAW_HISTORY_INDEX_QUERY_INVALID'});
function failure(error){
  const status=[400,413].includes(error?.status)?error.status:503;
  return NextResponse.json({ok:false,schema:RAW_HISTORY_MAINTENANCE_SCHEMA,...RAW_HISTORY_MAINTENANCE_FLAGS,
    status:status===503?'RETRYABLE':'INVALID_QUERY',counts:null,code:status===503?'RAW_HISTORY_INDEX_UNAVAILABLE':error.code||'RAW_HISTORY_INDEX_QUERY_INVALID',
    error:status===503?'原始盤口整理進度暫時無法核對，未當成零筆。':'原始盤口整理請求無效。'}, {status,headers});
}
export async function GET(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  const rate=checkRateLimit(request,{id:'soccer-raw-history-maintenance-read',limit:60,windowMs:600000});if(!rate.allowed)return rateLimitResponse(rate);
  try{if([...new URL(request.url).searchParams].length)throw invalid();return NextResponse.json(await getRawSeenHistoryProgress(),{headers});}
  catch(error){return failure(error);}
}
export async function POST(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  if(!validateSameOrigin(request))return originErrorResponse();
  const rate=checkRateLimit(request,{id:'soccer-raw-history-maintenance-write',limit:12,windowMs:600000});if(!rate.allowed)return rateLimitResponse(rate);
  try{
    if([...new URL(request.url).searchParams].length)throw invalid();
    const body=await readJsonBody(request,4096);
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||body.action!=='drain')throw invalid();
    const result=await drainRawSeenHistoryIndex({maxBatches:64,timeBudgetMs:40000});return NextResponse.json(result,{status:result.ok?200:503,headers});
  }catch(error){return failure(error);}
}
