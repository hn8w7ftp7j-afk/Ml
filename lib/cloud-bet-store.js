import { neon } from '@neondatabase/serverless';
import { betPositionIdentity } from './bet-ledger.js';
import { isLeagueId } from './leagues.js';

const MAX_BETS = 500;
const CACHE_KEY = 'baseball-private-bets:v1';
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 365;
let sqlClient;
let schemaReady;

function databaseConfigured() {
  return Boolean(String(process.env.DATABASE_URL || '').trim());
}

async function runtimeCache() {
  try {
    const module = await import('@vercel/functions');
    return module.getCache();
  } catch { return null; }
}

async function readCachedBets() {
  const cache = await runtimeCache();
  if (!cache) throw new Error('雲端下注儲存目前無法使用');
  const stored = await cache.get(CACHE_KEY);
  return (Array.isArray(stored?.bets) ? stored.bets : []).map(sanitizeCloudBet).filter(Boolean).slice(0, MAX_BETS);
}

async function writeCachedBets(bets) {
  const cache = await runtimeCache();
  if (!cache) throw new Error('雲端下注儲存目前無法使用');
  const next = bets.map(sanitizeCloudBet).filter(Boolean).sort((a, b) => Date.parse(b.placedAt) - Date.parse(a.placedAt)).slice(0, MAX_BETS);
  await cache.set(CACHE_KEY, { bets: next, updatedAt: new Date().toISOString() }, {
    ttl: CACHE_TTL_SECONDS,
    tags: ['baseball-private-bets'],
    name: 'Private baseball bet ledger',
  });
  return next;
}

function sql() {
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

async function ensureSchema() {
  if (!schemaReady) schemaReady = sql()`
    CREATE TABLE IF NOT EXISTS baseball_private_bets (
      id TEXT PRIMARY KEY,
      position_key TEXT NOT NULL UNIQUE,
      league TEXT NOT NULL,
      placed_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `.catch(error => { schemaReady = null; throw error; });
  await schemaReady;
}

function cleanText(value, max = 500) {
  return String(value || '').trim().slice(0, max);
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
  if (!id || !isLeagueId(league) || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(gamePk) || !market || !pick || !Number.isFinite(Date.parse(placedAt))) return null;
  const bet = { ...value, id, league, date, gamePk, market, pick, placedAt };
  if (Buffer.byteLength(JSON.stringify(bet), 'utf8') > 20_000) return null;
  bet.positionIdentity = betPositionIdentity(date, gamePk, bet, league);
  return bet;
}

export async function listCloudBets() {
  if (!databaseConfigured()) return readCachedBets();
  await ensureSchema();
  const rows = await sql()`SELECT payload FROM baseball_private_bets ORDER BY placed_at DESC LIMIT ${MAX_BETS}`;
  return rows.map(row => row.payload).filter(Boolean);
}

export async function upsertCloudBet(value) {
  const bet = sanitizeCloudBet(value);
  if (!bet) throw new Error('下注紀錄格式不正確');
  if (!databaseConfigured()) {
    const current = await readCachedBets();
    return writeCachedBets(current.some(item => item.positionIdentity === bet.positionIdentity) ? current : [bet, ...current]);
  }
  await ensureSchema();
  await sql()`
    INSERT INTO baseball_private_bets (id, position_key, league, placed_at, payload)
    VALUES (${bet.id}, ${bet.positionIdentity}, ${bet.league}, ${bet.placedAt}, ${JSON.stringify(bet)}::jsonb)
    ON CONFLICT (position_key) DO NOTHING
  `;
  return listCloudBets();
}

export async function mergeCloudBets(values) {
  const bets = (Array.isArray(values) ? values : []).slice(0, MAX_BETS).map(sanitizeCloudBet).filter(Boolean);
  if (!databaseConfigured()) {
    const current = await readCachedBets();
    const known = new Set(current.map(item => item.positionIdentity));
    return writeCachedBets([...current, ...bets.filter(item => !known.has(item.positionIdentity))]);
  }
  await ensureSchema();
  for (const bet of bets) {
    await sql()`
      INSERT INTO baseball_private_bets (id, position_key, league, placed_at, payload)
      VALUES (${bet.id}, ${bet.positionIdentity}, ${bet.league}, ${bet.placedAt}, ${JSON.stringify(bet)}::jsonb)
      ON CONFLICT (position_key) DO NOTHING
    `;
  }
  return listCloudBets();
}

export async function deleteCloudBet(positionIdentity) {
  if (!databaseConfigured()) return writeCachedBets((await readCachedBets()).filter(item => item.positionIdentity !== cleanText(positionIdentity, 500)));
  await ensureSchema();
  await sql()`DELETE FROM baseball_private_bets WHERE position_key = ${cleanText(positionIdentity, 500)}`;
  return listCloudBets();
}

export async function clearCloudLeague(league) {
  const id = cleanText(league, 8).toUpperCase();
  if (!isLeagueId(id)) throw new Error('聯盟格式不正確');
  if (!databaseConfigured()) return writeCachedBets((await readCachedBets()).filter(item => item.league !== id));
  await ensureSchema();
  await sql()`DELETE FROM baseball_private_bets WHERE league = ${id}`;
  return listCloudBets();
}
