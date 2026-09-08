import { NextResponse } from 'next/server';
import { neon } from '@neondatabase/serverless';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { durableDatabaseUrl } from '../../../lib/database-url.js';
import { requireApiAuth,checkRateLimit,rateLimitResponse } from '../../../lib/security.js';
import { validateAnalysisDirectionRecord } from '../../../lib/analysis-direction-history-v1.js';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
export async function GET(request){
 const auth=await requireApiAuth(request);if(auth)return auth;
 const rate=checkRateLimit(request,{id:'history-direction-export',limit:120,windowMs:600000});if(!rate.allowed)return rateLimitResponse(rate);
 const p=new URL(request.url).searchParams,after=p.get('after')||'',until=p.get('until')||'';
 if((after&&!/^[a-f0-9]{64}$/.test(after))||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(until)||!Number.isFinite(Date.parse(until))||Date.parse(until)>Date.now()+60000)return NextResponse.json({ok:false,code:'INVALID_QUERY'},{status:400,headers});
 try{
 const sql=neon(durableDatabaseUrl());
 const rows=await sql`SELECT d.direction_result_id,d.record_hash,d.record_payload,d.created_at,
 s.result_snapshot,s.status AS settlement_status,s.created_at AS result_saved_at
 FROM baseball_analysis_direction_results d
 LEFT JOIN LATERAL(SELECT result_snapshot,status,created_at FROM baseball_analysis_direction_settlements WHERE direction_result_id=d.direction_result_id AND created_at<=${until}::timestamptz ORDER BY created_at DESC,settled_at DESC,settlement_id DESC LIMIT 1)s ON true
 WHERE d.created_at<=${until}::timestamptz AND d.direction_result_id>${after}
 ORDER BY d.direction_result_id LIMIT 1001`;
 const records=rows.slice(0,1000).map(row=>{
 try{
  const record=validateAnalysisDirectionRecord(row.record_payload);
  if(record.recordHash!==row.record_hash)throw Error('HASH_MISMATCH');
  return {ok:true,record,createdAt:row.created_at,resultSnapshot:row.result_snapshot,settlementStatus:row.settlement_status,resultSavedAt:row.result_saved_at};
 }catch{return {ok:false,directionResultId:row.direction_result_id,code:'DIRECTION_INTEGRITY_FAILED'};}
 });
 const raw=Buffer.from(JSON.stringify({schema:'all-history-directions-v1',until,records,nextAfter:rows.length>1000?rows[999].direction_result_id:null,productionWrites:false}));
 const payload=gzipSync(raw).toString('base64');
 if(payload.length>2800000)return NextResponse.json({ok:false,code:'PAGE_TOO_LARGE'},{status:413,headers});
 return NextResponse.json({ok:true,encoding:'gzip-base64',sha256:createHash('sha256').update(raw).digest('hex'),payload},{headers});
 }catch{return NextResponse.json({ok:false,code:'DIRECTION_EXPORT_FAILED'},{status:503,headers});}
}