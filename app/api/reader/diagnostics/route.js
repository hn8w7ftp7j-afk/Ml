import { bearerToken, verifyReaderToken, readerOriginAllowed, readerCorsHeaders } from '../../../../lib/reader-auth-v2.js';
import { requireApiAuth, readJsonBody, checkRateLimit } from '../../../../lib/security.js';
import { DIAGNOSTIC_LEAGUES } from '../../../../reader/diagnostic-schema.js';
import { saveReaderDiagnostic, listReaderDiagnostics } from '../../../../lib/reader-diagnostic-store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const reply = (request, body, status = 200) => Response.json(body, { status, headers: readerCorsHeaders(request) });
export async function OPTIONS(request) {
  return new Response(null, { status: readerOriginAllowed(request) ? 204 : 403, headers: readerCorsHeaders(request) });
}
export async function POST(request) {
  if (!readerOriginAllowed(request)) return reply(request, { ok: false, error: '不允許的 Reader 請求來源' }, 403);
  const identity = await verifyReaderToken(bearerToken(request));
  if (!identity) return reply(request, { ok: false, error: '診斷回傳需要有效 Reader 配對' }, 401);
  if (request.headers.get('x-device-id') !== identity.deviceId) return reply(request, { ok: false, error: '診斷裝置與配對不符' }, 403);
  const rate = checkRateLimit(request, { id: `reader-diagnostics:${identity.deviceId}`, limit: 90, windowMs: 600000 });
  if (!rate.allowed) return reply(request, { ok: false, error: '診斷回傳過於頻繁' }, 429);
  try { return reply(request, await saveReaderDiagnostic(await readJsonBody(request, 49152), identity.deviceId)); }
  catch (error) { return reply(request, { ok: false, error: error.status === 400 || error.status === 413 || error.status === 409 ? error.message : '診斷尚未保存，Reader 將自動補傳' }, error.status || 503); }
}
export async function GET(request) {
  if (!readerOriginAllowed(request)) return reply(request, { ok: false, error: '不允許的查詢來源' }, 403);
  // A Reader token can only submit diagnostics; it cannot read other devices.
  const auth = await requireApiAuth(request); if (auth) return auth;
  const rate = checkRateLimit(request, { id: 'reader-diagnostics-read', limit: 120, windowMs: 600000 });
  if (!rate.allowed) return reply(request, { ok: false, error: '查詢過於頻繁' }, 429);
  const params = new URL(request.url).searchParams;
  const deviceId = params.get('deviceId') || '', league = params.get('league') || '';
  if (deviceId && !/^[a-zA-Z0-9._:-]{8,100}$/.test(deviceId) || league && !DIAGNOSTIC_LEAGUES.includes(league)) return reply(request, { ok: false, error: '診斷查詢條件錯誤' }, 400);
  try { return reply(request, { ok: true, retentionDays: 14, reports: await listReaderDiagnostics({ deviceId, league }) }); }
  catch { return reply(request, { ok: false, error: '診斷資料庫暫時無法查詢' }, 503); }
}
