import { NextResponse } from 'next/server';
import { requireApiAuth,checkRateLimit,rateLimitResponse } from '../../../../lib/security.js';
import { readSoccerRetrospectivePairDiagnostic } from '../../../../lib/soccer/retrospective-pair-service.js';
import { listSoccerRetrospectiveGames } from '../../../../lib/soccer/retrospective-game-inventory.js';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const maxDuration=60;
const response=(body,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function GET(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  const rate=checkRateLimit(request,{id:'soccer-retrospective-pair-read',limit:4,windowMs:60000});
  if(!rate.allowed)return rateLimitResponse(rate);
  const params=new URL(request.url).searchParams;
  if([...params.keys()].some(key=>!['league','date','gameId','mode'].includes(key)||params.getAll(key).length!==1)
    ||!params.has('league')||!params.has('date')||params.has('mode')&&(params.get('mode')!=='games'||params.has('gameId')))
    return response({ok:false,error:'只接受單一足球聯盟、日期及可選的一場比賽。',formalEligible:false,executable:false},400);
  try{
    const league=params.get('league'),date=params.get('date');
    const report=params.get('mode')==='games'?await listSoccerRetrospectiveGames(league,date)
      :await readSoccerRetrospectivePairDiagnostic({league,date,...(params.has('gameId')?{gameId:params.get('gameId')}:{})});
    return response({ok:true,report});
  }
  catch(error){return response({ok:false,error:error?.status===400?'足球聯盟或日期無效。':'回溯配對紀錄暫時無法讀取，目前筆數未知。',
    formalEligible:false,executable:false},error?.status===400?400:503);}
}
