import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';

const asNumber = value => Number(value || 0);

export function pitRetentionDatabaseConfigured() {
  return durableDatabaseConfigured();
}

export async function planPitRetentionMaintenance() {
  if (!pitRetentionDatabaseConfigured()) throw new Error('PIT retention inventory requires DATABASE_URL');
  const sql = neon(durableDatabaseUrl());

  const [relation] = await sql`
    SELECT
      pg_total_relation_size('baseball_analysis_pit_snapshots'::regclass)::bigint AS total_relation_bytes,
      pg_relation_size('baseball_analysis_pit_snapshots'::regclass)::bigint AS table_bytes,
      pg_indexes_size('baseball_analysis_pit_snapshots'::regclass)::bigint AS index_bytes
  `;
  const rows = await sql`
    WITH RECURSIVE bet_roots AS (
      SELECT DISTINCT COALESCE(
        NULLIF(payload->>'pitSnapshotId', ''),
        NULLIF(payload#>>'{analysis,pitSnapshotId}', '')
      ) AS snapshot_id
      FROM baseball_private_bets_v2
    ), protected_snapshots(snapshot_id) AS (
      SELECT snapshot_id FROM bet_roots WHERE snapshot_id IS NOT NULL
      UNION
      SELECT pit.parent_snapshot_id
      FROM baseball_analysis_pit_snapshots pit
      JOIN protected_snapshots protected ON protected.snapshot_id = pit.snapshot_id
      WHERE pit.parent_snapshot_id IS NOT NULL
    ), inventory AS (
      SELECT
        pit.*,
        protected.snapshot_id IS NOT NULL AS is_protected,
        pg_column_size(pit.frozen_context_payload)::bigint AS frozen_bytes,
        pg_column_size(pit.market_analysis_payload)::bigint AS market_bytes,
        pg_column_size(pit.distribution_payload)::bigint AS distribution_bytes
      FROM baseball_analysis_pit_snapshots pit
      LEFT JOIN protected_snapshots protected ON protected.snapshot_id = pit.snapshot_id
    )
    SELECT
      COUNT(*)::bigint AS total_snapshots,
      COUNT(*) FILTER (WHERE analysis_type = 'FULL')::bigint AS full_snapshots,
      COUNT(*) FILTER (WHERE analysis_type = 'PRICE_ONLY_REPRICE')::bigint AS reprice_snapshots,
      COUNT(*) FILTER (WHERE is_protected)::bigint AS protected_snapshots,
      COUNT(*) FILTER (
        WHERE analysis_type = 'PRICE_ONLY_REPRICE'
          AND game_start < NOW()
          AND NOT is_protected
          AND (
            frozen_context_payload->>'encoding' IS DISTINCT FROM 'OMITTED_HASH_ONLY'
            OR market_analysis_payload->>'encoding' IS DISTINCT FROM 'OMITTED_HASH_ONLY'
          )
      )::bigint AS eligible_snapshots,
      COALESCE(SUM(frozen_bytes), 0)::bigint AS frozen_bytes,
      COALESCE(SUM(market_bytes), 0)::bigint AS market_bytes,
      COALESCE(SUM(distribution_bytes), 0)::bigint AS distribution_bytes,
      COALESCE(SUM(frozen_bytes + market_bytes) FILTER (
        WHERE analysis_type = 'PRICE_ONLY_REPRICE'
          AND game_start < NOW()
          AND NOT is_protected
          AND (
            frozen_context_payload->>'encoding' IS DISTINCT FROM 'OMITTED_HASH_ONLY'
            OR market_analysis_payload->>'encoding' IS DISTINCT FROM 'OMITTED_HASH_ONLY'
          )
      ), 0)::bigint AS eligible_payload_bytes
    FROM inventory
  `;
  const [references] = await sql`
    SELECT
      (SELECT COUNT(*) FROM baseball_private_bets_v2)::bigint AS bets,
      (SELECT COUNT(*) FROM baseball_analysis_direction_results)::bigint AS direction_results,
      (SELECT COUNT(*) FROM baseball_analysis_direction_settlements)::bigint AS direction_settlements
  `;
  const inventory = rows[0] || {};
  return {
    generatedAt: new Date().toISOString(),
    policy: 'EXPIRED_UNPROTECTED_REPRICE_PAYLOADS_ONLY',
    relation: {
      totalBytes: asNumber(relation?.total_relation_bytes),
      tableBytes: asNumber(relation?.table_bytes),
      indexBytes: asNumber(relation?.index_bytes),
    },
    snapshots: {
      total: asNumber(inventory.total_snapshots),
      full: asNumber(inventory.full_snapshots),
      reprice: asNumber(inventory.reprice_snapshots),
      protected: asNumber(inventory.protected_snapshots),
      eligible: asNumber(inventory.eligible_snapshots),
    },
    payloads: {
      frozenBytes: asNumber(inventory.frozen_bytes),
      marketBytes: asNumber(inventory.market_bytes),
      distributionBytes: asNumber(inventory.distribution_bytes),
      eligibleBytesBeforeCompaction: asNumber(inventory.eligible_payload_bytes),
    },
    references: {
      bets: asNumber(references?.bets),
      directionResults: asNumber(references?.direction_results),
      directionSettlements: asNumber(references?.direction_settlements),
    },
  };
}
