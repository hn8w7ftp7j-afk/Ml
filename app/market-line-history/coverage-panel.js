'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { taipeiHistoryTime } from './history-view.js';
import styles from './history.module.css';

const LEAGUES = ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'EPL', 'UCL'];
const LABELS = { EPL: '英超 EPL', UCL: '歐冠 UCL' };
const MARKET_STATUS = { AVAILABLE: '有保存', NOT_CAPTURED: '未保存', INVALID: '內容異常', LOCKED: '鎖盤', PERIOD_UNKNOWN: '期間未確認' };
const numberText = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-TW') : '未確認';
const timeText = value => value && Number.isFinite(Date.parse(value)) ? taipeiHistoryTime(value) : '未確認';

function validateCoverage(payload) {
  if (payload?.ok !== true || payload.schema !== 'market-history-coverage-v1'
    || !Array.isArray(payload.leagues) || !Array.isArray(payload.games) || !Array.isArray(payload.sources)
    || payload.leagues.some(row => !LEAGUES.includes(row.league))
    || new Set(payload.leagues.map(row => row.league)).size !== payload.leagues.length) {
    throw new Error('保存狀態回應不完整，尚未確認覆蓋範圍。');
  }
  return payload;
}

export default function CoveragePanel() {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef({ sequence: 0, controller: null });

  const load = useCallback(async (filters = {}, pagination = null) => {
    const sequence = ++request.current.sequence;
    request.current.controller?.abort();
    const controller = new AbortController();
    request.current.controller = controller;
    setBusy(true); setError('');
    // A changed filter must never display the previous scope as its result.
    if (!pagination) setResult(null);
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    try {
      const params = new URLSearchParams({ limit: '40' });
      if (filters.league) params.set('league', filters.league);
      if (filters.date) params.set('date', filters.date);
      if (pagination) { params.set('until', pagination.until); params.set('after', pagination.nextAfter); }
      const response = await fetch(`/api/market-history-coverage?${params}`, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '保存狀態暫時無法讀取；未當成零筆。');
      validateCoverage(payload);
      if (pagination && payload.sources.some(source => source.status !== 'PASS')) throw new Error('本頁部分來源尚未讀取成功，已保留原分頁位置，請重試。');
      if (request.current.sequence === sequence) setResult({ ...payload, appliedFilters: filters,
        games: pagination ? [...new Map([...pagination.games, ...payload.games].map(row => [JSON.stringify([row.league, row.boardDate, row.gameKey]), row])).values()] : payload.games });
    } catch (cause) {
      if (request.current.sequence === sequence) setError(cause.name === 'AbortError' ? '保存狀態查詢逾時，請重新查詢。' : cause.message || '保存狀態讀取失敗。');
    } finally {
      window.clearTimeout(timeout);
      if (request.current.sequence === sequence) setBusy(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => { ++request.current.sequence; request.current.controller?.abort(); };
  }, [load]);

  return <section className={`panel ${styles.coverage}`} aria-label="七聯盟盤口保存狀態" aria-busy={busy}>
    <h2>七聯盟盤口保存狀態</h2>
    <p>查最後保存時間與各市場缺漏。變盤紀錄與讀盤回條分開計算；每場最後尾盤是否完整，仍待核對。</p>
    <form className={styles.coverageFilters} onSubmit={event => {
      event.preventDefault();
      const fields = new FormData(event.currentTarget);
      load({ league: String(fields.get('coverage-league') || ''), date: String(fields.get('coverage-date') || '') });
    }}>
      <label htmlFor="coverage-league">保存狀態聯盟<select id="coverage-league" name="coverage-league" disabled={busy} defaultValue=""><option value="">七個聯盟</option>{LEAGUES.map(league => <option key={league} value={league}>{LABELS[league] || league}</option>)}</select></label>
      <label htmlFor="coverage-date">保存狀態盤日<input type="date" id="coverage-date" name="coverage-date" disabled={busy}/></label>
      <button type="submit" className="secondary" disabled={busy}>{busy ? '核對中…' : '查詢保存狀態'}</button>
    </form>
    {error && <p role="alert" className={styles.invalid}>{error}</p>}
    {busy && <p role="status" className={styles.muted}>正在核對實際保存內容…</p>}
    {result && <>
      <p className={styles.muted}>查詢時間 {timeText(result.until)}（台北時間）{result.status === 'PARTIAL' ? '｜部分來源未確認，不能視為完整。' : '｜已讀回來源，並不代表尾盤完整。'}</p>
      <div className={styles.tableWrap}><table>
        <caption>各聯盟保存數量及最後觀測時間</caption>
        <thead><tr><th scope="col">聯盟</th><th scope="col">保存數量</th><th scope="col">盤日範圍</th><th scope="col">最後保存變盤</th><th scope="col">最後讀盤觀測</th><th scope="col">回條存入時間</th></tr></thead>
        <tbody>{result.leagues.map(row => <tr key={row.league}>
          <th scope="row">{LABELS[row.league] || row.league}{row.status !== 'PASS' && <small className={styles.coverageWarning}>部分未確認</small>}</th>
          <td>{numberText(row.savedCount)}<small className={styles.coverageSub}>{row.countUnit === 'READER_OBSERVATIONS' ? '讀盤觀測' : '變盤版本'}</small></td>
          <td>{row.firstBoardDate || '未確認'} ～ {row.lastBoardDate || '未確認'}</td>
          <td>{row.countUnit === 'READER_OBSERVATIONS' ? '另計觀測，不當作變盤' : timeText(row.lastStateChangedAt)}</td>
          <td>{timeText(row.lastReaderObservedAt)}</td><td>{timeText(row.lastPersistedAt)}</td>
        </tr>)}</tbody>
      </table></div>
      <p className={styles.muted}>沒有讀盤回條的舊資料，無法回推最後確認時間。原始截圖未在此保存；未讀到的歷史盤口不補造。</p>
      {result.sources.some(source => source.status !== 'PASS') && <p role="status" className={styles.coverageWarning}>部分保存來源尚未可讀，相關時間或數量顯示「未確認」，不當作零筆。</p>}
      <details className={styles.coverageGames}><summary>查看各場市場缺漏（已載入 {numberText(result.games.length)} 筆{result.gameRowsTruncated ? '，可繼續載入' : ''}）</summary>
        {result.games.length === 0 ? <p>此查詢沒有可列出的保存場次，不能據此認定沒有開盤。</p> : <div className={styles.tableWrap}><table>
          <caption>各場最新保存內容；尾盤完整性未驗證</caption>
          <thead><tr><th scope="col">場次</th><th scope="col">各市場狀態</th><th scope="col">最後讀盤觀測</th><th scope="col">最後尾盤</th></tr></thead>
          <tbody>{result.games.map(row => <tr key={`${row.league}|${row.boardDate}|${row.gameKey}`}>
            <th scope="row">{row.league} {row.gameLabel || row.gameKey}<small className={styles.coverageSub}>{row.boardDate}</small><a href={`/market-line-history?${new URLSearchParams({ league: row.league, from: row.boardDate, through: row.boardDate, gameKey: row.gameKey })}`}>查看這場全部保存紀錄</a></th>
            <td>{!row.lastReaderObservedAt && <small className={styles.coverageSub}>最後保存版本；讀盤回條未確認</small>}{(row.latestCaptureMarkets || row.markets || []).map((market, index) => <div key={`${market.market}|${index}`} className={market.status === 'AVAILABLE' ? undefined : styles.coverageWarning}>{market.market}：{MARKET_STATUS[market.status] || '未確認'}{['EPL', 'UCL'].includes(row.league) && market.lastObservedAt && <small className={styles.coverageSub}>觀測 {timeText(market.lastObservedAt)}</small>}</div>)}{row.integrity?.status === 'FAIL' && <div className={styles.invalid}>保存內容待核對</div>}</td>
            <td>{timeText(row.lastReaderObservedAt)}</td><td>未驗證</td>
          </tr>)}</tbody>
        </table></div>}
        {result.nextAfter && <button type="button" className="secondary" disabled={busy} onClick={() => load(result.appliedFilters, result)}>{busy ? '核對中…' : '載入下一頁場次'}</button>}
        {result.gameRowsTruncated && !result.nextAfter && <p className={styles.coverageWarning}>部分來源尚未讀取成功，請重新查詢後再繼續分頁，避免漏列場次。</p>}
        {result.inventoryComplete && <p className={styles.muted}>此範圍的已保存場次已列完；尚未與全部官方賽程比對。</p>}
      </details>
    </>}
  </section>;
}
