import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { bearerToken, readerCorsHeaders, readerOriginAllowed, verifyReaderToken } from '../../../../lib/reader-auth-v2.js';
import { requestedLeagueId, leagueConfig } from '../../../../lib/leagues.js';
import { resolveLeagueTeamId, TEAM_CODE_RE } from '../../../../lib/league-teams.js';
import { validateMarketPair } from '../../../../lib/markets.js';
import { loadLeagueCapture, storeLeagueCapture } from '../../../../lib/reader-capture-store-v3.js';
import { validateTai888ReaderEnvelope } from '../../../../lib/tai888-reader-parser-v2.js';
import { checkRateLimit, cleanText, rateLimitResponse, readJsonBody, validDateString } from '../../../../lib/security.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const LINE = /^(?:\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(?:平|[+-]\d{1,3})?$/;
const LEAGUE_READY = new Set(['NPB', 'KBO', 'CPBL']);

function validMarket(value, total = false) {
  if (!value || typeof value !== 'object') return false;
  const waters = total ? [value.overWater, value.underWater] : [value.awayWater, value.homeWater];
  return typeof value.line === 'string' && LINE.test(value.line)
    && waters.every(item => typeof item === 'number' && Number.isFinite(item) && item >= 0.01 && item <= 3)
    && (total || ['away', 'home'].includes(value.lineSide));
}

function marketPairErrors(game) {
  const rows = [];
  const addRunline = (market, value) => {
    if (!value) return;
    const favorite = value.lineSide === 'away' ? game.awayCode : game.homeCode;
    const underdog = value.lineSide === 'away' ? game.homeCode : game.awayCode;
    const waters = value.lineSide === 'away'
      ? [value.awayWater, value.homeWater]
      : [value.homeWater, value.awayWater];
    rows.push(...validateMarketPair(market, [
      { market, pick: `${favorite}讓${value.line}`, water: waters[0] },
      { market, pick: `${underdog}受讓${value.line}`, water: waters[1] },
    ]));
  };
  const addTotal = (market, value) => {
    if (!value) return;
    rows.push(...validateMarketPair(market, [
      { market, pick: `大${value.line}`, water: value.overWater },
      { market, pick: `小${value.line}`, water: value.underWater },
    ]));
  };
  addRunline('全場讓分', game.fullRunline);
  addTotal('全場大小', game.fullTotal);
  addRunline('上半讓分', game.first5Runline);
  addTotal('上半大小', game.first5Total);
  return [...new Set(rows)];
}

function normalize(body, league, token, receivedAt, envelope) {
  const boardDate = cleanText(body?.boardDate, 20);
  if (!validDateString(boardDate)) throw new Error('盤口日期格式錯誤');
  const observedAt = new Date(cleanText(body?.observedAt, 40)).toISOString();
  const pageActivityAt = new Date(cleanText(body?.pageActivityAt, 40)).toISOString();
  const received = Date.parse(receivedAt);
  const observedTime = Date.parse(observedAt);
  const activityTime = Date.parse(pageActivityAt);
  if (observedTime > received + 90_000 || received - observedTime > 600_000
    || activityTime > observedTime + 5_000 || activityTime > received + 5_000
    || received - activityTime > 180_000) throw new Error('盤口頁面已過期');
  const games = (Array.isArray(body?.games) ? body.games : []).slice(0, 40).map(game => {
    const awayCode = cleanText(game?.awayCode, 12).toUpperCase();
    const homeCode = cleanText(game?.homeCode, 12).toUpperCase();
    if (!TEAM_CODE_RE.test(awayCode) || !TEAM_CODE_RE.test(homeCode)
      || !resolveLeagueTeamId(league, awayCode) || !resolveLeagueTeamId(league, homeCode)
      || resolveLeagueTeamId(league, awayCode) === resolveLeagueTeamId(league, homeCode)
      || game?.boardDate !== boardDate || !TIME.test(game?.boardTime)) throw new Error('場次辨識資料錯誤');
    const locked = game.marketStatus === 'locked';
    const suppliedMarkets = [game.fullRunline, game.fullTotal, game.first5Runline, game.first5Total];
    if (locked && suppliedMarkets.some(value => value != null)) throw new Error('鎖盤場次不得夾帶盤口資料');
    if (!locked && (!validMarket(game.fullRunline) || !validMarket(game.fullTotal, true)
      || !validMarket(game.first5Runline) || !validMarket(game.first5Total, true))) throw new Error('盤口市場不完整');
    const runline = market => market ? { lineSide: market.lineSide, line: market.line, awayWater: market.awayWater, homeWater: market.homeWater } : null;
    const total = market => market ? { line: market.line, overWater: market.overWater, underWater: market.underWater } : null;
    const normalized = {
      awayCode, homeCode, boardDate, boardTime: game.boardTime,
      marketStatus: locked ? 'locked' : 'open',
      fullRunline: locked ? null : runline(game.fullRunline), fullTotal: locked ? null : total(game.fullTotal),
      first5Runline: locked ? null : runline(game.first5Runline), first5Total: locked ? null : total(game.first5Total),
    };
    if (!locked && marketPairErrors(normalized).length) throw new Error('盤口市場配對不一致');
    return normalized;
  });
  if (!games.length) throw new Error('未找到可安全儲存的場次');
  const unique = new Set(games.map(game => `${game.awayCode}|${game.homeCode}|${game.boardTime}`));
  if (unique.size !== games.length) throw new Error('場次重複');
  return {
    version: 'TAI888-CAPTURE-v3.1.0', league, boardDate, games,
    gameCount: games.length, observedAt, pageActivityAt, receivedAt,
    readerVersion: envelope.readerVersion, deviceId: token.deviceId,
    sourceHost: envelope.sourceHost, pageUrl: envelope.pageUrl,
    rawBoardHash: envelope.rawBoardHash,
    clientPayloadHash: cleanText(body?.payloadHash, 64).toLowerCase(),
    payloadHash: createHash('sha256').update(JSON.stringify({
      domain: 'baseball-positive-ev/reader-capture-staging/v2', league, boardDate, games,
    })).digest('hex'),
    executable: false,
  };
}

function assertCaptureMonotonic(previous, snapshot) {
  if (!previous) return;
  const previousObserved = Date.parse(previous.observedAt || '');
  const previousActivity = Date.parse(previous.pageActivityAt || '');
  const observed = Date.parse(snapshot.observedAt || '');
  const activity = Date.parse(snapshot.pageActivityAt || '');
  if ((Number.isFinite(previousObserved) && observed <= previousObserved)
    || (Number.isFinite(previousActivity) && activity < previousActivity)
    || (previous.payloadHash !== snapshot.payloadHash
      && Number.isFinite(previousActivity) && activity <= previousActivity)) {
    const error = new Error('Reader capture 時間倒退或重播，已拒絕覆蓋');
    error.status = 409;
    throw error;
  }
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
    const receivedAt = new Date().toISOString();
    const envelope = validateTai888ReaderEnvelope(body, { receivedAt, league });
    const snapshot = normalize(body, league, token, receivedAt, envelope);
    const previous = await loadLeagueCapture(league, snapshot.boardDate);
    assertCaptureMonotonic(previous, snapshot);
    const storage = await storeLeagueCapture(snapshot);
    if (!storage.ok) return NextResponse.json({ ok: false, error: 'Reader 盤口儲存失敗' }, { status: 503, headers });
    return NextResponse.json({ ok: true, league, captured: true, executable: false, rawGameCount: snapshot.gameCount, matchedGameCount: 0, boardDate: snapshot.boardDate, payloadHash: snapshot.payloadHash, runtimeCache: storage.runtimeCache, message: `${leagueConfig(league).shortLabel}已抓到 ${snapshot.gameCount} 場｜等待賽程與模型驗證` }, { headers });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || '盤口資料錯誤' }, { status: Number(error?.status) || 400, headers });
  }
}
