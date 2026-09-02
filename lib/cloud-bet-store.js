import { neon } from '@neondatabase/serverless';
import { betIdentity, betPositionIdentity, betPriceIdentity, canonicalBetPick } from './bet-ledger.js';
import { summarizeBetLedger } from './bet-stats.js';
import { isLeagueId, leagueConfig } from './leagues.js';
import { buildPitPredictionFromBetV109 } from './calibration-ledger-v109.js';
import { markDatabaseError } from './database-error.js';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';
import {
  buildPlacedClosingContractSnapshot,
  buildReaderClosingContractCandidate,
  calculateClosingContractMetrics,
  closingContractNeedsReplacement,
  closingMetricFailure,
} from './bet-closing-line-v1.js';
import { TAIWAN_CREDIT_REBATE_RATE } from './taiwan-settlement-v9.js';

const MAX_BETS = 5000;
const MAX_STAKE = 1_000_000_000;
const ALLOWED_STATUS = new Set(['OPEN', 'SETTLED', 'VOID', 'MANUAL_REVIEW', 'CANCELLED']);
let sqlClient;
let schemaReady;

export function databaseConfigured() {
  return durableDatabaseConfigured();
}

function requireDurableDatabase() {
  if (!databaseConfigured()) {
    throw new Error('永久下注帳本尚未設定 DATABASE_URL；已停止寫入，避免把 Runtime Cache 誤當永久資料庫');
  }
}

function sql() {
  if (!sqlClient) {
    const client = neon(durableDatabaseUrl());
    const query = async (...args) => {
      try { return await client(...args); }
      catch (error) { throw markDatabaseError(error, 'CLOUD_BET_SQL_FAILED'); }
    };
    query.transaction = async (...args) => {
      try { return await client.transaction(...args); }
      catch (error) { throw markDatabaseError(error, 'CLOUD_BET_TRANSACTION_FAILED'); }
    };
    sqlClient = query;
  }
  return sqlClient;
}

async function ensureSchema() {
  if (!schemaReady) schemaReady = (async () => {
    await sql()`
      CREATE TABLE IF NOT EXISTS baseball_private_bets (
        id TEXT PRIMARY KEY,
        position_key TEXT NOT NULL UNIQUE,
        league TEXT NOT NULL,
        placed_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql()`
      CREATE TABLE IF NOT EXISTS baseball_private_bets_v2 (
        id TEXT PRIMARY KEY,
        position_key TEXT NOT NULL,
        price_key TEXT NOT NULL,
        league TEXT NOT NULL,
        game_pk BIGINT NOT NULL,
        placed_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL DEFAULT 'OPEN',
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    const database = sql();
    await database`CREATE INDEX IF NOT EXISTS idx_baseball_private_bets_v2_league_placed ON baseball_private_bets_v2(league, placed_at DESC)`;
    await database`CREATE INDEX IF NOT EXISTS idx_baseball_private_bets_v2_status ON baseball_private_bets_v2(status, placed_at)`;
    await database`
      INSERT INTO baseball_private_bets_v2 (id, position_key, price_key, league, game_pk, placed_at, status, payload, updated_at)
      SELECT id,
             position_key,
             position_key || '|||legacy',
             league,
             COALESCE(NULLIF(payload->>'gamePk', '')::BIGINT, 0),
             placed_at,
             COALESCE(NULLIF(UPPER(payload->>'status'), ''), 'OPEN'),
             payload,
             updated_at
      FROM baseball_private_bets
      ON CONFLICT DO NOTHING
    `;
    const [migrationState] = await database`
      SELECT
        TO_REGCLASS('public.uq_baseball_private_bets_v2_position_key_v110') IS NOT NULL AS unique_ready,
        TO_REGCLASS('public.uq_baseball_private_bets_v2_active_position_v1172') IS NOT NULL AS active_unique_ready,
        TO_REGCLASS('public.baseball_private_bets_v2_position_quarantine') IS NOT NULL AS quarantine_ready
    `;
    if ((migrationState?.unique_ready !== true && migrationState?.active_unique_ready !== true)
      || migrationState?.quarantine_ready !== true) {
      await database.transaction(transaction => [
        transaction`LOCK TABLE baseball_private_bets_v2 IN SHARE ROW EXCLUSIVE MODE`,
        transaction`
          CREATE TABLE IF NOT EXISTS baseball_private_bets_v2_position_quarantine (
            id TEXT PRIMARY KEY,
            original_position_key TEXT NOT NULL,
            canonical_bet_id TEXT NOT NULL,
            reason TEXT NOT NULL,
            quarantined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            original_row JSONB NOT NULL
          )
        `,
        transaction`
          WITH ranked AS (
            SELECT bet.*,
                   ROW_NUMBER() OVER (
                     PARTITION BY position_key
                     ORDER BY placed_at ASC, updated_at ASC, id ASC
                   ) AS duplicate_rank,
                   FIRST_VALUE(id) OVER (
                     PARTITION BY position_key
                     ORDER BY placed_at ASC, updated_at ASC, id ASC
                   ) AS canonical_bet_id
            FROM baseball_private_bets_v2 AS bet
          )
          INSERT INTO baseball_private_bets_v2_position_quarantine (
            id, original_position_key, canonical_bet_id, reason, original_row
          )
          SELECT id,
                 position_key,
                 canonical_bet_id,
                 'DUPLICATE_POSITION_KEY_BEFORE_V110_UNIQUE_INDEX',
                 TO_JSONB(ranked) - 'duplicate_rank' - 'canonical_bet_id'
          FROM ranked
          WHERE duplicate_rank > 1
          ON CONFLICT (id) DO NOTHING
        `,
        transaction`
          WITH ranked AS (
            SELECT id,
                   position_key AS original_position_key,
                   status AS original_status,
                   ROW_NUMBER() OVER (
                     PARTITION BY position_key
                     ORDER BY placed_at ASC, updated_at ASC, id ASC
                   ) AS duplicate_rank,
                   FIRST_VALUE(id) OVER (
                     PARTITION BY position_key
                     ORDER BY placed_at ASC, updated_at ASC, id ASC
                   ) AS canonical_bet_id
            FROM baseball_private_bets_v2
          ), duplicates AS (
            SELECT id,
                   original_position_key,
                   original_status,
                   canonical_bet_id,
                   original_position_key
                     || '|||duplicate-quarantine-v110|||'
                     || ENCODE(CONVERT_TO(id, 'UTF8'), 'hex') AS quarantine_position_key
            FROM ranked
            WHERE duplicate_rank > 1
          )
          UPDATE baseball_private_bets_v2 AS bet
          SET position_key = duplicates.quarantine_position_key,
              status = 'MANUAL_REVIEW',
              payload = bet.payload || JSONB_BUILD_OBJECT(
                'positionIdentity', duplicates.quarantine_position_key,
                'originalPositionIdentity', duplicates.original_position_key,
                'status', 'MANUAL_REVIEW',
                'pitPrediction', NULL,
                'pitPredictionStatus', 'EXCLUDED_DUPLICATE_POSITION_QUARANTINE',
                'pitPredictionErrors', JSONB_BUILD_ARRAY('DUPLICATE_POSITION_KEY_BEFORE_V110_UNIQUE_INDEX'),
                'pitEvidenceVerified', FALSE,
                'calibrationEligibility', 'EXCLUDED_DUPLICATE_POSITION_QUARANTINE',
                'duplicateQuarantine', JSONB_BUILD_OBJECT(
                  'version', 'V11.0.0',
                  'reason', 'DUPLICATE_POSITION_KEY_BEFORE_V110_UNIQUE_INDEX',
                  'canonicalBetId', duplicates.canonical_bet_id,
                  'originalStatus', duplicates.original_status
                )
              ),
              updated_at = NOW()
          FROM duplicates
          WHERE bet.id = duplicates.id
        `,
        transaction`
          CREATE UNIQUE INDEX IF NOT EXISTS uq_baseball_private_bets_v2_position_key_v110
          ON baseball_private_bets_v2(position_key)
        `,
      ]);
    }
    const [activeUniquenessState] = await database`
      SELECT TO_REGCLASS('public.uq_baseball_private_bets_v2_active_position_v1172') IS NOT NULL AS ready
    `;
    if (activeUniquenessState?.ready !== true) {
      await database.transaction(transaction => [
        transaction`LOCK TABLE baseball_private_bets_v2 IN SHARE ROW EXCLUSIVE MODE`,
        transaction`
          CREATE UNIQUE INDEX IF NOT EXISTS uq_baseball_private_bets_v2_active_position_v1172
          ON baseball_private_bets_v2(position_key)
          WHERE status <> 'CANCELLED'
        `,
        transaction`DROP INDEX IF EXISTS uq_baseball_private_bets_v2_position_key_v110`,
      ]);
    }
  })().catch(error => { schemaReady = null; throw error; });
  await schemaReady;
}

function cleanText(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function sanitizeCloudBet(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const league = cleanText(value.league || 'MLB', 8).toUpperCase();
  const date = cleanText(value.date, 10);
  const gamePk = Number(value.gamePk);
  const market = cleanText(value.market, 30);
  const pick = cleanText(value.pick, 160);
  const placedAt = cleanText(value.placedAt, 40);
  const id = cleanText(value.id, 120);
  const water = finite(value.water);
  const stake = finite(value.stake);
  if (!id || !isLeagueId(league) || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isSafeInteger(gamePk) || gamePk <= 0 || !market || !pick || !Number.isFinite(Date.parse(placedAt))
    || water == null || water <= 0 || water > 5 || stake == null || stake <= 0 || stake > MAX_STAKE) return null;
  const statusCandidate = cleanText(value.status || 'OPEN', 30).toUpperCase();
  const status = ALLOWED_STATUS.has(statusCandidate) ? statusCandidate : 'OPEN';
  const rebateRate = Math.max(0, Math.min(0.1, finite(value.rebateRate, 0.015)));
  const bet = {
    ...value,
    id,
    league,
    date,
    gamePk,
    market,
    pick,
    water,
    stake,
    rebateRate,
    placedAt,
    status,
    score: value.scoreStatus === 'FORMAL_VALIDATED' && Number.isFinite(Number(value.score)) ? Number(value.score) : null,
    scoreStatus: cleanText(value.scoreStatus || 'LEGACY_INVALID', 40),
    betSource: cleanText(value.betSource || 'MANUAL', 40),
    canonicalPick: canonicalBetPick(pick),
  };
  bet.positionIdentity = betPositionIdentity(date, gamePk, bet, league);
  bet.priceIdentity = betPriceIdentity(date, gamePk, bet, league);
  if (Buffer.byteLength(JSON.stringify(bet), 'utf8') > 40_000) return null;
  return bet;
}

export function cloudBetLeagueCanWrite(value) {
  const league = cleanText(value, 8).toUpperCase();
  return isLeagueId(league) && leagueConfig(league).capabilities.bets === true;
}

export function cloudBetCandidateCanWrite(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && isLeagueId(cleanText(value.league, 8).toUpperCase())
    && cloudBetLeagueCanWrite(value.league));
}

function cloudBetMutationError(message, code, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

// The browser payload is only a request to record a verified position. Never
// spread it into the permanent ledger: every identity, contract, model metric,
// status and audit field below is rebuilt from server-verified Reader/PIT data.
export function buildServerVerifiedCloudBet(value, verification, {
  id = crypto.randomUUID(),
  placedAt = new Date().toISOString(),
} = {}) {
  const league = cleanText(value?.league, 8).toUpperCase();
  const date = cleanText(value?.date, 10);
  const officialGame = verification?.officialGame || {};
  const reader = verification?.reader || {};
  const pit = verification?.pitVerified === true ? verification.pit : null;
  const gamePk = Number(officialGame?.gamePk);
  const away = cleanText(officialGame?.away, 160);
  const home = cleanText(officialGame?.home, 160);
  const market = cleanText(reader?.market, 30);
  const pick = cleanText(reader?.pick, 160);
  const formulaDiagnosticScore = Number.isFinite(Number(pit?.formulaDiagnosticScore))
    ? Number(pit.formulaDiagnosticScore)
    : null;
  const shadowDiagnosticScore = Number.isFinite(Number(pit?.shadowDiagnosticScore))
    ? Number(pit.shadowDiagnosticScore)
    : null;
  const candidate = {
    id: cleanText(id, 120),
    identity: betIdentity(date, gamePk, { market, pick }, league),
    league,
    date,
    gamePk,
    gameNumber: Math.max(1, Number(officialGame?.gameNumber) || 1),
    officialDate: cleanText(officialGame?.officialDate, 20),
    matchup: away && home ? `${away} 對 ${home}` : '',
    gameDate: cleanText(officialGame?.gameDate, 40),
    away,
    home,
    market,
    pick,
    water: finite(reader?.water),
    stake: finite(value?.stake),
    unit: null,
    rebateRate: TAIWAN_CREDIT_REBATE_RATE,
    betSource: 'TAI888_READER_AUTO',
    analysisMode: 'SHADOW',
    score: null,
    scoreStatus: 'SHADOW_DIAGNOSTIC_NOT_FORMAL',
    formulaDiagnosticScore,
    shadowDiagnosticScore,
    legacyDiagnosticScore: null,
    weightedEV: finite(pit?.weightedEV),
    robustEV: finite(pit?.robustEV),
    rawModelWeightedEV: finite(pit?.weightedEV),
    rawModelRobustEV: finite(pit?.robustEV),
    qaStatus: cleanText(pit?.scoreStatus, 60) === 'BLOCKED' ? 'BLOCK' : 'SHADOW_DIAGNOSTIC',
    qa: null,
    placedContractSnapshot: {
      pick,
      water: finite(reader?.water),
      market,
      sourceType: 'ACTUAL_TW_CREDIT',
      provider: 'TAI888_READER_AUTO',
      lineAsOf: cleanText(reader?.lineAsOf, 40) || null,
    },
    lineAsOf: cleanText(reader?.lineAsOf, 40) || null,
    readerPayloadHash: cleanText(reader?.payloadHash, 64).toLowerCase() || null,
    rawBoardHash: cleanText(reader?.rawBoardHash, 64).toLowerCase() || null,
    readerRevision: cleanText(reader?.revision, 200) || null,
    readerGameMarketHash: cleanText(pit?.readerGameMarketHash, 64).toLowerCase() || null,
    serverEvidenceVersion: cleanText(verification?.version, 120) || null,
    serverEvidenceVerifiedAt: cleanText(verification?.verifiedAt, 40) || null,
    readerEvidenceStatus: reader?.captureFreshAtRecord === true
      ? 'SERVER_VERIFIED_CURRENT_READER'
      : 'SERVER_VERIFIED_CAPTURED_READER',
    pitSnapshotId: cleanText(pit?.snapshotId, 500) || null,
    snapshotId: cleanText(pit?.inputHash, 64).toLowerCase() || null,
    inputHash: cleanText(pit?.inputHash, 64).toLowerCase() || null,
    coreFingerprint: cleanText(pit?.coreFingerprint, 64).toLowerCase() || null,
    distributionHash: cleanText(pit?.distributionHash, 64).toLowerCase() || null,
    distributionId: cleanText(pit?.distributionId, 500) || null,
    analysisAsOf: cleanText(pit?.analysisAsOf, 40) || null,
    dataAsOf: cleanText(pit?.dataAsOf, 40) || null,
    featureObservedAts: pit?.featureObservedAts && typeof pit.featureObservedAts === 'object'
      && !Array.isArray(pit.featureObservedAts) ? pit.featureObservedAts : {},
    modelVersion: cleanText(pit?.modelVersion, 120) || null,
    scoreFormulaVersion: cleanText(pit?.scoreFormulaVersion, 120) || null,
    settlementRuleVersion: cleanText(pit?.settlementRuleVersion, 120) || null,
    pitEvidenceVerified: pit?.verified === true,
    calibrationEligibility: cleanText(verification?.calibrationEligibility, 120) || null,
    performanceEligibility: null,
    settlement: null,
    resultSnapshot: null,
    cancellation: null,
    cancelledAt: null,
    closingContractSnapshot: null,
    placedAt: cleanText(placedAt, 40),
    status: 'OPEN',
  };
  return sanitizeCloudBet(candidate);
}

// The database clock is authoritative for the first-pitch cutoff. The cutoff,
// partial unique-index conflict and insert outcome are decided in one statement
// so a slow schema check or network hop cannot write a post-start ticket.
export async function insertVerifiedCloudBetAtomically(bet, { database = null } = {}) {
  if (!bet || !Number.isFinite(Date.parse(String(bet.gameDate || '')))) {
    throw cloudBetMutationError('下注紀錄缺少有效官方開賽時間', 'BET_GAME_TIME_INVALID', 400);
  }
  const query = database || sql();
  const [outcome] = await query`
    WITH insertion_clock AS (
      SELECT NOW() AS checked_at
    ), inserted AS (
      INSERT INTO baseball_private_bets_v2 (id, position_key, price_key, league, game_pk, placed_at, status, payload)
      SELECT ${bet.id}, ${bet.positionIdentity}, ${bet.priceIdentity}, ${bet.league}, ${bet.gamePk}, ${bet.placedAt}, ${bet.status}, ${JSON.stringify(bet)}::jsonb
      FROM insertion_clock
      WHERE ${bet.gameDate}::timestamptz > insertion_clock.checked_at
      ON CONFLICT (position_key) WHERE status <> 'CANCELLED' DO NOTHING
      RETURNING id
    )
    SELECT EXISTS(SELECT 1 FROM inserted) AS created,
           (SELECT id FROM inserted LIMIT 1) AS id,
           ${bet.gameDate}::timestamptz > insertion_clock.checked_at AS prestart
    FROM insertion_clock
  `;
  if (!outcome) {
    throw cloudBetMutationError('永久下注帳本未回傳寫入結果', 'BET_INSERT_OUTCOME_MISSING', 503);
  }
  if (outcome.created !== true) {
    if (outcome.prestart !== true) {
      throw cloudBetMutationError('比賽已達官方開打時間，已停止寫入下注紀錄', 'BET_ALREADY_STARTED');
    }
    throw cloudBetMutationError('此方向已有未取消的下注紀錄，目前盤口未重複寫入', 'BET_POSITION_ALREADY_OPEN');
  }
  return { created: true, betId: cleanText(outcome.id || bet.id, 120) };
}

function trustedLedgerEvidence(bet) {
  return ['SERVER_VERIFIED_CURRENT_READER', 'SERVER_VERIFIED_CAPTURED_READER'].includes(bet?.readerEvidenceStatus)
    && bet?.pitEvidenceVerified === true
    && bet?.pitPredictionStatus === 'IMMUTABLE_PIT_VERIFIED';
}

function enforceTrustedLedgerEvidence(bet) {
  if (!bet || trustedLedgerEvidence(bet)) return bet;
  return {
    ...bet,
    status: 'MANUAL_REVIEW',
    settlement: null,
    score: null,
    scoreStatus: 'LEGACY_INVALID',
    betSource: 'LEGACY_UNVERIFIABLE_QUARANTINE',
    readerEvidenceStatus: 'EXCLUDED_UNVERIFIABLE_LEGACY',
    pitPrediction: null,
    pitPredictionStatus: bet?.pitPredictionStatus === 'EXCLUDED_DUPLICATE_POSITION_QUARANTINE'
      ? bet.pitPredictionStatus
      : 'EXCLUDED_UNVERIFIABLE_LEGACY',
    pitPredictionErrors: [...new Set([...(Array.isArray(bet?.pitPredictionErrors) ? bet.pitPredictionErrors : []), 'LEDGER_EVIDENCE_NOT_SERVER_VERIFIED'])],
    pitEvidenceVerified: false,
    calibrationEligibility: bet?.calibrationEligibility === 'EXCLUDED_DUPLICATE_POSITION_QUARANTINE'
      ? bet.calibrationEligibility
      : 'EXCLUDED_UNVERIFIABLE_LEGACY',
    performanceEligibility: 'EXCLUDED_UNVERIFIABLE_LEGACY',
  };
}

export async function listCloudBets() {
  requireDurableDatabase();
  await ensureSchema();
  const rows = await sql()`SELECT payload FROM baseball_private_bets_v2 ORDER BY placed_at DESC LIMIT ${MAX_BETS}`;
  return rows.map(row => sanitizeCloudBet(row.payload)).filter(Boolean).map(enforceTrustedLedgerEvidence);
}

export async function listCloudBetsByIds(values) {
  requireDurableDatabase();
  const ids = [...new Set((Array.isArray(values) ? values : [])
    .map(value => cleanText(value, 120))
    .filter(Boolean))].slice(0, 300);
  if (!ids.length) return [];
  await ensureSchema();
  const rows = await sql()`
    SELECT payload
    FROM baseball_private_bets_v2
    WHERE id = ANY(${ids}::text[])
    LIMIT 300
  `;
  return rows.map(row => sanitizeCloudBet(row.payload)).filter(Boolean).map(enforceTrustedLedgerEvidence);
}

export async function updateOpenCloudBetClosingSnapshots(readerSnapshot, {
  calculateMetrics = calculateClosingContractMetrics,
} = {}) {
  const league = cleanText(readerSnapshot?.league, 8).toUpperCase();
  const date = cleanText(readerSnapshot?.boardDate, 10);
  const gameIds = [...new Set((Array.isArray(readerSnapshot?.games) ? readerSnapshot.games : [])
    .map(row => Number(row?.gamePk || row?.game?.gamePk))
    .filter(value => Number.isSafeInteger(value) && value > 0))];
  if (!isLeagueId(league) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !gameIds.length) {
    return { configured: databaseConfigured(), checked: 0, updated: 0, skipped: 0, failed: 0 };
  }
  if (!databaseConfigured()) return { configured: false, checked: 0, updated: 0, skipped: 0, failed: 0 };
  await ensureSchema();
  const rows = await sql()`
    SELECT id, payload
    FROM baseball_private_bets_v2
    WHERE status = 'OPEN'
      AND league = ${league}
      AND game_pk = ANY(${gameIds}::bigint[])
      AND payload->>'date' = ${date}
    ORDER BY placed_at ASC
    LIMIT 500
  `;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    const bet = sanitizeCloudBet(row.payload);
    if (!bet || !trustedLedgerEvidence(bet)) {
      skipped += 1;
      continue;
    }
    const candidate = buildReaderClosingContractCandidate(bet, readerSnapshot);
    if (!closingContractNeedsReplacement(bet.closingContractSnapshot, candidate)) {
      skipped += 1;
      continue;
    }
    let metrics;
    try {
      metrics = await calculateMetrics(bet, candidate);
    } catch (error) {
      metrics = closingMetricFailure(error);
      failed += 1;
    }
    const closingContractSnapshot = { ...candidate, ...metrics };
    const result = await sql()`
      UPDATE baseball_private_bets_v2
      SET payload = payload || JSONB_BUILD_OBJECT(
            'closingContractSnapshot', ${JSON.stringify(closingContractSnapshot)}::jsonb
          ),
          updated_at = NOW()
      WHERE id = ${bet.id}
        AND status = 'OPEN'
        AND COALESCE(payload->'closingContractSnapshot'->>'lineAsOf', '') <= ${closingContractSnapshot.lineAsOf}
      RETURNING id
    `;
    if (result.length) updated += 1;
    else skipped += 1;
  }
  return { configured: true, checked: rows.length, updated, skipped, failed };
}

export async function upsertCloudBet(value, { verification = null } = {}) {
  if (!value?.league || !isLeagueId(cleanText(value.league, 8).toUpperCase())) {
    throw new Error('新增下注紀錄必須明確提供有效聯盟');
  }
  requireDurableDatabase();
  if (verification?.readerVerified !== true) throw new Error('下注紀錄缺少伺服器Reader即時驗證');
  if (verification?.pitVerified !== true) throw new Error('下注紀錄缺少同場最新不可變PIT驗證');
  const pit = verification?.pitVerified === true ? verification.pit : null;
  let bet = buildServerVerifiedCloudBet(value, verification);
  if (!bet) throw new Error('伺服器驗證後的下注紀錄格式不正確');
  const prediction = buildPitPredictionFromBetV109(bet);
  if (!prediction.ok) {
    throw new Error(`不可變PIT校準證據不完整：${prediction.errors.join('；') || 'PIT_PREDICTION_INVALID'}`);
  }
  bet = {
    ...bet,
    pitPrediction: prediction.prediction,
    pitPredictionStatus: 'IMMUTABLE_PIT_VERIFIED',
    pitPredictionErrors: prediction.errors,
  };
  bet = sanitizeCloudBet({
    ...bet,
    closingContractSnapshot: buildPlacedClosingContractSnapshot(bet, {
      metricStatus: 'CALCULATED',
      formulaDiagnosticScore: pit?.formulaDiagnosticScore,
      shadowDiagnosticScore: pit?.shadowDiagnosticScore,
      weightedEV: pit?.weightedEV,
      robustEV: pit?.robustEV,
      scoreStatus: pit?.scoreStatus,
      modelVersion: pit?.modelVersion,
      scoreFormulaVersion: pit?.scoreFormulaVersion,
      distributionHash: pit?.distributionHash,
      distributionId: pit?.distributionId,
      readerGameMarketHash: pit?.readerGameMarketHash,
    }),
  });
  if (!bet) throw new Error('下注時與開賽前最後盤初始快照格式不正確');
  if (!cloudBetLeagueCanWrite(bet.league)) throw new Error(`${bet.league} 目前不可寫入實際下注紀錄`);
  await ensureSchema();
  const insertion = await insertVerifiedCloudBetAtomically(bet);
  return {
    bets: await listCloudBets(),
    created: insertion.created,
    betId: insertion.betId,
  };
}

export async function mergeCloudBets(values) {
  const bets = (Array.isArray(values) ? values : []).slice(0, MAX_BETS)
    .map(value => value && typeof value === 'object' && !Array.isArray(value) && !value.league
      ? { ...value, league: 'MLB' }
      : value)
    .filter(cloudBetCandidateCanWrite)
    .map(sanitizeCloudBet)
    .filter(bet => bet && cloudBetLeagueCanWrite(bet.league));
  requireDurableDatabase();
  await ensureSchema();
  for (const source of bets) {
    const bet = {
      ...source,
      status: 'MANUAL_REVIEW',
      settlement: null,
      score: null,
      scoreStatus: 'LEGACY_INVALID',
      betSource: 'LEGACY_LOCAL_QUARANTINE',
      readerEvidenceStatus: 'EXCLUDED_UNVERIFIABLE_LEGACY',
      pitPrediction: null,
      pitPredictionStatus: 'EXCLUDED_UNVERIFIABLE_LEGACY',
      pitPredictionErrors: ['LEGACY_MERGE_NOT_SERVER_VERIFIED'],
      pitEvidenceVerified: false,
      calibrationEligibility: 'EXCLUDED_UNVERIFIABLE_LEGACY',
      performanceEligibility: 'EXCLUDED_UNVERIFIABLE_LEGACY',
    };
    await sql()`
      INSERT INTO baseball_private_bets_v2 (id, position_key, price_key, league, game_pk, placed_at, status, payload)
      VALUES (${bet.id}, ${bet.positionIdentity}, ${bet.priceIdentity}, ${bet.league}, ${bet.gamePk}, ${bet.placedAt}, ${bet.status}, ${JSON.stringify(bet)}::jsonb)
      ON CONFLICT DO NOTHING
    `;
  }
  return listCloudBets();
}

export async function deleteCloudBet() {
  throw new Error('永久下注帳本禁止硬刪除；請新增 VOID 或更正事件');
}

export async function clearCloudLeague() {
  throw new Error('永久下注帳本禁止清空聯盟紀錄');
}

export async function cancelOpenCloudBetAtomically(value, { database = sql() } = {}) {
  const id = cleanText(value, 120);
  if (!id) {
    const error = new Error('缺少有效下注編號');
    error.code = 'INVALID_BET_ID';
    error.status = 400;
    throw error;
  }
  const updated = await database`
    UPDATE baseball_private_bets_v2
    SET status = 'CANCELLED',
        payload = payload || JSONB_BUILD_OBJECT(
          'status', 'CANCELLED',
          'settlement', NULL,
          'cancelledAt', TO_JSONB(NOW()),
          'cancellation', JSONB_BUILD_OBJECT(
            'type', 'USER_CANCELLED_PRESTART',
            'cancelledAt', TO_JSONB(NOW())
          )
        ),
        updated_at = NOW()
    WHERE id = ${id}
      AND status = 'OPEN'
      AND NULLIF(payload->>'gameDate', '')::timestamptz > NOW()
    RETURNING id
  `;
  if (updated.length) return { cancelled: true, betId: updated[0]?.id || id };

  const [row] = await database`
    SELECT status
    FROM baseball_private_bets_v2
    WHERE id = ${id}
    LIMIT 1
  `;
  if (!row) {
    const error = new Error('找不到這筆下注紀錄');
    error.code = 'BET_NOT_FOUND';
    error.status = 404;
    throw error;
  }
  if (String(row.status || '').toUpperCase() !== 'OPEN') {
    const error = new Error(String(row.status || '').toUpperCase() === 'CANCELLED' ? '這筆下注已取消' : '只有尚未結算的下注可以取消');
    error.code = 'BET_NOT_OPEN';
    error.status = 409;
    throw error;
  }
  const error = new Error('比賽已達官方開打時間，不能取消下注紀錄');
  error.code = 'BET_ALREADY_STARTED';
  error.status = 409;
  throw error;
}

export async function cancelOpenCloudBet(value) {
  requireDurableDatabase();
  await ensureSchema();
  await cancelOpenCloudBetAtomically(value);
  return listCloudBets();
}

async function persistBetUpdates(values) {
  const bets = values.map(sanitizeCloudBet).filter(Boolean);
  requireDurableDatabase();
  await ensureSchema();
  for (const bet of bets) {
    await sql()`
      UPDATE baseball_private_bets_v2
      SET status = ${bet.status}, payload = ${JSON.stringify(bet)}::jsonb, updated_at = NOW()
      WHERE id = ${bet.id} AND status = 'OPEN'
    `;
  }
  return listCloudBets();
}

export async function settleOpenCloudBets({ league = '', limit = 500 } = {}) {
  const id = cleanText(league, 8).toUpperCase();
  if (id && !isLeagueId(id)) throw new Error('聯盟格式不正確');
  const current = await listCloudBets();
  const cap = Math.max(1, Math.min(500, Number(limit) || 500));
  const candidates = current
    .filter(bet => bet.status === 'OPEN' && (!id || bet.league === id))
    .sort((left, right) => Date.parse(left?.placedAt || 0) - Date.parse(right?.placedAt || 0))
    .slice(0, cap);
  if (!candidates.length) return current;
  const { settleBetTickets } = await import('./bet-settlement-service.js');
  const updates = await settleBetTickets(candidates, { concurrency: 4 });
  const runSummary = updates.reduce((summary, bet) => {
    const status = cleanText(bet?.status || 'UNKNOWN', 30).toUpperCase();
    summary.statuses[status] = (summary.statuses[status] || 0) + 1;
    if (bet?.lastResultError) {
      const message = cleanText(bet.lastResultError, 180);
      summary.resultErrors[message] = (summary.resultErrors[message] || 0) + 1;
    }
    return summary;
  }, {
    candidateTickets: candidates.length,
    uniqueGames: new Set(candidates.map(bet => `${bet.league}|||${bet.gamePk}|||${bet.officialDate || ''}`)).size,
    statuses: {},
    resultErrors: {},
  });
  const unresolvedGames = new Map();
  for (const bet of updates) {
    if (cleanText(bet?.status, 30).toUpperCase() !== 'OPEN') continue;
    const key = `${bet.league}|||${bet.gamePk}|||${bet.officialDate || ''}`;
    if (unresolvedGames.has(key)) continue;
    unresolvedGames.set(key, {
      league: bet.league,
      gamePk: bet.gamePk,
      officialDate: bet.officialDate || '',
      error: cleanText(bet.lastResultError, 180) || null,
      providerGameId: cleanText(bet.resultSnapshot?.providerGameId, 80) || null,
      providerStatus: cleanText(bet.resultSnapshot?.statusEnglish || bet.resultSnapshot?.status, 80) || null,
      final: bet.resultSnapshot?.final === true,
    });
  }
  runSummary.unresolvedGames = [...unresolvedGames.values()].slice(0, 50);
  console.info('[BET_SETTLEMENT_RUN]', runSummary);
  return persistBetUpdates(updates);
}

export function cloudBetStats(values) {
  return summarizeBetLedger((Array.isArray(values) ? values : []).map(enforceTrustedLedgerEvidence));
}
