'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { taipeiHistoryTime } from './history-view.js';
import { SEEN_CAPTURE_LEAGUES, SEEN_CAPTURE_REASON_LABELS, latestSeenDeliveryReports, seenCaptureQueryUrl, validateSeenCaptureDetail, validateSeenCaptureResponse } from './seen-capture-view.js';
import styles from './seen-capture.module.css';

const LABELS = { NHL: '冰球 NHL', EPL: '英超 EPL', UCL: '歐冠 UCL' };
const countText = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-TW') : '未確認';
const timeText = value => value && Number.isFinite(Date.parse(value)) ? taipeiHistoryTime(value) : '未確認';
const DELIVERY_STATES = { sent: '回報無待補傳片段', pending: '等待補傳', error: '保存或補傳異常', idle: '尚無保存狀態' };
const DELIVERY_CODES = { QUEUE_FULL: '電腦待補傳空間已滿，請查看 Reader', LOCAL_SAVE_FAILED: '電腦保存失敗',
  PAIR_REQUIRED: 'Reader 需要配對', DEVICE_MISMATCH: '配對裝置不符', INVALID_RECEIPT: '伺服器回條未通過核對', RETRY_PENDING: '傳送未成功，等待重試',
  SEEN_UPLOAD_FAILED: '原始盤面補傳失敗，等待重試', SEEN_INVALID_RECEIPT: '原始盤面回條未通過核對', SEEN_LOCAL_SAVE_FAILED: '原始盤面本機保存失敗',
  SEEN_STORAGE_UNAVAILABLE: 'Reader 本機儲存暫時無法使用', SEEN_LOCAL_READBACK_FAILED: '原始盤面本機讀回未通過核對', SEEN_LOCAL_HASH_MISMATCH: '原始盤面待補傳內容待核對' };

function SeenCaptureEvidence({ capture }) {
  const [evidence, setEvidence] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const lifecycle = useRef({ mounted: true, controller: null });
  useEffect(() => {
    lifecycle.current.mounted = true;
    return () => { lifecycle.current.mounted = false; lifecycle.current.controller?.abort(); };
  }, []);
  async function readEvidence() {
    const controller = new AbortController(); lifecycle.current.controller = controller;
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/reader/seen-captures?captureId=${capture.captureId}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) throw new Error('這筆原始保存文字暫時無法讀取，請重試。');
      const saved = validateSeenCaptureDetail(payload, capture);
      if (lifecycle.current.mounted) setEvidence(saved);
    } catch (cause) {
      if (lifecycle.current.mounted) setError(cause.name === 'AbortError' ? '原始保存文字讀取逾時，請重試。' : cause.message || '保存文字讀取失敗。');
    } finally { window.clearTimeout(timeout); if (lifecycle.current.mounted) setBusy(false); }
  }
  return <div className={styles.evidence}>
    {!evidence && <button className="secondary" type="button" onClick={readEvidence} disabled={busy}>{busy ? '讀回保存文字…' : '查看這筆保存的盤面文字'}</button>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {evidence && <details open className={styles.details}><summary>原始保存的盤面文字</summary>
      <p className={styles.notice}>以下保留來源文字及排列；尚未代表隊伍配對、盤口解析或可分析資格已通過。</p>
      {evidence.pageLeagueLabel && <p>{evidence.pageLeagueLabel}</p>}
      {evidence.tables.length === 0 && <p className={styles.notice}>這筆保存沒有表格，可能只讀到聯盟標題，不能據此認定沒有開盤。</p>}
      <div className={styles.rawTables}>{evidence.tables.map((table, tableIndex) => <div key={tableIndex} className={styles.rawTable}>
        <h4>{table.sectionTitle || `來源表格 ${tableIndex + 1}`}</h4>
        <div className={styles.tableWrap}><table><caption>來源文字列；未換算成比賽場數</caption>
          {table.headers?.length > 0 && <thead><tr>{table.headers.map((header, index) => <th key={index} scope="col">{header}</th>)}</tr></thead>}
          <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.cells.map((cell, index) => <td key={index}>{cell.pair.join('\n')}</td>)}{row.marketLocked === true && <td>含鎖盤標記</td>}</tr>)}</tbody>
        </table></div>
      </div>)}</div>
    </details>}
  </div>;
}

export default function SeenCapturePanel() {
  const [result, setResult] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState(null), [diagnosticError, setDiagnosticError] = useState('');
  const request = useRef({ sequence: 0, controller: null });

  const load = useCallback(async (league = '') => {
    const sequence = ++request.current.sequence;
    request.current.controller?.abort();
    const controller = new AbortController(); request.current.controller = controller;
    setResult(null); setError(''); setBusy(true); setDiagnostics(null); setDiagnosticError('');
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    const current = () => request.current.sequence === sequence;
    // Independent requests keep a diagnostic outage from hiding saved captures.
    const inventory = async () => {
      try {
        const response = await fetch(seenCaptureQueryUrl(league), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        const payload = await response.json();
        if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || (payload?.code === 'READER_SEEN_CAPTURE_TABLE_NOT_READY'
          ? '原始盤面保存尚未啟用，不能當成零筆。' : '原始盤面保存暫時無法讀取，未當成零筆。'));
        validateSeenCaptureResponse(payload, league);
        if (current()) setResult(payload);
      } catch (cause) {
        if (current()) setError(cause.name === 'AbortError' ? '原始盤面查詢逾時，請重新查詢；未當成零筆。' : cause.message || '原始盤面保存讀取失敗。');
      }
    };
    const diagnosticSnapshots = async () => {
      try {
        const response = await fetch('/api/reader/diagnostics', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        const payload = await response.json();
        if (!response.ok || payload?.ok !== true) throw new Error('Reader 待補傳狀態暫時無法讀取；未確認電腦上的待補傳數量。');
        const reports = latestSeenDeliveryReports(payload.reports);
        if (current()) setDiagnostics(reports);
      } catch (cause) {
        if (current()) setDiagnosticError(cause.name === 'AbortError' ? 'Reader 狀態讀取逾時；未確認待補傳數量。' : cause.message || 'Reader 狀態讀取失敗。');
      }
    };
    try { await Promise.allSettled([inventory(), diagnosticSnapshots()]); }
    finally { window.clearTimeout(timeout); if (current()) setBusy(false); }
  }, []);

  useEffect(() => {
    load();
    return () => { ++request.current.sequence; request.current.controller?.abort(); };
  }, [load]);

  return <section className={`panel ${styles.panel}`} aria-label="讀到的原始盤面保存" aria-busy={busy}>
    <h2>讀到的原始盤面保存</h2>
    <p>保存 Reader 看見的盤面文字與結構。未配對、未通過解析或未採用的來源，也與可分析盤口分開保留。</p>
    <p className={styles.notice}>這裡的筆數是原始盤面觀測片段，不是場數、可分析盤口數或完整尾盤數。同一批來源可能分段保存。</p>
    <form className={styles.filters} onSubmit={event => {
      event.preventDefault(); load(String(new FormData(event.currentTarget).get('seen-league') || ''));
    }}>
      <label htmlFor="seen-league">原始盤面聯盟<select id="seen-league" name="seen-league" disabled={busy} defaultValue=""><option value="">八個聯盟</option>{SEEN_CAPTURE_LEAGUES.map(league => <option key={league} value={league}>{LABELS[league] || league}</option>)}</select></label>
      <button type="submit" className="secondary" disabled={busy}>{busy ? '核對中…' : '查詢原始保存與補傳狀態'}</button>
    </form>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {busy && <p role="status" className={styles.muted}>正在讀回已保存盤面與最近 Reader 回報…</p>}
    {result && <>
      <div className={styles.tableWrap}><table>
        <caption>正式資料庫已保存的原始盤面觀測（台北時間）</caption>
        <thead><tr><th scope="col">聯盟</th><th scope="col">保存片段／來源批次</th><th scope="col">分段收齊狀態</th><th scope="col">最後讀到來源</th><th scope="col">最後伺服器接收</th><th scope="col">最後存入</th></tr></thead>
        <tbody>{result.leagues.map(row => <tr key={row.league}><th scope="row">{LABELS[row.league] || row.league}</th><td>{countText(row.captureCount)} 筆／{countText(row.receivedPartGroups)} 批</td><td>{countText(row.completePartGroups)} 批段數收齊<br/><span className={styles.notice}>{countText(row.pendingPartGroups)} 批待補段／{countText(row.conflictingPartGroups)} 批有衝突</span></td><td>{timeText(row.lastObservedAt)}</td><td>{timeText(row.lastReceivedAt)}</td><td>{timeText(row.lastPersistedAt)}</td></tr>)}</tbody>
      </table></div>
      <p className={styles.muted}>「段數收齊」只表示該批來源宣告的片段已收到，不表示全部比賽、盤口或最後尾盤完整。</p>
      {result.leagues.every(row => row.captureCount === 0) && <p className={styles.notice}>此查詢尚未讀到已保存的原始盤面觀測，不能據此認定沒有開盤或沒有待補傳內容。</p>}
      <details className={styles.details}><summary>查看最近 {countText(result.recent.length)} 筆原始保存摘要</summary>
        {result.recent.length === 0 ? <p className={styles.muted}>尚無可列出的保存摘要。</p> : <ol className={styles.observations}>{result.recent.map(row => <li key={row.captureId}>
          <strong>{LABELS[row.league] || row.league}｜來源讀取 {timeText(row.observedAt)}</strong>
          <p>{countText(row.tableCount)} 個表格／{countText(row.rowCount)} 列文字／{countText(row.lockedRowCount)} 列含鎖盤標記<span className={styles.muted}>（文字列數不等於比賽場數）</span></p>
          <p className={styles.muted}>Reader {row.readerVersion || '版本未確認'}｜接收 {timeText(row.receivedAt)}｜存入 {timeText(row.persistedAt)}</p>
          {row.captureBatchId && <p className={styles.muted}>同批來源第 {countText(row.partIndex + 1)}／{countText(row.partCount)} 段</p>}
          <p className={styles.notice}>{row.completeCapture === true ? '本次截取標示完整，尚未驗證全部賽程或盤口。' : row.completeCapture === false ? '本次截取可能不完整；原始內容仍保留。' : '本次截取的完整程度未確認。'} 盤口證據待驗證。</p>
          {row.captureReasons.length > 0 && <p>擷取註記：{row.captureReasons.map(reason => SEEN_CAPTURE_REASON_LABELS[reason] || reason).join('、')}</p>}
          <small className={styles.id}>保存識別 {row.captureId}</small>
          <SeenCaptureEvidence capture={row}/>
        </li>)}</ol>}
      </details>
    </>}
    <div className={styles.delivery} aria-label="Reader 最近回報的待補傳狀態">
      <h3>Reader 最近回報的待補傳狀態</h3>
      <p className={styles.muted}>這是最近已上傳的狀態快照，並非電腦目前的即時佇列。沒有回報時，數量保持未確認。</p>
      {diagnosticError && <p role="alert" className={styles.error}>{diagnosticError}</p>}
      {diagnostics?.length === 0 && <p className={styles.notice}>尚未收到 Reader 的狀態回報，待補傳數量未確認。</p>}
      {diagnostics?.map(row => <div className={styles.device} key={row.deviceId}>
        <strong>Reader {row.readerVersion || '版本未確認'}<span className={styles.muted}>｜裝置 …{row.deviceId.slice(-6)}</span></strong>
        <p className={styles.muted}>最近狀態產生 {timeText(row.reportCreatedAt)}｜伺服器收到 {timeText(row.reportReceivedAt)}</p>
        {!row.delivery ? <p className={styles.notice}>此份回報未包含原始盤面補傳狀態；待補傳數量未確認。</p> : <>
          <p className={row.delivery.state === 'error' || row.delivery.failedCaptureCount > 0 ? styles.error : styles.notice}>{row.delivery.state === 'sent' && row.delivery.pendingCount !== 0 ? '補傳狀態待核對' : DELIVERY_STATES[row.delivery.state]}｜待補傳 {countText(row.delivery.pendingCount)} 筆</p>
          {row.delivery.failedCaptureCount > 0 && <p className={styles.error}>Reader 回報保存或補傳異常，不能視為全部保存成功。</p>}
          {row.delivery.code && <p className={styles.notice}>{DELIVERY_CODES[row.delivery.code] || row.delivery.code}</p>}
          <p className={styles.muted}>最近回條存入 {timeText(row.delivery.lastPersistedAt)}</p>
        </>}
      </div>)}
    </div>
    <p className={styles.muted}>本項原始盤面另外計數，不合併下方既有盤口版本。已存原始盤面不代表已取得可分析盤口；下方仍分別核對配對後的市場、變盤與尾盤完整性。</p>
  </section>;
}
