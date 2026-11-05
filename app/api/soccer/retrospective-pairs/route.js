import { NextResponse } from 'next/server';
import { requireApiAuth,checkRateLimit,rateLimitResponse } from '../../../../lib/security.js';
import { readSoccerRetrospectivePairDiagnostic } from '../../../../lib/soccer/retrospective-pair-service.js';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=60;
const response=(body,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  const rate=checkRateLimit(request,{id:'soccer-retrospective-pair-read',limit:4,windowMs:60000});
  if(!rate.allowed)return rateLimitResponse(rate);
  const params=new URL(request.url).searchParams;
  if([...params.keys()].some(key=>!['league','date'].includes(key)||params.getAll(key).length!==1)
    ||!params.has('league')||!params.has('date'))return response({ok:false,error:'只接受單一足球聯盟與單一日期。',formalEligible:false,executable:false},400);
  try{return response({ok:true,report:await readSoccerRetrospectivePairDiagnostic({league:params.get('league'),date:params.get('date')})});}
  catch(error){return response({ok:false,error:error?.status===400?'足球聯盟或日期無效。':'回溯配對紀錄暫時無法讀取，目前筆數未知。',
    formalEligible:false,executable:false},error?.status===400?400:503);}
}
