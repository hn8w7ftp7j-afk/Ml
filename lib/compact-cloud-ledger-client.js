import { requireCloudLedgerResponse } from './cloud-ledger-receipt.js';

function invalidPage(message) {
  return Object.assign(new Error(message), { code: 'LEDGER_RESPONSE_INVALID' });
}

// A bounded readback contains updates, not evidence that older rows disappeared.
// Cancellation is an explicit stored status and replaces only the same ID.
export function mergeKnownLedgerRecords(previous = [], updates = []) {
  const records = new Map(previous.map(record => [record.id, record]));
  for (const record of updates) records.set(record.id, record);
  return [...records.values()].sort((left, right) => Date.parse(right.placedAt || 0) - Date.parse(left.placedAt || 0));
}

// Read-only keyset pagination. Never publish a partial page as the whole ledger,
// and never clear known records when a later page fails.
export async function loadCompactCloudLedger(requestJSON, { now = Date.now, budgetMs = 60000 } = {}) {
  const deadline = now() + budgetMs;
  const seenCursors = new Set();
  const records = new Map();
  let cursor = '';
  let invalidRecords = 0;
  let expectedTotal = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) throw Object.assign(new Error('帳本分頁讀取逾時；原有紀錄已保留。'), { code: 'REQUEST_TIMEOUT' });
    const url = `/api/bets?view=compact&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await requestJSON(url, {}, Math.min(15000, remaining));
    requireCloudLedgerResponse(page);
    const pagination = page.pagination;
    if (!pagination || typeof pagination.hasMore !== 'boolean'
      || !Number.isSafeInteger(pagination.totalRecords) || pagination.totalRecords < 0
      || !Number.isSafeInteger(pagination.returnedRecords) || pagination.returnedRecords !== page.bets.length
      || !Number.isSafeInteger(pagination.invalidRecordsOnPage) || pagination.invalidRecordsOnPage < 0) {
      throw invalidPage('帳本分頁資訊不完整；原有紀錄已保留。');
    }
    if (expectedTotal == null) expectedTotal = pagination.totalRecords;
    if (pagination.totalRecords !== expectedTotal) throw invalidPage('讀取期間帳本筆數已變更；請重新讀取，原有紀錄已保留。');
    for (const record of page.bets) {
      if (!record?.id || records.has(record.id)) throw invalidPage('帳本分頁出現重複或缺少識別的紀錄。');
      records.set(record.id, record);
    }
    invalidRecords += pagination.invalidRecordsOnPage;
    if (!pagination.hasMore) {
      if (records.size + invalidRecords !== expectedTotal) throw invalidPage('帳本讀取筆數與總數不一致；不會將部分資料視為全部。');
      return {
        ok: true,
        bets: [...records.values()],
        stats: null,
        calibration: null,
        statsScope: 'COMPLETE_COMPACT_READ',
        pagination: { ...pagination, invalidRecords, loadedRecords: records.size, pages: pageNumber + 1 },
      };
    }
    if (typeof pagination.nextCursor !== 'string' || !pagination.nextCursor || seenCursors.has(pagination.nextCursor)) {
      throw invalidPage('帳本分頁游標無效；原有紀錄已保留。');
    }
    cursor = pagination.nextCursor;
    seenCursors.add(cursor);
  }
  throw invalidPage('帳本超過本次完整讀取上限；不會將部分資料視為全部。');
}
