import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl } from '../database-url.js';
import { APP_VERSION } from '../app-version.js';
import { freezeNbaForwardSelection, nbaCaptureRevision } from './forward-validation.js';

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
