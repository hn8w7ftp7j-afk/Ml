import { NextResponse } from 'next/server';
import { settleOpenCloudBets } from '../../../../lib/cloud-bet-store.js';
import { settleOpenNbaManualRecords } from '../../../../lib/nba/manual-bet-settlement-service.js';
import { settleOpenSoccerManualRecords } from '../../../../lib/soccer/manual-settlement-service.js';
import { collectSoccerForwardBacklog } from '../../../../lib/soccer/forward-result-collector.js';
import { drainSoccerReaderAnalysis } from '../../../../lib/soccer/reader-auto-analysis.js';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function authorized(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  return Boolean(secret) && request.headers.get('authorization') === `Bearer ${secret}`;
}

// Logs are operational markers, not settlement receipts. Never serialize a
// record, result, request, dependency error message or stack into these logs.
function safeErrorClass(error) {
  try {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT') return 'TIMEOUT';
    if (error?.code === '57014') return 'QUERY_CANCELLED';
    if (error?.code === '55P03') return 'LOCK_UNAVAILABLE';
    if (error?.code === '40P01' || error?.code === '40001') return 'DATABASE_CONFLICT';
    if (error?.databaseOperation === true || error?.name === 'NeonDbError') return 'DATABASE_ERROR';
    if (error?.status === 429 || error?.statusCode === 429) return 'RATE_LIMIT';
    if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) return 'NETWORK_ERROR';
    return 'UNCLASSIFIED_ERROR';
  } catch { return 'UNCLASSIFIED_ERROR'; }
}
const STAGE_COUNTS = {
  NBA: ['checked', 'settled', 'pending', 'deferred'],
  SOCCER: ['checked', 'resultVerified', 'settled', 'pending', 'deferred'],
  FORWARD: ['checkedCaptureReceipts', 'evaluatedCaptureReceipts', 'pendingCaptureReceipts', 'failedCaptureReceipts', 'sourceRequests'],
  READER_ANALYSIS: ['checked', 'captured', 'refreshed', 'duplicate', 'retryable', 'deferred'],
  CLOUD: ['returnedTickets', 'deferred'],
};
function safeCounts(stage,value) {
  try { return Object.fromEntries((STAGE_COUNTS[stage]||[])
    .filter(key=>Number.isSafeInteger(value?.[key])&&value[key]>=0).map(key=>[key,value[key]])); }
  catch { return {}; }
}
function safeLog(event) {
  try { console.info('[BET_SETTLEMENT_CRON_STAGE]', JSON.stringify(event)); }
  catch { /* Observability must never change the settlement response/work. */ }
}

export async function GET(request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, {
      status: 401,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  const startedAt=Date.now();
  let activeStage=null,stageStartedAt=startedAt;
  const startStage=stage=>{
    activeStage=stage;stageStartedAt=Date.now();
    safeLog({stage,event:'START',elapsedMs:0,routeElapsedMs:Math.max(0,stageStartedAt-startedAt)});
  };
  const endStage=(event,value)=>{
    if(!activeStage)return;
    const at=Date.now(),stage=activeStage;activeStage=null;
    safeLog({stage,event,elapsedMs:Math.max(0,at-stageStartedAt),routeElapsedMs:Math.max(0,at-startedAt),
      ...(event==='ERROR'?{errorClass:safeErrorClass(value)}:{counts:safeCounts(stage,value)})});
  };
  const endRoute=(event,error)=>safeLog({stage:'ROUTE',event,elapsedMs:Math.max(0,Date.now()-startedAt),
    ...(event==='ERROR'?{errorClass:safeErrorClass(error)}:{})});
  try {
    startStage('NBA');
    let nba;
    try { nba = await settleOpenNbaManualRecords({ limit: 100, timeBudgetMs: 15000 }); endStage('COMPLETE',nba); }
    catch (error) { endStage('ERROR',error); nba = { status: 'unavailable', settled: 0 }; }
    startStage('SOCCER');
    let soccer;
    try { soccer=await settleOpenSoccerManualRecords({limit:100,timeBudgetMs:15000}); endStage('COMPLETE',soccer); }
    catch (error) { endStage('ERROR',error); soccer={status:'unavailable',settled:0}; }
    startStage('FORWARD');
    let soccerForward;
    try {
      soccerForward=await collectSoccerForwardBacklog({receiptLimit:12,timeBudgetMs:8000}); endStage('COMPLETE',soccerForward);
    } catch (error) { endStage('ERROR',error); soccerForward={status:'unavailable',checkedCaptureReceipts:0,formalEligible:false}; }
    startStage('READER_ANALYSIS');
    let soccerReaderCapture;
    try{soccerReaderCapture=await drainSoccerReaderAnalysis({timeBudgetMs:10000,maxGames:1});endStage('COMPLETE',soccerReaderCapture);}
    catch(error){endStage('ERROR',error);soccerReaderCapture={status:'unavailable',captured:0,executable:false};}
    // Reserve 22 seconds for overhead. The existing ledger receives the actual
    // remaining budget after the recoverable Reader work, never an extra 240 s.
    // Settlement must not depend on a user opening the ledger page. Process all
    // leagues from the durable OPEN ledger; each ticket is still settled only
    // from its verified official final result and the versioned Tai888 contract.
    const remainingBudgetMs=Math.max(0,Math.min(240_000,278000-(Date.now()-startedAt)));
    // The ledger's zero option means its default budget, so an exhausted route
    // must explicitly defer work rather than accidentally start another 240 s.
    startStage('CLOUD');
    const bets = remainingBudgetMs>0?await settleOpenCloudBets({ limit: 500, timeBudgetMs: remainingBudgetMs }):[];
    endStage('COMPLETE',{returnedTickets:Array.isArray(bets)?bets.length:undefined,deferred:remainingBudgetMs===0?1:0});
    const summary = bets.reduce((acc, bet) => {
      const status = String(bet?.status || 'UNKNOWN').toUpperCase();
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    const response=NextResponse.json({ ok: true, summary, nba, soccer, soccerForward, soccerReaderCapture,
      settlementDeferred:remainingBudgetMs===0 }, {
      headers: { 'Cache-Control': 'no-store' },
    });
    endRoute('COMPLETE');
    return response;
  } catch (error) {
    endStage('ERROR',error);
    endRoute('ERROR',error);
    return NextResponse.json({
      ok: false,
      error: String(error?.message || error),
    }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
