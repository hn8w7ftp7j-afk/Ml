'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { taipeiHistoryTime } from './history-view.js';
import styles from './history.module.css';

const LEAGUES = ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'EPL', 'UCL'];
const LABELS = { EPL: '英超 EPL', UCL: '歐冠 UCL' };
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const validTime = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const timeText = value => value ? taipeiHistoryTime(value) : '尚無紀錄';

export function validateArchiveSummary(payload) {
  if (payload?.ok !== true || payload.schema !== 'READER-CAPTURE-ARCHIVE-v1'
    || payload.archiveOnly !== true || payload.currentBoardUpdated !== false
    || payload.historicalAvailabilityVerified !== false || payload.executable !== false
    || !Array.isArray(payload.leagues) || payload.leagues.length !== LEAGUES.length
    || new Set(payload.leagues.map(row => row?.league)).size !== LEAGUES.length
    || payload.leagues.some(row => !LEAGUES.includes(row?.league)
      || !Number.isSafeInteger(row.captureCount) || row.captureCount < 0
      || (row.captureCount === 0
        ? [row.firstBoardDate, row.lastBoardDate, row.lastObservedAt, row.lastPersistedAt].some(value => value !== null)
        : !validDate(row.firstBoardDate) || !validDate(row.lastBoardDate) || row.firstBoardDate > row.lastBoardDate
          || !validTime(row.lastObservedAt) || !validTime(row.lastPersistedAt)))) {
    throw new Error('補傳歸檔尚未確認，未當作零筆或完整保存。');
  }
  return payload;
}

export default function ArchivePanel() {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef({ sequence: 0, controller: null });

  const load = useCallback(async () => {
    const sequence = ++request.current.sequence;
    request.current.controller?.abort();
    const controller = new AbortController();
    request.current.controller = controller;
    setResult(null); setError(''); setBusy(true);
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('/api/reader/archive', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) throw new Error('補傳歸檔暫時無法讀取，未當作零筆。');
      validateArchiveSummary(payload);
      if (request.current.sequence === sequence) setResult(payload);
    } catch (cause) {
      if (request.current.sequence === sequence) setError(cause.name === 'AbortError' ? '補傳歸檔查詢逾時，請重新讀取。' : cause.message || '補傳歸檔尚未確認。');
    } finally {
      window.clearTimeout(timeout);
      if (request.current.sequence === sequence) setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => { ++request.current.sequence; request.current.controller?.abort(); };
  }, [load]);

  return <section className={`panel ${styles.coverage}`} aria-label="斷線補傳歸檔" aria-busy={busy}>
    <details className={styles.coverageGames}>
      <summary>斷線補傳歸檔{result ? `（${result.leagues.reduce((sum, row) => sum + row.captureCount, 0).toLocaleString('zh-TW')} 筆擷取）` : busy ? '｜核對中…' : '｜未確認'}</summary>
      <p className={styles.muted}>Reader 先在本機保存讀到的盤面，斷線後自動補傳。這裡另計擷取紀錄，不併入上方變盤版本，也不更新即時分析；原始觀測時間會保留。</p>
      <button type="button" className="secondary" disabled={busy} onClick={load}>{busy ? '核對中…' : '重新讀取補傳歸檔'}</button>
      {error && <p role="alert" className={styles.invalid}>{error}</p>}
      {busy && <p role="status" className={styles.muted}>正在核對補傳歸檔…</p>}
      {result && <div className={styles.tableWrap}><table>
        <caption>七聯盟獨立擷取歸檔；時間為台北時間</caption>
        <thead><tr><th scope="col">聯盟</th><th scope="col">擷取紀錄</th><th scope="col">盤日範圍</th><th scope="col">最後原始觀測</th><th scope="col">最後存入時間</th></tr></thead>
        <tbody>{LEAGUES.map(league => {
          const row = result.leagues.find(item => item.league === league);
          return <tr key={league}><th scope="row">{LABELS[league] || league}</th><td>{row.captureCount.toLocaleString('zh-TW')}</td><td>{row.captureCount ? `${row.firstBoardDate} ～ ${row.lastBoardDate}` : '尚無紀錄'}</td><td>{timeText(row.lastObservedAt)}</td><td>{timeText(row.lastPersistedAt)}</td></tr>;
        })}</tbody>
      </table></div>}
      <p className={styles.muted}>零筆表示尚未收到此類歸檔，不能判定未開盤。擷取筆數不等於場次或完整尾盤；這裡保存盤口資料，沒有原始畫面截圖。</p>
    </details>
  </section>;
}
