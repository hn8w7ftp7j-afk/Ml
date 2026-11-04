import { NextResponse } from 'next/server';
import { settleOpenCloudBets } from '../../../../lib/cloud-bet-store.js';
import { settleOpenNbaManualRecords } from '../../../../lib/nba/manual-bet-settlement-service.js';
import { settleOpenSoccerManualRecords } from '../../../../lib/soccer/manual-settlement-service.js';
import { continueSoccerForwardBacklog } from '../../../../lib/soccer/forward-validation-scan.js';
import { soccerDate, shiftSoccerDate } from '../../../../lib/soccer/contracts.js';
import { drainSoccerReaderAnalysis } from '../../../../lib/soccer/reader-auto-analysis.js';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function authorized(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  return Boolean(secret) && request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(request) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, {
      status: 401,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  try {
    const startedAt=Date.now();
    let nba;
    try { nba = await settleOpenNbaManualRecords({ limit: 100, timeBudgetMs: 15000 }); }
    catch { nba = { status: 'unavailable', settled: 0 }; }
    let soccer;
    try { soccer=await settleOpenSoccerManualRecords({limit:100,timeBudgetMs:15000}); }
    catch { soccer={status:'unavailable',settled:0}; }
    let soccerForward;
    try {
      const today=soccerDate();
      const page=await continueSoccerForwardBacklog({from:shiftSoccerDate(today,-7),through:today},{gameLimit:5,timeBudgetMs:8000});
      soccerForward=page.summary;
    } catch { soccerForward={status:'unavailable',evaluated:0,formalEligible:false}; }
    let soccerReaderCapture;
    try{soccerReaderCapture=await drainSoccerReaderAnalysis({timeBudgetMs:10000,maxGames:1});}
    catch{soccerReaderCapture={status:'unavailable',captured:0,executable:false};}
    // Reserve 22 seconds for overhead. The existing ledger receives the actual
    // remaining budget after the recoverable Reader work, never an extra 240 s.
    // Settlement must not depend on a user opening the ledger page. Process all
    // leagues from the durable OPEN ledger; each ticket is still settled only
    // from its verified official final result and the versioned Tai888 contract.
    const remainingBudgetMs=Math.max(0,Math.min(240_000,278000-(Date.now()-startedAt)));
    // The ledger's zero option means its default budget, so an exhausted route
    // must explicitly defer work rather than accidentally start another 240 s.
    const bets = remainingBudgetMs>0?await settleOpenCloudBets({ limit: 500, timeBudgetMs: remainingBudgetMs }):[];
    const summary = bets.reduce((acc, bet) => {
      const status = String(bet?.status || 'UNKNOWN').toUpperCase();
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    return NextResponse.json({ ok: true, summary, nba, soccer, soccerForward, soccerReaderCapture,
      settlementDeferred:remainingBudgetMs===0 }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: String(error?.message || error),
    }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
