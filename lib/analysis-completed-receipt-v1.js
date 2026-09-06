import { analysisHasCalculatedDirections } from './analysis-display-state-v116.js';

export const ANALYSIS_COMPLETED_RECEIPT_VERSION = 1;
export const ANALYSIS_COMPLETED_RECEIPT_STORAGE_KEY = 'sports-positive-ev-completed-analysis-v1';
const DEFAULT_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const EVIDENCE_VERSION = 1;
const normalizeLeague = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(value.trim()) ? value.trim().toUpperCase() : null;
const runIdentity = value => typeof value === 'string' && /^[a-zA-Z0-9_:-]{1,300}$/.test(value.trim()) ? value.trim() : null;
const timestamp = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const positivePk = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
}

function gameMatches(game, league, date, { requireIdentity = true, expectedPk = null } = {}) {
  if (!game || typeof game !== 'object') return !requireIdentity;
  const pk = positivePk(game.gamePk);
  if ((requireIdentity && pk == null) || (expectedPk != null && pk != null && pk !== expectedPk)
    || (game.gamePk != null && pk == null)) return false;
  const leagues = [game.league, game.leagueId].filter(value => value != null);
  if ((requireIdentity && !leagues.length) || leagues.some(value => normalizeLeague(value) !== league)) return false;
  // MLB officialDate is the North American calendar day. It must never be
  // mistaken for the Taiwan board date when restoring an overnight game.
  const boardDates = [game.taipeiDate, game.boardDate, game.date].filter(value => value != null);
  if (boardDates.some(value => validDate(value) !== date)) return false;
  if (game.gameDate != null) {
    const startedAt = timestamp(game.gameDate);
    if (startedAt == null) return false;
    const taipeiDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(startedAt));
    if (taipeiDate !== date) return false;
    return true;
  }
  return !requireIdentity || boardDates.length > 0;
}

// Scope is independent of calculation state: legitimate queued/QA/BLOCK cards
// still belong to their board and may be saved/restored by the page cache.
export function analysisItemMatchesScope(item, { league, date } = {}) {
  const requestedLeague = normalizeLeague(league);
  const requestedDate = validDate(date);
  const pk = positivePk(item?.game?.gamePk);
  if (!requestedLeague || !requestedDate || pk == null
    || !gameMatches(item.game, requestedLeague, requestedDate)) return false;
  const data = item.customData;
  if (data?.game != null && !gameMatches(data.game, requestedLeague, requestedDate,
    { requireIdentity: false, expectedPk: pk })) return false;
  if ([data?.league, data?.leagueId].some(value => value != null && normalizeLeague(value) !== requestedLeague)) return false;
  if (data?.date != null && data.date !== requestedDate) return false;
  return true;
}

function analysisVersion(data) {
  const analysis = data?.analysis;
  if (!analysis || !analysisHasCalculatedDirections(data)) return null;
  const token = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 500 ? value : null;
  const snapshotCandidates = [data.pitPersistence?.snapshotId, analysis.pitPersistence?.snapshotId, analysis.pitSnapshotId]
    .filter(value => value != null);
  const snapshotIds = snapshotCandidates.map(token);
  if (snapshotIds.some(value => value == null) || new Set(snapshotIds).size > 1) return null;
  const snapshotId = snapshotIds[0] || null;
  const inputHash = token(analysis.inputHash);
  const distributionHash = token(analysis.distributionHash);
  const priceFingerprint = token(analysis.priceFingerprint);
  if (!snapshotId && !(inputHash && distributionHash && priceFingerprint)) return null;
  const analysisTime = timestamp(analysis.analysisAsOf);
  if (analysis.analysisAsOf != null && analysisTime == null) return null;
  return {
    // Preserve the original provenance tokens, not a collision-prone ad-hoc
    // digest. Reader refresh/fetchedAt never represents a new model version.
    fingerprint: JSON.stringify([snapshotId, inputHash, distributionHash, priceFingerprint,
      token(analysis.modelVersion), token(analysis.scoreFormulaVersion)]),
    analysisAsOf: analysisTime == null ? null : new Date(analysisTime).toISOString(),
  };
}

function validGameVersion(value, completedAt) {
  if (!Number.isFinite(completedAt) || !value || typeof value.fingerprint !== 'string' || value.fingerprint.length > 3200) return null;
  let parts;
  try { parts = JSON.parse(value.fingerprint); } catch { return null; }
  if (!Array.isArray(parts) || parts.length !== 6
    || parts.some(part => part !== null && (typeof part !== 'string' || !part.trim() || part.length > 500))
    || !(parts[0] || (parts[1] && parts[2] && parts[3]))) return null;
  const asOf = value.analysisAsOf == null ? null : timestamp(value.analysisAsOf);
  if (value.analysisAsOf != null && (asOf == null || asOf > completedAt)) return null;
  return { fingerprint: JSON.stringify(parts), analysisAsOf: asOf == null ? null : new Date(asOf).toISOString() };
}

/** A small receipt says which calculated games can be fetched again from one
 * completed workflow. It is never a substitute for the original W/R/S payload. */
export function createCompletedAnalysisReceipt(job, result, { now = Date.now() } = {}) {
  const league = normalizeLeague(job?.league);
  const date = validDate(job?.date);
  const runId = runIdentity(job?.runId);
  if (!league || !date || !runId || !Number.isFinite(now)
    || normalizeLeague(result?.league) !== league || result?.date !== date
    || (result?.runId != null && runIdentity(result.runId) !== runId)
    || !Array.isArray(result?.results)) return null;
  const completedValue = result.completedAt ?? job.completedAt;
  const completed = completedValue == null ? now : timestamp(completedValue);
  if (completed == null || completed > now) return null;
  const gamePks = new Set();
  const gameVersions = {};
  for (const row of result.results) {
    if (row?.ok !== true || !row.payload?.analysis || !analysisHasCalculatedDirections(row.payload)) continue;
    const game = row.task?.game;
    const pk = positivePk(game?.gamePk);
    if (!gameMatches(game, league, date) || pk == null) continue;
    if (row.task?.league != null && normalizeLeague(row.task.league) !== league) continue;
    if (row.task?.date != null && row.task.date !== date) continue;
    if (row.payload?.league != null && normalizeLeague(row.payload.league) !== league) continue;
    if (row.payload?.date != null && row.payload.date !== date) continue;
    if (row.payload.game != null && !gameMatches(row.payload.game, league, date, { requireIdentity: false, expectedPk: pk })) continue;
    const version = validGameVersion(analysisVersion(row.payload), completed);
    if (!version) continue;
    gamePks.add(pk);
    gameVersions[pk] = version;
  }
  if (!gamePks.size) return null;
  return { version: ANALYSIS_COMPLETED_RECEIPT_VERSION, runId, league, date,
    completedAt: new Date(completed).toISOString(), gamePks: [...gamePks].sort((a, b) => a - b),
    total: gamePks.size, completedReceipt: true, evidenceVersion: EVIDENCE_VERSION, gameVersions };
}

function validatedReceipt(value, now, maxAgeMs) {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0
    || value?.version !== ANALYSIS_COMPLETED_RECEIPT_VERSION || value.completedReceipt !== true || value.evidenceVersion !== EVIDENCE_VERSION
    || !runIdentity(value.runId) || !normalizeLeague(value.league) || !validDate(value.date)
    || !Array.isArray(value.gamePks) || !value.gamePks.length) return null;
  const completed = timestamp(value.completedAt);
  if (completed == null || completed > now || now - completed > maxAgeMs) return null;
  const pks = value.gamePks.map(positivePk);
  if (pks.some(pk => pk == null) || new Set(pks).size !== pks.length || value.total !== pks.length) return null;
  const gameVersions = Object.fromEntries(pks.map(pk => [pk, validGameVersion(value.gameVersions?.[pk], completed)]));
  if (Object.values(gameVersions).some(version => !version)) return null;
  return { version: ANALYSIS_COMPLETED_RECEIPT_VERSION, runId: runIdentity(value.runId), league: normalizeLeague(value.league),
    date: value.date, completedAt: new Date(completed).toISOString(), gamePks: pks.slice().sort((a, b) => a - b),
    total: pks.length, completedReceipt: true, evidenceVersion: EVIDENCE_VERSION, gameVersions };
}

const storeRows = store => Array.isArray(store) ? store : store && typeof store === 'object' ? Object.values(store) : [];
const receiptKey = receipt => `${receipt.league}|||${receipt.date}|||${receipt.runId}`;

export function upsertCompletedAnalysisReceipt(store, receipt, {
  now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, maxEntries = 12,
} = {}) {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0
    || !Number.isSafeInteger(maxEntries) || maxEntries < 1) return [];
  const valid = storeRows(store).map(row => validatedReceipt(row, now, maxAgeMs)).filter(Boolean);
  const incoming = validatedReceipt(receipt, now, maxAgeMs);
  const byKey = new Map();
  for (const row of incoming ? [...valid, incoming] : valid) {
    const key = receiptKey(row);
    const previous = byKey.get(key);
    if (!previous) { byKey.set(key, row); continue; }
    // A partial restore can re-observe only two of the same run's four games.
    // Keep all documented games for that run. Different run IDs never merge.
    const gamePks = [...new Set([...previous.gamePks, ...row.gamePks])].sort((a, b) => a - b);
    // A completed workflow has immutable payloads. A partial replay must not
    // replace already documented evidence for an existing game in the same run.
    const gameVersions = { ...row.gameVersions, ...previous.gameVersions };
    byKey.set(key, { ...row, gamePks, gameVersions, total: gamePks.length,
      // Reopening the same completed run must not restart its 72-hour lifetime.
      completedAt: Date.parse(previous.completedAt) <= Date.parse(row.completedAt) ? previous.completedAt : row.completedAt });
  }
  return [...byKey.values()].sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt)
    || receiptKey(a).localeCompare(receiptKey(b))).slice(0, maxEntries);
}

export function completedReceiptGameMatches(item, receipt, gamePk, { now = Date.now(), allowNewer = true } = {}) {
  const pk = positivePk(gamePk);
  const expected = validGameVersion(receipt?.gameVersions?.[pk], timestamp(receipt?.completedAt));
  if (pk == null || !Array.isArray(receipt?.gamePks) || !receipt.gamePks.includes(pk) || !expected
    || !item?.customData?.analysis || !analysisHasCalculatedDirections(item.customData)
    || positivePk(item?.game?.gamePk) !== pk || !analysisItemMatchesScope(item, receipt)) return false;
  const current = analysisVersion(item.customData);
  if (!current) return false;
  const currentAsOf = timestamp(current.analysisAsOf);
  const expectedAsOf = timestamp(expected.analysisAsOf);
  if (!Number.isFinite(now) || (currentAsOf != null && currentAsOf > now)) return false;
  if (current.fingerprint === expected.fingerprint) return true;
  return allowNewer && Number.isFinite(now) && currentAsOf != null && expectedAsOf != null
    && currentAsOf <= now && currentAsOf > expectedAsOf;
}

export function findMissingCompletedAnalysisReceipt(store, {
  league, date, board = [], now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const requestedLeague = normalizeLeague(league);
  const requestedDate = validDate(date);
  if (!requestedLeague || !requestedDate) return null;
  const boardByPk = new Map();
  for (const item of Array.isArray(board) ? board : []) {
    if (!item?.customData?.analysis || !analysisHasCalculatedDirections(item.customData)
      || !analysisItemMatchesScope(item, { league: requestedLeague, date: requestedDate })) continue;
    const pk = positivePk(item.game.gamePk);
    boardByPk.set(pk, item);
  }
  const candidates = storeRows(store).map(row => validatedReceipt(row, now, maxAgeMs)).filter(row => row
    && row.league === requestedLeague && row.date === requestedDate)
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
  const owner = new Map();
  for (const receipt of candidates) {
    for (const pk of receipt.gamePks) {
      const previous = owner.get(pk);
      if (!previous) { owner.set(pk, receipt); continue; }
      const currentAsOf = timestamp(receipt.gameVersions[pk].analysisAsOf);
      const previousAsOf = timestamp(previous.gameVersions[pk].analysisAsOf);
      // Receiving a delayed old workflow today does not make its model newer.
      // Prefer comparable model cutoffs; completion time orders equal/unknown
      // model cutoffs, including later prices of the same underlying model.
      if (currentAsOf != null && previousAsOf != null && currentAsOf > previousAsOf) owner.set(pk, receipt);
    }
  }
  for (const receipt of candidates) {
    const newestGamePks = receipt.gamePks.filter(pk => owner.get(pk) === receipt);
    const missingGamePks = newestGamePks.filter(pk => !completedReceiptGameMatches(boardByPk.get(pk), receipt, pk, { now }));
    if (missingGamePks.length) return { ...receipt, missingGamePks };
  }
  return null;
}
