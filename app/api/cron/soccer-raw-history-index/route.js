import { NextResponse } from 'next/server';
import { drainRawSeenHistoryIndex } from '../../../../lib/soccer/raw-seen-history-maintenance.js';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function GET(request){
  const headers={'Cache-Control':'no-store'},secret=String(process.env.CRON_SECRET||'').trim();
  if(!secret||request.headers.get('authorization')!==`Bearer ${secret}`)return NextResponse.json({ok:false,error:'Unauthorized'},{status:401,headers});
  try{
    const result=await drainRawSeenHistoryIndex({timeBudgetMs:40000,maxBatches:64});
    return NextResponse.json(result,{status:result.ok?200:503,headers});
  }catch{
    return NextResponse.json({ok:false,status:'RETRYABLE',budgetKind:'SOFT_DEADLINE',hardDeadlineEnforced:false,code:'RAW_HISTORY_INDEX_UNAVAILABLE',archiveOnly:true,currentBoardUpdated:false,
      historicalAvailabilityVerified:false,executable:false,formalEligible:false,coverageComplete:false,closingCoverage:'NOT_VERIFIED'},{status:503,headers});
  }
}
