import { NextResponse } from 'next/server';
import { flattenMarkets } from '../../../lib/batch.js';
import { normalizeVisionGame, validateMarketPair } from '../../../lib/markets.js';
import {
  cleanVisionJSON,
  expandVisionPayload,
  matchScheduleGame,
} from '../../../lib/vision.js';
import {
  TAI888_SOURCE_VERSION,
  loadTai888VisibleText,
  tai888SourceStatus,
} from '../../../lib/tai888-source.js';
import { loadReaderSnapshot, readerSnapshotStatus, READER_STORE_VERSION } from '../../../lib/reader-store-v2.js';
import { readerSnapshotIsComplete, TAI888_READER_PARSER_VERSION } from '../../../lib/tai888-reader-parser-v2.js';
import { signMarketGames } from '../../../lib/market-integrity-v1.js';
import { fetchOfficialTaipeiSlate, officialPrestartSlate, validateOfficialScheduleSubset } from '../../../lib/official-schedule-v1.js';
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

const GATEWAY = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const cache = globalThis.__MLB_TAI888_CREDIT_CACHE_V93__ || new Map();
globalThis.__MLB_TAI888_CREDIT_CACHE_V93__ = cache;

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
  })).filter(game => game.gamePk && game.away && game.home);
}

function readerSnapshotMatchesFullOfficialSlate(snapshot, officialSlate, boardDate) {
  const slate = Array.isArray(officialSlate) ? officialSlate : [];
  if (!readerSnapshotIsComplete(snapshot)
    || snapshot?.boardDate !== boardDate
    || !slate.length
    || snapshot.games.length !== slate.length
    || Number(snapshot.scheduleGameCount) !== slate.length) return false;
  try {
    const verified = validateOfficialScheduleSubset(snapshot.games.map(row => row.game), slate, boardDate);
    const expected = slate.map(game => Number(game.gamePk)).sort((left, right) => left - right);
    const actual = verified.map(game => Number(game.gamePk)).sort((left, right) => left - right);
    return expected.every((gamePk, index) => gamePk === actual[index]);
  } catch {
    return false;
  }
}

function slateText(schedule) {
  return schedule.map(game => {
    const start = new Date(game.gameDate || '');
    const taipeiStart = Number.isFinite(start.getTime())
      ? new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(start)
      : '時間無效';
    return `${game.gamePk}|台北${taipeiStart}|G${game.gameNumber || 1}|${game.away}/${game.awayEnglish || ''}@${game.home}/${game.homeEnglish || ''}`;
  }).join('\n');
}

function extractionPrompt(schedule, text) {
  return `你是台灣信用盤 MLB 盤口擷取器。輸入是使用者本人唯讀帳號正常登入後，頁面可見文字；只擷取盤口，不做推薦、不算分。\n\n可配對官方賽事：\n${slateText(schedule)}\n\n硬規則：\n1. 只輸出能唯一配對上述 gamePk 的賽事。客隊away、主隊home不得對調；同隊雙重賽必須依畫面時間對應台北開打時間與G1/G2，不能只看隊名。\n2. 每場最多四個市場：全場讓分、全場大小、上半/前5局讓分、上半/前5局大小。未開盤填null。\n3. 嚴格區分盤口尾碼與實際水位。1+50、9-30中的+50/-30是尾碼；0.950、0.940才是水位。\n4. 非0讓分盤，盤口標示在哪一隊，該隊就是lineSide；不得依球隊強弱猜。0盤仍保留畫面標示側。\n5. 只有一邊水位時另一邊填null。看不清就null，絕不可補造。\n6. 斜線盤如0/0.5、0.5/1原樣抄寫，不得換算成+50。\n7. 忽略帳號、餘額、下注按鈕、獨贏與一輸二贏，除非未來另有專用合約規格。\n8. 只回單一JSON，不要解釋。\n\n短鍵格式：\n{"g":[{"id":gamePk,"a":"客隊","h":"主隊","c":0到1,"fr":["away或home或null","全場讓分line",客隊讓球水位或null,主隊讓球水位或null,信心],"ft":["全場大小line",大分水位或null,小分水位或null,信心],"r5":["away或home或null","上半讓分line",客隊上半水位或null,主隊上半水位或null,信心],"t5":["上半大小line",大分水位或null,小分水位或null,信心]}]}\n\n頁面可見文字：\n${String(text || '').slice(0, 150000)}`;
}

function modelCandidates() {
  return [...new Set([
    process.env.AI_VISION_MODEL,
    'openai/gpt-4o-mini',
    'google/gemini-2.5-flash',
    process.env.AI_MODEL,
  ].filter(Boolean))].slice(0, 4);
}

async function gatewayExtract(prompt) {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) throw new Error('Tai888盤口文字解析需要Server-side AI_GATEWAY_API_KEY');
  const failures = [];
  for (const model of modelCandidates()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 24_000);
    try {
      const response = await fetch(GATEWAY, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: 3200,
        }),
        cache: 'no-store',
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        failures.push(`${model}（${response.status}）`);
        continue;
      }
      const outer = JSON.parse(raw);
      const content = outer?.choices?.[0]?.message?.content;
      if (!content) throw new Error(`${model}未回傳內容`);
      return { payload: expandVisionPayload(cleanVisionJSON(content)), model, failures };
    } catch (error) {
      failures.push(`${model}：${String(error?.message || error).slice(0, 160)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  const error = new Error('Tai888頁面已登入，但盤口文字未能解析');
  error.details = failures;
  throw error;
}

function formalizeGame(raw, matched, observedAt) {
  const normalized = normalizeVisionGame(raw, matched, null);
  const safeMarkets = normalized.markets.map(market => {
    const directions = (market.directions || []).slice(0, 2).map(direction => ({
      ...direction,
      water: direction.waterEstimated ? null : direction.water,
      waterEstimated: false,
      waterMissing: direction.waterEstimated || direction.water == null,
      sourceType: 'ACTUAL_TW_CREDIT',
      sourceLabel: 'Tai888唯讀信用盤',
      provider: 'TAI888_READ_ONLY_CREDIT',
      lineAsOf: observedAt,
      executable: direction.waterEstimated ? false : direction.water != null,
      marketVerification: null,
    }));
    const errors = validateMarketPair(market.market, directions);
    return errors.length ? { market: market.market, directions: [] } : { market: market.market, directions };
  });
  return { ...normalized, markets: safeMarkets };
}

export async function GET(request) {
  const auth = await requireApiAuth(request);
  if (auth) return auth;
  const snapshot = await loadReaderSnapshot();
  const reader = readerSnapshotStatus(snapshot);
  return NextResponse.json({
    ok: true,
    version: TAI888_SOURCE_VERSION,
    ...tai888SourceStatus(),
    readerStoreVersion: READER_STORE_VERSION,
    readerParserVersion: TAI888_READER_PARSER_VERSION,
    readerAvailable: reader.available,
    readerFresh: reader.fresh,
    readerStale: reader.stale,
    readerAgeSeconds: reader.ageSeconds,
    readerMessage: reader.message,
    payloadHash: snapshot?.payloadHash || null,
    matchedGameCount: snapshot?.matchedGameCount || 0,
    observedAt: snapshot?.observedAt || null,
    receivedAt: snapshot?.receivedAt || null,
    pageActivityAt: snapshot?.pageActivityAt || null,
  }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request) {
  let readerSnapshot = null;
  let readerState = readerSnapshotStatus(null);
  try {
    const auth = await requireApiAuth(request);
    if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'tai888-credit-lines-v9-4-1', limit: 180, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 500_000);
    const requestedSchedule = sanitizeSchedule(body?.schedule);
    const date = cleanText(body?.date, 20);
    if (!validDateString(date)) return NextResponse.json({ ok: false, error: '日期格式必須為 YYYY-MM-DD' }, { status: 400 });
    if (!requestedSchedule.length) return NextResponse.json({ ok: false, error: '今日賽事清單為空，無法配對信用盤' }, { status: 400 });
    const fullOfficialSlate = await fetchOfficialTaipeiSlate(date);
    const schedule = validateOfficialScheduleSubset(requestedSchedule, fullOfficialSlate, date);
    const requestedGamePks = new Set(schedule.map(game => Number(game.gamePk)));
    const officialByPk = new Map(fullOfficialSlate.map(game => [Number(game.gamePk), game]));

    readerSnapshot = await loadReaderSnapshot(date);
    readerState = readerSnapshotStatus(readerSnapshot);
    const executableOfficialSlate = officialPrestartSlate(
      fullOfficialSlate,
      Date.parse(readerSnapshot?.pageActivityAt || ''),
    );
    const completeReaderSlate = readerSnapshotMatchesFullOfficialSlate(readerSnapshot, executableOfficialSlate, date);
    if (readerState.fresh && completeReaderSlate) {
      const verifiedReaderGames = readerSnapshot.games.filter(row => {
        const official = officialByPk.get(Number(row.gamePk));
        if (!official || !Array.isArray(row.markets) || !row.markets.length) return false;
        try {
          validateOfficialScheduleSubset([row.game], fullOfficialSlate, date);
          return requestedGamePks.has(Number(row.gamePk));
        } catch { return false; }
      }).map(row => ({
        ...row,
        game: officialByPk.get(Number(row.gamePk)),
        source: { ...row.source, observedAt: readerSnapshot.observedAt, receivedAt: readerSnapshot.receivedAt },
      }));
      const games = verifiedReaderGames.length === schedule.length
        ? await signMarketGames(verifiedReaderGames)
        : [];
      if (games.length === schedule.length) {
        return NextResponse.json({
          ok: true, configured: true, blocked: false, readerFresh: true,
          version: TAI888_READER_PARSER_VERSION, provider: 'TAI888_READER_AUTO',
          label: 'Tai888 Reader 自動信用盤', games,
          payloadHash: readerSnapshot.payloadHash, boardDate: readerSnapshot.boardDate,
          observedAt: readerSnapshot.observedAt, receivedAt: readerSnapshot.receivedAt,
          pageActivityAt: readerSnapshot.pageActivityAt,
          rawGameCount: readerSnapshot.rawGameCount, matchedGameCount: games.length,
          scheduleGameCount: schedule.length, unmatched: readerSnapshot.unmatched || [],
          readerStatus: readerState, fetchedAt: new Date().toISOString(), cache: 'READER_RUNTIME_CACHE',
        }, { headers: { 'Cache-Control': 'no-store' } });
      }
    }

    const status = tai888SourceStatus();
    if (!status.configured) {
      return NextResponse.json({
        ok: true,
        configured: false,
        version: TAI888_SOURCE_VERSION,
        provider: status.provider,
        label: status.label,
        games: [],
        message: 'Tai888唯讀來源尚未設定。帳密只可放在Vercel Server-side Environment Variables。',
      }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const fullSlateIdentity = fullOfficialSlate.map(game => `${game.gamePk}:${game.awayTeamId}:${game.homeTeamId}:${game.gameNumber}:${game.gameDate}`).join('|');
    const key = `${date}:${fullSlateIdentity}:${schedule.map(game => game.gamePk).join(',')}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return NextResponse.json({ ...cached.payload, cache: 'HIT' }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const source = await loadTai888VisibleText();
    const safeText = String(source.text || '')
      .replace(/((?:帳號|账号|會員|会员|使用者|用户名|username))\s*[:：]?\s*[^|\n]{1,80}/gi, '$1：[已遮蔽]')
      .replace(/((?:餘額|余额|信用額度|信用额度|可用額度|可用额度|balance|credit))\s*[:：]?\s*[-+]?[$NT\s]*[0-9,.]+/gi, '$1：[已遮蔽]');
    const extracted = await gatewayExtract(extractionPrompt(fullOfficialSlate, safeText));
    const games = [];
    const warnings = [...(extracted.failures || [])];
    for (const raw of Array.isArray(extracted.payload?.games) ? extracted.payload.games : []) {
      const matched = matchScheduleGame(raw, fullOfficialSlate);
      if (!matched) {
        warnings.push(`${cleanText(raw?.away, 50)} 對 ${cleanText(raw?.home, 50)} 無法唯一配對官方賽事`);
        continue;
      }
      const normalized = formalizeGame(raw, matched, source.observedAt);
      const markets = flattenMarkets(normalized).map(row => ({
        ...row,
        sourceType: 'ACTUAL_TW_CREDIT',
        sourceLabel: 'Tai888唯讀信用盤',
        provider: 'TAI888_READ_ONLY_CREDIT',
      }));
      if (!markets.length) continue;
      if (!requestedGamePks.has(Number(matched.gamePk))) continue;
      games.push({
        gamePk: matched.gamePk,
        game: matched,
        source: {
          provider: 'TAI888_READ_ONLY_CREDIT',
          label: 'Tai888唯讀信用盤',
          sourceType: 'ACTUAL_TW_CREDIT',
          observedAt: source.observedAt,
          executable: true,
        },
        markets,
      });
    }

    const signedGames = await signMarketGames(games);
    const payload = {
      ok: true,
      configured: true,
      version: TAI888_SOURCE_VERSION,
      provider: 'TAI888_READ_ONLY_CREDIT',
      label: 'Tai888唯讀信用盤',
      parserModel: extracted.model,
      games: signedGames,
      warnings: warnings.slice(0, 20),
      diagnostics: source.diagnostics,
      fetchedAt: new Date().toISOString(),
      cache: 'MISS',
    };
    cache.set(key, { payload, expiresAt: Date.now() + 30_000 });
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error?.code === 'TAI888_CLOUDFLARE_BLOCKED') {
      return NextResponse.json({
        ok: true,
        configured: true,
        blocked: true,
        blockCode: 'TAI888_CLOUDFLARE_BLOCKED',
        version: TAI888_SOURCE_VERSION,
        provider: 'TAI888_READ_ONLY_CREDIT',
        label: 'Tai888唯讀信用盤',
        games: [],
        message: String(error.message),
        importModes: ['reader_auto', 'clipboard_text', 'screenshot'],
        readerFresh: readerState.fresh,
        readerStale: readerState.stale,
        readerAgeSeconds: readerState.ageSeconds,
        readerMessage: readerState.message,
        payloadHash: readerSnapshot?.payloadHash || null,
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json({
      ok: false,
      error: String(error?.message || error),
      details: Array.isArray(error?.details) ? error.details.slice(0, 8) : [],
    }, {
      status: Number(error?.status) || 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
