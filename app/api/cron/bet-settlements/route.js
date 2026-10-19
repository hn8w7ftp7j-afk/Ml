import { NextResponse } from 'next/server';
import { settleOpenCloudBets } from '../../../../lib/cloud-bet-store.js';
import { settleOpenNbaManualRecords } from '../../../../lib/nba/manual-bet-settlement-service.js';
import { settleOpenSoccerManualRecords } from '../../../../lib/soccer/manual-settlement-service.js';
import { runSoccerForwardValidation } from '../../../../lib/soccer/forward-validation-service.js';
import { soccerDate, shiftSoccerDate } from '../../../../lib/soccer/contracts.js';

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
    let nba;
    try { nba = await settleOpenNbaManualRecords({ limit: 100, timeBudgetMs: 15000 }); }
    catch { nba = { status: 'unavailable', settled: 0 }; }
    let soccer;
    try { soccer=await settleOpenSoccerManualRecords({limit:100,timeBudgetMs:15000}); }
    catch { soccer={status:'unavailable',settled:0}; }
    let soccerForward;
    try {
      const today=soccerDate();
      soccerForward=await runSoccerForwardValidation({from:shiftSoccerDate(today,-7),through:today},{limit:5,timeBudgetMs:8000});
    } catch { soccerForward={status:'unavailable',evaluated:0,formalEligible:false}; }
    // Budgets total 278 s (15 + 15 + 8 + 240), leaving 22 s for
    // route overhead within this cron's 300 s duration.
    // Settlement must not depend on a user opening the ledger page. Process all
    // leagues from the durable OPEN ledger; each ticket is still settled only
    // from its verified official final result and the versioned Tai888 contract.
    const bets = await settleOpenCloudBets({ limit: 500, timeBudgetMs: 240_000 });
    const summary = bets.reduce((acc, bet) => {
      const status = String(bet?.status || 'UNKNOWN').toUpperCase();
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    return NextResponse.json({ ok: true, summary, nba, soccer, soccerForward }, {
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
