import { randomBytes, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireApiAuth, readCookie, readJsonBody, validateSameOrigin, originErrorResponse, checkRateLimit, rateLimitResponse } from '../../../lib/security.js';
import { PUSH_COOKIE, deviceHash, pushStatus, savePushDevice, removePushDevice, sendPush } from '../../../lib/analysis-push.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  try {
    return NextResponse.json({ ok: true, ...await pushStatus(deviceHash(readCookie(request, PUSH_COOKIE))) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ ok: false, error: '通知服務暫時無法使用' }, { status: 503 }); }
}
export async function POST(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'analysis-notifications', limit: 20, windowMs: 600000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 8192);
    let token = readCookie(request, PUSH_COOKIE);
    let id = deviceHash(token);
    if (body.action === 'subscribe') {
      if (!id) { token = randomBytes(32).toString('hex'); id = deviceHash(token); }
      await savePushDevice(id, body.subscription);
      const response = NextResponse.json({ ok: true });
      response.cookies.set(PUSH_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 31536000 });
      return response;
    }
    if (!id) return NextResponse.json({ ok: false, error: '請先啟用通知' }, { status: 400 });
    if (body.action === 'unsubscribe') {
      await removePushDevice(id);
      return NextResponse.json({ ok: true });
    }
    if (body.action === 'test') {
      const result = await sendPush(id, { title: '測試通知', body: '分析通知已連線；點此返回網站。', url: '/', tag: 'analysis-push-test' }, `test-${id}-${randomUUID()}`);
      return NextResponse.json({ ok: result.status === 'sent', ...result });
    }
    return NextResponse.json({ ok: false, error: '不支援的通知操作' }, { status: 400 });
  } catch { return NextResponse.json({ ok: false, error: '通知操作失敗，請稍後重試' }, { status: 503 }); }
}
