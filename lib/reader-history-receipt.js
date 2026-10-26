import { buildMarketLineHistoryRows, marketLineHistoryDatabaseConfigured, recordMarketLineHistory } from './market-line-history-v1.js';
import { recordMarketCaptureReceipt } from './market-capture-receipts.js';

// An accepted current board is not evidence that its history was persisted.
// Call this before advancing the current-board authority (including heartbeats).
export async function requireReaderHistorySaved(snapshot, options = {}) {
  let historyTracking;
  try {
    historyTracking = await (options.record || recordMarketLineHistory)(snapshot);
  } catch (error) {
    console.error('[MARKET_LINE_HISTORY_WRITE_FAILED]', { league: snapshot?.league, boardDate: snapshot?.boardDate, code: String(error?.code || 'WRITE_FAILED').slice(0, 80) });
    historyTracking = { configured: marketLineHistoryDatabaseConfigured(), checked: buildMarketLineHistoryRows(snapshot).length, inserted: 0, unchanged: 0, failed: 1 };
  }
  if (!historyTracking?.configured || Number(historyTracking.failed) > 0) {
    const error = new Error('歷史盤口未確認保存，請重新同步');
    error.status = 503;
    error.code = 'MARKET_LINE_HISTORY_WRITE_FAILED';
    error.historyTracking = { ...historyTracking, failed: Math.max(1, Number(historyTracking?.failed) || 0) };
    throw error;
  }
  try {
    const captureReceipt = await (options.recordCapture || recordMarketCaptureReceipt)(snapshot);
    if (!captureReceipt?.configured || captureReceipt.persisted !== true) throw Error('MARKET_CAPTURE_RECEIPT_NOT_PERSISTED');
    historyTracking = { ...historyTracking, captureReceipt };
  } catch (cause) {
    console.error('[MARKET_CAPTURE_RECEIPT_WRITE_FAILED]', { league: snapshot?.league, boardDate: snapshot?.boardDate,
      code: String(cause?.code || cause?.message || 'WRITE_FAILED').slice(0, 80) });
    const error = new Error('讀盤保存回條未確認，請重新同步');
    error.status = 503;
    error.code = 'MARKET_CAPTURE_RECEIPT_WRITE_FAILED';
    error.historyTracking = { ...historyTracking, captureReceipt: { configured: marketLineHistoryDatabaseConfigured(), persisted: false } };
    throw error;
  }
  if (historyTracking.inserted > 0) console.info('[MARKET_LINE_HISTORY_SAVED]', {
    league: snapshot?.league, boardDate: snapshot?.boardDate,
    checked: historyTracking.checked, inserted: historyTracking.inserted, unchanged: historyTracking.unchanged,
  });
  return historyTracking;
}
