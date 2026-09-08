'use client';
import { runExplanationDisplay, externalVerificationExplanation, sourceStatusLabel, bullpenEvidenceDisplay } from '../lib/mlb-diagnostic-display-v1.js';

import { analysisDisplayGame, analysisGameIdentity, sameAnalysisGame } from '../lib/analysis-game-identity-v1.js';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { QUALITY_GROUPS, qualityGroupForBet, savedVersionForBet } from '../lib/performance-evidence-v1.js';
import { APP_VERSION } from '../lib/app-version.js';
import { analysisStarterDisplay } from '../lib/analysis-starter-display.js';
import { analysisSourceStatusDisplay } from '../lib/npb-identity-display.js';
import { currentWrWarnings, wrGapExceedsReference } from '../lib/wr-gap-warning.js';
import NbaEntry from './nba/entry.js';
import Link from 'next/link';
import { MARKET_ORDER, breakEvenProbability, hasActualWater } from '../lib/markets.js';
import {
  betIdentity,
  betMatches,
  betPositionIdentity,
  betPriceMatches,
} from '../lib/bet-ledger.js';
import { compareBetPrice } from '../lib/bet-price-comparison.js';
import { priceComparisonLabel, verifiedClosingPriceForBet } from '../lib/bet-price-feed.js';
import { summarizeOriginalBetPrices } from '../lib/bet-price-summary.js';
import { BET_PERIODS, filterBetLedgerByPeriod, hasUnverifiedFirst5Settlement, summarizeBetLedger } from '../lib/bet-stats.js';
import {
  SCORE_BUCKETS,
  SCORE_PERFORMANCE_MARKETS,
  buildScorePerformanceReport,
  filterScorePerformanceDetails,
  scorePerformanceScoreForBet,
  scorePerformanceSampleLabel,
} from '../lib/score-performance.js';
import { teamNameZh, translateTeamText } from '../lib/i18n.js';
import { LEAGUE_IDS, leagueConfig, normalizeLeagueId } from '../lib/leagues.js';
import {
  advanceUnchangedReaderGame,
  bindVerifiedReaderContractsForItem,
  coreSnapshotReusable,
  finalizeReaderBoardAtStart,
  gameIsPrestartNow,
  liveReaderHashMatches,
  mergeReaderStatusHighWater,
  readerCaptureForBet,
  readerCoverageCounts,
  readerHashKey,
  readerAnalysisNeedsRevalidation,
  readerTaskGameRevisionIsStale,
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
  ANALYSIS_COMPLETED_RECEIPT_STORAGE_KEY,
  analysisItemMatchesScope,
  completedReceiptGameMatches,
  createCompletedAnalysisReceipt,
  findMissingCompletedAnalysisReceipt,
  upsertCompletedAnalysisReceipt,
} from '../lib/analysis-completed-receipt-v1.js';
import { isHistoricalIdentityConflict, reconcileOfficialBoardIdentity } from '../lib/official-board-identity-v1195.js';
import {
  analysisDisplayRowsForCard,
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
import {
  allLeagueBoardDate,
  allLeagueAnalysisProgress,
  allLeagueRunContainsDate,
  allLeagueStatusLabel,
  createAllLeagueAnalysisRun,
  mergePreparedLeagueBoard,
  preserveCompletedReaderResult,
  summarizeAllLeagueBatchResult,
  updateAllLeagueAnalysisLeague,
} from '../lib/all-league-analysis-v117.js';
import { capturedReaderContractReady, evaluateBetAction } from '../lib/bet-action-state-v118.js';

const VERSION = APP_VERSION;
const READER_DOWNLOAD_PATH = '/downloads/Tai888-Reader-v2.1.19-VERIFIED-RESCAN.zip';
const STORAGE = 'sports-positive-ev-v10-0-0';
const BET_BACKUP_STORAGE = 'sports-positive-ev-bets-backup-v2';
const BET_CLOUD_MIGRATION_STORAGE = 'sports-positive-ev-bets-cloud-migrated-v1';
const ANALYSIS_BOARD_CACHE_STORAGE = 'sports-positive-ev-analysis-board-v1';
const ANALYSIS_JOB_STORAGE = 'sports-positive-ev-background-jobs-v1';
// A failed durable write must not strand a workflow while this tab stays open.
const backgroundJobsInMemory = new Map();
const supersededBackgroundRuns = new Set();
const ALL_LEAGUE_ANALYSIS_STORAGE = 'sports-positive-ev-all-league-analysis-v1';
const APP_OPERATION_BUSY_KEY = 'sports-positive-ev-operation-busy';
let authRedirectStarted = false;
let appOperationBusyDepth = 0;
// A cold Production analysis can legitimately spend close to a minute fetching
// point-in-time data and building the deterministic distribution. iOS Safari
// reports an AbortController timeout as the unhelpful `Load failed`, so keep the
// browser timeout above the 90 second server route ceiling.
const ANALYSIS_REQUEST_TIMEOUT_MS = 120_000;
// Starting a durable workflow can consume the full 60 second route allowance on
// a cold deployment. Keep the browser alive beyond that ceiling so iOS Safari
// does not report a successfully accepted job as an all-league submission
// failure while the server continues running it.
const BACKGROUND_JOB_START_TIMEOUT_MS = 75_000;
const BACKGROUND_JOB_RECOVERY_TIMEOUT_MS = 45_000;
const ANALYSIS_TRANSIENT_RETRY_DELAYS_MS = [0, 2500, 6000];
const READER_RECHECK_INTERVAL_MS = 30 * 1000;
const REFERENCE_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
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

function markAppOperationBusy(active) {
  try {
    appOperationBusyDepth = Math.max(0, appOperationBusyDepth + (active ? 1 : -1));
    if (appOperationBusyDepth > 0) window.sessionStorage.setItem(APP_OPERATION_BUSY_KEY, String(Date.now()));
    else window.sessionStorage.removeItem(APP_OPERATION_BUSY_KEY);
  } catch {}
}

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
  // QA and ranking gates must not erase an already calculated formula value.
  // `rawScore` remains display-only when diagnostic release is blocked; the
  // independent ranking and execution checks below stay fail-closed.
  return firstFiniteNumber(
    row?.formulaDiagnosticScore,
    row?.shadowDiagnosticScore,
    row?.scoreBreakdown?.rawScore,
  );
}

function compactModelMetrics(row) {
  const score = formulaScoreValue(row);
  const weightedEV = modelEvValue(row);
  const robustEV = robustEvValue(row);
  return `S ${score == null ? '—' : score.toFixed(1)}｜W ${signedPct(weightedEV)}｜R ${signedPct(robustEV)}`;
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
  if (canonical.length) return currentWrWarnings([...new Set(canonical)], row?.evCalibration?.rawScenarioSpread);
  const gap = firstFiniteNumber(row?.tai888MarketProbabilityGap, row?.rawMarketProbabilityGap);
  const warnings = [
    ...(gap != null && gap > 0.10 ? [`模型／Tai888去水機率高度分歧 ${(gap * 100).toFixed(2)}pp`] : []),
    ...(row?.extremeEvReviewRequired === true || Number(modelEvValue(row)) >= 0.20 ? ['極高模型EV，建議複核'] : []),
    ...(row?.scoreAudit?.diagnosticWarnings || []),
    ...(row?.scoreAudit?.plausibility?.auditWarnings || []),
    ...(row?.scoreAudit?.extremeEvReview?.auditWarnings || []),
    ...(row?.evCalibration?.auditWarnings || []),
  ];
  return currentWrWarnings([...new Set(warnings.filter(Boolean))], row?.evCalibration?.rawScenarioSpread);
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
    return restoreAnalysisBoardCache(entry, { league, date })
      .filter(item => analysisItemMatchesScope(item, { league, date }));
  } catch {
    return [];
  }
}

function saveAnalysisBoardCache(league, date, board) {
  const scopedBoard = (Array.isArray(board) ? board : [])
    .filter(item => analysisItemMatchesScope(item, { league, date }));
  const entry = createAnalysisBoardCacheEntry({ league, date, board: scopedBoard });
  if (!entry) return false;
  try {
    const current = safeParse(window.localStorage.getItem(ANALYSIS_BOARD_CACHE_STORAGE) || 'null');
    window.localStorage.setItem(ANALYSIS_BOARD_CACHE_STORAGE, JSON.stringify(upsertAnalysisBoardCache(current, entry)));
    return true;
  } catch {
    // setItem is atomic. Keep the previous league snapshots when quota is
    // exhausted; a compact completed-job receipt can recover missing results.
    return false;
  }
}

function saveCompletedAnalysisReceipt(job, result) {
  const receipt = createCompletedAnalysisReceipt(job, result);
  if (!receipt) return { stored: false, completed: 0, retainJob: false };
  try {
    const saved = safeParse(window.localStorage.getItem(ANALYSIS_COMPLETED_RECEIPT_STORAGE_KEY) || 'null');
    window.localStorage.setItem(ANALYSIS_COMPLETED_RECEIPT_STORAGE_KEY, JSON.stringify(upsertCompletedAnalysisReceipt(saved, receipt)));
    return { stored: true, completed: receipt.total, retainJob: false };
  } catch {
    // Replacing a pending job's lightweight slate with a smaller completed
    // receipt can still succeed when a separate storage key has no room.
    const stored = saveBackgroundJob(receipt);
    return { stored, completed: receipt.total, retainJob: stored };
  }
}

function clearCompletedAnalysisReceipt(league, date, runId) {
  try {
    const saved = safeParse(window.localStorage.getItem(ANALYSIS_COMPLETED_RECEIPT_STORAGE_KEY) || 'null');
    const rows = Array.isArray(saved) ? saved : saved && typeof saved === 'object' ? Object.values(saved) : [];
    const retained = rows.filter(row => !(row?.league === league && row?.date === date && row?.runId === runId));
    window.localStorage.setItem(ANALYSIS_COMPLETED_RECEIPT_STORAGE_KEY, JSON.stringify(retained));
  } catch { /* The current page also suppresses this failed recovery run. */ }
}

function markBackgroundResultUnavailable(league, date, runId) {
  try {
    const run = safeParse(window.localStorage.getItem(ALL_LEAGUE_ANALYSIS_STORAGE) || 'null');
    const id = normalizeLeagueId(league);
    if (run?.runId !== runId || allLeagueBoardDate(run, id) !== date || !run?.leagues?.[id]) return;
    window.localStorage.setItem(ALL_LEAGUE_ANALYSIS_STORAGE, JSON.stringify({ ...run,
      leagues: { ...run.leagues, [id]: { ...run.leagues[id], resultUnavailable: true } },
    }));
  } catch { /* The current page also suppresses this failed scoped run. */ }
}

function backgroundJobKey(league, date) {
  return `${String(league || '').toUpperCase()}|||${String(date || '')}`;
}

function loadBackgroundJob(league, date, visibleBoard = []) {
  const memoryJob = backgroundJobsInMemory.get(backgroundJobKey(league, date)) || null;
  try {
    const jobs = safeParse(window.localStorage.getItem(ANALYSIS_JOB_STORAGE) || 'null');
    const storedCandidate = jobs?.[backgroundJobKey(league, date)] || null;
    const storedJob = storedCandidate?.completedReceipt !== true
      && supersededBackgroundRuns.has(`${backgroundJobKey(league, date)}|||${storedCandidate?.runId}`)
      ? null : storedCandidate;
    const storedAt = value => Date.parse(value?.startedAt || value?.completedAt || '');
    const job = storedJob && memoryJob && storedAt(storedJob) > storedAt(memoryJob)
      ? storedJob : memoryJob || storedJob;
    const run = safeParse(window.localStorage.getItem(ALL_LEAGUE_ANALYSIS_STORAGE) || 'null');
    const id = normalizeLeagueId(league);
    const cachedBoard = loadAnalysisBoardCache(id, date);
    const scopedVisibleBoard = (Array.isArray(visibleBoard) ? visibleBoard : [])
      .filter(item => analysisItemMatchesScope(item, { league: id, date }));
    const receipts = safeParse(window.localStorage.getItem(ANALYSIS_COMPLETED_RECEIPT_STORAGE_KEY) || 'null');
    const recoveryStore = job?.completedReceipt === true ? upsertCompletedAnalysisReceipt(receipts, job) : receipts;
    const recovery = findMissingCompletedAnalysisReceipt(recoveryStore, {
      league: id, date, board: [...cachedBoard, ...scopedVisibleBoard],
    });
    const batch = run?.leagues?.[id] || null;
    const terminalRunMatches = run?.state === 'completed'
      && Boolean(run?.runId)
      && allLeagueBoardDate(run, id) === String(date || '');
    if (recovery) {
      const newerPendingJob = job?.completedReceipt !== true && job?.runId
        && !(terminalRunMatches && job.runId === run.runId)
        && Date.parse(job.startedAt || '') > Date.parse(recovery.completedAt);
      // A completed receipt has exact per-game version evidence. Do not turn
      // it into an older, unversioned all-league reconnect record.
      return newerPendingJob ? job : recovery;
    }
    // Older clients could mark a terminal batch as consumed even when its
    // Reader re-attestation discarded every row before anything reached the
    // board.  Do not trust that stale flag unless a calculated board really
    // survived in the durable browser cache for this league/date.
    const cachedResultLoaded = batch?.resultLoaded === true
      && [...cachedBoard, ...scopedVisibleBoard]
        .some(item => analysisHasCalculatedDirections(item?.customData))
      && !recovery;
    if (terminalRunMatches && batch?.resultUnavailable !== true && batch?.resultSuperseded !== true
      && !supersededBackgroundRuns.has(`${backgroundJobKey(id, date)}|||${run.runId}`)
      && !cachedResultLoaded && Number(batch?.total) > 0) {
      const completedAt = Date.parse(run.completedAt || '');
      const jobStartedAt = Date.parse(job?.startedAt || '');
      const differentNewerJob = job?.runId !== run.runId
        && Number.isFinite(completedAt)
        && Number.isFinite(jobStartedAt)
        && jobStartedAt > completedAt;
      if (!differentNewerJob && job?.runId !== run.runId) {
        const recovered = {
          runId: run.runId,
          batchMode: 'all-leagues',
          league: id,
          date: String(date || ''),
          total: Number(batch.total) || 0,
          gamePks: [],
          startedAt: run.startedAt || run.completedAt || new Date().toISOString(),
        };
        saveBackgroundJob(recovered);
        return recovered;
      }
    }
    if (terminalRunMatches && cachedResultLoaded
      && job?.batchMode === 'all-leagues' && job.runId === run.runId) {
      clearBackgroundJob(id, date, run.runId);
      return recovery;
    }
    if (terminalRunMatches && (batch?.resultUnavailable === true || batch?.resultSuperseded === true)
      && job?.runId === run.runId) return null;
    return (job?.completedReceipt === true ? null : job) || recovery;
  } catch {
    return memoryJob?.completedReceipt === true
      ? findMissingCompletedAnalysisReceipt([memoryJob], { league, date, board: visibleBoard })
      : memoryJob;
  }
}

function saveBackgroundJob(job) {
  try {
    const key = backgroundJobKey(job.league, job.date);
    const storedAt = value => Date.parse(value?.startedAt || value?.completedAt || '');
    let stored = null;
    try { stored = safeParse(window.localStorage.getItem(ANALYSIS_JOB_STORAGE) || 'null'); } catch {}
    const source = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
    for (const [entryKey, value] of backgroundJobsInMemory) {
      if (!source[entryKey] || !Number.isFinite(storedAt(source[entryKey]))
        || !Number.isFinite(storedAt(value)) || storedAt(value) >= storedAt(source[entryKey])) source[entryKey] = value;
    }
    const previous = source[key] || null;
    if (job.completedReceipt !== true && job.runId) {
      for (const prior of [stored?.[key], backgroundJobsInMemory.get(key)]) {
        if (prior?.runId && prior.runId !== job.runId && prior.completedReceipt !== true
          && (!Number.isFinite(storedAt(prior)) || !Number.isFinite(storedAt(job)) || storedAt(job) >= storedAt(prior))) {
          supersededBackgroundRuns.add(`${key}|||${prior.runId}`);
        }
      }
    }
    const lightweight = value => {
      if (!Array.isArray(value?.preparedBoard) || value.completedReceipt === true) return value;
      return { ...value, preparedBoard: value.preparedBoard.flatMap(item => !item?.game ? [] : [{
        // Official normalized game identity and display values remain exact.
        // Source evidence and market arrays are fetched again by the Reader;
        // they are neither workflow handles nor completed analysis results.
        game: item.game, mode: item.mode || 'actual', readerPayloadHash: null,
        customMarkets: [],
        status: item.status || 'queued', statusLabel: item.statusLabel || '等待伺服器背景分析', error: item.error || '',
      }]) };
    };
    const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const compact = Object.fromEntries(Object.entries({ ...source, [key]: job })
      .filter(([entryKey, value]) => entryKey === key
        || ((value?.completedReceipt === true || !supersededBackgroundRuns.has(`${entryKey}|||${value?.runId}`))
          && (!Number.isFinite(storedAt(value)) || storedAt(value) >= cutoff)))
      .sort((left, right) => Number(right[0] === key) - Number(left[0] === key)
        || (storedAt(right[1]) || 0) - (storedAt(left[1]) || 0))
      .slice(0, 12).map(([entryKey, value]) => [entryKey, lightweight(value)]));
    const persist = value => {
      try {
        const serialized = JSON.stringify(value);
        window.localStorage.setItem(ANALYSIS_JOB_STORAGE, serialized);
        return window.localStorage.getItem(ANALYSIS_JOB_STORAGE) === serialized;
      } catch { return false; }
    };
    let durable = persist(compact);
    if (!durable) {
      // Quota recovery removes only reconstructible loading cards, retaining
      // every retained run handle, game ID, result field and receipt fingerprint.
      const handles = Object.fromEntries(Object.entries(compact).map(([entryKey, value]) => {
        if (!Array.isArray(value?.preparedBoard) || value.completedReceipt === true) return [entryKey, value];
        const { preparedBoard, ...handle } = value;
        return [entryKey, handle];
      }));
      durable = persist(handles);
    }
    backgroundJobsInMemory.clear();
    for (const [entryKey, value] of Object.entries(compact)) backgroundJobsInMemory.set(entryKey, value);
    // A failed receipt write must leave the original pending reconnect handle
    // available; an in-memory receipt never establishes durable consumption.
    if (!durable && job.completedReceipt === true && previous) backgroundJobsInMemory.set(key, previous);
    return durable;
  } catch { return false; }
}

function clearBackgroundJob(league, date, runId = '') {
  const memoryKey = backgroundJobKey(league, date);
  const memoryRunMatches = backgroundJobsInMemory.get(memoryKey)?.runId === runId;
  if (!runId || memoryRunMatches) backgroundJobsInMemory.delete(memoryKey);
  if (memoryRunMatches) {
    try {
      const run = safeParse(window.localStorage.getItem(ALL_LEAGUE_ANALYSIS_STORAGE) || 'null');
      const id = normalizeLeagueId(league);
      if (run?.runId && run.runId !== runId && run?.leagues?.[id]
        && allLeagueBoardDate(run, id) === date && supersededBackgroundRuns.has(`${memoryKey}|||${run.runId}`)) {
        // Preserve other league summaries and all completed receipts. Only the
        // superseded legacy pending reconnect must stop surviving a remount.
        window.localStorage.setItem(ALL_LEAGUE_ANALYSIS_STORAGE, JSON.stringify({ ...run,
          leagues: { ...run.leagues, [id]: { ...run.leagues[id], resultSuperseded: true } },
        }));
      }
    } catch {}
  }
  try {
    const jobs = safeParse(window.localStorage.getItem(ANALYSIS_JOB_STORAGE) || 'null');
    if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return;
    const key = backgroundJobKey(league, date);
    if (runId && jobs[key]?.runId !== runId
      && !(memoryRunMatches && jobs[key]?.completedReceipt !== true
        && supersededBackgroundRuns.has(`${key}|||${jobs[key]?.runId}`))) return;
    const { [key]: omitted, ...remaining } = jobs;
    window.localStorage.setItem(ANALYSIS_JOB_STORAGE, JSON.stringify(remaining));
  } catch {}
}

function clearAllLeagueBackgroundJobs(run) {
  if (!run?.runId || !run?.date) return;
  for (const id of LEAGUE_IDS) clearBackgroundJob(id, allLeagueBoardDate(run, id, run.date), run.runId);
}

function loadAllLeagueAnalysisRun(date) {
  try {
    const run = safeParse(window.localStorage.getItem(ALL_LEAGUE_ANALYSIS_STORAGE) || 'null');
    return allLeagueRunContainsDate(run, date) ? run : null;
  } catch { return null; }
}

function saveAllLeagueAnalysisRun(run) {
  try {
    if (!run?.date) return false;
    window.localStorage.setItem(ALL_LEAGUE_ANALYSIS_STORAGE, JSON.stringify(run));
    return true;
  } catch { return false; }
}

function clearAllLeagueAnalysisRun(run = null) {
  try {
    const saved = safeParse(window.localStorage.getItem(ALL_LEAGUE_ANALYSIS_STORAGE) || 'null');
    if (run?.startedAt && saved?.startedAt && saved.startedAt !== run.startedAt) return false;
    window.localStorage.removeItem(ALL_LEAGUE_ANALYSIS_STORAGE);
    return true;
  } catch { return false; }
}

function isInterruptedPreSubmitRun(run) {
  if (!run || run.runId) return false;
  if (run.state === 'preparing') return true;
  return run.state === 'completed' && LEAGUE_IDS.some(id => (
    String(run.leagues?.[id]?.message || '').includes('送出伺服器背景工作前中斷')
  ));
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
    if (['SERVER_VERIFIED_CURRENT_READER', 'SERVER_VERIFIED_CAPTURED_READER'].includes(bet.readerEvidenceStatus)
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
    if (response.status === 401 && !authRedirectStarted && typeof window !== 'undefined'
      && window.location.pathname !== '/login') {
      authRedirectStarted = true;
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
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
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('請求逾時，請稍後重試');
      timeoutError.code = 'REQUEST_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJSONWithTransientRetry(url, options = {}, timeoutMs = 180000, {
  allowApplicationFailure = false,
  delaysMs = [0, 1500, 4000],
} = {}) {
  let failure;
  for (const delay of delaysMs) {
    if (delay) await new Promise(resolve => window.setTimeout(resolve, delay));
    try {
      return await requestJSON(url, options, timeoutMs, { allowApplicationFailure });
    } catch (error) {
      failure = error;
      if (!transientAnalysisError(error)) throw error;
    }
  }
  const error = new Error('網路暫時中斷；已自動重試仍無法載入，請按重新分析全部聯盟');
  error.code = 'TRANSIENT_BROWSER_LOAD_FAILED';
  error.cause = failure;
  throw error;
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

function cloudLedgerFailureState(error, retryAt = 0) {
  return {
    state: 'unavailable',
    code: String(error?.code || 'DATABASE_UNAVAILABLE'),
    message: String(error?.message || '永久資料庫目前無法使用'),
    retryAt: Number(retryAt) || 0,
  };
}

function transientAnalysisError(error) {
  if (String(error?.code || '') === 'PIT_PERSISTENCE_REQUIRED') return false;
  if (String(error?.code || '') === 'REQUEST_TIMEOUT') return true;
  if (Number.isFinite(Number(error?.status))) return Number(error.status) >= 500;
  return /Load failed|Failed to fetch|NetworkError|network request failed|請求逾時|分析逾時/i.test(String(error?.message || error));
}

async function startBackgroundAnalysisJob(payload) {
  const requestId = uid();
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
    body: JSON.stringify(payload),
  };
  let job = await requestJSONWithTransientRetry('/api/analysis-jobs', options, BACKGROUND_JOB_START_TIMEOUT_MS, {
    delaysMs: ANALYSIS_TRANSIENT_RETRY_DELAYS_MS,
  });
  if (job?.runId) return job;
  const deadline = Date.now() + BACKGROUND_JOB_RECOVERY_TIMEOUT_MS;
  while (job?.requestId && Date.now() < deadline) {
    await new Promise(resolve => window.setTimeout(resolve, 1500));
    job = await requestJSON(`/api/analysis-jobs?requestId=${encodeURIComponent(job.requestId)}&t=${Date.now()}`, {}, 15000);
    if (job?.runId) return job;
  }
  const error = new Error('背景工作已送出，但暫時無法取得工作編號；請再按一次即可接回原工作');
  error.code = 'BACKGROUND_JOB_RECOVERY_PENDING';
  throw error;
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
  const canonical = Array.isArray(row?.qa?.reasons)
    ? row.qa.reasons.map(String).filter(Boolean)
    : [];
  const fallback = canonical.length ? [] : [
    ...(row?.scoreAudit?.baseQa?.failures || []),
    ...(row?.scoreAudit?.thirdAudit?.failures || []),
  ];
  return [...new Set([
    ...canonical,
    ...fallback,
    ...(row?.scoreAudit?.boundary?.errors || []),
    ...(row?.scoreAudit?.plausibility?.failures || []),
    ...(row?.pairAudit?.failures || []),
  ].map(String).filter(reason => reason && reason !== 'baseQa'))];
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
  const asian = ['NPB', 'KBO', 'CPBL'].includes(context?.leagueId || context?.game?.leagueId);
  const fallback = asian ? null : context?.fetchedAt;
  const rows = {};
  for (const item of context?.featureProvenance || []) {
    const name = String(item?.featureName || item?.feature || '').trim();
    const value = asian ? item?.fetchedAt : item?.observedAt || item?.asOf || fallback;
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
    {closing && <div className="priceComparisonModels">
      <span>下注時分數：{compactModelMetrics(bet)}</span>
      <span>最後盤分數：{compactModelMetrics(reference)}</span>
    </div>}
    <small>{detail}</small>
    {closing && <small>最後盤時間：{localTime(reference?.lineAsOf)}｜開賽後鎖定，不再覆蓋</small>}
    {comparison?.keyDifference?.text && <b>關鍵洞口差：{comparison.keyDifference.text}</b>}
    {closing && <em>優／劣依開賽前最後盤逐比分 payoff 比較；洞口的 u 差不是 CLV 百分比。</em>}
  </div>;
}

function BetPriceComparison({ bet, currentRow = null, game = null, closingRow = null, readerChecked = false, showExactLabel = false }) {
  if (!bet) return null;
  const gameStarted = Number.isFinite(Date.parse(bet?.gameDate || '')) && Date.now() >= Date.parse(bet.gameDate);
  const currentComparison = currentRow ? compareBetPrice({ bet, row: currentRow, game: game || bet, rebateRate: 0.015 }) : null;
  const verifiedClosing = closingRow || verifiedClosingPriceForBet(bet);
  const closingComparison = verifiedClosing
    ? compareBetPrice({ bet, row: verifiedClosing, game: game || bet, rebateRate: 0.015 })
    : null;
  const showCurrent = !gameStarted && currentComparison && currentComparison.exact !== true;
  return <div className="priceComparisonStack">
    {!gameStarted && showExactLabel && currentComparison?.exact === true && <div className="priceComparisonExact">已下注 ✓</div>}
    {showCurrent && <PriceComparisonPanel title="即時 Reader 比較" referenceLabel="Reader目前盤口" bet={bet} reference={currentRow} comparison={currentComparison}/>} 
    {!gameStarted && !currentRow && readerChecked && bet.status === 'OPEN' && <div className="priceComparisonUnavailable">Reader目前盤口：等待該聯盟最新同步；不使用舊盤冒充目前盤。</div>}
    {closingComparison && <PriceComparisonPanel title="開賽前最後盤｜Closing CLV" referenceLabel="最後盤口" bet={bet} reference={verifiedClosing} comparison={closingComparison} closing/>}
  </div>;
}

function SummaryCards({ summary, originalPriceSummary }) {
  const values = [
    ['下注', summary?.bets ?? 0],
    ['已結算', summary?.settled ?? 0],
    ['待結算', summary?.open ?? 0],
    ['需確認賽果', summary?.manualReview ?? 0],
    ['舊賽果待核驗', summary?.unverifiedSettlements ?? 0],
    ['已取消', summary?.cancelled ?? 0],
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
    <div className="originalPriceSummary"><span>原下注盤優劣</span><strong>總數 {originalPriceSummary?.total ?? 0}｜<b className="positive">優 {originalPriceSummary?.better ?? 0}</b>｜<b className="negative">劣 {originalPriceSummary?.worse ?? 0}</b></strong></div>
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

function BetLedgerDashboard({ bets, cloudLedgerStatus, cloudLedgerBusy, reportCloudLedgerFailure, period, setPeriod, selectedLeague, setSelectedLeague, selectedMarket, setSelectedMarket, refreshSettlements, onCancel }) {
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
  const originalPriceSummary = useMemo(
    () => summarizeOriginalBetPrices(filteredBets, priceFeed),
    [filteredBets, priceFeed],
  );
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
    <div className="panelHead"><div><span className="kicker">四聯盟整合帳本</span><h2>實際下注紀錄與績效</h2></div><button className="textButton" disabled={cloudLedgerBusy || cloudLedgerStatus?.state !== 'ready'} onClick={() => refreshSettlements('', { force: true })}>{cloudLedgerBusy ? '帳本同步中…' : '更新全部賽果'}</button></div>
    {cloudLedgerStatus?.state === 'unavailable' && <div className="errorBox" role="alert"><strong>永久雲端帳本目前無法讀取</strong><br/>{cloudLedgerStatus.message}<br/>下方若顯示 0 注，只代表這台裝置沒有可用暫存，不代表資料庫內沒有紀錄；系統不會把失敗回應冒充空帳本。</div>}
    <div className="periodTabs" aria-label="下注期間">
      {BET_PERIODS.map(item => <button key={item.id} className={period === item.id ? 'active' : ''} onClick={() => choosePeriod(item.id)}>{item.label}</button>)}
    </div>
    <div className="ledgerPath">{periodLabel}｜{leagueLabel}｜{marketLabel}</div>
    <SummaryCards summary={summary} originalPriceSummary={originalPriceSummary}/>

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
      <div><strong><span className="leagueBadge inline">{bet.league}</span>{translateTeamText(bet.pick)}｜{waterText(bet.water)}</strong><span>{translateTeamText(bet.matchup)}｜{bet.market}｜{hasUnverifiedFirst5Settlement(bet) ? '舊賽果待核驗' : statusText(bet.status)}{bet.status === 'SETTLED' && !hasUnverifiedFirst5Settlement(bet) && bet.settlement?.outcome ? `｜${outcomeText(bet.settlement.outcome)}` : ''}</span><small>下注：{localTime(bet.placedAt)}｜{Number(bet.stake || 0).toLocaleString()}元｜下注時 {compactModelMetrics(bet)}｜{hasUnverifiedFirst5Settlement(bet) ? '原始下注保留；缺少正式上半比分，暫不納入結算績效' : String(bet.performanceEligibility || '').startsWith('EXCLUDED_') ? '不可驗證舊紀錄：不納入績效' : '實際下注績效已收錄｜S分數僅作影子分組'}</small><BetPriceComparison bet={bet} currentRow={priceFeed[bet.id]?.current || null} closingRow={priceFeed[bet.id]?.closing || null} readerChecked={priceFeedChecked} showExactLabel/></div>
      <div className="betRowResult"><strong>{hasUnverifiedFirst5Settlement(bet) ? '舊賽果待核驗' : bet.status === 'SETTLED' ? moneyText(bet.settlement?.netProfit) : bet.status === 'CANCELLED' ? '已取消' : bet.status === 'MANUAL_REVIEW' ? '需確認賽果' : '待結算'}</strong>{bet.status !== 'SETTLED' && (bet.settlementError || bet.lastResultError) && <small className="settlementPendingReason">{bet.settlementError || bet.lastResultError}</small>}{bet.status === 'OPEN' && Number.isFinite(Date.parse(bet.gameDate || '')) && Date.now() < Date.parse(bet.gameDate) && <button className="mini cancel" disabled={cloudLedgerBusy || cloudLedgerStatus?.state !== 'ready'} onClick={() => onCancel(bet)}>取消下注</button>}<small>下注證據永久保留；取消只變更狀態，不會刪除</small></div>
    </div>) : <div className="emptySmall">這個篩選範圍目前沒有下注紀錄。</div>}
  </section>;
}

function ScorePerformanceMetrics({ summary, compact = false }) {
  if (compact) return <>
    <b>{summary?.bets ?? 0} 注</b>
    <span>勝率 {pct(summary?.winRate)}</span>
    <span>ROI {pct(summary?.roi)}</span>
  </>;
  const rows = [
    ['下注數', summary?.bets ?? 0],
    ['已結算', summary?.settled ?? 0],
    ['勝', summary?.wins ?? 0],
    ['敗', summary?.losses ?? 0],
    ['走', summary?.pushes ?? 0],
    ['勝半／輸半', `${summary?.halfWins ?? 0}／${summary?.halfLosses ?? 0}`],
    ['有效勝率', pct(summary?.winRate)],
    ['總本金', moneyText(summary?.totalStake)],
    ['退水', moneyText(summary?.rebate)],
    ['淨利', moneyText(summary?.netPnl)],
    ['ROI', pct(summary?.roi)],
  ];
  return <div className="scoreBucketMetrics">{rows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>;
}

function ScorePerformanceDashboard({ bets, cloudLedgerStatus }) {
  const [period, setPeriod] = useState('ALL');
  const [selectedLeague, setSelectedLeague] = useState('ALL');
  const [selectedMarket, setSelectedMarket] = useState('ALL');
  const [selectedBucket, setSelectedBucket] = useState('ALL');
  const [modelVersion, setModelVersion] = useState('ALL');
  const [dataVersion, setDataVersion] = useState('ALL');
  const [dataQuality, setDataQuality] = useState('ALL');
  const report = useMemo(() => buildScorePerformanceReport(bets, {
    period,
    league: selectedLeague,
    market: selectedMarket,
    modelVersion, dataVersion, dataQuality,
  }), [bets, period, selectedLeague, selectedMarket, modelVersion, dataVersion, dataQuality]);
  const details = useMemo(() => filterScorePerformanceDetails(bets, {
    period,
    league: selectedLeague,
    market: selectedMarket,
    modelVersion, dataVersion, dataQuality,
    bucketId: selectedBucket,
  }), [bets, period, selectedLeague, selectedMarket, selectedBucket, modelVersion, dataVersion, dataQuality]);
  const periodLabel = BET_PERIODS.find(item => item.id === period)?.label || '全部';
  const leagueLabel = selectedLeague === 'ALL' ? '全部聯盟' : selectedLeague;
  const marketLabel = selectedMarket === 'ALL' ? '全部市場' : selectedMarket;
  const bucketLabel = selectedBucket === 'ALL'
    ? '全部分數區間'
    : selectedBucket === 'NO_SCORE'
      ? '無分數資料'
      : selectedBucket === 'OUTSIDE_RANGE'
        ? '不在指定區間'
        : SCORE_BUCKETS.find(item => item.id === selectedBucket)?.label || '全部分數區間';
  const choosePeriod = value => {
    setPeriod(value);
    setSelectedBucket('ALL');
  };
  const chooseLeague = value => {
    setSelectedLeague(value);
    setSelectedBucket('ALL');
  };
  const chooseMarket = value => {
    setSelectedMarket(value);
    setSelectedBucket('ALL');
  };
  const selectCell = (bucketId, market) => {
    setSelectedBucket(bucketId);
    setSelectedMarket(market);
  };

  return <section className="panel scorePerformancePanel">
    <div className="panelHead"><div><span className="kicker">只讀實際下注帳本</span><h2>S 分數績效</h2></div><span className="state shadow">觀察介面｜不回寫模型</span></div>
    <div className="scorePerformanceNotice">只使用每筆實際下注當下永久保存的 S 分數。未保存有效分數的舊資料不補值；本頁不會觸發結算、修改帳本或改變 S、W、R、EV、Robust EV。</div>
    {cloudLedgerStatus?.state === 'unavailable' && <div className="errorBox" role="alert"><strong>永久雲端帳本目前無法讀取</strong><br/>{cloudLedgerStatus.message}<br/>目前畫面不會把讀取失敗冒充成 0 注。</div>}

    <div className="periodTabs" aria-label="分數績效期間">
      {BET_PERIODS.map(item => <button key={item.id} className={period === item.id ? 'active' : ''} onClick={() => choosePeriod(item.id)}>{item.label}</button>)}
    </div>
    <div className="leagueScopeTabs" aria-label="分數績效聯盟">
      <button className={selectedLeague === 'ALL' ? 'active' : ''} onClick={() => chooseLeague('ALL')}>全部</button>
      {LEAGUE_IDS.map(id => <button key={id} className={selectedLeague === id ? 'active' : ''} onClick={() => chooseLeague(id)}>{id}<small>{leagueConfig(id).shortLabel}</small></button>)}
    </div>
    <div className="scoreMarketTabs" aria-label="分數績效市場">
      <button className={selectedMarket === 'ALL' ? 'active' : ''} onClick={() => chooseMarket('ALL')}>全部市場</button>
      {SCORE_PERFORMANCE_MARKETS.map(market => <button key={market} className={selectedMarket === market ? 'active' : ''} onClick={() => chooseMarket(market)}>{market}</button>)}
    </div>
    <div className="performanceEvidenceFilters">
      <label>模型版本<select aria-label="績效模型版本" value={modelVersion} onChange={event => { setModelVersion(event.target.value); setSelectedBucket('ALL'); }}><option value="ALL">全部模型版本</option>{report.availableVersions.modelVersion.map(value => <option key={value} value={value}>{value === 'UNKNOWN' ? '未保存版本' : value}</option>)}</select></label>
      <label>資料版本<select aria-label="績效資料版本" value={dataVersion} onChange={event => { setDataVersion(event.target.value); setSelectedBucket('ALL'); }}><option value="ALL">全部資料版本</option>{report.availableVersions.dataVersion.map(value => <option key={value} value={value}>{value === 'UNKNOWN' ? '未保存版本' : value}</option>)}</select></label>
      <label>資料品質<select aria-label="績效資料品質" value={dataQuality} onChange={event => { setDataQuality(event.target.value); setSelectedBucket('ALL'); }}><option value="ALL">全部品質狀態</option>{Object.entries(QUALITY_GROUPS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    </div>
    <details className="details performanceAttribution"><summary>版本與資料品質績效比較</summary>
      <p>使用目前篩選內所有合格實際下注，包含無 S 分數紀錄。品質分類只涵蓋核心人員資料；未保存證據的舊紀錄列為未知。同場多筆下注另列比賽數，不能視為獨立樣本。分組差異不代表因果或新版已改善。</p>
      <h4>模型與資料版本</h4><div className="performanceEvidenceGrid">{report.attribution.versions.map(row => <article key={row.key}><strong>{row.modelVersion === 'UNKNOWN' ? '未保存模型版本' : row.modelVersion}</strong><small>資料：{row.dataVersion === 'UNKNOWN' ? '未保存版本' : row.dataVersion}｜{row.uniqueGames} 場比賽</small><ScorePerformanceMetrics summary={row.summary}/></article>)}</div>
      <h4>資料品質</h4><div className="performanceEvidenceGrid">{report.attribution.quality.map(row => <article key={row.key}><strong>{row.label}</strong><small>{row.uniqueGames} 場比賽</small><ScorePerformanceMetrics summary={row.summary}/></article>)}</div>
    </details>
    <div className="ledgerPath">{periodLabel}｜{leagueLabel}｜{marketLabel}｜{bucketLabel}</div>

    <div className="ledgerSectionHead"><h3>1. S 分數績效比較</h3><span>未結算只計下注數</span></div>
    <div className="scoreBucketGrid">
      {report.buckets.map(bucket => <button key={bucket.id} className={`scoreBucketCard ${selectedBucket === bucket.id ? 'active' : ''}`} onClick={() => setSelectedBucket(selectedBucket === bucket.id ? 'ALL' : bucket.id)}>
        <div className="scoreBucketHead"><strong>{bucket.label}</strong><span>已結算 {bucket.summary.settled}</span></div>
        <ScorePerformanceMetrics summary={bucket.summary}/>
        {scorePerformanceSampleLabel(bucket.summary) && <em>樣本不足｜僅提示，不調整任何數值</em>}
      </button>)}
    </div>
    <div className="scoreDataExceptions">
      <button className={selectedBucket === 'NO_SCORE' ? 'active' : ''} onClick={() => setSelectedBucket(selectedBucket === 'NO_SCORE' ? 'ALL' : 'NO_SCORE')}><strong>無分數資料</strong><span>{report.noScore.recordCount} 筆｜不猜測、不補值、不納入四區間</span></button>
      {report.outsideRange.recordCount > 0 && <button className={selectedBucket === 'OUTSIDE_RANGE' ? 'active' : ''} onClick={() => setSelectedBucket(selectedBucket === 'OUTSIDE_RANGE' ? 'ALL' : 'OUTSIDE_RANGE')}><strong>不在指定區間</strong><span>{report.outsideRange.recordCount} 筆有效分數｜不混入四區間</span></button>}
    </div>

    <div className="ledgerSectionHead"><h3>2. 四市場 × S 分數矩陣</h3><span>注數／勝率／ROI</span></div>
    <div className="scoreMatrixDesktop">
      <table><thead><tr><th>S 分數</th>{SCORE_PERFORMANCE_MARKETS.map(market => <th key={market}>{market}</th>)}<th>全部</th></tr></thead>
        <tbody>{report.matrix.map(row => <tr key={row.id}><th>{row.label}</th>{SCORE_PERFORMANCE_MARKETS.map(market => <td key={market}><button className={selectedBucket === row.id && selectedMarket === market ? 'active' : ''} onClick={() => selectCell(row.id, market)}><ScorePerformanceMetrics summary={row.markets[market]} compact/></button></td>)}<td><button className={selectedBucket === row.id && selectedMarket === 'ALL' ? 'active' : ''} onClick={() => selectCell(row.id, 'ALL')}><ScorePerformanceMetrics summary={row.total} compact/></button></td></tr>)}</tbody>
      </table>
    </div>
    <div className="scoreMatrixMobile">
      {report.matrix.map(row => <article key={row.id}><h4>{row.label}</h4><div>{[...SCORE_PERFORMANCE_MARKETS, 'ALL'].map(market => {
        const summary = market === 'ALL' ? row.total : row.markets[market];
        const label = market === 'ALL' ? '全部' : market;
        return <button key={market} className={selectedBucket === row.id && selectedMarket === market ? 'active' : ''} onClick={() => selectCell(row.id, market)}><strong>{label}</strong><ScorePerformanceMetrics summary={summary} compact/></button>;
      })}</div></article>)}
    </div>

    <div className="ledgerSectionHead"><h3>3. 符合條件的下注明細</h3><span>{details.length} 筆｜直接讀取原帳本</span></div>
    {details.length ? details.map(bet => <div className="betRow scorePerformanceBetRow" key={bet.id}>
      <div><strong><span className="leagueBadge inline">{bet.league}</span>{scorePerformanceScoreForBet(bet) != null ? `S ${scorePerformanceScoreForBet(bet).toFixed(1)}｜` : 'S —｜'}{translateTeamText(bet.pick)}｜{waterText(bet.water)}</strong><span>{translateTeamText(bet.matchup)}｜{bet.market}｜{hasUnverifiedFirst5Settlement(bet) ? '舊賽果待核驗' : statusText(bet.status)}{bet.status === 'SETTLED' && !hasUnverifiedFirst5Settlement(bet) && bet.settlement?.outcome ? `｜${outcomeText(bet.settlement.outcome)}` : ''}</span><small>下注：{localTime(bet.placedAt)}｜本金 {moneyText(bet.stake)}｜下注時 {compactModelMetrics(bet)}</small></div>
      <div className="betRowResult"><strong>{bet.status === 'SETTLED' && !hasUnverifiedFirst5Settlement(bet) ? moneyText(bet.settlement?.netProfit) : '未列入已結算績效'}</strong><small>原始帳本唯讀顯示</small><small>模型：{savedVersionForBet(bet) === 'UNKNOWN' ? '未保存版本' : savedVersionForBet(bet)}</small><small>資料：{savedVersionForBet(bet, 'dataVersion') === 'UNKNOWN' ? '未保存版本' : savedVersionForBet(bet, 'dataVersion')}｜{QUALITY_GROUPS[qualityGroupForBet(bet)]}</small></div>
    </div>) : <div className="emptySmall">目前篩選條件沒有可顯示的下注紀錄。</div>}
  </section>;
}

function diagnosticVerdict(row, formulaScore, qaPassed, leagueValidated) {
  const weightedEV = modelEvValue(row);
  const robustEV = robustEvValue(row);
  const dataQualityWarningOnly = row?.scoreBreakdown?.dataQualityWarningOnly === true;
  if (row?.evCalibration?.qualified !== true && !dataQualityWarningOnly) return { icon: '⚠️', label: '模型評分阻擋', ranking: false, reason: row?.evCalibration?.reasons?.[0] || 'Reader、核心資料或數學未通過' };
  if (formulaScore == null) return { icon: '⛔', label: '無法評分', ranking: false, reason: '缺少合法水位或雙EV' };
  if (!leagueValidated) return { icon: '⚠️', label: '聯盟模型未驗證', ranking: false, reason: '不列排名' };
  if (!qaPassed && !dataQualityWarningOnly) return { icon: '⚠️', label: '資料QA阻擋', ranking: false, reason: '不列排名' };
  if (!Number.isFinite(weightedEV) || weightedEV <= 0) return { icon: '⚪', label: 'PASS', ranking: false, reason: '模型W未大於0' };
  if (!Number.isFinite(robustEV) || robustEV <= 0) return { icon: '🟡', label: '觀察', ranking: false, reason: '模型穩健R未大於0' };
  if (formulaScore < 7.2) return { icon: '⚪', label: 'PASS', ranking: false, reason: '公式分數未達7.2' };
  if (row?.rankingQualified === false) return { icon: '🟡', label: '影子候選未進排名', ranking: false, reason: row?.rankingQualificationReason || '後端排名Gate未通過' };
  const scenarioWarning = wrGapExceedsReference(row?.evCalibration?.rawScenarioSpread) ? '；W/R差距超過5個百分點列警告' : '';
  if (formulaScore >= 8.5) return { icon: '🔥', label: '8.5級模型方向', ranking: true, reason: `雙EV為正、達8.5且既定高分條件完成${scenarioWarning}` };
  if (formulaScore >= 8.0) return { icon: '🟢', label: '8.0級模型方向', ranking: true, reason: `雙EV為正且達8.0${scenarioWarning}` };
  if (formulaScore >= 7.5) return { icon: '🟢', label: '7.5級模型方向', ranking: true, reason: `雙EV為正且達7.5${scenarioWarning}` };
  return { icon: '🟢', label: '7.2級模型方向', ranking: true, reason: `雙EV為正且達7.2${scenarioWarning}` };
}

function ResultRow({ row, game, onBet, onCancel, betState = null, action, now, inactiveNotice = '' }) {
  const actualLine = row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water);
  const breakEven = actualLine ? breakEvenProbability(row.water, 0.015) : null;
  const modelEV = modelEvValue(row);
  const robustEV = robustEvValue(row);
  const storedFormulaScore = formulaScoreValue(row);
  const qaPassed = directionQaPassed(row);
  const leagueValidated = row?.scoreStatus !== 'LEAGUE_MODEL_NOT_VALIDATED';
  const dataQualityWarningOnly = row?.scoreBreakdown?.dataQualityWarningOnly === true;
  const calibrationBlocked = row?.evCalibration?.qualified !== true && !dataQualityWarningOnly;
  const calibrationReason = row?.evCalibration?.reasons?.[0] || 'Reader、核心資料或數學未通過';
  const qaFailures = scoreQaFailures(row);
  const formulaScore = storedFormulaScore;
  const auditWarnings = diagnosticWarnings(row);
  const externalAuditFresh = row?.marketVerification?.referencePriorEligible === true
    && referenceEvidenceFreshNow(row, now);
  const externalBookCount = Number(row?.marketVerification?.referenceConsensusBookCount || 0);
  const externalAuditText = externalAuditFresh
    ? `外部市場驗證：PASS｜${externalBookCount}家獨立莊家｜5分鐘內同賽事同期間同合約`
    : `外部市場驗證：未通過｜${row?.marketVerification?.priorIneligibleReason || '目前沒有可安全配對的同合約價格'}`;
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
  const probabilityDetail = `狀態模型等效條件勝率 ${pct(row.modelProbability)}（排除等效走水）｜等效贏 ${pct(row.equivalentWinProbability)}／等效輸 ${pct(row.equivalentLossProbability)}／等效走水 ${pct(row.equivalentPushProbability)}｜結算機率：全贏 ${pct(row.fullWinProbability)}／部分贏 ${pct(row.partialWinProbability)}／純走水 ${pct(row.pushProbability)}／混合中性 ${pct(row.mixedNeutralProbability)}／部分輸 ${pct(row.partialLossProbability)}／全輸 ${pct(row.fullLossProbability)}｜損益兩平 ${pct(breakEven)}｜W/R差距 ${pct(row.evCalibration?.rawScenarioSpread)}（含資料風險扣減）${marketGapText}`;
  const exact = betState?.exact || null;
  const latest = betState?.latest || null;
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
      <div className={`qaLine ${externalAuditFresh ? '' : 'pending'}`}>{externalAuditText}｜只作驗證，不改W/R</div>
      {!externalAuditFresh && <details className="details"><summary>外部驗證原因</summary><p>{externalVerificationExplanation(row?.marketVerification, externalAuditFresh)}</p></details>}
      <div className={`qaLine ${verdict.ranking ? '' : 'pending'}`}>{verdict.icon} 排名資格：{rankText}</div>
      {inactiveNotice && <div className="scoreMeta">實際下注紀錄狀態：{inactiveNotice}</div>}
      <div className="scoreMeta">{probabilityDetail}</div>
      {auditWarnings.map(warning => <div className="warningLine" key={warning}>⚠️ {warning}</div>)}
    </div>
    <div className="rowActions">
      {actualLine && <div>
        <button className={`mini ${action.kind === 'cancel' ? 'cancel' : latest ? 'recorded' : action.recordable ? 'green' : 'unavailable'}`} disabled={action.disabled} title={action.title} onClick={() => action.kind === 'cancel' ? onCancel(latest) : onBet(row)}>{action.text}</button>
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

function AnalysisDataAudit({ audit, persistence }) {
  const snapshotLink = persistence?.snapshotId && <p>快照保存：{persistence.confirmed ? '已確認保存' : '尚未確認保存'}。<a href={`/api/pit-model-audit?snapshotId=${encodeURIComponent(persistence.snapshotId)}`} target="_blank" rel="noreferrer">查看保存快照稽核</a></p>;
  if (!audit?.rows?.length) return <div className="sourceBanner dataStatusBanner"><strong>資料查核明細尚未建立｜時點證據不足</strong><span>這份舊分析未保存逐欄取得與使用紀錄；新分析會另存新快照，不會替舊分析補造證據。</span>{snapshotLink}</div>;
  const sourceTimeAudit = audit.sourceTimeAudit || (['NPB', 'KBO', 'CPBL'].includes(audit.league || persistence?.snapshotId?.split(':')[0]) ? { status: 'PENDING', rows: [], inputCutoffAt: null } : null);
  const labels = { observed: '實際取得', projected: '預測替代', missing: '缺失', stale: '舊資料' };
  const explanations = { observed: '有取得紀錄，仍須核對下列來源與統計範圍。', projected: '包含預測名單或替代數據，不能視為今日完整實績。', missing: '必要的身分或統計證據不足；中性預設值不代表實際能力。', stale: '來源已標示過期，不能當作最新資料。' };
  const summary = audit.summary || {};
  return <details className="details dataAudit">
    <summary>核心人員資料與模型使用｜實際 {summary.observed || 0}・替代 {summary.projected || 0}・缺失 {summary.missing || 0}・舊資料 {summary.stale || 0}</summary>
    {snapshotLink}
    <p className="muted">保存確認、快照完整性、比分分布與 W/R 重播、原始來源核驗、歷史預測成效是不同查核。此頁不因保存成功而宣告其他項目通過；各項結果請見快照稽核。高 EV 與重播一致均不代表勝率已驗證可靠。</p>
    <p className="muted">{audit.temporal?.limitation || '這是本次取得紀錄，不等於已驗證的歷史賽前快照。'} 各項詳細覆蓋情形如下。</p>
    {sourceTimeAudit && <div className="dataAuditRow"><strong>來源內容與取得時點核對：{({ VERIFIED: '通過', PENDING: '證據不足', FAILED: '核對失敗' })[sourceTimeAudit.status] || '未核對'}</strong><p>輸入鎖定：{sourceTimeAudit.inputCutoffAt || '未保存'}。此項只核對綁定來源內容與取得時間，不代表資料可用或特徵映射已驗證。缺失與未接入狀態請看逐項證據；均不代表預測效果已驗證。</p><p>特徵可用性與映射：</p>{sourceTimeAudit.rows?.map(row => <p key={row.featureName}>{row.featureName}｜{({ NOT_CONNECTED: '未接入來源', MISSING: '資料缺失', PROJECTED: '含推估資料', REPORTED: '有輸入紀錄', UNKNOWN: '未記錄' })[row.availability] || '舊快照未記錄可用性'}｜{row.mapping?.status === 'MAPPED_PATHS_PRESENT' ? '來源欄位存在；推導結果尚未重播驗證' : '欄位映射證據不足'}</p>)}<details><summary>逐項時間證據</summary><pre>{JSON.stringify(sourceTimeAudit.rows, null, 2)}</pre></details></div>}
    {audit.leagueLimitations?.map(note => <p key={note}>{note}</p>)}
    <div className="dataAuditRows">{audit.rows.map(row => <div className="dataAuditRow" key={row.id || row.key}>
      <div className="dataAuditHeading"><strong>{row.label}</strong><span className={`dataAuditStatus ${row.status}`}>{labels[row.status] || '未確認'}</span></div>
      <p>{explanations[row.status]}</p>
      {row.temporalNote && <p>{row.temporalNote}</p>}
      {row.category === 'starter' && Number.isFinite(row.inningsEstimate?.value ?? row.metrics?.expectedInnings) && <p><b>預估投球局數：</b>{(row.inningsEstimate?.value ?? row.metrics.expectedInnings).toFixed(2)} 局（推估）｜{row.inningsEstimate?.note || '歷史資料取得狀態不代表未來出賽局數已確認；此舊紀錄未保存推估分支明細。'}</p>}
      <p><b>模型使用：</b>{row.usageStatus === 'UNVERIFIED' ? '尚無逐欄使用紀錄' : [row.usedInMean && '得分中心', row.usedInUncertainty && '不確定性'].filter(Boolean).join('、') || '未進入計算／僅供診斷'}{row.status !== 'observed' && row.usedInMean ? '（包含既有替代值）' : ''}</p>
      <p><b>來源：</b>{row.source || '未提供'}｜取得 {row.observedAt ? localTime(row.observedAt) : '時間未提供'}{row.category !== 'bullpen' && `｜統計截至 ${row.asOf || '未提供'}`}</p>
      {row.category === 'bullpen' && <BullpenEvidence row={row} league={audit.league}/>}
      {row.coverage && <p><b>覆蓋：</b>{row.category === 'lineup' ? `名單 ${row.coverage.identityCount ?? '未知'}/${row.coverage.expectedCount || 9} 人；統計 ${row.coverage.metricCoverage == null ? '未確認' : `${Math.round(row.coverage.metricCoverage * 100)}%`}` : `有效名單 ${row.coverage.rosterCount ?? '未知'} 人；名單完整性${row.coverage.rosterComplete ? '已確認' : '未確認'}`}</p>}
      {row.category === 'lineup' && row.coverage?.rateStatsCoverage > 0 && <p><b>官方個人比率：</b>{Math.round(row.coverage.rateStatsCoverage * 9)}/9 人取得打擊率及打席；不等於模型所需打數與安打數完整，僅供診斷。</p>}
      {row.category === 'bullpen' && <p><b>能力統計：</b>{row.coverage?.qualityCount ?? '未確認'}/{row.coverage?.rosterCount ?? '未知'} 人必要欄位完整{row.players?.some(player => !player.qualityComplete) ? `；缺項球員：${row.players.filter(player => !player.qualityComplete).map(player => player.name || player.id).join('、')}` : ''}。欄位覆蓋不代表樣本充足或能力估計已驗證。可出賽程度仍是依近期用量估計。</p>}
      {row.category === 'bullpen' && <p><b>近期用球紀錄：</b>{row.coverage?.usage ? `完整 ${row.coverage.usage.completeGames}/${row.coverage.usage.expectedGames} 場；取得 ${row.coverage.usage.fetchedGames} 場` : '未保存逐場覆蓋證據'}{row.coverage?.usage?.missingGames?.length > 0 ? `；缺項：${row.coverage.usage.missingGames.map(game => `${game.date || game.gamePk}${game.missingPlayers?.length ? `（${game.missingPlayers.map(player => player.name || player.id).join('、')}用球數）` : '（紀錄未確認）'}`).join('、')}` : ''}。缺值不代表 0 球或充分休息。</p>}
      {row.featureDefinition && <p><b>指數定義：</b>{row.featureDefinition.description}｜基準 OPS {row.featureDefinition.baselineOps ?? '未提供'}</p>}
      {row.substitutions?.length > 0 && <p><b>替代依據：</b>此項含替代或估計處理，展開明細可查原始依據。</p>}
      <details><summary>身分、數據與來源明細</summary><pre>{JSON.stringify({ inningsEstimate: row.inningsEstimate, featureDefinition: row.featureDefinition, evidenceStatus: row.evidenceStatus, identity: row.identity, coverage: row.coverage, metrics: row.metrics, modelUsageInputs: row.modelUsageInputs, reportedBattingRates: row.reportedBattingRates, batterRateEvidence: row.batterRateEvidence, players: row.players, sources: row.sources, substitutions: row.substitutions, exclusions: row.exclusions, diagnostic: row.diagnostic, modelStatuses: row.modelStatuses, statusReason: row.statusReason, usage: row.usage }, null, 2)}</pre></details>
    </div>)}</div>
    {audit.supportingData?.length > 0 && <details className="dataAuditRow"><summary>本季、近期與環境資料的取得及使用</summary><p>列出統計期間、實際取得欄位與模型使用。近期打擊保留小樣本收縮；整隊投球與主審身分另作查核，不能當成已啟用的得分效果。以下項目未併入上方核心人員數量。</p><pre>{JSON.stringify(audit.supportingData, null, 2)}</pre></details>}
    {audit.otherUsage?.length > 0 && <details className="dataAuditRow"><summary>球場、天氣與進階欄位使用明細</summary><p>此處只列模型是否使用，不代表來源完整或功能已通過歷史驗證。</p><pre>{JSON.stringify(audit.otherUsage, null, 2)}</pre></details>}
  </details>;
}

function BullpenEvidence({ row, league }) {
  const evidence = bullpenEvidenceDisplay(row);
  return <div>
    <p>名單基準日：{evidence.rosterDates}｜個人能力統計截至：{evidence.metricDates}{evidence.metricDatesIncomplete ? '（部分日期未保存）' : ''}｜已列用量最新比賽日：{evidence.latestUsageDate}。最新紀錄日不等於完整覆蓋截止日。</p>
    <p>疲勞與可用性分開計算；可用性 1 不是官方確認，也不是 100% 出賽機率。候選名單與歷史後援出賽不等於當日角色已核驗。</p>
    {league === 'MLB' && <p>用量天數依比賽時間差換算並取整，不直接等同日曆上的昨日；請核對逐場 daysAgo 與權重。原始時間與推導紀錄未保存時，不補造。</p>}
    <details><summary>後援能力樣本局數（十進位）</summary>{evidence.samples.map((player, index) => <p key={index}>{player.name}：{player.innings == null ? '未保存' : player.innings.toFixed(2)} 局；小樣本需搭配該版本收縮與角色證據解讀。</p>)}</details>
  </div>;
}

function GameCard({ item, onBet, onCancel, getBetState, now, betsEnabled = true, shadowMode = false, cloudLedgerState = 'ready', readerAuthority = null }) {
  const displayedGame = analysisDisplayGame(item);
  const displayedItem = { ...item, game: displayedGame };
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
  const displayRowIds = new Set(analysisDisplayRowsForCard(directionAnalysis, {
    pitConfirmed: pitPersistence?.confirmed === true,
  }).map(directionIdentity));
  const actualRows = bindVerifiedReaderContractsForItem(
    item,
    analysisDirectionRows(directionAnalysis).filter(row => displayRowIds.has(directionIdentity(row))),
  ).map(row => {
    const currentReaderPrice = capturedReaderContractReady(item, row, now, readerAuthority);
    const inactiveNotice = !gamePrestart
      ? '已達官方預定開打時間｜保留賽前分析｜停止記錄新下注'
      : pitUnconfirmed
        ? 'PIT永久保存未確認｜保留模型分析與排名｜實際下注紀錄暫停'
      : !currentReaderPrice
        ? '尚無已驗證的Reader盤口｜保留分析與排名｜實際下注紀錄暫停'
        : '';
    // A captured signed line remains recordable until first pitch. Switching
    // Reader leagues never changes the immutable score or its stored contract.
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
    starterIdentity: '球員身分', starterAssignments: '當場先發指派', starters: '個人先發能力統計', lineups: '打線', bullpen: '純牛棚', parkFactor: '球場', weather: '天氣',
    catcherFraming: '捕手Framing', defenseFRV: '守備FRV', injuryRunValue: '傷停', pitchTypeMatchup: '球種對戰',
    umpire: '主審效果', umpireZone: '主審Zone', parkWindOrientation: '球場風向',
  };
  const sourceStatusText = Object.entries(analysisSourceStatusDisplay(item))
    .filter(([, value]) => value != null && String(value).trim())
    .map(([key, value]) => sourceStatusLabel(key, value) || `${sourceStatusLabels[key] || key}：${value}`)
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
      <div><h2>{matchup(displayedGame)}</h2><p>{localTime(displayedGame.gameDate)}｜{analysisStarterDisplay(displayedItem, 'away')} 對 {analysisStarterDisplay(displayedItem, 'home')}</p></div>
      <span className={`state ${item.status}`}>{item.statusLabel}</span>
    </div>
    {shadowMode && <div className="sourceBanner shadowBanner"><strong>🧪 {item.game.leagueId || item.game.league || 'MLB'} 聯合比分影子模型</strong><span>{preservingPreviousReaderAnalysis
      ? `Reader最新已開 ${openMarketCount}/4 市場｜保留上一版 ${scoredDirectionCount}/${expectedDirectionCount} 個分數與排序｜新結果完成後更新`
      : `已開 ${openMarketCount}/4 市場｜應評 ${expectedDirectionCount} 方向｜已評 ${scoredDirectionCount}/${expectedDirectionCount}｜進影子排名 ${rankingDirectionCount}；依固定S分數分析與排序`}</span></div>}
    {expectedRuns && <div className="sourceBanner"><strong>上游得分中心｜市場水位回灌：停用</strong><span>全場 {runCenter(expectedRuns.full)}｜前五局 {runCenter(expectedRuns.first5)}｜這份得分分布同時結算大／小與讓／受讓</span></div>}
    {(sourceStatusText || provenanceText) && <div className="sourceBanner dataStatusBanner"><strong>上游資料狀態</strong><span>{sourceStatusText || provenanceText}</span></div>}
    {analysisHasCalculatedDirections(item.customData) && <AnalysisDataAudit audit={analysis.dataAudit} persistence={item.customData?.pitPersistence}/>}
    {(preservingPreviousReaderAnalysis || item.restoredFromCache === true) && <div className="sourceBanner shadowBanner"><strong>保留的分析版本</strong><span>分析時間：{localTime(analysis.analysisAsOf || analysis.createdAt)}｜資料截至：{localTime(analysis.dataAsOf)}｜盤口時間：{localTime(analysis.lineAsOf)}｜模型：{analysis.modelVersion || '未記錄'}｜Reader：{(analysis.results || []).find(row => row.readerVersion)?.readerVersion || '未記錄'}｜此處時間與版本屬於保留結果</span></div>}
    {analysis.runExplanation && <details className="details"><summary>得分計算過程與局部敏感度</summary><p>以下是既定局數、終局處理前的得分中心。敏感度不等於特徵貢獻，也不是重新估算的 EV。OPS 同時是左右拆分倍率的分母；固定拆分資料時，OPS 單項斜率可能為負。</p><pre>{JSON.stringify(runExplanationDisplay(analysis.runExplanation), null, 2)}</pre></details>}
    {analysis.distributionQA && <details className="details"><summary>比分矩陣分期間 QA</summary><p>列出機率總和、平局與勝分差；終局矩陣檢查不等於逐路徑合法性或歷史準確度驗證。</p><pre>{JSON.stringify(analysis.distributionQA, null, 2)}</pre></details>}
    {pitPersistence && <div className={`sourceBanner ${pitPersistence.confirmed ? 'dataStatusBanner' : 'shadowBanner'}`}><strong>{pitPersistence.confirmed ? 'PIT快照保存已確認（不等於資料全數驗證）' : 'PIT永久保存未確認'}</strong><span>{pitPersistence.status || 'UNKNOWN'}｜{pitPersistence.reason || '未提供原因'}｜{pitPersistence.snapshotId ? String(pitPersistence.snapshotId).slice(0, 36) : '無快照識別'}</span></div>}
    {item.actualSource && <div className="sourceBanner actualSource"><strong>{item.actualSource.label}</strong><span>盤口內容時間：{localTime(item.actualSource.observedAt)}</span></div>}
    {item.error && <div className="errorBox">{item.error}</div>}
    {!item.referenceData && !item.error && <div className="emptyGame">{item.statusLabel}</div>}
    {item.referenceData && <>
      {(item.actualSource || item.marketCoverage || actualRows.length > 0) && <div className="actualBox">
        <div className="actualHead"><strong>Tai888 實際信用盤</strong><span>{preservingPreviousReaderAnalysis ? 'Reader最新' : ''}已開 {openMarketCount}/4 市場{preservingPreviousReaderAnalysis ? '｜保留上一版分析' : ''}</span></div>
        {allDirectionsUnopened
          ? <div className="readerWaitingSummary"><strong>目前尚未開盤</strong><span>四市場八方向由 Reader 持續監看；實際盤口出現後，請手動按分析。</span></div>
          : MARKET_ORDER.map(market => {
          const rows = actualRows.filter(row => row.market === market).sort(compareDirectionsByScore);
          const calculated = rows.some(row => modelEvValue(row) != null);
          const blocked = blockedMarkets.has(market) || rows.some(row => directionStatus(row) === 'BLOCKED');
          const marketState = blocked ? 'BLOCKED' : calculated ? 'AVAILABLE' : 'UNOPENED';
          const marketStateLabel = blocked && latestCoverage ? '資料異常｜停止評分'
            : preservingPreviousReaderAnalysis ? '保留上一版分析｜背景更新中｜停止下注'
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
              ? (() => {
                const betState = betsEnabled ? getBetState(item, row) : { latest: null, cancelled: null };
                const action = evaluateBetAction({ item, row, now, betsEnabled, cloudLedgerState, latest: betState?.latest, cancelled: betState?.cancelled, readerAuthority });
                return <ResultRow key={`${directionIdentity(row)}-${index}`} row={row} game={item.game} betState={betState} action={action} onBet={value => onBet(item, value)} onCancel={onCancel} now={now} inactiveNotice={row.clientInactiveNotice}/>;
              })()
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
  const [cloudLedgerBusy, setCloudLedgerBusy] = useState(true);
  const [tab, setTab] = useState('board');
  const [date, setDate] = useState(taipeiDate());
  const [schedule, setSchedule] = useState([]);
  const [gamePicker, setGamePicker] = useState({ scope: '', games: [], selected: '', loading: false });
  const gamePickerRequestRef = useRef(0);
  const [board, setBoard] = useState([]);
  const boardRef = useRef(board);
  boardRef.current = board;
  const [readerStatus, setReaderStatus] = useState(null);
  const [readerPolling, setReaderPolling] = useState(false);
  const [readerTrace, setReaderTrace] = useState([]);
  function recordReaderPhase(phase, detail = '') { setReaderTrace(rows => [...rows.slice(-19), { at: new Date().toISOString(), league, date, phase, detail }]); }
  const [queuedAnalysis, setQueuedAnalysis] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ active: false, done: 0, total: 0, label: '' });
  const [allLeagueRun, setAllLeagueRun] = useState(null);
  const allLeagueRunRef = useRef(allLeagueRun);
  allLeagueRunRef.current = allLeagueRun;
  const [allLeaguePreparing, setAllLeaguePreparing] = useState(false);
  const [backgroundJobRevision, setBackgroundJobRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [health, setHealth] = useState(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [acknowledgedReaderKey, setAcknowledgedReaderKey] = useState('');
  const snapshots = useRef(new Map());
  const creditRevisionRef = useRef('');
  const lastReferenceRefreshAtRef = useRef(0);
  const officialPrestartCheckedAtRef = useRef(0);
  const operationBusyRef = useRef(false);
  const allLeagueBusyRef = useRef(false);
  const readerPollBusyRef = useRef(false);
  const queuedAnalysisRef = useRef(null);
  const autoAnalyzeHashRef = useRef('');
  const manualAnalysisScopesRef = useRef(new Set());
  const manualDateSelectionRef = useRef(new Set());
  const currentDateRef = useRef(date);
  const currentLeagueRef = useRef(league);
  const leagueDatesRef = useRef(Object.fromEntries(LEAGUE_IDS.map(id => [id, date])));
  const rankingPanelRef = useRef(null);
  const rankingScrollAnchorRef = useRef(null);
  const analysisGenerationRef = useRef(0);
  const readerStatusRef = useRef(null);
  const readerStatusHighWaterRef = useRef(null);
  const betsRef = useRef([]);
  const cloudSyncBusyRef = useRef(false);
  const betMutationBusyRef = useRef(false);
  const cloudSyncRetryAtRef = useRef(0);
  const backgroundJobPollsRef = useRef(new Map());
  const completedRecoveryFailuresRef = useRef(new Set());
  const officialIdentityEvidenceRef = useRef(new Map());
  const [officialIdentityRevision, setOfficialIdentityRevision] = useState(0);
  const coreDataBlockRetryRef = useRef(new Map());
  const restoredBoardNeedsValidationRef = useRef(false);
  const activeLeague = leagueConfig(league);
  const analysisEnabled = activeLeague.capabilities.analysis === true;
  const readerEnabled = activeLeague.capabilities.reader === true;
  const rankingEnabled = activeLeague.capabilities.ranking === true;
  const bettingEnabled = activeLeague.capabilities.bets === true;
  const shadowMode = activeLeague.status === 'shadow';
  const allLeagueProgress = allLeagueAnalysisProgress(allLeagueRun);
  const allLeaguePrechecked = LEAGUE_IDS.filter(id => !['idle', 'preparing'].includes(
    String(allLeagueRun?.leagues?.[id]?.status || 'idle'),
  )).length;
  const allLeagueRunning = ['preparing', 'running'].includes(String(allLeagueRun?.state || ''));
  const cloudLedgerActionState = cloudLedgerBusy ? 'loading' : cloudLedgerStatus.state;
  const activeLeagueBatchStatus = allLeagueBoardDate(allLeagueRun, league) === date
    ? allLeagueRun?.leagues?.[league]?.status || 'idle'
    : 'idle';
  const readerCoverage = readerCoverageCounts(readerStatus);
  const readerPendingText = coveragePendingText(readerCoverage);
  const liveReaderAuthority = {
    fresh: readerStatus?.fresh === true,
    boardDate: readerStatus?.boardDate || null,
    expectedBoardDate: date,
    payloadHash: readerStatus?.payloadHash || null,
  };
  const identityBoard = useMemo(() => {
    const evidence = officialIdentityEvidenceRef.current.get(`${league}:${date}`);
    return evidence ? reconcileOfficialBoardIdentity(board, evidence) : board;
  }, [board, league, date, officialIdentityRevision]);
  const activeBoard = useMemo(() => identityBoard.filter(item => !isHistoricalIdentityConflict(item)), [identityBoard]);
  const historicalIdentityBoard = useMemo(() => identityBoard.filter(isHistoricalIdentityConflict), [identityBoard]);
  useEffect(() => {
    if (identityBoard === board) return;
    boardRef.current = identityBoard;
    setBoard(identityBoard);
  }, [identityBoard, board]);
  const shadowRanking = useMemo(() => activeBoard.flatMap(item => {
    const analysis = item.customData?.analysis || {};
    const itemLeague = String(analysis.leagueId || item?.game?.leagueId || item?.game?.league || '').trim().toUpperCase();
    if (itemLeague !== league) return [];
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
    return bindVerifiedReaderContractsForItem(item, analysisDirectionRows(directionAnalysis))
      .filter(row => item.actualSource?.provider === 'TAI888_READER_AUTO'
        && modelEvValue(row) != null
        && !currentBlockedMarkets.has(row.market)
        && (hasDirectionSlots || (row.sourceType === 'ACTUAL_TW_CREDIT' && row.provider === 'TAI888_READER_AUTO')))
      .map(row => {
      const score = formulaScoreValue(row);
      const qaPassed = directionQaPassed(row);
      const qualified = row.evCalibration?.qualified === true;
      const gamePrestart = gameIsPrestartNow(item.game, clockNow);
      const pitConfirmed = item.customData?.pitPersistence?.confirmed === true;
      const currentReaderPrice = capturedReaderContractReady(item, row, clockNow, liveReaderAuthority);
      const inactiveNotice = !gamePrestart
        ? '比賽已開始｜保留賽前分析與排名｜停止記錄新下注'
        : !pitConfirmed
          ? 'PIT永久保存未確認｜保留模型分析與排名｜實際下注紀錄暫停'
        : !currentReaderPrice
          ? '尚無已驗證的Reader盤口｜保留分析與排名｜實際下注紀錄暫停'
          : '';
      const rankingEligible = currentAnalysisExecutable
        && qualified && qaPassed && row.scoreStatus === 'SHADOW_DIAGNOSTIC_UNCALIBRATED'
        && row.rankingQualified === true;
      const stableKey = `${item.game.gamePk}|${row.slotId || `${row.market}|${row.direction || row.pick}`}`;
      return { item, row, stableKey, gamePk: item.game.gamePk, matchup: matchup(item.game), market: row.market, pick: row.pick,
        water: row.water, score, weightedEV: modelEvValue(row), robustEV: robustEvValue(row), qaPassed, qualified,
        currentReaderPrice, inactiveNotice, rankingEligible };
      });
  })
    .sort((left, right) => Number(right.score ?? -Infinity) - Number(left.score ?? -Infinity)
      || Number(right.weightedEV ?? -Infinity) - Number(left.weightedEV ?? -Infinity)
      || Number(right.robustEV ?? -Infinity) - Number(left.robustEV ?? -Infinity)),
  [activeBoard, clockNow, readerStatus?.fresh, readerStatus?.boardDate, readerStatus?.payloadHash, date]);
  const shadowBetOrder = useMemo(() => buildBetOrderEntries(shadowRanking), [shadowRanking]);
  const shadowBetOrderGames = useMemo(() => groupBetOrderEntries(shadowBetOrder), [shadowBetOrder]);
  const rankingLayoutRevision = useMemo(() => shadowRanking
    .map(entry => `${entry.stableKey}:${entry.score ?? ''}:${entry.weightedEV ?? ''}:${entry.robustEV ?? ''}`)
    .join('||'), [shadowRanking]);
  const rankingProvenance = useMemo(() => {
    const modelVersions = [...new Set(activeBoard.map(item => item.customData?.analysis?.modelVersion).filter(Boolean))];
    const lineTimes = activeBoard.flatMap(item => (item.customData?.analysis?.results || []).map(row => row.lineAsOf).filter(Boolean));
    return {
      modelVersions,
      latestLineAsOf: lineTimes.sort().at(-1) || null,
    };
  }, [activeBoard]);

  useLayoutEffect(() => {
    if (!['ranking', 'betOrder'].includes(tab)) {
      rankingScrollAnchorRef.current = null;
      return undefined;
    }
    const pending = rankingScrollAnchorRef.current;
    const container = rankingPanelRef.current;
    if (pending?.tab === tab && container) {
      const target = [...container.querySelectorAll('[data-rank-key]')]
        .find(element => element.dataset.rankKey === pending.key);
      if (target) {
        const delta = target.getBoundingClientRect().top - pending.top;
        if (Math.abs(delta) > 1) window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
      }
    }
    rankingScrollAnchorRef.current = null;
    return () => {
      const current = rankingPanelRef.current;
      if (!current) return;
      const visible = [...current.querySelectorAll('[data-rank-key]')]
        .map(element => ({ element, rect: element.getBoundingClientRect() }))
        .find(({ rect }) => rect.bottom > 0 && rect.top < window.innerHeight);
      if (visible) rankingScrollAnchorRef.current = {
        tab,
        key: visible.element.dataset.rankKey,
        top: visible.rect.top,
      };
    };
  }, [tab, rankingLayoutRevision]);

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

  function publishAllLeagueRun(run) {
    allLeagueRunRef.current = run || null;
    setAllLeagueRun(run || null);
    if (run) saveAllLeagueAnalysisRun(run);
  }

  function setLeagueBoardDate(targetLeague, value, { manual = false } = {}) {
    const id = normalizeLeagueId(targetLeague);
    const nextDate = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) return false;
    leagueDatesRef.current[id] = nextDate;
    if (manual) manualDateSelectionRef.current.add(id);
    if (currentLeagueRef.current === id) {
      currentDateRef.current = nextDate;
      setDate(nextDate);
    }
    return true;
  }

  function selectAnalysisDate(value) {
    gamePickerRequestRef.current += 1;
    setGamePicker({ scope: '', games: [], selected: '', loading: false });
    setLeagueBoardDate(league, value, { manual: true });
  }

  async function allLeagueTargetDate(targetLeague, selectedDate) {
    if (manualDateSelectionRef.current.has(targetLeague)) return selectedDate;
    try {
      const latest = await requestJSONWithTransientRetry(
        `/api/reader/status?league=${encodeURIComponent(targetLeague)}&t=${Date.now()}`,
        {},
        20000,
        { delaysMs: [0, 1500, 4000] },
      );
      const readerDate = String(latest?.boardDate || '').trim();
      const readerTime = Date.parse(`${readerDate}T00:00:00Z`);
      const validReaderDate = /^\d{4}-\d{2}-\d{2}$/.test(readerDate)
        && Number.isFinite(readerTime)
        && new Date(readerTime).toISOString().slice(0, 10) === readerDate;
      return latest?.fresh === true && validReaderDate && readerDate > selectedDate
        ? readerDate : selectedDate;
    } catch {
      return selectedDate;
    }
  }

  function acquireOperation() {
    if (operationBusyRef.current || allLeagueBusyRef.current) return false;
    if (readerPollBusyRef.current) {
      setNotice('Reader 正在自動複核最新盤口；完成後即可再次操作。');
      return false;
    }
    operationBusyRef.current = true;
    markAppOperationBusy(true);
    setBusy(true);
    return true;
  }

  function releaseOperation() {
    operationBusyRef.current = false;
    markAppOperationBusy(false);
    setBusy(false);
  }

  function reportCloudLedgerFailure(cause) {
    const retryAt = Date.now() + cloudLedgerRetryDelay(cause);
    cloudSyncRetryAtRef.current = retryAt;
    setCloudLedgerStatus(cloudLedgerFailureState(cause, retryAt));
  }

  async function probeCloudLedgerRecovery() {
    if (cloudSyncBusyRef.current || betMutationBusyRef.current || document.visibilityState !== 'visible') return;
    cloudSyncBusyRef.current = true;
    setCloudLedgerBusy(true);
    try {
      const data = await requestJSON('/api/bets', {}, 30000);
      if (!Array.isArray(data.bets)) throw new Error('雲端下注紀錄回傳格式錯誤');
      betsRef.current = data.bets;
      setBets(data.bets);
      setCalibrationStatus(data.calibration || null);
      cloudSyncRetryAtRef.current = 0;
      setCloudLedgerStatus({ state: 'ready', code: '', message: '', retryAt: 0 });
    } catch (cause) {
      reportCloudLedgerFailure(cause);
    } finally {
      cloudSyncBusyRef.current = false;
      setCloudLedgerBusy(false);
    }
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
    if (cloudSyncBusyRef.current || betMutationBusyRef.current) return;
    cloudSyncBusyRef.current = true;
    setCloudLedgerBusy(true);
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
      setCloudLedgerBusy(false);
    }
  }

  useEffect(() => {
    const initial = loadCompactStore();
    const migratedBets = migrateLegacyLocalBets(initial.bets);
    // Same-site sport routes can return to a particular baseball league.
    const requestedLeague = new URLSearchParams(window.location.search).get('league');
    setLeague(LEAGUE_IDS.includes(requestedLeague) ? requestedLeague : initial.activeLeague);
    setSettings(initial.settings);
    betsRef.current = migratedBets;
    setBets(migratedBets);
    setStorageReady(true);
    cloudSyncBusyRef.current = true;
    setCloudLedgerBusy(true);
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
    }).finally(() => {
      cloudSyncBusyRef.current = false;
      setCloudLedgerBusy(false);
    });
  }, []);
  useEffect(() => {
    betsRef.current = bets;
    if (storageReady) saveCompactStore({ settings, bets, activeLeague: league });
  }, [settings, bets, league, storageReady]);
  useEffect(() => {
    if (!storageReady) return;
    const saved = loadAllLeagueAnalysisRun(date);
    if (isInterruptedPreSubmitRun(saved)) {
      // Without a durable run id there is no server analysis failure to show.
      // Remove the local-only interruption so reload always unlocks the buttons.
      clearAllLeagueAnalysisRun(saved);
      allLeagueRunRef.current = null;
      setAllLeagueRun(null);
      setProgress({ active: false, done: 0, running: 0, total: 0, label: '' });
      return;
    }
    setAllLeagueRun(saved);
  }, [date, storageReady]);
  useEffect(() => {
    if (!storageReady || !allLeagueRun?.runId
      || !['preparing', 'running'].includes(String(allLeagueRun.state || ''))) return undefined;
    let active = true;
    let timer;
    const expectedRunId = allLeagueRun.runId;
    const stillCurrentRun = () => active && allLeagueRunRef.current?.runId === expectedRunId;
    const pollSummary = async () => {
      if (!stillCurrentRun()) return;
      try {
        const state = await requestJSON(`/api/analysis-jobs?runId=${encodeURIComponent(expectedRunId)}&summary=1&t=${Date.now()}`, {}, 30000);
        if (!stillCurrentRun()) return;
        if (state.status === 'completed') {
          const saved = loadAllLeagueAnalysisRun(date);
          const latest = saved?.runId === expectedRunId ? saved : allLeagueRunRef.current;
          let completedRun = {
            ...latest,
            state: 'completed',
            completedAt: new Date().toISOString(),
          };
          const resultByLeague = new Map((state.result?.batches || [])
            .map(batch => [String(batch?.league || '').toUpperCase(), batch]));
          for (const id of LEAGUE_IDS) {
            const batch = resultByLeague.get(id);
            if (!batch) continue;
            completedRun = updateAllLeagueAnalysisLeague(completedRun, id, {
              boardDate: batch.date || allLeagueBoardDate(completedRun, id, completedRun.date),
              ...summarizeAllLeagueBatchResult(batch),
              message: batch.emptyReason === 'no_games' ? '今日沒有賽前場次'
                : batch.emptyReason === 'no_open_markets' ? '今日盤口尚未開出'
                  : '',
            });
          }
          publishAllLeagueRun(completedRun);
          setProgress(value => ({ ...value, active: false, running: 0 }));
          setBackgroundJobRevision(value => value + 1);
          return;
        }
        if (['failed', 'cancelled'].includes(String(state.status || '').toLowerCase())) {
          const saved = loadAllLeagueAnalysisRun(date);
          const latest = saved?.runId === expectedRunId ? saved : allLeagueRunRef.current;
          let failedRun = { ...latest, state: 'completed', completedAt: new Date().toISOString() };
          for (const id of LEAGUE_IDS) {
            const status = failedRun.leagues?.[id]?.status;
            if (!['done', 'partial', 'failed', 'no_games', 'no_open_markets'].includes(status)) {
              failedRun = updateAllLeagueAnalysisLeague(failedRun, id, {
                status: 'failed', message: '四聯盟伺服器背景工作未完成',
              });
            }
            clearBackgroundJob(id, allLeagueBoardDate(failedRun, id, failedRun.date), expectedRunId);
          }
          publishAllLeagueRun(failedRun);
          setProgress(value => ({ ...value, active: false, running: 0, label: '四聯盟伺服器背景工作未完成' }));
          setBackgroundJobRevision(value => value + 1);
          return;
        }
      } catch (cause) {
        if (!stillCurrentRun()) return;
        const failure = analysisFailureState(cause);
        if (failure.permanent) {
          const saved = loadAllLeagueAnalysisRun(date);
          const latest = saved?.runId === expectedRunId ? saved : allLeagueRunRef.current;
          let failedRun = { ...latest, state: 'completed', completedAt: new Date().toISOString() };
          for (const id of LEAGUE_IDS) {
            if (!['done', 'partial', 'failed', 'no_games', 'no_open_markets'].includes(failedRun.leagues?.[id]?.status)) {
              failedRun = updateAllLeagueAnalysisLeague(failedRun, id, {
                status: 'failed',
                message: failure.status === 404 ? '背景工作已失效，請重新執行' : failure.message,
              });
            }
            clearBackgroundJob(id, allLeagueBoardDate(failedRun, id, failedRun.date), expectedRunId);
          }
          publishAllLeagueRun(failedRun);
          setProgress(value => ({ ...value, active: false, running: 0, label: '四聯盟背景工作已停止' }));
          setBackgroundJobRevision(value => value + 1);
          setError(failure.status === 404
            ? '先前的四聯盟背景工作已失效，按鈕已解鎖，請重新分析。'
            : failure.message);
          return;
        }
        // The durable workflow keeps running when the browser temporarily
        // loses its connection. Poll again without resetting any league.
      }
      if (stillCurrentRun()) timer = window.setTimeout(pollSummary, 2500);
    };
    void pollSummary();
    return () => { active = false; window.clearTimeout(timer); };
  }, [storageReady, date, allLeagueRun?.runId, allLeagueRun?.state]);
  useEffect(() => {
    if (!storageReady || !['bets', 'performanceStats'].includes(tab) || cloudLedgerStatus.state !== 'ready') return undefined;
    refreshSettlements('');
    const onVisible = () => { if (document.visibilityState === 'visible') refreshSettlements(''); };
    const timer = window.setInterval(() => refreshSettlements(''), CLOUD_LEDGER_VISIBLE_REFRESH_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [storageReady, tab, league, cloudLedgerStatus.state]);
  useEffect(() => {
    if (!storageReady || cloudLedgerStatus.state !== 'unavailable') return undefined;
    let disposed = false;
    let timer;
    const attemptWhenDue = () => {
      if (disposed || document.visibilityState !== 'visible') return;
      const delay = Math.max(0, Number(cloudLedgerStatus.retryAt || cloudSyncRetryAtRef.current || 0) - Date.now());
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { if (!disposed) void probeCloudLedgerRecovery(); }, delay);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') attemptWhenDue(); };
    attemptWhenDue();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [storageReady, cloudLedgerStatus.state, cloudLedgerStatus.retryAt]);
  useEffect(() => {
    currentDateRef.current = date;
    currentLeagueRef.current = league;
    leagueDatesRef.current[league] = date;
    analysisGenerationRef.current += 1;
    snapshots.current.clear();
    creditRevisionRef.current = '';
    officialPrestartCheckedAtRef.current = 0;
    autoAnalyzeHashRef.current = '';
    coreDataBlockRetryRef.current.clear();
    setAcknowledgedReaderKey('');
    const restoredBoard = storageReady ? loadAnalysisBoardCache(league, date) : [];
    boardRef.current = restoredBoard;
    restoredBoardNeedsValidationRef.current = restoredBoard.length > 0
      && !manualAnalysisScopesRef.current.has(`${league}:${date}`);
    setSchedule(restoredBoard.map(item => item.game));
    setBoard(restoredBoard);
    setError('');
    if (restoredBoard.length) setNotice(`已恢復 ${restoredBoard.length} 場上一版分析；分數保留顯示，未啟動重算，請手動按分析以驗證最新盤口。`);
    readerStatusRef.current = null;
    readerStatusHighWaterRef.current = null;
    setReaderStatus(null);
  }, [date, league, storageReady]);
  useEffect(() => {
    if (!storageReady) return undefined;
    const saved = loadBackgroundJob(league, date, boardRef.current);
    if (!saved?.runId) return undefined;
    if (completedRecoveryFailuresRef.current.has(`${league}|||${date}|||${saved.runId}`)) return undefined;
    const locksForeground = saved.batchMode !== 'all-leagues';
    if (locksForeground && operationBusyRef.current) return undefined;
    if (Array.isArray(saved.preparedBoard)) {
      setSchedule(saved.preparedBoard.map(item => item?.game).filter(Boolean));
      setBoard(current => mergePreparedLeagueBoard(current, saved.preparedBoard));
    }
    const generation = analysisGenerationRef.current;
    if (locksForeground) {
      operationBusyRef.current = true;
      markAppOperationBusy(true);
      setBusy(true);
    }
    setProgress({ active: true, done: 0, running: 1, total: Number(saved.total) || 1, label: saved.completedReceipt === true ? '正在接回已完成的伺服器結果' : saved.batchMode === 'all-leagues' ? '四聯盟伺服器背景分析中｜可自由切換' : '伺服器背景分析中｜可離開App' });
    setNotice(saved.completedReceipt === true
      ? '正在接回已完成的伺服器結果；原始分數保留，最新 Reader 盤口會另行核對。'
      : saved.batchMode === 'all-leagues'
      ? `已接回 ${league} 的四聯盟背景工作；完成後分數會保存於各自聯盟。`
      : '已接回尚未完成的伺服器背景分析；可以切換畫面，完成後會自動載入。');
    pollBackgroundJob(saved.runId, generation, date, saved.gamePks, { completedReceipt: saved.completedReceipt === true ? saved : null }).then(result => {
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== date) return;
      const resultActuallyLoaded = result?.detached !== true && result?.discarded !== true;
      if (saved.batchMode === 'all-leagues' && resultActuallyLoaded && result?.recoveryPersisted === true) {
        const completedRun = loadAllLeagueAnalysisRun(date);
        if (completedRun?.runId === saved.runId) {
          publishAllLeagueRun(updateAllLeagueAnalysisLeague(completedRun, league, { resultLoaded: true }));
        }
      }
      if (!resultActuallyLoaded) {
        setNotice('伺服器分析已完成；Reader盤口已更新，結果保留待重新驗證載入。');
        return;
      }
      const rows = Array.isArray(result?.results) ? result.results : [];
      const completed = rows.filter(row => row?.ok).length;
      const blocked = rows.filter(row => !row?.ok && analysisFailureState(row).blocked).length;
      const failed = Math.max(0, (Number(result?.total) || rows.length) - completed - blocked);
      if (result?.restoredCompleted === true) {
        setNotice(`已接回 ${completed} 場已完成的伺服器結果；原始分數已恢復，最新 Reader 盤口正在核對。`);
        return;
      }
      setNotice(`伺服器背景分析已載入：完成 ${completed} 場${blocked ? `｜資料不足 ${blocked} 場` : ''}${failed ? `｜暫時失敗 ${failed} 場` : ''}。`);
    }).catch(cause => {
      if (generation === analysisGenerationRef.current && currentDateRef.current === date) setError(String(cause?.message || cause));
    }).finally(() => {
      if (locksForeground && generation === analysisGenerationRef.current && currentDateRef.current === date) {
        releaseOperation();
        setProgress(value => ({ ...value, active: false }));
      }
    });
    return undefined;
  }, [date, league, storageReady, busy, backgroundJobRevision]);
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
        // Completed cards may remain cached after midnight. Their presence must
        // not pin the app to yesterday and hide the new board's full slate.
        const hasCurrentPrestartGame = board.some(item => gameIsPrestartNow(item?.game, stamp));
        const [value, latest] = await Promise.all([
          requestJSON(`/api/reader/status?league=${encodeURIComponent(league)}&date=${encodeURIComponent(date)}&t=${stamp}`, {}, 20000),
          requestJSON(`/api/reader/status?league=${encodeURIComponent(league)}&t=${stamp}`, {}, 20000),
        ]);
        if (!active) return;
        if (latest?.fresh
          && /^\d{4}-\d{2}-\d{2}$/.test(String(latest.boardDate || ''))
          && latest.boardDate > currentDateRef.current
          && !manualDateSelectionRef.current.has(league)
          && !hasCurrentPrestartGame
          && !operationBusyRef.current
          && !allLeagueRunning
          && !allLeagueBusyRef.current
          && !readerPollBusyRef.current) {
          setNotice(`已依 ${league} Tai888 Reader 自動切換至 ${latest.boardDate} 盤口日期。`);
          setLeagueBoardDate(league, latest.boardDate);
          return;
        }
        commitReaderStatus(value);
        if (value?.fresh || hasCurrentPrestartGame || operationBusyRef.current
          || allLeagueRunning || allLeagueBusyRef.current || readerPollBusyRef.current) return;
        if (!active || !latest?.fresh || !/^\d{4}-\d{2}-\d{2}$/.test(String(latest.boardDate || ''))) return;
        if (latest.boardDate > currentDateRef.current && !manualDateSelectionRef.current.has(league)) {
          setNotice(`已依 Tai888 Reader 自動切換至 ${latest.boardDate} 盤口日期。`);
          setLeagueBoardDate(league, latest.boardDate);
        }
      } catch (cause) {
        if (active) invalidateReaderStatus(cause?.message || cause);
      }
    };
    refreshReader();
    const timer = window.setInterval(refreshReader, READER_RECHECK_INTERVAL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [date, board.length, league, readerEnabled, analysisEnabled, allLeagueRunning]);
  // Reader polling above is read-only. Analysis/repricing requires an explicit
  // analysis button; neither entry, timers nor a completed job may start it.
  useEffect(() => {
    // A previous league's poll may release the shared Reader lock after this
    // league queued a manual click. Drain from the active render so the old
    // closure cannot either lose that click or run it for the wrong league.
    if (!queuedAnalysis || readerPolling || busy || allLeaguePreparing || allLeagueRunning
      || !analysisEnabled || readerPollBusyRef.current || operationBusyRef.current
      || queuedAnalysisRef.current !== queuedAnalysis
      || queuedAnalysis.league !== league || queuedAnalysis.date !== date) return;
    queuedAnalysisRef.current = null;
    setQueuedAnalysis(null);
    void oneClickAnalyze('', queuedAnalysis.gamePk);
  }, [queuedAnalysis, readerPolling, busy, allLeaguePreparing, allLeagueRunning, analysisEnabled, league, date]);
  const currentReaderHashKey = readerHashKey(date, readerStatus?.payloadHash);
  const readerExecutable = readerEnabled
    && readerStatus?.fresh === true
    && readerStatus?.boardDate === date
    && Boolean(currentReaderHashKey);
  const visibleBets = useMemo(
    () => bets.filter(bet => normalizeLeagueId(bet?.league) === league),
    [bets, league],
  );

  function getBetState(item, row) {
    const records = bets.filter(bet => betMatches(bet, date, item.game.gamePk, row, league))
      .sort((left, right) => Date.parse(right.placedAt || 0) - Date.parse(left.placedAt || 0));
    const activeRecords = records.filter(bet => bet.status !== 'CANCELLED');
    return {
      records,
      latest: activeRecords[0] || null,
      exact: activeRecords.find(bet => betPriceMatches(bet, date, item.game.gamePk, row, league)) || null,
      cancelled: records.find(bet => bet.status === 'CANCELLED') || null,
    };
  }

  function updateBoard(gamePk, updater) {
    setBoard(current => current.map(item => item.game.gamePk === gamePk ? updater(item) : item));
  }

  async function fetchScheduleForLeague(targetLeague, targetDate, { commit = false } = {}) {
    const config = leagueConfig(targetLeague);
    if (!config.scheduleEndpoint) throw new Error(`${config.label}正式賽程尚未接入，不能進行分析`);
    const data = await requestJSONWithTransientRetry(
      `${config.scheduleEndpoint}?league=${encodeURIComponent(targetLeague)}&date=${encodeURIComponent(targetDate)}&t=${Date.now()}`,
      {},
      40000,
    );
    const rows = Array.isArray(data.games) ? data.games.filter(game => gameIsPrestartNow(game, Date.now())) : [];
    if (data.ok === true && data.league === targetLeague && data.date === targetDate
      && Array.isArray(data.identitySlate) && typeof data.identityAsOf === 'string') {
      const evidence = { league: targetLeague, date: targetDate,
        identitySlate: data.identitySlate, identityAsOf: data.identityAsOf };
      officialIdentityEvidenceRef.current.set(`${targetLeague}:${targetDate}`, evidence);
      setOfficialIdentityRevision(value => value + 1);
      if (currentDateRef.current === targetDate && currentLeagueRef.current === targetLeague) {
        const reconciled = reconcileOfficialBoardIdentity(boardRef.current, evidence);
        if (reconciled !== boardRef.current) {
          boardRef.current = reconciled;
          setBoard(reconciled);
        }
      }
    }
    if (commit && currentDateRef.current === targetDate && currentLeagueRef.current === targetLeague) setSchedule(rows);
    return rows;
  }

  async function fetchSchedule(targetDate = date) {
    return fetchScheduleForLeague(league, targetDate, { commit: true });
  }

  async function loadGamePicker() {
    const scope = `${league}:${date}`;
    const request = ++gamePickerRequestRef.current;
    setGamePicker({ scope, games: [], selected: '', loading: true });
    setError('');
    try {
      const games = await fetchScheduleForLeague(league, date);
      if (request !== gamePickerRequestRef.current || `${currentLeagueRef.current}:${currentDateRef.current}` !== scope) return;
      setGamePicker({ scope, games, selected: '', loading: false });
      setNotice(games.length ? '已讀取賽程，尚未執行分析。請選擇一場，或按本日全部分析。' : '這個日期目前沒有可分析的賽前賽事。');
    } catch (cause) {
      if (request !== gamePickerRequestRef.current || `${currentLeagueRef.current}:${currentDateRef.current}` !== scope) return;
      setGamePicker({ scope, games: [], selected: '', loading: false });
      setError(cause?.message || '賽程讀取失敗');
    }
  }

  async function fetchReferenceLines(games, targetDate = date, targetGames = []) {
    if (!Array.isArray(games) || !games.length) {
      return { ok: true, configured: false, games: [], failures: [], message: '今日沒有可配對的賽事' };
    }
    const targetLeague = normalizeLeagueId(games[0]?.leagueId || games[0]?.league || league);
    if (targetLeague !== 'MLB') {
      return { ok: true, league: targetLeague, configured: false, games: [], failures: [], message: `${targetLeague} 尚未設定同聯盟合法外部盤源` };
    }
    try {
      const targets = (Array.isArray(targetGames) ? targetGames : []).map(row => ({
        gamePk: Number(row?.gamePk || row?.game?.gamePk),
        markets: (Array.isArray(row?.markets) ? row.markets : []).map(market => ({
          market: String(market?.market || ''),
          pick: String(market?.pick || ''),
        })).filter(market => market.market && market.pick),
      })).filter(row => row.gamePk && row.markets.length);
      const result = await requestJSON('/api/reference-lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ league: targetLeague, date: targetDate, schedule: games, targets }),
      }, 60000);
      lastReferenceRefreshAtRef.current = Date.now();
      return result;
    } catch (cause) {
      lastReferenceRefreshAtRef.current = Date.now();
      return { ok: false, configured: false, games: [], failures: [], message: `獨立外部市場取得失敗：${String(cause?.message || cause)}` };
    }
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
    const taskEvidenceHash = readerGameEvidenceHash(task);
    const currentEvidenceHash = String(currentItem?.pendingReaderEvidenceHash
      || readerGameEvidenceHash(currentItem)
      || '').trim();
    // Reader payloadHash and activity time cover the entire league board. A
    // different NPB game can advance both while this game's signed market is
    // unchanged. Once both sides have per-game evidence, that is the only
    // revision boundary that may discard this game's completed work.
    const gameRevisionStale = readerTaskGameRevisionIsStale(taskEvidenceHash, currentEvidenceHash);
    if (gameRevisionStale != null) return gameRevisionStale;
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
      && item?.pendingReaderEvidenceHash === expectedEvidenceHash;
  }

  function commitAnalysisPayload(task, baseData) {
    if (task?.game?.gamePk && baseData?.game?.gamePk && !sameAnalysisGame(task.game, baseData.game)) return false;
    const game = analysisGameIdentity(task?.game, baseData?.game);
    if (!game?.gamePk || !baseData?.analysis) return false;
    const commitBoard = updater => {
      const next = updater(boardRef.current);
      boardRef.current = next;
      setBoard(next);
      if (storageReady) saveAnalysisBoardCache(league, currentDateRef.current, next);
    };
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
      commitBoard(current => current.map(item => {
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
    commitBoard(current => {
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
        pendingReaderEvidenceHash: null,
        referenceData: compactAnalysisData(baseData),
        mode: 'actual',
        status: 'done',
        statusLabel: Number(baseData?.analysis?.calculatedDirectionCount || 0) === 0
          ? '八方向槽位已保存｜目前尚未開盤或市場資料異常'
          : baseData.pitPersistence?.confirmed
            ? 'Tai888盤口分析完成｜快照保存已確認'
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

  function pollBackgroundJob(runId, generation, targetDate, gamePks = [], { completedReceipt = null } = {}) {
    const pollKey = `${runId}|||${generation}|||${targetDate}`;
    const currentPoll = backgroundJobPollsRef.current.get(pollKey);
    if (currentPoll) return currentPoll;
    const poll = (async () => {
      let readerWaitDelayMs = 2500;
      while (generation === analysisGenerationRef.current && currentDateRef.current === targetDate) {
        try {
          const state = await requestJSON(`/api/analysis-jobs?runId=${encodeURIComponent(runId)}&league=${encodeURIComponent(league)}&t=${Date.now()}`, {}, 30000);
          if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) {
            return { detached: true, total: 0, completed: 0, results: [] };
          }
          if (state.status === 'completed') {
            const result = state.result || {};
            const rows = Array.isArray(result.results) ? result.results : [];
            if (completedReceipt) {
              const verified = createCompletedAnalysisReceipt(completedReceipt, result);
              if (!verified || completedReceipt.gamePks.some(gamePk => !verified.gamePks.includes(gamePk)
                || verified.gameVersions?.[gamePk]?.fingerprint !== completedReceipt.gameVersions?.[gamePk]?.fingerprint)) {
                const failure = new Error('已完成背景結果與保存的聯盟／日期／賽事識別不符；未載入異常資料。');
                failure.backgroundFatal = true;
                throw failure;
              }
              const missing = new Set(completedReceipt.missingGamePks || completedReceipt.gamePks);
              const restoredRows = rows.filter(row => row?.ok === true && missing.has(Number(row?.task?.game?.gamePk)));
              const entry = createAnalysisBoardCacheEntry({ league, date: targetDate, board: restoredRows.map(row => (
                preserveCompletedReaderResult(null, row, null, compactAnalysisData(row.payload))
              )).filter(Boolean) });
              const restored = restoreAnalysisBoardCache(entry, { league, date: targetDate });
              const current = boardRef.current;
              const byPk = new Map(current.map(item => [Number(item?.game?.gamePk), item]));
              for (const item of restored) {
                const previous = byPk.get(Number(item.game.gamePk));
                if (!completedReceiptGameMatches(previous, completedReceipt, Number(item.game.gamePk))) {
                  byPk.set(Number(item.game.gamePk), item);
                }
              }
              const next = [...byPk.values()].sort((left, right) => Date.parse(left?.game?.gameDate || '') - Date.parse(right?.game?.gameDate || ''));
              boardRef.current = next;
              setBoard(next);
              setSchedule(next.map(item => item.game));
              saveAnalysisBoardCache(league, targetDate, next);
              // Identical to an ordinary cache restore: retain immutable
              // displayed values, then let the existing Reader poll validate
              // current execution authority and refresh stale core inputs.
              restoredBoardNeedsValidationRef.current = false;
              return { ...result, results: restoredRows, restoredCompleted: true, recoveryPersisted: true };
            }
            const completedRecovery = saveCompletedAnalysisReceipt({ runId, league, date: targetDate }, result);
            const clearCompletedJobAfterReceipt = () => {
              if (!completedRecovery.completed || (completedRecovery.stored && !completedRecovery.retainJob)) {
                clearBackgroundJob(result.league || league, result.date || targetDate, runId);
              }
            };
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
                clearCompletedJobAfterReceipt();
                setBoard(current => finalizeReaderBoardAtStart(current, Date.now(), { noPrestartGames: true }));
                setProgress({ active: false, done: 0, running: 0, total: Number(result.total) || rows.length, label: '背景結果已停止｜場次已開始、延期或取消' });
                return { ...result, discarded: true, results: [] };
              }
              if (!applicableRows.length) {
                clearCompletedJobAfterReceipt();
                setProgress({ active: false, done: 0, running: 0, total: Number(result.total) || rows.length, label: '背景結果已停止｜該批場次已開始、延期或取消' });
                return { ...result, discarded: true, results: [] };
              }
              const credit = await requestJSONWithTransientRetry('/api/credit-lines', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
                body: JSON.stringify({ league, date: targetDate, schedule: officialGames }),
              }, 60000, { delaysMs: ANALYSIS_TRANSIENT_RETRY_DELAYS_MS });
              if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) {
                return { detached: true, total: 0, completed: 0, results: [] };
              }
              if (credit?.code === 'NO_PRESTART_GAMES') {
                clearCompletedJobAfterReceipt();
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
                await new Promise(resolve => window.setTimeout(resolve, readerWaitDelayMs));
                readerWaitDelayMs = Math.min(30000, readerWaitDelayMs * 2);
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
                const completedDisplayRows = rows.filter(row => (
                  discardedReaderPks.has(Number(row?.task?.game?.gamePk))
                  && row?.ok === true
                  && row?.payload?.analysis
                ));
                setBoard(current => {
                  let next = current.map(item => {
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
                  });
                  for (const row of completedDisplayRows) {
                    const gamePk = Number(row?.task?.game?.gamePk);
                    const liveGame = currentReaderByPk.get(gamePk) || null;
                    const previousIndex = next.findIndex(item => Number(item?.game?.gamePk) === gamePk);
                    const previous = previousIndex >= 0 ? next[previousIndex] : null;
                    const preserved = preserveCompletedReaderResult(
                      previous,
                      row,
                      liveGame,
                      compactAnalysisData(row.payload),
                    );
                    if (!preserved) continue;
                    if (previousIndex >= 0) next[previousIndex] = preserved;
                    else next.push(preserved);
                  }
                  return next.sort((left, right) => (
                    Date.parse(left?.game?.gameDate || '') - Date.parse(right?.game?.gameDate || '')
                  ));
                });
              }
              if (!applicableRows.length) {
                clearCompletedJobAfterReceipt();
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
            clearCompletedJobAfterReceipt();
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
              recoveryPersisted: completedRecovery.stored,
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
          if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) {
            return { detached: true, total: 0, completed: 0, results: [] };
          }
          if (cause?.backgroundFatal || [401, 403, 404].includes(Number(cause?.status))) {
            completedRecoveryFailuresRef.current.add(`${league}|||${targetDate}|||${runId}`);
            markBackgroundResultUnavailable(league, targetDate, runId);
            if (completedReceipt) {
              clearCompletedAnalysisReceipt(league, targetDate, runId);
            }
            clearBackgroundJob(league, targetDate, runId);
            releaseTerminalBackgroundCards(gamePks, cause?.backgroundFatal ? 'failed' : 'unavailable');
            if (generation === analysisGenerationRef.current && currentDateRef.current === targetDate) {
              setProgress(value => ({ ...value, active: false, running: 0, label: '伺服器背景分析已停止' }));
            }
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
    const job = await startBackgroundAnalysisJob({
      league,
      date: targetDate,
      tasks: tasks.map(task => ({ ...task, requestId: uid(), generation: undefined })),
    });
    const reconnectSaved = saveBackgroundJob({
      runId: job.runId,
      league,
      date: targetDate,
      total: tasks.length,
      gamePks: tasks.map(task => Number(task?.game?.gamePk)).filter(Number.isFinite),
      preparedBoard: tasks.map(task => ({
        game: task.game, mode: 'actual', readerPayloadHash: null,
        customMarkets: [], status: 'queued',
        statusLabel: '等待伺服器背景分析', error: '',
      })),
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

  async function prepareAllLeagueBatch(targetLeague, targetDate) {
    const config = leagueConfig(targetLeague);
    if (config.capabilities.analysis !== true || config.capabilities.reader !== true) {
      throw new Error(`${config.label}尚未啟用分析`);
    }
    const games = await fetchScheduleForLeague(targetLeague, targetDate);
    if (!games.length) {
      return { league: targetLeague, date: targetDate, tasks: [], preparedBoard: [], emptyReason: 'no_games' };
    }
    const creditRequestId = uid();
    const credit = await requestJSONWithTransientRetry('/api/credit-lines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': creditRequestId },
      body: JSON.stringify({ league: targetLeague, date: targetDate, schedule: games }),
    }, 60000);
    if (credit?.code === 'NO_PRESTART_GAMES') {
      return { league: targetLeague, date: targetDate, tasks: [], preparedBoard: [], emptyReason: 'no_games' };
    }
    if (credit?.blocked === true) {
      throw new Error(credit.message || `${config.label} Reader資料驗證未通過`);
    }
    const readerReady = credit?.provider === 'TAI888_READER_AUTO'
      && credit?.readerFresh === true
      && credit?.blocked !== true;
    const references = await fetchReferenceLines(games, targetDate, credit.games || []);
    const referenceByPk = new Map((references.games || [])
      .map(row => [Number(row.gamePk), row]));
    const openByPk = new Map((readerReady ? credit.games || [] : [])
      .map(row => [Number(row.gamePk), row]));
    const unopenedByPk = new Map((readerReady ? credit.unopenedGames || [] : [])
      .map(row => [Number(row.gamePk), row]));
    const readerByPk = new Map([...unopenedByPk, ...openByPk]);
    const cachedByPk = new Map(loadAnalysisBoardCache(targetLeague, targetDate)
      .map(item => [Number(item?.game?.gamePk), item]));
    const preparedBoard = games.map(game => {
      const readerGame = readerByPk.get(Number(game.gamePk));
      const hasOpenMarkets = Boolean(readerGame?.markets?.length);
      const hasPrevious = Boolean(cachedByPk.get(Number(game.gamePk))?.customData?.analysis);
      const unavailableReason = readerGame?.unavailableReason === 'not-rendered-by-reader'
        ? 'Reader目前未呈現盤口'
        : 'Tai888目前尚未開盤';
      return {
        game,
        mode: 'actual',
        actualSource: readerGame?.source || null,
        marketCoverage: readerGame?.marketCoverage || null,
        readerProvenance: readerGame?.readerProvenance || null,
        readerPayloadHash: null,
        customMarkets: [],
        verificationMarkets: referenceByPk.get(Number(game.gamePk))?.markets || [],
        status: hasOpenMarkets ? 'queued' : hasPrevious ? 'done' : 'unopened',
        statusLabel: hasOpenMarkets
          ? hasPrevious ? '四聯盟背景更新中｜保留目前分數' : '等待四聯盟背景分析'
          : hasPrevious ? `${unavailableReason}｜保留上一版分析` : `${unavailableReason}｜持續自動監看`,
        error: '',
      };
    });
    const tasks = games.flatMap(game => {
      const readerGame = openByPk.get(Number(game.gamePk));
      if (!readerGame?.markets?.length) return [];
      return [{
        game,
        actualMarkets: readerGame.markets,
        actualSource: readerGame.source,
        marketCoverage: readerGame.marketCoverage,
        readerProvenance: readerGame.readerProvenance,
        readerPayloadHash: credit.payloadHash,
        verificationMarkets: referenceByPk.get(Number(game.gamePk))?.markets || [],
      }];
    });
    return {
      league: targetLeague,
      date: targetDate,
      tasks,
      preparedBoard,
      emptyReason: tasks.length ? null : 'no_open_markets',
    };
  }

  async function oneClickAnalyzeAll() {
    if (readerPollBusyRef.current) {
      setNotice('Reader 正在自動複核最新盤口；複核完成後請再按一次「一鍵分析全部聯盟」。');
      return false;
    }
    if (allLeagueBusyRef.current || operationBusyRef.current || allLeagueRunning) {
      setNotice('目前已有分析工作進行中；完成後即可重新分析全部聯盟。');
      return false;
    }
    const targetDate = leagueDatesRef.current.MLB || date;
    const previousRun = loadAllLeagueAnalysisRun(targetDate) || allLeagueRun;
    if (previousRun?.runId) clearAllLeagueBackgroundJobs(previousRun);
    analysisGenerationRef.current += 1;
    restoredBoardNeedsValidationRef.current = false;
    allLeagueBusyRef.current = true;
    markAppOperationBusy(true);
    setAllLeaguePreparing(true);
    setError('');
    setNotice('正在並行預查四個聯盟的官方賽程與 Tai888 Reader 盤口。');
    let run = createAllLeagueAnalysisRun(targetDate);
    for (const id of LEAGUE_IDS) {
      run = updateAllLeagueAnalysisLeague(run, id, {
        status: 'preparing',
        boardDate: id === 'MLB' ? targetDate : (leagueDatesRef.current[id] || date),
        message: '並行預查官方賽程與Reader盤口',
      });
    }
    publishAllLeagueRun(run);
    const batches = [];
    try {
      const prepared = await Promise.all(LEAGUE_IDS.map(async id => {
        const selectedDate = id === 'MLB' ? targetDate : (leagueDatesRef.current[id] || date);
        const batchDate = await allLeagueTargetDate(id, selectedDate);
        clearBackgroundJob(id, batchDate);
        leagueDatesRef.current[id] = batchDate;
        manualAnalysisScopesRef.current.add(`${id}:${batchDate}`);
        try {
          const batch = await prepareAllLeagueBatch(id, batchDate);
          run = updateAllLeagueAnalysisLeague(run, id, {
            status: batch.emptyReason || 'queued',
            boardDate: batchDate,
            total: batch.tasks.length,
            completed: 0,
            blocked: 0,
            failed: 0,
            message: batch.emptyReason === 'no_games' ? '今日沒有賽前場次'
              : batch.emptyReason === 'no_open_markets' ? 'Reader持續等待開盤'
                : `已排入 ${batch.tasks.length} 場`,
          });
          publishAllLeagueRun(run);
          return { id, batchDate, batch };
        } catch (cause) {
          run = updateAllLeagueAnalysisLeague(run, id, {
            status: 'failed',
            boardDate: batchDate,
            message: String(cause?.message || cause),
          });
          publishAllLeagueRun(run);
          return { id, batchDate, cause };
        }
      }));
      for (const result of prepared) {
        if (result.batch) batches.push(result.batch);
      }
      if (!batches.length) {
        run = { ...run, state: 'completed', completedAt: new Date().toISOString() };
        publishAllLeagueRun(run);
        setError('四個聯盟的賽程或Reader預查都失敗；可切到個別聯盟重新執行。');
        return false;
      }
      const job = await startBackgroundAnalysisJob({
        mode: 'all-leagues',
        date: targetDate,
        batches: batches.map(batch => ({
          league: batch.league,
          date: batch.date,
          emptyReason: batch.emptyReason,
          tasks: batch.tasks,
        })),
      });
      run = {
        ...run,
        runId: job.runId,
        state: 'running',
      };
      let reconnectSaved = true;
      for (const batch of batches) {
        if (batch.tasks.length) {
          run = updateAllLeagueAnalysisLeague(run, batch.league, {
            status: 'running', message: `伺服器依序分析 ${batch.tasks.length} 場`,
          });
        }
        reconnectSaved = saveBackgroundJob({
          runId: job.runId,
          batchMode: 'all-leagues',
          league: batch.league,
          date: batch.date,
          total: batch.tasks.length,
          gamePks: batch.tasks.map(task => Number(task?.game?.gamePk)).filter(Number.isFinite),
          preparedBoard: batch.preparedBoard,
          startedAt: run.startedAt,
        }) && reconnectSaved;
      }
      publishAllLeagueRun(run);
      setBackgroundJobRevision(value => value + 1);
      const failedPreparations = LEAGUE_IDS.filter(id => run.leagues?.[id]?.status === 'failed').length;
      setNotice(reconnectSaved
        ? `四聯盟背景分析已開始${failedPreparations ? `；${failedPreparations}個聯盟預查失敗，可稍後單獨重試` : ''}。現在可以自由切換聯盟或離開App。`
        : '四聯盟背景分析已開始，但此裝置無法保存工作編號；完成前請保持 App 開啟。');
      return true;
    } catch (cause) {
      for (const id of LEAGUE_IDS) {
        if (['preparing', 'queued', 'running'].includes(run.leagues?.[id]?.status)) {
          run = updateAllLeagueAnalysisLeague(run, id, { status: 'failed', message: String(cause?.message || cause) });
        }
      }
      run = { ...run, state: 'completed', completedAt: new Date().toISOString() };
      publishAllLeagueRun(run);
      setError(`四聯盟背景工作未能送出：${String(cause?.message || cause)}；可切到個別聯盟重新執行。`);
      return false;
    } finally {
      allLeagueBusyRef.current = false;
      markAppOperationBusy(false);
      setAllLeaguePreparing(false);
    }
  }

  async function oneClickAnalyze(automaticKey = '', selectedGamePk = null) {
    if (allLeagueRunning) {
      setNotice('四聯盟背景分析正在進行；完成後即可重新分析目前聯盟。');
      return false;
    }
    if (readerPollBusyRef.current) {
      const queued = { league, date, gamePk: selectedGamePk };
      queuedAnalysisRef.current = queued;
      setQueuedAnalysis(queued);
      setError('');
      setNotice(`Reader 正在複核最新盤口；已排隊，複核完成後會自動開始 ${activeLeague.id} 分析。`);
      return true;
    }
    const savedBatchJob = loadBackgroundJob(league, date, boardRef.current);
    if (savedBatchJob?.runId && savedBatchJob?.batchMode === 'all-leagues') {
      setBackgroundJobRevision(value => value + 1);
      setNotice('這個聯盟已包含在四聯盟背景分析中；畫面會自動接續目前工作。');
      return false;
    }
    if (!analysisEnabled) {
      setError(`${activeLeague.label}尚未完成正式賽程與Reader驗證，目前不能分析。`);
      return false;
    }
    if (!acquireOperation()) return false;
    queuedAnalysisRef.current = null;
    setQueuedAnalysis(null);
    manualAnalysisScopesRef.current.add(`${league}:${date}`);
    restoredBoardNeedsValidationRef.current = false;
    const requestedAutoKey = typeof automaticKey === 'string' ? automaticKey : '';
    const targetDate = date;
    const generation = analysisGenerationRef.current;
    const previousByPk = new Map(boardRef.current.map(item => [Number(item.game.gamePk), item]));
    setError(''); setNotice(''); setTab('board');
    setBoard(current => current.map(item => (selectedGamePk == null || Number(item.game.gamePk) === Number(selectedGamePk)) && item.actualSource?.provider === 'TAI888_READER_AUTO'
      ? { ...item, readerPayloadHash: null, status: 'running', statusLabel: '後台重新驗證中｜保留目前分數｜停止下注', error: '' }
      : item));
    try {
      setProgress({ active: true, done: 0, running: 1, total: 1, label: `取得今日${activeLeague.shortLabel}賽事` });
      const officialGames = await fetchSchedule(targetDate);
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;
      const games = selectedGamePk == null ? officialGames : officialGames.filter(game => Number(game.gamePk) === Number(selectedGamePk));
      if (selectedGamePk != null && !games.length) throw new Error('選中的比賽已開賽、取消或不屬於目前日期；請重新讀取賽程。未啟動其他場次分析。');
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
      const credit = await requestJSONWithTransientRetry('/api/credit-lines', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() }, body: JSON.stringify({ league, date: targetDate, schedule: games }),
      }, 60000, { delaysMs: ANALYSIS_TRANSIENT_RETRY_DELAYS_MS });
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
        if (selectedGamePk != null) throw new Error('選中的比賽目前已無可分析的賽前盤口；未啟動其他場次分析。');
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
        setBoard(current => current.map(item => selectedGamePk != null && Number(item.game.gamePk) !== Number(selectedGamePk) ? item : markReaderBoardVerificationBlocked(item)));
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
          && previous?.customData?.pitPersistence?.confirmed === true
          ? advanceUnchangedReaderGame(previous, foundCredit.markets, credit.payloadHash, credit.pageActivityAt, Date.now(), {
            actualSource: foundCredit.source,
            marketCoverage: foundCredit.marketCoverage,
            readerProvenance: foundCredit.readerProvenance,
          })
          : null;
        const capturedHistoricalPit = !resumed
          && hasOpenRows
          && !coverageRegression
          && previous?.customData?.pitPersistence?.confirmed === true
          && foundCredit?.source?.provider === 'TAI888_READER_AUTO'
          && foundCredit?.readerProvenance?.provider === 'TAI888_READER_AUTO'
          && foundCredit.readerProvenance.payloadHash === credit.payloadHash
          && foundCredit.readerProvenance.boardDate === targetDate;
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
          actualSource: resumed?.actualSource || (capturedHistoricalPit ? foundCredit?.source : retainingPreviousRevision ? previous?.actualSource : foundCredit?.source) || previous?.actualSource || null,
          marketCoverage: retainingPreviousRevision ? previous?.marketCoverage || null : foundCredit?.marketCoverage || previous?.marketCoverage || null,
          latestMarketCoverage: waitingForReader || pendingReaderAnalysis ? currentMarketCoverage : null,
          latestReaderSource: waitingForReader || pendingReaderAnalysis ? foundCredit?.source || null : null,
          readerProvenance: capturedHistoricalPit ? foundCredit.readerProvenance : retainingPreviousRevision ? previous?.readerProvenance || null : foundCredit?.readerProvenance || previous?.readerProvenance || null,
          readerPayloadHash: resumed?.readerPayloadHash || (capturedHistoricalPit ? credit.payloadHash : null),
          customMarkets: resumed?.customMarkets || (capturedHistoricalPit ? foundCredit.markets : retainingPreviousRevision ? previous?.customMarkets || [] : represented ? foundCredit.markets || [] : previous?.customMarkets || []),
          verificationMarkets: retainingPreviousRevision ? previous?.verificationMarkets || [] : foundReference?.markets || [],
          referenceSource: retainingPreviousRevision ? previous?.referenceSource || null : foundReference?.source || previous?.referenceSource || null,
          status: resumed || capturedHistoricalPit || preservePreviousReaderAnalysis ? 'done' : represented && hasOpenRows ? 'queued' : 'unopened',
          statusLabel: represented
            ? resumed ? 'Tai888盤口未變｜接續完成'
              : capturedHistoricalPit ? 'Reader最新盤已驗證｜背景更新分析'
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
      const byStartTime = (left, right) => Date.parse(left?.game?.gameDate || '') - Date.parse(right?.game?.gameDate || '');
      const items = [
        ...activeItems.sort(byStartTime),
        ...(selectedGamePk != null ? [...previousByPk.values()].filter(item => Number(item.game.gamePk) !== Number(selectedGamePk)) : retainedFinishedItems).sort(byStartTime),
      ];
      setBoard(items);

      const tasks = items.map(item => {
        if (!activeGamePks.has(Number(item.game.gamePk))) return null;
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

      const backgroundResult = await runDurableAnalysisTasks(tasks, generation, targetDate, {
        progressLabel: selectedGamePk != null ? '分析選定單場比賽' : '分析本日全部盤口',
      });
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
        setError('Reader 最新盤面版本尚未完成驗證；請手動分析需要更新的場次，原始分數會保留。');
      } else {
        setNotice(`Reader讀取 ${coverage.captured}/${coverage.total} 場｜完成 ${completedCount} 場｜資料不足 ${blockedCount} 場${failedCount ? `｜暫時失敗 ${failedCount} 場` : ''}｜${coveragePendingText(coverage)}${sourceWarnings.length ? `｜提醒：${sourceWarnings.join('；')}` : ''}`);
        if (blockedCount) {
          setError(`${blockedCount} 場官方先發身分、左右投或獨立表現資料不足，QA 已停止評分；請按單場或「分析本日全部 ${activeLeague.id}」手動重驗。${failedCount ? `另有 ${failedCount} 場暫時分析失敗。` : ''}`);
        } else {
          const readerHashPending = Boolean(credit?.readerFresh && creditCount > 0 && failedCreditCount > 0);
          setError(`${failedCount} 場暫時分析失敗${readerHashPending ? '，Reader 最新盤面版本尚未承認' : ''}；已保留成功場次與上一版結果。`);
        }
      }
      return allSucceeded;
    } catch (cause) {
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;
      setBoard(current => current.map(item => (selectedGamePk == null || Number(item.game.gamePk) === Number(selectedGamePk)) && item.customData && ['running', 'queued'].includes(item.status)
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
      if (gameIsPrestartNow(item?.game, now) && readerAnalysisNeedsRevalidation(item)) return true;
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
    if (operationBusyRef.current || readerPollBusyRef.current || allLeagueBusyRef.current
      || allLeagueRunning || !boardRef.current.length) {
      if (boardRef.current.length) recordReaderPhase('等待其他工作完成', readerPollBusyRef.current ? '前次Reader複核仍在執行' : '分析工作占用中');
      return;
    }
    const targetDate = date;
    const generation = analysisGenerationRef.current;
    const stillCurrent = () => generation === analysisGenerationRef.current && currentDateRef.current === targetDate;
    readerPollBusyRef.current = true;
    markAppOperationBusy(true);
    setReaderPolling(true);
    recordReaderPhase('讀取Reader狀態');
    let fullSlateRecoveryNeeded = false;
    try {
      const status = await requestJSON(`/api/reader/status?league=${encodeURIComponent(league)}&date=${encodeURIComponent(targetDate)}&t=${Date.now()}`, {}, 20000);
      if (!stillCurrent()) return;
      commitReaderStatus(status);
      const currentStatus = readerStatusRef.current;
      const statusRevision = readerHashKey(targetDate, currentStatus?.payloadHash);
      const referenceRefreshDue = league === 'MLB'
        && Date.now() - Number(lastReferenceRefreshAtRef.current || 0) >= REFERENCE_REFRESH_INTERVAL_MS;
      if (!currentStatus?.fresh || !statusRevision) { recordReaderPhase('等待有效Reader資料'); return; }
      if (statusRevision === creditRevisionRef.current
        && !blockedReaderHashRecheckDue(currentStatus.payloadHash)
        && !readerBoardNeedsCoreRefresh()
        && !referenceRefreshDue
        && Date.now() - officialPrestartCheckedAtRef.current < OFFICIAL_PRESTART_RECHECK_MS) {
        setBoard(current => current.map(item => touchReaderHeartbeat(
          item,
          currentStatus.payloadHash,
          currentStatus.pageActivityAt,
        )));
        return;
      }
      // A restored card is an immutable historical snapshot, not today's
      // official request identity. Provider IDs may change as links appear or
      // disappear, so every credit verification uses a freshly fetched slate.
      recordReaderPhase('核對官方賽程');
      const games = await fetchSchedule(targetDate);
      if (!stillCurrent()) return;
      if (!games.length) {
        officialPrestartCheckedAtRef.current = Date.now();
        creditRevisionRef.current = '';
        setSchedule([]);
        setBoard(current => finalizeReaderBoardAtStart(current, Date.now(), { noPrestartGames: true }));
        setNotice('目前已無官方賽前場次；先前分析保留查閱，停止驗證新的下注盤口。');
        return;
      }
      recordReaderPhase('伺服器驗證盤口');
      const credit = await requestJSONWithTransientRetry('/api/credit-lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ league, date: targetDate, schedule: games }),
      }, 60000, { delaysMs: ANALYSIS_TRANSIENT_RETRY_DELAYS_MS });
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
        && !readerBoardNeedsCoreRefresh()
        && !referenceRefreshDue) {
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
      const boardPks = new Set(currentBoard.filter(item => !isHistoricalIdentityConflict(item)).map(item => Number(item.game.gamePk)));
      const missingReaderGameCount = [...readerGameByPk.keys()].filter(gamePk => !boardPks.has(gamePk)).length;
      if (missingReaderGameCount > 0) {
        fullSlateRecoveryNeeded = true;
        setNotice(`Reader有 ${readerGameByPk.size} 場、目前畫面缺少 ${missingReaderGameCount} 場；正在自動補齊完整賽程。`);
        return;
      }
      const expectedItems = currentBoard.filter(item => !isHistoricalIdentityConflict(item) && gameIsPrestartNow(item.game, Date.now())
        && (readerGameByPk.has(Number(item.game.gamePk)) || item.actualSource?.provider === 'TAI888_READER_AUTO'));
      let failed = 0;
      let blocked = 0;
      let completed = 0;
      let updated = 0;
      let removed = 0;
      const rebuildTasks = [];
      await runPool(currentBoard, 2, async item => {
        if (!stillCurrent()) return;
        if (isHistoricalIdentityConflict(item)) return;
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
        if (item.readerPayloadHash === credit.payloadHash && coreSnapshotReusable(item)
          && !readerAnalysisNeedsRevalidation(item)) {
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
          recordReaderPhase('重算已驗證盤口', String(item.game.gamePk));
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
          if (!stillCurrent()) return;
          const currentDirectItem = boardRef.current.find(current => (
            Number(current?.game?.gamePk) === Number(item.game.gamePk)
          )) || null;
          if (taskReaderStateIsStale(rebuildTask)
            || !directRepriceAuthorityMatches(currentDirectItem, rebuildTask)) {
            failed += 1;
            return;
          }
          if (Number(cause?.status) === 409 && cause?.code === 'CORE_REFRESH_REQUIRED') {
            // A server-confirmed expired or incompatible frozen core cannot
            // be repriced again. Rebuild from current sources through the
            // existing durable analysis path, preserving the prior display.
            snapshots.current.delete(item.game.gamePk);
            updateBoard(item.game.gamePk, current => !stillCurrent() ? current : ({
              ...current,
              readerPayloadHash: null,
              pendingReaderAnalysis: true,
              status: 'running',
              statusLabel: '資料或模型版本已更新｜重新取得資料中｜保留上一版分析',
              error: '',
            }));
            rebuildTasks.push(rebuildTask);
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
        markAppOperationBusy(true);
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
          if (stillCurrent()) setError(`伺服器背景重建暫時失敗：${String(cause?.message || cause)}；已保留上一版分數。`);
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
        setError(`${blocked}場官方先發身分、左右投或獨立表現資料不足，QA 已停止評分；請按單場或「分析本日全部 ${activeLeague.id}」手動重驗。${failed ? `另有 ${failed} 場盤口更新暫時失敗。` : ''}`);
      } else if (failed) {
        setError(`${failed}場盤口更新暫時失敗；已保留上一版分數，下次輪詢只重試暫時失敗場次。`);
      }
    } catch (cause) {
      if (stillCurrent()) { recordReaderPhase('複核失敗', String(cause?.message || cause)); invalidateReaderStatus(cause?.message || cause); }
    } finally {
      if (stillCurrent()) recordReaderPhase('本次複核結束', '是否可用仍依各場QA與盤口驗證結果');
      readerPollBusyRef.current = false;
      markAppOperationBusy(false);
      setReaderPolling(false);
      const queued = queuedAnalysisRef.current;
      const queuedForCurrentBoard = queued?.league === currentLeagueRef.current
        && queued?.date === currentDateRef.current;
      // Queued manual work is drained by the active render's effect. A
      // detached old poll must never consume another league's queued click.
      // Recovery is manual-only; never expand a refresh into full-slate analysis.
    }
  }

  async function recordBet(item, row) {
    if (isHistoricalIdentityConflict(item)) {
      setError('此分析屬於歷史場次識別，不能用來記錄目前 Reader 盤口。');
      return;
    }
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
    if (cloudLedgerStatus.state !== 'ready') {
      setError(cloudLedgerStatus.state === 'loading'
        ? '永久雲端帳本仍在同步；完成前不會送出下注紀錄'
        : '永久雲端帳本目前無法寫入；系統不會把未保存的下注顯示成成功');
      return;
    }
    if (cloudSyncBusyRef.current || cloudLedgerBusy) {
      setNotice('永久雲端帳本正在同步；完成後才能記錄下注。');
      return;
    }
    if (betMutationBusyRef.current) {
      setNotice('上一筆帳本操作仍在確認中，請稍候。');
      return;
    }
    const action = evaluateBetAction({
      item,
      row,
      now,
      betsEnabled: bettingEnabled,
      cloudLedgerState: 'ready',
      latest: state.latest,
      cancelled: state.cancelled,
      readerAuthority: liveReaderAuthority,
    });
    if (!action.recordable) {
      setError(action.title || '目前未通過實際下注記錄條件');
      return;
    }
    const identity = betIdentity(date, item.game.gamePk, row, league);
    const positionIdentity = betPositionIdentity(date, item.game.gamePk, row, league);
    const readerCapture = readerCaptureForBet(item, row, date);
    if (!readerCapture.payloadHash || !readerCapture.revision) {
      setError('目前 Reader 證據版本不一致；請先同步最新盤口再記錄下注');
      return;
    }
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
      readerPayloadHash: readerCapture.payloadHash,
      rawBoardHash: readerCapture.rawBoardHash,
      readerRevision: readerCapture.revision,
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
    let reconcileAfterMutation = false;
    let refreshReaderAfterMutation = false;
    betMutationBusyRef.current = true;
    setCloudLedgerBusy(true);
    markAppOperationBusy(true);
    try {
      const data = await requestJSON('/api/bets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'upsert', bet }) }, 30000);
      if (!Array.isArray(data.bets) || data.created !== true || !data.betId) {
        throw new Error('永久帳本未確認新增這筆下注');
      }
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
      refreshReaderAfterMutation = ['READER_CONTRACT_MISMATCH', 'READER_HASH_MISMATCH', 'READER_GAME_MISSING']
        .includes(String(cause?.code || ''));
      if (refreshReaderAfterMutation) {
        creditRevisionRef.current = '';
        setError('Tai888盤口已更新；請手動分析這一場或本日全部後再記錄。原分析分數會保留。');
      } else {
        setError(cause?.message || '雲端下注紀錄更新失敗');
      }
      reconcileAfterMutation = [409].includes(Number(cause?.status)) || /逾時/.test(String(cause?.message || ''));
    } finally {
      betMutationBusyRef.current = false;
      setCloudLedgerBusy(false);
      markAppOperationBusy(false);
    }
    if (reconcileAfterMutation) await probeCloudLedgerRecovery();
    // A failed bet must never implicitly start analysis or repricing.
  }

  async function cancelBet(bet) {
    if (!bet?.id || bet.status !== 'OPEN') return;
    if (!window.confirm(`確定取消這筆下注？\n${translateTeamText(bet.pick)}｜${waterText(bet.water)}`)) return;
    if (cloudLedgerStatus.state !== 'ready') {
      setError(cloudLedgerStatus.state === 'loading'
        ? '永久雲端帳本仍在同步；取消尚未送出'
        : '永久雲端帳本目前無法更新；取消尚未送出');
      return;
    }
    if (cloudSyncBusyRef.current || cloudLedgerBusy) {
      setNotice('永久雲端帳本正在同步；完成後才能取消下注。');
      return;
    }
    if (betMutationBusyRef.current) {
      setNotice('上一筆帳本操作仍在確認中，請稍候。');
      return;
    }
    let reconcileAfterMutation = false;
    betMutationBusyRef.current = true;
    setCloudLedgerBusy(true);
    markAppOperationBusy(true);
    try {
      const data = await requestJSON('/api/bets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', id: bet.id }),
      }, 30000);
      if (!Array.isArray(data.bets)) throw new Error('雲端下注紀錄回傳格式錯誤');
      betsRef.current = data.bets;
      setBets(data.bets);
      setCalibrationStatus(data.calibration || null);
      setCloudLedgerStatus({ state: 'ready', code: '', message: '' });
      setError('');
      setNotice(`已取消下注：${translateTeamText(bet.pick)}；原始下注證據仍保留。`);
    } catch (cause) {
      if (String(cause?.code || '').startsWith('DATABASE_') || Number(cause?.status) >= 500) {
        reportCloudLedgerFailure(cause);
      }
      setError(cause?.message || '取消下注失敗');
      reconcileAfterMutation = [409].includes(Number(cause?.status)) || /逾時/.test(String(cause?.message || ''));
    } finally {
      betMutationBusyRef.current = false;
      setCloudLedgerBusy(false);
      markAppOperationBusy(false);
    }
    if (reconcileAfterMutation) await probeCloudLedgerRecovery();
  }

  function selectLeague(value) {
    gamePickerRequestRef.current += 1;
    setGamePicker({ scope: '', games: [], selected: '', loading: false });
    const nextLeague = normalizeLeagueId(value);
    if (nextLeague === league) return;
    const nextDate = allLeagueBoardDate(allLeagueRun, nextLeague, leagueDatesRef.current[nextLeague] || date);
    // Analysis runs are durable server jobs. Switching the visible league only
    // detaches this screen from the old poll; it does not cancel the server run.
    // The saved job is reattached when the user returns to that league/date.
    if (operationBusyRef.current) {
      operationBusyRef.current = false;
      markAppOperationBusy(false);
      setBusy(false);
      setProgress(value => ({ ...value, active: false, running: 0 }));
    }
    queuedAnalysisRef.current = null;
    setQueuedAnalysis(null);
    currentLeagueRef.current = nextLeague;
    currentDateRef.current = nextDate;
    leagueDatesRef.current[nextLeague] = nextDate;
    analysisGenerationRef.current += 1;
    // Clear synchronously as well as in the league/date effect. Otherwise a
    // fast click can start the new league analysis with the previous league's
    // completed cards still present in boardRef.current.
    boardRef.current = [];
    setBoard([]);
    setSchedule([]);
    setError('');
    setNotice('');
    setTab('board');
    setLeague(nextLeague);
    if (nextDate !== date) setDate(nextDate);
  }

  return <main className="appShell">
    <header className="appHeader">
      <div><div className="eyebrow">BASEBALL DATA & BET LEDGER</div><h1>{activeLeague.label}｜盤口與實際下注系統</h1><p>每場使用一份聯盟專屬的凍結聯合比分分布，依Tai888實際盤口逐腿結算八個方向；前台以固定S分數為主，模型EV（W）與穩健EV（R）作次要診斷。Tai888與外部市場都不回灌模型概率。</p></div>
      <div className="headerBadges"><span className={health?.ready ? 'health ok' : 'health warn'}>{health == null ? '系統檢查中' : health.ready ? '必要設定已提供｜PIT寫入依逐場狀態' : `系統設定未完成｜${(health.readinessReasons || ['設定待確認'])[0]}`}</span><span className={`state ${activeLeague.status}`}>{activeLeague.statusLabel}</span><button type="button" className="appRefreshButton" title="重新整理並取得最新版" onClick={() => window.location.reload()}>↻ 更新</button><span className="version">v{VERSION}</span></div>
    </header>

    <nav className="leagueTabs" aria-label="聯盟切換">
      {LEAGUE_IDS.map(id => {
        const config = leagueConfig(id);
        const batchStatus = allLeagueBoardDate(allLeagueRun, id) === (leagueDatesRef.current[id] || date)
          ? allLeagueRun?.leagues?.[id]?.status || 'idle'
          : 'idle';
        return <button key={id} className={league === id ? 'active' : ''} onClick={() => selectLeague(id)} aria-pressed={league === id}>
          <span className={`leagueDot ${config.status} batch-${batchStatus}`}/><b>{id}</b><small>{config.shortLabel}{batchStatus !== 'idle' ? `｜${allLeagueStatusLabel(batchStatus)}` : ''}</small>
        </button>;
      })}
      <NbaEntry/>
      <Link prefetch={false} className="sportModuleLink" href="/nhl"><b>NHL</b><small>冰球資料與研究</small></Link>
      <Link prefetch={false} className="sportModuleLink" href="/external-audit"><b>外部來源</b><small>獨立稽核，不改評分</small></Link>
    </nav>

    <nav className="mainTabs">
      <button className={tab === 'board' ? 'active' : ''} onClick={() => setTab('board')}>今日盤口</button>
      <button className={tab === 'ranking' || tab === 'betOrder' ? 'active' : ''} onClick={() => setTab('ranking')}>影子排名</button>
      <button className={tab === 'bets' ? 'active' : ''} onClick={() => setTab('bets')}>下注紀錄</button>
      <button className={tab === 'scorePerformance' ? 'active' : ''} onClick={() => setTab('scorePerformance')}>分數績效</button>
      <button className={tab === 'performanceStats' ? 'active' : ''} onClick={() => setTab('performanceStats')}>績效統計</button>
      <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>設定</button>
    </nav>

    {error && <div className="errorBox global"><strong>發生問題</strong><span>{error}</span><button onClick={() => setError('')}>關閉</button></div>}
    {notice && <div className="noticeBox">{notice}</div>}
    <LoadingLine progress={progress}/>

    {tab === 'board' && <>
      <section className="heroCard">
        <div className="heroCopy"><span className="kicker">每日主要操作</span><h2>手動分析 {activeLeague.id}｜單場或本日全部</h2><p>只使用Reader同步的實際信用盤。比分分布與逐腿結算完整時，先顯示固定S分數，再列模型EV（W）與穩健EV（R）。市場差距與極高EV只作WARNING；資料、合約、分布、鏡像或結算等實質錯誤才會BLOCK。按下「紀錄實際下注」會由伺服器再次核對Reader與PIT證據，再永久保存當下盤口、水位與金額。</p></div>
        <div className="heroControls"><label>台灣日期<input type="date" value={date} disabled={busy || readerPolling || allLeaguePreparing || allLeagueRunning} onChange={event => selectAnalysisDate(event.target.value)}/></label><p className="muted">進站、重新整理及切換日期不會啟動分析；請手動選擇單場或本日全部。</p><button className="secondary" disabled={busy || allLeaguePreparing || allLeagueRunning || !analysisEnabled || (gamePicker.scope === `${league}:${date}` && gamePicker.loading)} onClick={loadGamePicker}>{gamePicker.scope === `${league}:${date}` && gamePicker.loading ? '讀取賽程中…' : '讀取賽程（不分析）'}</button><label>選擇單場比賽<select style={{ width: '100%', minWidth: 0, maxWidth: '100%' }} value={gamePicker.scope === `${league}:${date}` ? gamePicker.selected : ''} disabled={busy || allLeaguePreparing || allLeagueRunning || gamePicker.scope !== `${league}:${date}` || gamePicker.loading} onChange={event => setGamePicker(current => ({ ...current, selected: event.target.value }))}><option value="">請先讀取賽程並選擇一場</option>{gamePicker.scope === `${league}:${date}` && gamePicker.games.map(game => <option key={game.gamePk} value={game.gamePk}>{translateTeamText((typeof game.away === 'string' ? game.away : game.away?.name) || game.teams?.away?.team?.name || '')} @ {translateTeamText((typeof game.home === 'string' ? game.home : game.home?.name) || game.teams?.home?.team?.name || '')}｜{game.gameDate ? new Date(game.gameDate).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit' }) : ''}｜{game.gamePk}</option>)}</select></label><button className="primary" disabled={busy || allLeaguePreparing || allLeagueRunning || !analysisEnabled || gamePicker.scope !== `${league}:${date}` || !gamePicker.selected} onClick={() => oneClickAnalyze('', gamePicker.selected)}>只分析這一場</button><button className="primary giant" disabled={busy || allLeaguePreparing || allLeagueRunning || !analysisEnabled} onClick={() => oneClickAnalyze()}>{busy ? progress.label || '執行中…' : queuedAnalysis ? '已排隊｜複核後自動分析' : readerPolling ? 'Reader複核中｜按此排隊分析' : analysisEnabled ? `分析本日全部 ${activeLeague.id}` : `${activeLeague.id} 尚未啟用`}</button><button className="secondary allLeagueAnalyzeButton" disabled={busy || allLeaguePreparing || allLeagueRunning} onClick={() => oneClickAnalyzeAll()}>{allLeaguePreparing ? `預查四聯盟中 ${allLeaguePrechecked}/4` : allLeagueRunning ? '四聯盟伺服器背景處理中…' : allLeagueProgress.terminal === 4 ? '重新分析全部聯盟' : `一鍵分析全部聯盟 ${allLeagueProgress.terminal}/4`}</button>{(busy || readerPolling || queuedAnalysis) && <div className="heroActionStatus" role="status" aria-live="polite"><strong>{queuedAnalysis ? '分析已排隊' : busy ? progress.label || '分析正在啟動' : 'Reader 正在複核最新盤口'}</strong><span>{queuedAnalysis ? '複核完成後會自動開始，不必再按。' : busy ? progress.total > 0 ? `${progress.done || 0} 完成｜${progress.running || 0} 處理中｜${Math.max(0, progress.total - (progress.done || 0) - (progress.running || 0))} 排隊` : '請稍候，工作已開始。' : '可按上方按鈕先排隊，完成後自動分析。'}</span></div>}<a className="secondary readerDownload" href={READER_DOWNLOAD_PATH} download>下載目前穩定版 Reader v2.1.19</a><details className="details"><summary>Reader更新紀錄（本分頁）</summary><pre>{JSON.stringify(readerTrace.filter(row => row.league === league && row.date === date), null, 2)}</pre></details></div>
        <div className={`providerState ${analysisEnabled && readerExecutable ? 'ready' : 'missing'}`}>
          <strong>{!analysisEnabled ? `${activeLeague.label}獨立模型核心尚未發布` : readerExecutable ? 'Tai888 Reader自動同步正常｜目前畫面已驗證' : readerStatus?.fresh ? 'Tai888 Reader新盤已同步｜等待分析驗證' : readerStatus?.stale ? 'Tai888 Reader盤口已過期' : 'Tai888 Reader等待同步'}</strong>
          <span>{!analysisEnabled ? '官方賽程、Reader與實際下注帳本保留；核心先發、打線、純牛棚與球場資料未完整前不建立假分布或假EV。' : readerStatus?.fresh ? `最後同步：${localTime(readerStatus?.receivedAt)}｜Reader已讀取${readerCoverage.captured}/${readerCoverage.total}場｜已開盤${readerCoverage.open}場｜${readerPendingText}｜狀態自動更新，分析由手動啟動｜S分數、W與R完整顯示` : readerStatus?.message || `保持唯一一台讀盤電腦、Chrome與Tai888 ${activeLeague.shortLabel}頁面開啟。`}</span>
        </div>
        {allLeagueRunContainsDate(allLeagueRun, date) && <div className="allLeagueState" aria-live="polite"><div><strong>四聯盟分析 {allLeagueProgress.terminal}/4</strong><span>目前聯盟：{activeLeague.id}｜盤日 {date}｜{allLeagueStatusLabel(activeLeagueBatchStatus)}；各聯盟依 Reader 盤日分開保存。</span></div><div className="allLeaguePills">{LEAGUE_IDS.map(id => {
          const state = allLeagueRun?.leagues?.[id] || {};
          return <span className={`batch-${state.status || 'idle'}`} title={state.message || ''} key={id}>{id} {state.boardDate || '—'}｜{allLeagueStatusLabel(state.status)}</span>;
        })}</div>{LEAGUE_IDS.some(id => allLeagueRun?.leagues?.[id]?.status === 'failed') && <div className="allLeagueErrors">{LEAGUE_IDS.filter(id => allLeagueRun?.leagues?.[id]?.status === 'failed').map(id => <small key={id}>{id} {allLeagueRun.leagues[id].boardDate || '—'}：{allLeagueRun.leagues[id].message || '分析失敗'}</small>)}</div>}</div>}
      </section>
      {!analysisEnabled && <LeagueSetupPanel config={activeLeague}/>}
      {analysisEnabled && shadowMode && <LeagueShadowPanel config={activeLeague}/>}
      {analysisEnabled && !activeBoard.length && <section className="emptyBoard"><div>⚾</div><h2>尚未建立今日盤口</h2><p>按上方按鈕後，Reader已同步的Tai888信用盤會一次列出。</p></section>}
      {analysisEnabled && activeBoard.map(item => <GameCard key={`${league}-${item.game.gamePk}`} item={item} onBet={recordBet} onCancel={cancelBet} getBetState={getBetState} now={clockNow} betsEnabled={bettingEnabled} shadowMode={shadowMode} cloudLedgerState={cloudLedgerActionState} readerAuthority={liveReaderAuthority}/>) }
      {analysisEnabled && historicalIdentityBoard.length > 0 && <details className="panel historicalIdentityPanel">
        <summary>歷史識別衝突｜{historicalIdentityBoard.length} 場原始分析保留</summary>
        <p>官方最新清單使用另一個場次識別。以下原始分析僅供查閱，不列入今日盤口、影子排名或候選順序，也不能作為目前 Reader 的下注身分。原下注紀錄與 PIT 均保持原樣。</p>
        {historicalIdentityBoard.map(item => <div key={`historical-${league}-${item.game.gamePk}`} data-historical-identity={item.game.gamePk}>
          <div className="noticeBox">原場次 {item.game.gamePk}｜最新官方清單識別 {item.identityConflict.officialGamePk}｜歷史資料，不可建立新下注</div>
          <GameCard item={item} onBet={recordBet} onCancel={cancelBet} getBetState={getBetState} now={clockNow} betsEnabled={false} shadowMode={shadowMode} cloudLedgerState={cloudLedgerActionState} readerAuthority={{ ...liveReaderAuthority, fresh: false }}/>
        </div>)}
      </details>}
    </>}

    {tab === 'ranking' && <section className="panel" ref={rankingPanelRef}><div className="rankingViewTabs" aria-label="影子排名檢視"><button className="active" onClick={() => setTab('ranking')}>全部方向</button><button onClick={() => setTab('betOrder')}>影子候選順序</button></div><div className="panelHead"><h2>全部方向｜S分數由高到低</h2><span className="state shadow">全部顯示｜模型分析</span></div>
      <div className="emptySmall">此處顯示這一版Reader快照中已開盤且成功完成分析的全部方向，先依固定S分數由高到低排列，同分再依W、R排序；負EV、R≤0、QA BLOCK與低分方向都不刪除。市場差距與極高EV只顯示WARNING，不取消分數或排名。尚未開盤或市場資料錯誤的固定槽位保留在各場今日盤口，不能與其他時點、其他盤口快照混合比較。</div>
      <div className="emptySmall">盤日 {date}｜Reader覆蓋 {readerCoverage.captured}/{readerCoverage.total}場｜已開盤 {readerCoverage.open}場｜盤口雜湊 {readerStatus?.payloadHash ? String(readerStatus.payloadHash).slice(0, 12) : '—'}｜最晚盤口 {rankingProvenance.latestLineAsOf ? localTime(rankingProvenance.latestLineAsOf) : '—'}｜模型 {rankingProvenance.modelVersions.length ? rankingProvenance.modelVersions.join('、') : '—'}</div>
      {shadowRanking.length ? shadowRanking.map((entry, index) => {
        const betState = bettingEnabled ? getBetState(entry.item, entry.row) : { exact: null, latest: null, records: [] };
        const action = evaluateBetAction({ item: entry.item, row: entry.row, now: clockNow, betsEnabled: bettingEnabled, cloudLedgerState: cloudLedgerActionState, latest: betState.latest, cancelled: betState.cancelled, readerAuthority: liveReaderAuthority });
        const scoreText = entry.score == null ? '—' : entry.score.toFixed(1);
        const qaText = entry.qaPassed && entry.qualified ? 'PASS' : 'BLOCK';
        const warnings = diagnosticWarnings(entry.row);
        const icon = scoreIcon(entry.score, entry.qaPassed && entry.qualified);
        const status = entry.rankingEligible ? '排名資格：是' : !entry.qualified ? '排名資格：否｜模型QA未通過' : !entry.qaPassed ? '排名資格：否｜資料QA未通過' : `排名資格：否｜${entry.row?.rankingQualificationReason || '未達排名條件'}`;
        return <div className={`rankRow ${betState.latest ? 'betRecorded' : ''}`} data-rank-key={entry.stableKey} key={entry.stableKey}><b>{index + 1}</b><strong className={`rankScore ${entry.score != null && entry.score >= 8.5 ? 'strongest' : ''}`} title="固定S分數">{icon} {scoreText}</strong><div><span>{entry.matchup}｜{entry.market}｜{translateTeamText(entry.pick)}｜{waterText(entry.water)}</span><small>模型EV W {signedPct(entry.weightedEV)}｜穩健EV R {signedPct(entry.robustEV)}｜資料／數學 QA：{qaText}｜{status}</small>{warnings.map(warning => <small className="warningText" key={warning}>⚠️ {warning}</small>)}{entry.inactiveNotice && <small>實際下注紀錄狀態：{entry.inactiveNotice}</small>}</div><div className="rankActionStack"><button className={`mini ${action.kind === 'cancel' ? 'cancel' : betState.latest ? 'recorded' : action.recordable ? 'green' : 'unavailable'}`} disabled={action.disabled} title={action.title} onClick={() => action.kind === 'cancel' ? cancelBet(betState.latest) : recordBet(entry.item, entry.row)}>{action.text}</button>{betState.latest && <BetPriceComparison bet={betState.latest} currentRow={entry.row} game={entry.item.game}/>}</div></div>;
      }) : <div className="emptySmall">目前沒有已完成分析的Reader實際盤方向。</div>}
    </section>}

    {tab === 'betOrder' && <section className="panel" ref={rankingPanelRef}><div className="rankingViewTabs" aria-label="影子排名檢視"><button onClick={() => setTab('ranking')}>全部方向</button><button className="active" onClick={() => setTab('betOrder')}>影子候選順序</button></div><div className="panelHead"><h2>影子候選順序｜7.0分以上</h2><span className="state shadow">依開賽時間｜非推薦</span></div>
      <div className="emptySmall">先按比賽開始時間由早到晚，再於同場依序排列全場讓分、全場大小、上半讓分、上半大小；同一市場有多個7.0分以上方向時，分數較高者排前。已下注項目保留標記，時間未定賽事排在最後。</div>
      {shadowBetOrderGames.length ? shadowBetOrderGames.map((group, gameIndex) => <div className="betOrderGame" key={group.key}>
        <div className="betOrderGameHead"><div><span>第 {gameIndex + 1} 場</span><strong>{group.matchup}</strong></div><time>{localTime(group.gameDate)}</time></div>
        {group.entries.map(entry => {
          const betState = bettingEnabled ? getBetState(entry.item, entry.row) : { exact: null, latest: null, records: [] };
          const action = evaluateBetAction({ item: entry.item, row: entry.row, now: clockNow, betsEnabled: bettingEnabled, cloudLedgerState: cloudLedgerActionState, latest: betState.latest, cancelled: betState.cancelled, readerAuthority: liveReaderAuthority });
          const scoreText = entry.score.toFixed(1);
          const qaText = entry.qaPassed && entry.qualified ? 'PASS' : 'BLOCK';
          const warnings = diagnosticWarnings(entry.row);
          const icon = scoreIcon(entry.score, entry.qaPassed && entry.qualified);
          const status = entry.rankingEligible ? '排名資格：是' : !entry.qualified ? '排名資格：否｜模型QA未通過' : !entry.qaPassed ? '排名資格：否｜資料QA未通過' : `排名資格：否｜${entry.row?.rankingQualificationReason || '未達排名條件'}`;
          return <div className={`rankRow betOrderRow ${betState.latest ? 'betRecorded' : ''}`} data-rank-key={entry.stableKey} key={entry.stableKey}><b>{entry.betOrderIndex}</b><strong className={`rankScore ${entry.score >= 8.5 ? 'strongest' : ''}`} title="固定S分數">{icon} {scoreText}</strong><div><span>{entry.market}｜{translateTeamText(entry.pick)}｜{waterText(entry.water)}</span><small>模型EV W {signedPct(entry.weightedEV)}｜穩健EV R {signedPct(entry.robustEV)}｜資料／數學 QA：{qaText}｜{status}</small>{warnings.map(warning => <small className="warningText" key={warning}>⚠️ {warning}</small>)}{entry.inactiveNotice && <small>實際下注紀錄狀態：{entry.inactiveNotice}</small>}</div><button className={`mini ${action.kind === 'cancel' ? 'cancel' : betState.latest ? 'recorded' : action.recordable ? 'green' : 'unavailable'}`} disabled={action.disabled} title={action.title} onClick={() => action.kind === 'cancel' ? cancelBet(betState.latest) : recordBet(entry.item, entry.row)}>{action.text}</button></div>;
        })}
      </div>) : <div className="emptySmall">目前沒有公式分數達 {BET_ORDER_MIN_SCORE.toFixed(1)} 的Reader實際盤方向。</div>}
    </section>}

    {tab === 'bets' && <BetLedgerDashboard bets={bets} cloudLedgerStatus={cloudLedgerStatus} cloudLedgerBusy={cloudLedgerBusy} reportCloudLedgerFailure={reportCloudLedgerFailure} period={betPeriod} setPeriod={setBetPeriod} selectedLeague={betLeague} setSelectedLeague={setBetLeague} selectedMarket={betMarket} setSelectedMarket={setBetMarket} refreshSettlements={refreshSettlements} onCancel={cancelBet}/>}

    {tab === 'scorePerformance' && <ScorePerformanceDashboard bets={bets} cloudLedgerStatus={cloudLedgerStatus}/>}

    {tab === 'performanceStats' && <BetLedgerDashboard bets={bets} cloudLedgerStatus={cloudLedgerStatus} cloudLedgerBusy={cloudLedgerBusy} reportCloudLedgerFailure={reportCloudLedgerFailure} period={betPeriod} setPeriod={setBetPeriod} selectedLeague={betLeague} setSelectedLeague={setBetLeague} selectedMarket={betMarket} setSelectedMarket={setBetMarket} refreshSettlements={refreshSettlements} onCancel={cancelBet}/>}

    {tab === 'settings' && <section className="panel"><div className="panelHead"><h2>{activeLeague.label}｜設定</h2><span className={`state ${activeLeague.status}`}>{activeLeague.statusLabel}</span></div><div className="settingsGrid"><label>每筆實際下注金額<input type="number" value={settings.unitValue} min="100" step="100" onChange={event => setSettings(value => ({ ...value, unitValue: Number(event.target.value) || 10000 }))}/></label></div><div className="settingsNote"><b>模型：{activeLeague.modelFamily}</b><br/>每場正反方向、讓分大小、全場與上半場共用一份PIT凍結聯合比分分布；Tai888只提供待評估的成交盤口與水位，不改寫模型概率。前台固定以S分數為主，W與R為次要資訊；Tai888差距、外部市場方向與極高EV只作WARNING，不影響S或排名。只有資料、合約、比分分布、正反鏡像與逐腿結算等實質QA錯誤才會BLOCK。此金額只供實際下注帳本紀錄；帳本仍依台灣信用盤逐腿結算與每萬退150規則計算。</div></section>}

  </main>;
}
