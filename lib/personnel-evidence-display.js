// Read-only presentation of saved evidence; never updates PIT, model inputs or scores.
const finite = value => typeof value === 'number' && Number.isFinite(value);
const count = value => finite(value) && Number.isInteger(value) && value >= 0 ? value : null;
const list = value => Array.isArray(value) ? value : [];
const names = values => [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];

// Assignment evidence is separate from statistics. Legacy `observed` rows do
// not establish who was officially announced for this game.
export function assignmentEvidenceView(row = {}) {
  const status = row.assignmentEvidence?.status;
  const labels = { OFFICIAL_REPORTED: '官方回報', PROJECTED: '預估', MISSING: '缺失', UNVERIFIED: '未核對' };
  return {
    status: Object.hasOwn(labels, status) ? status : 'UNVERIFIED',
    label: labels[status] || '未核對',
    tone: { OFFICIAL_REPORTED: 'observed', PROJECTED: 'projected', MISSING: 'missing' }[status] || 'missing',
  };
}

export function measurementEvidenceView(row = {}) {
  const status = row.status === 'stale' ? 'stale' : row.measurementEvidence?.status || row.status;
  const labels = { observed: '已取得', projected: '含推估', missing: '缺失', stale: '舊資料' };
  return { status: Object.hasOwn(labels, status) ? status : 'missing', label: labels[status] || '未核對' };
}

export function personnelAssignmentSummary(audit = {}) {
  const counts = { OFFICIAL_REPORTED: 0, PROJECTED: 0, MISSING: 0, UNVERIFIED: 0 };
  for (const row of list(audit.rows).filter(row => ['starter', 'lineup'].includes(row.category))) counts[assignmentEvidenceView(row).status]++;
  return `官方回報 ${counts.OFFICIAL_REPORTED}・預估 ${counts.PROJECTED}・缺失 ${counts.MISSING}・未核對 ${counts.UNVERIFIED}`;
}

export function personnelNames(row = {}) {
  return names([...list(row.identity?.playerNames), ...list(row.players).map(player => player.name)]);
}

export function lineupOrderText(player = {}, league) {
  const order = player.battingOrder;
  if (order == null) return '棒次未保存';
  if (Number.isInteger(order) && order >= 1 && order <= 9) return `${order} 棒`;
  // MLB encodes original starters as 100..900; e.g. 101 is a substitute,
  // so it must not be silently promoted to the starting batting order.
  if (league === 'MLB' && Number.isInteger(order) && order >= 100 && order <= 900 && order % 100 === 0) return `${order / 100} 棒`;
  return '棒次未核對';
}

export function bullpenRosterView(row = {}) {
  const candidates = names(list(row.players).map(player => player.name || (player.id == null ? '' : String(player.id))));
  const historical = names(list(row.historicalUsage?.playerNames));
  return {
    candidates, historical,
    candidateLabel: candidates.length ? `保存投手名單 ${candidates.length} 人` : '未保存逐人投手名單',
    historyLabel: historical.length ? `歷史登板 ${historical.length} 人` : '未保存逐人歷史登板',
    completeness: row.coverage?.rosterComplete === true ? '來源名單完整' : row.coverage?.rosterComplete === false ? '來源名單未完整' : '名單完整性未保存',
    note: '保存名單與歷史登板不代表本場可出賽。',
  };
}

export function sourceLineageView(row = {}) {
  const comparison = row.sourceLineage?.parsedInputComparison;
  const compared = Array.isArray(comparison?.comparedFields) ? comparison.comparedFields.length : count(comparison?.comparedFields);
  const mismatches = list(comparison?.mismatches);
  const mismatchCount = count(comparison?.mismatches) ?? mismatches.length;
  if (mismatchCount > 0 || comparison?.status === 'CONFLICT') return '保存欄位有差異';
  if (compared > 0 && comparison?.status === 'TRANSFORMED_FIELDS_MATCH') return `保存欄位與轉換一致（${compared} 欄）`;
  if (compared > 0 && comparison?.status === 'SHARED_FIELDS_MATCH') return `保存欄位一致（${compared} 欄）`;
  return '保存欄位未核對';
}

export function umpireEvidenceView(audit = {}) {
  const row = list(audit.supportingData).find(item => item.key === 'umpire');
  if (!row) return { label: '主審未保存', tone: 'missing', name: null, effect: '效果使用未記錄', row: null };
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null;
  const statuses = [row.identityStatus, row.status].map(value => String(value || '').toUpperCase());
  const identityMissing = row.available === false || statuses.some(status => /MISSING|UNAVAILABLE|UNVERIFIED|UNKNOWN|REJECTED/.test(status));
  const projected = row.projected === true || statuses.some(status => /PROJECTED|FORECAST/.test(status));
  const reported = statuses.some(status => ['REPORTED', 'OBSERVED', 'CONFIRMED'].includes(status));
  return {
    label: !name || identityMissing ? '主審未確認' : projected ? '主審預估' : reported ? '主審已取得' : '主審未確認',
    tone: !name || identityMissing ? 'missing' : projected ? 'projected' : reported ? 'observed' : 'missing',
    name,
    effect: list(row.usage).some(item => item.usedInMean === true) ? '效果已用於得分中心' : list(row.usage).length && list(row.usage).every(item => item.usedInMean === false) ? '效果未用於得分中心' : '效果使用未記錄',
    row,
  };
}

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
