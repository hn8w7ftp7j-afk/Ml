import { parseTai888Capture, canonicalReaderPayload, readerMarketProperties, nhlReaderEvidencePayload } from './parser.js';
import { selectAuthoritativeBoard, selectAuthoritativeSoccerBoards, shouldSkipSuccessfulPayload, readerPayloadsByDate } from './board-selector.js';
import { createDiagnosticOutbox, DIAGNOSTIC_ALARM } from './diagnostic-outbox.js';
import { DIAGNOSTIC_SCHEMA } from './diagnostic-schema.js';

const VERSION = '2.1.46';
const ORIGIN = 'https://mlb-positive-ev.vercel.app';
const PATTERNS = ['https://*.tai888.in/*', 'https://tai888.in/*'];
const LEAGUES = ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'NHL', 'EPL', 'UCL'];
const LABELS = { MLB: '美棒', NPB: '日棒', KBO: '韓棒', CPBL: '中職', NBA: '美籃', NHL: '冰球', EPL:'英超', UCL:'歐冠' };
const ALARM = 'tai888-reader-auto-sync';
let diagnosticOutbox;
function getDiagnosticOutbox() { return diagnosticOutbox ||= createDiagnosticOutbox({ storage: chrome.storage.local, upload: async (report, stored) => {
  const response = await request(`${ORIGIN}/api/reader/diagnostics`, { method: 'POST', headers: {
    Authorization: `Bearer ${stored.readerToken}`, 'Content-Type': 'application/json',
    'X-Device-Id': stored.deviceId, 'X-Reader-Version': VERSION,
  }, body: JSON.stringify(report) }, 8000);
  const receipt = await json(response);
  if (!response.ok) throw Object.assign(new Error('DIAGNOSTIC_UPLOAD_FAILED'), { status: response.status });
  return receipt;
} }); }
async function ensureDiagnosticAlarm() {
  await chrome.alarms.create(DIAGNOSTIC_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
}
function syncExceptionCode(error) {
  if (error?.code === 'INVALID_RESPONSE') return 'INVALID_RESPONSE';
  return error?.status ? `HTTP_${error.status}` : error?.name === 'AbortError' ? 'TIMEOUT'
    : error?.name === 'TypeError' ? 'NETWORK_ERROR' : 'SYNC_EXCEPTION';
}
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
  await ensureDiagnosticAlarm();
  // Existing tabs retain their old content scripts after an extension update.
  const tabs = await chrome.tabs.query({ url: PATTERNS });
  await Promise.all(tabs.map(tab => chrome.tabs.reload(tab.id).catch(() => {})));
});
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureDiagnosticAlarm);
chrome.alarms.onAlarm.addListener(event => { if (event.name === DIAGNOSTIC_ALARM) getDiagnosticOutbox().flush().catch(() => {}); });
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
const SAVE_RECEIPT_VERSION = 'READER-SAVE-RECEIPT-v1';
function readerSaveReceiptMatches(receipt, league, boardDate, payloadHash) {
  return receipt?.version === SAVE_RECEIPT_VERSION && receipt.status === 'CONFIRMED'
    && receipt.league === league && receipt.boardDate === boardDate
    && receipt.payloadHash === payloadHash && /^[a-f0-9]{64}$/.test(payloadHash || '');
}
function confirmedReaderSaveReceipt(data, payload, payloadHash) {
  const invalid = () => { throw Object.assign(new Error('伺服器未確認盤口永久保存，將自動重試'), { code: 'INVALID_RESPONSE' }); };
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const timestamp = value => typeof value === 'string' && Boolean(iso(value));
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const league = payload?.league, boardDate = payload?.boardDate;
  if (!data || data.ok !== true || data.league !== league || !hash(payloadHash)
    || (data.boardDate !== undefined && data.boardDate !== boardDate)
    || data.durable === false || data.persisted === false) invalid();
  const receipt = { version: SAVE_RECEIPT_VERSION, status: 'CONFIRMED', league, boardDate, payloadHash,
    confirmedAt: new Date().toISOString() };
  if (['MLB', 'NPB', 'KBO', 'CPBL', 'NBA'].includes(league)) {
    const history = data.historyTracking;
    if (data.boardDate !== boardDate || data.allRequiredWritesSucceeded !== true
      || history?.configured !== true || !['checked', 'inserted', 'unchanged', 'failed'].every(key => count(history[key]))
      || history.failed !== 0 || history.checked !== history.inserted + history.unchanged + history.failed) invalid();
    receipt.evidenceType = 'MARKET_HISTORY';
    receipt.historyTracking = { configured: true, checked: history.checked, inserted: history.inserted,
      unchanged: history.unchanged, failed: 0 };
    // Capture receipts are additive. Older deployed APIs can still confirm the
    // history write, while new receipts retain only this explicit evidence list.
    const capture = history.captureReceipt;
    if (capture?.configured === true && capture.persisted === true && hash(capture.receiptId)
      && timestamp(capture.persistedAt) && count(capture.gameCount)
      && capture.coverageComplete === false && capture.closingLineVerified === false
      && ['sourceObservedAt', 'pageActivityAt', 'receivedAt'].every(key => capture[key] === null || timestamp(capture[key]))) {
      receipt.historyTracking.captureReceipt = { configured: true, persisted: true, receiptId: capture.receiptId,
        sourceObservedAt: capture.sourceObservedAt === null ? null : iso(capture.sourceObservedAt),
        pageActivityAt: capture.pageActivityAt === null ? null : iso(capture.pageActivityAt),
        receivedAt: capture.receivedAt === null ? null : iso(capture.receivedAt), persistedAt: iso(capture.persistedAt),
        gameCount: capture.gameCount, coverageComplete: false, closingLineVerified: false };
    }
  } else if (['EPL', 'UCL', 'NHL'].includes(league)) {
    if (data.persisted !== true || !hash(data.revision) || !timestamp(data.observedAt)
      || Date.parse(data.observedAt) !== Date.parse(payload.observedAt)) invalid();
    receipt.evidenceType = league === 'NHL' ? 'NHL_OBSERVATION' : 'SOCCER_OBSERVATION';
    receipt.persisted = true; receipt.revision = data.revision; receipt.observedAt = iso(data.observedAt);
    if (league !== 'NHL') {
      if (!hash(data.observationId) || data.observationId !== data.revision
        || !timestamp(data.receivedAt) || !timestamp(data.firstFetchedAt)
        || data.timeEvidence !== 'SERVER_RECEIPT_RECORDED') invalid();
      receipt.observationId = data.observationId; receipt.receivedAt = iso(data.receivedAt);
      receipt.firstFetchedAt = iso(data.firstFetchedAt); receipt.timeEvidence = 'SERVER_RECEIPT_RECORDED';
    }
  } else invalid();
  return receipt;
}
function localBoardDiagnostic(payload, capture) {
  const games = Array.isArray(payload?.games) ? payload.games : [];
  if (['EPL', 'UCL'].includes(payload?.league)) {
    const openCount = games.filter(game => game.marketStatus !== 'locked' && game.markets?.length).length;
    return { openCount, lockedCount: games.filter(game => game.marketStatus === 'locked').length,
      marketCount: games.reduce((count, game) => count + (game.markets?.length || 0), 0),
      sample: games.flatMap(game => game.markets || []).flatMap(market => market.rawRows || []).join('｜').slice(0, 280) };
  }
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
    ...(['NHL','EPL','UCL'].includes(league) ? { pageLeagueLabel: String(input.pageLeagueLabel || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100) } : {}),
    sourceHost: safeHost(`https://${input.sourceHost || ''}`) || safeHost(input.pageUrl), pageUrl: safeUrl(input.pageUrl), frameUrl: safeUrl(input.frameUrl), observedAt: iso(input.observedAt),
    tables: Array.isArray(input.tables) ? input.tables.slice(0, 12) : [],
    diagnostics: { recordCount: integer(input.diagnostics?.recordCount), headerCount: integer(input.diagnostics?.headerCount), candidateRows: integer(input.diagnostics?.candidateRows), gameCount: integer(input.diagnostics?.gameCount, 40), pairedRows: integer(input.diagnostics?.pairedRows, 80), singleRows: integer(input.diagnostics?.singleRows, 80), expectedGameCount: integer(input.diagnostics?.expectedGameCount, 40), rootCount: integer(input.diagnostics?.rootCount), candidateElementCount: integer(input.diagnostics?.candidateElementCount), acceptedRecordCount: integer(input.diagnostics?.acceptedRecordCount), lastMutationAt: iso(input.diagnostics?.lastMutationAt), sawLeagueMarker: input.diagnostics?.sawLeagueMarker === true, wrongPeriodHeader: input.diagnostics?.wrongPeriodHeader === true, skippedAlternativeCount: integer(input.diagnostics?.skippedAlternativeCount, 1000), tableIssues: ['EPL', 'UCL'].includes(league) && Array.isArray(input.diagnostics?.tableIssues) ? [...new Set(input.diagnostics.tableIssues.filter(issue => SOCCER_LAYOUT_ISSUES.has(issue)))].slice(0, 8) : [], conflictingGameKeys: Array.isArray(input.diagnostics?.conflictingGameKeys) && input.diagnostics.conflictingGameKeys.length ? ['redacted-conflict'] : [] },
  };
}

// Layout diagnostics are kept in the downloaded report only. Never copy a
// content-script object wholesale: a malformed page must not turn this into a
// DOM/account-text export or add arbitrary keys to a saved report.
const SOCCER_LAYOUT_ISSUES = new Set([
  'SOCCER_MIXED_LEAGUE_SECTION', 'SOCCER_CARD_HEADERS_MISSING', 'SOCCER_CARD_HEADERS_AMBIGUOUS',
  'SOCCER_CARD_TEAM_IDENTITY_INVALID', 'SOCCER_CARD_QUOTES_AMBIGUOUS', 'SOCCER_TABLE_IDENTITY_INVALID',
  'SOCCER_TABLE_QUOTES_AMBIGUOUS', 'SOCCER_TABLE_HEADERS_AMBIGUOUS', 'SOCCER_HEADING_FOUND_NO_LAYOUT',
  'SOCCER_LAYOUT_UNRECOGNIZED', 'SOCCER_MODULE_MISSING', 'SOCCER_LAYOUT_RECORDS_TRUNCATED',
]);
const SOCCER_DIAGNOSTIC_TEAM_KEYS = new Set([
  '兵工廠', '曼城', '曼聯', '熱刺', '利物浦', '切爾西', '阿斯頓維拉', '伯恩茅斯', '布倫特福德', '布萊頓',
  '伯恩利', '水晶宮', '艾佛頓', '富勒姆', '里茲聯', '萊斯特城', '紐卡索聯', '諾丁漢森林', '桑德蘭',
  '西漢姆聯', '狼隊', '南安普敦', '伊普斯維奇', '謝菲爾德聯', '盧頓', '皇家馬德里', '巴塞隆納',
  '馬德里競技', '畢爾包競技', '比利亞雷亞爾', '皇家社會', '巴黎聖日耳曼', '馬賽', '摩納哥', '里爾',
  '里昂', '拜仁慕尼黑', '多特蒙德', '勒沃庫森', '法蘭克福', 'RB萊比錫', '斯圖加特', '國際米蘭',
  '尤文圖斯', 'AC米蘭', '拿坡里', '亞特蘭大', '羅馬', '拉齊奧', '本菲卡', '波爾圖', '里斯本競技',
  '阿賈克斯', 'PSV恩荷芬', '飛燕諾', '塞爾提克', '格拉斯哥流浪者', '加拉塔薩雷', '費內巴切',
  '布魯日', '哥本哈根', '薩爾斯堡紅牛', '頓內茨克礦工', '奧林匹亞科斯', '布拉格斯拉維亞',
  '布拉格斯巴達', '聖吉羅斯聯', 'Coventry City', 'Hull City', 'Portsmouth',
]);
const SOCCER_DIAGNOSTIC_PRIVATE = /(?:password|passwd|token|cookie|session|secret|authorization|bearer|account|balance|credit|帳號|账号|帳戶|账户|餘額|余额|額度|额度|登入|登录|密碼|密码|[<>=@\\]|https?:|[A-Za-z0-9_-]{24,})/i;
function soccerDiagnosticText(value) {
  if (typeof value !== 'string' || !value || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value) || SOCCER_DIAGNOSTIC_PRIVATE.test(value)) return '';
  return value.replace(/\s+/g, ' ').trim();
}
function soccerDiagnosticHeading(value, league) {
  const text = soccerDiagnosticText(value), registry = globalThis.Tai888LeagueRegistry;
  if (!text || registry?.identify(text) !== league || !registry.standardMarker(text, league)) return '';
  const marker = text.match(registry.leagues?.[league]?.marker);
  if (!marker || marker.index !== 0) return '';
  const suffix = text.slice(marker[0].length).replace(/(?:全場|全场|上半場|上半场|上半|第[一1]半場|第[一1]半场|FULL[ -]?TIME|FIRST\s+HALF|1ST\s+HALF|\bFT\b|\bHT\b|\b1H\b)/gi, '').replace(/[\d\s()（）:：—–-]/g, '');
  return suffix ? '' : text;
}
function soccerDiagnosticLine(value, league) {
  const text = soccerDiagnosticText(value);
  if (!text) return '';
  if (soccerDiagnosticHeading(text, league)) return text;
  const header = text.replace(/(?:全場|全场|上半場|上半场|上半|第[一1]半場|第[一1]半场|FULL[ -]?TIME|FIRST\s+HALF|1ST\s+HALF|\bFT\b|\bHT\b|\b1H\b)/gi, '').replace(/[\s:：()（）-]/g, '');
  if (['時間', '时间', '主客隊伍', '主客队伍', '隊伍', '队伍', '獨贏', '独赢', '讓球', '让球', '讓分', '让分', '大小', '大小盤', '大小盘', '單雙', '单双'].includes(header)) return text;
  if (/^\d{1,2}[/-]\d{1,2}(?:\s+(?:[01]?\d|2[0-3]):[0-5]\d)?$/.test(text) || /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(text)) return text;
  if (/^[-－—]$/.test(text) || /^[\d.＋+\/－–—−\-\s平大小單单双主客勝胜和]+$/u.test(text) && /\d/.test(text)) return text;
  const team = globalThis.Tai888SoccerTeams?.resolve(text);
  // Unknown unmarked text is never accepted merely because resolve() can
  // create a fallback identity for any name. A home label is explicit sport
  // evidence only when it still has a short human-readable team-name shape.
  if (team && (SOCCER_DIAGNOSTIC_TEAM_KEYS.has(team.key)
    || /[\[［【(（]\s*主\s*[\]］】)）]/u.test(text) && text.length <= 64 && /^[\p{L}\p{M}\s.'’&\-\[\]［］【】()（）]+$/u.test(text))) return text;
  return '';
}
function soccerDiagnosticCoordinate(value) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000 ? Math.round(value * 100) / 100 : null; }
function sanitizeSoccerLayout(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !['EPL', 'UCL'].includes(input.league)) return null;
  const league = input.league, label = soccerDiagnosticHeading(input.label, league);
  if (!label) return null;
  const modules = {}, counts = {}, paths = {}, samples = [];
  for (const name of ['registry', 'table', 'card']) modules[name] = input.modules?.[name] === true;
  for (const name of ['records', 'headers', 'markers', 'physicalGroups', 'geometryGroups']) counts[name] = typeof input.counts?.[name] === 'number' ? integer(input.counts[name], 10000) : 0;
  for (const name of ['physical', 'geometry', 'cards']) {
    const path = input.paths?.[name];
    paths[name] = { tableCount: typeof path?.tableCount === 'number' ? integer(path.tableCount, 1000) : 0,
      sawLeagueMarker: path?.sawLeagueMarker === true,
      issues: [...new Set((Array.isArray(path?.issues) ? path.issues : []).filter(issue => SOCCER_LAYOUT_ISSUES.has(issue)))].slice(0, 8) };
  }
  for (const sample of (Array.isArray(input.samples) ? input.samples : []).slice(0, 8)) {
    if (!['TR', 'DIV', 'LI', 'SPAN', 'TABLE', 'TD', 'TH', 'SECTION'].includes(sample?.tag)) continue;
    const top = soccerDiagnosticCoordinate(sample.top), left = soccerDiagnosticCoordinate(sample.left), right = soccerDiagnosticCoordinate(sample.right);
    if (top === null || left === null || right === null || right <= left) continue;
    const cells = [];
    for (const cell of (Array.isArray(sample.cells) ? sample.cells : []).slice(0, 12)) {
      const cellLeft = soccerDiagnosticCoordinate(cell?.left), cellRight = soccerDiagnosticCoordinate(cell?.right);
      if (cellLeft === null || cellRight === null || cellRight <= cellLeft) continue;
      const lines = (Array.isArray(cell?.lines) ? cell.lines : []).slice(0, 4).map(value => soccerDiagnosticLine(value, league)).filter(Boolean);
      if (lines.length) cells.push({ left: cellLeft, right: cellRight, lines });
    }
    if (cells.length) samples.push({ tag: sample.tag, top, left, right, cells });
  }
  return { league, label, modules, counts, paths, samples };
}
function extensionManifestVersion() {
  try { const version = chrome.runtime.getManifest?.()?.version; return typeof version === 'string' && /^\d+(?:\.\d+){1,3}$/.test(version) ? version : null; }
  catch { return null; }
}
async function request(url, options, timeout = 45000) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout); try { return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' }); } finally { clearTimeout(timer); } }
async function json(response) { const text = await response.text(); try { return JSON.parse(text); } catch { throw new Error(`主系統回傳格式錯誤（${response.status}）`); } }
async function sha(value) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value))); return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function collectCandidates(tabs) {
  const candidates = [];
  const silentTabIds = [];
  const sections = [], emptyCaptures = [], soccerLayouts = [];
  for (const tab of tabs) {
    let responded = false;
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => [{ frameId: 0, url: tab.url }]);
    for (const frame of frames || []) try {
      const answer = await chrome.tabs.sendMessage(tab.id, { type: 'TAI888_CAPTURE_BASEBALL_TABLE' }, { frameId: frame.frameId });
      if (answer?.capture?.readerVersion !== VERSION) continue;
      responded = responded || answer?.ok === true;
      if (answer?.ok === true) for (const input of (Array.isArray(answer.capture.soccerLayouts) ? answer.capture.soccerLayouts : []).slice(0, 2)) {
        const layout = sanitizeSoccerLayout(input);
        if (layout) soccerLayouts.push({ tabId: tab.id, frameId: frame.frameId, ...layout });
      }
      for (const item of (Array.isArray(answer?.capture?.sectionDiagnostics) ? answer.capture.sectionDiagnostics : []).slice(0, 24)) {
        if (!LEAGUES.includes(item?.league) || typeof item.label !== 'string' || !/^(?:聯盟|联盟)\s*[:：]?/.test(item.label)
          || item.label.length > 100 || /[<>\u0000-\u001f]/.test(item.label)) continue;
        sections.push({ tabId: tab.id, frameId: frame.frameId, league: item.league, label: item.label, accepted: item.accepted === true });
      }
      const rawCaptures = Array.isArray(answer?.capture?.captures) ? answer.capture.captures : answer?.capture ? [answer.capture] : [];
      for (const rawCapture of rawCaptures) {
        const capture = sanitizeCapture(rawCapture);
        if (answer?.ok && capture.league && !capture.tables.length) emptyCaptures.push({ tabId: tab.id, frameId: frame.frameId, league: capture.league, diagnostics: capture.diagnostics });
        if (answer?.ok && capture.league && capture.tables.length) candidates.push({ tabId: tab.id, frameId: frame.frameId, active: Boolean(tab.active), lastAccessed: Number(tab.lastAccessed || 0), capture, parsed: parseTai888Capture(capture, new Date()) });
      }
    } catch {}
    if (!responded) silentTabIds.push(tab.id);
  }
  return { candidates, silentTabIds, sections, emptyCaptures, soccerLayouts };
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
  return { ok: true, report: { readerVersion: VERSION, extensionManifestVersion: extensionManifestVersion(), createdAt: new Date().toISOString(), silentTabIds: scan.silentTabIds, sections: scan.sections, emptyCaptures: scan.emptyCaptures, soccerLayouts: scan.soccerLayouts, boards } };
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
  const context = { tabCount: 0, silentTabCount: 0, leagues: {}, authority: {} };
  let exceptionCode = '';
  try { return await performSyncAttempt(reason, preferredTabId, context); }
  catch (error) { exceptionCode = syncExceptionCode(error); throw error; }
  finally {
    // Diagnostics use an independent endpoint and never authorize a failed
    // board. Do not let diagnostic/storage/network failure break market sync.
    try {
      const stored = await chrome.storage.local.get(['readerToken', 'readerStatuses', 'deviceId', 'pairedAt']);
      if (stored.deviceId && stored.pairedAt && !(reason !== 'manual' && context.skipped)) {
        const leagues = {};
        for (const league of LEAGUES) {
          const status = stored.readerStatuses?.[league];
          if (status) leagues[league] = { state: status.state, errorCode: status.diagnosticCode || '',
            issues: status.diagnosticIssues || [], rawGameCount: status.rawGameCount || 0,
            marketCount: status.marketCount || 0, boards: context.leagues[league] || [],
            ...(context.authority[league] ? { authority: context.authority[league] } : {}) };
        }
        await getDiagnosticOutbox().enqueue({ schema: DIAGNOSTIC_SCHEMA, reportId: crypto.randomUUID(),
          readerVersion: VERSION, extensionManifestVersion: extensionManifestVersion(),
          createdAt: new Date().toISOString(), tabCount: context.tabCount,
          silentTabCount: context.silentTabCount, exceptionCode, leagues });
        await getDiagnosticOutbox().flush();
      }
    } catch {}
  }
}

async function performSyncAttempt(reason, preferredTabId, context) {
  const stored = await chrome.storage.local.get(['readerToken', 'deviceId', 'autoEnabled', 'readerStatuses', 'lastSuccessfulPayloadHashes', 'lastSuccessfulSyncAts']);
  if (!stored.readerToken) throw new Error('尚未配對，請先輸入一次 Reader 配對密碼。');
  if (reason !== 'manual' && stored.autoEnabled === false) { context.skipped = true; return { ok: true, skipped: true, message: '自動同步已關閉' }; }
  const tabs = [...new Map((await chrome.tabs.query({ url: PATTERNS })).map(tab => [tab.id, tab])).values()];
  context.tabCount = tabs.length;
  if (!tabs.length) {
    const message = '找不到 Tai888 分頁，請確認網站存取權限，並開啟 tai888.in 的「讓分＆大小」頁。';
    await chrome.storage.local.set({ readerStatuses: Object.fromEntries(LEAGUES.map(league => [league, { ok: false, state: 'missing', league, message, readerVersion: VERSION }])) });
    return { ok: false, message };
  }
  let scan = await collectCandidates(tabs);
  if (scan.silentTabIds.length && await recoverTabs(tabs, scan.silentTabIds, { force: reason === 'manual' })) scan = await collectCandidates(tabs);
  context.silentTabCount = scan.silentTabIds.length;
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
      const empty = scan.emptyCaptures.some(item => item.league === league);
      const rejected = scan.sections.find(item => item.league === league && !item.accepted);
      statuses[league] = { ok: false, state: empty || rejected ? 'error' : disconnected ? 'disconnected' : 'missing', league,
        diagnosticCode: empty ? 'no-parsed-games' : rejected ? 'no-board-table' : '',
        message: empty ? `${LABELS[league]}已偵測到聯盟標題，但無法組成賽事列；診斷將自動回傳，不代表未開盤`
          : rejected ? `${LABELS[league]}已看到盤面，但區段未通過辨識；診斷將自動回傳`
          : disconnected ? `${LABELS[league]} Reader 未連線，無法連上頁面讀取程式；請按「修復讀取」或在該分頁按 F5`
          : `未偵測到${LABELS[league]}標準盤；請確認該聯盟分頁已開啟（不能據此判定未開盤）`, readerVersion: VERSION };
      context.leagues[league] = scan.emptyCaptures.filter(item => item.league === league).map(item => ({ diagnostics: item.diagnostics, parsedGameCount: 0, issues: ['no-parsed-games'] }));
      continue;
    }
    const soccer = ['EPL', 'UCL'].includes(league);
    const selection = soccer ? selectAuthoritativeSoccerBoards(own, { now: Date.now(), preferredTabId, league })
      : selectAuthoritativeBoard(own, { now: Date.now(), preferredTabId, league, dateScoped: true });
    context.leagues[league] = (selection.assessed || []).map(item => ({ diagnostics: item.candidate?.capture?.diagnostics,
      parsedGameCount: item.candidate?.parsed?.games?.length || 0, issues: item.issues || [] }));
    if (!selection.ok) {
      if (soccer && selection.diagnosticEvidence) context.authority[league] = selection.diagnosticEvidence;
      const detail = selection.error === 'conflicting-duplicate-rows'
        ? '同場盤口重複且數字不一致，已停止上傳；請重新整理 Tai888 分頁後再同步'
        : selection.error === 'conflicting-duplicate-frames'
        ? '同一分頁內盤口不一致，已停止同步；請重新整理該 Tai888 分頁後再同步'
        : selection.error === 'conflicting-duplicate-tabs'
          ? '同聯盟分頁盤口不一致，已停止同步；請只保留正確盤日的分頁後再同步'
          : selection.assessed?.flatMap(item => item.issues || []).slice(0, 3).join('、');
      statuses[league] = { ok: false, state: 'error', league, diagnosticCode: selection.error,
        diagnosticIssues: selection.assessed?.flatMap(item => item.issues || []),
        message: `${LABELS[league]}已讀取，但檢查未通過${detail ? `：${detail}` : ''}`, readerVersion: VERSION };
      continue;
    }
    const sources = (soccer ? selection.selections : selection.selections || [{ selected: selection.selected }]).map(({ selected, sourceScopes, boardDates }) => {
      // Comparison projections must never replace the captured evidence sent to
      // the server. Each dated upload retains its intact original raw frame.
      const sourcePayload = soccer ? { ...selected.candidate.parsed } : selected.candidate.parsed;
      Object.assign(sourcePayload, { league, readerVersion: VERSION, deviceId: stored.deviceId, pageActivityAt: selected.pageActivityAt, expectedGameCount: selected.expectedGameCount, detectedGameCount: selected.detectedGameCount });
      return { selected, sourcePayload, boardDates: !soccer && Array.isArray(boardDates) ? boardDates : null,
        sourceScopes: soccer && Array.isArray(sourceScopes) ? sourceScopes : [] };
    });
    const { selected, sourcePayload } = sources[0];
    // A frame can win authority for only some dated periods. Keep its complete
    // raw source for reparse, but remove every unselected date and period so a
    // full frame cannot overwrite a different scope's chosen source receipt.
    const payloads = sources.flatMap(source => readerPayloadsByDate(source.sourcePayload,
      soccer ? { soccerScopes: source.sourceScopes } : {}).filter(payload =>
      soccer || source.boardDates === null || source.boardDates.includes(payload.boardDate)));
    if (soccer && !payloads.length) {
      statuses[league] = { ok: false, state: 'error', league, diagnosticCode: 'soccer-authority-date-missing',
        message: `${LABELS[league]}來源盤日尚未通過核對，已停止上傳`, readerVersion: VERSION };
      continue;
    }
    const accepted = [], failures = [];
    for (const payload of payloads) {
      const periodsCovered = soccer ? (payload.periodsCovered?.length ? payload.periodsCovered : ['UNKNOWN']) : null;
      const periodKey = soccer ? periodsCovered.join('+') : '';
      const baseSyncKey = ['NBA', 'NHL', 'EPL', 'UCL'].includes(league) ? `${league}:${payload.boardDate}` : league;
      const syncKey = soccer && periodKey !== 'UNKNOWN' ? `${baseSyncKey}:${periodKey}` : baseSyncKey;
      try {
        const payloadHash = await sha(canonicalReaderPayload(payload)); payload.payloadHash = payloadHash;
        if (shouldSkipSuccessfulPayload({ reason, payloadHash, lastSuccessfulPayloadHash: hashes[syncKey], lastSuccessfulSyncAt: times[syncKey], now: Date.now() })) {
          // A skipped day still contributes to the aggregate only if its
          // previously acknowledged receipt is available.
          const receipt = stored.readerStatuses?.[league]?.dateStatuses?.find(item => item.boardDate === payload.boardDate
            && (!soccer || (item.periodsCovered?.length ? item.periodsCovered.join('+') : 'UNKNOWN') === periodKey));
          if (readerSaveReceiptMatches(receipt?.saveReceipt, league, payload.boardDate, payloadHash)) {
            accepted.push(receipt); results.push({ league, boardDate: payload.boardDate, ...(soccer ? { periodsCovered } : {}), ok: true, skipped: true }); continue;
          }
        }
        const endpoint = ['EPL','UCL'].includes(league) ? '/api/soccer/reader' : league === 'NHL' ? '/api/nhl/reader' : league === 'NBA' ? '/api/nba/reader' : '/api/reader/ingest';
        const wirePayload = league === 'NHL' ? nhlReaderEvidencePayload(payload) : payload;
        const response = await request(`${ORIGIN}${endpoint}`, { method: 'POST', headers: { Authorization: `Bearer ${stored.readerToken}`, 'Content-Type': 'application/json', 'X-Reader-Version': VERSION, 'X-Device-Id': stored.deviceId }, body: JSON.stringify(wirePayload) });
        const data = await json(response); if (response.status === 401) { await chrome.storage.local.remove('readerToken'); throw Object.assign(new Error('Reader 配對已過期，請重新配對'), { status: 401 }); } if (!response.ok || !data.ok) throw Object.assign(new Error(data.error || `同步失敗（${response.status}）`), { status: response.status });
        const saveReceipt = confirmedReaderSaveReceipt(data, payload, payloadHash);
        const now = Date.now(); hashes[syncKey] = payloadHash; times[syncKey] = now;
        accepted.push({ boardDate: payload.boardDate, ...(soccer ? { periodsCovered } : {}), lastSyncAt: now, saveReceipt, rawGameCount: data.rawGameCount, matchedGameCount: integer(data.matchedGameCount, 40), unopenedGameCount: integer(data.unopenedGameCount, 40), marketCount: integer(data.marketCount, 160), directionCount: integer(data.directionCount, 320), partialGameCount: integer(data.partialGameCount, 40), executable: soccer ? false : data.executable === true });
        results.push({ league, boardDate: payload.boardDate, ...(soccer ? { periodsCovered } : {}), ok: true, message: data.message });
      } catch (error) { failures.push({ boardDate: payload.boardDate, ...(soccer ? { periodsCovered } : {}), error: error.message, diagnosticCode: syncExceptionCode(error) }); results.push({ league, boardDate: payload.boardDate, ...(soccer ? { periodsCovered } : {}), ok: false, error: error.message }); }
    }
    const sum = key => accepted.reduce((count, item) => count + Number(item[key] || 0), 0);
    const skippedAlternativeCount = soccer ? sources.reduce((count, source) => count + integer(source.selected.candidate.capture.diagnostics?.skippedAlternativeCount, 1000), 0) : 0;
    statuses[league] = { ok: failures.length === 0, state: failures.length ? 'error' : 'synced', league,
      diagnosticCode: failures[0]?.diagnosticCode || '', diagnosticIssues: failures.map(item => item.diagnosticCode),
      executable: ['NBA', 'NHL', 'EPL', 'UCL'].includes(league) ? accepted.some(item => item.executable) : sum('matchedGameCount') > 0,
      captureOnly: ['NBA', 'NHL', 'EPL', 'UCL'].includes(league), message: failures.length ? failures.map(item => `${item.boardDate}${soccer ? `（${item.periodsCovered.join('/')}）` : ''}：${item.error}`).join('；') : soccer ? `已同步 ${accepted.length} 筆盤面紀錄（${new Set(accepted.map(item => item.boardDate)).size} 個日期）` : `已同步 ${accepted.length} 個日期`,
      ...(soccer ? { gameCountBasis: 'BOARD_RECORDS_NOT_UNIQUE_GAMES', uniqueGameCount: new Set(payloads.flatMap(payload => payload.games).map(game => [game.boardDate,game.boardTime,game.awayCode,game.homeCode].join('|'))).size, periodsCovered: [...new Set(accepted.flatMap(item => item.periodsCovered || []))] } : {}),
      ...(skippedAlternativeCount ? { skippedAlternativeCount } : {}),
      lastSyncAt: accepted.length ? Math.min(...accepted.map(item => item.lastSyncAt)) : 0, lastAttemptAt: Date.now(),
      rawGameCount: sum('rawGameCount'), matchedGameCount: sum('matchedGameCount'), unopenedGameCount: sum('unopenedGameCount'), marketCount: sum('marketCount'), directionCount: sum('directionCount'), partialGameCount: sum('partialGameCount'),
      localDiagnostic: soccer ? sources.map(source => localBoardDiagnostic(source.sourcePayload, source.selected.candidate.capture)).reduce((total,item)=>({openCount:total.openCount+item.openCount,lockedCount:total.lockedCount+item.lockedCount,marketCount:total.marketCount+item.marketCount,sample:[total.sample,item.sample].filter(Boolean).join('｜').slice(0,280)}),{openCount:0,lockedCount:0,marketCount:0,sample:''}) : localBoardDiagnostic(sourcePayload, selected.candidate.capture), boardDate: sourcePayload.boardDate,
      boardDates: soccer ? [...new Set(payloads.map(item => item.boardDate))] : payloads.map(item => item.boardDate), dateStatuses: accepted, dateErrors: failures, readerVersion: VERSION };
    if (skippedAlternativeCount) statuses[league].message += `；略過 ${skippedAlternativeCount} 組無法核對的盤口，已保留其餘有效盤口`;

  }
  await chrome.storage.local.set({ readerStatuses: statuses, lastSuccessfulPayloadHashes: hashes, lastSuccessfulSyncAts: times, pairError: '' });
  const successes = LEAGUES.filter(league => statuses[league]?.ok === true && statuses[league]?.state === 'synced').length;
  return { ok: successes > 0, results, message: `各聯盟檢查完成｜${successes} 個分頁同步成功` };
}
async function readerStatus() { const stored = await chrome.storage.local.get(['readerToken', 'deviceId', 'autoEnabled', 'readerStatuses', 'pairError', 'pairedAt', 'diagnosticDelivery']); return { ok: true, paired: Boolean(stored.readerToken), deviceId: stored.deviceId || null, autoEnabled: stored.autoEnabled !== false, pairedAt: stored.pairedAt || null, statuses: stored.readerStatuses || {}, diagnosticDelivery: stored.diagnosticDelivery || null, error: stored.pairError || '', readerVersion: VERSION }; }

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
