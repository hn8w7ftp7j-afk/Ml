import { NextResponse } from 'next/server';
import {
  createReaderToken,
  readerCorsHeaders,
  readerOriginAllowed,
  readerPairingConfigured,
  readerPairPasswordMatches,
} from '../../../../lib/reader-auth-v2.js';
import { MINIMUM_READER_VERSION, readerVersionSupported } from '../../../../lib/tai888-reader-parser-v2.js';
import { checkRateLimit, cleanText, rateLimitResponse, readJsonBody } from '../../../../lib/security.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  const headers = readerCorsHeaders(request);
  if (!readerOriginAllowed(request)) return new Response(null, { status: 403, headers });
  return new Response(null, { status: 204, headers });
}

export async function POST(request) {
  const headers = readerCorsHeaders(request);
  if (!readerOriginAllowed(request)) {
    return NextResponse.json({ ok: false, error: '不允許的 Reader 請求來源' }, { status: 403, headers });
  }
  try {
    const rate = checkRateLimit(request, { id: 'reader-pair-v2', limit: 8, windowMs: 15 * 60 * 1000 });
    if (!rate.allowed) {
      const response = rateLimitResponse(rate);
      for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      return response;
    }
    if (!readerVersionSupported(request.headers.get('x-reader-version'))) {
      return NextResponse.json({
        ok: false,
        error: `Reader 版本過舊，最低需要 ${MINIMUM_READER_VERSION}`,
      }, { status: 426, headers });
    }
    if (!readerPairingConfigured()) {
      return NextResponse.json({ ok: false, error: 'Reader 配對密碼尚未設定' }, { status: 503, headers });
    }
    const body = await readJsonBody(request, 16_000);
    const deviceId = cleanText(body.deviceId, 100);
    const deviceName = cleanText(body.deviceName, 100);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[a-zA-Z0-9._:-]{8,100}$/.test(deviceId)) {
      return NextResponse.json({ ok: false, error: 'Reader 裝置識別碼格式錯誤' }, { status: 400, headers });
    }
    if (!(await readerPairPasswordMatches(password))) {
      await new Promise(resolve => setTimeout(resolve, 350));
      return NextResponse.json({ ok: false, error: 'Reader 配對密碼不正確' }, { status: 401, headers });
    }
    const token = await createReaderToken({ deviceId, deviceName });
    return NextResponse.json({
      ok: true,
      token,
      deviceId,
      expiresInSeconds: 60 * 60 * 24 * 90,
      message: 'Tai888 Reader 配對完成，已啟用自動同步。',
    }, { headers });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, {
      status: Number(error?.status) || 500,
      headers,
    });
  }
}
