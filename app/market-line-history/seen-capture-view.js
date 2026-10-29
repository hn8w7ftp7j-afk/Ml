export const SEEN_CAPTURE_LEAGUES = Object.freeze(['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'NHL', 'EPL', 'UCL']);
const count = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullableTimestamp = value => value === null || timestamp(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function validateSeenCaptureResponse(payload, expectedLeague = '') {
  const expected = expectedLeague ? [expectedLeague] : SEEN_CAPTURE_LEAGUES;
  if (payload?.ok !== true || payload.status !== 'PASS' || payload.schema !== 'reader-seen-capture-inventory-v1'
    || payload.sourceTable !== 'sports_reader_seen_captures_v1' || payload.countUnit !== 'RAW_CAPTURE_OBSERVATIONS'
    || payload.archiveOnly !== true || payload.currentBoardUpdated !== false || payload.executable !== false
    || payload.coverageComplete !== false || payload.historicalAvailabilityVerified !== false
    || !Array.isArray(payload.leagues) || payload.leagues.length !== expected.length
    || new Set(payload.leagues.map(row => row?.league)).size !== expected.length
    || payload.leagues.some(row => !expected.includes(row?.league)
      || !['captureCount', 'tableCount', 'rowCount', 'lockedRowCount'].every(key => count(row[key]))
      || ['receivedPartGroups', 'completePartGroups', 'pendingPartGroups', 'conflictingPartGroups'].some(key => row[key] !== undefined && !count(row[key]))
      || row.lockedRowCount > row.rowCount
      || !['firstObservedAt', 'lastObservedAt', 'lastReceivedAt', 'lastPersistedAt'].every(key => nullableTimestamp(row[key])))
    || !Array.isArray(payload.recent) || payload.recent.length > 100
    || payload.recent.some(row => !expected.includes(row?.league) || !digest(row.captureId) || !digest(row.evidenceHash)
      || !timestamp(row.observedAt) || !nullableTimestamp(row.pageActivityAt) || !timestamp(row.receivedAt) || !timestamp(row.persistedAt)
      || !['tableCount', 'rowCount', 'cellCount', 'lockedRowCount'].every(key => count(row[key])) || row.lockedRowCount > row.rowCount
      || !Array.isArray(row.captureReasons) || row.captureReasons.some(reason => typeof reason !== 'string' || reason.length > 100)
      || (row.captureBatchId != null && (!digest(row.captureBatchId) || !count(row.partIndex) || !count(row.partCount) || row.partCount < 1 || row.partIndex >= row.partCount))
      || (row.captureBatchId == null && (row.partIndex != null || row.partCount != null))
      || ![true, false, null].includes(row.completeCapture) || row.status !== 'EVIDENCE_UNVERIFIED')) {
    throw new Error('原始盤面保存回應不完整，未當成成功或零筆。');
  }
  return payload;
}

export function validateSeenCaptureDetail(payload, expected) {
  const captured = payload?.capture, evidence = captured?.evidence;
  if (payload?.ok !== true || payload.schema !== 'READER-SEEN-CAPTURE-v1' || payload.archiveOnly !== true
    || payload.currentBoardUpdated !== false || payload.executable !== false || payload.coverageComplete !== false || payload.historicalAvailabilityVerified !== false
    || captured?.captureId !== expected.captureId || captured?.evidenceHash !== expected.evidenceHash || captured?.league !== expected.league
    || evidence?.league !== expected.league || evidence?.observedAt !== expected.observedAt
    || !Array.isArray(evidence?.tables) || evidence.tables.length > 128 || evidence.tables.some(table => !Array.isArray(table?.rows)
      || table.rows.length > 1000 || (table.headers !== undefined && (!Array.isArray(table.headers) || table.headers.some(value => typeof value !== 'string')))
      || table.rows.some(row => !Array.isArray(row?.cells) || row.cells.some(cell => !Array.isArray(cell?.pair) || cell.pair.some(value => typeof value !== 'string'))))) {
    throw new Error('原始保存文字與這筆觀測不一致，未當成已讀回。');
  }
  return evidence;
}

export function seenCaptureQueryUrl(league = '') {
  if (league && !SEEN_CAPTURE_LEAGUES.includes(league)) throw new Error('請選擇支援的聯盟。');
  const params = new URLSearchParams({ limit: '20' });
  if (league) params.set('league', league);
  return `/api/reader/seen-captures?${params}`;
}

// The server can only report the latest uploaded diagnostic snapshot. Never
// convert absent Chrome-local queue evidence into an empty/successful queue.
export function latestSeenDeliveryReports(reports) {
  if (!Array.isArray(reports)) throw new Error('Reader 狀態回應不完整。');
  const latest = new Map();
  for (const report of reports) {
    if (typeof report?.device_id !== 'string' || !timestamp(report.received_at) || !report.payload || typeof report.payload !== 'object') continue;
    const previous = latest.get(report.device_id);
    if (!previous || Date.parse(previous.received_at) < Date.parse(report.received_at)) latest.set(report.device_id, report);
  }
  return [...latest.values()].sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at)).slice(0, 5).map(report => {
    const raw = report.payload.seenCaptureDelivery;
    const available = raw && typeof raw === 'object' && ['sent', 'pending', 'error', 'idle'].includes(raw.state);
    const delivery = available ? { state: raw.state,
      ...Object.fromEntries(['pendingCount', 'pendingBytes', 'failedCaptureCount', 'savedCaptureCount'].map(key => [key, count(raw[key]) ? raw[key] : null])),
      code: typeof raw.code === 'string' && raw.code.length <= 100 ? raw.code : '',
      lastPersistedAt: timestamp(raw.lastPersistedAt) ? raw.lastPersistedAt : null } : null;
    return { deviceId: report.device_id, reportReceivedAt: report.received_at,
      reportCreatedAt: timestamp(report.payload.createdAt) ? report.payload.createdAt : null,
      readerVersion: typeof report.payload.readerVersion === 'string' ? report.payload.readerVersion : null, delivery };
  });
}

export const SEEN_CAPTURE_REASON_LABELS = Object.freeze({
  PRE_NORMALIZATION: '解析前保存', MUTATION: '盤面變動', SCAN: '巡查讀取', BEFORE_SELECTION: '來源篩選前保存', SOURCE_PARTIAL: '來源片段',
  PARSE_REJECTED: '未通過解析', PARSE_FAILED: '解析失敗', SELECTION_REJECTED: '未採用的來源',
  AUTHORITY_REJECTED: '來源未採用', NO_PARSED_GAMES: '尚未解析出場次',
  PARSER_ERROR: '解析異常', CONFLICTING_SOURCES: '來源盤面不一致', CAPTURE_TRUNCATED: '本次截取不完整',
});
