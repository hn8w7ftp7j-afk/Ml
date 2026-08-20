import { NextResponse } from 'next/server';
import {
  ODDS_API_EVENT_MARKETS,
  REFERENCE_LINES_VERSION,
  filterReferenceGamesToTargets,
  matchReferenceScheduleGame,
  normalizeJbotReference,
  normalizeOddsApiReference,
  referenceProviderStatus,
} from '../../../lib/reference-lines.js';
import { oddsApiWindow } from '../../../lib/reference-time.js';
import { signMarketGames } from '../../../lib/market-integrity-v1.js';
import { fetchLeagueTaipeiSlate, validateLeagueScheduleSubset } from '../../../lib/league-provider.js';
import { requestedLeagueId } from '../../../lib/leagues.js';
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

const cache = globalThis.__MLB_REFERENCE_LINES_CACHE_V1043__ || new Map();
globalThis.__MLB_REFERENCE_LINES_CACHE_V1043__ = cache;
let lastJbotRequestAt = globalThis.__MLB_LAST_JBOT_REQUEST_AT__ || 0;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function mergeReferenceResults(results) {
  const byGame = new Map();
  const unmatched = [];
  for (const result of results.filter(Boolean)) {
    unmatched.push(...(Array.isArray(result.unmatched) ? result.unmatched : []));
    for (const row of Array.isArray(result.games) ? result.games : []) {
      const gamePk = Number(row?.gamePk || row?.game?.gamePk);
      if (!gamePk) continue;
      const current = byGame.get(gamePk) || { ...row, gamePk, markets: [], sources: [] };
      current.markets.push(...(Array.isArray(row.markets) ? row.markets : []));
      if (row.source) current.sources.push(row.source);
      current.source = current.sources.length === 1
        ? current.sources[0]
        : {
          provider: 'MULTI_REFERENCE_CONSENSUS',
          label: '獨立參考盤｜多來源',
          sourceType: 'INTERNATIONAL',
          observedAt: current.sources.map(source => source.observedAt).filter(Boolean).sort().at(-1) || null,
        };
      byGame.set(gamePk, current);
    }
  }
  return { games: [...byGame.values()], unmatched };
}

function sanitizeSchedule(rows, league) {
  return (Array.isArray(rows) ? rows : []).slice(0, 40).map(game => ({
    league,
    leagueId: league,
    gamePk: Number.isSafeInteger(Number(game?.gamePk)) && Number(game?.gamePk) > 0 ? Number(game.gamePk) : null,
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

const TARGET_MARKET_KEYS = Object.freeze({
  '全場讓分': ['spreads', 'alternate_spreads'],
  '全場大小': ['totals', 'alternate_totals'],
  '上半讓分': ['spreads_1st_5_innings', 'alternate_spreads_1st_5_innings'],
  '上半大小': ['totals_1st_5_innings', 'alternate_totals_1st_5_innings'],
});
const allowedEventMarkets = new Set(ODDS_API_EVENT_MARKETS);

function sanitizeTargets(rows, schedule) {
  const schedulePks = new Set((Array.isArray(schedule) ? schedule : []).map(game => Number(game.gamePk)));
  const targets = new Map();
  for (const row of (Array.isArray(rows) ? rows : []).slice(0, 20)) {
    const gamePk = Number(row?.gamePk);
    if (!Number.isSafeInteger(gamePk) || gamePk <= 0 || !schedulePks.has(gamePk)) continue;
    const current = targets.get(gamePk) || { gamePk, markets: [], marketKeys: new Set() };
    for (const marketRow of (Array.isArray(row?.markets) ? row.markets : []).slice(0, 16)) {
      const market = cleanText(typeof marketRow === 'string' ? marketRow : marketRow?.market, 20);
      const pick = cleanText(typeof marketRow === 'object' ? marketRow?.pick : '', 120);
      const keys = TARGET_MARKET_KEYS[market] || [];
      if (!keys.length) continue;
      current.markets.push({ market, pick });
      for (const key of keys) if (allowedEventMarkets.has(key)) current.marketKeys.add(key);
      if (market === '全場讓分' && /(?:讓|受讓)0(?:平|[+-]\d+|$)/.test(pick) && allowedEventMarkets.has('h2h')) {
        current.marketKeys.add('h2h');
      }
    }
    if (current.marketKeys.size) targets.set(gamePk, current);
  }
  return [...targets.values()]
    .map(row => ({ ...row, marketKeys: [...row.marketKeys].sort() }))
    .sort((left, right) => left.gamePk - right.gamePk);
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

function oddsApiEventsUrl(key, window = null) {
  const url = new URL('https://api.the-odds-api.com/v4/sports/baseball_mlb/events');
  url.searchParams.set('apiKey', key);
  url.searchParams.set('dateFormat', 'iso');
  if (window) {
    url.searchParams.set('commenceTimeFrom', window.start);
    url.searchParams.set('commenceTimeTo', window.end);
  }
  return url;
}

function oddsApiEventUrl(key, eventId, marketKeys) {
  const safeEventId = encodeURIComponent(cleanText(eventId, 120));
  const url = new URL(`https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${safeEventId}/odds`);
  url.searchParams.set('apiKey', key);
  url.searchParams.set('regions', 'us');
  url.searchParams.set('markets', marketKeys.filter(market => allowedEventMarkets.has(market)).join(','));
  url.searchParams.set('oddsFormat', 'decimal');
  url.searchParams.set('dateFormat', 'iso');
  return url;
}

function eventIdentity(raw) {
  return cleanText(raw?.id, 120);
}

function mergeOddsEvent(featured, detail) {
  return {
    ...featured,
    ...detail,
    id: eventIdentity(detail) || eventIdentity(featured),
    commence_time: detail?.commence_time || featured?.commence_time,
    away_team: detail?.away_team || featured?.away_team,
    home_team: detail?.home_team || featured?.home_team,
    bookmakers: Array.isArray(detail?.bookmakers) ? detail.bookmakers : featured?.bookmakers,
  };
}

async function loadOddsApi(date, schedule, targets = []) {
  const key = process.env.THE_ODDS_API_KEY;
  if (!key) return null;
  const window = oddsApiWindow(date, schedule);
  const targetByGamePk = new Map((Array.isArray(targets) ? targets : []).map(row => [Number(row.gamePk), row]));
  const discoveryUrl = selectedWindow => targetByGamePk.size
    ? oddsApiEventsUrl(key, selectedWindow)
    : oddsApiUrl(key, selectedWindow);
  let payload;
  try {
    payload = await fetchJson(discoveryUrl(window), { headers: { Accept: 'application/json' } });
  } catch (error) {
    if (!/commenceTime(?:From|To)|ISO 8601|timestamp/i.test(String(error?.message || error))) throw error;
    payload = await fetchJson(discoveryUrl(null), { headers: { Accept: 'application/json' } });
  }
  const discoveredEvents = Array.isArray(payload) ? payload : [];
  const targetedEvents = [];
  const failures = [];
  for (const raw of discoveredEvents) {
    const game = matchReferenceScheduleGame({
      away: raw?.away_team,
      home: raw?.home_team,
      time: raw?.commence_time,
    }, schedule);
    const target = targetByGamePk.get(Number(game?.gamePk));
    if (target && eventIdentity(raw)) targetedEvents.push({ raw, target });
  }
  const matchedTargetPks = new Set(targetedEvents.map(row => Number(row.target.gamePk)));
  for (const target of targetByGamePk.values()) {
    if (!matchedTargetPks.has(Number(target.gamePk))) failures.push(`gamePk ${target.gamePk}：The Odds API 找不到可安全配對的事件ID`);
  }

  const eventPayloads = new Map();
  await Promise.all(targetedEvents.map(async ({ raw, target }) => {
    try {
      const detail = await fetchJson(oddsApiEventUrl(key, raw.id, target.marketKeys), { headers: { Accept: 'application/json' } });
      if (!detail || eventIdentity(detail) !== eventIdentity(raw)) throw new Error('逐場回傳事件ID不一致');
      eventPayloads.set(eventIdentity(raw), mergeOddsEvent(raw, detail));
    } catch (error) {
      failures.push(`gamePk ${target.gamePk}：${String(error?.message || error)}`);
    }
  }));

  // A targeted request is fail-closed: only successfully enriched event
  // payloads are normalized. Falling back to the featured main-line payload
  // after an event endpoint failure could make an unavailable F5/alternate
  // contract look verified. The featured slate remains the legacy fallback
  // only when the caller supplied no Reader targets.
  const enrichedPayload = targetByGamePk.size
    ? targetedEvents.map(({ raw }) => eventPayloads.get(eventIdentity(raw))).filter(Boolean)
    : discoveredEvents;
  const fetchedAt = new Date().toISOString();
  return {
    ...normalizeOddsApiReference(enrichedPayload, schedule, { fetchedAt }),
    provider: 'THE_ODDS_API_CONSENSUS',
    requestWindow: window,
    targetedEventCount: targetedEvents.length,
    enrichedEventCount: eventPayloads.size,
    failures,
  };
}

export async function GET(request) {
  const auth = await requireApiAuth(request);
  if (auth) return auth;
  const league = requestedLeagueId(new URL(request.url).searchParams.get('league'));
  if (!league) {
    return NextResponse.json({ ok: false, code: 'UNKNOWN_LEAGUE', error: '不支援的聯盟' }, { status: 400 });
  }
  if (league !== 'MLB') {
    return NextResponse.json({
      ok: true, league, configured: false, version: REFERENCE_LINES_VERSION,
      providers: [], referencePolicy: 'NO_MLB_FALLBACK',
      message: `${league} 尚未設定同聯盟合法參考盤源，禁止回落 MLB 盤源`,
    }, { headers: { 'Cache-Control': 'no-store' } });
  }
  return NextResponse.json({ ok: true, league, version: REFERENCE_LINES_VERSION, ...referenceProviderStatus() }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request) {
  try {
    const auth = await requireApiAuth(request);
    if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'reference-lines-v10-4', limit: 60, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 500_000);
    const league = requestedLeagueId(body?.league);
    if (!league) {
      return NextResponse.json({ ok: false, code: 'UNKNOWN_LEAGUE', error: '不支援的聯盟' }, { status: 400 });
    }
    const date = cleanText(body?.date, 20);
    const requestedSchedule = sanitizeSchedule(body?.schedule, league);
    if (!validDateString(date)) return NextResponse.json({ ok: false, error: '日期格式必須為 YYYY-MM-DD' }, { status: 400 });
    if (!requestedSchedule.length) return NextResponse.json({ ok: false, error: '今日賽事清單為空，無法配對參考盤' }, { status: 400 });
    const fullOfficialSlate = await fetchLeagueTaipeiSlate(league, date);
    const schedule = validateLeagueScheduleSubset(league, requestedSchedule, fullOfficialSlate, date);
    const targets = sanitizeTargets(body?.targets, schedule);
    if (Array.isArray(body?.targets) && body.targets.length && !targets.length) {
      return NextResponse.json({ ok: false, error: 'Reader target 不是今日已驗證賽事或未包含有效市場，禁止回落一般 featured 盤' }, { status: 400 });
    }

    if (league !== 'MLB') {
      return NextResponse.json({
        ok: true,
        league,
        configured: false,
        blocked: true,
        version: REFERENCE_LINES_VERSION,
        providers: [],
        games: [],
        unmatched: [],
        referencePolicy: 'NO_MLB_FALLBACK',
        message: `${league} 尚未設定同聯盟合法參考盤源；已禁止使用 MLB JBot 或 The Odds API 替代`,
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

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
    const configuredProviders = status.providers.filter(provider => provider.configured).map(provider => provider.id).sort();
    const targetIdentity = targets.map(target => `${target.gamePk}:${target.marketKeys.join('+')}:${target.markets.map(row => `${row.market}/${row.pick}`).join('+')}`).join(',');
    const key = `${league}:${configuredProviders.join('+')}:${date}:${fullSlateIdentity}:${schedule.map(game => game.gamePk).join(',')}:${targetIdentity}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return NextResponse.json({ ...cached.payload, cache: 'HIT' }, { headers: { 'Cache-Control': 'no-store' } });

    const failures = [];
    const results = [];
    if (status.providers.find(provider => provider.id === 'JBOT_TAIWAN_SPORTS_LOTTERY')?.configured) {
      try { results.push(await loadJbot(date, fullOfficialSlate)); }
      catch (error) { failures.push(`JBot：${String(error?.message || error)}`); }
    }
    if (status.providers.find(provider => provider.id === 'THE_ODDS_API_CONSENSUS')?.configured) {
      try {
        const oddsResult = await loadOddsApi(date, fullOfficialSlate, targets);
        failures.push(...(Array.isArray(oddsResult?.failures) ? oddsResult.failures.map(message => `The Odds API：${message}`) : []));
        results.push(oddsResult);
      }
      catch (error) { failures.push(`The Odds API：${String(error?.message || error)}`); }
    }
    const result = mergeReferenceResults(results);
    if (!result.games.length && failures.length) {
      return NextResponse.json({ ok: false, error: failures.join('；') || '沒有可用的合法參考盤來源' }, { status: 502 });
    }

    const requestedGamePks = new Set((targets.length ? targets : schedule).map(game => Number(game.gamePk)));
    const requestedGames = (Array.isArray(result.games) ? result.games : []).filter(row => requestedGamePks.has(Number(row.gamePk)));
    const filteredGames = filterReferenceGamesToTargets(requestedGames, targets);
    const signedGames = await signMarketGames(league, filteredGames);
    const payload = {
      ok: true,
      league,
      configured: true,
      consensusReady: status.consensusReady,
      version: REFERENCE_LINES_VERSION,
      provider: configuredProviders.join('+') || null,
      providers: status.providers,
      games: signedGames,
      unmatched: result.unmatched,
      requestWindow: results.find(row => row?.requestWindow)?.requestWindow || null,
      targetCount: targets.length,
      targetedEventCount: results.reduce((sum, row) => sum + Number(row?.targetedEventCount || 0), 0),
      enrichedEventCount: results.reduce((sum, row) => sum + Number(row?.enrichedEventCount || 0), 0),
      fetchedAt: new Date().toISOString(),
      failures,
      message: status.consensusReady ? '' : '已設定一般參考盤，但尚未設定 The Odds API 三莊同合約共識；V10.4 將安全阻擋所有 W/R 與排名。',
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
