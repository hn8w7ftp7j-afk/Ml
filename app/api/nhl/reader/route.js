import { NextResponse } from 'next/server';
import { bearerToken, verifyReaderToken, readerOriginAllowed, readerCorsHeaders } from '../../../../lib/reader-auth-v2.js';
import { checkRateLimit, readJsonBody, requireApiAuth } from '../../../../lib/security.js';
import { validateNhlCapture, NHL_READER_WAITING_MESSAGE } from '../../../../lib/nhl/reader.js';
import { saveNhlObservation, loadNhlObservations, nhlPersistenceConfigured } from '../../../../lib/nhl/store.js';
import { nhlDate, validNhlDate } from '../../../../lib/nhl/identity.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function OPTIONS(request) { return new Response(null, { status: readerOriginAllowed(request) ? 204 : 403, headers: readerCorsHeaders(request) }); }
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const headers = { 'Cache-Control': 'no-store' };
  const requestedDate = new URL(request.url).searchParams.get('date');
  const date = requestedDate || nhlDate(Date.now());
  if (!validNhlDate(date)) return NextResponse.json({ ok: false, league: 'NHL', error: '日期無效' }, { status: 400, headers });
  if (!requestedDate) return NextResponse.json({ ok: true, league: 'NHL', message: NHL_READER_WAITING_MESSAGE,
    captureSupported: true, minimumReaderVersion: '2.1.31', persistenceConfigured: nhlPersistenceConfigured(), verifiedMarkets: [], executable: false }, { headers });
  if (!nhlPersistenceConfigured()) return NextResponse.json({ ok: false, league: 'NHL', date, status: 'BLOCKED', error: 'NHL 永久快照資料庫尚未設定', executable: false }, { status: 503, headers });
  try {
    const [capture] = await loadNhlObservations('READER', date, 1);
    const games = capture?.games || [];
    return NextResponse.json({ ok: true, league: 'NHL', date, captureSupported: true, minimumReaderVersion: '2.1.31',
      status: capture ? 'CAPTURED_RULES_UNVERIFIED' : 'WAITING_REAL_DATA',
      message: capture ? 'NHL 原盤已保存，結算規則待驗證' : NHL_READER_WAITING_MESSAGE,
      observedAt: capture?.observedAt || null, revision: capture?.revision || null,
      rawGameCount: games.length, rawRowCount: capture?.rawRows?.length || 0,
      games, verifiedMarkets: [], executable: false,
    }, { headers });
  } catch (error) { return NextResponse.json({ ok: false, league: 'NHL', date, status: 'BLOCKED', code: error.code || 'NHL_READER_LOAD_FAILED', error: 'NHL 原盤快照讀取失敗', executable: false }, { status: error.status || 503, headers }); }
}
export async function POST(request) {
  const headers = readerCorsHeaders(request);
  const respond = (body, status) => NextResponse.json({ ...body, league: 'NHL' }, { status, headers });
  if (!readerOriginAllowed(request)) return respond({ ok: false, error: '不允許的 Reader 來源' }, 403);
  const token = await verifyReaderToken(bearerToken(request));
  if (!token) return respond({ ok: false, error: 'Reader 未配對或授權已過期' }, 401);
  if (request.headers.get('x-device-id') !== token.deviceId) return respond({ ok: false, error: 'Reader 裝置身分不符' }, 403);
  const rate = checkRateLimit(request, { id: 'nhl-reader-capture', limit: 20, windowMs: 60_000 });
  if (!rate.allowed) return respond({ ok: false, error: '請稍後再同步', retryAfter: rate.retryAfter }, 429);
  try {
    const input = await readJsonBody(request, 128_000);
    const capture = validateNhlCapture(input, { headerVersion: request.headers.get('x-reader-version') });
    if (!capture.ok) return respond(capture, 422);
    const stored = await saveNhlObservation('READER', capture.payload.boardDate, { ...capture.payload, deviceId: token.deviceId });
    const games = capture.payload.games || [];
    const marketCount = games.reduce((count, game) => count + Object.values(game.parsedMarkets).filter(Boolean).length, 0);
    return respond({ ok: true, ...stored, message: 'NHL 原盤已保存，結算規則待驗證',
      rawGameCount: games.length, recognizedGameCount: games.length, matchedGameCount: 0,
      unopenedGameCount: games.filter(game => game.marketStatus === 'locked').length,
      rawRowCount: capture.payload.rawRows.length, marketCount, directionCount: 0,
      executable: false, marketVerification: 'CAPTURED_RULES_UNVERIFIED' }, 200);
  } catch (error) { return respond({ ok: false, error: error.status === 413 ? 'Reader資料過大' : 'NHL Reader來源快照未保存', code: error.code || 'NHL_READER_CAPTURE_FAILED' }, error.status || 503); }
}
