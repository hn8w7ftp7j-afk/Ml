import { neon } from '@neondatabase/serverless';
import { betPositionIdentity, betPriceIdentity, canonicalBetPick } from './bet-ledger.js';
import { summarizeBetLedger } from './bet-stats.js';
import { isLeagueId, leagueConfig } from './leagues.js';

const MAX_BETS = 5000;
const CACHE_KEY = 'baseball-private-bets:v2';
const LEGACY_CACHE_KEY = 'baseball-private-bets:v1';
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 365;
const ALLOWED_STATUS = new Set(['OPEN', 'SETTLED', 'VOID', 'MANUAL_REVIEW', 'CANCELLED']);
let sqlClient;
let schemaReady;

export function databaseConfigured() {
  return Boolean(String(process.env.DATABASE_URL || '').trim());
}

function requireDurableDatabase() {
  if (!databaseConfigured()) {
    throw new Error('永久下注帳本尚未設定 DATABASE_URL；已停止寫入，避免把 Runtime Cache 誤當永久資料庫');
  }
}

async function runtimeCache() {
  try {
    const module = await import('@vercel/functions');
    return module.getCache();
  } catch { return null; }
}

function sortBets(values) {
  return values.sort((left, right) => Date.parse(right?.placedAt || 0) - Date.parse(left?.placedAt || 0));
}

async function readCachedBets() {
  const cache = await runtimeCache();
  if (!cache) throw new Error('雲端下注儲存目前無法使用');
  const current = await cache.get(CACHE_KEY);
  const legacy = current?.bets ? null : await cache.get(LEGACY_CACHE_KEY);
  return sortBets((Array.isArray(current?.bets) ? current.bets : Array.isArray(legacy?.bets) ? legacy.bets : [])
    .map(sanitizeCloudBet).filter(Boolean).slice(0, MAX_BETS));
}

async function writeCachedBets(bets) {
  const cache = await runtimeCache();
  if (!cache) throw new Error('雲端下注儲存目前無法使用');
  const next = sortBets(bets.map(sanitizeCloudBet).filter(Boolean)).slice(0, MAX_BETS);
  await cache.set(CACHE_KEY, { bets: next, updatedAt: new Date().toISOString() }, {
    ttl: CACHE_TTL_SECONDS,
    tags: ['baseball-private-bets-v2'],
    name: 'Private baseball immutable bet ledger',
  });
  return next;
}

function sql() {
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
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
    await sql()`CREATE INDEX IF NOT EXISTS idx_baseball_private_bets_v2_league_placed ON baseball_private_bets_v2(league, placed_at DESC)`;
    await sql()`CREATE INDEX IF NOT EXISTS idx_baseball_private_bets_v2_status ON baseball_private_bets_v2(status, placed_at)`;
    await sql()`
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
      ON CONFLICT (id) DO NOTHING
    `;
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

export async function listCloudBets() {
  if (!databaseConfigured()) return readCachedBets();
  await ensureSchema();
  const rows = await sql()`SELECT payload FROM baseball_private_bets_v2 ORDER BY placed_at DESC LIMIT ${MAX_BETS}`;
  return rows.map(row => sanitizeCloudBet(row.payload)).filter(Boolean);
}

export async function upsertCloudBet(value) {
  if (!value?.league || !isLeagueId(cleanText(value.league, 8).toUpperCase())) {
    throw new Error('新增下注紀錄必須明確提供有效聯盟');
  }
  requireDurableDatabase();
  const bet = sanitizeCloudBet({
    ...value,
    id: crypto.randomUUID(),
    placedAt: new Date().toISOString(),
    status: 'OPEN',
  });
  if (!bet) throw new Error('下注紀錄格式不正確');
  if (!cloudBetLeagueCanWrite(bet.league)) throw new Error(`${bet.league} 目前不可寫入實際下注紀錄`);
  await ensureSchema();
  const duplicate = await sql()`SELECT id FROM baseball_private_bets_v2 WHERE price_key = ${bet.priceIdentity} LIMIT 1`;
  if (duplicate.length) return listCloudBets();
  await sql()`
    INSERT INTO baseball_private_bets_v2 (id, position_key, price_key, league, game_pk, placed_at, status, payload)
    VALUES (${bet.id}, ${bet.positionIdentity}, ${bet.priceIdentity}, ${bet.league}, ${bet.gamePk}, ${bet.placedAt}, ${bet.status}, ${JSON.stringify(bet)}::jsonb)
    ON CONFLICT (id) DO NOTHING
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
  for (const bet of bets) {
    const duplicate = await sql()`SELECT id FROM baseball_private_bets_v2 WHERE id = ${bet.id} OR price_key = ${bet.priceIdentity} LIMIT 1`;
    if (duplicate.length) continue;
    await sql()`
      INSERT INTO baseball_private_bets_v2 (id, position_key, price_key, league, game_pk, placed_at, status, payload)
      VALUES (${bet.id}, ${bet.positionIdentity}, ${bet.priceIdentity}, ${bet.league}, ${bet.gamePk}, ${bet.placedAt}, ${bet.status}, ${JSON.stringify(bet)}::jsonb)
      ON CONFLICT (id) DO NOTHING
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
  return summarizeBetLedger(values);
}
