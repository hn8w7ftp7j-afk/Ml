import { validDate, taipeiDate } from './identity.js';
import { nbaReaderDisplayStatus } from './reader-display.js';
export function nbaLatestBoardDate(board, selected, now = Date.now()) {
  return validDate(selected) && nbaReaderDisplayStatus(board, now) === 'fresh' && validDate(board.boardDate)
    && board.boardDate >= selected && board.boardDate <= new Date(Date.parse(`${selected}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
    ? board.boardDate : selected;
}

// Date discovery is separate from quote eligibility: a stale Reader must not
// strand an automatic query on this morning's completed slate. Both entry
// points use the official board and still require fresh quotes for tasks.
export async function loadNbaUpcomingBoard({ selectedDate, manual = false, loadReader, loadBoard, now = Date.now() }) {
  if (!validDate(selectedDate)) throw new Error('NBA 日期無效');
  const today = taipeiDate(now);
  const selected = !manual && selectedDate < today ? today : selectedDate;
  const target = manual ? selected : nbaLatestBoardDate(await loadReader(), selected, now);
  const board = await loadBoard(target);
  if (manual || target !== today || board.emptyReason !== 'no_games') return board;
  const nextDate = new Date(Date.parse(`${target}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const next = await loadBoard(nextDate);
  return next.rows?.some(row => row.game?.league === 'NBA' && row.game.status === 'scheduled'
    && !row.game.completed && row.game.timeConfirmed === true
    && Number.isFinite(Date.parse(row.game.startTime))
    && taipeiDate(row.game.startTime) === nextDate && Date.parse(row.game.startTime) > now) ? next : board;
}
export function nbaCompletionSummary(batch) {
  const counts = { ready: 0, reference: 0, insufficient: 0, blocked: 0, failed: 0 };
  for (const row of batch?.results || []) counts[row.ok && ['ready', 'reference'].includes(row.payload?.status) ? row.payload.status : ['insufficient', 'blocked'].includes(row.payload?.status) ? row.payload.status : 'failed']++;
  return `NBA 已處理 ${batch?.results?.length || 0}/${batch?.total || 0} 場｜校正分析 ${counts.ready}｜跨季基準 ${counts.reference}｜資料不足 ${counts.insufficient}｜核對阻擋 ${counts.blocked}｜失敗 ${counts.failed}`;
}
