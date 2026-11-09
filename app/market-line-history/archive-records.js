'use client';

import { useEffect, useRef, useState } from 'react';
import { taipeiHistoryTime } from './history-view.js';
import { nbaHistoricalAvailabilityLabel } from './coverage-display.js';
import styles from './history.module.css';

const LEAGUES = ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'EPL', 'UCL'];
const initial = { league: '', from: '', through: '', gameKey: '' };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = value => Number.isSafeInteger(value) && value >= 0;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
export function archiveRecordsUrl(filters, page) {
  if (filters.league && !LEAGUES.includes(filters.league)) throw new Error('請選擇支援的聯盟');
  if ([filters.from, filters.through].some(value => value && !validDate(value)) || (filters.from && filters.through && filters.from > filters.through)) throw new Error('盤日範圍無效');
  if (filters.gameKey.length > 200) throw new Error('場次識別過長');
  const params = new URLSearchParams({ view: 'records', limit: '25' });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  if (page) { params.set('until', page.until); params.set('after', page.nextAfter); }
  return `/api/reader/archive?${params}`;
}
export function validateArchiveRecords(payload, detail = false) {
  if (payload?.ok !== true || payload.schema !== 'READER-CAPTURE-ARCHIVE-v1' || payload.archiveOnly !== true
    || payload.currentBoardUpdated !== false || payload.historicalAvailabilityVerified !== false || payload.executable !== false || payload.productionWrites !== false) throw new Error('補傳保存回應不完整');
  const metadata = row => row && hash(row.captureId) && LEAGUES.includes(row.league) && validDate(row.boardDate)
    && time(row.observedAt) && time(row.persistedAt) && hash(row.payloadHash);
  if (detail) {
    if (!metadata(payload.record) || !['PASS', 'FAIL'].includes(payload.record.integrity?.status)
      || (payload.record.integrity.status === 'PASS' && (!payload.record.payload || !Array.isArray(payload.record.payload.games)))
      || (payload.record.integrity.status === 'FAIL' && payload.record.payload !== null)) throw new Error('補傳保存內容未通過核對');
  } else if (!count(payload.totalCount) || !time(payload.until) || typeof payload.hasMore !== 'boolean'
    || (payload.hasMore && (typeof payload.nextAfter !== 'string' || !payload.nextAfter)) || !Array.isArray(payload.records)
    || payload.records.some(row => !metadata(row) || !Array.isArray(row.games))) throw new Error('補傳保存清單不完整');
  return payload;
}
export function archiveGameMarkets(game) {
  if (Array.isArray(game.markets)) {
    const rows = game.markets.map((market, index) => ({
      key: `soccer-${index}`, label: `${market.period === 'FT' ? '全場' : market.period === 'HT' ? '上半場' : '期間未確認'} ${market.kind === 'HANDICAP' ? '讓球' : market.kind === 'TOTAL' ? '大小' : market.kind || '市場未確認'}`,
      value: market,
    }));
    for (const [period, kind, label] of [['FT', 'HANDICAP', '全場 讓球'], ['FT', 'TOTAL', '全場 大小'], ['HT', 'HANDICAP', '上半場 讓球'], ['HT', 'TOTAL', '上半場 大小']]) {
      if (!game.markets.some(market => market.period === period && market.kind === kind)) rows.push({ key: `${period}-${kind}`, label, value: null });
    }
    return rows;
  }
  return [['fullRunline', '全場讓分'], ['fullTotal', '全場大小'], [game.firstHalfRunline !== undefined ? 'firstHalfRunline' : 'first5Runline', '上半讓分'],
    [game.firstHalfTotal !== undefined ? 'firstHalfTotal' : 'first5Total', '上半大小']].map(([key, label]) => ({ key, label, value: game[key] ?? null }));
}
function ArchiveDetail({ record }) {
  if (!record) return null;
  return <div className={styles.gameBody}>
    <h3>原始保存擷取</h3>
    <p className={styles.muted}>這是 Reader 原始識別與盤口；沒有官方賽事配對保證，不更新分析或尾盤完整狀態。</p>
    <p className={styles.muted}>來源觀測 {taipeiHistoryTime(record.observedAt)}｜實際存入 {taipeiHistoryTime(record.persistedAt)}｜Reader {record.readerVersion}</p>
    <p className={styles.muted}>擷取識別 <code>{record.captureId}</code></p>
    {record.integrity.status === 'FAIL' ? <p className={styles.invalid} role="alert">保存內容雜湊核對失敗，未當成有效盤口，原始內容暫不顯示。</p> : <>
      {record.payload.games.map((game, index) => <div key={index} className={styles.game}>
        <h4>{game.awayCode || game.awayKey || '客隊未確認'} @ {game.homeCode || game.homeKey || '主隊未確認'} {game.boardTime}｜{nbaHistoricalAvailabilityLabel(record.league, game) || (game.marketStatus === 'locked' ? '鎖盤' : '原始盤面')}</h4>
        <div className={styles.markets}>{archiveGameMarkets(game).map(market => <div className={styles.market} key={market.key}>
          <h4>{market.label}</h4>{market.value ? <dl>{Object.entries(market.value).filter(([key]) => ['line', 'lineSide', 'awayWater', 'homeWater', 'overWater', 'underWater'].includes(key)).map(([key, value]) => <div className={styles.direction} key={key}><dt>{{ line: '原盤', lineSide: '讓分方', awayWater: '客水', homeWater: '主水', overWater: '大水', underWater: '小水' }[key]}</dt><dd>{key === 'lineSide' ? value === 'away' ? '客隊' : value === 'home' ? '主隊' : String(value) : String(value)}</dd></div>)}</dl> : <p className={styles.muted}>這筆擷取未保存此市場</p>}
        </div>)}</div>
      </div>)}
      <details className={styles.raw}><summary>完整原始保存 JSON（含來源及期間證據）</summary><pre>{JSON.stringify(record.payload, null, 2)}</pre></details>
    </>}
  </div>;
}
export default function ArchiveRecords() {
  const [page, setPage] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [filters, setFilters] = useState(initial), [detail, setDetail] = useState(null), [detailBusy, setDetailBusy] = useState(false), [detailError, setDetailError] = useState('');
  const listRequest = useRef({ sequence: 0, controller: null }), detailRequest = useRef({ sequence: 0, controller: null });
  useEffect(() => () => { for (const ref of [listRequest, detailRequest]) { ++ref.current.sequence; ref.current.controller?.abort(); } }, []);
  async function load(nextFilters, previous = null) {
    const request = listRequest.current, sequence = ++request.sequence;
    request.controller?.abort(); const controller = new AbortController(); request.controller = controller;
    setBusy(true); setError('');
    if (!previous) { setPage(null); setFilters(nextFilters); setDetail(null); ++detailRequest.current.sequence; detailRequest.current.controller?.abort(); setDetailBusy(false); setDetailError(''); }
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(archiveRecordsUrl(nextFilters, previous), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || '補傳保存清單讀取失敗');
      validateArchiveRecords(payload);
      if (request.sequence === sequence) {
        const records = new Map((previous?.records || []).map(row => [row.captureId, row]));
        for (const row of payload.records) records.set(row.captureId, row);
        setPage({ ...payload, records: [...records.values()] });
      }
    } catch (cause) { if (request.sequence === sequence) setError(cause.name === 'AbortError' ? '查詢逾時，未當成零筆；可重新查詢' : cause.message); }
    finally { window.clearTimeout(timeout); if (request.sequence === sequence) setBusy(false); }
  }
  async function inspect(captureId) {
    const request = detailRequest.current, sequence = ++request.sequence;
    request.controller?.abort(); const controller = new AbortController(); request.controller = controller;
    setDetail(null); setDetailBusy(true); setDetailError('');
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`/api/reader/archive?captureId=${encodeURIComponent(captureId)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || '原始保存內容讀取失敗');
      validateArchiveRecords(payload, true);
      if (payload.record.captureId !== captureId) throw new Error('擷取識別不一致');
      if (request.sequence === sequence) setDetail(payload.record);
    } catch (cause) { if (request.sequence === sequence) setDetailError(cause.name === 'AbortError' ? '原始保存內容讀取逾時' : cause.message); }
    finally { window.clearTimeout(timeout); if (request.sequence === sequence) setDetailBusy(false); }
  }
  return <section aria-label="逐筆補傳擷取查詢">
    <h3>逐筆查詢已保存擷取</h3>
    <p className={styles.muted}>場次識別採 Reader 的時間與主客隊原始識別，不等於棒球官方 gamePk。擷取資料可獨立查閱，不需先下注或配對成功。</p>
    <form className={styles.coverageFilters} onSubmit={event => {
      event.preventDefault(); const fields = new FormData(event.currentTarget);
      load(Object.fromEntries(Object.keys(initial).map(key => [key, String(fields.get(`archive-${key}`) || '').trim()])));
    }}>
      <label>補傳聯盟<select name="archive-league" disabled={busy} defaultValue=""><option value="">七個聯盟</option>{LEAGUES.map(league => <option key={league}>{league}</option>)}</select></label>
      <label>補傳起始盤日<input name="archive-from" type="date" disabled={busy}/></label>
      <label>補傳結束盤日<input name="archive-through" type="date" disabled={busy}/></label>
      <label>Reader 原始場次識別（選填）<input name="archive-gameKey" type="text" maxLength={200} disabled={busy} placeholder="例如 08:05|LAL|GSW"/></label>
      <button className="secondary" type="submit" disabled={busy}>{busy ? '讀取中…' : '查詢補傳擷取'}</button>
    </form>
    {error && <p role="alert" className={styles.invalid}>{error}</p>}
    {page && <>
      <p className={styles.muted}>符合篩選 {page.totalCount.toLocaleString('zh-TW')} 筆擷取｜已載入 {page.records.length.toLocaleString('zh-TW')} 筆｜存入截點 {taipeiHistoryTime(page.until)}。清單依實際存入順序；點選後核對完整內容。</p>
      {page.records.length === 0 ? <p>沒有符合條件的補傳擷取；不代表沒有比賽或開盤。</p> : <div className={styles.tableWrap}><table>
        <caption>已保存的擷取清單；不受是否下注影響</caption><thead><tr><th>聯盟／盤日</th><th>原始場次</th><th>來源觀測</th><th>實際存入</th><th>內容</th></tr></thead>
        <tbody>{page.records.map(row => <tr key={row.captureId}><th scope="row">{row.league}<small className={styles.coverageSub}>{row.boardDate}</small></th><td>{row.games.length === 0 ? '沒有可讀的場次摘要，請查看保存內容' : row.games.map((game, index) => <div key={index}>{game.away} @ {game.home} {game.boardTime}<small className={styles.coverageSub}>{game.gameKey}</small></div>)}</td><td>{taipeiHistoryTime(row.observedAt)}</td><td>{taipeiHistoryTime(row.persistedAt)}</td><td><button type="button" className="secondary" disabled={detailBusy} onClick={() => inspect(row.captureId)}>查看原盤與水位</button></td></tr>)}</tbody>
      </table></div>}
      {page.hasMore && <button type="button" className="secondary" disabled={busy} onClick={() => load(filters, page)}>{busy ? '讀取中…' : '載入下一頁補傳擷取'}</button>}
    </>}
    {detailBusy && <p role="status">正在讀回並核對擷取內容…</p>}
    {detailError && <p role="alert" className={styles.invalid}>{detailError}</p>}
    <ArchiveDetail record={detail}/>
  </section>;
}
