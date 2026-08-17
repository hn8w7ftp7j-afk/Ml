import { NextResponse } from 'next/server';
import { loadReaderSnapshot, readerSnapshotStatus, READER_STORE_VERSION } from '../../../lib/reader-store-v2.js';
import { readerSnapshotIsComplete, TAI888_READER_PARSER_VERSION } from '../../../lib/tai888-reader-parser-v2.js';
import { signMarketGames } from '../../../lib/market-integrity-v1.js';
import {
  fetchLeagueTaipeiSlate,
  filterLeaguePrestartGames,
  validateLeagueScheduleSubset,
} from '../../../lib/league-provider.js';
import { leagueConfig, requestedLeagueId } from '../../../lib/leagues.js';
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
  })).filter(game => game.gamePk && game.away && game.home);
}

function readerSnapshotMatchesFullOfficialSlate(league, snapshot, officialSlate, boardDate) {
  const slate = Array.isArray(officialSlate) ? officialSlate : [];
  if (!readerSnapshotIsComplete(snapshot, league)
    || snapshot?.league !== league
    || snapshot?.boardDate !== boardDate
    || !slate.length
    || Number(snapshot.scheduleGameCount) !== slate.length) return false;
  try {
    const snapshotRows = [...snapshot.games, ...(snapshot.unopenedGames || [])];
    if (snapshotRows.length !== slate.length) return false;
    const verified = validateLeagueScheduleSubset(league, snapshotRows.map(row => row.game), slate, boardDate);
    const expected = slate.map(game => Number(game.gamePk)).sort((left, right) => left - right);
    const actual = verified.map(game => Number(game.gamePk)).sort((left, right) => left - right);
    return expected.every((gamePk, index) => gamePk === actual[index]);
  } catch {
    return false;
  }
}

export async function GET(request) {
  const auth = await requireApiAuth(request);
  if (auth) return auth;
  const league = requestedLeagueId(new URL(request.url).searchParams.get('league'));
  if (!league) {
    return NextResponse.json({ ok: false, code: 'UNKNOWN_LEAGUE', error: '不支援的聯盟' }, { status: 400 });
  }
  const config = leagueConfig(league);
  if (!config.capabilities.reader) {
    return NextResponse.json({
      ok: false,
      code: 'LEAGUE_NOT_READY',
      league,
      error: `${config.label} Reader 尚未完成正式盤面驗證，已停止讀取信用盤`,
    }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }
  const snapshot = await loadReaderSnapshot(league);
  const reader = readerSnapshotStatus(snapshot, Date.now(), league);
  return NextResponse.json({
    ok: true,
    league,
    configured: Boolean(process.env.READER_PAIR_SECRET),
    version: TAI888_READER_PARSER_VERSION,
    provider: 'TAI888_READER_AUTO',
    label: 'Tai888 Reader 自動信用盤',
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
  let readerState = null;
  try {
    const auth = await requireApiAuth(request);
    if (auth) return auth;
    if (!validateSameOrigin(request)) return originErrorResponse();
    const rate = checkRateLimit(request, { id: 'tai888-credit-lines-v9-4-1', limit: 180, windowMs: 10 * 60 * 1000 });
    if (!rate.allowed) return rateLimitResponse(rate);
    const body = await readJsonBody(request, 500_000);
    const league = requestedLeagueId(body?.league);
    if (!league) {
      return NextResponse.json({ ok: false, code: 'UNKNOWN_LEAGUE', error: '不支援的聯盟' }, { status: 400 });
    }
    readerState = readerSnapshotStatus(null, Date.now(), league);
    const config = leagueConfig(league);
    if (!config.capabilities.reader) {
      return NextResponse.json({
        ok: false,
        code: 'LEAGUE_NOT_READY',
        league,
        error: `${config.label} Reader 尚未完成正式盤面驗證，已停止配對信用盤`,
      }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
    }
    const requestedSchedule = sanitizeSchedule(body?.schedule, league);
    const date = cleanText(body?.date, 20);
    if (!validDateString(date)) return NextResponse.json({ ok: false, error: '日期格式必須為 YYYY-MM-DD' }, { status: 400 });
    if (!requestedSchedule.length) return NextResponse.json({ ok: false, error: '今日賽事清單為空，無法配對信用盤' }, { status: 400 });
    const fullOfficialSlate = await fetchLeagueTaipeiSlate(league, date);
    const schedule = validateLeagueScheduleSubset(league, requestedSchedule, fullOfficialSlate, date);
    const requestedGamePks = new Set(schedule.map(game => Number(game.gamePk)));
    const officialByPk = new Map(fullOfficialSlate.map(game => [Number(game.gamePk), game]));

    readerSnapshot = await loadReaderSnapshot(league, date);
    readerState = readerSnapshotStatus(readerSnapshot, Date.now(), league);
    const executableOfficialSlate = filterLeaguePrestartGames(
      league,
      fullOfficialSlate,
      Date.parse(readerSnapshot?.pageActivityAt || ''),
    );
    const completeReaderSlate = readerSnapshotMatchesFullOfficialSlate(league, readerSnapshot, executableOfficialSlate, date);
    if (readerState.fresh && completeReaderSlate) {
      const verifiedReaderGames = readerSnapshot.games.filter(row => {
        const official = officialByPk.get(Number(row.gamePk));
        if (!official || !Array.isArray(row.markets) || !row.markets.length) return false;
        try {
          validateLeagueScheduleSubset(league, [row.game], fullOfficialSlate, date);
          return requestedGamePks.has(Number(row.gamePk));
        } catch { return false; }
      }).map(row => ({
        ...row,
        game: officialByPk.get(Number(row.gamePk)),
        source: { ...row.source, observedAt: readerSnapshot.observedAt, receivedAt: readerSnapshot.receivedAt },
      }));
      const requestedOpenCount = schedule.filter(game => (
        !new Set((readerSnapshot.unopenedGames || []).map(row => Number(row.gamePk))).has(Number(game.gamePk))
      )).length;
      const games = verifiedReaderGames.length === requestedOpenCount
        ? await signMarketGames(league, verifiedReaderGames)
        : [];
      if (games.length === requestedOpenCount) {
        return NextResponse.json({
          ok: true, league, configured: true, blocked: false, readerFresh: true,
          version: TAI888_READER_PARSER_VERSION, provider: 'TAI888_READER_AUTO',
          label: 'Tai888 Reader 自動信用盤', games,
          payloadHash: readerSnapshot.payloadHash, boardDate: readerSnapshot.boardDate,
          observedAt: readerSnapshot.observedAt, receivedAt: readerSnapshot.receivedAt,
          pageActivityAt: readerSnapshot.pageActivityAt,
          rawGameCount: readerSnapshot.rawGameCount, matchedGameCount: games.length,
          unopenedGameCount: schedule.length - games.length,
          unopenedGames: (readerSnapshot.unopenedGames || [])
            .filter(row => requestedGamePks.has(Number(row.gamePk)))
            .map(row => ({ gamePk: row.gamePk, marketStatus: 'locked' })),
          scheduleGameCount: schedule.length, unmatched: readerSnapshot.unmatched || [],
          readerStatus: readerState, fetchedAt: new Date().toISOString(), cache: 'READER_RUNTIME_CACHE',
        }, { headers: { 'Cache-Control': 'no-store' } });
      }
    }

    return NextResponse.json({
      ok: true,
      league,
      configured: Boolean(process.env.READER_PAIR_SECRET),
      blocked: true,
      readerFresh: readerState.fresh,
      version: TAI888_READER_PARSER_VERSION,
      provider: 'TAI888_READER_AUTO',
      label: 'Tai888 Reader 自動信用盤',
      games: [],
      message: readerState.fresh
        ? `Tai888 Reader 盤面不是目前官方完整賽前場次，已停止分析。請刷新 Tai888 ${config.shortLabel}盤面後重新同步。`
        : readerState.message || 'Tai888 Reader 尚未同步新鮮完整盤面，已停止分析。',
      payloadHash: readerSnapshot?.payloadHash || null,
      boardDate: readerSnapshot?.boardDate || date,
      observedAt: readerSnapshot?.observedAt || null,
      receivedAt: readerSnapshot?.receivedAt || null,
      pageActivityAt: readerSnapshot?.pageActivityAt || null,
      rawGameCount: readerSnapshot?.rawGameCount || 0,
      matchedGameCount: readerSnapshot?.matchedGameCount || 0,
      scheduleGameCount: schedule.length,
      readerStatus: readerState,
      fetchedAt: new Date().toISOString(),
      cache: 'READER_RUNTIME_CACHE',
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
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
