import { neon } from '@neondatabase/serverless';
import { betPositionIdentity } from './bet-ledger.js';
import { isLeagueId } from './leagues.js';

const MAX_BETS = 500;
let sqlClient;
let schemaReady;

function sql() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
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
  await ensureSchema();
  const rows = await sql()`SELECT payload FROM baseball_private_bets ORDER BY placed_at DESC LIMIT ${MAX_BETS}`;
  return rows.map(row => row.payload).filter(Boolean);
}

export async function upsertCloudBet(value) {
  const bet = sanitizeCloudBet(value);
  if (!bet) throw new Error('下注紀錄格式不正確');
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
  await ensureSchema();
  await sql()`DELETE FROM baseball_private_bets WHERE position_key = ${cleanText(positionIdentity, 500)}`;
  return listCloudBets();
}

export async function clearCloudLeague(league) {
  const id = cleanText(league, 8).toUpperCase();
  if (!isLeagueId(id)) throw new Error('聯盟格式不正確');
  await ensureSchema();
  await sql()`DELETE FROM baseball_private_bets WHERE league = ${id}`;
  return listCloudBets();
}
