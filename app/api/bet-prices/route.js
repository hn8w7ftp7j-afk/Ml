import { NextResponse } from 'next/server';
import { currentReaderPriceForBet, verifiedClosingPriceForBet } from '../../../lib/bet-price-feed.js';
import { listCloudBetsByIds } from '../../../lib/cloud-bet-store.js';
import { classifyDatabaseError, databaseFailureLog, isDatabaseError } from '../../../lib/database-error.js';
import { loadReaderSnapshot, readerSnapshotStatus } from '../../../lib/reader-store-v2.js';
import { checkRateLimit, originErrorResponse, rateLimitResponse, readJsonBody, requireApiAuth, validateSameOrigin } from '../../../lib/security.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const cleanId = value => String(value || '').trim().slice(0, 120);

export async function POST(request) {
  const auth = await requireApiAuth(request);
  if (auth) return auth;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'bet-price-feed-v1', limit: 120, windowMs: 10 * 60_000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 80_000);
    const ids = [...new Set((Array.isArray(body?.betIds) ? body.betIds : []).map(cleanId).filter(Boolean))].slice(0, 300);
    if (!ids.length) return NextResponse.json({ ok: true, prices: [] }, { headers: { 'Cache-Control': 'no-store' } });
    const wanted = new Set(ids);
    const bets = (await listCloudBetsByIds(ids)).filter(bet => wanted.has(bet.id));
    const groupKeys = [...new Set(bets.map(bet => `${bet.league}|||${bet.date}`))];
    const snapshots = new Map(await Promise.all(groupKeys.map(async key => {
      const [league, date] = key.split('|||');
      return [key, await loadReaderSnapshot(league, date)];
    })));
    const prices = bets.map(bet => {
      const snapshot = snapshots.get(`${bet.league}|||${bet.date}`);
      const status = readerSnapshotStatus(snapshot, Date.now(), bet.league);
      return {
        betId: bet.id,
        current: status.fresh ? currentReaderPriceForBet(bet, snapshot) : null,
        currentReaderFresh: status.fresh,
        currentReaderState: status.state,
        closing: verifiedClosingPriceForBet(bet),
      };
    });
    return NextResponse.json({ ok: true, prices }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (isDatabaseError(error)) {
      const failure = classifyDatabaseError(error);
      console.error('[BET_PRICE_FEED_READ_FAILED]', databaseFailureLog(error, 'BET_PRICE_FEED_READ_FAILED'));
      return NextResponse.json({
        ok: false,
        code: failure.code,
        error: failure.publicMessage,
        retryAfterSeconds: failure.retryAfterSeconds,
      }, {
        status: failure.status,
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': String(failure.retryAfterSeconds),
        },
      });
    }
    return NextResponse.json({ ok: false, error: error?.message || 'Reader 最新盤口比較讀取失敗' }, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
