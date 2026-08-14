import { taipeiBoardDate } from './official-schedule-v1.js';

export const MARKET_INTEGRITY_VERSION = 'MARKET-HMAC-SHA256-v1.0.0';
export const SNAPSHOT_INTEGRITY_VERSION = 'REPRICE-SNAPSHOT-HMAC-SHA256-v1.0.0';
const encoder = new TextEncoder();
const PROTECTED_SOURCE_TYPES = new Set(['ACTUAL_TW_CREDIT', 'REFERENCE', 'INTERNATIONAL']);
const SERVER_PROVIDERS = new Set([
  'TAI888_READER_AUTO',
  'TAI888_READ_ONLY_CREDIT',
  'JBOT_TAIWAN_SPORTS_LOTTERY',
  'THE_ODDS_API_CONSENSUS',
]);
const MANUAL_SOURCE_LABELS = new Set(['我的Tai888盤口文字', '我的信用盤截圖', '使用者手動輸入盤口']);

function integrityError(message, status = 409, code = 'MARKET_INTEGRITY_REJECTED') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function secret(env = process.env) {
  return String(env.MARKET_INTEGRITY_SECRET || env.SESSION_SECRET || '');
}

export function marketIntegrityConfigured(env = process.env) {
  return Boolean(secret(env).trim());
}

function canonical(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(item => canonical(item) ?? null);
  if (value && typeof value === 'object') {
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const item = canonical(value[key]);
      if (item !== undefined) result[key] = item;
    }
    return result;
  }
  return String(value);
}

export function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function base64url(bytes) {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

async function hmac(value, env = process.env) {
  const configured = secret(env);
  if (!configured.trim()) {
    throw integrityError('MARKET_INTEGRITY_SECRET 或 SESSION_SECRET 尚未設定', 503, 'MARKET_INTEGRITY_NOT_CONFIGURED');
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(configured), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function constantTimeStringEqual(left, right) {
  const a = encoder.encode(String(left || ''));
  const b = encoder.encode(String(right || ''));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export function canonicalGameIdentity(game) {
  const timestamp = Date.parse(game?.gameDate || '');
  return {
    gamePk: Number(game?.gamePk) || null,
    awayTeamId: Number(game?.awayTeamId) || null,
    homeTeamId: Number(game?.homeTeamId) || null,
    taipeiDate: Number.isFinite(timestamp) ? taipeiBoardDate(timestamp) : '',
    gameNumber: Math.max(1, Number(game?.gameNumber) || 1),
    scheduledStart: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '',
  };
}

function marketContract(row) {
  return {
    market: String(row?.market || ''),
    pick: String(row?.pick || ''),
    water: row?.water == null ? null : Number(row.water),
    waterEstimated: row?.waterEstimated === true,
    waterMissing: row?.waterMissing === true,
    confidence: Number.isFinite(Number(row?.confidence)) ? Number(row.confidence) : null,
    sourceType: String(row?.sourceType || ''),
    sourceLabel: String(row?.sourceLabel || ''),
    provider: String(row?.provider || ''),
    providerEventId: String(row?.providerEventId || ''),
    lineAsOf: String(row?.lineAsOf || ''),
    executable: row?.executable === true,
    rawDecimalOdds: row?.rawDecimalOdds == null ? null : Number(row.rawDecimalOdds),
    referenceSide: String(row?.referenceSide || ''),
    rawText: String(row?.rawText || ''),
    sourceTemplateVersion: String(row?.sourceTemplateVersion || ''),
    authorizationStatus: String(row?.authorizationStatus || ''),
    integrityOrigin: String(row?.integrityOrigin || ''),
  };
}

function marketMessage(game, row) {
  return stableJson({
    domain: 'mlb-positive-ev/market',
    version: MARKET_INTEGRITY_VERSION,
    game: canonicalGameIdentity(game),
    market: marketContract(row),
  });
}

export async function signMarketRow(game, row, env = process.env) {
  const signature = await hmac(marketMessage(game, row), env);
  return { ...row, marketSignatureVersion: MARKET_INTEGRITY_VERSION, marketSignature: signature };
}

export async function verifyMarketRow(game, row, env = process.env) {
  if (row?.marketSignatureVersion !== MARKET_INTEGRITY_VERSION || !row?.marketSignature) return false;
  const expected = await hmac(marketMessage(game, row), env);
  return constantTimeStringEqual(row.marketSignature, expected);
}

export async function signMarketRows(game, rows, env = process.env) {
  return Promise.all((Array.isArray(rows) ? rows : []).map(row => signMarketRow(game, row, env)));
}

export async function signMarketGames(games, env = process.env) {
  return Promise.all((Array.isArray(games) ? games : []).map(async row => ({
    ...row,
    gamePk: Number(row?.game?.gamePk || row?.gamePk) || null,
    markets: await signMarketRows(row?.game, row?.markets, env),
  })));
}

function isManualCandidate(row) {
  const sourceType = String(row?.sourceType || '').toUpperCase();
  const provider = String(row?.provider || '').toUpperCase();
  return sourceType === 'USER_MANUAL_ENTRY'
    || ((sourceType === 'ACTUAL_TW_CREDIT' || sourceType === 'ESTIMATED') && (!provider || provider === 'USER_MANUAL_ENTRY'));
}

function protectedClaim(row) {
  const sourceType = String(row?.sourceType || '').toUpperCase();
  const provider = String(row?.provider || '').toUpperCase();
  return PROTECTED_SOURCE_TYPES.has(sourceType) || SERVER_PROVIDERS.has(provider);
}

function normalizeManualRow(row) {
  const requestedLabel = String(row?.sourceLabel || '').trim();
  return {
    ...row,
    sourceType: row?.waterEstimated === true ? 'ESTIMATED' : 'ACTUAL_TW_CREDIT',
    sourceLabel: MANUAL_SOURCE_LABELS.has(requestedLabel) ? requestedLabel : '使用者手動輸入盤口',
    provider: 'USER_MANUAL_ENTRY',
    integrityOrigin: 'USER_MANUAL_ENTRY',
    authorizationStatus: 'USER_CONFIRMED_MANUAL',
  };
}

export async function attestIncomingMarketRows(game, rows, env = process.env) {
  const result = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.marketSignature) {
      if (!(await verifyMarketRow(game, row, env))) {
        throw integrityError('盤口簽章無效或盤口內容已被修改');
      }
      result.push(row);
      continue;
    }
    if (isManualCandidate(row)) {
      result.push(await signMarketRow(game, normalizeManualRow(row), env));
      continue;
    }
    if (protectedClaim(row)) {
      throw integrityError('Reader／信用盤／參考盤缺少伺服器簽章');
    }
    throw integrityError('盤口來源未受允許；手動盤口必須使用 USER_MANUAL_ENTRY');
  }
  return result;
}

function unsignedSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  const { snapshotSignature: omittedSignature, snapshotSignatureVersion: omittedVersion, ...rest } = snapshot;
  return rest;
}

function snapshotMessage(game, snapshot) {
  return stableJson({
    domain: 'mlb-positive-ev/reprice-snapshot',
    version: SNAPSHOT_INTEGRITY_VERSION,
    game: canonicalGameIdentity(game),
    snapshot: unsignedSnapshot(snapshot),
  });
}

export async function signRepriceSnapshot(game, snapshot, env = process.env) {
  const cleanSnapshot = unsignedSnapshot(snapshot);
  const signature = await hmac(snapshotMessage(game, cleanSnapshot), env);
  return { ...cleanSnapshot, snapshotSignatureVersion: SNAPSHOT_INTEGRITY_VERSION, snapshotSignature: signature };
}

export async function verifyRepriceSnapshot(game, snapshot, env = process.env) {
  if (snapshot?.snapshotSignatureVersion !== SNAPSHOT_INTEGRITY_VERSION || !snapshot?.snapshotSignature) return false;
  const expected = await hmac(snapshotMessage(game, snapshot), env);
  return constantTimeStringEqual(snapshot.snapshotSignature, expected);
}
