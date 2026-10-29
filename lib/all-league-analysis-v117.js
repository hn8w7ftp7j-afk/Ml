import { analysisGameIdentity, sameAnalysisGame } from './analysis-game-identity-v1.js';
import { ANALYSIS_LEAGUE_IDS, analysisLeagueId, analysisLeagueIdsForRun } from './analysis-leagues.js';
import { summarizeNbaBatchOutcome } from './nba/analysis-outcome.js';

export const ALL_LEAGUE_ANALYSIS_VERSION = 'ALL-LEAGUE-ANALYSIS-v11.7.0';

export const ALL_LEAGUE_TERMINAL_STATUSES = Object.freeze([
  'done',
  'partial',
  'failed',
  'no_games',
  'no_open_markets',
  'waiting_reader',
  'result_pending',
  'research',
  'insufficient_data',
]);

const terminalStatuses = new Set(ALL_LEAGUE_TERMINAL_STATUSES);
const cleanDate = value => String(value || '').trim();

function emptyLeagueState() {
  return { status: 'idle', boardDate: '', total: 0, completed: 0, blocked: 0, failed: 0, message: '' };
}

// A missing/expired Reader is an unmet prerequisite, not a failed model job.
// Classify only explicit Reader availability codes; identity/coverage errors
// and transport failures remain failures. No quote or execution gate changes.
export function allLeaguePreflightFailureState(error = {}) {
  const waiting = ['READER_NOT_SYNCED', 'READER_STALE'].includes(error.code);
  return {
    status: waiting ? 'waiting_reader' : 'failed',
    code: String(error.code || ''),
    stage: String(error.stage || 'preflight'),
    message: String(error.message || '此聯盟資料暫時無法取得，請稍後重試'),
  };
}

// Older saved jobs can carry the previous classification. Normalize their
// display without rewriting the receipt or replacing it with a live status.
export function allLeagueStateForDisplay(row = {}) {
  if (row.status === 'failed' && ['READER_NOT_SYNCED', 'READER_STALE'].includes(row.code)) {
    return { ...row, status: 'waiting_reader' };
  }
  if (row.status === 'no_open_markets' && ['waiting', 'missing', 'stale'].includes(row.readerStatus)) {
    return { ...row, status: 'waiting_reader', message: row.readerStatus === 'stale'
      ? 'Reader盤口已過期，等待重新同步' : '尚未收到此盤日的Reader盤口，等待同步' };
  }
  return row;
}

export function allLeagueBoardDate(run, league, fallback = '') {
  const id = analysisLeagueId(league);
  return cleanDate(run?.leagues?.[id]?.boardDate) || cleanDate(fallback) || cleanDate(run?.date);
}

export function allLeagueRunContainsDate(run, date) {
  const target = cleanDate(date);
  if (!run || !target) return false;
  return cleanDate(run.date) === target
    || analysisLeagueIdsForRun(run).some(league => cleanDate(run?.leagues?.[league]?.boardDate) === target);
}

export function createAllLeagueAnalysisRun(date, now = Date.now(), leagueIds = ANALYSIS_LEAGUE_IDS) {
  const selected = new Set(leagueIds);
  return {
    version: ALL_LEAGUE_ANALYSIS_VERSION,
    date: cleanDate(date),
    runId: '',
    state: 'preparing',
    startedAt: new Date(Number(now)).toISOString(),
    completedAt: null,
    leagues: Object.fromEntries(ANALYSIS_LEAGUE_IDS.filter(id => selected.has(id)).map(league => [league, emptyLeagueState()])),
  };
}

export function updateAllLeagueAnalysisLeague(run, league, patch = {}) {
  if (!run || typeof run !== 'object') return run;
  const id = analysisLeagueId(league);
  if (!id) return run;
  const current = run.leagues?.[id] || emptyLeagueState();
  return {
    ...run,
    leagues: {
      ...(run.leagues || {}),
      [id]: { ...current, ...patch },
    },
  };
}

export function allLeagueAnalysisProgress(run) {
  const rows = analysisLeagueIdsForRun(run).map(league => allLeagueStateForDisplay(run?.leagues?.[league] || emptyLeagueState()));
  return {
    total: rows.length,
    terminal: rows.filter(row => terminalStatuses.has(String(row?.status || ''))).length,
    running: rows.filter(row => ['preparing', 'queued', 'running'].includes(String(row?.status || ''))).length,
    succeeded: rows.filter(row => row?.status === 'done').length,
    research: rows.filter(row => row?.status === 'research').length,
    insufficient: rows.filter(row => row?.status === 'insufficient_data').length,
    partial: rows.filter(row => row?.status === 'partial').length,
    failed: rows.filter(row => row?.status === 'failed').length,
    waitingReader: rows.filter(row => row?.status === 'waiting_reader').length,
    skipped: rows.filter(row => ['no_games', 'no_open_markets'].includes(String(row?.status || ''))).length,
    resultPending: rows.filter(row => row?.status === 'result_pending').length,
    idle: rows.filter(row => !terminalStatuses.has(String(row?.status || ''))
      && !['preparing', 'queued', 'running'].includes(String(row?.status || ''))).length,
  };
}

// Finishing a workflow is not the same as successfully analysing every league.
// Keep failures, skipped slates and results still waiting for delivery explicit.
export function allLeagueAnalysisOutcomeText(progress) {
  return [
    ['成功', progress?.succeeded],
    ['研究完成', progress?.research],
    ['資料不足', progress?.insufficient],
    ['部分完成', progress?.partial],
    ['失敗', progress?.failed],
    ['等待同步', progress?.waitingReader],
    ['略過', progress?.skipped],
    ['結果待載入', progress?.resultPending],
    ['進行中', progress?.running],
    ['未開始', progress?.idle],
  ].filter(([, count]) => Number(count) > 0)
    .map(([label, count]) => `${label} ${count} 聯盟`).join('｜');
}

export function summarizeAllLeagueBatchResult(result) {
  if (result?.league === 'NBA') return summarizeNbaBatchOutcome(result);
  const rows = Array.isArray(result?.results) ? result.results : [];
  const total = Number.isFinite(Number(result?.total)) ? Number(result.total) : rows.length;
  const completed = rows.filter(row => row?.ok === true).length;
  const blocked = rows.filter(row => row?.ok !== true && (
    row?.blocked === true
    || row?.code === 'CORE_DATA_MISSING'
    || Number(row?.status) === 422
  )).length;
  const failed = Math.max(0, total - completed - blocked);
  const shadow = rows.some(row => row?.ok === true && row?.shadow === true);
  const soccer = ['EPL', 'UCL'].includes(result?.league);
  const status = total === 0
    ? result?.emptyReason === 'no_games' ? 'no_games' : 'no_open_markets'
    : soccer && completed === total && rows.every(row => row.research === true)
      ? 'research'
      : soccer && blocked === total ? 'insufficient_data'
      : failed === 0 && blocked === 0 && !shadow && completed === total
      ? 'done'
      : completed > 0 || blocked > 0
        ? 'partial'
        : 'failed';
  return { status, total, completed, blocked, failed };
}

export function mergePreparedLeagueBoard(currentBoard, preparedBoard, { replacePendingRevision = false } = {}) {
  const current = Array.isArray(currentBoard) ? currentBoard : [];
  const prepared = Array.isArray(preparedBoard) ? preparedBoard : [];
  const currentByPk = new Map(current
    .filter(item => Number.isFinite(Number(item?.game?.gamePk)))
    .map(item => [Number(item.game.gamePk), item]));
  const preparedPks = new Set();
  const merged = prepared.flatMap(item => {
    const gamePk = Number(item?.game?.gamePk);
    if (!Number.isFinite(gamePk)) return [];
    preparedPks.add(gamePk);
    const previous = currentByPk.get(gamePk);
    if (!previous) return [{ ...item }];
    const hasCompletedAnalysis = Boolean(previous?.customData?.analysis);
    return [{
      ...item,
      ...previous,
      game: item.game,
      ...(hasCompletedAnalysis ? {
        status: item.status === 'queued' ? 'running' : previous.status,
        statusLabel: item.status === 'queued'
          ? '四聯盟背景更新中｜保留目前分數'
          : previous.statusLabel,
      } : {}),
      // The displayed analysis retains its frozen Reader revision. A queued
      // refresh belongs to the newly prepared task, including after reload.
      ...(item.status === 'queued' && item.pendingReaderEvidenceHash ? {
        pendingReaderEvidenceHash: replacePendingRevision
          ? item.pendingReaderEvidenceHash
          : previous.pendingReaderEvidenceHash || item.pendingReaderEvidenceHash,
      } : {}),
    }];
  });
  const retained = current.filter(item => {
    const gamePk = Number(item?.game?.gamePk);
    return Number.isFinite(gamePk)
      && !preparedPks.has(gamePk)
      && Boolean(item?.customData?.analysis);
  });
  return [...retained, ...merged].sort((left, right) => (
    Date.parse(left?.game?.gameDate || '') - Date.parse(right?.game?.gameDate || '')
  ));
}

export function preserveCompletedReaderResult(previous, row, liveGame = null, compactPayload = null) {
  const task = row?.task || {};
  const payload = compactPayload || row?.payload;
  const taskGame = task?.game || previous?.game;
  if (taskGame?.gamePk && payload?.game?.gamePk && !sameAnalysisGame(taskGame, payload.game)) return previous || null;
  const game = analysisGameIdentity(taskGame, payload?.game);
  if (row?.ok !== true || !game?.gamePk || !payload?.analysis) return previous || null;
  const liveOpen = Boolean(liveGame?.markets?.length);
  return {
    ...(previous || {}),
    game,
    actualSource: task.actualSource || previous?.actualSource || null,
    marketCoverage: task.marketCoverage || previous?.marketCoverage || null,
    latestMarketCoverage: liveGame?.marketCoverage || null,
    latestReaderSource: liveGame?.source || null,
    latestReaderMarkets: liveGame?.markets || [],
    readerProvenance: task.readerProvenance || previous?.readerProvenance || null,
    readerPayloadHash: null,
    pendingReaderEvidenceHash: null,
    referenceData: payload,
    customData: payload,
    customMarkets: task.actualMarkets || previous?.customMarkets || [],
    verificationMarkets: task.verificationMarkets || previous?.verificationMarkets || [],
    restoredFromCache: false,
    analysisFailure: null,
    pendingReaderAnalysis: liveOpen,
    preservedCurrentReaderGame: true,
    readerWaitingHandled: !liveOpen,
    status: 'done',
    statusLabel: liveOpen
      ? 'Reader盤口已更新｜保留已完成分析｜等待重新計算'
      : 'Reader目前暫無盤口｜保留已完成分析｜停止下注',
    error: '',
  };
}

export function allLeagueStatusLabel(status) {
  const labels = {
    idle: '尚未執行',
    preparing: '準備資料',
    queued: '等待分析',
    running: '分析中',
    done: '已完成',
    research: '研究完成',
    insufficient_data: '資料不足',
    result_pending: '結果待載入',
    partial: '部分完成',
    failed: '失敗',
    no_games: '今日無賽事',
    no_open_markets: '等待開盤',
    waiting_reader: '等待盤口同步',
  };
  return labels[String(status || '')] || '尚未執行';
}

// Counters are display evidence only: never grant a completed analysis receipt.
export function applyAllLeagueLiveProgress(run, rows) {
  let next = run;
  for (const row of Array.isArray(rows) ? rows : []) {
    const current = next?.leagues?.[row?.league];
    if (!current || current.boardDate !== row.date || !['queued', 'running'].includes(current.status)) continue;
    const { total, settled, running, completed, failed } = row;
    if (![total, settled, running, completed, failed].every(Number.isSafeInteger)
      || total !== current.total || total <= 0 || settled < 0 || running < 0
      || completed < 0 || failed < 0 || settled > total || settled + running > total
      || completed + failed !== settled) continue;
    next = updateAllLeagueAnalysisLeague(next, row.league, {
      status: settled === total ? 'result_pending' : running > 0 ? 'running' : 'queued',
      completed, failed,
      message: `已處理 ${settled}/${total} 場｜成功 ${completed}｜未完成 ${failed}`
        + (settled === total ? '｜等待整批結果核對' : running ? `｜處理中 ${running}` : '｜排隊中'),
    });
  }
  return next;
}
