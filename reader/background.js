import { parseTai888Capture, canonicalReaderPayload } from './parser.js';

const READER_VERSION = '2.0.0';
const MLB_EV_ORIGIN = 'https://mlb-positive-ev.vercel.app';
const ALARM_NAME = 'tai888-reader-auto-sync';
let syncPromise = null;
let mutationTimer = null;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(['deviceId', 'autoEnabled']);
  if (!current.deviceId) await chrome.storage.local.set({ deviceId: crypto.randomUUID() });
  if (current.autoEnabled == null) await chrome.storage.local.set({ autoEnabled: true });
  await ensureAlarm();
  setTimeout(() => syncNow('installed').catch(() => {}), 5000);
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  setTimeout(() => syncNow('startup').catch(() => {}), 5000);
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) syncNow('alarm').catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !isTai888Url(tab.url)) return;
  setTimeout(() => syncNow('tai888-tab-loaded', tabId).catch(() => {}), 5000);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'PAIR_READER') {
    pairReader(message.password, message.deviceName)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === 'SYNC_NOW') {
    syncNow('manual')
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === 'GET_READER_STATUS') {
    readerStatus().then(sendResponse);
    return true;
  }
  if (message?.type === 'SET_AUTO_ENABLED') {
    chrome.storage.local.set({ autoEnabled: Boolean(message.enabled) })
      .then(async () => {
        await ensureAlarm();
        sendResponse({ ok: true, enabled: Boolean(message.enabled) });
      });
    return true;
  }
  if (message?.type === 'TAI888_BOARD_MUTATED') {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => syncNow('mutation', sender?.tab?.id).catch(() => {}), 3500);
  }
});

async function ensureAlarm() {
  const { autoEnabled = true } = await chrome.storage.local.get('autoEnabled');
  await chrome.alarms.clear(ALARM_NAME);
  if (autoEnabled) chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.2, periodInMinutes: 1 });
}

function isTai888Url(url) {
  try {
    const parsed = new URL(url || '');
    return parsed.protocol === 'https:' && (parsed.hostname === 'tai888.in' || parsed.hostname.endsWith('.tai888.in'));
  } catch { return false; }
}

async function pairReader(password, deviceName = '') {
  const stored = await chrome.storage.local.get('deviceId');
  const deviceId = stored.deviceId || crypto.randomUUID();
  await chrome.storage.local.set({ deviceId });
  const response = await fetch(`${MLB_EV_ORIGIN}/api/reader/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Reader-Version': READER_VERSION },
    body: JSON.stringify({ deviceId, deviceName: deviceName || navigator.userAgent.slice(0, 80), password: String(password || '') }),
  });
  const data = await jsonResponse(response);
  if (!response.ok || !data.ok) throw new Error(data.error || `配對失敗（${response.status}）`);
  await chrome.storage.local.set({ readerToken: data.token, pairedAt: Date.now(), autoEnabled: true, pairError: '' });
  await ensureAlarm();
  const sync = await syncNow('paired');
  return { ok: true, message: data.message, sync };
}

async function syncNow(reason = 'manual', preferredTabId = null) {
  if (syncPromise) return syncPromise;
  syncPromise = performSync(reason, preferredTabId).finally(() => { syncPromise = null; });
  return syncPromise;
}

async function performSync(reason, preferredTabId) {
  const stored = await chrome.storage.local.get(['readerToken', 'deviceId', 'autoEnabled']);
  if (!stored.readerToken) throw await rememberError('尚未配對 MLB EV，請先在 Reader 視窗輸入一次配對密碼。');
  if (reason !== 'manual' && stored.autoEnabled === false) return { ok: true, skipped: true, message: '自動同步已關閉' };

  const tabs = await chrome.tabs.query({ url: ['https://*.tai888.in/*', 'https://tai888.in/*'] });
  const ordered = [...tabs].sort((left, right) => {
    if (left.id === preferredTabId) return -1;
    if (right.id === preferredTabId) return 1;
    if (left.active && !right.active) return -1;
    if (right.active && !left.active) return 1;
    return Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
  });
  if (!ordered.length) throw await rememberError('找不到已開啟的 Tai888 分頁。請保持 Tai888 MLB 盤口頁開著。');

  const captures = [];
  for (const tab of ordered.slice(0, 4)) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => [{ frameId: 0 }]);
    for (const frame of frames || [{ frameId: 0 }]) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'TAI888_CAPTURE_MLB_TABLE' }, { frameId: frame.frameId });
        if (response?.ok && response.capture?.tables?.length) captures.push(response.capture);
      } catch {
        // Frames without an injected content script are expected on old pages.
      }
    }
  }
  if (!captures.length) throw await rememberError('目前 Tai888 畫面找不到 MLB 盤口表格，請停在「美棒 → 讓分＆大小」。');

  const combined = {
    sourceHost: new URL(ordered[0].url).hostname,
    pageUrl: ordered[0].url,
    pageTitle: ordered[0].title || '',
    observedAt: new Date().toISOString(),
    tables: captures.flatMap(capture => capture.tables || []),
  };
  const parsed = parseTai888Capture(combined, new Date());
  parsed.readerVersion = READER_VERSION;
  parsed.deviceId = stored.deviceId;
  if (!parsed.games.length) throw await rememberError('Reader 找到 Tai888 頁面，但沒有解析到 MLB 場次。');

  const payloadHash = await sha256(canonicalReaderPayload(parsed));
  parsed.payloadHash = payloadHash;
  const response = await fetch(`${MLB_EV_ORIGIN}/api/reader/ingest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stored.readerToken}`,
      'Content-Type': 'application/json',
      'X-Reader-Version': READER_VERSION,
      'X-Device-Id': stored.deviceId,
    },
    body: JSON.stringify(parsed),
  });
  const data = await jsonResponse(response);
  if (response.status === 401) {
    await chrome.storage.local.remove('readerToken');
    throw await rememberError('Reader 配對已過期，請重新輸入一次配對密碼。');
  }
  if (!response.ok || !data.ok) throw await rememberError(data.error || `同步失敗（${response.status}）`);

  const status = {
    ok: true,
    state: 'synced',
    reason,
    message: data.message || `已同步 ${data.matchedGameCount} 場`,
    lastSyncAt: Date.now(),
    lastObservedAt: parsed.observedAt,
    rawGameCount: data.rawGameCount,
    matchedGameCount: data.matchedGameCount,
    scheduleGameCount: data.scheduleGameCount,
    payloadHash: data.payloadHash,
    boardDate: data.boardDate,
    unmatched: data.unmatched || [],
    readerVersion: READER_VERSION,
    runtimeCache: data.runtimeCache,
  };
  await chrome.storage.local.set({ readerStatus: status, pairError: '' });
  return status;
}

async function readerStatus() {
  const stored = await chrome.storage.local.get(['readerToken', 'deviceId', 'autoEnabled', 'readerStatus', 'pairError', 'pairedAt']);
  return {
    ok: true,
    paired: Boolean(stored.readerToken),
    deviceId: stored.deviceId || null,
    autoEnabled: stored.autoEnabled !== false,
    pairedAt: stored.pairedAt || null,
    status: stored.readerStatus || null,
    error: stored.pairError || '',
    readerVersion: READER_VERSION,
  };
}

async function rememberError(message) {
  const error = new Error(message);
  await chrome.storage.local.set({
    pairError: message,
    readerStatus: { ok: false, state: 'error', message, lastAttemptAt: Date.now(), readerVersion: READER_VERSION },
  });
  return error;
}

async function jsonResponse(response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`MLB EV 回傳格式錯誤（${response.status}）`); }
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
