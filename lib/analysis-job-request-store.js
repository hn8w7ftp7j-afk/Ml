import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';

const REQUEST_KEY = /^[a-zA-Z0-9-]{16,100}$/;
let sqlClient;
let schemaReady;

function sql() {
  if (!sqlClient) sqlClient = neon(durableDatabaseUrl());
  return sqlClient;
}

async function ensureSchema() {
  if (!schemaReady) schemaReady = (async () => {
    await sql()`
      CREATE TABLE IF NOT EXISTS baseball_analysis_job_requests (
        request_key TEXT PRIMARY KEY,
        run_id TEXT,
        status TEXT NOT NULL DEFAULT 'STARTING',
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql()`
      CREATE INDEX IF NOT EXISTS idx_baseball_analysis_job_requests_updated
      ON baseball_analysis_job_requests(updated_at DESC)
    `;
  })();
  return schemaReady;
}

function normalize(row) {
  if (!row) return null;
  return {
    requestId: String(row.request_key || ''),
    runId: row.run_id ? String(row.run_id) : null,
    status: String(row.status || 'STARTING').toLowerCase(),
    error: row.error ? String(row.error) : '',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export function analysisJobRequestStoreConfigured(env = process.env) {
  return durableDatabaseConfigured(env);
}

export function validAnalysisJobRequestKey(value) {
  return REQUEST_KEY.test(String(value || '').trim());
}

export async function claimAnalysisJobRequest(requestKey) {
  if (!analysisJobRequestStoreConfigured() || !validAnalysisJobRequestKey(requestKey)) return null;
  await ensureSchema();
  const rows = await sql()`
    INSERT INTO baseball_analysis_job_requests (request_key, status)
    VALUES (${requestKey}, 'STARTING')
    ON CONFLICT (request_key) DO NOTHING
    RETURNING request_key, run_id, status, error, created_at, updated_at
  `;
  if (rows[0]) return { ...normalize(rows[0]), claimed: true };
  return { ...(await getAnalysisJobRequest(requestKey)), claimed: false };
}

export async function getAnalysisJobRequest(requestKey) {
  if (!analysisJobRequestStoreConfigured() || !validAnalysisJobRequestKey(requestKey)) return null;
  await ensureSchema();
  const rows = await sql()`
    SELECT request_key, run_id, status, error, created_at, updated_at
    FROM baseball_analysis_job_requests
    WHERE request_key = ${requestKey}
    LIMIT 1
  `;
  return normalize(rows[0]);
}

export async function completeAnalysisJobRequest(requestKey, runId) {
  if (!analysisJobRequestStoreConfigured() || !validAnalysisJobRequestKey(requestKey)) return null;
  await ensureSchema();
  const rows = await sql()`
    UPDATE baseball_analysis_job_requests
    SET run_id = ${runId}, status = 'RUNNING', error = NULL, updated_at = NOW()
    WHERE request_key = ${requestKey}
    RETURNING request_key, run_id, status, error, created_at, updated_at
  `;
  return normalize(rows[0]);
}

export async function failAnalysisJobRequest(requestKey, error) {
  if (!analysisJobRequestStoreConfigured() || !validAnalysisJobRequestKey(requestKey)) return null;
  await ensureSchema();
  const rows = await sql()`
    UPDATE baseball_analysis_job_requests
    SET status = 'FAILED', error = ${String(error || '背景工作啟動失敗').slice(0, 500)}, updated_at = NOW()
    WHERE request_key = ${requestKey} AND run_id IS NULL
    RETURNING request_key, run_id, status, error, created_at, updated_at
  `;
  return normalize(rows[0]);
}
