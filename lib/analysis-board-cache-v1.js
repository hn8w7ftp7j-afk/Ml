const CACHE_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 72 * 60 * 60 * 1000;

const clean = value => String(value || '').trim();

export function analysisBoardCacheKey(league, date) {
  return `${clean(league).toUpperCase()}|||${clean(date)}`;
}

function compactAnalysisData(data) {
  if (!data?.analysis || !Array.isArray(data.analysis.results)) return null;
  return {
    game: data.game || null,
    openMarkets: Array.isArray(data.openMarkets) ? data.openMarkets : [],
    // Context and reprice snapshots are intentionally not persisted. They are
    // large, become stale quickly, and are rebuilt by background verification.
    analysis: data.analysis,
  };
}

export function compactAnalysisBoard(board) {
  return (Array.isArray(board) ? board : []).flatMap(item => {
    const customData = compactAnalysisData(item?.customData);
    if (!item?.game?.gamePk || !customData) return [];
    return [{
      game: item.game,
      mode: item.mode || 'actual',
      actualSource: item.actualSource || null,
      marketCoverage: item.marketCoverage || null,
      readerPayloadHash: item.readerPayloadHash || null,
      customMarkets: Array.isArray(item.customMarkets) ? item.customMarkets : [],
      verificationMarkets: Array.isArray(item.verificationMarkets) ? item.verificationMarkets : [],
      referenceSource: item.referenceSource || null,
      referenceData: compactAnalysisData(item.referenceData) || customData,
      customData,
      status: 'done',
      statusLabel: '已恢復上一版分析｜背景驗證中',
      error: '',
      restoredFromCache: true,
    }];
  });
}

export function createAnalysisBoardCacheEntry({ league, date, board, savedAt = Date.now() } = {}) {
  const compactBoard = compactAnalysisBoard(board);
  if (!compactBoard.length) return null;
  return {
    version: CACHE_VERSION,
    league: clean(league).toUpperCase(),
    date: clean(date),
    savedAt: new Date(Number(savedAt)).toISOString(),
    board: compactBoard,
  };
}

export function restoreAnalysisBoardCache(entry, { league, date, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (!entry || Number(entry.version) !== CACHE_VERSION) return [];
  if (entry.league !== clean(league).toUpperCase() || entry.date !== clean(date)) return [];
  const savedAt = Date.parse(entry.savedAt || '');
  const age = Number(now) - savedAt;
  if (!Number.isFinite(savedAt) || !Number.isFinite(age) || age < -5 * 60 * 1000 || age > Number(maxAgeMs)) return [];
  return compactAnalysisBoard(entry.board);
}

export function upsertAnalysisBoardCache(store, entry, maxEntries = 8) {
  const source = store && typeof store === 'object' && !Array.isArray(store) ? store : {};
  if (!entry) return source;
  const next = { ...source, [analysisBoardCacheKey(entry.league, entry.date)]: entry };
  return Object.fromEntries(Object.entries(next)
    .sort(([, left], [, right]) => Date.parse(right?.savedAt || 0) - Date.parse(left?.savedAt || 0))
    .slice(0, Math.max(1, Number(maxEntries) || 8)));
}
