import { NextResponse } from 'next/server';
import { loadReaderSnapshot, readerSnapshotStatus, READER_STORE_VERSION } from '../../../lib/reader-store-v2.js';
import { readerSnapshotIsComplete, TAI888_READER_PARSER_VERSION } from '../../../lib/tai888-reader-parser-v2.js';
import { signMarketGames, signReaderProvenance } from '../../../lib/market-integrity-v1.js';
import {
  readerGameEvidenceRows,
  readerGameMarketContentHash,
  readerUnopenedGameMarketContentHash,
} from '../../../lib/reader-market-revision-v110.js';
import { MARKET_ORDER } from '../../../lib/markets.js';
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

function unopenedMarketCoverage() {
  return {
    openMarkets: 0,
    totalMarkets: MARKET_ORDER.length,
    directionCount: 0,
    availableMarkets: [],
    unavailableMarkets: [...MARKET_ORDER],
    blockedMarkets: [],
    missingMarkets: [...MARKET_ORDER],
  };
}

async function signedReaderProvenance(league, game, readerSnapshot, marketStatus, readerGameMarketHash) {
  return signReaderProvenance(league, game, {
    readerVersion: readerSnapshot.readerVersion,
    payloadHash: readerSnapshot.payloadHash,
    rawBoardHash: readerSnapshot.rawBoardHash,
    boardDate: readerSnapshot.boardDate,
    lineAsOf: readerSnapshot.pageActivityAt,
    marketStatus,
    readerGameMarketHash,
  });
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
    const requestNow = Date.now();
    const currentPrestartPks = new Set(filterLeaguePrestartGames(
      league,
      fullOfficialSlate,
      requestNow,
    ).map(game => Number(game.gamePk)));
    const currentSchedule = schedule.filter(game => currentPrestartPks.has(Number(game.gamePk)));
    const requestedGamePks = new Set(currentSchedule.map(game => Number(game.gamePk)));
    const officialByPk = new Map(fullOfficialSlate.map(game => [Number(game.gamePk), game]));

    readerSnapshot = await loadReaderSnapshot(league, date);
    readerState = readerSnapshotStatus(readerSnapshot, Date.now(), league);
    if (!currentSchedule.length) {
      return NextResponse.json({
        ok: true,
        league,
        configured: Boolean(process.env.READER_PAIR_SECRET),
        blocked: false,
        readerFresh: readerState.fresh,
        code: 'NO_PRESTART_GAMES',
        message: '目前已無尚未開賽場次；停止建立未開盤分析。',
        version: TAI888_READER_PARSER_VERSION,
        readerVersion: readerSnapshot?.readerVersion || null,
        provider: 'TAI888_READER_AUTO',
        label: 'Tai888 Reader 自動信用盤',
        games: [],
        unopenedGames: [],
        payloadHash: readerSnapshot?.payloadHash || null,
        rawBoardHash: readerSnapshot?.rawBoardHash || null,
        boardDate: readerSnapshot?.boardDate || date,
        observedAt: readerSnapshot?.observedAt || null,
        receivedAt: readerSnapshot?.receivedAt || null,
        pageActivityAt: readerSnapshot?.pageActivityAt || null,
        rawGameCount: 0,
        matchedGameCount: 0,
        marketCount: 0,
        directionCount: 0,
        partialGameCount: 0,
        unopenedGameCount: 0,
        scheduleGameCount: 0,
        unmatched: [],
        readerStatus: readerState,
        fetchedAt: new Date().toISOString(),
        cache: 'READER_RUNTIME_CACHE',
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
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
      const requestedUnopenedRows = (readerSnapshot.unopenedGames || [])
        .filter(row => requestedGamePks.has(Number(row.gamePk)));
      const requestedOpenCount = currentSchedule.length - requestedUnopenedRows.length;
      const readerEvidenceGames = await Promise.all(verifiedReaderGames.map(async row => {
        const evidenceMarkets = readerGameEvidenceRows(row, readerSnapshot.pageActivityAt);
        const readerGameMarketHash = readerGameMarketContentHash(evidenceMarkets);
        return {
          ...row,
          markets: evidenceMarkets.map(market => ({
            ...market,
            readerGameMarketHash,
            readerVersion: readerSnapshot.readerVersion,
            readerPayloadHash: readerSnapshot.payloadHash,
            readerRawBoardHash: readerSnapshot.rawBoardHash,
            readerBoardDate: readerSnapshot.boardDate,
          })),
          readerProvenance: await signedReaderProvenance(
            league,
            row.game,
            readerSnapshot,
            'OPEN',
            readerGameMarketHash,
          ),
        };
      }));
      const games = readerEvidenceGames.length === requestedOpenCount
        ? await signMarketGames(league, readerEvidenceGames)
        : [];
      const unopenedGames = await Promise.all(requestedUnopenedRows.map(async row => {
        const game = officialByPk.get(Number(row.gamePk));
        const readerGameMarketHash = readerUnopenedGameMarketContentHash({ league, game, readerSnapshot });
        return {
          ...row,
          league,
          gamePk: Number(row.gamePk),
          game,
          source: {
            ...row.source,
            observedAt: readerSnapshot.observedAt,
            receivedAt: readerSnapshot.receivedAt,
          },
          marketStatus: 'locked',
          markets: [],
          marketCoverage: row.marketCoverage || unopenedMarketCoverage(),
          readerProvenance: await signedReaderProvenance(
            league,
            game,
            readerSnapshot,
            'UNOPENED',
            readerGameMarketHash,
          ),
        };
      }));
      if (games.length === requestedOpenCount && games.length + unopenedGames.length === currentSchedule.length) {
        const currentRawGameCount = games.length + requestedUnopenedRows
          .filter(row => row?.unavailableReason !== 'not-rendered-by-reader').length;
        const currentMarketCount = games.reduce((count, row) => (
          count + new Set((row.markets || []).map(market => market.market)).size
        ), 0);
        const currentDirectionCount = games.reduce((count, row) => count + (row.markets || []).length, 0);
        return NextResponse.json({
          ok: true, league, configured: true, blocked: false, readerFresh: true,
          code: currentSchedule.length ? undefined : 'NO_PRESTART_GAMES',
          message: currentSchedule.length ? undefined : '目前已無尚未開賽場次；停止建立未開盤分析。',
          version: TAI888_READER_PARSER_VERSION, provider: 'TAI888_READER_AUTO',
          label: 'Tai888 Reader 自動信用盤', games,
          readerVersion: readerSnapshot.readerVersion,
          payloadHash: readerSnapshot.payloadHash, boardDate: readerSnapshot.boardDate,
          rawBoardHash: readerSnapshot.rawBoardHash,
          observedAt: readerSnapshot.observedAt, receivedAt: readerSnapshot.receivedAt,
          pageActivityAt: readerSnapshot.pageActivityAt,
          rawGameCount: currentRawGameCount, matchedGameCount: games.length,
          marketCount: currentMarketCount,
          directionCount: currentDirectionCount,
          partialGameCount: games.filter(row => new Set((row.markets || []).map(market => market.market)).size < MARKET_ORDER.length).length,
          unopenedGameCount: unopenedGames.length,
          unopenedGames,
          scheduleGameCount: currentSchedule.length, unmatched: readerSnapshot.unmatched || [],
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
      readerVersion: readerSnapshot?.readerVersion || null,
      provider: 'TAI888_READER_AUTO',
      label: 'Tai888 Reader 自動信用盤',
      games: [],
      message: readerState.fresh
        ? `Tai888 Reader 盤面不是目前官方完整賽前場次，已停止分析。請刷新 Tai888 ${config.shortLabel}盤面後重新同步。`
        : readerState.message || 'Tai888 Reader 尚未同步新鮮完整盤面，已停止分析。',
      payloadHash: readerSnapshot?.payloadHash || null,
      rawBoardHash: readerSnapshot?.rawBoardHash || null,
      boardDate: readerSnapshot?.boardDate || date,
      observedAt: readerSnapshot?.observedAt || null,
      receivedAt: readerSnapshot?.receivedAt || null,
      pageActivityAt: readerSnapshot?.pageActivityAt || null,
      rawGameCount: readerSnapshot?.rawGameCount || 0,
      matchedGameCount: readerSnapshot?.matchedGameCount || 0,
      scheduleGameCount: currentSchedule.length,
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
