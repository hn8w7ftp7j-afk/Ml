import { parseTai888Capture, canonicalReaderPayload } from './parser.js';
import { MAX_TAI888_TABS, selectAuthoritativeBoard, shouldSkipSuccessfulPayload, withinTai888TabScanLimit } from './board-selector.js';

const READER_VERSION = '2.0.7';
const MLB_EV_ORIGIN = 'https://mlb-positive-ev.vercel.app';
const TAI888_PATTERNS = ['https://*.tai888.in/*', 'https://tai888.in/*'];
const ALARM_NAME = 'tai888-reader-auto-sync';
const PAIR_TIMEOUT_MS = 20_000;
const INGEST_TIMEOUT_MS = 45_000;
let syncPromise = null;
let mutationTimer = null;

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(['deviceId', 'autoEnabled']);
  if (!current.deviceId) await chrome.storage.local.set({ deviceId: crypto.randomUUID() });
  if (current.autoEnabled == null) await chrome.storage.local.set({ autoEnabled: true });
  // Older builds could retain raw frame URLs in local diagnostics.  Remove the
  // transient status/error on install or update; pairing state is unaffected.
  await chrome.storage.local.remove(['readerStatus', 'pairError']);
  await ensureAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) syncNow('alarm').catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !isTai888Url(tab.url)) return;
  const preferredTabId = tab.active === true ? tabId : null;
  clearTimeout(mutationTimer);
  mutationTimer = setTimeout(() => syncNow('tai888-tab-loaded', preferredTabId).catch(() => {}), 3500);
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
      })
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === 'TAI888_BOARD_MUTATED') {
    // Mutation events also arrive from background/old Tai888 tabs.  Only the
    // active sender may request preference; board-selector checks activity
    // again against the fresh tabs.query() result before honoring it.
    const preferredTabId = sender?.tab?.active === true ? sender.tab.id : null;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => syncNow('mutation', preferredTabId).catch(() => {}), 3500);
  }
});

async function ensureAlarm() {
  const { autoEnabled = true } = await chrome.storage.local.get('autoEnabled');
  await chrome.alarms.clear(ALARM_NAME);
  if (autoEnabled) {
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.5, periodInMinutes: 1 });
  }
}

function isTai888Url(url) {
  return Boolean(sanitizeTai888PageUrl(url));
}

function tai888Host(value) {
  try {
    const text = String(value || '').trim();
    if (!text) return '';
    const parsed = text.includes('://') ? new URL(text) : new URL(`https://${text}`);
    const host = parsed.hostname.toLowerCase();
    return host === 'tai888.in' || host.endsWith('.tai888.in') ? host : '';
  } catch { return ''; }
}

function sanitizeTai888PageUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:'
      || (host !== 'tai888.in' && !host.endsWith('.tai888.in'))) return '';
    const marker = /^#\/BS(?:$|[/?&])/i.test(parsed.hash || '') ? '#/BS' : '';
    return `${parsed.origin}${parsed.pathname || '/'}${marker}`.slice(0, 500);
  } catch { return ''; }
}

function diagnosticInteger(value, maximum = 10_000) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= maximum ? number : 0;
}

function diagnosticIso(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function sanitizeCaptureDiagnostics(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    recordCount: diagnosticInteger(input.recordCount),
    headerCount: diagnosticInteger(input.headerCount),
    candidateRows: diagnosticInteger(input.candidateRows),
    gameCount: diagnosticInteger(input.gameCount, 40),
    pairedRows: diagnosticInteger(input.pairedRows, 80),
    singleRows: diagnosticInteger(input.singleRows, 80),
    expectedGameCount: diagnosticInteger(input.expectedGameCount, 40),
    rootCount: diagnosticInteger(input.rootCount),
    candidateElementCount: diagnosticInteger(input.candidateElementCount),
    acceptedRecordCount: diagnosticInteger(input.acceptedRecordCount),
    mutationAgeSeconds: diagnosticInteger(input.mutationAgeSeconds, 86_400),
    sawLeagueMarker: input.sawLeagueMarker === true,
    documentLooksStandardMlb: input.documentLooksStandardMlb === true,
    frameHost: tai888Host(input.frameHost),
    sourceHost: tai888Host(input.sourceHost),
    lastMutationAt: diagnosticIso(input.lastMutationAt),
    // Board selection only needs to know that a conflict exists.  Never retain
    // attacker-controlled row keys or other unexpected diagnostic metadata.
    conflictingGameKeys: Array.isArray(input.conflictingGameKeys) && input.conflictingGameKeys.length
      ? ['redacted-conflict']
      : [],
  };
}

function sanitizeCaptureMetadata(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const pageUrl = sanitizeTai888PageUrl(input.pageUrl);
  const frameUrl = sanitizeTai888PageUrl(input.frameUrl);
  return {
    version: input.version === 'TAI888-DOM-CAPTURE-v2.0.7' ? input.version : '',
    sourceHost: tai888Host(input.sourceHost) || tai888Host(pageUrl) || tai888Host(frameUrl),
    pageUrl,
    frameUrl,
    observedAt: diagnosticIso(input.observedAt),
    tables: Array.isArray(input.tables) ? input.tables.slice(0, 12) : [],
    diagnostics: sanitizeCaptureDiagnostics(input.diagnostics),
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('連線逾時，Reader 會於下一次心跳重試');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function pairReader(password, deviceName = '') {
  const stored = await chrome.storage.local.get('deviceId');
  const deviceId = stored.deviceId || crypto.randomUUID();
  await chrome.storage.local.set({ deviceId });
  const response = await fetchWithTimeout(`${MLB_EV_ORIGIN}/api/reader/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Reader-Version': READER_VERSION },
    body: JSON.stringify({
      deviceId,
      deviceName: String(deviceName || 'Tai888 Reader PC').slice(0, 80),
      password: String(password || ''),
    }),
  }, PAIR_TIMEOUT_MS);
  const data = await jsonResponse(response);
  if (!response.ok || !data.ok) throw new Error(data.error || `配對失敗（${response.status}）`);

  await chrome.storage.local.set({
    readerToken: data.token,
    pairedAt: Date.now(),
    autoEnabled: true,
    pairError: '',
    lastPayloadHash: '',
    lastSyncAt: 0,
    lastSuccessfulPayloadHash: '',
    lastSuccessfulSyncAt: 0,
  });
  await ensureAlarm();

  try {
    const sync = await syncNow('paired');
    return { ok: true, paired: true, syncOk: true, message: data.message, sync };
  } catch (error) {
    // Pairing already succeeded. Preserve the token and show the sync problem separately.
    return {
      ok: true,
      paired: true,
      syncOk: false,
      message: `配對完成，但首次讀盤未成功：${String(error?.message || error)}`,
    };
  }
}

async function syncNow(reason = 'manual', preferredTabId = null) {
  if (syncPromise) return syncPromise;
  syncPromise = performSync(reason, preferredTabId).finally(() => { syncPromise = null; });
  return syncPromise;
}

async function performSync(reason, preferredTabId) {
  const stored = await chrome.storage.local.get([
    'readerToken', 'deviceId', 'autoEnabled', 'lastPayloadHash', 'lastSyncAt',
    'lastSuccessfulPayloadHash', 'lastSuccessfulSyncAt',
  ]);
  if (!stored.readerToken) {
    throw await rememberError('尚未配對 MLB EV，請先在 Reader 視窗輸入一次配對密碼。');
  }
  if (reason !== 'manual' && stored.autoEnabled === false) {
    return { ok: true, skipped: true, message: '自動同步已關閉' };
  }

  const tabs = await chrome.tabs.query({ url: TAI888_PATTERNS });
  const ordered = [...new Map(tabs.map(tab => [tab.id, tab])).values()].sort((left, right) => {
    const leftPreferred = left.active === true && left.id === preferredTabId;
    const rightPreferred = right.active === true && right.id === preferredTabId;
    if (leftPreferred !== rightPreferred) return Number(rightPreferred) - Number(leftPreferred);
    if (left.active && !right.active) return -1;
    if (right.active && !left.active) return 1;
    return Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
  });
  if (!ordered.length) {
    throw await rememberError('找不到已開啟的 Tai888 分頁。請保持 Tai888 MLB 盤口頁開著。');
  }
  if (!withinTai888TabScanLimit(ordered.length)) {
    throw await rememberError(
      `偵測到 ${ordered.length} 個 Tai888 分頁；Reader 最多檢查 ${MAX_TAI888_TABS} 個。已停止上傳，請關閉多餘分頁後再同步。`,
    );
  }

  const boardCandidates = [];
  const diagnostics = [];
  for (const tab of ordered) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id })
      .catch(() => [{ frameId: 0, url: tab.url }]);
    for (const frame of frames || [{ frameId: 0, url: tab.url }]) {
      try {
        const response = await chrome.tabs.sendMessage(
          tab.id,
          { type: 'TAI888_CAPTURE_MLB_TABLE' },
          { frameId: frame.frameId },
        );
        const capture = sanitizeCaptureMetadata(response?.capture);
        diagnostics.push({
          tabId: tab.id,
          frameId: frame.frameId,
          frameUrl: sanitizeTai888PageUrl(frame.url) || capture.frameUrl,
          ok: response?.ok === true,
          tableCount: capture.tables.length,
          capture: capture.diagnostics,
          error: response?.ok === true ? '' : 'capture-failed',
        });
        if (response?.ok && capture.tables.length) {
          boardCandidates.push({
            tabId: tab.id,
            frameId: frame.frameId,
            active: Boolean(tab.active),
            lastAccessed: Number(tab.lastAccessed || 0),
            capture,
            parsed: parseTai888Capture(capture, new Date()),
          });
        }
      } catch (error) {
        diagnostics.push({
          tabId: tab.id,
          frameId: frame.frameId,
          frameUrl: sanitizeTai888PageUrl(frame.url),
          ok: false,
          tableCount: 0,
          error: 'capture-unavailable',
        });
      }
    }
  }

  if (!boardCandidates.length) {
    const responding = diagnostics.filter(row => row.ok).length;
    throw await rememberError(
      `目前畫面尚未辨識到標準 MLB 讓分／大小盤口（已檢查 ${diagnostics.length} 個框架、${responding} 個框架有回應）。請停在「美棒 → 讓分＆大小」並按一次 F5。`,
      { diagnostics },
    );
  }

  const selection = selectAuthoritativeBoard(boardCandidates, {
    now: Date.now(),
    preferredTabId,
  });
  const selectionDiagnostics = selection.assessed?.map(row => ({
    tabId: row.candidate?.tabId,
    frameId: row.candidate?.frameId,
    ok: row.ok,
    issues: row.issues,
    expectedGameCount: row.expectedGameCount,
    detectedGameCount: row.detectedGameCount,
    rawDetectedGameCount: row.rawDetectedGameCount,
    parsedGameCount: Array.isArray(row.candidate?.parsed?.games) ? row.candidate.parsed.games.length : 0,
    pageActivityAt: row.pageActivityAt,
  })) || [];
  if (!selection.ok) {
    const stale = selectionDiagnostics.some(row => row.issues?.includes('stale-page-activity'));
    const frameConflict = selection.error === 'conflicting-complete-frames';
    const tabConflict = selection.error === 'conflicting-complete-tabs';
    const authorityDiagnostic = selectionDiagnostics.find(row => row.tabId === selection.authorityTabId)
      || selectionDiagnostics[0];
    const diagnosticSummary = authorityDiagnostic
      ? `〔診斷：應有${authorityDiagnostic.expectedGameCount ?? '—'}場／原始節點${authorityDiagnostic.rawDetectedGameCount ?? '—'}筆／去重${authorityDiagnostic.detectedGameCount ?? '—'}場／解析${authorityDiagnostic.parsedGameCount ?? '—'}場；${(authorityDiagnostic.issues || []).slice(0, 4).join('、') || '未提供原因'}〕`
      : '';
    const message = tabConflict
      ? '同一盤日有多個 Tai888 分頁回報互相衝突的完整盤面；已停止上傳。請關閉或重新整理舊分頁後再同步。'
      : frameConflict
        ? '同一 Tai888 分頁內有兩個互相衝突的完整盤面；已停止上傳，避免跨框架錯盤。'
        : stale
          ? 'Tai888 權威盤面超過3分鐘沒有頁面活動；已停止刷新舊盤，請重新整理或重新登入後再同步。'
          : `目前權威 Tai888 分頁尚未完整辨識每場4市場／8方向與雙方水位；已停止上傳，避免部分盤覆蓋完整盤。${diagnosticSummary}`;
    throw await rememberError(message, {
      diagnostics: [...diagnostics, ...selectionDiagnostics],
    });
  }

  // Never combine captures here.  The selected parsed board came from one
  // proven-complete frame in one authoritative tab.
  const selected = selection.selected;
  const parsed = selected.candidate.parsed;
  parsed.readerVersion = READER_VERSION;
  parsed.deviceId = stored.deviceId;
  parsed.pageActivityAt = selected.pageActivityAt;
  parsed.expectedGameCount = selected.expectedGameCount;
  parsed.detectedGameCount = selected.detectedGameCount;

  const payloadHash = await sha256(canonicalReaderPayload(parsed));
  parsed.payloadHash = payloadHash;
  const lastSuccessfulPayloadHash = stored.lastSuccessfulPayloadHash || stored.lastPayloadHash || '';
  const lastSuccessfulSyncAt = stored.lastSuccessfulSyncAt || stored.lastSyncAt || 0;
  if (shouldSkipSuccessfulPayload({
    reason,
    payloadHash,
    lastSuccessfulPayloadHash,
    lastSuccessfulSyncAt,
  })) {
    return { ok: true, skipped: true, message: '盤口未變，等待下一次心跳', payloadHash };
  }

  const response = await fetchWithTimeout(`${MLB_EV_ORIGIN}/api/reader/ingest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stored.readerToken}`,
      'Content-Type': 'application/json',
      'X-Reader-Version': READER_VERSION,
      'X-Device-Id': stored.deviceId,
    },
    body: JSON.stringify(parsed),
  }, INGEST_TIMEOUT_MS);
  const data = await jsonResponse(response);
  if (response.status === 401) {
    await chrome.storage.local.remove('readerToken');
    throw await rememberError('Reader 配對已過期，請重新輸入一次配對密碼。');
  }
  if (!response.ok || !data.ok) {
    throw await rememberError(data.error || `同步失敗（${response.status}）`, { diagnostics });
  }

  const successfulSyncAt = Date.now();
  const status = {
    ok: true,
    state: 'synced',
    reason,
    heartbeat: Boolean(data.heartbeat),
    message: data.message || `已同步 ${data.matchedGameCount} 場`,
    lastSyncAt: successfulSyncAt,
    lastObservedAt: parsed.observedAt,
    rawGameCount: data.rawGameCount,
    matchedGameCount: data.matchedGameCount,
    unopenedGameCount: data.unopenedGameCount || 0,
    scheduleGameCount: data.scheduleGameCount,
    payloadHash: data.payloadHash,
    boardDate: data.boardDate,
    unmatched: data.unmatched || [],
    readerVersion: READER_VERSION,
    runtimeCache: data.runtimeCache,
    expectedGameCount: selected.expectedGameCount,
    detectedGameCount: selected.detectedGameCount,
    pageActivityAt: selected.pageActivityAt,
    selectedTabId: selected.candidate.tabId,
    selectedFrameId: selected.candidate.frameId,
    diagnostics: diagnostics.slice(0, 20),
  };
  await chrome.storage.local.set({
    readerStatus: status,
    pairError: '',
    lastPayloadHash: payloadHash,
    lastSyncAt: successfulSyncAt,
    // These keys are written only after the ingest response confirms success.
    // A failed new hash therefore remains retryable on the next alarm/mutation.
    lastSuccessfulPayloadHash: payloadHash,
    lastSuccessfulSyncAt: successfulSyncAt,
  });
  return status;
}

async function readerStatus() {
  const stored = await chrome.storage.local.get([
    'readerToken', 'deviceId', 'autoEnabled', 'readerStatus', 'pairError', 'pairedAt',
  ]);
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

async function rememberError(message, details = {}) {
  const error = new Error(message);
  await chrome.storage.local.set({
    pairError: message,
    readerStatus: {
      ok: false,
      state: 'error',
      message,
      lastAttemptAt: Date.now(),
      readerVersion: READER_VERSION,
      diagnostics: details.diagnostics?.slice?.(0, 20) || [],
    },
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
