import { NextResponse } from 'next/server';
import { settleOpenCloudBets } from '../../../../lib/cloud-bet-store.js';

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
    // Settlement must not depend on a user opening the ledger page. Process all
    // leagues from the durable OPEN ledger; each ticket is still settled only
    // from its verified official final result and the versioned Tai888 contract.
    const bets = await settleOpenCloudBets({ limit: 500 });
    const summary = bets.reduce((acc, bet) => {
      const status = String(bet?.status || 'UNKNOWN').toUpperCase();
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    return NextResponse.json({ ok: true, summary }, {
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
