import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { bearerToken, readerCorsHeaders, readerOriginAllowed, verifyReaderToken } from '../../../../lib/reader-auth-v2.js';
import { requestedLeagueId, leagueConfig } from '../../../../lib/leagues.js';
import { storeLeagueCapture } from '../../../../lib/reader-capture-store-v3.js';
import { checkRateLimit, cleanText, rateLimitResponse, readJsonBody, validDateString } from '../../../../lib/security.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const CODE = /^[A-Z]{2,4}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const LEAGUE_READY = new Set(['NPB', 'KBO', 'CPBL']);

function validMarket(value, total = false) {
  if (!value || typeof value !== 'object') return false;
  const waters = total ? [value.overWater, value.underWater] : [value.awayWater, value.homeWater];
  return typeof value.line === 'string' && value.line.length <= 20
    && waters.every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0.01 && item <= 3)
    && (total || ['away', 'home'].includes(value.lineSide));
}

function normalize(body, league, token, receivedAt) {
  const boardDate = cleanText(body?.boardDate, 20);
  if (!validDateString(boardDate)) throw new Error('盤口日期格式錯誤');
  const observedAt = new Date(cleanText(body?.observedAt, 40)).toISOString();
  const pageActivityAt = new Date(cleanText(body?.pageActivityAt, 40)).toISOString();
  const received = Date.parse(receivedAt);
  if (Math.abs(received - Date.parse(observedAt)) > 600_000 || received - Date.parse(pageActivityAt) > 180_000) throw new Error('盤口頁面已過期');
  const games = (Array.isArray(body?.games) ? body.games : []).slice(0, 40).map(game => {
    if (!CODE.test(game?.awayCode) || !CODE.test(game?.homeCode) || game.awayCode === game.homeCode
      || game?.boardDate !== boardDate || !TIME.test(game?.boardTime)) throw new Error('場次辨識資料錯誤');
    const locked = game.marketStatus === 'locked';
    if (!locked && (!validMarket(game.fullRunline) || !validMarket(game.fullTotal, true)
      || !validMarket(game.first5Runline) || !validMarket(game.first5Total, true))) throw new Error('盤口市場不完整');
    return {
      awayCode: game.awayCode, homeCode: game.homeCode, boardDate, boardTime: game.boardTime,
      marketStatus: locked ? 'locked' : 'open',
      fullRunline: locked ? null : game.fullRunline, fullTotal: locked ? null : game.fullTotal,
      first5Runline: locked ? null : game.first5Runline, first5Total: locked ? null : game.first5Total,
    };
  });
  if (!games.length) throw new Error('未找到可安全儲存的場次');
  const unique = new Set(games.map(game => `${game.awayCode}|${game.homeCode}|${game.boardTime}`));
  if (unique.size !== games.length) throw new Error('場次重複');
  const canonical = JSON.stringify({ league, boardDate, games });
  return {
    version: 'TAI888-CAPTURE-v3.0.0', league, boardDate, games,
    gameCount: games.length, observedAt, pageActivityAt, receivedAt,
    readerVersion: cleanText(body?.readerVersion, 30), deviceId: token.deviceId,
    payloadHash: createHash('sha256').update(canonical).digest('hex'),
    executable: false,
  };
}

export async function OPTIONS(request) {
  const headers = readerCorsHeaders(request);
  return new Response(null, { status: readerOriginAllowed(request) ? 204 : 403, headers });
}

export async function POST(request) {
  const headers = readerCorsHeaders(request);
  if (!readerOriginAllowed(request)) return NextResponse.json({ ok: false, error: '不允許的 Reader 請求來源' }, { status: 403, headers });
  const rate = checkRateLimit(request, { id: 'reader-capture-v3', limit: 300, windowMs: 600_000 });
  if (!rate.allowed) { const response = rateLimitResponse(rate); Object.entries(headers).forEach(([k, v]) => response.headers.set(k, v)); return response; }
  const token = await verifyReaderToken(bearerToken(request));
  if (!token || cleanText(request.headers.get('x-device-id'), 100) !== token.deviceId) return NextResponse.json({ ok: false, error: 'Reader 配對已失效' }, { status: 401, headers });
  try {
    const body = await readJsonBody(request, 600_000);
    const league = requestedLeagueId(body?.league);
    if (!league) return NextResponse.json({ ok: false, code: 'UNKNOWN_LEAGUE', error: '不支援的聯盟' }, { status: 400, headers });
    if (!LEAGUE_READY.has(league)) return NextResponse.json({ ok: false, code: 'USE_MLB_INGEST', error: 'MLB 必須使用已驗證的 ingest' }, { status: 409, headers });
    const snapshot = normalize(body, league, token, new Date().toISOString());
    const storage = await storeLeagueCapture(snapshot);
    if (!storage.ok) return NextResponse.json({ ok: false, error: 'Reader 盤口儲存失敗' }, { status: 503, headers });
    return NextResponse.json({ ok: true, league, captured: true, executable: false, rawGameCount: snapshot.gameCount, matchedGameCount: 0, boardDate: snapshot.boardDate, payloadHash: snapshot.payloadHash, runtimeCache: storage.runtimeCache, message: `${leagueConfig(league).shortLabel}已抓到 ${snapshot.gameCount} 場｜等待賽程與模型驗證` }, { headers });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || '盤口資料錯誤' }, { status: 400, headers });
  }
}
