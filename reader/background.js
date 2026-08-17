import { parseTai888Capture, canonicalReaderPayload } from './parser.js';
import { MAX_TAI888_TABS, selectAuthoritativeBoard, shouldSkipSuccessfulPayload, withinTai888TabScanLimit } from './board-selector.js';

const VERSION = '2.1.3';
const ORIGIN = 'https://mlb-positive-ev.vercel.app';
const PATTERNS = ['https://*.tai888.in/*', 'https://tai888.in/*'];
const LEAGUES = ['MLB', 'NPB', 'KBO', 'CPBL'];
const LABELS = { MLB: '美棒', NPB: '日棒', KBO: '韓棒', CPBL: '中職' };
const ALARM = 'tai888-reader-auto-sync';
let running;
let mutationTimer;

chrome.runtime.onInstalled.addListener(async () => {
  const old = await chrome.storage.local.get(['deviceId', 'autoEnabled', 'readerStatus', 'lastSuccessfulPayloadHash', 'lastSuccessfulSyncAt']);
  const values = {};
  if (!old.deviceId) values.deviceId = crypto.randomUUID();
  if (old.autoEnabled == null) values.autoEnabled = true;
  if (old.readerStatus) values.readerStatuses = { MLB: old.readerStatus };
  if (old.lastSuccessfulPayloadHash) values.lastSuccessfulPayloadHashes = { MLB: old.lastSuccessfulPayloadHash };
  if (old.lastSuccessfulSyncAt) values.lastSuccessfulSyncAts = { MLB: old.lastSuccessfulSyncAt };
  await chrome.storage.local.set(values);
  await chrome.storage.local.remove(['readerStatus', 'pairError']);
  await ensureAlarm();
});
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.alarms.onAlarm.addListener(event => { if (event.name === ALARM) syncNow('alarm').catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== 'complete' || !safeUrl(tab.url)) return;
  clearTimeout(mutationTimer);
  mutationTimer = setTimeout(() => syncNow('tab-loaded', tab.active === true ? tabId : null).catch(() => {}), 3500);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'PAIR_READER') { pair(message.password, message.deviceName).then(reply).catch(error => reply({ ok: false, error: error.message })); return true; }
  if (message?.type === 'SYNC_NOW') { syncNow('manual').then(reply).catch(error => reply({ ok: false, error: error.message })); return true; }
  if (message?.type === 'GET_READER_STATUS') { readerStatus().then(reply); return true; }
  if (message?.type === 'SET_AUTO_ENABLED') { chrome.storage.local.set({ autoEnabled: Boolean(message.enabled) }).then(async () => { await ensureAlarm(); reply({ ok: true, enabled: Boolean(message.enabled) }); }); return true; }
  if (message?.type === 'TAI888_BOARD_MUTATED') { const preferredTabId = sender?.tab?.active === true ? sender.tab.id : null; clearTimeout(mutationTimer); mutationTimer = setTimeout(() => syncNow('mutation', preferredTabId).catch(() => {}), 3500); }
});

async function ensureAlarm() {
  const { autoEnabled = true } = await chrome.storage.local.get('autoEnabled');
  await chrome.alarms.clear(ALARM);
  if (autoEnabled) await chrome.alarms.create(ALARM, { delayInMinutes: .5, periodInMinutes: 1 });
}
function safeUrl(value) { try { const url = new URL(String(value || '')); const host = url.hostname.toLowerCase(); if (url.protocol !== 'https:' || (host !== 'tai888.in' && !host.endsWith('.tai888.in'))) return ''; return `${url.origin}${url.pathname}${/^#\/BS(?:$|[/?&])/i.test(url.hash) ? '#/BS' : ''}`.slice(0, 500); } catch { return ''; } }
function safeHost(value) { try { const host = new URL(String(value || '')).hostname.toLowerCase(); return host === 'tai888.in' || host.endsWith('.tai888.in') ? host : ''; } catch { return ''; } }
function iso(value) { const time = Date.parse(String(value || '')); return Number.isFinite(time) ? new Date(time).toISOString() : ''; }
function integer(value, max = 10000) { const number = Number(value); return Number.isInteger(number) && number >= 0 && number <= max ? number : 0; }
function sanitizeCapture(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const league = LEAGUES.includes(input.league) ? input.league : null;
  return {
    version: input.version === 'TAI888-DOM-CAPTURE-v2.1.0' ? input.version : '', league,
    sourceHost: safeHost(`https://${input.sourceHost || ''}`) || safeHost(input.pageUrl), pageUrl: safeUrl(input.pageUrl), frameUrl: safeUrl(input.frameUrl), observedAt: iso(input.observedAt),
    tables: Array.isArray(input.tables) ? input.tables.slice(0, 12) : [],
    diagnostics: { recordCount: integer(input.diagnostics?.recordCount), headerCount: integer(input.diagnostics?.headerCount), candidateRows: integer(input.diagnostics?.candidateRows), gameCount: integer(input.diagnostics?.gameCount, 40), pairedRows: integer(input.diagnostics?.pairedRows, 80), singleRows: integer(input.diagnostics?.singleRows, 80), expectedGameCount: integer(input.diagnostics?.expectedGameCount, 40), rootCount: integer(input.diagnostics?.rootCount), candidateElementCount: integer(input.diagnostics?.candidateElementCount), acceptedRecordCount: integer(input.diagnostics?.acceptedRecordCount), lastMutationAt: iso(input.diagnostics?.lastMutationAt), sawLeagueMarker: input.diagnostics?.sawLeagueMarker === true, conflictingGameKeys: Array.isArray(input.diagnostics?.conflictingGameKeys) && input.diagnostics.conflictingGameKeys.length ? ['redacted-conflict'] : [] },
  };
}
async function request(url, options, timeout = 45000) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); try { return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' }); } finally { clearTimeout(timer); } }
async function json(response) { const text = await response.text(); try { return JSON.parse(text); } catch { throw new Error(`主系統回傳格式錯誤（${response.status}）`); } }
async function sha(value) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value))); return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }

async function pair(password, deviceName) {
  const current = await chrome.storage.local.get('deviceId'); const deviceId = current.deviceId || crypto.randomUUID();
  await chrome.storage.local.set({ deviceId });
  const response = await request(`${ORIGIN}/api/reader/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reader-Version': VERSION }, body: JSON.stringify({ deviceId, deviceName: String(deviceName || 'Tai888 Reader PC').slice(0, 80), password: String(password || '') }) }, 20000);
  const data = await json(response); if (!response.ok || !data.ok) throw new Error(data.error || `配對失敗（${response.status}）`);
  await chrome.storage.local.set({ readerToken: data.token, pairedAt: Date.now(), autoEnabled: true, pairError: '', readerStatuses: {}, lastSuccessfulPayloadHashes: {}, lastSuccessfulSyncAts: {} });
  await ensureAlarm();
  try { return { ok: true, paired: true, syncOk: true, message: data.message, sync: await syncNow('paired') }; } catch (error) { return { ok: true, paired: true, syncOk: false, message: `配對完成，但首次讀盤未成功：${error.message}` }; }
}
async function syncNow(reason, preferredTabId = null) { if (running) return running; running = performSync(reason, preferredTabId).finally(() => { running = null; }); return running; }

async function performSync(reason, preferredTabId) {
  const stored = await chrome.storage.local.get(['readerToken', 'deviceId', 'autoEnabled', 'readerStatuses', 'lastSuccessfulPayloadHashes', 'lastSuccessfulSyncAts']);
  if (!stored.readerToken) throw new Error('尚未配對，請先輸入一次 Reader 配對密碼。');
  if (reason !== 'manual' && stored.autoEnabled === false) return { ok: true, skipped: true, message: '自動同步已關閉' };
  const tabs = [...new Map((await chrome.tabs.query({ url: PATTERNS })).map(tab => [tab.id, tab])).values()];
  if (!tabs.length) throw new Error('找不到 Tai888 分頁。請開啟四個聯盟的「讓分＆大小」頁。');
  if (!withinTai888TabScanLimit(tabs.length)) throw new Error(`偵測到 ${tabs.length} 個 Tai888 分頁；Reader 最多檢查 ${MAX_TAI888_TABS} 個。`);
  const candidates = [];
  for (const tab of tabs) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => [{ frameId: 0, url: tab.url }]);
    for (const frame of frames || []) try {
      const answer = await chrome.tabs.sendMessage(tab.id, { type: 'TAI888_CAPTURE_BASEBALL_TABLE' }, { frameId: frame.frameId });
      const capture = sanitizeCapture(answer?.capture);
      if (answer?.ok && capture.league && capture.tables.length) candidates.push({ tabId: tab.id, frameId: frame.frameId, active: Boolean(tab.active), lastAccessed: Number(tab.lastAccessed || 0), capture, parsed: parseTai888Capture(capture, new Date()) });
    } catch {}
  }
  const statuses = { ...(stored.readerStatuses || {}) }; const hashes = { ...(stored.lastSuccessfulPayloadHashes || {}) }; const times = { ...(stored.lastSuccessfulSyncAts || {}) }; const results = [];
  for (const league of LEAGUES) {
    const own = candidates.filter(item => item.parsed.league === league);
    if (!own.length) { statuses[league] = { ok: false, state: 'missing', league, message: `找不到${LABELS[league]}標準盤分頁`, readerVersion: VERSION }; continue; }
    const selection = selectAuthoritativeBoard(own, { now: Date.now(), preferredTabId, league });
    if (!selection.ok) {
      const detail = selection.assessed?.flatMap(item => item.issues || []).slice(0, 3).join('、');
      statuses[league] = { ok: false, state: 'error', league, message: `${LABELS[league]}已讀取，但檢查未通過${detail ? `：${detail}` : ''}`, readerVersion: VERSION };
      continue;
    }
    const selected = selection.selected; const payload = selected.candidate.parsed;
    Object.assign(payload, { league, readerVersion: VERSION, deviceId: stored.deviceId, pageActivityAt: selected.pageActivityAt, expectedGameCount: selected.expectedGameCount, detectedGameCount: selected.detectedGameCount });
    const payloadHash = await sha(canonicalReaderPayload(payload)); payload.payloadHash = payloadHash;
    if (shouldSkipSuccessfulPayload({ reason, payloadHash, lastSuccessfulPayloadHash: hashes[league], lastSuccessfulSyncAt: times[league] })) { results.push({ league, ok: true, skipped: true }); continue; }
    try {
      const response = await request(`${ORIGIN}/api/reader/ingest`, { method: 'POST', headers: { Authorization: `Bearer ${stored.readerToken}`, 'Content-Type': 'application/json', 'X-Reader-Version': VERSION, 'X-Device-Id': stored.deviceId }, body: JSON.stringify(payload) });
      const data = await json(response); if (response.status === 401) { await chrome.storage.local.remove('readerToken'); throw new Error('Reader 配對已過期'); } if (!response.ok || !data.ok) throw new Error(data.error || `同步失敗（${response.status}）`);
      const now = Date.now(); hashes[league] = payloadHash; times[league] = now;
      statuses[league] = { ok: true, state: 'synced', league, executable: data.executable !== false, captureOnly: false, message: data.message, lastSyncAt: now, rawGameCount: data.rawGameCount, matchedGameCount: data.matchedGameCount, boardDate: data.boardDate, readerVersion: VERSION };
      results.push({ league, ok: true, message: data.message });
    } catch (error) { statuses[league] = { ok: false, state: 'error', league, message: error.message, lastAttemptAt: Date.now(), readerVersion: VERSION }; results.push({ league, ok: false, error: error.message }); }
  }
  await chrome.storage.local.set({ readerStatuses: statuses, lastSuccessfulPayloadHashes: hashes, lastSuccessfulSyncAts: times, pairError: '' });
  const successes = results.filter(item => item.ok).length;
  return { ok: successes > 0, results, message: `四聯盟檢查完成｜${successes} 個分頁同步成功` };
}
async function readerStatus() { const stored = await chrome.storage.local.get(['readerToken', 'deviceId', 'autoEnabled', 'readerStatuses', 'pairError', 'pairedAt']); return { ok: true, paired: Boolean(stored.readerToken), deviceId: stored.deviceId || null, autoEnabled: stored.autoEnabled !== false, pairedAt: stored.pairedAt || null, statuses: stored.readerStatuses || {}, error: stored.pairError || '', readerVersion: VERSION }; }
