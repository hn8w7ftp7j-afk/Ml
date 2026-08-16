import { NextResponse } from 'next/server';
import { clearCloudLeague, deleteCloudBet, listCloudBets, mergeCloudBets, upsertCloudBet } from '../../../lib/cloud-bet-store.js';
import { checkRateLimit, originErrorResponse, rateLimitResponse, readJsonBody, requireApiAuth, validateSameOrigin } from '../../../lib/security.js';

const response = bets => NextResponse.json({ ok: true, bets }, { headers: { 'Cache-Control': 'no-store' } });

export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  try { return response(await listCloudBets()); }
  catch { return NextResponse.json({ ok: false, error: '雲端下注紀錄讀取失敗' }, { status: 503 }); }
}

export async function POST(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'cloud-bets', limit: 90, windowMs: 60_000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 300_000);
    if (body.action === 'merge') return response(await mergeCloudBets(body.bets));
    if (body.action === 'upsert') return response(await upsertCloudBet(body.bet));
    if (body.action === 'delete') return response(await deleteCloudBet(body.positionIdentity));
    if (body.action === 'clearLeague') return response(await clearCloudLeague(body.league));
    return NextResponse.json({ ok: false, error: '不支援的下注紀錄操作' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || '雲端下注紀錄更新失敗' }, { status: 400 });
  }
}
