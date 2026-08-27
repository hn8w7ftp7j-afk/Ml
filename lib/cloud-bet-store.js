import { neon } from '@neondatabase/serverless';
import { betPositionIdentity, betPriceIdentity, canonicalBetPick } from './bet-ledger.js';
import { summarizeBetLedger } from './bet-stats.js';
import { isLeagueId, leagueConfig } from './leagues.js';
import { buildPitPredictionFromBetV109 } from './calibration-ledger-v109.js';
import { markDatabaseError } from './database-error.js';
import { durableDatabaseConfigured, durableDatabaseUrl } from './database-url.js';

const MAX_BETS = 5000;
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
        TO_REGCLASS('public.baseball_private_bets_v2_position_quarantine') IS NOT NULL AS quarantine_ready
    `;
    if (migrationState?.unique_ready !== true || migrationState?.quarantine_ready !== true) {
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
    || water == null || water <= 0 || water > 5 || stake == null || stake <= 0) return null;
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

function trustedLedgerEvidence(bet) {
  return bet?.readerEvidenceStatus === 'SERVER_VERIFIED_CURRENT_READER'
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

export async function upsertCloudBet(value, { verification = null } = {}) {
  if (!value?.league || !isLeagueId(cleanText(value.league, 8).toUpperCase())) {
    throw new Error('新增下注紀錄必須明確提供有效聯盟');
  }
  requireDurableDatabase();
  let bet = sanitizeCloudBet({
    ...value,
    id: crypto.randomUUID(),
    placedAt: new Date().toISOString(),
    status: 'OPEN',
  });
  if (!bet) throw new Error('下注紀錄格式不正確');
  if (verification?.readerVerified !== true) throw new Error('下注紀錄缺少伺服器Reader即時驗證');
  if (verification?.pitVerified !== true) throw new Error('下注紀錄缺少同場最新不可變PIT驗證');
  const pit = verification?.pitVerified === true ? verification.pit : null;
  bet = sanitizeCloudBet({
    ...bet,
    gameDate: verification?.officialGame?.gameDate || bet.gameDate,
    officialDate: verification?.officialGame?.officialDate || bet.officialDate,
    gameNumber: verification?.officialGame?.gameNumber || bet.gameNumber,
    away: verification?.officialGame?.away || bet.away,
    home: verification?.officialGame?.home || bet.home,
    market: verification.reader.market,
    pick: verification.reader.pick,
    water: verification.reader.water,
    lineAsOf: verification.reader.lineAsOf,
    readerPayloadHash: verification.reader.payloadHash,
    rawBoardHash: verification.reader.rawBoardHash,
    readerRevision: verification.reader.revision,
    betSource: 'TAI888_READER_AUTO',
    serverEvidenceVersion: verification.version,
    serverEvidenceVerifiedAt: verification.verifiedAt,
    readerEvidenceStatus: 'SERVER_VERIFIED_CURRENT_READER',
    pitSnapshotId: pit?.snapshotId || null,
    snapshotId: pit?.inputHash || null,
    inputHash: pit?.inputHash || null,
    coreFingerprint: pit?.coreFingerprint || null,
    distributionHash: pit?.distributionHash || null,
    distributionId: pit?.distributionId || null,
    analysisAsOf: pit?.analysisAsOf || null,
    dataAsOf: pit?.dataAsOf || null,
    weightedEV: pit?.weightedEV ?? null,
    robustEV: pit?.robustEV ?? null,
    rawModelWeightedEV: pit?.weightedEV ?? null,
    rawModelRobustEV: pit?.robustEV ?? null,
    featureObservedAts: pit?.featureObservedAts || {},
    modelVersion: pit?.modelVersion || null,
    scoreFormulaVersion: pit?.scoreFormulaVersion || null,
    settlementRuleVersion: pit?.settlementRuleVersion || null,
    pitEvidenceVerified: Boolean(pit),
    calibrationEligibility: verification.calibrationEligibility,
  });
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
  if (!cloudBetLeagueCanWrite(bet.league)) throw new Error(`${bet.league} 目前不可寫入實際下注紀錄`);
  if (Date.now() >= Date.parse(verification?.officialGame?.gameDate || '')) {
    throw new Error('PIT驗證完成後比賽已達官方開打時間，已停止寫入下注紀錄');
  }
  await ensureSchema();
  await sql()`
    INSERT INTO baseball_private_bets_v2 (id, position_key, price_key, league, game_pk, placed_at, status, payload)
    VALUES (${bet.id}, ${bet.positionIdentity}, ${bet.priceIdentity}, ${bet.league}, ${bet.gamePk}, ${bet.placedAt}, ${bet.status}, ${JSON.stringify(bet)}::jsonb)
    ON CONFLICT (position_key) DO NOTHING
  `;
  return listCloudBets();
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

async function persistBetUpdates(values) {
  const bets = values.map(sanitizeCloudBet).filter(Boolean);
  requireDurableDatabase();
  await ensureSchema();
  for (const bet of bets) {
    await sql()`
      UPDATE baseball_private_bets_v2
      SET status = ${bet.status}, payload = ${JSON.stringify(bet)}::jsonb, updated_at = NOW()
      WHERE id = ${bet.id}
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
  const { settleBetTicket } = await import('./bet-settlement-service.js');
  const updates = [];
  for (let index = 0; index < candidates.length; index += 4) {
    const group = candidates.slice(index, index + 4);
    const settled = await Promise.all(group.map(settleBetTicket));
    updates.push(...settled.filter(Boolean));
  }
  return persistBetUpdates(updates);
}

export function cloudBetStats(values) {
  return summarizeBetLedger((Array.isArray(values) ? values : []).map(enforceTrustedLedgerEvidence));
}
