import { NextResponse } from 'next/server';
import { requireApiAuth, checkRateLimit, rateLimitResponse } from '../../../../lib/security.js';
import { validDate } from '../../../../lib/nba/identity.js';
import { loadNbaAnalysisBoard } from '../../../../lib/nba/analysis-board.js';
import { restoreNbaAnalysisBoard, loadNbaRetainedAnalysisBoard } from '../../../../lib/nba/analysis-journal.js';
import { recoverableNbaScheduleSourceError } from '../../../../lib/nba/data.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const response = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  const query = new URL(request.url).searchParams;
  if (query.size !== 1 || !validDate(query.get('date'))) return response({ ok: false, error: 'NBA 日期或參數無效' }, 400);
  const rate = checkRateLimit(request, { id: 'nba-analysis-board', limit: 60, windowMs: 60_000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try { return response({ ok: true, ...await restoreNbaAnalysisBoard(await loadNbaAnalysisBoard(query.get('date'))) }); }
  catch (error) {
    const issues = error?.issueCodes || [];
    // Invalid identity/schema evidence stays a blocked response. Only a source
    // transport outage may expose an independently verified historical view.
    const sourceFailure = error?.code === 'NBA_SCHEDULE_UNAVAILABLE'
      && issues.some(code => code === 'STALE_CACHE' || recoverableNbaScheduleSourceError(code))
      && !issues.some(code => /IDENTITY|SCHEMA|SCORE_INVALID|SEASON_INVALID|DATE_INVALID/.test(code)
        && code !== 'OFFICIAL_IDENTITY_UNVERIFIED');
    const retained = sourceFailure ? await loadNbaRetainedAnalysisBoard(query.get('date'), { scheduleError: error }) : null;
    if (retained) {
      console.warn('[NBA_ANALYSIS_BOARD_RETAINED]', { date: query.get('date'), code: error.code, issueCodes: issues });
      return response({ ok: true, ...retained });
    }
    console.error('[NBA_ANALYSIS_BOARD_FAILED]', { date: query.get('date'), code: error?.code || 'NBA_BOARD_UNAVAILABLE', issueCodes: error?.issueCodes || [] });
    return response({ ok: false, error: 'NBA 賽程或盤口暫時無法核對，請重試。', code: error?.code || 'NBA_BOARD_UNAVAILABLE' }, 503);
  }
}
