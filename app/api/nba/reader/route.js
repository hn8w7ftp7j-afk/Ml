import { NextResponse } from 'next/server';
import { bearerToken, verifyReaderToken, readerOriginAllowed, readerCorsHeaders } from '../../../../lib/reader-auth-v2.js';
import { checkRateLimit, readJsonBody, requireApiAuth } from '../../../../lib/security.js';
import { validDate } from '../../../../lib/nba/identity.js';
import { normalizeNbaReaderPayload, nbaReaderPublicView } from '../../../../lib/nba/reader.js';
import { loadNbaReaderSnapshot, storeNbaReaderSnapshot } from '../../../../lib/nba/reader-store.js';
import {
  marketLineHistoryDatabaseConfigured,
  recordMarketLineHistory,
} from '../../../../lib/market-line-history-v1.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const respond = (request, body, status = 200) => NextResponse.json({ ...body, league: 'NBA', executable: false }, { status, headers: readerCorsHeaders(request) });
function rejected(request, code, error, status) {
  console.warn('[NBA_READER_CAPTURE_REJECTED]', { code, status });
  return respond(request, { ok: false, code, error }, status);
}
async function trackMarketLineHistory(snapshot) {
  try {
    const result = await recordMarketLineHistory(snapshot);
    if (result.inserted > 0) console.info('[NBA_MARKET_LINE_HISTORY_SAVED]', {
      league: snapshot?.league,
      boardDate: snapshot?.boardDate,
      checked: result.checked,
      inserted: result.inserted,
      unchanged: result.unchanged,
    });
    return result;
  } catch (error) {
    console.error('[NBA_MARKET_LINE_HISTORY_WRITE_FAILED]', String(error?.message || error));
    return {
      configured: marketLineHistoryDatabaseConfigured(),
      checked: 0,
      inserted: 0,
      unchanged: 0,
      failed: 1,
    };
  }
}

export async function OPTIONS(request) {
  return new Response(null, { status: readerOriginAllowed(request) ? 204 : 403, headers: readerCorsHeaders(request) });
}
export async function GET(request) {
  if (!readerOriginAllowed(request)) return respond(request, { ok: false, code: 'NBA_READER_ORIGIN_FORBIDDEN', error: '不允許的 Reader 來源' }, 403);
  const denied = await requireApiAuth(request); if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const date = params.get('date') || '';
  if ((date && !validDate(date)) || (params.has('league') && params.get('league') !== 'NBA')) return respond(request, { ok: false, code: 'NBA_READER_DATE_INVALID', error: 'NBA 日期必須是有效的 YYYY-MM-DD，聯盟必須是 NBA' }, 400);
  const rate = checkRateLimit(request, { id: 'nba-reader-status', limit: 240, windowMs: 600_000 });
  if (!rate.allowed) return respond(request, { ok: false, error: '讀取太頻繁，請稍後再試', retryAfter: rate.retryAfter }, 429);
  try {
    const snapshot = await loadNbaReaderSnapshot(date);
    return respond(request, { ok: true, ...nbaReaderPublicView(snapshot, { boardDate: date }) });
  } catch (error) {
    console.warn('[NBA_READER_READ_FAILED]', { code: error.code || 'NBA_READER_READ_FAILED', status: error.status || 503 });
    return respond(request, { ok: false, code: error.code || 'NBA_READER_READ_FAILED', error: error.message || 'NBA 盤口暫時無法取得' }, error.status || 503);
  }
}
export async function POST(request) {
  if (!readerOriginAllowed(request)) return rejected(request, 'NBA_READER_ORIGIN_FORBIDDEN', '不允許的 Reader 來源', 403);
  const token = await verifyReaderToken(bearerToken(request));
  if (!token || request.headers.get('x-device-id') !== token.deviceId) return rejected(request, 'NBA_READER_AUTH_INVALID', 'Reader 未配對、授權過期或裝置身分不符', 401);
  const rate = checkRateLimit(request, { id: 'nba-reader-capture', limit: 300, windowMs: 600_000 });
  if (!rate.allowed) return respond(request, { ok: false, error: '請稍後再同步', retryAfter: rate.retryAfter }, 429);
  try {
    const payload = await readJsonBody(request, 600_000);
    const snapshot = normalizeNbaReaderPayload(payload, { deviceId: token.deviceId, headerVersion: request.headers.get('x-reader-version') });
    const storage = await storeNbaReaderSnapshot(snapshot);
    const historyTracking = await trackMarketLineHistory(snapshot);
    console.info('[NBA_READER_CAPTURE_ACCEPTED]', { code: 'NBA_READER_CAPTURE_ACCEPTED', status: 200, boardDate: snapshot.boardDate,
      gameCount: snapshot.gameCount, marketCount: snapshot.marketCount, readerVersion: snapshot.readerVersion });
    return respond(request, { ok: true, captured: true, boardDate: snapshot.boardDate, gameCount: snapshot.gameCount,
      rawGameCount: snapshot.gameCount, matchedGameCount: 0, marketCount: snapshot.marketCount, directionCount: snapshot.marketCount * 2,
      identityStatus: 'team_mapped_game_unverified', ...storage, historyTracking,
      message: `NBA 已讀取 ${snapshot.gameCount} 場、${snapshot.marketCount} 個市場` });
  } catch (error) {
    console.warn('[NBA_READER_CAPTURE_REJECTED]', { code: error.code || 'NBA_READER_CAPTURE_FAILED', status: error.status || 503 });
    return respond(request, { ok: false, code: error.code || 'NBA_READER_CAPTURE_FAILED', error: error.message || 'NBA 盤口未確認保存' }, error.status || 503);
  }
}
