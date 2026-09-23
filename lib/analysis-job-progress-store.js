import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';

let client;
let ready;
const sql = () => client ||= neon(durableDatabaseUrl());
async function schema() {
  if (!ready) ready = sql()`CREATE TABLE IF NOT EXISTS baseball_analysis_job_progress (
    run_id TEXT NOT NULL, league TEXT NOT NULL, board_date TEXT NOT NULL,
    revision INTEGER NOT NULL, payload JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_id, league)
  )`.catch(error => { ready = null; throw error; });
  await ready;
}

export async function saveAnalysisJobProgress(runId, progress) {
  if (!durableDatabaseConfigured()) return false;
  await schema();
  await sql()`INSERT INTO baseball_analysis_job_progress (run_id, league, board_date, revision, payload)
    VALUES (${runId}, ${progress.league}, ${progress.date}, ${progress.revision}, ${JSON.stringify(progress)}::jsonb)
    ON CONFLICT (run_id, league) DO UPDATE SET
      revision = EXCLUDED.revision, payload = EXCLUDED.payload, updated_at = NOW()
    WHERE baseball_analysis_job_progress.revision <= EXCLUDED.revision`;
  return true;
}

export async function getAnalysisJobProgress(runId, league, afterRevision = null) {
  if (!durableDatabaseConfigured() || !league) return null;
  // Only a valid, already-rendered revision may suppress a duplicate payload.
  // Missing/invalid cursors retain the full response for older clients/reloads.
  const revision = /^\d+$/.test(String(afterRevision ?? ''))
    && Number.isSafeInteger(Number(afterRevision)) && Number(afterRevision) <= 2147483647
    ? Number(afterRevision) : null;
  await schema();
  const rows = await sql()`SELECT payload FROM baseball_analysis_job_progress
    WHERE run_id = ${runId} AND league = ${league}
      AND (${revision}::integer IS NULL OR revision <> ${revision}::integer) LIMIT 1`;
  return rows[0]?.payload || null;
}
