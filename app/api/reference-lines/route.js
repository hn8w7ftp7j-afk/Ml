import { NextResponse } from 'next/server';
import {
  REFERENCE_LINES_VERSION,
  normalizeJbotReference,
  normalizeOddsApiReference,
  referenceProviderStatus,
} from '../../../lib/reference-lines.js';
import { oddsApiWindow } from '../../../lib/reference-time.js';
import { signMarketGames } from '../../../lib/market-integrity-v1.js';
import { fetchOfficialTaipeiSlate, validateOfficialScheduleSubset } from '../../../lib/official-schedule-v1.js';
import {
  checkRateLimit,
  cleanText,
  originErrorResponse,
  rateLimitResponse,
  readJsonBody,
  requireApiAuth,
  validDateString,
  validateSameOrigin,
} from '../../../lib/security.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const cache = globalThis.__MLB_REFERENCE_LINES_CACHE_V93__ || new Map();
globalThis.__MLB_REFERENCE_LINES_CACHE_V93__ = cache;
let lastJbotRequestAt = globalThis.__MLB_LAST_JBOT_REQUEST_AT__ || 0;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function sanitizeSchedule(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 40).map(game => ({
    gamePk: Number(game?.gamePk) || null,
    gameDate: cleanText(game?.gameDate, 40),
    officialDate: cleanText(game?.officialDate, 20),
    status: cleanText(game?.status, 60),
    statusEnglish: cleanText(game?.statusEnglish, 60),
    statusCode: cleanText(game?.statusCode, 10),
    gameNumber: Math.max(1, Number(game?.gameNumber) || 1),
    scheduledInnings: Math.max(1, Number(game?.scheduledInnings) || 9),
    away: cleanText(game?.away, 80),
    home: cleanText(game?.home, 80),
    awayEnglish: cleanText(game?.awayEnglish, 80),
    homeEnglish: cleanText(game?.homeEnglish, 80),
    awayTeamId: Number(game?.awayTeamId) || null,
    homeTeamId: Number(game?.homeTeamId) || null,
    awayProbableId: Number(game?.awayProbableId) || null,
    homeProbableId: Number(game?.homeProbableId) || null,
    awayProbable: cleanText(game?.awayProbable, 80),
    homeProbable: cleanText(game?.homeProbable, 80),
    venue: cleanText(game?.venue, 100),
    venueEnglish: cleanText(game?.venueEnglish, 100),
    venueId: Number(game?.venueId) || null,
  })).filter(game => game.gamePk && game.away && game.home);
}

async function fetchJson(url, options, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`盤源回傳格式錯誤（${response.status}）`); }
    if (!response.ok) throw new Error(data?.message || data?.error || `盤源請求失敗（${response.status}）`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function loadJbot(date, schedule) {
  const token = process.env.JBOT_API_TOKEN || process.env.SPORTSBOT_API_TOKEN || process.env.JBOT_TOKEN;
  if (!token) return null;
  const elapsed = Date.now() - lastJbotRequestAt;
  if (elapsed < 5200) await sleep(5200 - elapsed);
  lastJbotRequestAt = Date.now();
  globalThis.__MLB_LAST_JBOT_REQUEST_AT__ = lastJbotRequestAt;
  const url = new URL('https://api.sportsbot.tech/v2/odds');
  url.searchParams.set('sport', 'MLB');
  url.searchParams.set('date', date);
  url.searchParams.set('mode', 'close');
  const payload = await fetchJson(url, { headers: { 'X-JBot-Token': token, Accept: 'application/json' } });
  const fetchedAt = new Date().toISOString();
  return { ...normalizeJbotReference(payload, schedule, { fetchedAt }), provider: 'JBOT_TAIWAN_SPORTS_LOTTERY' };
}

function oddsApiUrl(key, window = null) {
  const url = new URL('https://api.the-odds-api.com/v4/sports/baseball_mlb/odds');
  url.searchParams.set('apiKey', key);
  url.searchParams.set('regions', 'us');
  url.searchParams.set('markets', 'spreads,totals');
  url.searchParams.set('oddsFormat', 'decimal');
  url.searchParams.set('dateFormat', 'iso');
  if (window) {
    url.searchParams.set('commenceTimeFrom', window.start);
    url.searchParams.set('commenceTimeTo', window.end);
  }
  return url;
}

async function loadOddsApi(date, schedule) {
  const key = process.env.THE_ODDS_API_KEY;
  if (!key) return null;
  const window = oddsApiWindow(date, schedule);
  let payload;
  try {
    payload = await fetchJson(oddsApiUrl(key, window), { headers: { Accept: 'application/json' } });
  } catch (error) {
    if (!/commenceTime(?:From|To)|ISO 8601|timestamp/i.test(String(error?.message || error))) throw error;
    payload = await fetchJson(oddsApiUrl(key), { headers: { Accept: 'application/json' } });
  }
  const fetchedAt = new Date().toISOString();
  return { ...normalizeOddsApiReference(payload, schedule, { fetchedAt }), provider: 'THE_ODDS_API_CONSENSUS', requestWindow: window };
}

export async function GET(request) {
  const auth = await requireApiAuth(request);
  if (auth) return auth;
  return NextResponse.json({ ok: true, version: REFERENCE_LINES_VERSION, ...referenceProviderStatus() }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request);
    if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'reference-lines-v9-3', limit: 12, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 500_000);
    const date = cleanText(body?.date, 20);
    const requestedSchedule = sanitizeSchedule(body?.schedule);
    if (!validDateString(date)) return NextResponse.json({ ok: false, error: '日期格式必須為 YYYY-MM-DD' }, { status: 400 });
    if (!requestedSchedule.length) return NextResponse.json({ ok: false, error: '今日賽事清單為空，無法配對參考盤' }, { status: 400 });
    const fullOfficialSlate = await fetchOfficialTaipeiSlate(date);
    const schedule = validateOfficialScheduleSubset(requestedSchedule, fullOfficialSlate, date);

    const status = referenceProviderStatus();
    if (!status.configured) {
      return NextResponse.json({
        ok: true,
        configured: false,
        version: REFERENCE_LINES_VERSION,
        providers: status.providers,
        games: [],
        unmatched: [],
        message: '合法盤源尚未設定。請在Server-side Environment Variable設定JBot或The Odds API金鑰；網站不會爬取未授權頁面。',
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const fullSlateIdentity = fullOfficialSlate.map(game => `${game.gamePk}:${game.awayTeamId}:${game.homeTeamId}:${game.gameNumber}:${game.gameDate}`).join('|');
    const key = `${status.primary}:${date}:${fullSlateIdentity}:${schedule.map(game => game.gamePk).join(',')}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return NextResponse.json({ ...cached.payload, cache: 'HIT' }, { headers: { 'Cache-Control': 'no-store' } });

    const failures = [];
    let result = null;
    try { result = await loadJbot(date, fullOfficialSlate); }
    catch (error) { failures.push(`JBot：${String(error?.message || error)}`); }
    if (!result) {
      try { result = await loadOddsApi(date, fullOfficialSlate); }
      catch (error) { failures.push(`The Odds API：${String(error?.message || error)}`); }
    }
    if (!result) return NextResponse.json({ ok: false, error: failures.join('；') || '沒有可用的合法參考盤來源' }, { status: 502 });

    const requestedGamePks = new Set(schedule.map(game => Number(game.gamePk)));
    const filteredGames = (Array.isArray(result.games) ? result.games : []).filter(row => requestedGamePks.has(Number(row.gamePk)));
    const signedGames = await signMarketGames(filteredGames);
    const payload = {
      ok: true,
      configured: true,
      version: REFERENCE_LINES_VERSION,
      provider: result.provider,
      providers: status.providers,
      games: signedGames,
      unmatched: result.unmatched,
      requestWindow: result.requestWindow || null,
      fetchedAt: new Date().toISOString(),
      failures,
      cache: 'MISS',
    };
    cache.set(key, { payload, expiresAt: Date.now() + 3 * 60 * 1000 });
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, {
      status: Number(error?.status) || 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
