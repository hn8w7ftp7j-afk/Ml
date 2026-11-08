import { NextResponse } from 'next/server';
import { requireApiAuth, validateSameOrigin, originErrorResponse, checkRateLimit, rateLimitResponse, readJsonBody } from '../../../../lib/security.js';
import { RAW_HISTORY_INDEX_SCHEMA, parseRawHistoryIndexQuery, queryRawHistoryIndex, indexRawSeenHistoryCapture, scanRawHistoryIndex } from '../../../../lib/soccer/raw-seen-history-index.js';
import { RAW_SEEN_HISTORY_FLAGS } from '../../../../lib/soccer/raw-seen-history.js';

export const dynamic='force-dynamic';
export const maxDuration=60;
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
function failed(error) {
  const status=[400,404,413,422].includes(error?.status)?error.status:503;
  return NextResponse.json({ok:false,schema:RAW_HISTORY_INDEX_SCHEMA,...RAW_SEEN_HISTORY_FLAGS,
    code:/^(?:RAW_HISTORY_INDEX_|RAW_SEEN_RECOVERY_|READER_SEEN_CAPTURE_)[A-Z0-9_]+$/.test(error?.code||'')?error.code:'RAW_HISTORY_INDEX_UNAVAILABLE',
    error:'歷史查閱索引尚未通過核對；未將未辨識、未索引或暫時無法讀取的來源當成沒有盤口。'}, {status,headers});
}
export async function GET(request) {
  const denied=await requireApiAuth(request);if(denied)return denied;
  const rate=checkRateLimit(request,{id:'soccer-raw-history-index-read',limit:60,windowMs:600_000});if(!rate.allowed)return rateLimitResponse(rate);
  try{return NextResponse.json(await queryRawHistoryIndex(parseRawHistoryIndexQuery(new URL(request.url).searchParams)),{headers});}
  catch(error){return failed(error);}
}
export async function POST(request) {
  const denied=await requireApiAuth(request);if(denied)return denied;
  if(!validateSameOrigin(request))return originErrorResponse();
  const rate=checkRateLimit(request,{id:'soccer-raw-history-index-write',limit:120,windowMs:600_000});if(!rate.allowed)return rateLimitResponse(rate);
  try {
    const body=await readJsonBody(request,4096);
    const allowed=body.action==='index'?['action','captureId']:body.action==='scan'?['action','league','from','through','after']:[];
    if(!allowed.length||!Object.keys(body).every(key=>allowed.includes(key)))throw Object.assign(Error('RAW_HISTORY_INDEX_QUERY_INVALID'),{code:'RAW_HISTORY_INDEX_QUERY_INVALID',status:400});
    const result=body.action==='index'?await indexRawSeenHistoryCapture(body.captureId):await scanRawHistoryIndex(body);
    return NextResponse.json(result,{headers});
  }catch(error){return failed(error);}
}
