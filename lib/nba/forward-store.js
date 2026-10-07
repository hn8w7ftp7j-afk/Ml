import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { durableDatabaseUrl } from '../database-url.js';
import { NBA_FORWARD_VERSION, canonicalNbaForwardCaptures, nbaForwardContractHash, validNbaForwardCapture, buildNbaForwardReport } from './forward-validation.js';
import { validDate, taipeiDate } from './identity.js';

let client, clientUrl;
const schemas = new WeakMap();
function database() {
  const url = durableDatabaseUrl();
  if (!url) throw Object.assign(new Error('NBA 前瞻驗證永久資料庫未設定。'), { status: 503 });
  if (!client || url !== clientUrl) { client = neon(url); clientUrl = url; }
  return client;
}
export async function prepareNbaForwardSchema(db) {
  let task = schemas.get(db);
  if (!task) {
    task = (async () => {
      await db`CREATE TABLE IF NOT EXISTS nba_analysis_forward_v1 (
        revision TEXT PRIMARY KEY, game_id TEXT NOT NULL, board_date TEXT NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), payload JSONB NOT NULL
      )`;
      await db`CREATE TABLE IF NOT EXISTS nba_forward_evaluations_v1 (
        observation_key TEXT PRIMARY KEY, revision TEXT NOT NULL REFERENCES nba_analysis_forward_v1(revision),
        game_id TEXT NOT NULL, board_date TEXT NOT NULL, market_key TEXT NOT NULL,
        contract_hash TEXT NOT NULL, payload JSONB NOT NULL, evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await db`CREATE TABLE IF NOT EXISTS nba_forward_attempts_v1 (
        attempt_id TEXT PRIMARY KEY, game_id TEXT NOT NULL, payload JSONB NOT NULL,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
      await db`CREATE INDEX IF NOT EXISTS nba_forward_capture_game_time_v1 ON nba_analysis_forward_v1(game_id, captured_at)`;
      await db`CREATE INDEX IF NOT EXISTS nba_forward_attempt_game_time_v1 ON nba_forward_attempts_v1(game_id, attempted_at)`;
      // Enforce append-only even if a later application path accidentally tries
      // to update or erase a completed research observation.
      await db`CREATE OR REPLACE FUNCTION nba_forward_reject_mutation_v1() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'NBA forward evaluations are append-only'; END $$`;
      await db`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'nba_forward_append_only_v1'
          AND tgrelid = 'nba_forward_evaluations_v1'::regclass) THEN
          CREATE TRIGGER nba_forward_append_only_v1 BEFORE UPDATE OR DELETE ON nba_forward_evaluations_v1
          FOR EACH ROW EXECUTE FUNCTION nba_forward_reject_mutation_v1();
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'nba_forward_attempt_append_only_v1'
          AND tgrelid = 'nba_forward_attempts_v1'::regclass) THEN
          CREATE TRIGGER nba_forward_attempt_append_only_v1 BEFORE UPDATE OR DELETE ON nba_forward_attempts_v1
          FOR EACH ROW EXECUTE FUNCTION nba_forward_reject_mutation_v1();
        END IF;
      END $$`;
    })().catch(error => { schemas.delete(db); throw error; });
    schemas.set(db, task);
  }
  await task;
}
function scope({ from = null, through = null, date = null, now = Date.now() } = {}) {
  if ([from, through, date].some(value => value != null && !validDate(value))) throw Object.assign(new Error('驗證日期格式不正確。'), { status: 400 });
  if (date != null && (from != null || through != null)) throw Object.assign(new Error('請指定單日或日期範圍，不能混用。'), { status: 400 });
  const last = through || date || taipeiDate(now), first = from || date || new Date(Date.parse(`${last}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
  if (!validDate(first) || !validDate(last) || first > last || Date.parse(last) - Date.parse(first) > 365 * 86400000
    || last > taipeiDate(now)) throw Object.assign(new Error('驗證日期範圍須為已發生的有效日期，最多 366 天。'), { status: 400 });
  return { from: first, through: last };
}
export function normalizeNbaForwardScope(options) { return scope(options); }
const normalizeCapture = row => ({ ...row, capturedAt: new Date(row.captured_at).toISOString(),
  capturedAtExact: row.captured_at_exact || (typeof row.captured_at === 'string' ? row.captured_at : new Date(row.captured_at).toISOString()) });
export async function listPendingNbaForwardCaptures({ date = null, from = null, through = null, limit = 50, now = Date.now() } = {},
  { db = null, prepareSchema = true } = {}) {
  const latest = through || date || taipeiDate(now);
  const range = scope({ date, from: date || from ? from : new Date(Date.parse(`${latest}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10), through, now });
  const bound = Math.min(100, Math.max(1, Math.floor(limit)));
  db ||= database(); if (prepareSchema) await prepareNbaForwardSchema(db);
  // First bound distinct games, then retain EVERY capture for those games.
  // LIMIT before canonicalization must never silently discard the latest quote.
  const rows = await db`WITH candidate_games AS (
    SELECT c.game_id, MIN(c.captured_at) AS first_capture FROM nba_analysis_forward_v1 c
    WHERE c.board_date >= ${range.from} AND c.board_date <= ${range.through}
      AND c.captured_at < (c.payload->'game'->>'startTime')::timestamptz
      AND (c.payload->'game'->>'startTime')::timestamptz < ${new Date(now).toISOString()}::timestamptz
      AND EXISTS (SELECT 1 FROM jsonb_each(COALESCE(c.payload->'marketAnalyses', '{}'::jsonb)) m
        WHERE m.key IN ('fullTotal','fullRunline','firstHalfTotal','firstHalfRunline') AND m.value->>'status' = 'ready'
          AND NOT EXISTS (SELECT 1 FROM nba_forward_evaluations_v1 e
            WHERE e.game_id = c.game_id AND e.market_key = m.key))
    GROUP BY c.game_id
  ), pending_games AS (
    SELECT c.game_id, c.first_capture, attempt.last_attempt FROM candidate_games c
    LEFT JOIN LATERAL (SELECT MAX(a.attempted_at) AS last_attempt
      FROM nba_forward_attempts_v1 a WHERE a.game_id = c.game_id) attempt ON TRUE
    ORDER BY attempt.last_attempt ASC NULLS FIRST, c.first_capture, c.game_id LIMIT ${bound}
  ) SELECT c.revision, c.game_id, c.board_date, c.captured_at,
    to_char(c.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_at_exact, c.payload
    FROM nba_analysis_forward_v1 c JOIN pending_games p ON p.game_id = c.game_id
    ORDER BY p.last_attempt ASC NULLS FIRST, p.first_capture, c.game_id, c.captured_at, c.revision`;
  const canonical = canonicalNbaForwardCaptures(rows.map(normalizeCapture), { now });
  const gameOrder = new Map();
  for (const row of rows) if (!gameOrder.has(row.game_id)) gameOrder.set(row.game_id, gameOrder.size);
  canonical.sort((a, b) => gameOrder.get(a.payload.gameId) - gameOrder.get(b.payload.gameId) || a.marketKey.localeCompare(b.marketKey));
  if (!canonical.length) return [];
  const ids = [...new Set(canonical.map(c => c.payload.gameId))];
  const evaluated = await db`SELECT observation_key FROM nba_forward_evaluations_v1 WHERE game_id = ANY(${ids}::text[])`;
  const done = new Set(evaluated.map(e => e.observation_key));
  return canonical.filter(c => !done.has(`${NBA_FORWARD_VERSION}|${c.payload.gameId}|${c.marketKey}`));
}

export async function recordNbaForwardAttempt(capture, summary, { db = null, prepareSchema = true, id = randomUUID() } = {}) {
  if (!validNbaForwardCapture(capture) || !summary || !['checked', 'evaluated', 'pending', 'deferred'].every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0)) throw new Error('Invalid forward attempt');
  db ||= database(); if (prepareSchema) await prepareNbaForwardSchema(db);
  const payload = { checked: summary.checked, evaluated: summary.evaluated, pending: summary.pending, deferred: summary.deferred,
    reasons: Object.fromEntries(Object.entries(summary.reasons || {}).filter(([key, count]) => /^[A-Z0-9_]{1,80}$/.test(key) && Number.isSafeInteger(count) && count >= 0)),
    status: summary.evaluated > 0 ? 'evaluated_or_partial' : 'pending', isActualBet: false };
  const rows = await db`INSERT INTO nba_forward_attempts_v1 (attempt_id,game_id,payload)
    SELECT ${id}, c.game_id, ${JSON.stringify(payload)}::jsonb FROM nba_analysis_forward_v1 c
    WHERE c.revision = ${capture.revision} AND c.game_id = ${capture.payload.gameId}
      AND c.captured_at < (c.payload->'game'->>'startTime')::timestamptz
      AND NOW() > (c.payload->'game'->>'startTime')::timestamptz
    ON CONFLICT (attempt_id) DO NOTHING RETURNING attempt_id`;
  return { persisted: rows.length === 1, attemptId: rows[0]?.attempt_id || null };
}

export async function archiveNbaForwardEvaluation(capture, evaluation, { db = null, prepareSchema = true } = {}) {
  if (!validNbaForwardCapture(capture) || evaluation?.status !== 'EVALUATED' || evaluation.version !== NBA_FORWARD_VERSION
    || evaluation.revision !== capture.revision || evaluation.marketKey !== capture.marketKey
    || evaluation.contractHash !== nbaForwardContractHash(capture)
    || evaluation.observationKey !== `${NBA_FORWARD_VERSION}|${capture.payload.gameId}|${capture.marketKey}`
    || evaluation.executable !== false || evaluation.strictPointInTime !== false || evaluation.isActualBet !== false) throw new Error('NBA forward contract mismatch');
  db ||= database(); if (prepareSchema) await prepareNbaForwardSchema(db);
  const p = capture.payload, key = capture.marketKey;
  // A DB-time guard and exact source JSON check prevent late/backdated inserts.
  // Any newer apparently complete capture blocks this write (fail closed), so
  // two competing requests cannot choose a more profitable earlier quote.
  const rows = await db`INSERT INTO nba_forward_evaluations_v1
    (observation_key,revision,game_id,board_date,market_key,contract_hash,payload)
    SELECT ${evaluation.observationKey}, c.revision, c.game_id, c.board_date, ${key}, ${evaluation.contractHash}, ${JSON.stringify(evaluation)}::jsonb
    FROM nba_analysis_forward_v1 c WHERE c.revision = ${capture.revision}
      AND c.payload = ${JSON.stringify(p)}::jsonb AND c.game_id = ${p.gameId} AND c.board_date = ${p.date}
      AND c.captured_at = ${capture.capturedAtExact || capture.capturedAt}::timestamptz
      AND c.captured_at < ${p.game.startTime}::timestamptz AND NOW() > ${p.game.startTime}::timestamptz
      AND NOT EXISTS (SELECT 1 FROM nba_analysis_forward_v1 newer
        WHERE newer.game_id = c.game_id AND newer.captured_at < ${p.game.startTime}::timestamptz
          AND (newer.captured_at > c.captured_at OR newer.captured_at = c.captured_at AND newer.revision > c.revision)
          AND newer.payload->'marketAnalyses'->${key}->>'status' = 'ready'
          AND newer.payload->'quotes'->${key} = newer.payload->'marketAnalyses'->${key}->'quote')
    ON CONFLICT (observation_key) DO NOTHING RETURNING contract_hash, payload`;
  const saved = rows.length ? rows : await db`SELECT contract_hash, payload FROM nba_forward_evaluations_v1
    WHERE observation_key = ${evaluation.observationKey}`;
  if (!saved[0]) return { evaluation: null, created: false, status: 'canonical_capture_changed_or_unverified' };
  if (saved[0].contract_hash !== evaluation.contractHash || saved[0].payload.contractHash !== evaluation.contractHash) throw new Error('NBA stored forward contract mismatch');
  return { evaluation: saved[0].payload, created: rows.length > 0, persistence: 'durable_database' };
}

export async function readNbaForwardValidation({ date = null, from = null, through = null, now = Date.now() } = {},
  { db = null, prepareSchema = true } = {}) {
  const range = scope({ date, from, through, now });
  db ||= database(); if (prepareSchema) await prepareNbaForwardSchema(db);
  const rows = await db`SELECT c.revision, c.game_id, c.board_date, c.captured_at,
    to_char(c.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_at_exact, c.payload,
    e.contract_hash AS evaluation_hash, e.payload AS evaluation FROM nba_analysis_forward_v1 c
    LEFT JOIN nba_forward_evaluations_v1 e ON e.revision = c.revision
    WHERE c.board_date >= ${range.from} AND c.board_date <= ${range.through}
    ORDER BY c.captured_at, c.revision LIMIT 10001`;
  const truncated = rows.length > 10000;
  // A partial capture inventory cannot prove which pre-tipoff quote is LAST.
  // In particular a join can have four market rows for one revision. Do not
  // publish a profitable earlier observation simply because its newer capture
  // lies after the bounded read; all performance statistics fail closed.
  if (truncated) {
    const empty = buildNbaForwardReport([], { pending: null, truncated: true });
    return { ...empty, status: 'incomplete_capture_inventory', range, evaluations: null, directions: null,
      distinctGames: null, canonicalMarkets: null, capturedGames: null, rawCaptureRows: null,
      invalidCaptureRows: null, rawRowsRead: rows.length, unitProfit: null,
      selected: { ...empty.selected, directions: null, distinctGames: null, unitProfit: null },
      reason: 'Capture inventory exceeded bounded read; canonical quote and performance are not established. Query a narrower date range.' };
  }
  const bounded = rows, captures = canonicalNbaForwardCaptures(bounded.map(normalizeCapture), { now });
  const byKey = new Map(captures.map(c => [`${c.revision}|${c.marketKey}`, c]));
  const evaluations = [];
  for (const row of bounded) {
    const e = row.evaluation;
    if (!e) continue;
    const capture = byKey.get(`${row.revision}|${e.marketKey}`);
    if (!capture) continue;
    if (row.evaluation_hash !== e.contractHash || e.contractHash !== nbaForwardContractHash(capture)) throw new Error('NBA forward evaluation integrity mismatch');
    evaluations.push(e);
  }
  const evaluatedKeys = new Set(evaluations.map(e => `${e.gameId}|${e.marketKey}`));
  const report = buildNbaForwardReport(evaluations, { pending: captures.filter(c => !evaluatedKeys.has(`${c.payload.gameId}|${c.marketKey}`)).length, truncated });
  return { ...report, range, canonicalMarkets: captures.length,
    capturedGames: new Set(captures.map(c => c.payload.gameId)).size,
    rawCaptureRows: new Set(bounded.map(c => c.revision)).size,
    invalidCaptureRows: new Set(bounded.filter(c => !validNbaForwardCapture(c)).map(c => c.revision)).size };
}
