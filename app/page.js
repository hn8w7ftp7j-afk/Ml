'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { APP_VERSION } from '../lib/app-version.js';
import { MARKET_ORDER, breakEvenProbability, hasActualWater } from '../lib/markets.js';
import {
  betIdentity,
  betMatches,
  betPositionIdentity,
  betPriceMatches,
} from '../lib/bet-ledger.js';
import { compareBetPrice } from '../lib/bet-price-comparison.js';
import { priceComparisonLabel, verifiedClosingPriceForBet } from '../lib/bet-price-feed.js';
import { BET_PERIODS, filterBetLedgerByPeriod, summarizeBetLedger } from '../lib/bet-stats.js';
import { teamNameZh, translateTeamText } from '../lib/i18n.js';
import { LEAGUE_IDS, leagueConfig, normalizeLeagueId } from '../lib/leagues.js';
import {
  advanceUnchangedReaderGame,
  coreSnapshotReusable,
  finalizeReaderBoardAtStart,
  gameIsPrestartNow,
  liveReaderHashMatches,
  mergeReaderStatusHighWater,
  readerCoverageCounts,
  readerHashKey,
  shouldAcceptReaderStatus,
  shouldAcknowledgeReaderHash,
  touchReaderHeartbeat,
} from '../lib/client-analysis-state.js';
import { assessCoreSnapshotFreshnessV109 } from '../lib/analysis-refresh-policy-v109.js';
import { BET_ORDER_MIN_SCORE, buildBetOrderEntries, groupBetOrderEntries } from '../lib/bet-order.js';
import {
  analysisBoardCacheKey,
  createAnalysisBoardCacheEntry,
  restoreAnalysisBoardCache,
  upsertAnalysisBoardCache,
} from '../lib/analysis-board-cache-v1.js';
import {
  analysisHasCalculatedDirections,
  analysisIsUnopenedOnly,
  readerEvidenceIsOlder,
  readerMarketsLoseCalculatedCoverage,
  readerResultIsStale,
  shouldPreserveCalculatedAnalysis,
} from '../lib/analysis-display-state-v116.js';
import {
  CLOUD_LEDGER_VISIBLE_REFRESH_MS,
  cloudLedgerAutomaticRefreshAllowed,
  cloudLedgerRetryDelay,
} from '../lib/cloud-ledger-sync-policy.js';

const VERSION = APP_VERSION;
const READER_DOWNLOAD_PATH = '/downloads/Tai888-Reader-v2.1.19-VERIFIED-RESCAN.zip';
const STORAGE = 'sports-positive-ev-v10-0-0';
const BET_BACKUP_STORAGE = 'sports-positive-ev-bets-backup-v2';
const BET_CLOUD_MIGRATION_STORAGE = 'sports-positive-ev-bets-cloud-migrated-v1';
const ANALYSIS_BOARD_CACHE_STORAGE = 'sports-positive-ev-analysis-board-v1';
const ANALYSIS_JOB_STORAGE = 'sports-positive-ev-background-jobs-v1';
// A cold Production analysis can legitimately spend close to a minute fetching
// point-in-time data and building the deterministic distribution. iOS Safari
// reports an AbortController timeout as the unhelpful `Load failed`, so keep the
// browser timeout above the 90 second server route ceiling.
const ANALYSIS_REQUEST_TIMEOUT_MS = 120_000;
const ANALYSIS_TRANSIENT_RETRY_DELAYS_MS = [0, 2500, 6000];
const READER_RECHECK_INTERVAL_MS = 30 * 1000;
const OFFICIAL_PRESTART_RECHECK_MS = 60 * 1000;
const CORE_DATA_BLOCK_RECHECK_MS = 5 * 60 * 1000;
const BET_PRICE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const LEGACY_KEYS = ['sports-positive-ev-v9-7-0', 'sports-positive-ev-v9-6-0', 'sports-positive-ev-v9-5-0', 'mlb-positive-ev-v9-4-4', 'mlb-positive-ev-v9-4-3', 'mlb-positive-ev-v9-4-2', 'mlb-positive-ev-v9-4-1', 'mlb-positive-ev-v9-4-0', 'mlb-positive-ev-v9-3-4', 'mlb-positive-ev-v9-3-3', 'mlb-positive-ev-v9-3-2', 'mlb-positive-ev-v9-3', 'mlb-positive-ev-v9-2', 'mlb-positive-ev-v9-1-preview', 'mlb-positive-ev-v8-4', 'mlb-positive-ev-v7'];
const DEFAULT_SETTINGS = {
  unitValue: 10000,
  rebateRate: 0.015,
  fallbackWater: { 全場讓分: 0.95, 全場大小: 0.94, 上半讓分: 0.94, 上半大小: 0.93 },
};

function normalizeSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const { simulationsPerScenario: ignoredLegacySimulationSetting, ...current } = source;
  return {
    ...DEFAULT_SETTINGS,
    ...current,
    fallbackWater: { ...DEFAULT_SETTINGS.fallbackWater, ...(current.fallbackWater || {}) },
  };
}

const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const pct = value => value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(2)}%`;
const signedPct = value => value == null || !Number.isFinite(Number(value))
  ? '—'
  : `${Number(value) > 0 ? '+' : ''}${(Number(value) * 100).toFixed(2)}%`;
const waterText = value => hasActualWater(value) ? Number(value).toFixed(3) : '水位未提供';
const moneyText = value => value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value) >= 0 ? '+' : ''}${Math.round(Number(value)).toLocaleString()}元`;
const matchup = game => `${translateTeamText(game?.away || '')} 對 ${translateTeamText(game?.home || '')}`;

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

// W/R are mathematical outputs of the frozen score distribution. Qualification
// gates may stop ranking or betting, but must never hide an already calculated
// value. The raw aliases keep older cached/PIT responses readable during rollout.
function modelEvValue(row) {
  return firstFiniteNumber(row?.modelEV, row?.modelEv, row?.rawWeightedEV, row?.weightedEV);
}

function robustEvValue(row) {
  return firstFiniteNumber(row?.robustEV, row?.robustEv, row?.rawRobustEV);
}

function formulaScoreValue(row) {
  return firstFiniteNumber(row?.formulaDiagnosticScore, row?.shadowDiagnosticScore);
}

function scoreIcon(score, qaPassed = true) {
  if (!qaPassed || score == null) return '⛔';
  if (score >= 8.5) return '🔥';
  if (score >= 7.2) return '🟢';
  if (score > 6.6) return '🟡';
  return '⚪';
}

function diagnosticWarnings(row) {
  const canonical = Array.isArray(row?.scoreAudit?.diagnosticWarnings)
    ? row.scoreAudit.diagnosticWarnings.filter(Boolean)
    : Array.isArray(row?.diagnosticWarnings) ? row.diagnosticWarnings.filter(Boolean) : [];
  if (canonical.length) return [...new Set(canonical)];
  const gap = firstFiniteNumber(row?.tai888MarketProbabilityGap, row?.rawMarketProbabilityGap);
  const warnings = [
    ...(gap != null && gap > 0.10 ? [`模型／Tai888去水機率高度分歧 ${(gap * 100).toFixed(2)}pp`] : []),
    ...(row?.extremeEvReviewRequired === true || Number(modelEvValue(row)) >= 0.20 ? ['極高模型EV，建議複核'] : []),
    ...(row?.scoreAudit?.diagnosticWarnings || []),
    ...(row?.scoreAudit?.plausibility?.auditWarnings || []),
    ...(row?.scoreAudit?.extremeEvReview?.auditWarnings || []),
    ...(row?.evCalibration?.auditWarnings || []),
  ];
  return [...new Set(warnings.filter(Boolean))];
}

function directionStatus(row) {
  const explicit = String(row?.status || row?.slotStatus || row?.directionStatus || '').toUpperCase();
  if (explicit === 'CALCULATED' || explicit === 'UNOPENED' || explicit === 'BLOCKED') return explicit;
  return modelEvValue(row) == null ? 'UNOPENED' : 'CALCULATED';
}

function directionQaPassed(row) {
  const canonical = String(row?.qa?.status || '').trim().toUpperCase();
  const qaPassed = canonical
    ? canonical === 'PASS'
    : row?.scoreAudit?.ok === true;
  return qaPassed && row?.pairAudit?.passed !== false;
}

function directionIdentity(row) {
  return String(row?.slotId || row?.directionKey || row?.id || `${row?.market || ''}|||${row?.pick || row?.direction || row?.side || ''}`);
}

function analysisDirectionRows(analysis) {
  const results = Array.isArray(analysis?.results) ? analysis.results : [];
  const slots = Array.isArray(analysis?.directionSlots) ? analysis.directionSlots
    : Array.isArray(analysis?.slots) ? analysis.slots
      : [];
  if (!slots.length) return results;
  const byIdentity = new Map(results.map(row => [directionIdentity(row), row]));
  return slots.map(slot => {
    const embedded = slot?.result && typeof slot.result === 'object' ? slot.result : {};
    const matching = byIdentity.get(directionIdentity(slot)) || {};
    return { ...slot, ...matching, ...embedded, status: slot?.status || matching?.status || embedded?.status };
  });
}

function directionLabel(row, game) {
  if (row?.pick) return translateTeamText(row.pick);
  if (row?.label || row?.directionLabel) return translateTeamText(row.label || row.directionLabel);
  const identity = `${row?.slotId || ''} ${row?.directionKey || ''} ${row?.direction || ''} ${row?.side || ''}`.toUpperCase();
  if (/OVER|大分|^大$/.test(identity)) return '大分方向';
  if (/UNDER|小分|^小$/.test(identity)) return '小分方向';
  if (/HOME|主隊|主方/.test(identity)) return `${translateTeamText(game?.home || '') || '主隊'}方向`;
  if (/AWAY|客隊|客方/.test(identity)) return `${translateTeamText(game?.away || '') || '客隊'}方向`;
  return '待開盤方向';
}

function compareDirectionsByScore(left, right) {
  return (formulaScoreValue(right) ?? -Infinity) - (formulaScoreValue(left) ?? -Infinity)
    || (modelEvValue(right) ?? -Infinity) - (modelEvValue(left) ?? -Infinity)
    || (robustEvValue(right) ?? -Infinity) - (robustEvValue(left) ?? -Infinity);
}
const referenceEvidenceFreshNow = (row, now = Date.now()) => {
  const expiresAt = Date.parse(row?.marketVerification?.referenceConsensusExpiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt > Number(now);
};
function outcomeText(value) {
  const outcome = String(value || '').toUpperCase();
  if (outcome === 'WIN') return '贏';
  if (outcome === 'LOSS') return '輸';
  if (outcome === 'PUSH') return '走水';
  if (outcome === 'HALF_WIN') return '贏半';
  if (outcome === 'HALF_LOSS') return '輸半';
  if (outcome === 'VOID') return '作廢';
  if (outcome === 'MIXED') return '混合結算';
  return '待結算';
}

function statusText(value) {
  const status = String(value || '').toUpperCase();
  if (status === 'SETTLED') return '已結算';
  if (status === 'MANUAL_REVIEW') return '需人工確認';
  if (status === 'VOID') return '作廢';
  if (status === 'CANCELLED') return '已取消';
  return '待賽果';
}

function coveragePendingText(coverage) {
  return [
    coverage?.locked ? `鎖盤等待 ${coverage.locked} 場` : '',
    coverage?.notRendered ? `Reader未呈現 ${coverage.notRendered} 場` : '',
  ].filter(Boolean).join('｜') || '等待開盤 0 場';
}

function taipeiDate(offset = 0) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + offset * 86400000));
}

function localTime(value) {
  if (!value) return '時間未定';
  try {
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(value));
  } catch { return String(value); }
}

function safeParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function loadCompactStore() {
  if (typeof window === 'undefined') return { settings: DEFAULT_SETTINGS, bets: [], activeLeague: 'MLB' };
  try {
    const backup = safeParse(window.localStorage.getItem(BET_BACKUP_STORAGE) || 'null');
    const backupBets = Array.isArray(backup) ? backup.slice(0, 5000) : [];
    const own = safeParse(window.localStorage.getItem(STORAGE) || 'null');
    if (own && typeof own === 'object') {
      const primaryBets = Array.isArray(own.bets) ? own.bets.slice(0, 5000) : [];
      return {
        settings: normalizeSettings(own.settings),
        bets: cloudBetMigrationComplete() ? primaryBets : recoverLocalBetCopies(primaryBets, backupBets),
        activeLeague: normalizeLeagueId(own.activeLeague),
      };
    }
    for (const key of LEGACY_KEYS) {
      const legacy = safeParse(window.localStorage.getItem(key) || 'null');
      if (!legacy || typeof legacy !== 'object') continue;
      return {
        settings: normalizeSettings(legacy.settings),
        bets: cloudBetMigrationComplete()
          ? (Array.isArray(legacy.bets) ? legacy.bets.slice(0, 5000) : [])
          : recoverLocalBetCopies(Array.isArray(legacy.bets) ? legacy.bets.slice(0, 5000) : [], backupBets),
        activeLeague: normalizeLeagueId(legacy.activeLeague || 'MLB'),
      };
    }
    if (!cloudBetMigrationComplete() && backupBets.length) {
      return { settings: DEFAULT_SETTINGS, bets: backupBets, activeLeague: 'MLB' };
    }
  } catch {
    // Safari private mode, quota failures and corrupted legacy storage must never crash the app.
  }
  return { settings: DEFAULT_SETTINGS, bets: [], activeLeague: 'MLB' };
}

function saveCompactStore(value) {
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify({ settings: value.settings, bets: value.bets.slice(0, 5000), activeLeague: normalizeLeagueId(value.activeLeague) }));
    if (value.bets.length) window.localStorage.setItem(BET_BACKUP_STORAGE, JSON.stringify(value.bets.slice(0, 5000)));
    else if (cloudBetMigrationComplete()) window.localStorage.removeItem(BET_BACKUP_STORAGE);
    return true;
  } catch {
    try { window.localStorage.removeItem(STORAGE); } catch {}
    return false;
  }
}

function loadAnalysisBoardCache(league, date) {
  try {
    const store = safeParse(window.localStorage.getItem(ANALYSIS_BOARD_CACHE_STORAGE) || 'null');
    const entry = store?.[analysisBoardCacheKey(league, date)];
    return restoreAnalysisBoardCache(entry, { league, date });
  } catch {
    return [];
  }
}

function saveAnalysisBoardCache(league, date, board) {
  const entry = createAnalysisBoardCacheEntry({ league, date, board });
  if (!entry) return false;
  try {
    const current = safeParse(window.localStorage.getItem(ANALYSIS_BOARD_CACHE_STORAGE) || 'null');
    window.localStorage.setItem(ANALYSIS_BOARD_CACHE_STORAGE, JSON.stringify(upsertAnalysisBoardCache(current, entry)));
    return true;
  } catch {
    // If older cached slates exhausted Safari's small quota, retain the current
    // slate alone. Private mode may still reject it; live analysis continues.
    try {
      window.localStorage.setItem(ANALYSIS_BOARD_CACHE_STORAGE, JSON.stringify({
        [analysisBoardCacheKey(league, date)]: entry,
      }));
      return true;
    } catch { return false; }
  }
}

function backgroundJobKey(league, date) {
  return `${String(league || '').toUpperCase()}|||${String(date || '')}`;
}

function loadBackgroundJob(league, date) {
  try {
    const jobs = safeParse(window.localStorage.getItem(ANALYSIS_JOB_STORAGE) || 'null');
    return jobs?.[backgroundJobKey(league, date)] || null;
  } catch { return null; }
}

function saveBackgroundJob(job) {
  try {
    const jobs = safeParse(window.localStorage.getItem(ANALYSIS_JOB_STORAGE) || 'null');
    const source = jobs && typeof jobs === 'object' && !Array.isArray(jobs) ? jobs : {};
    window.localStorage.setItem(ANALYSIS_JOB_STORAGE, JSON.stringify({
      ...source,
      [backgroundJobKey(job.league, job.date)]: job,
    }));
    return true;
  } catch { return false; }
}

function clearBackgroundJob(league, date, runId = '') {
  try {
    const jobs = safeParse(window.localStorage.getItem(ANALYSIS_JOB_STORAGE) || 'null');
    if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return;
    const key = backgroundJobKey(league, date);
    if (runId && jobs[key]?.runId !== runId) return;
    const { [key]: omitted, ...remaining } = jobs;
    window.localStorage.setItem(ANALYSIS_JOB_STORAGE, JSON.stringify(remaining));
  } catch {}
}

function recoverLocalBetCopies(primary, backup) {
  const result = [];
  const known = new Set();
  for (const bet of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(backup) ? backup : [])]) {
    const key = String(bet?.id || `${bet?.league || 'MLB'}|||${bet?.date || ''}|||${bet?.gamePk || ''}|||${bet?.market || ''}|||${bet?.pick || ''}|||${bet?.water || ''}|||${bet?.placedAt || ''}`);
    if (!key || known.has(key)) continue;
    known.add(key);
    result.push(bet);
  }
  return result.sort((left, right) => Date.parse(right?.placedAt || 0) - Date.parse(left?.placedAt || 0)).slice(0, 5000);
}

function migrateLegacyLocalBets(values) {
  return (Array.isArray(values) ? values : []).slice(0, 5000).map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const bet = value.league ? value : { ...value, league: 'MLB' };
    if (bet.readerEvidenceStatus === 'SERVER_VERIFIED_CURRENT_READER'
      && bet.pitEvidenceVerified === true
      && bet.pitPredictionStatus === 'IMMUTABLE_PIT_VERIFIED') return bet;
    return {
      ...bet,
      status: 'MANUAL_REVIEW', settlement: null, score: null, scoreStatus: 'LEGACY_INVALID',
      betSource: 'LEGACY_LOCAL_QUARANTINE', performanceEligibility: 'EXCLUDED_UNVERIFIABLE_LEGACY',
      calibrationEligibility: 'EXCLUDED_UNVERIFIABLE_LEGACY', pitEvidenceVerified: false,
    };
  });
}

function cloudBetMigrationComplete() {
  try { return window.localStorage.getItem(BET_CLOUD_MIGRATION_STORAGE) === '1'; }
  catch { return false; }
}

function markCloudBetMigrationComplete() {
  try { window.localStorage.setItem(BET_CLOUD_MIGRATION_STORAGE, '1'); }
  catch {}
}

async function requestJSON(url, options = {}, timeoutMs = 180000, { allowApplicationFailure = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`伺服器回傳格式錯誤（${response.status}）`); }
    if (!response.ok || (data.ok === false && !allowApplicationFailure)) {
      const error = new Error(data.error || `請求失敗（${response.status}）`);
      error.status = response.status;
      error.code = data.code || '';
      error.blocking = Array.isArray(data.blocking) ? data.blocking : [];
      error.warnings = Array.isArray(data.warnings) ? data.warnings : [];
      const retryAfterHeader = Number(response.headers.get('retry-after'));
      const retryAfterBody = Number(data.retryAfterSeconds);
      const retryAfterSeconds = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader
        : Number.isFinite(retryAfterBody) && retryAfterBody > 0 ? retryAfterBody : 0;
      error.retryAfterMs = retryAfterSeconds * 1000;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('分析逾時，請稍後重試');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function analysisFailureState(value) {
  const source = value && typeof value === 'object' ? value : { error: value };
  const message = String(source.error || source.message || value || '背景分析失敗');
  const code = String(source.code || '');
  const numericStatus = Number(source.status);
  const status = Number.isFinite(numericStatus) ? numericStatus : null;
  const blocking = Array.isArray(source.blocking) ? source.blocking.map(String) : [];
  const warnings = Array.isArray(source.warnings) ? source.warnings.map(String) : [];
  const blocked = source.blocked === true
    || code === 'CORE_DATA_MISSING'
    || status === 422
    || /資料不足.*不評分|QA BLOCK|比賽已開打或結束/.test(message);
  const permanent = blocked
    || code === 'PIT_PERSISTENCE_REQUIRED'
    || [400, 401, 403, 404, 409, 413].includes(status)
    || /^INVALID_[A-Z_]+$/.test(code)
    || code === 'GAME_ALREADY_STARTED';
  return { message, code, status, blocking, warnings, blocked, permanent };
}

function readerGameEvidenceHash(value) {
  return String(value?.readerProvenance?.readerGameMarketHash
    || value?.readerGameMarketHash
    || value?.readerPayloadHash
    || '');
}

function coreDataBlockKey(league, date, gamePk, evidenceHash) {
  return `${String(league || '').toUpperCase()}|||${String(date || '')}|||${Number(gamePk) || ''}|||${String(evidenceHash || '')}`;
}

function cloudLedgerFailureState(error) {
  return {
    state: 'unavailable',
    code: String(error?.code || 'DATABASE_UNAVAILABLE'),
    message: String(error?.message || '永久資料庫目前無法使用'),
  };
}

function transientAnalysisError(error) {
  if (String(error?.code || '') === 'PIT_PERSISTENCE_REQUIRED') return false;
  if (Number.isFinite(Number(error?.status))) return Number(error.status) >= 500;
  return /Load failed|Failed to fetch|NetworkError|network request failed|分析逾時/i.test(String(error?.message || error));
}

async function requestAnalysisWithResume(options) {
  let failure;
  for (let attempt = 0; attempt < ANALYSIS_TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    const delay = ANALYSIS_TRANSIENT_RETRY_DELAYS_MS[attempt];
    if (delay) await new Promise(resolve => window.setTimeout(resolve, delay));
    try { return await requestJSON('/api/analyze', options, ANALYSIS_REQUEST_TIMEOUT_MS); }
    catch (error) {
      failure = error;
      if (!transientAnalysisError(error) || attempt === ANALYSIS_TRANSIENT_RETRY_DELAYS_MS.length - 1) throw error;
    }
  }
  throw failure;
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function scoreQaFailures(row) {
  return [...new Set([
    ...(row?.qa?.reasons || []),
    ...(row?.scoreAudit?.baseQa?.failures || []),
    ...(row?.scoreAudit?.boundary?.errors || []),
    ...(row?.scoreAudit?.thirdAudit?.failures || []),
    ...(row?.scoreAudit?.plausibility?.failures || []),
    ...(row?.pairAudit?.failures || []),
  ].filter(Boolean))];
}

function betRecordable(item, row, now = Date.now(), betsEnabled = true, currentReaderPrice = false, cloudLedgerWritable = true) {
  return betsEnabled
    && cloudLedgerWritable === true
    && currentReaderPrice === true
    && readerAnalysisRevisionReady(item)
    && item?.customData?.pitPersistence?.confirmed === true
    && gameIsPrestartNow(item?.game, now)
    && item?.actualSource?.provider === 'TAI888_READER_AUTO'
    && row?.sourceType === 'ACTUAL_TW_CREDIT'
    && row?.provider === 'TAI888_READER_AUTO'
    && row?.evCalibration?.actualReaderEligible === true
    && hasActualWater(row?.water)
    && row?.waterEstimated !== true;
}

function readerAnalysisRevisionReady(item) {
  return item?.status === 'done'
    && item?.restoredFromCache !== true
    && item?.pendingReaderAnalysis !== true
    && item?.preservedCurrentReaderGame !== true
    && item?.readerWaitingHandled !== true
    && item?.latestMarketCoverage == null
    && item?.latestReaderSource == null
    && item?.analysisFailure == null;
}

function markReaderBoardVerificationBlocked(item) {
  if (item?.actualSource?.provider !== 'TAI888_READER_AUTO') return item;
  const preserve = analysisHasCalculatedDirections(item?.customData);
  return {
    ...item,
    readerPayloadHash: null,
    latestMarketCoverage: { openMarkets: 0, availableMarkets: [], blockedMarkets: [] },
    latestReaderSource: null,
    pendingReaderAnalysis: false,
    preservedCurrentReaderGame: preserve,
    readerWaitingHandled: true,
    analysisFailure: null,
    status: preserve ? 'done' : 'unopened',
    statusLabel: preserve
      ? 'Reader資料驗證未通過｜保留上一版分析｜停止下注'
      : 'Reader資料驗證未通過｜停止分析',
    error: '',
  };
}

function betActionState({ latest = null, recordable = false, inactiveNotice = '', cloudLedgerUnavailable = false }) {
  if (latest) return {
    text: '已下注 ✓',
    title: '此方向已經記錄；盤口或水位變動也不再新增',
    disabled: true,
  };
  if (recordable) return {
    text: '紀錄實際下注',
    title: '記錄目前實際下注盤口與水位',
    disabled: false,
  };
  if (cloudLedgerUnavailable) return {
    text: '永久帳本暫停',
    title: '永久雲端帳本目前無法寫入；恢復後會自動開放記錄',
    disabled: true,
  };
  if (inactiveNotice.includes('PIT')) return {
    text: 'PIT未保存',
    title: 'PIT永久保存尚未確認；確認後會自動開放記錄',
    disabled: true,
  };
  if (inactiveNotice.includes('開打') || inactiveNotice.includes('已開始')) return {
    text: '已開賽',
    title: '已達官方預定開打時間，停止記錄新下注',
    disabled: true,
  };
  if (inactiveNotice.includes('Reader')) return {
    text: '等待Reader',
    title: '等待Reader最新盤口驗證；完成後會自動開放記錄',
    disabled: true,
  };
  return {
    text: '暫不可記錄',
    title: '目前未通過實際下注記錄條件',
    disabled: true,
  };
}

function compactAnalysisData(data) {
  return {
    game: data.game,
    context: data.context,
    analysis: data.analysis,
    pitPersistence: data.pitPersistence || null,
    openMarkets: data.openMarkets || [],
  };
}

function calibrationFeatureTimes(context) {
  const fallback = context?.fetchedAt;
  const rows = {};
  for (const item of context?.featureProvenance || []) {
    const name = String(item?.featureName || '').trim();
    const value = item?.observedAt || item?.asOf || fallback;
    if (name && Number.isFinite(Date.parse(String(value || '')))) rows[name] = new Date(value).toISOString();
  }
  if (!Object.keys(rows).length && Number.isFinite(Date.parse(String(fallback || '')))) rows.coreSnapshot = new Date(fallback).toISOString();
  return rows;
}

function LoadingLine({ progress }) {
  if (!progress?.active) return null;
  const ratio = progress.total ? Math.round(progress.done / progress.total * 100) : 0;
  const running = Math.max(0, Number(progress.running) || 0);
  const queued = Math.max(0, Number(progress.total || 0) - Number(progress.done || 0) - running);
  const detail = running || queued
    ? `${progress.done} 完成｜${running} 處理中｜${queued} 排隊`
    : `${progress.done}/${progress.total}`;
  return <div className="progressBox"><div className="progressTop"><strong>{progress.label}</strong><span>{detail}</span></div><div className="progressTrack"><i style={{ width: `${ratio}%` }}/></div></div>;
}

function PriceComparisonPanel({ title, referenceLabel, bet, reference, comparison, closing = false }) {
  const status = comparison?.combinedStatus || 'UNKNOWN';
  const detail = comparison?.comparable
    ? `盤口：${comparison.lineLabel || '無法比較'}｜水位：${comparison.waterLabel || '無法比較'}`
    : comparison?.reason || '場次方向、盤口或水位資料不足';
  return <div className={`priceComparison ${closing ? 'closing' : 'live'} ${String(status).toLowerCase()}`}>
    <div className="priceComparisonHead"><span>{title}</span><strong>{priceComparisonLabel(status)}</strong></div>
    <div className="priceComparisonRows">
      <span>下注時盤口：{translateTeamText(bet?.pick)}｜{waterText(bet?.water)}</span>
      <span>{referenceLabel}：{translateTeamText(reference?.pick)}｜{waterText(reference?.water)}</span>
    </div>
    <small>{detail}</small>
    {comparison?.keyDifference?.text && <b>關鍵洞口差：{comparison.keyDifference.text}</b>}
    {closing && <em>Closing CLV 依收盤逐比分 payoff 比較，洞口的 u 差不是 CLV 百分比。</em>}
  </div>;
}

function BetPriceComparison({ bet, currentRow = null, game = null, closingRow = null, readerChecked = false, showExactLabel = false }) {
  if (!bet) return null;
  const currentComparison = currentRow ? compareBetPrice({ bet, row: currentRow, game: game || bet, rebateRate: 0.015 }) : null;
  const verifiedClosing = closingRow || verifiedClosingPriceForBet(bet);
  const closingComparison = verifiedClosing
    ? compareBetPrice({ bet, row: verifiedClosing, game: game || bet, rebateRate: 0.015 })
    : null;
  const showCurrent = currentComparison && currentComparison.exact !== true;
  return <div className="priceComparisonStack">
    {showExactLabel && currentComparison?.exact === true && <div className="priceComparisonExact">已下注 ✓</div>}
    {showCurrent && <PriceComparisonPanel title="即時 Reader 比較" referenceLabel="Reader目前盤口" bet={bet} reference={currentRow} comparison={currentComparison}/>} 
    {!currentRow && readerChecked && bet.status === 'OPEN' && <div className="priceComparisonUnavailable">Reader目前盤口：等待該聯盟最新同步；不使用舊盤冒充目前盤。</div>}
    {closingComparison && <PriceComparisonPanel title="Closing CLV" referenceLabel="Closing盤口" bet={bet} reference={verifiedClosing} comparison={closingComparison} closing/>}
  </div>;
}

function SummaryCards({ summary }) {
  const values = [
    ['下注', summary?.bets ?? 0],
    ['已結算', summary?.settled ?? 0],
    ['待結算', summary?.open ?? 0],
    ['贏／輸／走', `${summary?.wins ?? 0}／${summary?.losses ?? 0}／${summary?.pushes ?? 0}`],
    ['贏半／輸半', `${summary?.halfWins ?? 0}／${summary?.halfLosses ?? 0}`],
    ['有效勝率', pct(summary?.winRate)],
    ['總下注金額', moneyText(summary?.placedStake)],
    ['已結算本金', moneyText(summary?.totalStake)],
    ['淨盈虧', moneyText(summary?.netPnl)],
    ['ROI', pct(summary?.roi)],
    ['退水', moneyText(summary?.rebate)],
    ['隔離舊紀錄', summary?.quarantined ?? 0],
  ];
  return <div className="ledgerSummary">
    {values.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
  </div>;
}

function BreakdownButton({ label, summary, active = false, onClick }) {
  return <button className={`breakdownButton ${active ? 'active' : ''}`} onClick={onClick}>
    <span>{label}</span>
    <b>{summary?.bets ?? 0} 注｜{summary?.settled ?? 0} 已結算</b>
    <small>{summary?.wins ?? 0}勝／{summary?.losses ?? 0}敗／{summary?.pushes ?? 0}走｜勝率 {pct(summary?.winRate)}</small>
    <strong className={Number(summary?.netPnl || 0) >= 0 ? 'positive' : 'negative'}>{moneyText(summary?.netPnl)}</strong>
  </button>;
}

function BetLedgerDashboard({ bets, cloudLedgerStatus, reportCloudLedgerFailure, period, setPeriod, selectedLeague, setSelectedLeague, selectedMarket, setSelectedMarket, refreshSettlements }) {
  const [priceFeed, setPriceFeed] = useState({});
  const [priceFeedChecked, setPriceFeedChecked] = useState(false);
  const priceFeedBusyRef = useRef(false);
  const priceFeedRetryAtRef = useRef(0);
  const periodBets = useMemo(() => filterBetLedgerByPeriod(bets, period), [bets, period]);
  const leagueBets = useMemo(() => selectedLeague === 'ALL'
    ? periodBets
    : periodBets.filter(bet => normalizeLeagueId(bet?.league) === selectedLeague), [periodBets, selectedLeague]);
  const filteredBets = useMemo(() => selectedMarket === 'ALL'
    ? leagueBets
    : leagueBets.filter(bet => bet?.market === selectedMarket), [leagueBets, selectedMarket]);
  const summary = useMemo(() => summarizeBetLedger(filteredBets).overall, [filteredBets]);
  const priceBetIds = useMemo(() => filteredBets
    .filter(bet => bet?.status === 'OPEN' && bet?.id)
    .slice(0, 300)
    .map(bet => bet.id), [filteredBets]);
  const priceRequestKey = priceBetIds.join('|');
  const periodLabel = BET_PERIODS.find(item => item.id === period)?.label || '全部';
  const leagueLabel = selectedLeague === 'ALL' ? '全部聯盟' : leagueConfig(selectedLeague).label;
  const marketLabel = selectedMarket === 'ALL' ? '全部市場' : selectedMarket;
  const chooseLeague = value => {
    setSelectedLeague(value);
    setSelectedMarket('ALL');
  };
  const choosePeriod = value => {
    setPeriod(value);
    setSelectedLeague('ALL');
    setSelectedMarket('ALL');
  };
  useEffect(() => {
    let disposed = false;
    setPriceFeed({});
    setPriceFeedChecked(priceBetIds.length === 0);
    if (!priceBetIds.length || cloudLedgerStatus?.state === 'unavailable') return () => { disposed = true; };
    const refresh = async () => {
      if (!cloudLedgerAutomaticRefreshAllowed({
        storageReady: true,
        tab: 'bets',
        visibilityState: document.visibilityState,
        busy: priceFeedBusyRef.current,
        now: Date.now(),
        retryAt: priceFeedRetryAtRef.current,
      })) return;
      priceFeedBusyRef.current = true;
      try {
        const data = await requestJSON('/api/bet-prices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ betIds: priceBetIds }),
        }, 30_000);
        if (disposed) return;
        const next = {};
        for (const item of Array.isArray(data?.prices) ? data.prices : []) {
          if (item?.betId) next[item.betId] = item;
        }
        setPriceFeed(next);
        priceFeedRetryAtRef.current = 0;
      } catch (cause) {
        priceFeedRetryAtRef.current = Date.now() + cloudLedgerRetryDelay(cause);
        if (String(cause?.code || '').startsWith('DATABASE_') || Number(cause?.status) >= 500) {
          reportCloudLedgerFailure(cause);
        }
        // Keep the ledger stable; an unavailable Reader comparison must not hide the bet.
      } finally {
        priceFeedBusyRef.current = false;
        if (!disposed) setPriceFeedChecked(true);
      }
    };
    refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    const timer = window.setInterval(refresh, BET_PRICE_REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [priceRequestKey, cloudLedgerStatus?.state]);
  return <section className="panel ledgerPanel">
    <div className="panelHead"><div><span className="kicker">四聯盟整合帳本</span><h2>實際下注紀錄與績效</h2></div><button className="textButton" onClick={() => refreshSettlements('', { force: true })}>更新全部賽果</button></div>
    {cloudLedgerStatus?.state === 'unavailable' && <div className="errorBox" role="alert"><strong>永久雲端帳本目前無法讀取</strong><br/>{cloudLedgerStatus.message}<br/>下方若顯示 0 注，只代表這台裝置沒有可用暫存，不代表資料庫內沒有紀錄；系統不會把失敗回應冒充空帳本。</div>}
    <div className="periodTabs" aria-label="下注期間">
      {BET_PERIODS.map(item => <button key={item.id} className={period === item.id ? 'active' : ''} onClick={() => choosePeriod(item.id)}>{item.label}</button>)}
    </div>
    <div className="ledgerPath">{periodLabel}｜{leagueLabel}｜{marketLabel}</div>
    <SummaryCards summary={summary}/>

    <div className="ledgerSectionHead"><h3>1. 選擇聯盟範圍</h3></div>
    <div className="leagueScopeTabs" aria-label="聯盟統計範圍">
      <button className={selectedLeague === 'ALL' ? 'active' : ''} onClick={() => chooseLeague('ALL')}>全部聯盟</button>
      {LEAGUE_IDS.map(id => <button key={id} className={selectedLeague === id ? 'active' : ''} onClick={() => chooseLeague(id)}>{id}<small>{leagueConfig(id).shortLabel}</small></button>)}
    </div>

    <div className="ledgerSectionHead"><h3>2. {leagueLabel}｜四種市場輸贏</h3>{selectedMarket !== 'ALL' && <button className="textButton" onClick={() => setSelectedMarket('ALL')}>回全部市場</button>}</div>
    <div className="breakdownGrid marketBreakdown">
      {MARKET_ORDER.map(market => {
        const rows = leagueBets.filter(bet => bet?.market === market);
        return <BreakdownButton key={market} label={market} active={selectedMarket === market} summary={summarizeBetLedger(rows).overall} onClick={() => setSelectedMarket(selectedMarket === market ? 'ALL' : market)}/>;
      })}
    </div>

    <div className="ledgerSectionHead"><h3>3. 下注明細</h3><span>{filteredBets.length} 注｜不可變帳本</span></div>
    {filteredBets.length ? filteredBets.map(bet => <div className="betRow" key={bet.id}>
      <div><strong><span className="leagueBadge inline">{bet.league}</span>{translateTeamText(bet.pick)}｜{waterText(bet.water)}</strong><span>{translateTeamText(bet.matchup)}｜{bet.market}｜{statusText(bet.status)}{bet.settlement?.outcome ? `｜${outcomeText(bet.settlement.outcome)}` : ''}</span><small>下注：{localTime(bet.placedAt)}｜{Number(bet.stake || 0).toLocaleString()}元｜{String(bet.performanceEligibility || '').startsWith('EXCLUDED_') ? '不可驗證舊紀錄：不納入績效' : '模型分數未列入績效'}</small><BetPriceComparison bet={bet} currentRow={priceFeed[bet.id]?.current || null} closingRow={priceFeed[bet.id]?.closing || null} readerChecked={priceFeedChecked} showExactLabel/></div>
      <div className="betRowResult"><strong>{bet.status === 'SETTLED' ? moneyText(bet.settlement?.netProfit) : '待結算'}</strong><small>下注證據保留，不提供刪除</small></div>
    </div>) : <div className="emptySmall">這個篩選範圍目前沒有下注紀錄。</div>}
  </section>;
}

function diagnosticVerdict(row, formulaScore, qaPassed, leagueValidated) {
  const weightedEV = modelEvValue(row);
  const robustEV = robustEvValue(row);
  if (row?.evCalibration?.qualified !== true) return { icon: '⚠️', label: '模型評分阻擋', ranking: false, reason: row?.evCalibration?.reasons?.[0] || 'Reader、核心資料或數學未通過' };
  if (formulaScore == null) return { icon: '⛔', label: '無法評分', ranking: false, reason: '缺少合法水位或雙EV' };
  if (!leagueValidated) return { icon: '⚠️', label: '聯盟模型未驗證', ranking: false, reason: '不列排名' };
  if (!qaPassed) return { icon: '⚠️', label: '資料QA阻擋', ranking: false, reason: '不列排名' };
  if (row?.evCalibration?.scenarioStable !== true) return { icon: '🟡', label: '模型情境不穩定', ranking: false, reason: 'W/R情境差距超過5%' };
  if (!Number.isFinite(weightedEV) || weightedEV <= 0) return { icon: '⚪', label: 'PASS', ranking: false, reason: '模型W未大於0' };
  if (!Number.isFinite(robustEV) || robustEV <= 0) return { icon: '🟡', label: '觀察', ranking: false, reason: '模型穩健R未大於0' };
  if (formulaScore < 7.2) return { icon: '⚪', label: 'PASS', ranking: false, reason: '公式分數未達7.2' };
  if (row?.rankingQualified === false) return { icon: '🟡', label: '影子候選未進排名', ranking: false, reason: row?.rankingQualificationReason || '後端排名Gate未通過' };
  if (formulaScore >= 8.5) return { icon: '🔥', label: '8.5級模型方向', ranking: true, reason: '雙EV為正、達8.5且既定高分條件完成' };
  if (formulaScore >= 8.0) return { icon: '🟢', label: '8.0級模型方向', ranking: true, reason: '雙EV為正且達8.0' };
  if (formulaScore >= 7.5) return { icon: '🟢', label: '7.5級模型方向', ranking: true, reason: '雙EV為正且達7.5' };
  return { icon: '🟢', label: '7.2級模型方向', ranking: true, reason: '雙EV為正且達7.2' };
}

function ResultRow({ row, game, onBet, betState = null, recordable = false, now, inactiveNotice = '', cloudLedgerUnavailable = false }) {
  const actualLine = row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water);
  const breakEven = actualLine ? breakEvenProbability(row.water, 0.015) : null;
  const modelEV = modelEvValue(row);
  const robustEV = robustEvValue(row);
  const storedFormulaScore = formulaScoreValue(row);
  const qaPassed = directionQaPassed(row);
  const leagueValidated = row?.scoreStatus !== 'LEAGUE_MODEL_NOT_VALIDATED';
  const calibrationBlocked = row?.evCalibration?.qualified !== true;
  const calibrationReason = row?.evCalibration?.reasons?.[0] || 'Reader、核心資料或數學未通過';
  const qaFailures = scoreQaFailures(row);
  const formulaScore = storedFormulaScore;
  const auditWarnings = diagnosticWarnings(row);
  const tai888Gap = row?.tai888MarketProbabilityGap == null
    ? row?.rawMarketProbabilityGap
    : row.tai888MarketProbabilityGap;
  const marketGapText = tai888Gap != null && Number.isFinite(Number(tai888Gap))
    ? `｜模型/Tai888去水差距 ${pct(tai888Gap)}`
    : '';
  const scoreLabel = !leagueValidated || formulaScore == null ? '—' : formulaScore.toFixed(1);
  const verdict = diagnosticVerdict(row, formulaScore, qaPassed, leagueValidated);
  const scoreClass = formulaScore == null ? (qaPassed ? 'pass' : 'warning') : formulaScore >= 8.5 ? 'strongest' : formulaScore >= 7.2 ? 'candidate' : 'pass';
  const scoreMark = scoreIcon(formulaScore, qaPassed && !calibrationBlocked && leagueValidated);
  const qaReason = !leagueValidated
    ? '聯盟模型尚未驗證'
    : !qaPassed
      ? qaFailures.join('；') || '資料、數學或數值檢查未通過'
      : calibrationBlocked
        ? calibrationReason
        : '';
  const qaLabel = qaPassed && !calibrationBlocked ? 'PASS' : 'BLOCK';
  const rankText = verdict.ranking
    ? `是（${verdict.label}）`
    : `否（${verdict.reason}）`;
  const scoreTitle = `S分數 ${scoreLabel}｜模型EV W ${signedPct(modelEV)}｜穩健EV R ${signedPct(robustEV)}｜資料／數學QA ${qaLabel}｜排名資格 ${rankText}`;
  const probabilityDetail = `狀態模型等效條件勝率 ${pct(row.modelProbability)}（排除等效走水）｜等效贏 ${pct(row.equivalentWinProbability)}／等效輸 ${pct(row.equivalentLossProbability)}／等效走水 ${pct(row.equivalentPushProbability)}｜結算機率：全贏 ${pct(row.fullWinProbability)}／部分贏 ${pct(row.partialWinProbability)}／純走水 ${pct(row.pushProbability)}／混合中性 ${pct(row.mixedNeutralProbability)}／部分輸 ${pct(row.partialLossProbability)}／全輸 ${pct(row.fullLossProbability)}｜損益兩平 ${pct(breakEven)}｜情境差距 ${pct(row.evCalibration?.rawScenarioSpread)}${marketGapText}`;
  const exact = betState?.exact || null;
  const latest = betState?.latest || null;
  const action = betActionState({ latest, recordable, inactiveNotice, cloudLedgerUnavailable });
  return <div className="scoreRow">
    <div className={`score ${scoreClass}`} title={scoreTitle} aria-label={`S分數 ${scoreLabel}`}>
      <span style={{ display: 'block', fontSize: 9, lineHeight: 1.1 }}>S 分數</span>
      <strong className="scoreValue">{scoreMark} {scoreLabel}</strong>
    </div>
    <div className="scoreBody">
      <div className="scorePick">{translateTeamText(row.pick) || '水位未提供｜不評分'}</div>
      <div className="scorePrice">信用盤水位 {waterText(row.water)}</div>
      <div className="scoreMeta"><strong>模型EV W {signedPct(modelEV)}｜穩健EV R {signedPct(robustEV)}</strong>{robustEV != null && robustEV <= 0 ? '｜觀察／不排名' : ''}</div>
      <div className={`qaLine ${qaLabel === 'BLOCK' ? 'pending' : ''}`}>資料／數學 QA：{qaLabel}{qaReason ? `（${qaReason}）` : ''}</div>
      <div className={`qaLine ${verdict.ranking ? '' : 'pending'}`}>{verdict.icon} 排名資格：{rankText}</div>
      {inactiveNotice && <div className="scoreMeta">實際下注紀錄狀態：{inactiveNotice}</div>}
      <div className="scoreMeta">{probabilityDetail}</div>
      {auditWarnings.map(warning => <div className="warningLine" key={warning}>⚠️ {warning}</div>)}
    </div>
    <div className="rowActions">
      {actualLine && <div>
        <button className={`mini ${latest ? 'recorded' : recordable ? 'green' : 'unavailable'}`} disabled={action.disabled} title={action.title} onClick={() => onBet(row)}>{action.text}</button>
        {latest && <BetPriceComparison bet={latest} currentRow={row} game={game}/>} 
      </div>}
    </div>
  </div>;
}

function DirectionSlotRow({ row, game }) {
  const status = directionStatus(row);
  const blocked = status === 'BLOCKED';
  const statusLabel = status === 'UNOPENED' ? '尚未開盤'
    : blocked ? '資料異常｜此市場方向已封鎖'
      : '等待模型計算';
  const qaStateLabel = status === 'UNOPENED' ? '等待開盤'
    : blocked ? '資料檢查未通過｜停止評分'
      : '等待模型計算';
  const reason = [
    row?.reason,
    row?.statusReason,
    row?.error,
    ...(Array.isArray(row?.coverageErrors) ? row.coverageErrors : []),
    ...(Array.isArray(row?.errors) ? row.errors : []),
    ...(Array.isArray(row?.qa?.reasons) ? row.qa.reasons : []),
  ].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join('；');
  return <div className="scoreRow">
    <div className={`score ${blocked ? 'warning' : 'pass'}`} aria-label="S分數尚未產生">
      <span style={{ display: 'block', fontSize: 9, lineHeight: 1.1 }}>S 分數</span>
      <strong className="scoreValue">—</strong>
    </div>
    <div className="scoreBody">
      <div className="scorePick">{directionLabel(row, game)}</div>
      <div className="scorePrice">盤口／水位：{status === 'UNOPENED' ? '尚未開盤' : '—'}</div>
      <div className="scoreMeta"><strong>模型EV W —｜穩健EV R —</strong></div>
      <div className={`qaLine ${blocked ? 'pending' : ''}`}>資料／數學 QA：{qaStateLabel}{reason ? `（${reason}）` : ''}</div>
      <div className="qaLine pending">排名資格：否｜{statusLabel}</div>
    </div>
  </div>;
}

function GameCard({ item, onBet, getBetState, readerExecutable, now, betsEnabled = true, shadowMode = false, cloudLedgerUnavailable = false }) {
  const readerBacked = item.actualSource?.provider === 'TAI888_READER_AUTO';
  const gamePrestart = gameIsPrestartNow(item.game, now);
  const latestCoverage = item.latestMarketCoverage || null;
  const coverage = latestCoverage || item.marketCoverage || {};
  const preservingPreviousReaderAnalysis = (Boolean(latestCoverage)
    || item.preservedCurrentReaderGame === true
    || item.pendingReaderAnalysis === true)
    && analysisHasCalculatedDirections(item.customData);
  const availableMarkets = new Set(coverage.availableMarkets || []);
  const blockedMarkets = new Set(coverage.blockedMarkets || []);
  const analysis = item.customData?.analysis || {};
  const externalDirectionSlots = item.customData?.directionSlots || item.directionSlots || null;
  const directionAnalysis = externalDirectionSlots && !analysis.directionSlots
    ? { ...analysis, directionSlots: externalDirectionSlots }
    : analysis;
  const hasDirectionSlots = Array.isArray(directionAnalysis.directionSlots) || Array.isArray(directionAnalysis.slots);
  const openMarketCount = Number.isInteger(Number(coverage.openMarkets))
    ? Number(coverage.openMarkets)
    : new Set((item.customMarkets || []).map(row => row.market)).size;
  const pitPersistence = item.customData?.pitPersistence || null;
  const pitUnconfirmed = pitPersistence?.confirmed !== true;
  const actualRows = analysisDirectionRows(directionAnalysis)
    .filter(row => hasDirectionSlots || row.sourceType === 'ACTUAL_TW_CREDIT')
    .map(row => {
    const currentReaderPrice = readerBacked
      && gamePrestart
      && readerExecutable
      && row?.provider === 'TAI888_READER_AUTO'
      && row?.evCalibration?.actualReaderEligible === true;
    const inactiveNotice = !gamePrestart
      ? '已達官方預定開打時間｜保留賽前分析｜停止記錄新下注'
      : pitUnconfirmed
        ? 'PIT永久保存未確認｜保留模型分析與排名｜實際下注紀錄暫停'
      : !currentReaderPrice
        ? 'Reader盤口等待最新驗證｜保留上一版分析與排名｜實際下注紀錄暫停'
        : '';
    // A line becoming stale or a game starting changes execution eligibility,
    // never the immutable score that was completed before first pitch.
    return { ...row, clientReaderPriceCurrent: currentReaderPrice, clientInactiveNotice: inactiveNotice };
  });
  const allDirectionsUnopened = blockedMarkets.size === 0 && actualRows.length > 0
    && actualRows.every(row => directionStatus(row) === 'UNOPENED');
  const expectedDirectionCount = 8;
  const scoredDirectionCount = actualRows.filter(row => modelEvValue(row) != null).length;
  const rankingDirectionCount = actualRows.filter(row => modelEvValue(row) != null && diagnosticVerdict(
    row,
    row.formulaDiagnosticScore != null && Number.isFinite(Number(row.formulaDiagnosticScore)) ? Number(row.formulaDiagnosticScore) : null,
    directionQaPassed(row),
    row?.scoreStatus !== 'LEAGUE_MODEL_NOT_VALIDATED',
  ).ranking && !preservingPreviousReaderAnalysis && !blockedMarkets.has(row.market)).length;
  const expectedRuns = analysis.expectedRuns || null;
  const sourceStatusLabels = {
    starters: '先發', lineups: '打線', bullpen: '純牛棚', parkFactor: '球場', weather: '天氣',
    catcherFraming: '捕手Framing', defenseFRV: '守備FRV', injuryRunValue: '傷停', pitchTypeMatchup: '球種對戰',
    umpireZone: '主審Zone', parkWindOrientation: '球場風向',
  };
  const sourceStatusText = Object.entries(analysis.sourceStatuses || {})
    .filter(([, value]) => value != null && String(value).trim())
    .map(([key, value]) => `${sourceStatusLabels[key] || key}：${value}`)
    .join('｜');
  const provenanceText = (Array.isArray(analysis.featureProvenance) ? analysis.featureProvenance : [])
    .slice(0, 10)
    .map(row => `${row?.feature || row?.featureName || '資料'}：${row?.status || '未知'}`)
    .join('｜');
  const runCenter = value => {
    const away = Number(value?.away);
    const home = Number(value?.home);
    return Number.isFinite(away) && Number.isFinite(home)
      ? `客 ${away.toFixed(2)}／主 ${home.toFixed(2)}／合計 ${(away + home).toFixed(2)}`
      : '資料不足';
  };
  return <section className="gameCard">
    <div className="gameHead">
      <div><h2>{matchup(item.game)}</h2><p>{localTime(item.game.gameDate)}｜{item.game.awayProbable || '先發未定'} 對 {item.game.homeProbable || '先發未定'}</p></div>
      <span className={`state ${item.status}`}>{item.statusLabel}</span>
    </div>
    {shadowMode && <div className="sourceBanner shadowBanner"><strong>🧪 {item.game.leagueId || item.game.league || 'MLB'} 聯合比分影子模型</strong><span>{preservingPreviousReaderAnalysis
      ? `Reader最新已開 ${openMarketCount}/4 市場｜上一版已評 ${scoredDirectionCount}/${expectedDirectionCount}｜目前不進排名`
      : `已開 ${openMarketCount}/4 市場｜應評 ${expectedDirectionCount} 方向｜已評 ${scoredDirectionCount}/${expectedDirectionCount}｜進影子排名 ${rankingDirectionCount}；依固定S分數分析與排序`}</span></div>}
    {expectedRuns && <div className="sourceBanner"><strong>上游得分中心｜市場水位回灌：停用</strong><span>全場 {runCenter(expectedRuns.full)}｜前五局 {runCenter(expectedRuns.first5)}｜這份得分分布同時結算大／小與讓／受讓</span></div>}
    {(sourceStatusText || provenanceText) && <div className="sourceBanner dataStatusBanner"><strong>上游資料狀態</strong><span>{sourceStatusText || provenanceText}</span></div>}
    {pitPersistence && <div className={`sourceBanner ${pitPersistence.confirmed ? 'dataStatusBanner' : 'shadowBanner'}`}><strong>{pitPersistence.confirmed ? 'PIT永久保存已確認' : 'PIT永久保存未確認'}</strong><span>{pitPersistence.status || 'UNKNOWN'}｜{pitPersistence.reason || '未提供原因'}｜{pitPersistence.snapshotId ? String(pitPersistence.snapshotId).slice(0, 36) : '無快照識別'}</span></div>}
    {item.actualSource && <div className="sourceBanner actualSource"><strong>{item.actualSource.label}</strong><span>盤口內容時間：{localTime(item.actualSource.observedAt)}</span></div>}
    {item.error && <div className="errorBox">{item.error}</div>}
    {!item.referenceData && !item.error && <div className="emptyGame">{item.statusLabel}</div>}
    {item.referenceData && <>
      {(item.actualSource || item.marketCoverage || actualRows.length > 0) && <div className="actualBox">
        <div className="actualHead"><strong>Tai888 實際信用盤</strong><span>{preservingPreviousReaderAnalysis ? 'Reader最新' : ''}已開 {openMarketCount}/4 市場{preservingPreviousReaderAnalysis ? '｜保留上一版分析' : ''}</span></div>
        {allDirectionsUnopened
          ? <div className="readerWaitingSummary"><strong>目前尚未開盤</strong><span>四市場八方向由 Reader 持續監看；實際盤口出現後會自動分析。</span></div>
          : MARKET_ORDER.map(market => {
          const rows = actualRows.filter(row => row.market === market).sort(compareDirectionsByScore);
          const calculated = rows.some(row => modelEvValue(row) != null);
          const blocked = blockedMarkets.has(market) || rows.some(row => directionStatus(row) === 'BLOCKED');
          const marketState = blocked ? 'BLOCKED' : calculated ? 'AVAILABLE' : 'UNOPENED';
          const marketStateLabel = blocked && latestCoverage ? '資料異常｜停止評分'
            : preservingPreviousReaderAnalysis ? '上一版分析｜停止下注'
              : marketState === 'AVAILABLE' ? '已完成分析'
                : marketState === 'BLOCKED' ? '資料異常'
              : '尚未開盤';
          const marketBlocked = blocked;
          const marketAllUnopened = !marketBlocked && rows.length > 0 && rows.every(row => directionStatus(row) === 'UNOPENED');
          return <div className={`marketBlock actualMarket ${marketBlocked ? 'blockedMarket' : calculated ? 'availableMarket' : 'unavailableMarket'}`} key={market}><div className="marketTitle"><h3>{market}</h3><span>{marketStateLabel}</span></div>{marketBlocked
            ? <div className="marketPlaceholder">資料異常｜不評分</div>
            : marketAllUnopened
            ? <div className="marketPlaceholder">尚未開盤｜Reader持續監看</div>
            : rows.length ? rows.map((row, index) => directionStatus(row) === 'CALCULATED' || modelEvValue(row) != null
              ? <ResultRow key={`${directionIdentity(row)}-${index}`} row={row} game={item.game} betState={betsEnabled ? getBetState(item, row) : null} recordable={betRecordable(item, row, now, betsEnabled, row.clientReaderPriceCurrent, !cloudLedgerUnavailable)} onBet={value => onBet(item, value)} now={now} inactiveNotice={row.clientInactiveNotice} cloudLedgerUnavailable={cloudLedgerUnavailable}/>
              : <DirectionSlotRow key={`${directionIdentity(row)}-${index}`} row={row} game={item.game}/>)
            : <div className="marketPlaceholder">{blocked ? '資料異常｜不評分' : availableMarkets.has(market) ? '等待分析驗證' : '尚未開盤'}</div>}</div>;
        })}
      </div>}
      <details className="details"><summary>查看模型、PIT與QA明細</summary><div className="detailGrid">
        <div><span>分析類型</span><b>分數驗證中</b></div>
        <div><span>固定公式</span><b>{analysis.scoreFormulaVersion || '—'}</b></div>
        <div><span>比分分布</span><b>{analysis.distributionHash?.slice(0, 12) || '—'}</b></div>
        <div><span>資料狀態</span><b>{analysis.analysisStatus || '—'}</b></div>
        <div><span>資料截至</span><b>{analysis.dataAsOf ? localTime(analysis.dataAsOf) : '—'}</b></div>
        <div><span>輸入雜湊</span><b>{analysis.inputHash?.slice(0, 12) || '—'}</b></div>
        <div><span>核心雜湊</span><b>{analysis.coreFingerprint?.slice(0, 12) || '—'}</b></div>
        <div><span>模型版本</span><b>{analysis.modelVersion || '—'}</b></div>
        <div><span>規則版本</span><b>{analysis.rulesVersion || '—'}</b></div>
        <div><span>PIT永久保存</span><b>{pitPersistence?.confirmed ? 'CONFIRMED' : pitPersistence?.status || '—'}</b></div>
      </div></details>
    </>}
  </section>;
}

function LeagueSetupPanel({ config }) {
  const stages = [
    ['正式賽程', '建立台灣日期、場次識別與雙重賽唯一配對'],
    ['Tai888 Reader', `驗證「${config.readerPageHint}」四市場八方向實際頁面`],
    ['獨立模型', `建立 ${config.id} 專屬資料、機率校準與版本稽核`],
    ['正式啟用', '通過方向、盤口、水位、時間與下注安全回歸測試'],
  ];
  return <section className="leagueSetup panel">
    <div className="setupHead"><div><span className="kicker">獨立聯盟模組</span><h2>{config.label}正在建立正式資料鏈</h2></div><span className="state setup">{config.statusLabel}</span></div>
    <p className="muted">聯盟資料尚未驗證前不借用其他聯盟機率、不補造盤口，也不建立未驗證的分析分布；實際下注帳本仍可獨立使用。</p>
    <div className="setupGrid">{stages.map(([title, detail], index) => <div key={title}><b>{index + 1}</b><strong>{title}</strong><span>{detail}</span></div>)}</div>
  </section>;
}

function LeagueShadowPanel({ config }) {
  return <section className="leagueSetup panel">
    <div className="setupHead"><div><span className="kicker">v{VERSION} 四聯盟 PIT 影子驗證</span><h2>{config.label}顯示固定S分數、雙EV與資料QA</h2></div><span className="state shadow">模型分析與排序</span></div>
    <p className="muted">每筆分析只有在資料庫回覆CONFIRMED後才標示為已永久保存不可變PIT；未確認不影響已完成的模型分數與排名，只暫停實際下注紀錄。Tai888與獨立同約市場不改比分分布或W/R；市場差距與極高EV只顯示診斷警示，資料、合約、分布、鏡像或結算等實質錯誤才會BLOCK。</p>
  </section>;
}

export default function Home() {
  const [league, setLeague] = useState('MLB');
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [bets, setBets] = useState([]);
  const [, setCalibrationStatus] = useState(null);
  const [betPeriod, setBetPeriod] = useState('TODAY');
  const [betLeague, setBetLeague] = useState('ALL');
  const [betMarket, setBetMarket] = useState('ALL');
  const [storageReady, setStorageReady] = useState(false);
  const [cloudLedgerStatus, setCloudLedgerStatus] = useState({ state: 'loading', code: '', message: '' });
  const [tab, setTab] = useState('board');
  const [date, setDate] = useState(taipeiDate());
  const [schedule, setSchedule] = useState([]);
  const [board, setBoard] = useState([]);
  const boardRef = useRef(board);
  boardRef.current = board;
  const [readerStatus, setReaderStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ active: false, done: 0, total: 0, label: '' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [health, setHealth] = useState(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [acknowledgedReaderKey, setAcknowledgedReaderKey] = useState('');
  const snapshots = useRef(new Map());
  const creditRevisionRef = useRef('');
  const officialPrestartCheckedAtRef = useRef(0);
  const operationBusyRef = useRef(false);
  const readerPollBusyRef = useRef(false);
  const autoAnalyzeHashRef = useRef('');
  const autoAnalyzePendingRef = useRef('');
  const currentDateRef = useRef(date);
  const currentLeagueRef = useRef(league);
  const analysisGenerationRef = useRef(0);
  const readerStatusRef = useRef(null);
  const readerStatusHighWaterRef = useRef(null);
  const betsRef = useRef([]);
  const cloudSyncBusyRef = useRef(false);
  const cloudSyncRetryAtRef = useRef(0);
  const backgroundJobPollsRef = useRef(new Map());
  const coreDataBlockRetryRef = useRef(new Map());
  const restoredBoardNeedsValidationRef = useRef(false);
  const activeLeague = leagueConfig(league);
  const analysisEnabled = activeLeague.capabilities.analysis === true;
  const readerEnabled = activeLeague.capabilities.reader === true;
  const rankingEnabled = activeLeague.capabilities.ranking === true;
  const bettingEnabled = activeLeague.capabilities.bets === true;
  const shadowMode = activeLeague.status === 'shadow';
  const readerCoverage = readerCoverageCounts(readerStatus);
  const readerPendingText = coveragePendingText(readerCoverage);
  const shadowRanking = useMemo(() => board.flatMap(item => {
    const analysis = item.customData?.analysis || {};
    const externalDirectionSlots = item.customData?.directionSlots || item.directionSlots || null;
    const directionAnalysis = externalDirectionSlots && !analysis.directionSlots
      ? { ...analysis, directionSlots: externalDirectionSlots }
      : analysis;
    const hasDirectionSlots = Array.isArray(directionAnalysis.directionSlots) || Array.isArray(directionAnalysis.slots);
    const currentBlockedMarkets = new Set((item.latestMarketCoverage || item.marketCoverage)?.blockedMarkets || []);
    const preservedReaderAnalysis = Boolean(item.latestMarketCoverage)
      || item.preservedCurrentReaderGame === true
      || item.pendingReaderAnalysis === true;
    const currentAnalysisExecutable = readerAnalysisRevisionReady(item)
      && Boolean(item.readerPayloadHash)
      && !preservedReaderAnalysis;
    return analysisDirectionRows(directionAnalysis)
      .filter(row => item.actualSource?.provider === 'TAI888_READER_AUTO'
        && !preservedReaderAnalysis
        && modelEvValue(row) != null
        && !currentBlockedMarkets.has(row.market)
        && (hasDirectionSlots || (row.sourceType === 'ACTUAL_TW_CREDIT' && row.provider === 'TAI888_READER_AUTO')))
      .map(row => {
      const score = formulaScoreValue(row);
      const qaPassed = directionQaPassed(row);
      const qualified = row.evCalibration?.qualified === true;
      const readerQualified = row.evCalibration?.actualReaderEligible === true;
      const gamePrestart = gameIsPrestartNow(item.game, clockNow);
      const pitConfirmed = item.customData?.pitPersistence?.confirmed === true;
      const currentReaderPrice = gamePrestart
        && readerQualified
        && readerStatus?.fresh === true
        && readerStatus?.boardDate === date
        && Boolean(item.readerPayloadHash)
        && item.readerPayloadHash === readerStatus?.payloadHash;
      const inactiveNotice = !gamePrestart
        ? '比賽已開始｜保留賽前分析與排名｜停止記錄新下注'
        : !pitConfirmed
          ? 'PIT永久保存未確認｜保留模型分析與排名｜實際下注紀錄暫停'
        : !currentReaderPrice
          ? 'Reader盤口等待最新驗證｜保留上一版分析與排名｜實際下注紀錄暫停'
          : '';
      const rankingEligible = currentAnalysisExecutable
        && qualified && qaPassed && row.scoreStatus === 'SHADOW_DIAGNOSTIC_UNCALIBRATED'
        && row.rankingQualified === true;
      return { item, row, gamePk: item.game.gamePk, matchup: matchup(item.game), market: row.market, pick: row.pick,
        water: row.water, score, weightedEV: modelEvValue(row), robustEV: robustEvValue(row), qaPassed, qualified,
        currentReaderPrice, inactiveNotice, rankingEligible };
      });
  })
    .sort((left, right) => Number(right.score ?? -Infinity) - Number(left.score ?? -Infinity)
      || Number(right.weightedEV ?? -Infinity) - Number(left.weightedEV ?? -Infinity)
      || Number(right.robustEV ?? -Infinity) - Number(left.robustEV ?? -Infinity)),
  [board, clockNow, readerStatus?.fresh, readerStatus?.boardDate, readerStatus?.payloadHash, date]);
  const shadowBetOrder = useMemo(() => buildBetOrderEntries(shadowRanking), [shadowRanking]);
  const shadowBetOrderGames = useMemo(() => groupBetOrderEntries(shadowBetOrder), [shadowBetOrder]);
  const rankingProvenance = useMemo(() => {
    const modelVersions = [...new Set(board.map(item => item.customData?.analysis?.modelVersion).filter(Boolean))];
    const lineTimes = board.flatMap(item => (item.customData?.analysis?.results || []).map(row => row.lineAsOf).filter(Boolean));
    return {
      modelVersions,
      latestLineAsOf: lineTimes.sort().at(-1) || null,
    };
  }, [board]);

  function commitReaderStatus(value) {
    const highWater = readerStatusHighWaterRef.current;
    if (!shouldAcceptReaderStatus(highWater, value)) return false;
    readerStatusHighWaterRef.current = mergeReaderStatusHighWater(highWater, value);
    readerStatusRef.current = value;
    setReaderStatus(value);
    return true;
  }

  function invalidateReaderStatus(message) {
    const value = { ...(readerStatusRef.current || {}), fresh: false, message: String(message || '') };
    readerStatusRef.current = value;
    setReaderStatus(value);
  }

  function acquireOperation() {
    if (operationBusyRef.current || readerPollBusyRef.current) return false;
    operationBusyRef.current = true;
    setBusy(true);
    return true;
  }

  function releaseOperation() {
    operationBusyRef.current = false;
    setBusy(false);
  }

  function reportCloudLedgerFailure(cause) {
    cloudSyncRetryAtRef.current = Date.now() + cloudLedgerRetryDelay(cause);
    setCloudLedgerStatus(cloudLedgerFailureState(cause));
  }

  async function refreshSettlements(targetLeague = '', { force = false } = {}) {
    if (!force && !cloudLedgerAutomaticRefreshAllowed({
      storageReady,
      tab,
      visibilityState: document.visibilityState,
      busy: cloudSyncBusyRef.current,
      now: Date.now(),
      retryAt: cloudSyncRetryAtRef.current,
    })) return;
    if (cloudSyncBusyRef.current) return;
    cloudSyncBusyRef.current = true;
    try {
      const migrationComplete = cloudBetMigrationComplete();
      const data = await requestJSON('/api/bets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(migrationComplete
          ? { action: 'settleOpen', league: targetLeague, limit: 500 }
          : { action: 'merge', bets: migrateLegacyLocalBets(betsRef.current) }),
      }, 120000);
      if (Array.isArray(data.bets)) {
        if (!migrationComplete) markCloudBetMigrationComplete();
        betsRef.current = data.bets;
        setBets(data.bets);
        setCalibrationStatus(data.calibration || null);
        cloudSyncRetryAtRef.current = 0;
        setCloudLedgerStatus({ state: 'ready', code: '', message: '' });
      }
    } catch (cause) {
      reportCloudLedgerFailure(cause);
      // A temporary result-provider failure must not erase or rewrite the ledger.
    } finally {
      cloudSyncBusyRef.current = false;
    }
  }

  useEffect(() => {
    const initial = loadCompactStore();
    const migratedBets = migrateLegacyLocalBets(initial.bets);
    setLeague(initial.activeLeague);
    setSettings(initial.settings);
    betsRef.current = migratedBets;
    setBets(migratedBets);
    setStorageReady(true);
    cloudSyncBusyRef.current = true;
    const migrationComplete = cloudBetMigrationComplete();
    requestJSON('/api/bets', migrationComplete ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'merge', bets: migratedBets }),
    }, 30000).then(data => {
      if (!Array.isArray(data.bets)) return;
      if (!migrationComplete) markCloudBetMigrationComplete();
      betsRef.current = data.bets;
      setBets(data.bets);
      setCalibrationStatus(data.calibration || null);
    }).then(() => {
      cloudSyncRetryAtRef.current = 0;
      setCloudLedgerStatus({ state: 'ready', code: '', message: '' });
    }).catch(cause => {
      reportCloudLedgerFailure(cause);
    }).finally(() => { cloudSyncBusyRef.current = false; });
  }, []);
  useEffect(() => {
    betsRef.current = bets;
    if (storageReady) saveCompactStore({ settings, bets, activeLeague: league });
  }, [settings, bets, league, storageReady]);
  useEffect(() => {
    if (!storageReady || tab !== 'bets') return undefined;
    refreshSettlements('');
    const onVisible = () => { if (document.visibilityState === 'visible') refreshSettlements(''); };
    const timer = window.setInterval(() => refreshSettlements(''), CLOUD_LEDGER_VISIBLE_REFRESH_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [storageReady, tab, league]);
  useEffect(() => {
    currentDateRef.current = date;
    currentLeagueRef.current = league;
    analysisGenerationRef.current += 1;
    snapshots.current.clear();
    creditRevisionRef.current = '';
    officialPrestartCheckedAtRef.current = 0;
    autoAnalyzeHashRef.current = '';
    autoAnalyzePendingRef.current = '';
    coreDataBlockRetryRef.current.clear();
    setAcknowledgedReaderKey('');
    const restoredBoard = storageReady ? loadAnalysisBoardCache(league, date) : [];
    restoredBoardNeedsValidationRef.current = restoredBoard.length > 0;
    setSchedule(restoredBoard.map(item => item.game));
    setBoard(restoredBoard);
    setError('');
    if (restoredBoard.length) setNotice(`已恢復 ${restoredBoard.length} 場上一版分析；分數保留顯示，Reader 正在背景驗證目前盤口。`);
    readerStatusRef.current = null;
    readerStatusHighWaterRef.current = null;
    setReaderStatus(null);
  }, [date, league, storageReady]);
  useEffect(() => {
    if (!storageReady) return undefined;
    const saved = loadBackgroundJob(league, date);
    if (!saved?.runId) return undefined;
    if (operationBusyRef.current) return undefined;
    const generation = analysisGenerationRef.current;
    operationBusyRef.current = true;
    setBusy(true);
    setProgress({ active: true, done: 0, running: 1, total: Number(saved.total) || 1, label: '伺服器背景分析中｜可離開App' });
    setNotice('已接回尚未完成的伺服器背景分析；可以切換畫面，完成後會自動載入。');
    pollBackgroundJob(saved.runId, generation, date, saved.gamePks).then(result => {
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== date) return;
      const rows = Array.isArray(result?.results) ? result.results : [];
      const completed = rows.filter(row => row?.ok).length;
      const blocked = rows.filter(row => !row?.ok && analysisFailureState(row).blocked).length;
      const failed = Math.max(0, (Number(result?.total) || rows.length) - completed - blocked);
      setNotice(`伺服器背景分析已載入：完成 ${completed} 場${blocked ? `｜資料不足 ${blocked} 場` : ''}${failed ? `｜暫時失敗 ${failed} 場` : ''}。`);
    }).catch(cause => {
      if (generation === analysisGenerationRef.current && currentDateRef.current === date) setError(String(cause?.message || cause));
    }).finally(() => {
      if (generation === analysisGenerationRef.current && currentDateRef.current === date) {
        releaseOperation();
        setProgress(value => ({ ...value, active: false }));
      }
    });
    return undefined;
  }, [date, league, storageReady, busy]);
  useEffect(() => {
    if (!storageReady || !board.some(item => (
      item.customData?.analysis?.results?.length
      || item.customData?.analysis?.directionSlots?.length
    ))) return;
    saveAnalysisBoardCache(league, date, board);
  }, [board, date, league, storageReady]);
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    setBoard(current => finalizeReaderBoardAtStart(current, clockNow));
  }, [clockNow]);
  useEffect(() => {
    requestJSON('/api/health', {}, 20000, { allowApplicationFailure: true }).then(setHealth).catch(() => setHealth(null));
  }, []);
  useEffect(() => {
    if (!readerEnabled || !analysisEnabled) return undefined;
    let active = true;
    const refreshReader = async () => {
      try {
        const stamp = Date.now();
        const [value, latest] = await Promise.all([
          requestJSON(`/api/reader/status?league=${encodeURIComponent(league)}&date=${encodeURIComponent(date)}&t=${stamp}`, {}, 20000),
          requestJSON(`/api/reader/status?league=${encodeURIComponent(league)}&t=${stamp}`, {}, 20000),
        ]);
        if (!active) return;
        if (latest?.fresh
          && /^\d{4}-\d{2}-\d{2}$/.test(String(latest.boardDate || ''))
          && latest.boardDate !== currentDateRef.current
          && !board.length
          && !operationBusyRef.current
          && !readerPollBusyRef.current) {
          setNotice(`已依 ${league} Tai888 Reader 自動切換至 ${latest.boardDate} 盤口日期。`);
          setDate(latest.boardDate);
          return;
        }
        commitReaderStatus(value);
        if (value?.fresh || board.length || operationBusyRef.current || readerPollBusyRef.current) return;
        if (!active || !latest?.fresh || !/^\d{4}-\d{2}-\d{2}$/.test(String(latest.boardDate || ''))) return;
        if (latest.boardDate !== currentDateRef.current) {
          setNotice(`已依 Tai888 Reader 自動切換至 ${latest.boardDate} 盤口日期。`);
          setDate(latest.boardDate);
        }
      } catch (cause) {
        if (active) invalidateReaderStatus(cause?.message || cause);
      }
    };
    refreshReader();
    const timer = window.setInterval(refreshReader, READER_RECHECK_INTERVAL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [date, board.length, league, readerEnabled, analysisEnabled]);
  useEffect(() => {
    if (!readerEnabled || !analysisEnabled) return undefined;
    const hash = readerStatus?.payloadHash || '';
    const key = readerHashKey(date, hash);
    if (!readerStatus?.fresh || !key || board.length || busy || autoAnalyzeHashRef.current === key || autoAnalyzePendingRef.current === key) return;
    autoAnalyzePendingRef.current = key;
    let started = false;
    const timer = window.setTimeout(() => {
      started = true;
      Promise.resolve(oneClickAnalyze(key)).finally(() => {
        if (autoAnalyzePendingRef.current === key) autoAnalyzePendingRef.current = '';
      });
    }, 600);
    return () => {
      window.clearTimeout(timer);
      if (!started && autoAnalyzePendingRef.current === key) autoAnalyzePendingRef.current = '';
    };
  }, [readerStatus?.fresh, readerStatus?.payloadHash, board.length, busy, date, league, readerEnabled, analysisEnabled]);
  useEffect(() => {
    if (!readerEnabled || !analysisEnabled || !board.length || restoredBoardNeedsValidationRef.current) return undefined;
    // Validate immediately after a page restore or completed analysis. Waiting
    // for the first interval meant every mobile refresh restarted the delay and
    // could leave otherwise-current bet buttons hidden indefinitely.
    pollReaderAndReprice();
    const timer = window.setInterval(() => pollReaderAndReprice(), READER_RECHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [board.length, date, busy, league, readerEnabled, analysisEnabled]);
  useEffect(() => {
    if (!restoredBoardNeedsValidationRef.current || !board.length || busy || !readerStatus?.fresh) return undefined;
    // A restored board intentionally contains completed games only. It is not
    // the authoritative daily schedule, so repricing it directly can strand a
    // mobile client with just the one result Safari managed to persist. Re-run
    // the full slate bootstrap: it fetches the official schedule and current
    // Reader board, preserves cached scores, and queues every open game.
    let cancelled = false;
    let timer;
    const bootstrapFullSlate = () => {
      if (cancelled) return;
      if (operationBusyRef.current || readerPollBusyRef.current) {
        timer = window.setTimeout(bootstrapFullSlate, 250);
        return;
      }
      const key = readerHashKey(date, readerStatusRef.current?.payloadHash || readerStatus?.payloadHash);
      restoredBoardNeedsValidationRef.current = false;
      void oneClickAnalyze(key);
    };
    timer = window.setTimeout(bootstrapFullSlate, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [board.length, busy, readerStatus?.fresh, readerStatus?.payloadHash, date, league]);
  const currentReaderKey = readerHashKey(date, readerStatus?.payloadHash);
  const currentReaderHashKey = readerHashKey(date, readerStatus?.payloadHash);
  const readerExecutable = readerEnabled
    && readerStatus?.fresh === true
    && readerStatus?.boardDate === date
    && Boolean(currentReaderHashKey);
  const itemReaderExecutable = item => readerEnabled
    && readerStatus?.fresh === true
    && readerStatus?.boardDate === date
    && readerAnalysisRevisionReady(item)
    && Boolean(item?.readerPayloadHash)
    && item.readerPayloadHash === readerStatus?.payloadHash;

  const visibleBets = useMemo(
    () => bets.filter(bet => normalizeLeagueId(bet?.league) === league),
    [bets, league],
  );

  function getBetState(item, row) {
    const records = bets.filter(bet => betMatches(bet, date, item.game.gamePk, row, league))
      .sort((left, right) => Date.parse(right.placedAt || 0) - Date.parse(left.placedAt || 0));
    return {
      records,
      latest: records[0] || null,
      exact: records.find(bet => betPriceMatches(bet, date, item.game.gamePk, row, league)) || null,
    };
  }

  function updateBoard(gamePk, updater) {
    setBoard(current => current.map(item => item.game.gamePk === gamePk ? updater(item) : item));
  }

  async function fetchSchedule(targetDate = date) {
    if (!activeLeague.scheduleEndpoint) throw new Error(`${activeLeague.label}正式賽程尚未接入，不能進行分析`);
    const data = await requestJSON(`${activeLeague.scheduleEndpoint}?league=${encodeURIComponent(league)}&date=${encodeURIComponent(targetDate)}&t=${Date.now()}`, {}, 40000);
    const rows = Array.isArray(data.games) ? data.games.filter(game => gameIsPrestartNow(game, Date.now())) : [];
    if (currentDateRef.current === targetDate) setSchedule(rows);
    return rows;
  }

  async function fetchReferenceLines(games, targetDate = date, targetGames = []) {
    void games;
    void targetDate;
    void targetGames;
    return { ok: true, configured: false, games: [], failures: [], message: '目前未接外部同合約來源；不改比分分布或W/R，但缺少兩個獨立同約時8.5級最高封頂8.4。' };
  }

  async function confirmLiveReaderHash(targetDate, payloadHash, generation) {
    const live = await requestJSON(`/api/reader/status?league=${encodeURIComponent(league)}&date=${encodeURIComponent(targetDate)}&t=${Date.now()}`, {}, 20000);
    if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;
    commitReaderStatus(live);
    const current = readerStatusRef.current;
    return liveReaderHashMatches(targetDate, current, payloadHash);
  }

  function taskReaderStateIsStale(task) {
    const gamePk = Number(task?.game?.gamePk);
    const currentItem = boardRef.current.find(item => Number(item?.game?.gamePk) === gamePk) || null;
    const liveReader = readerStatusRef.current || {};
    return readerResultIsStale({
      taskPayloadHash: task?.readerPayloadHash,
      livePayloadHash: liveReader?.payloadHash,
      liveBoardDate: liveReader?.boardDate,
      targetDate: currentDateRef.current,
    }) || readerEvidenceIsOlder(
      task?.actualSource,
      currentItem?.actualSource,
      currentItem?.latestReaderSource,
    );
  }

  function directRepriceAuthorityMatches(item, task, now = Date.now()) {
    if (!item
      || Number(item?.game?.gamePk) !== Number(task?.game?.gamePk)
      || !gameIsPrestartNow(item.game, now)) return false;
    const expectedEvidenceHash = readerGameEvidenceHash(task);
    return Boolean(expectedEvidenceHash)
      && item?.pendingReaderEvidenceHash === expectedEvidenceHash
      && !readerEvidenceIsOlder(task?.actualSource, item?.actualSource, item?.latestReaderSource);
  }

  function commitAnalysisPayload(task, baseData) {
    const game = task?.game || baseData?.game;
    if (!game?.gamePk || !baseData?.analysis) return false;
    const actualMarkets = task?.actualMarkets || [];
    const currentItem = boardRef.current.find(item => Number(item?.game?.gamePk) === Number(game.gamePk)) || null;
    if (taskReaderStateIsStale(task)) return false;
    const preservePrevious = shouldPreserveCalculatedAnalysis(
      currentItem?.customData,
      baseData,
      actualMarkets,
    );
    const unopenedOnly = analysisIsUnopenedOnly(baseData);
    if (preservePrevious || unopenedOnly) {
      setBoard(current => current.map(item => {
        if (Number(item?.game?.gamePk) !== Number(game.gamePk)) return item;
        const preserve = preservePrevious && analysisHasCalculatedDirections(item?.customData);
        const readerMissing = actualMarkets.length === 0;
        return {
          ...item,
          game,
          latestMarketCoverage: task?.marketCoverage || null,
          latestReaderSource: task?.actualSource || null,
          readerPayloadHash: null,
          status: preserve ? 'done' : 'unopened',
          statusLabel: preserve
            ? readerMissing
              ? 'Reader目前未呈現盤口｜保留上一版分析'
              : 'Reader目前部分市場尚未開盤｜保留上一版分析'
            : task?.unavailableReason === 'not-rendered-by-reader'
              ? 'Reader目前未呈現盤口｜持續自動監看'
              : 'Tai888目前尚未開盤｜持續自動監看',
          referenceData: preserve ? item.referenceData : null,
          customData: preserve ? item.customData : null,
          customMarkets: preserve ? item.customMarkets : [],
          restoredFromCache: false,
          analysisFailure: null,
          pendingReaderAnalysis: false,
          preservedCurrentReaderGame: preserve,
          readerWaitingHandled: true,
          error: '',
        };
      }));
      return true;
    }
    coreDataBlockRetryRef.current.delete(coreDataBlockKey(league, currentDateRef.current, game.gamePk, readerGameEvidenceHash(task)));
    snapshots.current.set(game.gamePk, baseData.repriceSnapshot);
    setBoard(current => {
      const previous = current.find(item => Number(item?.game?.gamePk) === Number(game.gamePk)) || {};
      const completed = {
        ...previous,
        game,
        actualSource: task?.actualSource || previous.actualSource || null,
        marketCoverage: task?.marketCoverage || previous.marketCoverage || null,
        latestMarketCoverage: null,
        latestReaderSource: null,
        readerProvenance: task?.readerProvenance || previous.readerProvenance || null,
        readerPayloadHash: task?.readerPayloadHash || previous.readerPayloadHash || null,
        referenceData: compactAnalysisData(baseData),
        mode: 'actual',
        status: 'done',
        statusLabel: Number(baseData?.analysis?.calculatedDirectionCount || 0) === 0
          ? '八方向槽位已保存｜目前尚未開盤或市場資料異常'
          : baseData.pitPersistence?.confirmed
            ? 'Tai888盤口分析完成｜PIT已確認'
            : '模型分析完成｜PIT未保存、實際下注紀錄暫停',
        customMarkets: actualMarkets,
        verificationMarkets: task?.verificationMarkets || previous.verificationMarkets || [],
        customData: compactAnalysisData(baseData),
        restoredFromCache: false,
        analysisFailure: null,
        pendingReaderAnalysis: false,
        preservedCurrentReaderGame: false,
        readerWaitingHandled: false,
        error: '',
      };
      return previous.game
        ? current.map(item => Number(item?.game?.gamePk) === Number(game.gamePk) ? completed : item)
        : [...current, completed];
    });
    return true;
  }

  function commitAnalysisFailure(task, value) {
    const game = task?.game;
    if (!game?.gamePk || taskReaderStateIsStale(task)) return false;
    const failure = analysisFailureState(value);
    const terminalGame = failure.code === 'GAME_ALREADY_STARTED';
    const payloadHash = task?.readerPayloadHash || '';
    const evidenceHash = readerGameEvidenceHash(task);
    const retryAt = failure.blocked ? Date.now() + CORE_DATA_BLOCK_RECHECK_MS : 0;
    if (failure.blocked && evidenceHash) {
      coreDataBlockRetryRef.current.set(
        coreDataBlockKey(league, currentDateRef.current, game.gamePk, evidenceHash),
        retryAt,
      );
    }
    setBoard(current => {
      const previous = current.find(item => Number(item?.game?.gamePk) === Number(game.gamePk)) || {};
      if (terminalGame && !analysisHasCalculatedDirections(previous.customData)) {
        return current.filter(item => Number(item?.game?.gamePk) !== Number(game.gamePk));
      }
      const failed = {
        ...previous,
        game,
        readerPayloadHash: null,
        latestMarketCoverage: terminalGame ? null : previous.latestMarketCoverage || null,
        latestReaderSource: terminalGame ? null : previous.latestReaderSource || null,
        pendingReaderAnalysis: terminalGame ? false : previous.pendingReaderAnalysis === true,
        preservedCurrentReaderGame: terminalGame ? false : previous.preservedCurrentReaderGame === true,
        readerWaitingHandled: terminalGame ? false : previous.readerWaitingHandled === true,
        status: terminalGame ? 'done' : failure.blocked ? 'blocked' : 'failed',
        statusLabel: terminalGame
          ? '比賽已開始、延期或取消｜保留賽前分析｜停止記錄新下注'
          : failure.blocked
          ? previous.customData ? '資料不足｜保留上一版結果' : '資料不足｜QA BLOCK｜不評分'
          : previous.customData ? '更新失敗｜保留上一版結果' : '分析失敗',
        analysisFailure: {
          code: failure.code,
          status: failure.status,
          blocking: failure.blocking,
          warnings: failure.warnings,
          permanent: failure.permanent,
          blocked: failure.blocked,
          readerPayloadHash: terminalGame ? null : payloadHash || previous.readerPayloadHash || null,
          readerEvidenceHash: evidenceHash || null,
          retryAt: retryAt ? new Date(retryAt).toISOString() : null,
        },
        error: failure.message,
      };
      return previous.game
        ? current.map(item => Number(item?.game?.gamePk) === Number(game.gamePk) ? failed : item)
        : [...current, failed];
    });
    return true;
  }

  function releaseTerminalBackgroundCards(gamePks = [], workflowStatus = 'failed') {
    const targets = new Set((Array.isArray(gamePks) ? gamePks : [])
      .map(Number)
      .filter(Number.isFinite));
    const now = Date.now();
    setBoard(current => finalizeReaderBoardAtStart(current.flatMap(item => {
      if (!['queued', 'running'].includes(item?.status)
        || (targets.size && !targets.has(Number(item?.game?.gamePk)))) return [item];
      if (!gameIsPrestartNow(item?.game, now) && !analysisHasCalculatedDirections(item?.customData)) return [];
      const preserve = analysisHasCalculatedDirections(item?.customData);
      const cancelled = String(workflowStatus || '').toLowerCase() === 'cancelled';
      return [{
        ...item,
        readerPayloadHash: null,
        latestMarketCoverage: null,
        latestReaderSource: null,
        pendingReaderEvidenceHash: null,
        pendingReaderAnalysis: false,
        preservedCurrentReaderGame: false,
        readerWaitingHandled: false,
        status: 'failed',
        statusLabel: preserve
          ? `${cancelled ? '背景分析已取消' : '背景分析未完成'}｜保留上一版結果｜等待自動重試`
          : `${cancelled ? '背景分析已取消' : '背景分析未完成'}｜等待自動重試`,
        analysisFailure: {
          code: cancelled ? 'BACKGROUND_JOB_CANCELLED' : 'BACKGROUND_JOB_FAILED',
          status: null,
          blocking: [],
          warnings: [],
          permanent: false,
          blocked: false,
          readerPayloadHash: null,
          readerEvidenceHash: null,
          retryAt: null,
        },
        error: cancelled ? '伺服器背景分析已取消' : '伺服器背景分析未完成',
      }];
    }), now));
  }

  function pollBackgroundJob(runId, generation, targetDate, gamePks = []) {
    const pollKey = `${runId}|||${generation}|||${targetDate}`;
    const currentPoll = backgroundJobPollsRef.current.get(pollKey);
    if (currentPoll) return currentPoll;
    const poll = (async () => {
      while (generation === analysisGenerationRef.current && currentDateRef.current === targetDate) {
        try {
          const state = await requestJSON(`/api/analysis-jobs?runId=${encodeURIComponent(runId)}&t=${Date.now()}`, {}, 30000);
          if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) {
            return { detached: true, total: 0, completed: 0, results: [] };
          }
          if (state.status === 'completed') {
            const result = state.result || {};
            const rows = Array.isArray(result.results) ? result.results : [];
            let applicableRows = rows;
            const discardedReaderPks = new Set();
            const expectedReaderHashes = [...new Set(applicableRows
              .map(row => String(row?.task?.readerPayloadHash || '').trim()).filter(Boolean))];
            if (expectedReaderHashes.length) {
              const officialGames = await fetchSchedule(targetDate);
              if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) {
                return { detached: true, total: 0, completed: 0, results: [] };
              }
              const officialPks = new Set(officialGames.map(game => Number(game.gamePk)));
              const obsoletePks = new Set(applicableRows
                .filter(row => row?.task?.readerPayloadHash)
                .map(row => Number(row?.task?.game?.gamePk))
                .filter(gamePk => Number.isFinite(gamePk) && !officialPks.has(gamePk)));
              if (obsoletePks.size) {
                obsoletePks.forEach(gamePk => discardedReaderPks.add(gamePk));
                setBoard(current => current.flatMap(item => {
                  if (!obsoletePks.has(Number(item?.game?.gamePk))) return [item];
                  if (!analysisHasCalculatedDirections(item.customData)) return [];
                  return [{
                    ...item,
                    readerPayloadHash: null,
                    latestMarketCoverage: null,
                    latestReaderSource: null,
                    pendingReaderAnalysis: false,
                    preservedCurrentReaderGame: false,
                    readerWaitingHandled: false,
                    status: 'done',
                    statusLabel: '場次已開始、延期或取消｜保留賽前分析｜停止記錄新下注',
                    error: '',
                  }];
                }));
                applicableRows = applicableRows.filter(row => !obsoletePks.has(Number(row?.task?.game?.gamePk)));
              }
              if (!officialGames.length) {
                clearBackgroundJob(result.league || league, result.date || targetDate, runId);
                setBoard(current => finalizeReaderBoardAtStart(current, Date.now(), { noPrestartGames: true }));
                setProgress({ active: false, done: 0, running: 0, total: Number(result.total) || rows.length, label: '背景結果已停止｜場次已開始、延期或取消' });
                return { ...result, discarded: true, results: [] };
              }
              if (!applicableRows.length) {
                clearBackgroundJob(result.league || league, result.date || targetDate, runId);
                setProgress({ active: false, done: 0, running: 0, total: Number(result.total) || rows.length, label: '背景結果已停止｜該批場次已開始、延期或取消' });
                return { ...result, discarded: true, results: [] };
              }
              const credit = await requestJSON('/api/credit-lines', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
                body: JSON.stringify({ league, date: targetDate, schedule: officialGames }),
              }, 60000);
              if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) {
                return { detached: true, total: 0, completed: 0, results: [] };
              }
              if (credit?.code === 'NO_PRESTART_GAMES') {
                clearBackgroundJob(result.league || league, result.date || targetDate, runId);
                const taskPks = new Set(applicableRows
                  .map(row => Number(row?.task?.game?.gamePk))
                  .filter(Number.isFinite));
                setBoard(current => current.flatMap(item => {
                  if (!taskPks.has(Number(item?.game?.gamePk))) return [item];
                  if (!analysisHasCalculatedDirections(item?.customData)) return [];
                  return [{
                    ...item,
                    readerPayloadHash: null,
                    latestMarketCoverage: null,
                    latestReaderSource: null,
                    pendingReaderAnalysis: false,
                    preservedCurrentReaderGame: false,
                    readerWaitingHandled: false,
                    status: 'done',
                    statusLabel: '場次已開始、延期或取消｜保留賽前分析｜停止記錄新下注',
                    error: '',
                  }];
                }));
                return { ...result, discarded: true, results: [] };
              }
              if (credit?.blocked === true || credit?.readerFresh !== true || !credit?.payloadHash) {
                setNotice('伺服器分析已完成；正在等待 Reader 驗證同一份盤口後載入。');
                await new Promise(resolve => window.setTimeout(resolve, 2500));
                continue;
              }
              if (credit?.readerStatus) commitReaderStatus({
                ...credit.readerStatus,
                boardDate: credit.boardDate,
                payloadHash: credit.payloadHash,
                rawBoardHash: credit.rawBoardHash,
                observedAt: credit.observedAt,
                receivedAt: credit.receivedAt,
                pageActivityAt: credit.pageActivityAt,
              });
              const currentOpenByPk = new Map((credit.games || []).map(row => [Number(row.gamePk), row]));
              const currentReaderByPk = new Map([
                ...(credit.unopenedGames || []).map(row => [Number(row.gamePk), row]),
                ...currentOpenByPk,
              ]);
              applicableRows = applicableRows.flatMap(row => {
                if (!row?.task?.readerPayloadHash) return [row];
                const gamePk = Number(row?.task?.game?.gamePk);
                const liveGame = currentOpenByPk.get(gamePk);
                const taskEvidenceHash = readerGameEvidenceHash(row.task);
                const liveEvidenceHash = readerGameEvidenceHash(liveGame);
                if (!liveGame || !taskEvidenceHash || taskEvidenceHash !== liveEvidenceHash) {
                  if (Number.isFinite(gamePk)) discardedReaderPks.add(gamePk);
                  return [];
                }
                return [{
                  ...row,
                  task: {
                    ...row.task,
                    actualMarkets: liveGame.markets || row.task.actualMarkets || [],
                    actualSource: liveGame.source || row.task.actualSource || null,
                    marketCoverage: liveGame.marketCoverage || row.task.marketCoverage || null,
                    readerProvenance: liveGame.readerProvenance || row.task.readerProvenance || null,
                    readerPayloadHash: credit.payloadHash,
                  },
                }];
              });
              if (discardedReaderPks.size) {
                setBoard(current => current.map(item => {
                  const gamePk = Number(item?.game?.gamePk);
                  if (!discardedReaderPks.has(gamePk) || obsoletePks.has(gamePk)) return item;
                  const liveGame = currentReaderByPk.get(gamePk) || null;
                  const liveOpen = Boolean(liveGame?.markets?.length);
                  const preserve = analysisHasCalculatedDirections(item?.customData);
                  return {
                    ...item,
                    readerPayloadHash: null,
                    latestMarketCoverage: liveGame?.marketCoverage || null,
                    latestReaderSource: liveGame?.source || null,
                    pendingReaderAnalysis: preserve && liveOpen,
                    preservedCurrentReaderGame: preserve && !liveOpen,
                    readerWaitingHandled: !liveOpen,
                    status: preserve ? 'done' : liveOpen ? 'queued' : 'unopened',
                    statusLabel: liveOpen
                      ? preserve
                        ? 'Reader盤口已更新｜保留上一版分析｜等待重新計算'
                        : 'Reader盤口已更新｜等待重新計算'
                      : preserve
                        ? 'Reader目前尚未完整開盤｜保留上一版分析'
                        : 'Reader目前尚未完整開盤｜持續自動監看',
                    analysisFailure: null,
                    error: '',
                  };
                }));
              }
              if (!applicableRows.length) {
                clearBackgroundJob(result.league || league, result.date || targetDate, runId);
                setProgress({ active: false, done: 0, running: 0, total: Number(result.total) || rows.length, label: '舊盤分析已逐場丟棄｜Reader已有新盤' });
                return {
                  ...result,
                  discarded: true,
                  results: rows.map(row => discardedReaderPks.has(Number(row?.task?.game?.gamePk))
                    ? { ...row, ok: false, discarded: true, code: 'STALE_READER_RESULT', error: 'Reader已有新盤' }
                    : row),
                };
              }
            }
            applicableRows.forEach(row => row?.ok ? commitAnalysisPayload(row.task, row.payload) : commitAnalysisFailure(row?.task, row));
            clearBackgroundJob(result.league || league, result.date || targetDate, runId);
            const total = Number(result.total) || rows.length;
            const succeeded = applicableRows.filter(row => row?.ok).length;
            const blocked = applicableRows.filter(row => analysisFailureState(row).blocked).length;
            setProgress({
              active: false,
              done: succeeded,
              running: 0,
              total,
              label: blocked ? `伺服器背景分析結束｜${blocked}場資料不足` : '伺服器背景分析完成',
            });
            const applicableByPk = new Map(applicableRows.map(row => [Number(row?.task?.game?.gamePk), row]));
            return {
              ...result,
              results: rows.map(row => {
                const gamePk = Number(row?.task?.game?.gamePk);
                if (discardedReaderPks.has(gamePk)) {
                  return { ...row, ok: false, discarded: true, code: 'STALE_READER_RESULT', error: 'Reader已有新盤' };
                }
                return applicableByPk.get(gamePk) || row;
              }),
            };
          }
          if (['failed', 'cancelled'].includes(String(state.status || '').toLowerCase())) {
            clearBackgroundJob(league, targetDate, runId);
            releaseTerminalBackgroundCards(gamePks, state.status);
            const failure = new Error('伺服器背景分析未完成，請按更新後重試');
            failure.backgroundFatal = true;
            throw failure;
          }
          setProgress(value => ({ ...value, active: true, running: 1, label: '伺服器背景分析中｜可離開App' }));
        } catch (cause) {
          if (cause?.backgroundFatal || [401, 403, 404].includes(Number(cause?.status))) {
            clearBackgroundJob(league, targetDate, runId);
            releaseTerminalBackgroundCards(gamePks, cause?.backgroundFatal ? 'failed' : 'unavailable');
            throw cause;
          }
          if (generation === analysisGenerationRef.current && currentDateRef.current === targetDate) {
            setNotice('伺服器仍在背景分析；目前網路暫時無法取得進度，回到App後會自動再接續。');
          }
        }
        await new Promise(resolve => window.setTimeout(resolve, 2500));
      }
      return { detached: true, total: 0, completed: 0, results: [] };
    })().finally(() => backgroundJobPollsRef.current.delete(pollKey));
    backgroundJobPollsRef.current.set(pollKey, poll);
    return poll;
  }

  async function runDurableAnalysisTasks(tasks, generation, targetDate, {
    progressLabel = '分析今日全部盤口',
    noticeLabel = '',
  } = {}) {
    if (!Array.isArray(tasks) || !tasks.length) return { ok: true, total: 0, completed: 0, results: [] };
    setProgress({ active: true, done: 0, running: 0, total: tasks.length, label: progressLabel });
    const job = await requestJSON('/api/analysis-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
      body: JSON.stringify({
        league,
        date: targetDate,
        tasks: tasks.map(task => ({ ...task, requestId: uid(), generation: undefined })),
      }),
    }, 30000);
    const reconnectSaved = saveBackgroundJob({
      runId: job.runId,
      league,
      date: targetDate,
      total: tasks.length,
      gamePks: tasks.map(task => Number(task?.game?.gamePk)).filter(Number.isFinite),
      startedAt: new Date().toISOString(),
    });
    setNotice(reconnectSaved
      ? `${noticeLabel || `已交給伺服器背景分析 ${tasks.length} 場`}；現在可以離開App或鎖定手機。`
      : `${noticeLabel || `伺服器已開始分析 ${tasks.length} 場`}；此裝置無法保存工作編號，完成前請保持App開啟。`);
    return pollBackgroundJob(
      job.runId,
      generation,
      targetDate,
      tasks.map(task => Number(task?.game?.gamePk)).filter(Number.isFinite),
    );
  }

  async function analyzeBoardItem(task, index, total, retry = false, trackProgress = true) {
    if (task.generation !== analysisGenerationRef.current) return false;
    const game = task.game;
    const actualMarkets = task.actualMarkets || [];
    if (trackProgress) setProgress(value => ({ ...value, running: (Number(value.running) || 0) + 1 }));
    updateBoard(game.gamePk, item => ({
      ...item,
      status: 'running',
      statusLabel: item.customData
        ? '後台更新中｜保留目前分數'
        : retry ? '重新建立驗證用比分分布中…' : '建立驗證用比分分布中…',
    }));
    try {
      const requestId = uid();
      const baseData = await requestAnalysisWithResume({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
        body: JSON.stringify({
          league,
          game,
          markets: actualMarkets,
          readerProvenance: task.readerProvenance || null,
          verificationMarkets: task.verificationMarkets || [],
          settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },
        }),
      });
      if (task.generation !== analysisGenerationRef.current) return false;
      return commitAnalysisPayload(task, baseData);
    } catch (cause) {
      if (task.generation !== analysisGenerationRef.current) return false;
      const failure = analysisFailureState(cause);
      task.retryable = !failure.permanent;
      commitAnalysisFailure(task, cause);
      return false;
    } finally {
      if (trackProgress && task.generation === analysisGenerationRef.current) {
        setProgress(value => ({
          ...value,
          done: Math.min(total, Number(value.done || 0) + 1),
          running: Math.max(0, Number(value.running || 0) - 1),
        }));
      }
    }
  }

  async function oneClickAnalyze(automaticKey = '') {
    if (!analysisEnabled) {
      setError(`${activeLeague.label}尚未完成正式賽程與Reader驗證，目前不能分析。`);
      return false;
    }
    if (!acquireOperation()) return false;
    const requestedAutoKey = typeof automaticKey === 'string' ? automaticKey : '';
    const targetDate = date;
    const generation = analysisGenerationRef.current;
    const previousByPk = new Map(boardRef.current.map(item => [Number(item.game.gamePk), item]));
    setError(''); setNotice(''); setTab('board');
    setBoard(current => current.map(item => item.actualSource?.provider === 'TAI888_READER_AUTO'
      ? { ...item, readerPayloadHash: null, status: 'running', statusLabel: '後台重新驗證中｜保留目前分數｜停止下注', error: '' }
      : item));
    try {
      setProgress({ active: true, done: 0, running: 1, total: 1, label: `取得今日${activeLeague.shortLabel}賽事` });
      const games = await fetchSchedule(targetDate);
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;
      if (!games.length) {
        creditRevisionRef.current = '';
        officialPrestartCheckedAtRef.current = Date.now();
        autoAnalyzeHashRef.current = requestedAutoKey
          || readerHashKey(targetDate, readerStatusRef.current?.payloadHash);
        setSchedule([]);
        setBoard(current => finalizeReaderBoardAtStart(current, Date.now(), { noPrestartGames: true }));
        setNotice(`這個日期目前沒有可分析的賽前${activeLeague.shortLabel}賽事；空白等待卡已移除。`);
        setProgress({ active: false, done: 0, running: 0, total: 0, label: '' });
        return true;
      }

      setProgress({ active: true, done: 0, running: 1, total: 1, label: '取得Tai888信用盤' });
      const credit = await requestJSON('/api/credit-lines', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() }, body: JSON.stringify({ league, date: targetDate, schedule: games }),
      }, 60000);
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;

      if (credit?.readerStatus) commitReaderStatus({
        ...credit.readerStatus,
        boardDate: credit.boardDate,
        payloadHash: credit.payloadHash,
        rawBoardHash: credit.rawBoardHash,
        rawGameCount: credit.rawGameCount,
        matchedGameCount: credit.matchedGameCount,
        unopenedGameCount: credit.unopenedGameCount,
        scheduleGameCount: credit.scheduleGameCount,
        observedAt: credit.observedAt,
        receivedAt: credit.receivedAt,
        pageActivityAt: credit.pageActivityAt,
      });

      if (credit?.code === 'NO_PRESTART_GAMES') {
        creditRevisionRef.current = '';
        officialPrestartCheckedAtRef.current = Date.now();
        autoAnalyzeHashRef.current = requestedAutoKey || readerHashKey(targetDate, credit.payloadHash);
        setSchedule([]);
        setBoard(current => finalizeReaderBoardAtStart(current, Date.now(), { noPrestartGames: true }));
        setNotice(credit.message || '目前已無尚未開賽場次；空白等待卡已移除。');
        setProgress({ active: false, done: 0, running: 0, total: 0, label: '' });
        return true;
      }
      if (credit?.blocked === true) {
        creditRevisionRef.current = '';
        officialPrestartCheckedAtRef.current = Date.now();
        autoAnalyzeHashRef.current = requestedAutoKey || readerHashKey(targetDate, credit.payloadHash);
        setBoard(current => current.map(markReaderBoardVerificationBlocked));
        setNotice(credit.message || 'Reader資料驗證未通過；已停止分析與下注。');
        setProgress({ active: false, done: 0, running: 0, total: 0, label: '' });
        return false;
      }

      setProgress({ active: true, done: 0, running: 1, total: 1, label: '取得獨立國際市場同合約參考盤' });
      const references = await fetchReferenceLines(games, targetDate, credit.games || []);
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;
      const referenceByPk = new Map((references.games || []).map(row => [Number(row.gamePk), row]));

      const readerCreditReady = credit?.provider === 'TAI888_READER_AUTO'
        && credit?.readerFresh === true
        && credit?.blocked !== true;
      const creditByPk = new Map((readerCreditReady ? credit.games || [] : []).map(row => [Number(row.gamePk), row]));
      const unopenedByPk = new Map((readerCreditReady ? credit.unopenedGames || [] : []).map(row => [Number(row.gamePk), row]));
      const readerGameByPk = new Map([...unopenedByPk, ...creditByPk]);
      const activeItems = games.map(game => {
        const previous = previousByPk.get(Number(game.gamePk));
        const foundCredit = readerGameByPk.get(Number(game.gamePk));
        const foundReference = referenceByPk.get(Number(game.gamePk));
        const represented = Boolean(foundCredit);
        const hasOpenRows = Boolean(foundCredit?.markets?.length);
        const previousBlocked = analysisFailureState(previous?.analysisFailure || {}).blocked;
        const coverageRegression = hasOpenRows
          && readerMarketsLoseCalculatedCoverage(previous?.customData, foundCredit.markets);
        const preservePreviousReaderAnalysis = Boolean(previous)
          && analysisHasCalculatedDirections(previous?.customData)
          && (!hasOpenRows || coverageRegression);
        const resumed = hasOpenRows && !coverageRegression && previous && !previousBlocked
          ? advanceUnchangedReaderGame(previous, foundCredit.markets, credit.payloadHash, credit.pageActivityAt, Date.now(), {
            actualSource: foundCredit.source,
            marketCoverage: foundCredit.marketCoverage,
            readerProvenance: foundCredit.readerProvenance,
          })
          : null;
        const pendingReaderAnalysis = Boolean(previous)
          && analysisHasCalculatedDirections(previous?.customData)
          && hasOpenRows
          && !coverageRegression
          && !resumed;
        const retainingPreviousRevision = preservePreviousReaderAnalysis || pendingReaderAnalysis;
        const waitingForReader = preservePreviousReaderAnalysis
          || (represented && (!hasOpenRows || coverageRegression));
        const pendingMarketNames = [...new Set((foundCredit?.markets || []).map(row => row?.market).filter(Boolean))];
        const currentMarketCoverage = foundCredit?.marketCoverage || (waitingForReader || pendingReaderAnalysis ? {
          openMarkets: pendingMarketNames.length,
          availableMarkets: pendingMarketNames,
          blockedMarkets: [],
        } : null);
        const waitingReason = foundCredit?.unavailableReason === 'not-rendered-by-reader'
          ? 'Reader目前未呈現盤口'
          : coverageRegression ? 'Reader目前部分市場尚未開盤' : 'Tai888目前尚未開盤';
        return {
          game,
          mode: 'actual',
          actualSource: resumed?.actualSource || (retainingPreviousRevision ? previous?.actualSource : foundCredit?.source) || previous?.actualSource || null,
          marketCoverage: retainingPreviousRevision ? previous?.marketCoverage || null : foundCredit?.marketCoverage || previous?.marketCoverage || null,
          latestMarketCoverage: waitingForReader || pendingReaderAnalysis ? currentMarketCoverage : null,
          latestReaderSource: waitingForReader || pendingReaderAnalysis ? foundCredit?.source || null : null,
          readerProvenance: retainingPreviousRevision ? previous?.readerProvenance || null : foundCredit?.readerProvenance || previous?.readerProvenance || null,
          readerPayloadHash: resumed?.readerPayloadHash || null,
          customMarkets: resumed?.customMarkets || (retainingPreviousRevision ? previous?.customMarkets || [] : represented ? foundCredit.markets || [] : previous?.customMarkets || []),
          verificationMarkets: retainingPreviousRevision ? previous?.verificationMarkets || [] : foundReference?.markets || [],
          referenceSource: retainingPreviousRevision ? previous?.referenceSource || null : foundReference?.source || previous?.referenceSource || null,
          status: resumed || preservePreviousReaderAnalysis ? 'done' : represented && hasOpenRows ? 'queued' : 'unopened',
          statusLabel: represented
            ? resumed ? 'Tai888盤口未變｜接續完成'
              : preservePreviousReaderAnalysis ? `${waitingReason}｜保留上一版分析`
                : hasOpenRows ? previous?.customData ? '後台更新中｜保留目前分數' : '等待分析'
                  : `${waitingReason}｜持續自動監看`
            : previous?.customData ? 'Reader未呈現｜保留上一版結果' : '目前尚無可配對盤口',
          referenceData: resumed?.referenceData
            || (waitingForReader ? preservePreviousReaderAnalysis ? previous?.referenceData || null : null : previous?.referenceData || null),
          customData: resumed?.customData
            || (waitingForReader ? preservePreviousReaderAnalysis ? previous?.customData || null : null : previous?.customData || null),
          restoredFromCache: resumed ? false : previous?.restoredFromCache,
          resumedCurrentReaderGame: Boolean(resumed),
          preservedCurrentReaderGame: preservePreviousReaderAnalysis,
          pendingReaderAnalysis,
          readerWaitingHandled: waitingForReader,
          error: '',
        };
      });
      const activeGamePks = new Set(activeItems.map(item => Number(item.game.gamePk)));
      const retainedFinishedItems = [...previousByPk.values()]
        .filter(item => !activeGamePks.has(Number(item?.game?.gamePk))
          && analysisHasCalculatedDirections(item?.customData))
        .map(item => ({
          ...item,
          readerPayloadHash: null,
          latestMarketCoverage: null,
          latestReaderSource: null,
          pendingReaderAnalysis: false,
          preservedCurrentReaderGame: false,
          readerWaitingHandled: false,
          status: 'done',
          statusLabel: '目前已不在官方賽前清單｜保留賽前分析與排名｜停止記錄新下注',
          error: '',
        }));
      const items = [...retainedFinishedItems, ...activeItems]
        .sort((left, right) => Date.parse(left?.game?.gameDate || '') - Date.parse(right?.game?.gameDate || ''));
      setBoard(items);

      const tasks = items.map(item => {
        const actual = readerGameByPk.get(Number(item.game.gamePk));
        return actual?.markets?.length && !item.resumedCurrentReaderGame && !item.preservedCurrentReaderGame ? {
          game: item.game,
          actualMarkets: actual.markets || [],
          actualSource: actual.source,
          marketCoverage: actual.marketCoverage,
          readerProvenance: actual.readerProvenance,
          readerPayloadHash: credit.payloadHash,
          unavailableReason: actual.unavailableReason || null,
          verificationMarkets: referenceByPk.get(Number(item.game.gamePk))?.markets || item.verificationMarkets || [],
          generation,
        } : null;
      }).filter(Boolean);
      const coverage = readerCoverageCounts({
        rawGameCount: credit.rawGameCount,
        matchedGameCount: credit.matchedGameCount ?? tasks.length,
        unopenedGameCount: credit.unopenedGameCount,
        scheduleGameCount: credit.scheduleGameCount || games.length,
      });
      const sourceWarnings = [
        credit.error ? `Tai888信用盤：${credit.error}` : '',
        credit.blocked && credit.message ? `Tai888信用盤：${credit.message}` : '',
        references.message ? `獨立參考盤：${references.message}` : '',
        ...(references.failures || []).map(message => `獨立參考盤：${message}`),
        ...(credit.warnings || []),
      ].filter(Boolean);

      if (!tasks.length) {
        if (items.some(item => item.resumedCurrentReaderGame || item.preservedCurrentReaderGame || item.readerWaitingHandled)) {
          const completedKey = readerHashKey(targetDate, credit.payloadHash);
          const acknowledged = credit?.blocked === true
            ? false
            : await confirmLiveReaderHash(targetDate, credit.payloadHash, generation);
          if (acknowledged) {
            creditRevisionRef.current = completedKey;
            autoAnalyzeHashRef.current = completedKey;
            setAcknowledgedReaderKey(completedKey);
          }
          setNotice(`Reader讀取 ${coverage.captured}/${coverage.total} 場｜目前沒有需要重算的已開盤場次｜${coveragePendingText(coverage)}。`);
          setProgress({ active: false, done: 0, running: 0, total: 0, label: '' });
          return acknowledged;
        }
        setNotice(sourceWarnings.join('；') || credit.message || `目前 Tai888 Reader 沒有可分析的${activeLeague.shortLabel}信用盤。`);
        setProgress({ active: false, done: 0, running: 0, total: 0, label: '' });
        return false;
      }

      const backgroundResult = await runDurableAnalysisTasks(tasks, generation, targetDate);
      const resultRows = Array.isArray(backgroundResult?.results) ? backgroundResult.results : [];
      const outcomes = tasks.map((task, index) => Boolean(resultRows[index]?.ok));
      const blockedCount = tasks.filter((task, index) => analysisFailureState(resultRows[index]).blocked).length;
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;
      const creditCount = tasks.length;
      const completedCreditCount = outcomes.filter(Boolean).length;
      const failedCreditCount = creditCount - completedCreditCount;
      const readerHashRequired = Boolean(credit?.readerFresh && creditCount > 0);
      const hashEligible = readerHashRequired && shouldAcknowledgeReaderHash({
        payloadHash: credit.payloadHash,
        expectedCount: creditCount,
        completedCount: completedCreditCount,
        failedCount: failedCreditCount,
      });
      let readerHashAcknowledged = !readerHashRequired;
      const creditRevision = readerHashKey(targetDate, credit.payloadHash);
      if (hashEligible && await confirmLiveReaderHash(targetDate, credit.payloadHash, generation)) {
        creditRevisionRef.current = creditRevision;
        const completedKey = readerHashKey(targetDate, credit.payloadHash);
        autoAnalyzeHashRef.current = completedKey;
        setAcknowledgedReaderKey(completedKey);
        if (requestedAutoKey && requestedAutoKey !== completedKey) autoAnalyzeHashRef.current = completedKey;
        readerHashAcknowledged = true;
      }
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;
      const analysisSucceeded = outcomes.every(Boolean);
      const allSucceeded = analysisSucceeded && readerHashAcknowledged;
      const completedCount = outcomes.filter(Boolean).length;
      const failedCount = Math.max(0, tasks.length - completedCount - blockedCount);
      if (allSucceeded) {
        setNotice(`Reader讀取 ${coverage.captured}/${coverage.total} 場｜完成 ${tasks.length} 場驗證分析｜${coveragePendingText(coverage)}${sourceWarnings.length ? `｜提醒：${sourceWarnings.join('；')}` : ''}`);
      } else if (analysisSucceeded && !readerHashAcknowledged) {
        setNotice(`Reader讀取 ${coverage.captured}/${coverage.total} 場｜已完成 ${tasks.length} 場分析｜${coveragePendingText(coverage)}，但 Reader 在分析期間出現新盤；目前結果保留顯示。`);
        setError('Reader 最新盤面版本尚未完成驗證；下次輪詢只更新變動場次，不會清空整批分數。');
      } else {
        setNotice(`Reader讀取 ${coverage.captured}/${coverage.total} 場｜完成 ${completedCount} 場｜資料不足 ${blockedCount} 場${failedCount ? `｜暫時失敗 ${failedCount} 場` : ''}｜${coveragePendingText(coverage)}${sourceWarnings.length ? `｜提醒：${sourceWarnings.join('；')}` : ''}`);
        if (blockedCount) {
          setError(`${blockedCount} 場官方先發身分、左右投或獨立表現資料不足，QA 已停止評分；同一盤面每5分鐘重驗一次，也可按「同步今日 ${activeLeague.id}」立即重驗。${failedCount ? `另有 ${failedCount} 場暫時分析失敗。` : ''}`);
        } else {
          const readerHashPending = Boolean(credit?.readerFresh && creditCount > 0 && failedCreditCount > 0);
          setError(`${failedCount} 場暫時分析失敗${readerHashPending ? '，Reader 最新盤面版本尚未承認' : ''}；已保留成功場次與上一版結果。`);
        }
      }
      return allSucceeded;
    } catch (cause) {
      setBoard(current => current.map(item => item.customData && ['running', 'queued'].includes(item.status)
        ? { ...item, status: 'failed', statusLabel: '更新失敗｜保留上一版結果' }
        : item));
      setError(`${String(cause?.message || cause)}；已保留上一版分數。`);
      return false;
    }
    finally {
      if (generation === analysisGenerationRef.current && currentDateRef.current === targetDate) {
        releaseOperation();
        setProgress(value => ({ ...value, active: false }));
      }
    }
  }

  function blockedReaderHashRecheckDue(payloadHash, now = Date.now()) {
    return boardRef.current.some(item => {
      const failure = analysisFailureState(item?.analysisFailure || {});
      if (!failure.blocked || item?.analysisFailure?.readerPayloadHash !== payloadHash) return false;
      const evidenceHash = item?.analysisFailure?.readerEvidenceHash || payloadHash;
      const retryKey = coreDataBlockKey(league, date, item?.game?.gamePk, evidenceHash);
      const storedRetryAt = Number(coreDataBlockRetryRef.current.get(retryKey));
      const itemRetryAt = Date.parse(item?.analysisFailure?.retryAt || '');
      const retryAt = Number.isFinite(storedRetryAt) && storedRetryAt > 0 ? storedRetryAt : itemRetryAt;
      return !Number.isFinite(retryAt) || retryAt <= now;
    });
  }

  function readerBoardNeedsCoreRefresh(now = Date.now()) {
    return boardRef.current.some(item => {
      if (!gameIsPrestartNow(item?.game, now)
        || !item?.readerPayloadHash
        || !item?.customData?.context
        || assessCoreSnapshotFreshnessV109(item.customData.context, now).fresh) return false;
      const failure = analysisFailureState(item?.analysisFailure || {});
      if (!failure.blocked) return true;
      const evidenceHash = item?.analysisFailure?.readerEvidenceHash
        || item?.analysisFailure?.readerPayloadHash;
      const retryKey = coreDataBlockKey(league, date, item?.game?.gamePk, evidenceHash);
      const storedRetryAt = Number(coreDataBlockRetryRef.current.get(retryKey));
      const itemRetryAt = Date.parse(item?.analysisFailure?.retryAt || '');
      const retryAt = Number.isFinite(storedRetryAt) && storedRetryAt > 0 ? storedRetryAt : itemRetryAt;
      return !Number.isFinite(retryAt) || retryAt <= now;
    });
  }

  async function pollReaderAndReprice() {
    if (operationBusyRef.current || readerPollBusyRef.current || !boardRef.current.length) return;
    const targetDate = date;
    const generation = analysisGenerationRef.current;
    const stillCurrent = () => generation === analysisGenerationRef.current && currentDateRef.current === targetDate;
    readerPollBusyRef.current = true;
    let fullSlateRecoveryNeeded = false;
    try {
      const status = await requestJSON(`/api/reader/status?league=${encodeURIComponent(league)}&date=${encodeURIComponent(targetDate)}&t=${Date.now()}`, {}, 20000);
      if (!stillCurrent()) return;
      commitReaderStatus(status);
      const currentStatus = readerStatusRef.current;
      const statusRevision = readerHashKey(targetDate, currentStatus?.payloadHash);
      if (!currentStatus?.fresh || !statusRevision) return;
      if (statusRevision === creditRevisionRef.current
        && !blockedReaderHashRecheckDue(currentStatus.payloadHash)
        && !readerBoardNeedsCoreRefresh()
        && Date.now() - officialPrestartCheckedAtRef.current < OFFICIAL_PRESTART_RECHECK_MS) {
        setBoard(current => current.map(item => touchReaderHeartbeat(
          item,
          currentStatus.payloadHash,
          currentStatus.pageActivityAt,
        )));
        return;
      }
      const games = schedule.length ? schedule : boardRef.current.map(item => item.game);
      const credit = await requestJSON('/api/credit-lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ league, date: targetDate, schedule: games }),
      }, 60000);
      if (!stillCurrent()) return;
      officialPrestartCheckedAtRef.current = Date.now();
      if (credit?.code === 'NO_PRESTART_GAMES') {
        creditRevisionRef.current = '';
        autoAnalyzeHashRef.current = readerHashKey(targetDate, credit.payloadHash || currentStatus?.payloadHash);
        setSchedule([]);
        setBoard(current => finalizeReaderBoardAtStart(current, Date.now(), { noPrestartGames: true }));
        setNotice(credit.message || '目前已無尚未開賽場次；空白等待卡已移除。');
        return;
      }
      if (credit?.blocked === true) {
        creditRevisionRef.current = '';
        autoAnalyzeHashRef.current = readerHashKey(targetDate, credit.payloadHash || currentStatus?.payloadHash);
        setBoard(current => current.map(markReaderBoardVerificationBlocked));
        setNotice(credit.message || 'Reader資料驗證未通過；已停止分析與下注。');
        return;
      }
      const creditRevision = readerHashKey(targetDate, credit.payloadHash);
      if (credit.provider !== 'TAI888_READER_AUTO' || !credit.readerFresh || !creditRevision) return;
      if (creditRevision === creditRevisionRef.current
        && !blockedReaderHashRecheckDue(credit.payloadHash)
        && !readerBoardNeedsCoreRefresh()) {
        setBoard(current => current.map(item => touchReaderHeartbeat(item, credit.payloadHash, credit.pageActivityAt)));
        return;
      }
      const creditByPk = new Map((credit.games || []).map(row => [Number(row.gamePk), row]));
      const unopenedByPk = new Map((credit.unopenedGames || []).map(row => [Number(row.gamePk), row]));
      const readerGameByPk = new Map([...unopenedByPk, ...creditByPk]);
      const references = await fetchReferenceLines(games, targetDate, credit.games || []);
      if (!stillCurrent()) return;
      const currentBoard = boardRef.current;
      const referenceByPk = new Map((references.games || []).map(row => [Number(row.gamePk), row]));
      const boardPks = new Set(currentBoard.map(item => Number(item.game.gamePk)));
      const missingReaderGameCount = [...readerGameByPk.keys()].filter(gamePk => !boardPks.has(gamePk)).length;
      if (missingReaderGameCount > 0) {
        fullSlateRecoveryNeeded = true;
        setNotice(`Reader有 ${readerGameByPk.size} 場、目前畫面缺少 ${missingReaderGameCount} 場；正在自動補齊完整賽程。`);
        return;
      }
      const expectedItems = currentBoard.filter(item => gameIsPrestartNow(item.game, Date.now())
        && (readerGameByPk.has(Number(item.game.gamePk)) || item.actualSource?.provider === 'TAI888_READER_AUTO'));
      let failed = 0;
      let blocked = 0;
      let completed = 0;
      let updated = 0;
      let removed = 0;
      const rebuildTasks = [];
      await runPool(currentBoard, 2, async item => {
        if (!stillCurrent()) return;
        if (!gameIsPrestartNow(item.game, Date.now())) return;
        const actual = readerGameByPk.get(Number(item.game.gamePk));
        if (!actual) {
          if (item.actualSource?.provider === 'TAI888_READER_AUTO') {
            const preserve = analysisHasCalculatedDirections(item.customData);
            setBoard(current => current.flatMap(currentItem => {
              if (Number(currentItem?.game?.gamePk) !== Number(item.game.gamePk)) return [currentItem];
              return preserve ? [{
                ...currentItem,
                readerPayloadHash: null,
                latestMarketCoverage: null,
                latestReaderSource: null,
                pendingReaderAnalysis: false,
                preservedCurrentReaderGame: false,
                readerWaitingHandled: false,
                status: 'done',
                statusLabel: '目前已不在官方賽前清單｜保留賽前分析｜停止記錄新下注',
                error: '',
              }] : [];
            }));
            if (item.customMarkets?.length) removed += 1;
            completed += 1;
          }
          return;
        }
        const coverageRegression = readerMarketsLoseCalculatedCoverage(item?.customData, actual.markets || []);
        if (!actual.markets?.length || coverageRegression) {
          const preserve = analysisHasCalculatedDirections(item?.customData);
          updateBoard(item.game.gamePk, current => ({
            ...current,
            latestMarketCoverage: actual.marketCoverage || null,
            latestReaderSource: actual.source || null,
            readerPayloadHash: null,
            pendingReaderAnalysis: false,
            preservedCurrentReaderGame: preserve,
            readerWaitingHandled: true,
            status: preserve ? 'done' : 'unopened',
            statusLabel: preserve
              ? !actual.markets?.length
                ? 'Reader目前未呈現盤口｜保留上一版分析'
                : 'Reader目前部分市場尚未開盤｜保留上一版分析'
              : actual.unavailableReason === 'not-rendered-by-reader'
                ? 'Reader目前未呈現盤口｜持續自動監看'
                : 'Tai888目前尚未開盤｜持續自動監看',
            referenceData: preserve ? current.referenceData : null,
            customData: preserve ? current.customData : null,
            customMarkets: preserve ? current.customMarkets : [],
            restoredFromCache: false,
            analysisFailure: null,
            error: '',
          }));
          if (item.customMarkets?.length) removed += 1;
          completed += 1;
          return;
        }
        const rebuildTask = {
          game: item.game,
          actualMarkets: actual.markets,
          actualSource: actual.source,
          marketCoverage: actual.marketCoverage,
          readerProvenance: actual.readerProvenance,
          readerPayloadHash: credit.payloadHash,
          verificationMarkets: referenceByPk.get(Number(item.game.gamePk))?.markets || item.verificationMarkets || [],
          generation,
        };
        const priorFailure = analysisFailureState(item.analysisFailure || {});
        const currentEvidenceHash = readerGameEvidenceHash(rebuildTask);
        const priorEvidenceHash = item.analysisFailure?.readerEvidenceHash
          || item.analysisFailure?.readerPayloadHash;
        const sameBlockedEvidence = priorFailure.blocked
          && Boolean(currentEvidenceHash)
          && priorEvidenceHash === currentEvidenceHash;
        if (sameBlockedEvidence) {
          const retryKey = coreDataBlockKey(league, targetDate, item.game.gamePk, currentEvidenceHash);
          const storedRetryAt = Number(coreDataBlockRetryRef.current.get(retryKey));
          const itemRetryAt = Date.parse(item.analysisFailure?.retryAt || '');
          const retryAt = Number.isFinite(storedRetryAt) && storedRetryAt > 0 ? storedRetryAt : itemRetryAt;
          if (Number.isFinite(retryAt) && retryAt > Date.now()) {
            blocked += 1;
            return;
          }
          coreDataBlockRetryRef.current.set(retryKey, Date.now() + CORE_DATA_BLOCK_RECHECK_MS);
          updateBoard(item.game.gamePk, current => ({
            ...current,
            readerPayloadHash: null,
            latestMarketCoverage: actual.marketCoverage || null,
            latestReaderSource: actual.source || null,
            pendingReaderAnalysis: true,
            preservedCurrentReaderGame: false,
            readerWaitingHandled: false,
            status: 'running',
            statusLabel: '後台重新驗證中｜保留目前分數｜停止下注',
            error: '',
          }));
          rebuildTasks.push(rebuildTask);
          return;
        }
        if (item.readerPayloadHash === credit.payloadHash && coreSnapshotReusable(item)) {
          updateBoard(item.game.gamePk, current => touchReaderHeartbeat(current, credit.payloadHash, credit.pageActivityAt));
          completed += 1;
          return;
        }
        const unchanged = actual.markets?.length
          ? advanceUnchangedReaderGame(item, actual.markets, credit.payloadHash, credit.pageActivityAt, Date.now(), {
            actualSource: actual.source,
            marketCoverage: actual.marketCoverage,
            readerProvenance: actual.readerProvenance,
          })
          : null;
        if (unchanged) {
          updateBoard(item.game.gamePk, () => unchanged);
          completed += 1;
          return;
        }
        const snapshot = snapshots.current.get(item.game.gamePk);
        if (!snapshot || !item.referenceData || !coreSnapshotReusable(item)) {
          updateBoard(item.game.gamePk, current => ({
            ...current,
            readerPayloadHash: null,
            latestMarketCoverage: actual.marketCoverage || null,
            latestReaderSource: actual.source || null,
            pendingReaderAnalysis: true,
            preservedCurrentReaderGame: false,
            readerWaitingHandled: false,
            status: 'running',
            statusLabel: '後台重新驗證中｜保留目前分數｜停止下注',
            error: '',
          }));
          rebuildTasks.push(rebuildTask);
          return;
        }
        try {
          const directRepriceTask = rebuildTask;
          const directRepriceEvidenceHash = readerGameEvidenceHash(directRepriceTask);
          updateBoard(item.game.gamePk, current => ({
            ...current,
            readerPayloadHash: null,
            latestMarketCoverage: actual.marketCoverage || null,
            latestReaderSource: actual.source || null,
            pendingReaderEvidenceHash: directRepriceEvidenceHash || null,
            pendingReaderAnalysis: true,
            preservedCurrentReaderGame: false,
            readerWaitingHandled: false,
            status: 'running',
            statusLabel: '盤口快速重算中｜保留目前分數｜停止下注',
            error: '',
          }));
          const data = await requestJSON('/api/reprice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
            body: JSON.stringify({
              league,
              snapshot,
              markets: actual.markets || [],
              readerProvenance: actual.readerProvenance || null,
              previousMarkets: item.customMarkets || [],
              verificationMarkets: referenceByPk.get(Number(item.game.gamePk))?.markets || item.verificationMarkets || [],
              settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },
            }),
          }, 120000);
          if (!stillCurrent()) return;
          const currentDirectItem = boardRef.current.find(current => (
            Number(current?.game?.gamePk) === Number(item.game.gamePk)
          )) || null;
          if (taskReaderStateIsStale(directRepriceTask)
            || !directRepriceAuthorityMatches(currentDirectItem, directRepriceTask)) {
            failed += 1;
            return;
          }
          setBoard(items => {
            const currentItem = items.find(current => (
              Number(current?.game?.gamePk) === Number(item.game.gamePk)
            )) || null;
            if (!directRepriceAuthorityMatches(currentItem, directRepriceTask)) return items;
            snapshots.current.set(item.game.gamePk, data.repriceSnapshot);
            return items.map(current => Number(current?.game?.gamePk) === Number(item.game.gamePk) ? {
              ...current,
              actualSource: actual.source,
              marketCoverage: actual.marketCoverage || current.marketCoverage || null,
              latestMarketCoverage: null,
              latestReaderSource: null,
              pendingReaderEvidenceHash: null,
              readerProvenance: actual.readerProvenance || current.readerProvenance || null,
              readerPayloadHash: credit.payloadHash,
              customMarkets: actual.markets || [],
              verificationMarkets: referenceByPk.get(Number(item.game.gamePk))?.markets || item.verificationMarkets || [],
              referenceSource: referenceByPk.get(Number(item.game.gamePk))?.source || item.referenceSource || null,
              customData: compactAnalysisData(data),
              restoredFromCache: false,
              analysisFailure: null,
              pendingReaderAnalysis: false,
              preservedCurrentReaderGame: false,
              readerWaitingHandled: false,
              status: 'done',
              statusLabel: Number(data?.analysis?.calculatedDirectionCount || 0) === 0
                ? '八方向槽位已更新｜目前尚未開盤或市場資料異常'
                : 'Tai888最新盤快速重算完成',
              error: '',
            } : current);
          });
          if (item.customMarkets?.length && !actual.markets?.length) removed += 1;
          updated += 1;
          completed += 1;
        } catch (cause) {
          const currentDirectItem = boardRef.current.find(current => (
            Number(current?.game?.gamePk) === Number(item.game.gamePk)
          )) || null;
          if (taskReaderStateIsStale(rebuildTask)
            || !directRepriceAuthorityMatches(currentDirectItem, rebuildTask)) {
            failed += 1;
            return;
          }
          const failure = analysisFailureState(cause);
          if (failure.blocked) {
            blocked += 1;
          } else {
            failed += 1;
          }
          commitAnalysisFailure(rebuildTask, cause);
        }
      });
      if (rebuildTasks.length && stillCurrent()) {
        operationBusyRef.current = true;
        setBusy(true);
        try {
          const rebuilt = await runDurableAnalysisTasks(rebuildTasks, generation, targetDate, {
            progressLabel: '伺服器背景重建比分分布',
            noticeLabel: `已交給伺服器背景重建 ${rebuildTasks.length} 場比分分布`,
          });
          const rows = Array.isArray(rebuilt?.results) ? rebuilt.results : [];
          const rebuiltCompleted = rows.filter(row => row?.ok).length;
          const rebuiltBlocked = rows.filter(row => !row?.ok && analysisFailureState(row).blocked).length;
          const rebuiltFailed = Math.max(0, rebuildTasks.length - rebuiltCompleted - rebuiltBlocked);
          completed += rebuiltCompleted;
          updated += rebuiltCompleted;
          blocked += rebuiltBlocked;
          failed += rebuiltFailed;
        } catch (cause) {
          failed += rebuildTasks.length;
          setError(`伺服器背景重建暫時失敗：${String(cause?.message || cause)}；已保留上一版分數。`);
        } finally {
          if (generation === analysisGenerationRef.current && currentDateRef.current === targetDate) releaseOperation();
        }
      }
      if (!stillCurrent()) return;
      const hashEligible = shouldAcknowledgeReaderHash({ payloadHash: credit.payloadHash, expectedCount: expectedItems.length, completedCount: completed, failedCount: failed });
      const acknowledged = hashEligible && await confirmLiveReaderHash(targetDate, credit.payloadHash, generation);
      if (!stillCurrent()) return;
      if (acknowledged) {
        creditRevisionRef.current = creditRevision;
        const completedKey = readerHashKey(targetDate, credit.payloadHash);
        autoAnalyzeHashRef.current = completedKey;
        setAcknowledgedReaderKey(completedKey);
      }
      if (updated || removed || blocked) {
        setNotice(`Tai888盤口處理完成：${updated}場更新${removed ? '｜' + removed + '場已下架但保留舊結果' : ''}${blocked ? '｜' + blocked + '場核心資料不足' : ''}${failed ? '｜' + failed + '場暫時失敗' : ''}。`);
      }
      if (blocked) {
        setError(`${blocked}場官方先發身分、左右投或獨立表現資料不足，QA 已停止評分；同一盤面每5分鐘重驗一次，也可按「同步今日 ${activeLeague.id}」立即重驗。${failed ? `另有 ${failed} 場盤口更新暫時失敗。` : ''}`);
      } else if (failed) {
        setError(`${failed}場盤口更新暫時失敗；已保留上一版分數，下次輪詢只重試暫時失敗場次。`);
      }
    } catch (cause) {
      if (stillCurrent()) invalidateReaderStatus(cause?.message || cause);
    } finally {
      readerPollBusyRef.current = false;
      if (fullSlateRecoveryNeeded && stillCurrent()) void oneClickAnalyze();
    }
  }

  async function recordBet(item, row) {
    if (!bettingEnabled) {
      setError(`${activeLeague.label}目前不可寫入實際下注紀錄`);
      return;
    }
    const state = getBetState(item, row);
    if (state.latest) {
      setNotice(`此方向已經記錄；盤口或水位變動也不再新增：${translateTeamText(row.pick)}`);
      return;
    }
    const now = Date.now();
    const currentReaderPrice = itemReaderExecutable(item)
      && item?.actualSource?.provider === 'TAI888_READER_AUTO'
      && row?.provider === 'TAI888_READER_AUTO'
      && row?.evCalibration?.actualReaderEligible === true;
    if (cloudLedgerStatus.state === 'unavailable') {
      setError('永久雲端帳本目前無法寫入；系統不會把未保存的下注顯示成成功');
      return;
    }
    if (!betRecordable(item, row, now, bettingEnabled, currentReaderPrice, true)) {
      setError('只有仍未開賽、Reader最新驗證完成且有實際信用盤水位的方向可以記錄');
      return;
    }
    const identity = betIdentity(date, item.game.gamePk, row, league);
    const positionIdentity = betPositionIdentity(date, item.game.gamePk, row, league);
    const bet = {
      id: uid(),
      identity,
      positionIdentity,
      league,
      date,
      gamePk: item.game.gamePk,
      gameNumber: item.game.gameNumber || 1,
      officialDate: item.game.officialDate || date,
      matchup: `${teamNameZh(item.game.away)} 對 ${teamNameZh(item.game.home)}`,
      gameDate: item.game.gameDate,
      away: teamNameZh(item.game.away),
      home: teamNameZh(item.game.home),
      market: row.market,
      pick: row.pick,
      water: row.water,
      stake: settings.unitValue,
      unit: null,
      rebateRate: settings.rebateRate,
      betSource: 'TAI888_READER_AUTO',
      analysisMode: 'SHADOW',
      score: null,
      scoreStatus: 'SHADOW_DIAGNOSTIC_NOT_FORMAL',
      formulaDiagnosticScore: row.formulaDiagnosticScore ?? null,
      shadowDiagnosticScore: row.shadowDiagnosticScore ?? null,
      legacyDiagnosticScore: row.legacyDiagnosticScore ?? null,
      weightedEV: modelEvValue(row),
      robustEV: robustEvValue(row),
      rawModelWeightedEV: modelEvValue(row),
      rawModelRobustEV: robustEvValue(row),
      qaStatus: row.scoreAudit?.ok === false ? 'BLOCK' : 'SHADOW_DIAGNOSTIC',
      placedContractSnapshot: {
        pick: row.pick,
        water: row.water,
        market: row.market,
        sourceType: row.sourceType,
        lineAsOf: row.lineAsOf || null,
      },
      lineAsOf: row.lineAsOf || null,
      readerPayloadHash: readerStatus?.payloadHash || null,
      rawBoardHash: readerStatus?.rawBoardHash || null,
      readerRevision: currentReaderKey || null,
      snapshotId: item.customData?.analysis?.snapshotId || null,
      pitSnapshotId: item.customData?.analysis?.pitSnapshotId || null,
      pitPersistenceStatus: item.customData?.pitPersistence?.status || null,
      analysisAsOf: item.customData?.analysis?.analysisAsOf || null,
      dataAsOf: item.customData?.analysis?.dataAsOf || item.customData?.context?.fetchedAt || null,
      inputHash: item.customData?.analysis?.inputHash || item.customData?.analysis?.snapshotId || null,
      coreFingerprint: item.customData?.analysis?.coreFingerprint || null,
      priceFingerprint: item.customData?.analysis?.priceFingerprint || null,
      distributionHash: item.customData?.analysis?.distributionHash || null,
      featureObservedAts: calibrationFeatureTimes(item.customData?.context),
      modelVersion: item.customData?.analysis?.modelVersion || row.modelVersion || null,
      scoreFormulaVersion: row.scoreFormulaVersion || item.customData?.analysis?.scoreFormulaVersion || null,
      settlementRuleVersion: row.settlementRuleVersion || null,
      qa: { scoreAudit: row.scoreAudit || null, pairAudit: row.pairAudit || null, thirdAudit: row.thirdAudit || null },
      placedAt: new Date().toISOString(),
      status: 'OPEN',
    };
    try {
      const data = await requestJSON('/api/bets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'upsert', bet }) }, 30000);
      if (!Array.isArray(data.bets)) throw new Error('雲端下注紀錄回傳格式錯誤');
      betsRef.current = data.bets;
      setBets(data.bets);
      setCalibrationStatus(data.calibration || null);
      cloudSyncRetryAtRef.current = 0;
      setCloudLedgerStatus({ state: 'ready', code: '', message: '' });
      setError('');
      setNotice(`已雲端記錄實際下注：${translateTeamText(row.pick)}｜${Number(row.water).toFixed(3)}｜${Number(settings.unitValue).toLocaleString()}元`);
    } catch (cause) {
      if (String(cause?.code || '').startsWith('DATABASE_') || Number(cause?.status) >= 500) {
        reportCloudLedgerFailure(cause);
      }
      setError(cause?.message || '雲端下注紀錄更新失敗');
    }
  }

  function selectLeague(value) {
    const nextLeague = normalizeLeagueId(value);
    if (nextLeague === league) return;
    // Analysis runs are durable server jobs. Switching the visible league only
    // detaches this screen from the old poll; it does not cancel the server run.
    // The saved job is reattached when the user returns to that league/date.
    if (operationBusyRef.current) {
      operationBusyRef.current = false;
      setBusy(false);
      setProgress(value => ({ ...value, active: false, running: 0 }));
    }
    currentLeagueRef.current = nextLeague;
    analysisGenerationRef.current += 1;
    setError('');
    setNotice('');
    setTab('board');
    setLeague(nextLeague);
  }

  return <main className="appShell">
    <header className="appHeader">
      <div><div className="eyebrow">BASEBALL DATA & BET LEDGER</div><h1>{activeLeague.label}｜盤口與實際下注系統</h1><p>每場使用一份聯盟專屬的凍結聯合比分分布，依Tai888實際盤口逐腿結算八個方向；前台以固定S分數為主，模型EV（W）與穩健EV（R）作次要診斷。Tai888與外部市場都不回灌模型概率。</p></div>
      <div className="headerBadges"><span className={health?.ready ? 'health ok' : 'health warn'}>{health == null ? '系統檢查中' : health.ready ? '必要設定已提供｜PIT寫入依逐場狀態' : `系統設定未完成｜${(health.readinessReasons || ['設定待確認'])[0]}`}</span><span className={`state ${activeLeague.status}`}>{activeLeague.statusLabel}</span><button type="button" className="appRefreshButton" title="重新整理並取得最新版" onClick={() => window.location.reload()}>↻ 更新</button><span className="version">v{VERSION}</span></div>
    </header>

    <nav className="leagueTabs" aria-label="聯盟切換">
      {LEAGUE_IDS.map(id => {
        const config = leagueConfig(id);
        return <button key={id} className={league === id ? 'active' : ''} onClick={() => selectLeague(id)} aria-pressed={league === id}>
          <span className={`leagueDot ${config.status}`}/><b>{id}</b><small>{config.shortLabel}</small>
        </button>;
      })}
    </nav>

    <nav className="mainTabs">
      <button className={tab === 'board' ? 'active' : ''} onClick={() => setTab('board')}>今日盤口</button>
      <button className={tab === 'ranking' ? 'active' : ''} onClick={() => setTab('ranking')}>全部方向</button>
      <button className={tab === 'betOrder' ? 'active' : ''} onClick={() => setTab('betOrder')}>影子候選順序</button>
      <button className={tab === 'bets' ? 'active' : ''} onClick={() => setTab('bets')}>下注紀錄</button>
      <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>設定</button>
    </nav>

    {error && <div className="errorBox global"><strong>發生問題</strong><span>{error}</span><button onClick={() => setError('')}>關閉</button></div>}
    {notice && <div className="noticeBox">{notice}</div>}
    <LoadingLine progress={progress}/>

    {tab === 'board' && <>
      <section className="heroCard">
        <div className="heroCopy"><span className="kicker">每日主要操作</span><h2>同步今日全部 {activeLeague.id} 實際盤</h2><p>只使用Reader同步的實際信用盤。比分分布與逐腿結算完整時，先顯示固定S分數，再列模型EV（W）與穩健EV（R）。市場差距與極高EV只作WARNING；資料、合約、分布、鏡像或結算等實質錯誤才會BLOCK。按下「紀錄實際下注」會由伺服器再次核對Reader與PIT證據，再永久保存當下盤口、水位與金額。</p></div>
        <div className="heroControls"><label>台灣日期<input type="date" value={date} disabled={busy} onChange={event => setDate(event.target.value)}/></label><button className="primary giant" disabled={busy || !analysisEnabled} onClick={() => oneClickAnalyze()}>{busy ? '執行中…' : analysisEnabled ? `同步今日 ${activeLeague.id}` : `${activeLeague.id} 尚未啟用`}</button><a className="secondary readerDownload" href={READER_DOWNLOAD_PATH} download>下載目前穩定版 Reader v2.1.19</a></div>
        <div className={`providerState ${analysisEnabled && readerExecutable ? 'ready' : 'missing'}`}>
          <strong>{!analysisEnabled ? `${activeLeague.label}獨立模型核心尚未發布` : readerExecutable ? 'Tai888 Reader自動同步正常｜目前畫面已驗證' : readerStatus?.fresh ? 'Tai888 Reader新盤已同步｜等待分析驗證' : readerStatus?.stale ? 'Tai888 Reader盤口已過期' : 'Tai888 Reader等待同步'}</strong>
          <span>{!analysisEnabled ? '官方賽程、Reader與實際下注帳本保留；核心先發、打線、純牛棚與球場資料未完整前不建立假分布或假EV。' : readerStatus?.fresh ? `最後同步：${localTime(readerStatus?.receivedAt)}｜Reader已讀取${readerCoverage.captured}/${readerCoverage.total}場｜已開盤${readerCoverage.open}場｜${readerPendingText}｜每5分鐘複核｜S分數、W與R完整顯示` : readerStatus?.message || `保持唯一一台讀盤電腦、Chrome與Tai888 ${activeLeague.shortLabel}頁面開啟。`}</span>
        </div>
      </section>
      {!analysisEnabled && <LeagueSetupPanel config={activeLeague}/>}
      {analysisEnabled && shadowMode && <LeagueShadowPanel config={activeLeague}/>}
      {analysisEnabled && !board.length && <section className="emptyBoard"><div>⚾</div><h2>尚未建立今日盤口</h2><p>按上方按鈕後，Reader已同步的Tai888信用盤會一次列出。</p></section>}
      {analysisEnabled && board.map(item => <GameCard key={`${league}-${item.game.gamePk}`} item={item} onBet={recordBet} getBetState={getBetState} readerExecutable={itemReaderExecutable(item)} now={clockNow} betsEnabled={bettingEnabled} shadowMode={shadowMode} cloudLedgerUnavailable={cloudLedgerStatus.state === 'unavailable'}/>) }
    </>}

    {tab === 'ranking' && <section className="panel"><div className="panelHead"><h2>全部方向｜S分數由高到低</h2><span className="state shadow">全部顯示｜模型分析</span></div>
      <div className="emptySmall">此處顯示這一版Reader快照中已開盤且成功完成分析的全部方向，先依固定S分數由高到低排列，同分再依W、R排序；負EV、R≤0、QA BLOCK與低分方向都不刪除。市場差距與極高EV只顯示WARNING，不取消分數或排名。尚未開盤或市場資料錯誤的固定槽位保留在各場今日盤口，不能與其他時點、其他盤口快照混合比較。</div>
      <div className="emptySmall">盤日 {date}｜Reader覆蓋 {readerCoverage.captured}/{readerCoverage.total}場｜已開盤 {readerCoverage.open}場｜盤口雜湊 {readerStatus?.payloadHash ? String(readerStatus.payloadHash).slice(0, 12) : '—'}｜最晚盤口 {rankingProvenance.latestLineAsOf ? localTime(rankingProvenance.latestLineAsOf) : '—'}｜模型 {rankingProvenance.modelVersions.length ? rankingProvenance.modelVersions.join('、') : '—'}</div>
      {shadowRanking.length ? shadowRanking.map((entry, index) => {
        const betState = bettingEnabled ? getBetState(entry.item, entry.row) : { exact: null, latest: null, records: [] };
        const recordable = betRecordable(entry.item, entry.row, clockNow, bettingEnabled, entry.currentReaderPrice, cloudLedgerStatus.state !== 'unavailable');
        const action = betActionState({ latest: betState.latest, recordable, inactiveNotice: entry.inactiveNotice, cloudLedgerUnavailable: cloudLedgerStatus.state === 'unavailable' });
        const scoreText = entry.score == null ? '—' : entry.score.toFixed(1);
        const qaText = entry.qaPassed && entry.qualified ? 'PASS' : 'BLOCK';
        const warnings = diagnosticWarnings(entry.row);
        const icon = scoreIcon(entry.score, entry.qaPassed && entry.qualified);
        const status = entry.rankingEligible ? '排名資格：是' : !entry.qualified ? '排名資格：否｜模型QA未通過' : !entry.qaPassed ? '排名資格：否｜資料QA未通過' : `排名資格：否｜${entry.row?.rankingQualificationReason || '未達排名條件'}`;
        return <div className={`rankRow ${betState.latest ? 'betRecorded' : ''}`} key={`${entry.gamePk}-${entry.market}-${entry.pick}`}><b>{index + 1}</b><strong className={`rankScore ${entry.score != null && entry.score >= 8.5 ? 'strongest' : ''}`} title="固定S分數">{icon} {scoreText}</strong><div><span>{entry.matchup}｜{entry.market}｜{translateTeamText(entry.pick)}｜{waterText(entry.water)}</span><small>模型EV W {signedPct(entry.weightedEV)}｜穩健EV R {signedPct(entry.robustEV)}｜資料／數學 QA：{qaText}｜{status}</small>{warnings.map(warning => <small className="warningText" key={warning}>⚠️ {warning}</small>)}{entry.inactiveNotice && <small>實際下注紀錄狀態：{entry.inactiveNotice}</small>}</div><div className="rankActionStack"><button className={`mini ${betState.latest ? 'recorded' : recordable ? 'green' : 'unavailable'}`} disabled={action.disabled} title={action.title} onClick={() => recordBet(entry.item, entry.row)}>{action.text}</button>{betState.latest && <BetPriceComparison bet={betState.latest} currentRow={entry.row} game={entry.item.game}/>}</div></div>;
      }) : <div className="emptySmall">目前沒有已完成分析的Reader實際盤方向。</div>}
    </section>}

    {tab === 'betOrder' && <section className="panel"><div className="panelHead"><h2>影子候選順序｜7.0分以上</h2><span className="state shadow">依開賽時間｜非推薦</span></div>
      <div className="emptySmall">先按比賽開始時間由早到晚，再於同場依序排列全場讓分、全場大小、上半讓分、上半大小；同一市場有多個7.0分以上方向時，分數較高者排前。已下注項目保留標記，時間未定賽事排在最後。</div>
      {shadowBetOrderGames.length ? shadowBetOrderGames.map((group, gameIndex) => <div className="betOrderGame" key={group.key}>
        <div className="betOrderGameHead"><div><span>第 {gameIndex + 1} 場</span><strong>{group.matchup}</strong></div><time>{localTime(group.gameDate)}</time></div>
        {group.entries.map(entry => {
          const betState = bettingEnabled ? getBetState(entry.item, entry.row) : { exact: null, latest: null, records: [] };
          const recordable = betRecordable(entry.item, entry.row, clockNow, bettingEnabled, entry.currentReaderPrice, cloudLedgerStatus.state !== 'unavailable');
          const action = betActionState({ latest: betState.latest, recordable, inactiveNotice: entry.inactiveNotice, cloudLedgerUnavailable: cloudLedgerStatus.state === 'unavailable' });
          const scoreText = entry.score.toFixed(1);
          const qaText = entry.qaPassed && entry.qualified ? 'PASS' : 'BLOCK';
          const warnings = diagnosticWarnings(entry.row);
          const icon = scoreIcon(entry.score, entry.qaPassed && entry.qualified);
          const status = entry.rankingEligible ? '排名資格：是' : !entry.qualified ? '排名資格：否｜模型QA未通過' : !entry.qaPassed ? '排名資格：否｜資料QA未通過' : `排名資格：否｜${entry.row?.rankingQualificationReason || '未達排名條件'}`;
          return <div className={`rankRow betOrderRow ${betState.latest ? 'betRecorded' : ''}`} key={`${entry.gamePk}-${entry.market}-${entry.pick}`}><b>{entry.betOrderIndex}</b><strong className={`rankScore ${entry.score >= 8.5 ? 'strongest' : ''}`} title="固定S分數">{icon} {scoreText}</strong><div><span>{entry.market}｜{translateTeamText(entry.pick)}｜{waterText(entry.water)}</span><small>模型EV W {signedPct(entry.weightedEV)}｜穩健EV R {signedPct(entry.robustEV)}｜資料／數學 QA：{qaText}｜{status}</small>{warnings.map(warning => <small className="warningText" key={warning}>⚠️ {warning}</small>)}{entry.inactiveNotice && <small>實際下注紀錄狀態：{entry.inactiveNotice}</small>}</div><button className={`mini ${betState.latest ? 'recorded' : recordable ? 'green' : 'unavailable'}`} disabled={action.disabled} title={action.title} onClick={() => recordBet(entry.item, entry.row)}>{action.text}</button></div>;
        })}
      </div>) : <div className="emptySmall">目前沒有公式分數達 {BET_ORDER_MIN_SCORE.toFixed(1)} 的Reader實際盤方向。</div>}
    </section>}

    {tab === 'bets' && <BetLedgerDashboard bets={bets} cloudLedgerStatus={cloudLedgerStatus} reportCloudLedgerFailure={reportCloudLedgerFailure} period={betPeriod} setPeriod={setBetPeriod} selectedLeague={betLeague} setSelectedLeague={setBetLeague} selectedMarket={betMarket} setSelectedMarket={setBetMarket} refreshSettlements={refreshSettlements}/>}

    {tab === 'settings' && <section className="panel"><div className="panelHead"><h2>{activeLeague.label}｜設定</h2><span className={`state ${activeLeague.status}`}>{activeLeague.statusLabel}</span></div><div className="settingsGrid"><label>每筆實際下注金額<input type="number" value={settings.unitValue} min="100" step="100" onChange={event => setSettings(value => ({ ...value, unitValue: Number(event.target.value) || 10000 }))}/></label></div><div className="settingsNote"><b>模型：{activeLeague.modelFamily}</b><br/>每場正反方向、讓分大小、全場與上半場共用一份PIT凍結聯合比分分布；Tai888只提供待評估的成交盤口與水位，不改寫模型概率。前台固定以S分數為主，W與R為次要資訊；Tai888差距、外部市場方向與極高EV只作WARNING，不影響S或排名。只有資料、合約、比分分布、正反鏡像與逐腿結算等實質QA錯誤才會BLOCK。此金額只供實際下注帳本紀錄；帳本仍依台灣信用盤逐腿結算與每萬退150規則計算。</div></section>}

  </main>;
}
