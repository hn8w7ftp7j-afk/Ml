import { LEAGUE_IDS, normalizeLeagueId } from './leagues.js';

export const ALL_LEAGUE_ANALYSIS_VERSION = 'ALL-LEAGUE-ANALYSIS-v11.7.0';

export const ALL_LEAGUE_TERMINAL_STATUSES = Object.freeze([
  'done',
  'partial',
  'failed',
  'no_games',
  'no_open_markets',
]);

const terminalStatuses = new Set(ALL_LEAGUE_TERMINAL_STATUSES);
const cleanDate = value => String(value || '').trim();

function emptyLeagueState() {
  return { status: 'idle', boardDate: '', total: 0, completed: 0, blocked: 0, failed: 0, message: '' };
}

export function allLeagueBoardDate(run, league, fallback = '') {
  const id = normalizeLeagueId(league);
  return cleanDate(run?.leagues?.[id]?.boardDate) || cleanDate(fallback) || cleanDate(run?.date);
}

export function allLeagueRunContainsDate(run, date) {
  const target = cleanDate(date);
  if (!run || !target) return false;
  return cleanDate(run.date) === target
    || LEAGUE_IDS.some(league => cleanDate(run?.leagues?.[league]?.boardDate) === target);
}

export function createAllLeagueAnalysisRun(date, now = Date.now()) {
  return {
    version: ALL_LEAGUE_ANALYSIS_VERSION,
    date: cleanDate(date),
    runId: '',
    state: 'preparing',
    startedAt: new Date(Number(now)).toISOString(),
    completedAt: null,
    leagues: Object.fromEntries(LEAGUE_IDS.map(league => [league, emptyLeagueState()])),
  };
}

export function updateAllLeagueAnalysisLeague(run, league, patch = {}) {
  if (!run || typeof run !== 'object') return run;
  const id = normalizeLeagueId(league);
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
  const rows = LEAGUE_IDS.map(league => run?.leagues?.[league] || emptyLeagueState());
  return {
    total: LEAGUE_IDS.length,
    terminal: rows.filter(row => terminalStatuses.has(String(row?.status || ''))).length,
    running: rows.filter(row => ['preparing', 'queued', 'running'].includes(String(row?.status || ''))).length,
    failed: rows.filter(row => row?.status === 'failed').length,
  };
}

export function summarizeAllLeagueBatchResult(result) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  const total = Number.isFinite(Number(result?.total)) ? Number(result.total) : rows.length;
  const completed = rows.filter(row => row?.ok === true).length;
  const blocked = rows.filter(row => row?.ok !== true && (
    row?.blocked === true
    || row?.code === 'CORE_DATA_MISSING'
    || Number(row?.status) === 422
  )).length;
  const failed = Math.max(0, total - completed - blocked);
  const status = total === 0
    ? result?.emptyReason === 'no_games' ? 'no_games' : 'no_open_markets'
    : failed === 0 && blocked === 0 && completed === total
      ? 'done'
      : completed > 0 || blocked > 0
        ? 'partial'
        : 'failed';
  return { status, total, completed, blocked, failed };
}

export function mergePreparedLeagueBoard(currentBoard, preparedBoard) {
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

export function allLeagueStatusLabel(status) {
  const labels = {
    idle: '尚未執行',
    preparing: '準備資料',
    queued: '等待分析',
    running: '分析中',
    done: '已完成',
    partial: '部分完成',
    failed: '失敗',
    no_games: '今日無賽事',
    no_open_markets: '等待開盤',
  };
  return labels[String(status || '')] || '尚未執行';
}
