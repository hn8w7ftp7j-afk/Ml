import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from '../database-url.js';
import { APP_VERSION } from '../app-version.js';
import { freezeNbaForwardSelection, nbaCaptureRevision, validNbaForwardCapture } from './forward-validation.js';
import { validDate } from './identity.js';
import { mergeNbaAnalysisResults } from './analysis-job-display.js';

export async function restoreNbaAnalysisBoard(board, { db = null } = {}) {
  if (board?.league !== 'NBA' || !validDate(board.date) || !Array.isArray(board.rows)) throw Error('Invalid NBA board');
  if (!db) {
    const url = durableDatabaseUrl();
    if (!url) return { ...board, savedAnalysisStatus: 'unavailable' };
    db = client ||= neon(url);
  }
  try {
    const records = await db`SELECT DISTINCT ON (game_id) revision, captured_at, payload
      FROM nba_analysis_forward_v1 WHERE board_date=${board.date}
      ORDER BY game_id, captured_at DESC, revision DESC LIMIT 40`;
    const entries = [];
    for (const record of records) {
      const capturedAt = new Date(record.captured_at).toISOString();
      if (!validNbaForwardCapture({ ...record, capturedAt }) || record.payload.date !== board.date) continue;
      const row = board.rows.find(row => row.game.id === record.payload.gameId);
      if (!row || row.game.home.id !== record.payload.game.home.id || row.game.away.id !== record.payload.game.away.id
        || row.game.startTime !== record.payload.game.startTime) continue;
      const payload = { ...record.payload, persistence: { persisted: true, status: 'saved', revision: record.revision, capturedAt } };
      const entry = { ok: true, payload, task: { game: { ...payload.game, gamePk: Number(payload.game.sourceId) },
        nbaQuery: { date: board.date, id: payload.game.sourceId, observedAt: payload.observedAt } } };
      // Apply the same current model/market guards as completed workflow results.
      try { mergeNbaAnalysisResults({ league: 'NBA', date: board.date, results: [entry] }, [row], board.date); entries.push(entry); } catch {}
    }
    return { ...board, rows: mergeNbaAnalysisResults({ league: 'NBA', date: board.date, results: entries }, board.rows, board.date), savedAnalysisStatus: 'ready' };
  } catch { return { ...board, savedAnalysisStatus: 'unavailable' }; }
}

// A provider outage must not hide durable analyses on a new device. These are
// retained source snapshots, never a substitute for the current schedule or a
// newly verified quote. No candidates, tasks, records or settlement writes are
// authorized by this projection.
export async function loadNbaRetainedAnalysisBoard(date, { db = null, now = Date.now(), scheduleError = null } = {}) {
  if (!validDate(date) || !Number.isFinite(now)) return null;
  if (!db) {
    const url = durableDatabaseUrl();
    if (!url) return null;
    db = client ||= neon(url);
  }
  try {
    const records = await db`SELECT DISTINCT ON (game_id) game_id, board_date, revision, captured_at,
      to_char(captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_at_exact, payload
      FROM nba_analysis_forward_v1 WHERE board_date=${date} AND captured_at<=clock_timestamp()
      ORDER BY game_id, captured_at DESC, revision DESC LIMIT 40`;
    const rows = [];
    for (const record of records) {
      const payload = record.payload, capturedAt = new Date(record.captured_at).toISOString();
      if (payload?.forwardCaptureHashVersion !== 'canonical-json-sha256-v1'
        || !validNbaForwardCapture(record) || payload.date !== date || Date.parse(capturedAt) > now
        || record.game_id !== payload.gameId || record.board_date !== date
        || !Number.isFinite(Date.parse(payload.generatedAt || '')) || Date.parse(payload.generatedAt) > Date.parse(capturedAt)
        || payload.game?.league !== 'NBA' || payload.game.id !== `nba:espn:game:${payload.game.sourceId}`
        || !['home', 'away'].every(side => payload.game[side]?.league === 'NBA')) continue;
      const game = payload.game;
      const historical = { ...payload, persistence: { persisted: true, status: 'saved', revision: record.revision, capturedAt } };
      const row = { game, quote: null, canAnalyze: false, observedAt: null, pageActivityAt: null,
        readOnly: true, scheduleVerified: false, savedAnalysisAt: capturedAt,
        reason: '賽程來源暫時無法核對，以下為已保存分析；目前賽事狀態與盤口尚未確認。' };
      try {
        const [restored] = mergeNbaAnalysisResults({ league: 'NBA', date, results: [{ ok: true, payload: historical,
          task: { game: { ...game, gamePk: Number(game.sourceId) },
            nbaQuery: { id: game.sourceId, date, observedAt: payload.observedAt } } }] }, [row], date);
        rows.push(restored);
      } catch { /* Historical hashes alone cannot approve an unsupported model result. */ }
    }
    if (!rows.length) return null;
    return { league: 'NBA', date, rows, tasks: [], total: 0, emptyReason: 'schedule_unavailable',
      readerStatus: 'unverified', readerCoverage: null, observedAt: null, sources: [],
      readOnly: true, scheduleStatus: 'unavailable', scheduleCoverage: 'RETAINED_ANALYSES_ONLY',
      savedAnalysisStatus: 'retained', scheduleVerified: false,
      sourceError: { code: scheduleError?.code || 'NBA_SCHEDULE_UNAVAILABLE',
        issueCodes: Array.isArray(scheduleError?.issueCodes) ? [...scheduleError.issueCodes] : [] } };
  } catch { return null; }
}

let client, schema;
export function buildNbaAnalysisCapture(analysis) {
  if (analysis?.status !== 'ready' || analysis.league !== 'NBA' || analysis.game?.status !== 'scheduled'
    || analysis.game.completed || analysis.game.timeConfirmed !== true
    || !analysis.prediction || !/^[a-f0-9]{64}$/.test(analysis.quoteHash || '')
    || !Number.isFinite(Date.parse(analysis.game.startTime))) throw new Error('NBA analysis is not capture eligible');
  const payload = { ...analysis, forwardCaptureVersion: 'nba-analysis-forward-v1',
    forwardCaptureHashVersion: 'canonical-json-sha256-v1',
    forwardSelection: freezeNbaForwardSelection(analysis),
    engineVersion: APP_VERSION,
    engineCommit: /^[a-f0-9]{40}$/.test(process.env.VERCEL_GIT_COMMIT_SHA || '') ? process.env.VERCEL_GIT_COMMIT_SHA : null,
    strictPregameReplay: false, promotionEligible: false, calibrationEligible: false,
    captureScope: 'SERVER_PREDICTION_AND_ORIGINAL_QUOTES',
    missingEvidence: ['current_game_confirmed_injury_lineup_rotation_minutes_model_inputs', 'independent_forward_sample_completion'] };
  const revision = nbaCaptureRevision(payload);
  return { revision, payload };
}
export async function saveNbaAnalysisCapture(analysis, { db = null, prepareSchema = true } = {}) {
  const { revision, payload } = buildNbaAnalysisCapture(analysis);
  if (!db) {
    const url = durableDatabaseUrl();
    if (!url) return { persisted: false, status: 'not_configured' };
    db = client ||= neon(url);
  }
  if (prepareSchema) {
    schema ||= db`CREATE TABLE IF NOT EXISTS nba_analysis_forward_v1 (
      revision TEXT PRIMARY KEY, game_id TEXT NOT NULL, board_date TEXT NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), payload JSONB NOT NULL
    )`.catch(error => { schema = null; throw error; });
    await schema;
  }
  // Database time, not the caller's generatedAt, proves capture before tipoff.
  const inserted = await db`INSERT INTO nba_analysis_forward_v1 (revision, game_id, board_date, payload)
    SELECT ${revision}, ${analysis.gameId}, ${analysis.date}, ${JSON.stringify(payload)}::jsonb
    WHERE NOW() < ${analysis.game.startTime}::timestamptz
    ON CONFLICT (revision) DO NOTHING RETURNING revision, captured_at`;
  const rows = inserted.length ? inserted : await db`SELECT revision, captured_at FROM nba_analysis_forward_v1
    WHERE revision = ${revision} AND captured_at < ${analysis.game.startTime}::timestamptz`;
  if (!rows[0]) return { persisted: false, status: 'capture_window_closed' };
  return { persisted: true, status: 'saved', revision, capturedAt: new Date(rows[0].captured_at).toISOString(), inserted: inserted.length > 0 };
}
