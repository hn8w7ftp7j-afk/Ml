// Read-only presentation of saved evidence; never updates PIT, model inputs or scores.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const count = value => finite(value) && Number.isInteger(value) && value >= 0 ? value : null;

export function splitEvidenceNote(row = {}) {
  if (row.category !== 'splits') return row.temporalNote || null;
  if (row.status === 'missing') return '左右投拆分未取得；缺值不代表實測中性能力。來源接入狀態另待查核。';
  if (row.status === 'observed') return '已取得拆分統計；統計截止日與賽前可得性須另行核對，不據此宣告歷史賽前拆分已驗證。';
  if (row.status === 'stale') return '左右投拆分已標示為舊資料；不能視為最新完整實測。';
  return '左右投拆分含推估或不完整資料；逐方向數值、來源與使用狀態請見明細。';
}

export function bullpenUsageText(row = {}) {
  const usage = row.coverage?.usage;
  if (!usage || typeof usage !== 'object') return '未保存逐場覆蓋證據；用球數取得狀態未記錄';
  const parts = [];
  if (count(usage.sampledGames) != null) parts.push(`後援局數樣本 ${usage.sampledGames} 場`);
  if (count(usage.completeGames) != null || count(usage.expectedGames) != null) {
    parts.push(`完整 ${count(usage.completeGames) ?? '未確認'}/${count(usage.expectedGames) ?? '未確認'} 場`);
  }
  if (count(usage.fetchedGames) != null) parts.push(`取得 ${usage.fetchedGames} 場`);
  if (!parts.length) parts.push('逐場覆蓋數未保存');
  parts.push(`完整性${usage.complete === true ? '已確認' : '未確認'}`);
  parts.push(usage.pitchCountsAvailable === true ? '用球數標記已取得' : usage.pitchCountsAvailable === false ? '用球數未取得' : '用球數取得狀態未記錄');
  if (usage.startDate || usage.endDate) parts.push(`樣本期間 ${usage.startDate || '未保存'} 至 ${usage.endDate || '未保存'}`);
  return parts.join('；');
}

export function inningsEvidenceView(row = {}) {
  const original = row.inningsEstimate || {};
  const metrics = row.metrics || {};
  const evidence = original.evidence || metrics.expectedInningsEvidence || null;
  const calculation = original.calculation || null;
  return {
    ...original,
    value: finite(original.value) ? original.value : metrics.expectedInnings ?? null,
    source: original.expectedInningsSource || metrics.expectedInningsSource || original.source || null,
    evidence,
    method: calculation?.branch || evidence?.method || null,
    sampleGames: count(original.sampleGames) ?? count(metrics.expectedInningsSampleGames),
    historyStatus: evidence || calculation ? '已保存推估依據，尚未獨立核驗' : '推估依據未保存',
    note: '預估局數不等於當場工作量已確認；樣本數只指此局數推估依據，不代表全部能力統計樣本。',
  };
}

export function featureTimeText(row = {}) {
  const state = { VERIFIED: '通過', PENDING: '證據不足', FAILED: '核對失敗' }[row.status] || '未記錄';
  const object = row.verificationObject === 'CONTEXT_DEFAULT_ONLY;NO_SOURCE_QUERY_EVIDENCE'
    ? '預設上下文（無此特徵來源查詢證據）'
    : row.verificationObject === 'BOUND_SOURCE_CONTENT_AND_ACQUISITION_TIMING'
      ? '綁定來源內容與取得時間' : '驗證對象未記錄';
  const mapping = row.mapping?.status === 'MAPPED_PATHS_PRESENT' ? '來源路徑存在，推導未重播' : '欄位映射證據不足';
  return `取得核對：${state}｜對象：${object}｜${mapping}｜欄位追溯：${row.fieldTraceabilityStatus || '未記錄'}`;
}

export function savedLeagueLimitations(audit) {
  return [...new Set((Array.isArray(audit?.leagueLimitations) ? audit.leagueLimitations : []).filter(note => typeof note === 'string' && note.trim()))];
}
