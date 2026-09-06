import { neon } from '@neondatabase/serverless';
import { durableDatabaseUrl, durableDatabaseConfigured } from '../database-url.js';
import { nhlContentHash } from './context.js';
import { validateNhlIdentity, validNhlDate } from './identity.js';
import { NHL_READER_INTERFACE_VERSION } from './reader.js';

// Additive table. Baseball PIT, Reader, bets and calibration tables are never
// queried or migrated by the NHL module.
let client;
let schemaPromise;
const kinds = new Set(['GAME', 'PERSONNEL', 'GOALIE', 'READER', 'RESEARCH']);
export const nhlPersistenceConfigured = () => durableDatabaseConfigured();

export function validateNhlObservation(kind, key, payload, { now = Date.now() } = {}) {
  const errors = [];
  if (!kinds.has(kind) || typeof key !== 'string' || !/^[a-z0-9:_-]{1,160}$/i.test(key)) errors.push('NHL_SNAPSHOT_KEY_INVALID');
  if (payload?.league !== 'NHL' || typeof payload?.observedAt !== 'string'
    || !/(Z|[+-]\d{2}:\d{2})$/.test(payload.observedAt) || !Number.isFinite(Date.parse(payload.observedAt))
    || !Number.isFinite(now) || Date.parse(payload.observedAt) > now + 5_000) errors.push('NHL_SNAPSHOT_TIME_OR_LEAGUE_INVALID');
  if (kind === 'GAME' && (payload?.game?.league !== 'NHL' || String(payload?.game?.gameId) !== key || !validateNhlIdentity(payload?.game).ok
    || !payload?.game?.source?.contentHash || !payload?.game?.source?.url)) errors.push('NHL_SNAPSHOT_GAME_IDENTITY_INVALID');
  if (kind === 'READER' && (payload?.boardDate !== key || !validNhlDate(key)
    || payload?.provider !== 'TAI888_READER' || payload?.interfaceVersion !== NHL_READER_INTERFACE_VERSION
    || !Array.isArray(payload?.rawRows) || payload.rawRows.length > 100 || payload?.executable !== false
    || !/^[a-f0-9]{64}$/i.test(payload?.sourceHash || ''))) errors.push('NHL_SNAPSHOT_READER_IDENTITY_INVALID');
  if (['GOALIE', 'PERSONNEL'].includes(kind) && String(payload?.gameId ?? payload?.game?.gameId) !== key) errors.push('NHL_SNAPSHOT_GAME_IDENTITY_INVALID');
  return { ok: errors.length === 0, errors };
}

function sql() {
  if (!nhlPersistenceConfigured()) throw Object.assign(new Error('NHL 永久快照資料庫尚未設定'), { code: 'NHL_DATABASE_UNAVAILABLE', status: 503 });
  if (!client) client = neon(durableDatabaseUrl());
  return client;
}

async function ensureSchema() {
  if (!schemaPromise) schemaPromise = sql()`CREATE TABLE IF NOT EXISTS sports_nhl_snapshots_v1 (
    kind TEXT NOT NULL, record_key TEXT NOT NULL, revision TEXT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (kind, record_key, revision),
    CHECK (payload->>'league' = 'NHL')
  )`.catch(error => { schemaPromise = null; throw error; });
  await schemaPromise;
}

export async function saveNhlObservation(kind, key, payload) {
  const validation = validateNhlObservation(kind, key, payload);
  if (!validation.ok) throw Object.assign(new Error('NHL 快照識別或時間無效'), { code: 'NHL_SNAPSHOT_INVALID', status: 422, issues: validation.errors });
  const revision = nhlContentHash(payload);
  await ensureSchema();
  await sql()`INSERT INTO sports_nhl_snapshots_v1 (kind, record_key, revision, observed_at, payload)
    VALUES (${kind}, ${key}, ${revision}, ${payload.observedAt}, ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT DO NOTHING`;
  return { persisted: true, revision, observedAt: payload.observedAt };
}

export async function loadNhlObservations(kind, key, limit = 20) {
  if (!kinds.has(kind) || typeof key !== 'string' || !/^[a-z0-9:_-]{1,160}$/i.test(key)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('NHL_SNAPSHOT_INVALID');
  await ensureSchema();
  const rows = await sql()`SELECT revision, observed_at, payload FROM sports_nhl_snapshots_v1
    WHERE kind=${kind} AND record_key=${key} ORDER BY observed_at DESC, created_at DESC LIMIT ${limit}`;
  return rows.map(row => {
    if (!validateNhlObservation(kind, key, row.payload).ok) throw Object.assign(new Error('NHL 永久快照身分或資料損壞'), { code: 'NHL_SNAPSHOT_CORRUPTED', status: 503 });
    return { ...row.payload, revision: row.revision };
  });
}
