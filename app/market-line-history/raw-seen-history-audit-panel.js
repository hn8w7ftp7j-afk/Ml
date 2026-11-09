'use client';

import { taipeiHistoryTime } from './history-view.js';
import { useHistoryAuditRequest } from './history-audit-request.js';
import { auditInteger, auditInstant, auditHash, auditCode, auditText, auditNumber, auditReadonly } from './history-audit-validation.js';
import styles from './history-audit.module.css';

const endpoint = '/api/soccer/raw-seen-history-audit?limit=4';
const leagues = { EPL: '英超 EPL', UCL: '歐冠 UCL' };
const league = value => typeof value === 'string' && Object.hasOwn(leagues, value);
const nullableInteger = value => value === null || auditInteger(value);
const nullableCode = value => value === null || auditCode(value);
const partial = value => auditReadonly(value, undefined, false);

export function validateRawSeenHistoryAudit(value, expectedFilters = { league: null, limit: 4 }) {
  const invalid = () => { throw new Error('抽樣結果未通過核對'); };
  if (!expectedFilters || !(expectedFilters.league === null || league(expectedFilters.league))
    || !auditInteger(expectedFilters.limit) || expectedFilters.limit < 1 || expectedFilters.limit > 4
    || value?.ok !== true || value.schema !== 'soccer-raw-history-audit-v1' || !auditReadonly(value)
    || value.status !== 'BOUNDED_SAMPLE' || !auditInstant(value.until)
    || !value.filters || value.filters.league !== expectedFilters.league || value.filters.limit !== expectedFilters.limit
    || !Array.isArray(value.samples) || value.samples.length > expectedFilters.limit
    || value.sampleCompletenessVerified !== false || value.siblingCoverageVerified !== false
    || !value.budget || !auditInteger(value.budget.sourceBytesRead) || !auditInteger(value.budget.sourceBytesReserved)
    || value.budget.sourceBytesRead > value.budget.sourceBytesReserved
    || !auditInteger(value.budget.maxSourceBytes) || value.budget.sourceBytesReserved > value.budget.maxSourceBytes
    || value.budget.sourceByteBasis !== 'ORIGINAL_EVIDENCE_JSON_UTF8'
    || value.budget.maxSourceBytes < 1 || value.budget.maxSourceBytes > 10485760
    || !auditInteger(value.budget.timeBudgetMs) || value.budget.timeBudgetMs < 1 || value.budget.timeBudgetMs > 25000
    || value.budget.budgetKind !== 'SOFT_DEADLINE' || value.budget.hardDeadlineEnforced !== false) invalid();
  const samples = new Set();
  for (const sample of value.samples) {
    if (!league(sample?.league) || value.filters.league !== null && sample.league !== value.filters.league
      || !auditHash(sample.captureId) || !auditHash(sample.captureBatchId)
      || samples.has(sample.captureId) || !auditInstant(sample.sourceObservedAt) || !auditCode(sample.attemptReason)
      || !partial(sample) || !['VERIFIED_SOURCE', 'UNKNOWN'].includes(sample.status) || !nullableCode(sample.reason)
      || !['FLAT_TEXT_ONLY', 'STRUCTURED_ROWS', 'UNKNOWN'].includes(sample.classification)
      || !nullableInteger(sample.fragmentCount) || !nullableInteger(sample.rowCount) || !nullableInteger(sample.cellCount)
      || !Array.isArray(sample.fragmentManifest) || !Array.isArray(sample.headers) || !Array.isArray(sample.rowWidths)
      || typeof sample.headersTruncated !== 'boolean' || !Array.isArray(sample.siblings) || sample.siblings.length > 2
      || !['UNKNOWN', 'VERIFIED_METADATA_ONLY'].includes(sample.siblingStatus)
      || sample.siblingStatus === 'UNKNOWN' && sample.siblings.length !== 0
      || sample.siblingScopeBasis !== 'NEARBY_SAME_LEAGUE_READER_TIME_WINDOW'
      || sample.pageFrameVerified !== false || sample.sameCaptureVerified !== false) invalid();
    samples.add(sample.captureId);
    if (sample.status === 'UNKNOWN' && (sample.fragmentCount !== null || sample.rowCount !== null || sample.cellCount !== null
      || sample.classification !== 'UNKNOWN' || sample.fragmentManifest.length || sample.rowWidths.length || sample.reason === null)) invalid();
    if (sample.status === 'VERIFIED_SOURCE' && (!auditInteger(sample.fragmentCount) || sample.fragmentCount < 1
      || !auditInteger(sample.rowCount) || !auditInteger(sample.cellCount)
      || sample.fragmentManifest.length !== sample.fragmentCount || sample.reason !== null)) invalid();
    const fragments = new Set(), widths = new Set();
    for (const fragment of sample.fragmentManifest) {
      if (!auditHash(fragment?.captureId) || !auditHash(fragment.evidenceHash) || !partial(fragment)
        || fragments.has(fragment.captureId)
        || !auditInstant(fragment.receivedAt) || !auditInstant(fragment.persistedAt)
        || !nullableInteger(fragment.partIndex) || !nullableInteger(fragment.partCount)) invalid();
      fragments.add(fragment.captureId);
    }
    for (const header of sample.headers) {
      if (!header || !Array.isArray(header.values) || !header.values.every(auditText) || !auditInteger(header.tables) || header.tables < 1
        || !auditHash(header.contentHash) || typeof header.truncated !== 'boolean' || !partial(header)) invalid();
    }
    for (const width of sample.rowWidths) {
      if (!width || !auditInteger(width.cells) || !auditInteger(width.rows) || width.rows < 1 || widths.has(width.cells)) invalid();
      widths.add(width.cells);
    }
    if (sample.status === 'VERIFIED_SOURCE' && (sample.rowWidths.reduce((sum, width) => sum + width.rows, 0) !== sample.rowCount
      || sample.rowWidths.reduce((sum, width) => sum + width.rows * width.cells, 0) !== sample.cellCount)) invalid();
    const replay = sample.replay;
    if (!replay || !partial(replay) || !['RECOVERABLE', 'SOURCE_UNINDEXED', 'UNKNOWN'].includes(replay.status)
      || !nullableCode(replay.reason) || !nullableInteger(replay.gameCount) || !nullableInteger(replay.marketCount)
      || replay.status === 'UNKNOWN' && (replay.gameCount !== null || replay.marketCount !== null)
      || replay.status === 'SOURCE_UNINDEXED' && (replay.reason === null || replay.gameCount !== null || replay.marketCount !== null)
      || replay.status === 'RECOVERABLE' && (!auditInteger(replay.gameCount) || replay.gameCount < 1
        || !auditInteger(replay.marketCount) || replay.marketCount < 1 || replay.reason !== null)
      || sample.status === 'UNKNOWN' && replay.status !== 'UNKNOWN') invalid();
    for (const sibling of sample.siblings) {
      if (!sibling || !auditHash(sibling.captureId) || sibling.captureId === sample.captureId || !partial(sibling)
        || !auditInstant(sibling.observedAt) || !nullableInteger(sibling.rowCount) || !nullableInteger(sibling.cellCount)
        || !nullableInteger(sibling.partIndex) || !nullableInteger(sibling.partCount)) invalid();
    }
  }
  return value;
}

function replayText(replay) {
  if (replay.status === 'RECOVERABLE') return `可產生查閱內容：${auditNumber(replay.gameCount)} 場、${auditNumber(replay.marketCount)} 個盤口`;
  if (replay.status === 'SOURCE_UNINDEXED') return '本次仍未辨識出可查閱盤口';
  return '重播可用性：未確認';
}

export default function RawSeenHistoryAuditPanel() {
  const { data, busy, error, run } = useHistoryAuditRequest();
  const result = data.result;
  return <section className={`card ${styles.panel}`} aria-labelledby="raw-audit-title">
    <h2 id="raw-audit-title">尚未辨識來源抽查</h2>
    <p className={styles.notice}>每次最多抽查 4 筆已保存來源，核對原始表頭、列寬與重播可用性。這是抽樣，不代表所有來源或所有賽事已完整保存；不修改目前盤口。</p>
    <div className={styles.actions}><button type="button" disabled={Boolean(busy)} onClick={() => run(endpoint, validateRawSeenHistoryAudit)}>{busy ? '抽查中…' : '抽查尚未辨識來源'}</button></div>
    <div role="status" aria-live="polite">
      {error && <p className={styles.error}>{error}</p>}
      {!result && !busy && <p className={styles.meta}>抽查結果：未確認。</p>}
      {result && <>
        <p className={styles.meta}>本次返回 {result.samples.length} 筆樣本；查詢時間 {taipeiHistoryTime(result.until)}。全量覆蓋與尾盤仍未確認。</p>
        {result.samples.length === 0 && <p>本次沒有返回樣本，不能據此判定沒有缺漏。</p>}
        {result.samples.map((sample, index) => <article className={styles.sample} key={sample.captureId}>
          <h3>樣本 {index + 1} · {leagues[sample.league]} · {sample.status === 'UNKNOWN' ? '未確認' : sample.classification === 'FLAT_TEXT_ONLY' ? '僅有平面文字' : sample.classification === 'STRUCTURED_ROWS' ? '有結構化資料列' : '版面分類未確認'}</h3>
          <p className={styles.meta}>來源觀察時間 {taipeiHistoryTime(sample.sourceObservedAt)}；片段 {auditNumber(sample.fragmentCount)}、資料列 {auditNumber(sample.rowCount)}、儲存格 {auditNumber(sample.cellCount)}。</p>
          <p>重播：{replayText(sample.replay)}。{sample.status === 'UNKNOWN' && '本筆來源內容尚未完成核對。'}</p>
          <details><summary>查看原始表頭與列寬</summary>
            <p className={styles.meta}>保存識別：<code>{sample.captureId}</code></p>
            {sample.headers.length ? sample.headers.map((header, n) => <p key={`${header.contentHash}-${n}`} className={styles.strings}>表頭 {n + 1}（{auditNumber(header.tables)} 個表格）：<code>{header.values.join(' ｜ ')}</code>{header.truncated && '（部分顯示）'}</p>) : <p>{sample.status === 'UNKNOWN' ? '原始表頭：未確認' : '本次樣本未包含表頭'}</p>}
            {sample.headersTruncated && <p className={styles.meta}>表頭僅部分顯示，不能據此推定完整欄位。</p>}
            <p>{sample.rowWidths.length ? sample.rowWidths.map(row => `${auditNumber(row.cells)} 欄 × ${auditNumber(row.rows)} 列`).join('；') : sample.status === 'UNKNOWN' ? '列寬：未確認' : '本次未返回資料列列寬'}</p>
          </details>
          <details><summary>附近保存候選（{sample.siblingStatus === 'UNKNOWN' ? '未確認' : `${sample.siblings.length} 筆`}）</summary>
            <p className={styles.notice}>這些只是同聯盟、同 Reader 版本附近時間的其他批次候選。同次擷取與同一頁框皆未確認，不能替代本筆或作為完整覆蓋證明。</p>
            {sample.siblings.map(sibling => <p className={styles.meta} key={sibling.captureId}><code>{sibling.captureId}</code> · {taipeiHistoryTime(sibling.observedAt)} · 資料列 {auditNumber(sibling.rowCount)}、儲存格 {auditNumber(sibling.cellCount)}</p>)}
          </details>
        </article>)}
      </>}
    </div>
  </section>;
}
