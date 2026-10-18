import { NextResponse } from 'next/server';
import { bearerToken, readerCorsHeaders, readerOriginAllowed, verifyReaderToken } from '../../../../lib/reader-auth-v2.js';
import { checkRateLimit, readJsonBody, requireApiAuth } from '../../../../lib/security.js';
import { validateSoccerCapture, matchSoccerReaderGames } from '../../../../lib/soccer/reader.js';
import { loadSoccerReaderSnapshot, saveSoccerReaderSnapshot, soccerReaderStorageConfigured } from '../../../../lib/soccer/reader-store.js';
import { fetchSoccerSchedule } from '../../../../lib/soccer/data.js';
import { soccerLeague, validSoccerDate } from '../../../../lib/soccer/contracts.js';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function OPTIONS(request){return new Response(null,{status:readerOriginAllowed(request)?204:403,headers:readerCorsHeaders(request)});}
export async function POST(request){
  const headers=readerCorsHeaders(request);const response=(body,status=200)=>NextResponse.json(body,{status,headers});
  if(!readerOriginAllowed(request))return response({ok:false,error:'不允許的Reader來源'},403);
  const token=await verifyReaderToken(bearerToken(request));if(!token)return response({ok:false,error:'Reader未配對'},401);
  if(request.headers.get('x-device-id')!==token.deviceId)return response({ok:false,error:'Reader裝置不符'},403);
  if(!checkRateLimit(request,{id:'soccer-reader',limit:60,windowMs:60000}).allowed)return response({ok:false,error:'請稍後再同步'},429);
  try{
    const raw=await readJsonBody(request,384000);const checked=validateSoccerCapture(raw,{headerVersion:request.headers.get('x-reader-version')});
    if(!checked.ok)return response({ok:false,error:'足球原盤核對未通過',issues:checked.errors},422);
    const saved=await saveSoccerReaderSnapshot({...checked.payload,deviceId:token.deviceId});
    return response({ok:true,league:raw.league,...saved,rawGameCount:checked.payload.games.length,matchedGameCount:0,marketCount:checked.payload.games.reduce((n,g)=>n+g.markets.length,0),executable:false,message:'足球原盤已保存，規格及模型驗證中'});
  }catch(e){return response({ok:false,error:'足球原盤未保存',code:/^[A-Z0-9_]+$/.test(e.message||'')?e.message:'SOCCER_READER_CAPTURE_FAILED',status:'BLOCKED',executable:false},e.status||503);}
}
export async function GET(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  const response=(body,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
  const params=new URL(request.url).searchParams;const league=soccerLeague(params.get('league')),date=params.get('date');
  if(!league||!validSoccerDate(date)||params.getAll('league').length!==1||params.getAll('date').length!==1)return response({ok:false,error:'足球聯盟或日期無效'},400);
  if(!soccerReaderStorageConfigured())return response({ok:false,error:'足球原盤儲存尚未設定'},503);
  try{
    const capture=await loadSoccerReaderSnapshot(league.id,date);
    if(!capture)return response({ok:true,league:league.id,date,status:'WAITING_READER',games:[],executable:false});
    const official=await fetchSoccerSchedule(league.id,date);
    const games=matchSoccerReaderGames(capture,official.ok?official.games:[]);
    return response({ok:true,league:league.id,date,status:'CAPTURED_RULES_UNVERIFIED',observedAt:capture.observedAt,
      firstFetchedAt:capture.firstFetchedAt,receivedAt:capture.receivedAt||null,observationId:capture.observationId,
      timeEvidence:capture.timeEvidence,historicalAvailabilityVerified:false,revision:capture.revision,games,officialAvailable:official.ok,executable:false});
  }catch{return response({ok:false,error:'足球原盤暫時無法讀取',executable:false},503);}
}
