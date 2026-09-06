import { NBA_CACHE_PREFIX, NBA_MODULE_VERSION } from './config.js';

const entries = new Map();
const inflight = new Map();
const MAX_ENTRIES = 12;
const MAX_AGE = 24 * 60 * 60 * 1000;
const STORAGE_KEY = `${NBA_CACHE_PREFIX}:screens`;

export function nbaRequestKey(params) {
  return new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '' && value != null).sort(([a], [b]) => a.localeCompare(b))).toString();
}

export function validNbaScreen(value, key, now = Date.now()) {
  return Boolean(value?.key === key && value.version === NBA_MODULE_VERSION && value.result?.league === 'NBA' && value.result?.moduleVersion === NBA_MODULE_VERSION
    && value.result?.data && value.savedAt <= now && now - value.savedAt < MAX_AGE);
}

export function nbaScreenNeedsRefresh(key, result, now = Date.now()) {
  const view = new URLSearchParams(key).get('view');
  const ttl = { schedule: 60_000, game: 60_000, injuries: 300_000, teams: 21_600_000, team: 900_000, player: 3_600_000, history: 3_600_000 }[view] || 60_000;
  const timestamps = (result?.sources || []).map(source => Date.parse(source.fetchedAt || source.retrievedAt || ''));
  return !timestamps.length || timestamps.some(stamp => !Number.isFinite(stamp) || now < stamp || now - stamp >= ttl);
}

export function readNbaScreen(key) {
  if (entries.has(key) && validNbaScreen(entries.get(key), key)) return entries.get(key).result;
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
    const entry = Array.isArray(saved) && saved.find(row => validNbaScreen(row, key));
    if (entry) { entries.set(key, entry); return entry.result; }
  } catch { /* Storage may be disabled; the in-memory screen still works. */ }
  return null;
}

export function saveNbaScreen(key, result) {
  if (result?.league !== 'NBA' || result.moduleVersion !== NBA_MODULE_VERSION || !result.data || result.status === 'unavailable' || result.qa?.status === 'BLOCK') return;
  if (result.status === 'partial' && readNbaScreen(key)) return;
  entries.delete(key);
  entries.set(key, { key, result, version: NBA_MODULE_VERSION, savedAt: Date.now() });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  try {
    const compact = [...entries.values()].filter(row => JSON.stringify(row).length < 250_000);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(compact));
  } catch { /* Never remove other leagues' data to make room for NBA. */ }
}

export async function requestNbaScreen(key) {
  if (inflight.has(key)) return inflight.get(key);
  const task = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 65_000);
    try {
      const response = await fetch(`/api/nba?${key}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      let body;
      try { body = await response.json(); } catch { throw new Error('NBA 回應格式異常，請稍後重新讀取。'); }
      if (!response.ok) throw new Error(response.status === 401 ? '登入已過期，請重新登入後再讀取 NBA。' : body.error || '資料讀取失敗，請重試。');
      if (body.league !== 'NBA' || !body.data) throw new Error('資料識別不符，已保留原本畫面。');
      if (body.moduleVersion !== NBA_MODULE_VERSION) throw new Error('NBA 資料版本已更新，請重新載入頁面。');
      saveNbaScreen(key, body);
      return body;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('NBA 資料讀取逾時，請按重新讀取。');
      throw error;
    } finally { clearTimeout(timeout); }
  })();
  inflight.set(key, task);
  try { return await task; } finally { inflight.delete(key); }
}
