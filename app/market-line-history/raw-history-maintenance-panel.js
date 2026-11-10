'use client';

import { useEffect, useRef, useState } from 'react';
import { taipeiHistoryTime } from './history-view.js';
import styles from './raw-history-maintenance.module.css';

const endpoint = '/api/soccer/raw-seen-history-maintenance';
const schema = 'soccer-raw-history-maintenance-v1';
const countKeys = ['sourceFragments', 'sourceBatches', 'indexedBatches', 'previousReadableIndexedBatches', 'unindexedBatches', 'stableAttemptBatches', 'retryPendingBatches', 'indexedGames'];
const leagueNames = { EPL: '英超 EPL', UCL: '歐冠 UCL' };
const league = value => typeof value === 'string' && Object.hasOwn(leagueNames, value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const instant = value => typeof value === 'string' && day(value.slice(0, 10))
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}(?:\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const safeCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(value);
const readonly = value => value?.archiveOnly === true && value.currentBoardUpdated === false
  && value.historicalAvailabilityVerified === false && value.executable === false
  && value.formalEligible === false && value.calibrationEligible === false
  && value.coverageComplete === false && value.closingCoverage === 'NOT_VERIFIED'
  && value.indexCoverage === 'NOT_VERIFIED' && (!Object.hasOwn(value, 'identityVerified') || value.identityVerified === false);
const noContradictoryFlags = value => Object.entries({ archiveOnly: true, currentBoardUpdated: false,
  historicalAvailabilityVerified: false, executable: false, formalEligible: false, calibrationEligible: false,
  coverageComplete: false, closingCoverage: 'NOT_VERIFIED', indexCoverage: 'NOT_VERIFIED', identityVerified: false })
  .every(([key, expected]) => !Object.hasOwn(value, key) || value[key] === expected);
const validCounts = value => value && countKeys.every(key => integer(value[key]))
  && value.sourceFragments >= value.sourceBatches
  && value.sourceBatches === value.indexedBatches + value.unindexedBatches
  && value.unindexedBatches === value.stableAttemptBatches + value.retryPendingBatches
  && value.previousReadableIndexedBatches <= value.unindexedBatches
  && (value.indexedBatches === 0 ? value.indexedGames === 0 : value.indexedGames >= value.indexedBatches);
const sumMatches = (values, total) => countKeys.every(key => values.reduce((sum, value) => sum + value[key], 0) === total[key]);
const number = value => integer(value) ? value.toLocaleString('zh-TW') : '未確認';

export function validateRawHistoryMaintenanceProgress(value) {
  const invalid = () => { throw new Error('整理進度未通過核對，數量仍為未確認。'); };
  if (value?.ok !== true || value.schema !== schema || !readonly(value) || !instant(value.until)
    || value.countUnit !== 'CANONICAL_SOURCE_BATCHES' || value.dateBasis !== 'SOURCE_OBSERVATION_TAIPEI_DATE'
    || value.dateBucketBasis !== 'EARLIEST_SOURCE_OBSERVATION_OF_BATCH'
    || typeof value.derivationVersion !== 'string' || !value.derivationVersion || value.derivationVersion.length > 100
    || !['PENDING', 'NO_PENDING_SOURCE', 'SOURCE_UNINDEXED', 'NOT_INITIALIZED'].includes(value.status)
    || !Array.isArray(value.leagues) || value.leagues.length !== 2
    || new Set(value.leagues.map(row => row?.league)).size !== 2) invalid();
  if (value.status === 'NOT_INITIALIZED') {
    if (value.counts !== null || value.leagues.some(row => !league(row?.league) || !noContradictoryFlags(row) || row.counts !== null
      || !Array.isArray(row.days) || row.days.length || !Array.isArray(row.reasons) || row.reasons.length)) invalid();
    return value;
  }
  if (!validCounts(value.counts)) invalid();
  for (const row of value.leagues) {
    if (!league(row?.league) || !noContradictoryFlags(row) || !validCounts(row.counts) || !Array.isArray(row.days) || !Array.isArray(row.reasons)) invalid();
    const dates = new Set(), reasons = new Set();
    for (const bucket of row.days) {
      if (!day(bucket?.sourceDate) || !noContradictoryFlags(bucket) || dates.has(bucket.sourceDate) || !validCounts(bucket.counts)) invalid();
      dates.add(bucket.sourceDate);
    }
    if (!sumMatches(row.days.map(bucket => bucket.counts), row.counts)) invalid();
    for (const reason of row.reasons) {
      if (!safeCode(reason?.code) || reasons.has(reason.code) || !integer(reason.batches) || reason.batches < 1) invalid();
      reasons.add(reason.code);
    }
    if (row.reasons.reduce((sum, reason) => sum + reason.batches, 0) !== row.counts.stableAttemptBatches) invalid();
  }
  if (!sumMatches(value.leagues.map(row => row.counts), value.counts)
    || value.status === 'PENDING' && value.counts.retryPendingBatches === 0
    || value.status === 'NO_PENDING_SOURCE' && value.counts.unindexedBatches !== 0
    || value.status === 'SOURCE_UNINDEXED' && (value.counts.retryPendingBatches !== 0 || value.counts.stableAttemptBatches === 0)) invalid();
  return value;
}

export function validateRawHistoryMaintenanceReceipt(value) {
  const invalid = () => { throw new Error('本次整理回條未通過核對，請重新查詢進度。'); };
  if (typeof value?.ok !== 'boolean' || value.schema !== schema || !readonly(value) || !instant(value.until)
    || !['BUDGET_DEFERRED', 'BATCH_LIMIT_REACHED', 'WINDOW_EXHAUSTED', 'RETRYABLE'].includes(value.status)
    || value.budgetKind !== 'SOFT_DEADLINE' || value.hardDeadlineEnforced !== false || value.completeWithinWindow !== false
    || !integer(value.maxBatches) || value.maxBatches < 1 || value.maxBatches > 64
    || !integer(value.timeBudgetMs) || value.timeBudgetMs < 1000 || value.timeBudgetMs > 40000
    || !['processedBatches', 'indexedBatches', 'stableAttemptBatches', 'retryableBatches'].every(key => integer(value[key]))
    || !Array.isArray(value.results) || value.processedBatches !== value.results.length || value.processedBatches > value.maxBatches
    || value.processedBatches !== value.indexedBatches + value.stableAttemptBatches + value.retryableBatches
    || value.ok && (value.status === 'RETRYABLE' || value.retryableBatches > 0)) invalid();
  for (const row of value.results) {
    if (!league(row?.league) || !noContradictoryFlags(row) || !['INDEXED', 'SOURCE_UNINDEXED', 'RETRYABLE'].includes(row.status)
      || typeof row.captureId !== 'string' || !/^[a-f0-9]{64}$/.test(row.captureId)
      || row.status === 'INDEXED' && (!integer(row.indexedGames) || row.indexedGames < 1 || row.indexedGames > 40)
      || row.status !== 'INDEXED' && !safeCode(row.reason)) invalid();
  }
  if (value.results.filter(row => row.status === 'INDEXED').length !== value.indexedBatches
    || value.results.filter(row => row.status === 'SOURCE_UNINDEXED').length !== value.stableAttemptBatches
    || value.results.filter(row => row.status === 'RETRYABLE').length !== value.retryableBatches) invalid();
  return value;
}

function reasonLabel(code) {
  if (/INCOMPLETE|MISSING_PART|PART_COUNT|BATCH_PART/.test(code)) return '來源片段仍待核對';
  if (/NO_GOALS|NO_MARKET/.test(code)) return '尚未辨識出進球盤口';
  if (/UNSUPPORTED_FORMAT/.test(code)) return '尚未轉成可查盤口';
  if (/BUDGET|TOO_LARGE|LIMIT/.test(code)) return '單批來源較大，仍待處理';
  return '來源內容仍待釐清';
}

export function rawHistoryMaintenanceReceiptText(value) {
  const prefix = `本輪已建立 ${number(value.indexedBatches)} 批查閱資料`;
  if (!value.ok || value.status === 'RETRYABLE') return `${prefix}，部分整理結果尚未確認，可重新查詢進度或重試。`;
  if (value.status === 'BATCH_LIMIT_REACHED') return `${prefix}；本輪已達處理上限，剩餘量以最新進度為準。`;
  if (value.status === 'BUDGET_DEFERRED') return `${prefix}；本輪已到處理時間，接續情況以最新進度為準。`;
  return `${prefix}；本輪沒有新的可接續批次，尚未辨識的來源仍另列。`;
}

export default function RawHistoryMaintenancePanel() {
  const [result, setResult] = useState(null), [receipt, setReceipt] = useState(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(null);
  const request = useRef({ sequence: 0, controller: null, timer: null, busy: false, mounted: false });

  async function run(action = 'status') {
    if (request.current.busy || !request.current.mounted) return;
    const sequence = ++request.current.sequence, controller = new AbortController();
    let gotReceipt = false;
    request.current.controller?.abort();
    request.current.controller = controller; request.current.busy = true;
    const current = () => request.current.mounted && request.current.sequence === sequence;
    const timeout = window.setTimeout(() => {
      if (!current()) return;
      ++request.current.sequence; controller.abort(); request.current.busy = false;
      request.current.controller = null; request.current.timer = null;
      setResult(null); setBusy(null);
      setError(action === 'drain' ? gotReceipt ? '本輪整理回條已收到，最新進度查詢逾時；請重新查詢。'
        : '等候整理結果逾時，結果仍未確認；請重新查詢進度。' : '進度查詢逾時，數量仍未確認，請重試。');
    }, 52000);
    request.current.timer = timeout;
    setResult(null); setError(''); setBusy(action);
    if (action === 'drain') setReceipt(null);
    try {
      if (action === 'drain') {
        const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'drain' }), signal: controller.signal });
        if (response.status === 429) throw new Error('整理操作較密集，請稍後再試；可先重新查詢進度。');
        const value = validateRawHistoryMaintenanceReceipt(await response.json());
        if (!response.ok && value.ok) throw new Error('本次整理尚未確認，請重新查詢進度。');
        if (!current()) return;
        gotReceipt = true;
        setReceipt(value);
      }
      const response = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (response.status === 429) throw new Error('查詢較密集，請稍後再試；數量仍未確認。');
      if (!response.ok) throw new Error('暫時無法核對整理進度，數量仍未確認，請重試。');
      const value = validateRawHistoryMaintenanceProgress(await response.json());
      if (current()) setResult(value);
    } catch (cause) {
      if (current()) setError(cause.name === 'AbortError' ? '等候結果已中止，請重新查詢進度；來源仍保留。'
        : /^(?:整理進度未通過核對|本次整理回條未通過核對|本次整理尚未確認|暫時無法核對整理進度|整理操作較密集|查詢較密集)/.test(cause.message || '')
          ? cause.message : '整理結果尚未確認，請重新查詢進度。');
    } finally {
      window.clearTimeout(timeout);
      if (current()) {
        request.current.busy = false; request.current.controller = null; request.current.timer = null; setBusy(null);
      }
    }
  }

  useEffect(() => {
    request.current.mounted = true;
    run();
    return () => {
      request.current.mounted = false; ++request.current.sequence;
      request.current.controller?.abort(); window.clearTimeout(request.current.timer); request.current.busy = false;
    };
  }, []);

  return <section className={`panel ${styles.panel}`} aria-label="原始盤口整理進度" aria-busy={busy !== null}>
    <h2>已保存盤口的整理進度</h2>
    <p className={styles.notice}>範圍是英超與歐冠全部保存日期。來源保存與可依場次查詢的資料分開核對；以下以來源批次計數，一批可能包含多場。</p>
    <p className={styles.notice}>整理後可用下方「查詢原始歷史盤口」依盤日調閱。</p>
    <div className={styles.actions}>
      <button type="button" className="secondary" disabled={busy !== null} onClick={() => run('drain')}>{busy === 'drain' ? '整理中…' : '整理已保存盤口'}</button>
      <button type="button" className="secondary" disabled={busy !== null} onClick={() => run('status')}>重新查詢整理進度</button>
    </div>
    {busy && <p role="status">{busy === 'drain' ? '正在核對並整理已保存來源，完成後會重新讀取進度。' : '正在核對整理進度…'}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {receipt && <p role="status" className={styles.notice}>{rawHistoryMaintenanceReceiptText(receipt)}</p>}
    {!result && !busy && <p className={styles.notice}>來源量與待整理數量：未確認。</p>}
    {result?.status === 'NOT_INITIALIZED' && <p role="status" className={styles.notice}>整理進度尚未建立，來源量仍待核對；可按「整理已保存盤口」開始核對。</p>}
    {result?.counts && <>
      <p className={styles.meta}>核對截至台北時間 {taipeiHistoryTime(result.until)}；已接收 {number(result.counts.sourceFragments)} 個原始片段。</p>
      <div className={styles.tableWrap}><table>
        <caption>英超與歐冠來源批次</caption>
        <thead><tr><th scope="col">聯盟</th><th scope="col">已保存來源</th><th scope="col">新版已核可查</th><th scope="col">舊版仍可查</th><th scope="col">待整理</th><th scope="col">仍待辨識</th></tr></thead>
        <tbody>{[...result.leagues, { league: 'TOTAL', counts: result.counts }].map(row => <tr key={row.league}>
          <th scope="row">{leagueNames[row.league] || '合計'}</th><td>{number(row.counts.sourceBatches)}</td><td>{number(row.counts.indexedBatches)}</td>
          <td>{number(row.counts.previousReadableIndexedBatches)}</td>
          <td>{number(row.counts.retryPendingBatches)}</td><td>{number(row.counts.stableAttemptBatches)}</td>
        </tr>)}</tbody>
      </table></div>
      {result.counts.previousReadableIndexedBatches > 0 && <p className={styles.notice}>另有 {number(result.counts.previousReadableIndexedBatches)} 批舊版仍可查、待新版重核。這些批次包含在待整理或仍待辨識數量內，不代表資料消失，也未算成新版已驗收。</p>}
      {result.leagues.some(row => row.reasons.length) && <div className={styles.reasons}>
        <h3>仍待辨識的來源</h3>
        {result.leagues.filter(row => row.reasons.length).map(row => <p key={row.league}>{leagueNames[row.league]}：{row.reasons.map(reason => `${reasonLabel(reason.code)} ${number(reason.batches)} 批`).join('、')}。</p>)}
        <p className={styles.notice}>這些來源仍有保存；新片段到達後可再核對，未當成沒有開盤。尚未轉成可查盤口的來源可能包含附加文字、其他賽事與未支援格式，批次數不等於缺失場次。</p>
      </div>}
      <details className={styles.days}><summary>查看來源讀取日期明細（台北）</summary>
        <p className={styles.notice}>以下依每批最早的來源讀取日期分組，與賽事盤日不同。</p>
        {result.leagues.map(row => <div key={row.league} className={styles.tableWrap}><table>
          <caption>{leagueNames[row.league]}</caption>
          <thead><tr><th scope="col">來源讀取日期</th><th scope="col">已保存</th><th scope="col">新版已核可查</th><th scope="col">舊版仍可查</th><th scope="col">待整理</th><th scope="col">仍待辨識</th></tr></thead>
          <tbody>{row.days.map(bucket => <tr key={bucket.sourceDate}><th scope="row">{bucket.sourceDate}</th><td>{number(bucket.counts.sourceBatches)}</td>
            <td>{number(bucket.counts.indexedBatches)}</td><td>{number(bucket.counts.previousReadableIndexedBatches)}</td><td>{number(bucket.counts.retryPendingBatches)}</td><td>{number(bucket.counts.stableAttemptBatches)}</td></tr>)}</tbody>
        </table></div>)}
      </details>
    </>}
    <p className={styles.notice}>整理只增加歷史查閱資料，保留原始時間。官方場次、所有原始來源是否已展開，以及尾盤完整度仍未確認。</p>
  </section>;
}
