'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { EMPTY_HISTORY_FILTERS, HISTORY_LEAGUES, groupHistoryRows, historyFilterLabel, historyQueryUrl,
  historyRowKey, historyWater, mergeHistoryRows, taipeiHistoryTime, validateHistoryResponse } from './history-view.js';
import styles from './history.module.css';
import CoveragePanel from './coverage-panel.js';

const countText = value => value.toLocaleString('zh-TW');

function SavedMarket({ market }) {
  const available = market.status === 'AVAILABLE' && Array.isArray(market.directions) && market.directions.length === 2;
  return <div className={styles.market}>
    <h4>{market.market}</h4>
    {available ? market.directions.map((direction, index) => <div className={styles.direction} key={`${direction.side || index}:${index}`}>
      <strong>{direction.pick || '方向文字未保存'}</strong><span>水位 {historyWater(direction.water)}</span>
    </div>) : <p className={market.status === 'INVALID' ? styles.invalid : styles.muted}>
      {market.status === 'INVALID' || market.status === 'AVAILABLE' ? '原始紀錄格式異常，請查看保存內容。' : '此版本未保存這個市場。'}
    </p>}
  </div>;
}

function SavedGame({ game, partial }) {
  return <details className={styles.game} open>
    <summary><span><span className="leagueBadge">{game.league}</span> {game.label}</span><span>{game.boardDate}｜已載入 {game.rows.length} 個版本</span></summary>
    <div className={styles.gameBody}>
      <p className={styles.muted}>場次識別 <code>{game.gameKey}</code>{partial ? '｜尚有其他頁，這裡可能不是該場的全部版本。' : ''}</p>
      <ol className={styles.timeline} aria-label={`${game.label} 已保存的盤口時間順序`}>
        {game.rows.map(row => <li key={historyRowKey(row)}>
          <div className={styles.observation}><time dateTime={row.observedAt}>{taipeiHistoryTime(row.observedAt)}</time><small>台北時間{row.readerVersion ? `｜Reader ${row.readerVersion}` : ''}</small></div>
          {row.integrity?.ok === false && <p className={styles.invalid} role="alert">這筆保存內容未通過格式核對；不要把缺失的市場當成完整盤口。</p>}
          <div className={styles.markets}>{row.markets.map((market, index) => <SavedMarket key={`${market.market}:${index}`} market={market}/>)}</div>
          <details className={styles.raw}><summary>原始保存內容</summary><pre>{JSON.stringify({ league: row.league, boardDate: row.boardDate, gameKey: row.gameKey,
            observedAt: row.observedAt, stateHash: row.stateHash, sourceHash: row.sourceHash,
            integrity: row.integrity, rawMarkets: row.rawMarkets }, null, 2)}</pre></details>
        </li>)}
      </ol>
    </div>
  </details>;
}

export default function HistoryBrowser({ children } = {}) {
  const [draft, setDraft] = useState({ ...EMPTY_HISTORY_FILTERS });
  const [applied, setApplied] = useState({ ...EMPTY_HISTORY_FILTERS });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requiresLogin, setRequiresLogin] = useState(false);
  const controller = useRef(null);
  const sequence = useRef(0);
  const groups = useMemo(() => groupHistoryRows(result?.rows || []), [result?.rows]);
  const changedFilters = Object.keys(EMPTY_HISTORY_FILTERS).some(key => draft[key].trim() !== applied[key]);

  const load = useCallback(async (filters, pagination = null) => {
    const requestId = ++sequence.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    let timeout;
    setBusy(true); setError(''); setRequiresLogin(false);
    if (!pagination) { setResult(null); setApplied({ ...filters, gameKey: filters.gameKey.trim() }); }
    try {
      const url = historyQueryUrl(filters, pagination);
      timeout = window.setTimeout(() => abort.abort(), 30000);
      const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: abort.signal });
      let payload;
      try { payload = await response.json(); }
      catch { throw new Error('伺服器未回傳有效的歷史盤口資料，請稍後重新查詢。'); }
      if (!response.ok || payload?.ok !== true) {
        if (requestId === sequence.current) setRequiresLogin(response.status === 401);
        throw new Error(typeof payload?.error === 'string' ? payload.error : '歷史盤口暫時無法讀取，未確認查詢結果。');
      }
      validateHistoryResponse(payload);
      if (requestId !== sequence.current) return;
      setResult({ ...payload, rows: mergeHistoryRows(pagination?.rows || [], payload.rows) });
    } catch (cause) {
      if (requestId === sequence.current) setError(cause.name === 'AbortError' ? '查詢逾時，請重新查詢；未當成零筆資料。' : cause.message || '歷史盤口讀取失敗。');
    } finally {
      window.clearTimeout(timeout);
      if (requestId === sequence.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    load({ ...EMPTY_HISTORY_FILTERS });
    return () => { ++sequence.current; controller.current?.abort(); };
  }, [load]);

  function updateFilter(key, value) { setDraft(previous => ({ ...previous, [key]: value })); }
  function submit(event) {
    event.preventDefault();
    // Native date controls can commit their final value without React's change
    // state having advanced yet. Submit the visible form values, not stale state.
    const fields = new FormData(event.currentTarget);
    const filters = Object.fromEntries(Object.keys(EMPTY_HISTORY_FILTERS).map(key => [key, String(fields.get(key) || '')]));
    setDraft(filters);
    load(filters);
  }

  return <main className={`appShell ${styles.shell}`}>
    <header className={styles.header}><div><div className="eyebrow">SAVED MARKET LINES</div><h1>歷史盤口</h1><p>查看 Reader 已保存的原盤口與水位，不重算、不改分析。</p></div><Link href="/" className="secondary">回主站</Link></header>
    <CoveragePanel/>
    {children}
    <section className={`panel ${styles.scope}`} aria-label="資料範圍說明">
      <p>這裡是「變盤歸檔」，不是舊分析快照庫。同一場每次保存是一組盤口狀態，最多包含全場／上半讓分與大小、雙邊方向。</p>
      <p>盤日是 Reader 的盤面日期；下方觀測時間一律顯示台北時間。只列實際保存內容，未保存的市場不補值；筆數不代表全部歷史都已收齊。</p>
    </section>
    <form className={`panel ${styles.filters}`} onSubmit={submit} aria-label="歷史盤口篩選">
      <label htmlFor="history-league">聯盟<select id="history-league" name="league" value={draft.league} disabled={busy} onChange={event => updateFilter('league', event.target.value)}><option value="">全部聯盟</option>{HISTORY_LEAGUES.map(league => <option key={league} value={league}>{league}</option>)}</select></label>
      <label htmlFor="history-from">起始盤日<input id="history-from" name="from" type="date" value={draft.from} disabled={busy} onChange={event => updateFilter('from', event.target.value)}/></label>
      <label htmlFor="history-through">結束盤日<input id="history-through" name="through" type="date" value={draft.through} disabled={busy} onChange={event => updateFilter('through', event.target.value)}/></label>
      <label htmlFor="history-game" className={styles.gameFilter}>場次識別（選填）<input id="history-game" name="gameKey" type="text" value={draft.gameKey} maxLength={80} disabled={busy} placeholder="例如 777 或 19:30|LAL|GSW" onChange={event => updateFilter('gameKey', event.target.value)}/></label>
      <div className={styles.filterActions}><button className="primary" disabled={busy} type="submit">{busy ? '讀取中…' : '查詢盤口'}</button><button className="secondary" disabled={busy} type="button" onClick={() => { setDraft({ ...EMPTY_HISTORY_FILTERS }); load({ ...EMPTY_HISTORY_FILTERS }); }}>清除篩選</button></div>
      {changedFilters && <p className={styles.draftNotice}>篩選條件已變更，按「查詢盤口」更新結果。</p>}
    </form>
    {error && <div className="errorBox" role="alert">{error}{result && <p>保留先前已載入內容；這次沒有確認取得下一頁。</p>}{requiresLogin && <p><Link href="/login?next=%2Fmarket-line-history">重新登入</Link></p>}</div>}
    {busy && <p className={styles.loading} role="status" aria-live="polite">{result ? '正在讀取下一頁，先前內容保留。' : '正在查詢已保存盤口…'}</p>}
    {result && <section aria-label="歷史盤口查詢結果" aria-busy={busy}>
      <div className={`panel ${styles.inventory}`}>
        <h2>已保存資料</h2><p className={styles.applied}>{historyFilterLabel(applied)}</p>
        <dl className={styles.counts}><div><dt>符合篩選的保存版本</dt><dd>{countText(result.totals.savedStates)}</dd></div><div><dt>不同聯盟／盤日／場次識別</dt><dd>{countText(result.totals.gameDateKeys)}</dd></div><div><dt>目前已載入版本</dt><dd>{countText(result.rows.length)}</dd></div></dl>
        <p className={styles.muted}>上方總數包含符合篩選的全部歸檔，不只本頁。場次識別未另做官方身分去重；一個版本不等於一場或一個市場。</p>
        <p className={styles.muted}>盤日範圍 {result.totals.firstBoardDate || '—'} ～ {result.totals.lastBoardDate || '—'}｜查詢固定截點 {taipeiHistoryTime(result.until)}</p>
        <p className={styles.muted}>截點依觀測時間；之後補寫的較早紀錄，可能出現在後續查詢中。</p>
        {result.leagues.length > 0 && <div className={styles.tableWrap}><table><caption>符合目前篩選的各聯盟歸檔總數</caption><thead><tr><th scope="col">聯盟</th><th scope="col">保存版本</th><th scope="col">盤日／場次識別</th><th scope="col">盤日範圍</th></tr></thead><tbody>{result.leagues.map(league => <tr key={league.league}><th scope="row">{league.league}</th><td>{countText(league.savedStates)}</td><td>{countText(league.gameDateKeys)}</td><td>{league.firstBoardDate || '—'} ～ {league.lastBoardDate || '—'}</td></tr>)}</tbody></table></div>}
      </div>
      {result.rows.length === 0 ? <div className={`panel ${styles.empty}`}><h2>沒有符合條件的保存紀錄</h2><p>這不代表當時沒有比賽或沒有開盤。可清除篩選，查看已保存的盤日範圍。</p></div> : <>
        <div className={styles.resultsHead}><h2>各場盤口時間序列</h2><span>每場由早到晚｜已載入 {groups.length} 個盤日／場次識別</span></div>
        {groups.map(game => <SavedGame key={game.key} game={game} partial={result.hasMore}/>)}
      </>}
      <div className={styles.pagination}>
        <p role="status">已載入 {countText(result.rows.length)}／{countText(result.totals.savedStates)} 個保存版本{result.hasMore ? '；尚有下一頁。' : '；此查詢的保存紀錄已讀取完畢，不代表歷史覆蓋完整。'}</p>
        {result.hasMore && <button type="button" className="secondary" disabled={busy || changedFilters} onClick={() => load(applied, result)}>{busy ? '讀取中…' : '載入下一頁（最多 100 個版本）'}</button>}
      </div>
    </section>}
  </main>;
}
