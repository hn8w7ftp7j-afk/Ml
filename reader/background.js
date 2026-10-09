import { parseTai888Capture, canonicalReaderPayload, readerMarketProperties } from './parser.js';
import { selectAuthoritativeBoard, shouldSkipSuccessfulPayload, readerPayloadsByDate } from './board-selector.js';

const VERSION = '2.1.30';
const ORIGIN = 'https://mlb-positive-ev.vercel.app';
const PATTERNS = ['https://*.tai888.in/*', 'https://tai888.in/*'];
const LEAGUES = ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA'];
const LABELS = { MLB: '美棒', NPB: '日棒', KBO: '韓棒', CPBL: '中職', NBA: '美籃' };
const ALARM = 'tai888-reader-auto-sync';
let running;
let pendingRerun = false;
let pendingReason = 'mutation';
let pendingPreferredTabId = null;
let mutationTimer;
const recoveryCooldownByTab = new Map();
const RECOVERY_COOLDOWN_MS = 90_000;

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
  // Existing tabs retain their old content scripts after an extension update.
  const tabs = await chrome.tabs.query({ url: PATTERNS });
  await Promise.all(tabs.map(tab => chrome.tabs.reload(tab.id).catch(() => {})));
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
  if (message?.type === 'GET_READER_STATUS') { readerStatus().then(reply).catch(error => reply({ ok: false, error: error.message })); return true; }
  if (message?.type === 'GET_READER_DIAGNOSTICS') { readerDiagnostics().then(reply).catch(error => reply({ ok: false, error: error.message })); return true; }
  if (message?.type === 'REPAIR_READER') { repairReader().then(reply).catch(error => reply({ ok: false, error: error.message })); return true; }
  if (message?.type === 'SET_AUTO_ENABLED') { chrome.storage.local.set({ autoEnabled: Boolean(message.enabled) }).then(async () => { await ensureAlarm(); reply({ ok: true, enabled: Boolean(message.enabled) }); }); return true; }
  if (message?.type === 'TAI888_BOARD_MUTATED') { const preferredTabId = sender?.tab?.active === true ? sender.tab.id : null; clearTimeout(mutationTimer); mutationTimer = setTimeout(() => syncNow('mutation', preferredTabId).catch(() => {}), 3500); }
  if (message?.type === 'TAI888_FRAME_READY') { const preferredTabId = sender?.tab?.active === true ? sender.tab.id : null; clearTimeout(mutationTimer); mutationTimer = setTimeout(() => syncNow('frame-ready', preferredTabId).catch(() => {}), 1800); }
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
function localBoardDiagnostic(payload, capture) {
  const games = Array.isArray(payload?.games) ? payload.games : [];
  const properties = readerMarketProperties(payload?.league);
  const marketCount = games.reduce((count, game) => count + properties.filter(property => game?.[property]).length, 0);
  const openCount = games.filter(game => game?.marketStatus !== 'locked' && properties.some(property => game?.[property])).length;
  const lockedCount = games.length - openCount;
  const firstRow = capture?.tables?.[0]?.rows?.[0];
  const sample = [2, 3, 6, 7].map(index => {
    const pair = Array.isArray(firstRow?.cells?.[index]?.pair) ? firstRow.cells[index].pair : [];
    return pair.map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ');
  });
  return { openCount, lockedCount, marketCount, sample: sample.join('｜').slice(0, 280) };
}
function sanitizeCapture(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const league = LEAGUES.includes(input.league) ? input.league : null;
  return {
    version: /^TAI888-DOM-CAPTURE-v2\.[12]\.0$/.test(input.version || '') ? input.version : '', league,
    sourceHost: safeHost(`https://${input.sourceHost || ''}`) || safeHost(input.pageUrl), pageUrl: safeUrl(input.pageUrl), frameUrl: safeUrl(input.frameUrl), observedAt: iso(input.observedAt),
    tables: Array.isArray(input.tables) ? input.tables.slice(0, 12) : [],
    diagnostics: { recordCount: integer(input.diagnostics?.recordCount), headerCount: integer(input.diagnostics?.headerCount), candidateRows: integer(input.diagnostics?.candidateRows), gameCount: integer(input.diagnostics?.gameCount, 40), pairedRows: integer(input.diagnostics?.pairedRows, 80), singleRows: integer(input.diagnostics?.singleRows, 80), expectedGameCount: integer(input.diagnostics?.expectedGameCount, 40), rootCount: integer(input.diagnostics?.rootCount), candidateElementCount: integer(input.diagnostics?.candidateElementCount), acceptedRecordCount: integer(input.diagnostics?.acceptedRecordCount), lastMutationAt: iso(input.diagnostics?.lastMutationAt), sawLeagueMarker: input.diagnostics?.sawLeagueMarker === true, wrongPeriodHeader: input.diagnostics?.wrongPeriodHeader === true, conflictingGameKeys: Array.isArray(input.diagnostics?.conflictingGameKeys) && input.diagnostics.conflictingGameKeys.length ? ['redacted-conflict'] : [] },
  };
}
async function request(url, options, timeout = 45000) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); try { return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' }); } finally { clearTimeout(timer); } }
async function json(response) { const text = await response.text(); try { return JSON.parse(text); } catch { throw new Error(`主系統回傳格式錯誤（${response.status}）`); } }
async function sha(value) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value))); return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function collectCandidates(tabs) {
  const candidates = [];
  const silentTabIds = [];
  for (const tab of tabs) {
    let responded = false;
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => [{ frameId: 0, url: tab.url }]);
    for (const frame of frames || []) try {
      const answer = await chrome.tabs.sendMessage(tab.id, { type: 'TAI888_CAPTURE_BASEBALL_TABLE' }, { frameId: frame.frameId });
      if (answer?.capture?.readerVersion !== VERSION) continue;
      responded = responded || answer?.ok === true;
      const rawCaptures = Array.isArray(answer?.capture?.captures) ? answer.capture.captures : answer?.capture ? [answer.capture] : [];
      for (const rawCapture of rawCaptures) {
        const capture = sanitizeCapture(rawCapture);
        if (answer?.ok && capture.league && capture.tables.length) candidates.push({ tabId: tab.id, frameId: frame.frameId, active: Boolean(tab.active), lastAccessed: Number(tab.lastAccessed || 0), capture, parsed: parseTai888Capture(capture, new Date()) });
      }
    } catch {}
    if (!responded) silentTabIds.push(tab.id);
  }
  return { candidates, silentTabIds };
}

async function readerDiagnostics() {
  const tabs = await chrome.tabs.query({ url: PATTERNS });
  const scan = await collectCandidates(tabs);
  const boards = scan.candidates.map(candidate => {
    const selection = selectAuthoritativeBoard([candidate], { now: Date.now(), league: candidate.parsed.league });
    return {
      tabId: candidate.tabId, frameId: candidate.frameId, league: candidate.parsed.league,
      error: selection.error || '', issues: selection.assessed.flatMap(row => row.issues || []),
      diagnostics: candidate.capture.diagnostics,
      tables: candidate.capture.tables.map(table => ({
        rows: (table.rows || []).map(row => ({
          marketLocked: row.marketLocked === true,
          cells: (row.cells || []).map(cell => ({ pair: (cell.pair || []).map(value => String(value).slice(0, 200)) })),
        })),
      })),
    };
  });
  return { ok: true, report: { readerVersion: VERSION, createdAt: new Date().toISOString(), silentTabIds: scan.silentTabIds, boards } };
}

async function recoverTabs(tabs, tabIds, { force = false } = {}) {
  const targets = new Set(tabIds);
  let requested = false;
  for (const tab of tabs) {
    if (!targets.has(tab.id)) continue;
    const last = Number(recoveryCooldownByTab.get(tab.id) || 0);
    if (!force && Date.now() - last < RECOVERY_COOLDOWN_MS) continue;
    recoveryCooldownByTab.set(tab.id, Date.now());
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => [{ frameId: 0 }]);
    for (const frame of frames || []) try {
      const answer = await chrome.tabs.sendMessage(tab.id, { type: 'TAI888_READER_RECOVER' }, { frameId: frame.frameId });
      requested = requested || answer?.ok === true;
    } catch {}
  }
  if (requested) await wait(1600);
  return requested;
}

async function pair(password, deviceName) {
  const current = await chrome.storage.local.get('deviceId'); const deviceId = current.deviceId || crypto.randomUUID();
  await chrome.storage.local.set({ deviceId });
  const response = await request(`${ORIGIN}/api/reader/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Reader-Version': VERSION }, body: JSON.stringify({ deviceId, deviceName: String(deviceName || 'Tai888 Reader PC').slice(0, 80), password: String(password || '') }) }, 20000);
  const data = await json(response); if (!response.ok || !data.ok) throw new Error(data.error || `配對失敗（${response.status}）`);
  await chrome.storage.local.set({ readerToken: data.token, pairedAt: Date.now(), autoEnabled: true, pairError: '', readerStatuses: {}, lastSuccessfulPayloadHashes: {}, lastSuccessfulSyncAts: {} });
  await ensureAlarm();
  try { return { ok: true, paired: true, syncOk: true, message: data.message, sync: await syncNow('paired') }; } catch (error) { return { ok: true, paired: true, syncOk: false, message: `配對完成，但首次讀盤未成功：${error.message}` }; }
}
async function syncNow(reason, preferredTabId = null) {
  if (running) {
    pendingRerun = true;
    pendingReason = reason || 'mutation';
    if (preferredTabId != null) pendingPreferredTabId = preferredTabId;
    return running;
  }
  running = performSync(reason, preferredTabId).finally(() => {
    running = null;
    if (pendingRerun) {
      const rerunReason = pendingReason;
      const rerunTabId = pendingPreferredTabId;
      pendingRerun = false;
      pendingPreferredTabId = null;
      queueMicrotask(() => syncNow(rerunReason, rerunTabId).catch(() => {}));
    }
  });
  return running;
}

async function performSync(reason, preferredTabId) {
  const stored = await chrome.storage.local.get(['readerToken', 'deviceId', 'autoEnabled', 'readerStatuses', 'lastSuccessfulPayloadHashes', 'lastSuccessfulSyncAts']);
  if (!stored.readerToken) throw new Error('尚未配對，請先輸入一次 Reader 配對密碼。');
  if (reason !== 'manual' && stored.autoEnabled === false) return { ok: true, skipped: true, message: '自動同步已關閉' };
  const tabs = [...new Map((await chrome.tabs.query({ url: PATTERNS })).map(tab => [tab.id, tab])).values()];
  if (!tabs.length) {
    const message = '找不到 Tai888 分頁，請確認網站存取權限，並開啟 tai888.in 的「讓分＆大小」頁。';
    await chrome.storage.local.set({ readerStatuses: Object.fromEntries(LEAGUES.map(league => [league, { ok: false, state: 'missing', league, message, readerVersion: VERSION }])) });
    return { ok: false, message };
  }
  let scan = await collectCandidates(tabs);
  if (scan.silentTabIds.length && await recoverTabs(tabs, scan.silentTabIds, { force: reason === 'manual' })) scan = await collectCandidates(tabs);
  if (reason === 'manual' && scan.silentTabIds.length) {
    let reloaded = 0;
    for (const tabId of scan.silentTabIds) {
      try { await chrome.tabs.reload(tabId); reloaded += 1; } catch {}
    }
    if (reloaded) {
      const message = `已更新 ${reloaded} 個分頁內的 Reader 程式，頁面載入後會自動重新讀取。`;
      await chrome.storage.local.set({ readerStatuses: Object.fromEntries(LEAGUES.map(league => [league, { ok: false, state: 'idle', league, message, readerVersion: VERSION }])) });
      return { ok: false, message };
    }
  }
  let candidates = scan.candidates;
  const statuses = { ...(stored.readerStatuses || {}) }; const hashes = { ...(stored.lastSuccessfulPayloadHashes || {}) }; const times = { ...(stored.lastSuccessfulSyncAts || {}) }; const results = [];
  for (const league of LEAGUES) {
    const own = candidates.filter(item => item.parsed.league === league);
    if (!own.length) {
      const disconnected = scan.silentTabIds.length > 0;
      statuses[league] = { ok: false, state: disconnected ? 'disconnected' : 'missing', league, message: disconnected ? `${LABELS[league]} Reader 未連線，無法連上頁面讀取程式；請按「修復讀取」或在該分頁按 F5` : `找不到${LABELS[league]}標準盤分頁（可能尚未開盤）`, readerVersion: VERSION };
      continue;
    }
    const selection = selectAuthoritativeBoard(own, { now: Date.now(), preferredTabId, league });
    if (!selection.ok) {
      const detail = selection.error === 'conflicting-duplicate-rows'
        ? '同場盤口重複且數字不一致，已停止上傳；請重新整理 Tai888 分頁後再同步'
        : selection.error === 'conflicting-duplicate-frames'
        ? '同一分頁內盤口不一致，已停止同步；請重新整理該 Tai888 分頁後再同步'
        : selection.error === 'conflicting-duplicate-tabs'
          ? '同聯盟分頁盤口不一致，已停止同步；請只保留正確盤日的分頁後再同步'
          : selection.assessed?.flatMap(item => item.issues || []).slice(0, 3).join('、');
      statuses[league] = { ok: false, state: 'error', league, message: `${LABELS[league]}已讀取，但檢查未通過${detail ? `：${detail}` : ''}`, readerVersion: VERSION };
      continue;
    }
    const selected = selection.selected; const sourcePayload = selected.candidate.parsed;
    Object.assign(sourcePayload, { league, readerVersion: VERSION, deviceId: stored.deviceId, pageActivityAt: selected.pageActivityAt, expectedGameCount: selected.expectedGameCount, detectedGameCount: selected.detectedGameCount });
    const payloads = readerPayloadsByDate(sourcePayload);
    const accepted = [], failures = [];
    for (const payload of payloads) {
      const syncKey = league === 'NBA' ? `${league}:${payload.boardDate}` : league;
      try {
        const payloadHash = await sha(canonicalReaderPayload(payload)); payload.payloadHash = payloadHash;
        if (shouldSkipSuccessfulPayload({ reason, payloadHash, lastSuccessfulPayloadHash: hashes[syncKey], lastSuccessfulSyncAt: times[syncKey], now: Date.now() })) {
          // A skipped day still contributes to the aggregate only if its
          // previously acknowledged receipt is available.
          const receipt = league === 'NBA'
            ? stored.readerStatuses?.[league]?.dateStatuses?.find(item => item.boardDate === payload.boardDate)
            : stored.readerStatuses?.[league];
          if (receipt) { accepted.push(receipt); results.push({ league, boardDate: payload.boardDate, ok: true, skipped: true }); continue; }
        }
        const endpoint = league === 'NBA' ? '/api/nba/reader' : '/api/reader/ingest';
        const response = await request(`${ORIGIN}${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${stored.readerToken}`, 'Content-Type': 'application/json', 'X-Reader-Version': VERSION, 'X-Device-Id': stored.deviceId }, body: JSON.stringify(payload) });
        const data = await json(response); if (response.status === 401) { await chrome.storage.local.remove('readerToken'); throw new Error('Reader 配對已過期'); } if (!response.ok || !data.ok) throw new Error(data.error || `同步失敗（${response.status}）`);
        const now = Date.now(); hashes[syncKey] = payloadHash; times[syncKey] = now;
        accepted.push({ boardDate: payload.boardDate, lastSyncAt: now, rawGameCount: data.rawGameCount, matchedGameCount: integer(data.matchedGameCount, 40), unopenedGameCount: integer(data.unopenedGameCount, 40), marketCount: integer(data.marketCount, 160), directionCount: integer(data.directionCount, 320), partialGameCount: integer(data.partialGameCount, 40), executable: data.executable === true });
        results.push({ league, boardDate: payload.boardDate, ok: true, message: data.message });
      } catch (error) { failures.push({ boardDate: payload.boardDate, error: error.message }); results.push({ league, boardDate: payload.boardDate, ok: false, error: error.message }); }
    }
    const sum = key => accepted.reduce((count, item) => count + Number(item[key] || 0), 0);
    statuses[league] = { ok: failures.length === 0, state: failures.length ? 'error' : 'synced', league,
      executable: league === 'NBA' ? accepted.some(item => item.executable) : sum('matchedGameCount') > 0,
      captureOnly: league === 'NBA', message: failures.length ? failures.map(item => `${item.boardDate}：${item.error}`).join('；') : `已同步 ${accepted.length} 個日期`,
      lastSyncAt: accepted.length ? Math.min(...accepted.map(item => item.lastSyncAt)) : 0, lastAttemptAt: Date.now(),
      rawGameCount: sum('rawGameCount'), matchedGameCount: sum('matchedGameCount'), unopenedGameCount: sum('unopenedGameCount'), marketCount: sum('marketCount'), directionCount: sum('directionCount'), partialGameCount: sum('partialGameCount'),
      localDiagnostic: localBoardDiagnostic(sourcePayload, selected.candidate.capture), boardDate: sourcePayload.boardDate,
      boardDates: payloads.map(item => item.boardDate), dateStatuses: accepted, dateErrors: failures, readerVersion: VERSION };

  }
  await chrome.storage.local.set({ readerStatuses: statuses, lastSuccessfulPayloadHashes: hashes, lastSuccessfulSyncAts: times, pairError: '' });
  const successes = LEAGUES.filter(league => statuses[league]?.ok === true && statuses[league]?.state === 'synced').length;
  return { ok: successes > 0, results, message: `五聯盟檢查完成｜${successes} 個分頁同步成功` };
}
async function readerStatus() { const stored = await chrome.storage.local.get(['readerToken', 'deviceId', 'autoEnabled', 'readerStatuses', 'pairError', 'pairedAt']); return { ok: true, paired: Boolean(stored.readerToken), deviceId: stored.deviceId || null, autoEnabled: stored.autoEnabled !== false, pairedAt: stored.pairedAt || null, statuses: stored.readerStatuses || {}, error: stored.pairError || '', readerVersion: VERSION }; }

// A missing content script cannot receive RECOVER. Reload only after the user
// explicitly clicks repair, only on allowlisted tabs that did not respond.
async function repairReader() {
  if (running) await running.catch(() => {});
  const tabs = await chrome.tabs.query({ url: PATTERNS });
  const scan = await collectCandidates(tabs);
  const failed = [];
  let reloaded = 0;
  for (const tabId of scan.silentTabIds) {
    try { await chrome.tabs.reload(tabId); reloaded += 1; }
    catch { failed.push(tabId); }
  }
  if (reloaded) return { ok: failed.length === 0, message: `已重新整理 ${reloaded} 個未連線分頁，載入完成後請按「立即同步」。${failed.length ? '部分分頁無法重新整理，請手動按 F5。' : ''}` };
  return syncNow('manual');
}
