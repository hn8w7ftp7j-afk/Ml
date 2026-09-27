import { betPositionIdentity } from './bet-ledger.js';
import { isLeagueId } from './leagues.js';

export const BET_ATTEMPT_JOURNAL_KEY = 'mlb-positive-ev.bet-attempt-journal.v1';
export const MAX_BET_ATTEMPTS = 100;
const STATUSES = new Set(['queued', 'saving', 'failed', 'uncertain', 'confirmed']);
const MAX_STORAGE_BYTES = 1_000_000;
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const boundedText = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && value === value.trim() && !value.includes('|||');
const positiveNumber = (value, maximum) => ['number', 'string'].includes(typeof value)
  && Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= maximum;

// Only identification and readback matching data are retained. This journal is
// never a source of a POST body, Reader authority, PIT evidence, or success.
export function sanitizeBetAttemptCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !isLeagueId(value.league) || value.league !== value.league.toUpperCase()
    || typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)
    || !Number.isFinite(Date.parse(`${value.date}T00:00:00.000Z`))
    || new Date(`${value.date}T00:00:00.000Z`).toISOString().slice(0, 10) !== value.date
    || !positiveNumber(value.gamePk, Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(Number(value.gamePk))
    || !boundedText(value.market, 30) || !boundedText(value.pick, 160)
    || !positiveNumber(value.water, 5) || !positiveNumber(value.stake, 1_000_000_000)) return null;
  return {
    league: value.league, date: value.date, gamePk: Number(value.gamePk),
    market: value.market, pick: value.pick, water: Number(value.water), stake: Number(value.stake),
    ...(boundedText(value.id, 120) ? { id: value.id } : {}),
    ...(typeof value.placedAt === 'string' && value.placedAt.length <= 40 && Number.isFinite(Date.parse(value.placedAt)) ? { placedAt: value.placedAt } : {}),
  };
}

export function sanitizeBetAttemptEntry(value) {
  const candidate = sanitizeBetAttemptCandidate(value?.candidate);
  if (!candidate || !STATUSES.has(value?.status)
    || value.key !== betPositionIdentity(candidate.date, candidate.gamePk, candidate, candidate.league)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt) return null;
  return {
    key: value.key, label: text(value.label, 240), status: value.status,
    message: text(value.message, 1000), candidate,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
    requiresRecheck: value.requiresRecheck === true,
    rejectedPitSnapshotId: text(value.rejectedPitSnapshotId, 300) || null,
    confirmedBetId: boundedText(value.confirmedBetId, 120) ? value.confirmedBetId : null,
  };
}

function failure(code, message, entries = []) { return { ok: false, code, message, entries }; }

function validateEntries(values) {
  if (!Array.isArray(values)) return failure('BET_ATTEMPT_JOURNAL_INVALID', '下注操作紀錄格式不正確，無法完整復原。');
  const entries = [];
  const keys = new Set();
  let invalid = 0;
  for (const value of values) {
    const entry = sanitizeBetAttemptEntry(value);
    if (!entry || keys.has(entry.key)) { invalid += 1; continue; }
    keys.add(entry.key);
    entries.push(entry);
  }
  if (invalid) return failure('BET_ATTEMPT_JOURNAL_INVALID', `${invalid} 筆下注操作紀錄無法驗證；有效紀錄仍可回讀帳本確認。`, entries);
  return { ok: true, entries, code: '', message: '' };
}

// Keep every unresolved attempt. Old confirmed attempts may be removed only
// after newer entries need their space; a full unresolved journal refuses a
// new write rather than silently forgetting an uncertain financial action.
export function compactBetAttemptEntries(values) {
  const result = validateEntries(values);
  if (!result.ok) return result;
  const unresolved = result.entries.filter(entry => entry.status !== 'confirmed');
  if (unresolved.length > MAX_BET_ATTEMPTS) return failure('BET_ATTEMPT_JOURNAL_FULL', '待確認的下注操作紀錄已滿；請先回讀帳本確認，舊紀錄未刪除。', result.entries);
  const confirmed = result.entries.filter(entry => entry.status === 'confirmed')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_BET_ATTEMPTS - unresolved.length);
  return { ...result, entries: [...unresolved, ...confirmed].sort((a, b) => a.createdAt - b.createdAt) };
}

export function loadBetAttemptJournal(storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target?.getItem) return failure('BET_ATTEMPT_STORAGE_UNAVAILABLE', '此瀏覽器無法讀取下注操作紀錄；請回讀永久帳本確認。');
    const raw = target.getItem(BET_ATTEMPT_JOURNAL_KEY);
    if (raw == null) return { ok: true, entries: [], code: '', message: '' };
    if (raw.length > MAX_STORAGE_BYTES) return failure('BET_ATTEMPT_JOURNAL_INVALID', '下注操作紀錄大小異常，無法完整復原；原紀錄未刪除。');
    const value = JSON.parse(raw);
    if (value?.version !== 1) return failure('BET_ATTEMPT_JOURNAL_INVALID', '下注操作紀錄版本不正確，無法完整復原；原紀錄未刪除。');
    return compactBetAttemptEntries(value.entries);
  } catch {
    return failure('BET_ATTEMPT_STORAGE_READ_FAILED', '下注操作紀錄讀取失敗；請回讀永久帳本確認，原紀錄未刪除。');
  }
}

export function saveBetAttemptJournal(values, storage) {
  const result = compactBetAttemptEntries(values);
  if (!result.ok) return result;
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target?.setItem) return failure('BET_ATTEMPT_STORAGE_UNAVAILABLE', '此瀏覽器無法保存下注操作紀錄；關閉頁面前請確認永久帳本。', result.entries);
    target.setItem(BET_ATTEMPT_JOURNAL_KEY, JSON.stringify({ version: 1, entries: result.entries }));
    return result;
  } catch {
    return failure('BET_ATTEMPT_STORAGE_WRITE_FAILED', '下注操作紀錄保存失敗；關閉頁面前請確認永久帳本。', result.entries);
  }
}
