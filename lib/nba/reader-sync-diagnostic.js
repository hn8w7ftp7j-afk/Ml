const messages = {
  'conflicting-duplicate-tabs': '不同 NBA 分頁的盤口不一致，Reader 已停止上傳。請只保留一個正確盤日的 NBA 標準盤分頁，再同步。',
  'conflicting-duplicate-frames': '同一分頁內的 NBA 盤口不一致。請重新整理該分頁，再同步。',
  'conflicting-duplicate-rows': '同場 NBA 盤口重複且數字不一致。請重新整理 NBA 標準盤，再同步。',
  TIMEOUT: 'NBA 盤口上傳逾時，請檢查 Reader 同步狀態。',
  NETWORK_ERROR: 'NBA 盤口上傳連線失敗，請檢查 Reader 同步狀態。',
};

// Historical evidence explains why a visible board stopped updating. It never
// changes quote freshness, analysis eligibility, or model/scoring rules.
export function nbaReaderSyncFailure(reports, { observedAt, now = Date.now() } = {}) {
  const observed = Date.parse(observedAt || '');
  if (!Array.isArray(reports) || !Number.isFinite(observed)) return null;
  const failures = reports.flatMap(report => {
    const at = Date.parse(report?.received_at || '');
    const row = report?.payload?.leagues?.NBA;
    if (!Number.isFinite(at) || at <= observed || at > now + 5000 || now - at > 86400000
      || row?.state !== 'error' || !messages[row.errorCode]) return [];
    return [{ code: row.errorCode, at: new Date(at).toISOString(), message: messages[row.errorCode] }];
  });
  return failures.sort((a, b) => b.at.localeCompare(a.at))[0] || null;
}
