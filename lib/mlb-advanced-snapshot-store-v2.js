import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { MLB_ADVANCED_FEATURES_V2_VERSION } from './mlb-advanced-features-v2.js';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';

export const MLB_ADVANCED_SNAPSHOT_SCHEMA_V2 = 'MLB-ADVANCED-PIT-SNAPSHOT-2026-08-v2.0.0';
let sqlClient;
let schemaReady;

const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function sql() {
  if (!sqlClient) sqlClient = neon(durableDatabaseUrl());
  return sqlClient;
}

async function ensureSchema() {
  if (!schemaReady) schemaReady = (async () => {
    await sql()`
      CREATE TABLE IF NOT EXISTS mlb_advanced_feature_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        snapshot_id TEXT NOT NULL UNIQUE,
        schema_version TEXT NOT NULL,
        external_game_id BIGINT NOT NULL,
        game_start TIMESTAMPTZ NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL,
        feature_payload JSONB NOT NULL,
        source_payload_hash CHAR(64) NOT NULL,
        provenance JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (observed_at < game_start)
      )
    `;
    await sql()`CREATE INDEX IF NOT EXISTS idx_mlb_advanced_snapshot_game_time ON mlb_advanced_feature_snapshots(external_game_id, observed_at)`;
  })().catch(error => { schemaReady = null; throw error; });
  await schemaReady;
}

function advancedPayload(context) {
  return {
    contractVersion: MLB_ADVANCED_FEATURES_V2_VERSION,
    away: context?.away?.advanced || {},
    home: context?.home?.advanced || {},
    environment: context?.advancedEnvironment || {},
    sourceStatuses: Object.fromEntries(Object.entries(context?.sourceStatuses || {})
      .filter(([name]) => ['defenseFRV', 'catcherFraming', 'pitchTypeMatchup', 'injuryRunValue', 'umpireZone', 'parkWindOrientation'].includes(name))),
  };
}

export function buildMlbAdvancedSnapshotRecord(game, context) {
  const gamePk = Number(game?.gamePk || context?.game?.gamePk || 0);
  const gameStart = new Date(game?.gameDate || context?.game?.gameDate || '');
  const observedAt = new Date(context?.fetchedAt || '');
  if (!Number.isSafeInteger(gamePk) || gamePk <= 0) throw new Error('進階快照缺少有效gamePk');
  if (!Number.isFinite(gameStart.getTime()) || !Number.isFinite(observedAt.getTime())) throw new Error('進階快照時間無效');
  if (observedAt.getTime() >= gameStart.getTime()) throw new Error('進階快照不是賽前point-in-time資料');
  const featurePayload = advancedPayload(context);
  const provenance = (context?.featureProvenance || []).filter(row => [
    'advancedSavantSnapshot', 'injuryRunValue', 'umpireZone', 'parkWindOrientation',
  ].includes(row?.featureName));
  const sourcePayloadHash = sha256({ featurePayload, provenance });
  return {
    snapshotId: `${gamePk}:${observedAt.toISOString()}:${sourcePayloadHash}`,
    schemaVersion: MLB_ADVANCED_SNAPSHOT_SCHEMA_V2,
    gamePk,
    gameStart: gameStart.toISOString(),
    observedAt: observedAt.toISOString(),
    featurePayload,
    sourcePayloadHash,
    provenance,
  };
}

export async function persistMlbAdvancedSnapshot(game, context) {
  if (!durableDatabaseConfigured()) return { stored: false, reason: 'DATABASE_NOT_CONFIGURED' };
  const record = buildMlbAdvancedSnapshotRecord(game, context);
  await ensureSchema();
  await sql()`
    INSERT INTO mlb_advanced_feature_snapshots
      (snapshot_id, schema_version, external_game_id, game_start, observed_at, feature_payload, source_payload_hash, provenance)
    VALUES
      (${record.snapshotId}, ${record.schemaVersion}, ${record.gamePk}, ${record.gameStart}, ${record.observedAt},
       ${JSON.stringify(record.featurePayload)}::jsonb, ${record.sourcePayloadHash}, ${JSON.stringify(record.provenance)}::jsonb)
    ON CONFLICT (snapshot_id) DO NOTHING
  `;
  return { stored: true, snapshotId: record.snapshotId };
}

export async function persistMlbAdvancedSnapshotBestEffort(game, context) {
  try { return await persistMlbAdvancedSnapshot(game, context); }
  catch (error) {
    console.error('[MLB_ADVANCED_SNAPSHOT_WRITE_FAILED]', { gamePk: game?.gamePk, error: String(error?.message || error) });
    return { stored: false, reason: 'WRITE_FAILED' };
  }
}
