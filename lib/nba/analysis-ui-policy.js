import { validDate } from './identity.js';
import { nbaReaderDisplayStatus } from './reader-display.js';
export function nbaLatestBoardDate(board, selected, now = Date.now()) {
  return validDate(selected) && nbaReaderDisplayStatus(board, now) === 'fresh' && validDate(board.boardDate)
    && board.boardDate >= selected && board.boardDate <= new Date(Date.parse(`${selected}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
    ? board.boardDate : selected;
}
export function nbaCompletionSummary(batch) {
  const counts = { ready: 0, reference: 0, insufficient: 0, blocked: 0, failed: 0 };
  for (const row of batch?.results || []) counts[row.ok && ['ready', 'reference'].includes(row.payload?.status) ? row.payload.status : ['insufficient', 'blocked'].includes(row.payload?.status) ? row.payload.status : 'failed']++;
  return `NBA 已處理 ${batch?.results?.length || 0}/${batch?.total || 0} 場｜校正分析 ${counts.ready}｜跨季基準 ${counts.reference}｜資料不足 ${counts.insufficient}｜核對阻擋 ${counts.blocked}｜失敗 ${counts.failed}`;
}
