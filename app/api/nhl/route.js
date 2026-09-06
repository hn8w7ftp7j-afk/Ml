import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitResponse, requireApiAuth, validDateString } from '../../../lib/security.js';
import { NHL_DATA_VERSION, NHL_SOURCES, fetchNhlSchedule, fetchNhlGame, fetchNhlRoster, fetchNhlPlayer, fetchNhlTeamStatistics, fetchNhlClubSchedule } from '../../../lib/nhl/data.js';
import { nhlScheduleContext } from '../../../lib/nhl/context.js';
import { cachedNhlData } from '../../../lib/nhl/cache.js';
import { nhlPersistenceConfigured, saveNhlObservation, loadNhlObservations } from '../../../lib/nhl/store.js';
import { NHL_READER_INTERFACE_VERSION, NHL_READER_WAITING_MESSAGE } from '../../../lib/nhl/reader.js';
import { nhlHistoricalResearch } from '../../../lib/nhl/research.js';
import { NHL_HISTORICAL_SAMPLES } from '../../../lib/nhl/historical-samples.js';
import { fetchNhlTeamSummary } from '../../../lib/nhl/data.js';
import { validNhlTeamSummaryScope } from '../../../lib/nhl/team-summary.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const response = (payload, status = 200) => NextResponse.json({ ...payload, league: 'NHL' }, { status, headers: { 'Cache-Control': 'no-store' } });
const sourceError = result => Object.assign(new Error(result.code === 'NHL_SOURCE_FORBIDDEN'
  ? '官方資料來源拒絕目前伺服器的請求；已保留之前資料，歷史研究資料仍可查看。'
  : result.code === 'NHL_SOURCE_RATE_LIMITED' ? '官方資料來源要求稍後重試；已保留之前資料。'
    : result.code === 'NHL_SOURCE_TIMEOUT' ? '官方資料來源回應逾時；已保留之前資料。'
      : result.status === 'BLOCK' ? 'NHL 資料身分或比分核對未通過；已保留之前資料。' : 'NHL 官方來源暫時無法提供完整資料；已保留之前資料。'),
{ status: result.status === 'BLOCK' ? 422 : 503, code: result.code || 'NHL_SOURCE_UNAVAILABLE', issues: result.issues || [], upstreamStatus: result.httpStatus || null });
const requireResult = result => { if (!result?.ok) throw sourceError(result || {}); return { ...result, league: 'NHL' }; };
const validGameId = value => /^(?:19|20)\d{2}0[123]\d{4}$/.test(value || '') && Number(value.slice(6)) > 0;

export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const rate = checkRateLimit(request, { id: 'nhl-data', limit: 90, windowMs: 60_000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  const params = new URL(request.url).searchParams;
  try {
    const action = params.get('action') || 'status';
    if (action === 'status') return response({ ok: true, version: NHL_DATA_VERSION, sources: NHL_SOURCES,
      reader: { version: NHL_READER_INTERFACE_VERSION, status: 'WAITING_REAL_DATA', message: NHL_READER_WAITING_MESSAGE, verifiedMarketCount: 0 },
      persistenceConfigured: nhlPersistenceConfigured(), scope: 'NHL_DATA_AND_SHADOW_RESEARCH', realBetExecutionEnabled: false });
    if (action === 'research') return response(await cachedNhlData('historical-research-v1', async () => nhlHistoricalResearch(), { ttlMs: 3600_000 }));
    if (action === 'schedule') {
      const date = params.get('date');
      if (!validDateString(date)) return response({ ok: false, code: 'NHL_INVALID_DATE', error: '台灣日期格式無效' }, 400);
      return response(await cachedNhlData(`schedule:${date}`, async () => requireResult(await fetchNhlSchedule(date)), { ttlMs: 60_000 }));
    }
    if (action === 'game') {
      const gameId = params.get('gameId');
      if (!validGameId(gameId)) return response({ ok: false, code: 'NHL_INVALID_GAME_ID', error: 'NHL Game ID 無效' }, 400);
      const result = await cachedNhlData(`game:${gameId}`, async () => {
        const live = await fetchNhlGame(gameId, { includeDetails: true });
        if (live.ok) return { ...live, league: 'NHL', acquisition: 'OFFICIAL_LIVE_FETCH' };
        if (live.status === 'BLOCK') return requireResult(live);
        const historical = NHL_HISTORICAL_SAMPLES.find(game => game.gameId === gameId);
        if (historical && historical.qa?.canUseHistoricalPeriods === true && historical.historical === true) {
          return { ok: true, league: 'NHL', game: historical, acquisition: 'ARCHIVED_OFFICIAL_HISTORICAL_SAMPLE',
            issues: [live.code || 'CURRENT_SOURCE_UNAVAILABLE'], warning: '目前來源更新失敗；顯示已核對的官方歷史樣本，來源取得時間保持原值。' };
        }
        return requireResult(live);
      }, { ttlMs: 60_000 });
      let observation = { persisted: false, reason: result.acquisition === 'ARCHIVED_OFFICIAL_HISTORICAL_SAMPLE' ? '顯示封存樣本，沒有新增本次即時來源版本。' : '資料庫尚未設定' };
      if (nhlPersistenceConfigured() && result.acquisition === 'OFFICIAL_LIVE_FETCH') {
        try { observation = await saveNhlObservation('GAME', gameId, { league: 'NHL', observedAt: result.game.source.fetchedAt, game: result.game }); }
        catch { observation = { persisted: false, reason: '永久來源快照寫入失敗；本次資料可查看，不能當成已永久保存。' }; }
      }
      // Keep the complete evidence in the source snapshot. Avoid sending and
      // persisting thousands of raw events in browser localStorage.
      const game = { ...result.game };
      if (game.playByPlay) game.playByPlay = { source: game.playByPlay.source, eventCount: game.playByPlay.events?.length || 0 };
      return response({ ...result, game, observation });
    }
    if (action === 'context') {
      const gameId = params.get('gameId');
      if (!validGameId(gameId)) return response({ ok: false, code: 'NHL_INVALID_GAME_ID', error: 'NHL Game ID 無效' }, 400);
      return response(await cachedNhlData(`context:${gameId}`, async () => {
        const { game } = requireResult(await fetchNhlGame(gameId));
        const schedules = await Promise.all([fetchNhlClubSchedule(game.away, game.season), fetchNhlClubSchedule(game.home, game.season)]);
        const sides = {};
        for (const [index, side] of ['away', 'home'].entries()) {
          const schedule = requireResult(schedules[index]);
          const coverage = { ...schedule.coverage, from: schedule.coverage.from.slice(0, 10), to: schedule.coverage.to.slice(0, 10) };
          const context = nhlScheduleContext(game, schedule.games, { scheduleCoverage: coverage, includeScheduled: true });
          sides[side] = { ...context[side], qa: context.qa, source: schedule.source };
        }
        return { ok: true, league: 'NHL', gameId, ...sides, pregamePointInTimeVerified: false,
          message: '依本次官方完整球隊賽程推算；歷史查詢屬回溯資料，不代表當時可得的賽前快照。旅行距離須另有球場座標證據。' };
      }, { ttlMs: 5 * 60_000 }));
    }
    if (action === 'team-summary') {
      const teamId = Number(params.get('teamId')); const season = Number(params.get('season')); const gameType = Number(params.get('gameType'));
      if (!['teamId', 'season', 'gameType'].every(key => params.getAll(key).length === 1 && /^\d+$/.test(params.get(key) || '')) || !validNhlTeamSummaryScope(teamId, season, gameType))
        return response({ ok: false, code: 'NHL_TEAM_SUMMARY_SCOPE_INVALID', error: '球隊、賽季或賽事類型無效' }, 400);
      return response(await cachedNhlData(`team-summary-v1:${teamId}:${season}:${gameType}`, async () => requireResult(await fetchNhlTeamSummary(teamId, season, gameType)), { ttlMs: 5 * 60_000 }));
    }
    if (action === 'team') {
      const abbrev = params.get('team'); const teamId = Number(params.get('teamId')); const season = params.get('season');
      if (!/^[A-Z]{2,3}$/.test(abbrev || '') || !Number.isSafeInteger(teamId) || teamId <= 0 || !/^\d{8}$/.test(season || '')) return response({ ok: false, error: '球隊或賽季識別無效' }, 400);
      // Verify the abbrev-to-ID pairing against the official season schedule;
      // the client cannot attach a valid player roster to another team's ID.
      const knownTeam = NHL_HISTORICAL_SAMPLES.filter(game => String(game.season) === season).flatMap(game => [game.away, game.home]).find(team => team.abbrev === abbrev && team.teamId === teamId);
      const { fetchNhlJson } = await import('../../../lib/nhl/data.js');
      const schedule = await fetchNhlJson(`https://api-web.nhle.com/v1/club-schedule-season/${abbrev}/${season}`, { ttlMs: 3600_000 });
      const verified = schedule.ok && Array.isArray(schedule.data.games) && schedule.data.games.some(game => [game.awayTeam, game.homeTeam].some(team => team?.abbrev === abbrev && team?.id === teamId));
      if (!verified && !knownTeam) throw Object.assign(new Error('官方球隊代碼與 ID 尚未完成核對'), { status: 422, code: 'NHL_TEAM_IDENTITY_UNVERIFIED' });
      const team = { abbrev, teamId };
      const result = await cachedNhlData(`team:${abbrev}:${teamId}:${season}`, async () => {
        const [roster, statistics] = await Promise.all([fetchNhlRoster(team, season), fetchNhlTeamStatistics(team, season, 2)]);
        requireResult(roster);
        return { ok: true, league: 'NHL', roster, statistics, issues: statistics.ok ? [] : [statistics.code], identityBasis: verified ? 'OFFICIAL_SEASON_SCHEDULE' : 'ARCHIVED_OFFICIAL_GAME_TEAM' };
      }, { ttlMs: 5 * 60_000 });
      return response(result);
    }
    if (action === 'player') {
      const id = params.get('playerId');
      if (!/^\d{6,8}$/.test(id || '')) return response({ ok: false, error: '球員 ID 無效' }, 400);
      return response(await cachedNhlData(`player:${id}`, async () => requireResult(await fetchNhlPlayer(id)), { ttlMs: 5 * 60_000 }));
    }
    if (action === 'versions') {
      const gameId = params.get('gameId');
      if (!validGameId(gameId)) return response({ ok: false, error: 'NHL Game ID 無效' }, 400);
      return response({ ok: true, versions: await loadNhlObservations('GAME', gameId) });
    }
    return response({ ok: false, error: '不支援的 NHL 資料操作' }, 400);
  } catch (error) {
    return response({ ok: false, code: error.code || 'NHL_DATA_ERROR', error: error.status ? error.message : 'NHL 資料服務暫時無法完成，請稍後重試。',
      issues: error.issues || [], upstreamStatus: error.upstreamStatus || null }, error.status || 503);
  }
}
