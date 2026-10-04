import { createHash } from 'node:crypto';
import { loadNbaData } from './data.js';
import { validDate, sourceId } from './identity.js';
import { loadNbaReaderSnapshot } from './reader-store.js';
import { nbaReaderPublicView } from './reader.js';
import { matchNbaReaderGame, nbaReaderDisplayStatus } from './reader-display.js';
import { analyzeNbaModel, NBA_ANALYSIS_MODEL_VERSION as NBA_ANALYSIS_VERSION } from './analysis-model.js';

const issue = (code, message) => ({ code, message });
export function validNbaAnalysisQuery({ date, id, observedAt }) {
  return validDate(date) && typeof id === 'string' && /^(?:nba:espn:game:)?[1-9]\d{0,11}$/.test(id)
    && typeof observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(observedAt)
    && Number.isFinite(Date.parse(observedAt));
}

// Inputs come from the authenticated Reader store and validated NBA schedule.
// The client supplies identities only; it cannot supply scores or model inputs.
export async function loadNbaAnalysis(query, options = {}) {
  const clock = options.now ?? Date.now;
  const now = () => Number(typeof clock === 'function' ? clock() : clock);
  const gameId = `nba:espn:game:${sourceId(query.id, 'game')}`;
  const common = { league: 'NBA', modelVersion: NBA_ANALYSIS_VERSION, gameId, date: query.date,
    observedAt: query.observedAt, executable: false, probabilityEstimate: null,
    strictPregameReplay: false, promotionEligible: false };
  const blocked = (code, message) => ({ ...common, status: 'blocked', generatedAt: new Date(now()).toISOString(), issues: [issue(code, message)] });
  const [schedule, snapshot] = await Promise.all([
    (options.loadSchedule ?? loadNbaData)({ view: 'schedule', date: query.date }),
    (options.loadReader ?? loadNbaReaderSnapshot)(query.date),
  ]);
  if (!snapshot || snapshot.boardDate !== query.date || snapshot.observedAt !== query.observedAt)
    return blocked('NBA_ANALYSIS_QUOTE_CHANGED', '盤口已更新或未同步；請重新讀取盤口後分析。');
  const board = nbaReaderPublicView(snapshot, { now: now(), boardDate: query.date });
  if (nbaReaderDisplayStatus(board, now()) !== 'fresh')
    return blocked('NBA_ANALYSIS_QUOTE_EXPIRED', '盤口已過期；請重新同步最新盤口。');
  if (schedule?.league !== 'NBA' || schedule?.status !== 'ready' || schedule?.qa?.status === 'BLOCK'
    || schedule.sources?.some(source => source.status === 'stale' || source.status === 'unavailable' && !source.recoveredBy))
    return blocked('NBA_ANALYSIS_SCHEDULE_UNVERIFIED', '賽程來源尚未完成核對，暫不分析。');
  const matches = snapshot.games.map(row => ({ row, match: matchNbaReaderGame(row, schedule) }))
    .filter(item => item.match.status === 'matched' && item.match.game?.id === gameId);
  if (matches.length !== 1) return blocked('NBA_ANALYSIS_GAME_UNVERIFIED', '此盤口無法唯一配對場次、主客隊與開賽時間。');
  const { row, match: { game } } = matches[0];
  const start = Date.parse(game.startTime || '');
  if (game.status !== 'scheduled' || game.completed || game.timeConfirmed !== true || !Number.isFinite(start) || start <= now())
    return blocked('NBA_ANALYSIS_GAME_STARTED', '此場已開賽、完賽或開賽時間未確認；不提供賽前分析。');
  if (row.marketStatus !== 'open' || !row.fullTotal)
    return blocked('NBA_ANALYSIS_TOTAL_UNAVAILABLE', '全場大小分已鎖盤或雙邊水位不完整。');
  const result = (options.analyzeModel ?? analyzeNbaModel)(game, row.fullTotal);
  const latestSnapshot = await (options.loadReader ?? loadNbaReaderSnapshot)(query.date);
  if (!latestSnapshot || latestSnapshot.observedAt !== snapshot.observedAt
    || latestSnapshot.clientPayloadHash !== snapshot.clientPayloadHash)
    return blocked('NBA_ANALYSIS_QUOTE_CHANGED', '分析期間盤口已更新，請重新讀取最新盤口。');
  // A request must not return a current result after its quote/game expired.
  if (start <= now() || nbaReaderDisplayStatus(board, now()) !== 'fresh')
    return blocked('NBA_ANALYSIS_EXPIRED_DURING_REQUEST', '分析期間比賽已開賽或盤口過期，請重新核對。');
  const quoteHash = createHash('sha256').update(JSON.stringify({ captureKey: row.captureKey, observedAt: snapshot.observedAt, fullTotal: row.fullTotal })).digest('hex');
  return { ...result, ...common, generatedAt: new Date(now()).toISOString(), captureKey: row.captureKey, quoteHash,
    source: { schedule: schedule.sources?.map(({ url, hash, fetchedAt }) => ({ url, hash, fetchedAt })) ?? [],
      quoteObservedAt: snapshot.observedAt, quotePageActivityAt: snapshot.pageActivityAt },
    quote: { ...row.fullTotal, period: 'full', market: 'total' },
    scope: 'NBA_full_game_total_only', unsupportedMarkets: ['fullRunline', 'firstHalfRunline', 'firstHalfTotal'] };
}
