import { NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from '../../../lib/database-url.js';
import { requireApiAuth, checkRateLimit, rateLimitResponse } from '../../../lib/security.js';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
export async function GET(request) {
 const auth=await requireApiAuth(request); if(auth)return auth;
 const rate=checkRateLimit(request,{id:'history-inventory',limit:60,windowMs:600000});
 if(!rate.allowed)return rateLimitResponse(rate);
 const p=new URL(request.url).searchParams, after=p.get('after')||'', until=p.get('until')||new Date().toISOString();
 if((after&&!/^(MLB|NPB|KBO|CPBL):[1-9]\d{0,15}:(FULL|PRICE_ONLY_REPRICE):[a-f0-9]{64}$/.test(after))||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(until)||!Number.isFinite(Date.parse(until))||Date.parse(until)>Date.now()+60000)return NextResponse.json({ok:false,code:'INVALID_QUERY'},{status:400,headers});
 try{
  const sql=neon(durableDatabaseUrl());
  const rows=await sql`SELECT snapshot_id,league_id,external_game_id,game_identity,game_start,analysis_as_of,line_as_of,analysis_type,parent_snapshot_id,created_at,input_hash,price_fingerprint,model_version FROM baseball_analysis_pit_snapshots WHERE created_at<=${until}::timestamptz AND snapshot_id>${after} ORDER BY snapshot_id LIMIT 501`;
  let totals=null;
  if(!after)totals=await sql`SELECT league_id,COUNT(*) AS snapshots,COUNT(DISTINCT external_game_id) AS games,MIN(game_start) AS first_game,MAX(game_start) AS last_game,COUNT(*) FILTER(WHERE analysis_type='FULL') AS full_snapshots,COUNT(DISTINCT (external_game_id,price_fingerprint)) AS game_price_sets FROM baseball_analysis_pit_snapshots WHERE created_at<=${until}::timestamptz GROUP BY league_id ORDER BY league_id`;
  return NextResponse.json({ok:true,schema:'history-inventory-v1',until,totals,rows:rows.slice(0,500),nextAfter:rows.length>500?rows[499].snapshot_id:null,productionWrites:false},{headers});
 }catch{return NextResponse.json({ok:false,code:'INVENTORY_READ_FAILED'},{status:503,headers});}
}
