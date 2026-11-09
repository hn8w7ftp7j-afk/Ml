'use client';
import { useEffect, useRef, useState } from 'react';

const version = 'SOCCER-OFFICIAL-MARKET-COVERAGE-v1';
const cellLabels = [['FT:HANDICAP', '全場讓球'], ['FT:TOTAL', '全場大小'], ['HT:HANDICAP', '上半場讓球'], ['HT:TOTAL', '上半場大小']];
const count = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ids = values => Array.isArray(values) && values.every(hash) && new Set(values).size === values.length;
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const cursorValid = value => typeof value === 'string' && value.length <= 1600 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value);
const displayTime = value => instant(value) ? new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '未知';
const initial = (league, date) => ({ league, date, report: null, loading: false, error: '', notice: '' });

export function soccerOfficialCoveragePageValid(report, league, date) {
  const schedule = report?.schedule, history = report?.history;
  if (report?.version !== version || report.league !== league || report.date !== date || !['PARTIAL', 'COMPLETE_PROVIDER_SCOPE', 'NOT_VERIFIED'].includes(report.status) ||
    report.formalEligible !== false || report.executable !== false || report.coverageComplete !== false || schedule?.sourceScope !== 'RETURNED_PROVIDER_PAGES_ONLY' || schedule.providerCompletenessVerified !== false ||
    !hash(schedule.fingerprint) || !count(schedule.officialGameCount) || typeof schedule.empty !== 'boolean' || schedule.empty !== (schedule.officialGameCount === 0) || typeof schedule.sourceVerified !== 'boolean' ||
    !hash(history?.snapshotHash) || !instant(history.cutoffAt) || !(history.totalReceipts === null || count(history.totalReceipts)) || !['readFrom', 'readCount', 'readThrough'].every(key => count(history[key])) ||
    history.readThrough !== history.readFrom + history.readCount || history.totalReceipts !== null && history.readThrough > history.totalReceipts || typeof history.hasMore !== 'boolean' || typeof history.scopeComplete !== 'boolean' ||
    history.historicalAvailabilityVerified !== false || !['VERIFIED_PAGE', 'NOT_VERIFIED'].includes(history.integrityStatus) ||
    (history.hasMore ? !cursorValid(history.nextCursor) || history.readCount === 0 || history.totalReceipts === null || history.readThrough >= history.totalReceipts : history.nextCursor !== null) ||
    history.scopeComplete && (history.readFrom !== 0 || history.readThrough !== history.totalReceipts || history.hasMore || history.integrityStatus !== 'VERIFIED_PAGE') ||
    report.status === 'COMPLETE_PROVIDER_SCOPE' && (!history.scopeComplete || schedule.empty || !schedule.sourceVerified) ||
    !Array.isArray(report.games) || report.games.length !== schedule.officialGameCount || new Set(report.games.map(game => game.gameId)).size !== report.games.length ||
    !Array.isArray(report.diagnostics?.reasonCodes) || !['AVAILABLE', 'NO_ACTIVE_HEAD', 'NOT_VERIFIED'].includes(report.diagnostics.currentStatus) || !instant(report.diagnostics.currentAsOf) || !Array.isArray(report.unmatched) || !Array.isArray(report.currentUnmatched)) return false;
  const unmatchedValid = rows => rows.every(row => hash(row?.key) && typeof row.label === 'string' && ['UNMATCHED', 'AMBIGUOUS'].includes(row.status) && count(row.observationCount));
  if (!unmatchedValid(report.unmatched) || !unmatchedValid(report.currentUnmatched)) return false;
  return report.games.every(game => {
    if (!new RegExp(`^soccer:${league}:\\d{1,16}$`).test(game.gameId || '') || typeof game.label !== 'string' || !instant(game.startTime) || !count(game.seen?.unknownPeriodQuoteCount) || !game.current) return false;
    if (!cellLabels.every(([key]) => {
      const cell = game.seen.cells?.[key];
      return cell && ['marketIds', 'completeMarketIds', 'quoteIds'].every(field => ids(cell[field])) && cell.completeMarketIds.every(value => cell.marketIds.includes(value));
    })) return false;
    if (game.current.status === 'NOT_VERIFIED') return game.current.cells === null;
    return ['AVAILABLE', 'NO_ACTIVE_HEAD'].includes(game.current.status) && cellLabels.every(([key]) => {
      const cell = game.current.cells?.[key];
      return cell && ['marketCount', 'completePriceMarketCount', 'freshPregameMarketCount', 'quoteCount'].every(field => count(cell[field])) && cell.freshPregameMarketCount <= cell.completePriceMarketCount && cell.completePriceMarketCount <= cell.marketCount;
    });
  });
}

export function mergeSoccerOfficialCoveragePage(previous, page, league, date) {
  if (!soccerOfficialCoveragePageValid(page, league, date)) throw Error('核對回應範圍不一致，數量未知。');
  const history = page.history;
  if (!previous && history.readFrom !== 0 || previous && (previous.history.snapshotHash !== history.snapshotHash || previous.history.cutoffAt !== history.cutoffAt ||
    previous.schedule.fingerprint !== page.schedule.fingerprint || previous.history.totalReceipts !== history.totalReceipts || previous.history.readThrough !== history.readFrom ||
    previous.games.map(game => game.gameId).sort().join('|') !== page.games.map(game => game.gameId).sort().join('|'))) throw Error('來源版本或連續讀取進度不一致，請重新核對。');
  const priorGames = new Map((previous?.games || []).map(game => [game.gameId, game]));
  const games = page.games.map(game => {
    const old = priorGames.get(game.gameId);
    return { ...game, seen: { cells: Object.fromEntries(cellLabels.map(([key]) => [key, Object.fromEntries(['marketIds', 'completeMarketIds', 'quoteIds'].map(field =>
      [field, [...new Set([...(old?.seen.cells[key][field] || []), ...game.seen.cells[key][field]])]]))])), unknownPeriodQuoteCount: (old?.seen.unknownPeriodQuoteCount || 0) + game.seen.unknownPeriodQuoteCount } };
  });
  const unmatched = new Map((previous?.unmatched || []).map(row => [row.key, row]));
  for (const row of page.unmatched) unmatched.set(row.key, { ...row, observationCount: (unmatched.get(row.key)?.observationCount || 0) + row.observationCount });
  const verified = history.integrityStatus === 'VERIFIED_PAGE' && (!previous || previous.history.integrityStatus === 'VERIFIED_PAGE');
  return { ...page, games, unmatched: [...unmatched.values()], history: { ...history, readFrom: 0, readCount: history.readThrough, integrityStatus: verified ? 'VERIFIED_PAGE' : 'NOT_VERIFIED' },
    sourceReadComplete: verified && history.totalReceipts !== null && history.readThrough === history.totalReceipts && !history.hasMore };
}
const aborted = () => Object.assign(Error('aborted'), { name: 'AbortError' });
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted()); return; }
    const cancel = () => { clearTimeout(timer); reject(aborted()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export function SoccerOfficialMarketCoveragePanel({ league, date, active = true }) {
  const supported = ['epl', 'ucl'].includes(league) && /^\d{4}-\d\d-\d\d$/.test(date || ''), current = useRef(null);
  const [state, setState] = useState(initial(league, date));
  async function run(scope, { continueAll = false, reset = false } = {}) {
    if (!scope?.active || scope.running) return;
    scope.running = true; const controller = new AbortController(); scope.controller = controller;
    let aggregate = reset ? null : scope.report, cursor = aggregate?.history.nextCursor || null, restarts = 0, throttles = 0;
    const update = patch => { if (scope.active && current.current === scope) setState(old => ({ ...old, ...patch })); };
    update({ loading: true, error: '', notice: '', ...(reset ? { report: null } : {}) });
    try {
      for (let page = 0; page < 10010; page++) {
        const params = new URLSearchParams({ league: scope.league, date: scope.date, ...(cursor ? { cursor } : {}) });
        const requestController = new AbortController(), cancel = () => requestController.abort(); controller.signal.addEventListener('abort', cancel, { once: true });
        if (controller.signal.aborted) requestController.abort();
        const timeout = setTimeout(() => requestController.abort(), 35000); let response, body;
        try { response = await fetch(`/api/soccer/market-coverage?${params}`, { cache: 'no-store', signal: requestController.signal }); body = await response.json(); }
        finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', cancel); }
        if (!scope.active || current.current !== scope || controller.signal.aborted) return;
        if (response.status === 429 && throttles++ < 3) {
          const retry = Number(response.headers.get('Retry-After'));
          update({ notice: '等待請求額度後繼續核對。' }); await pause(Math.max(1, Math.min(60, Number.isFinite(retry) ? retry : 60)) * 1000, controller.signal); continue;
        }
        if (response.status === 409 && body.code === 'SOCCER_MARKET_COVERAGE_SCOPE_CHANGED' && restarts++ < 2) {
          aggregate = null; cursor = null; scope.report = null; update({ report: null, notice: '來源範圍已變更，從第一筆重新核對。' }); await pause(1100, controller.signal); continue;
        }
        if (!response.ok || body.ok !== true) throw Error(response.status === 401 ? '登入已過期，請重新登入。' : '官方賽程或原盤暫時無法核對，數量未知。');
        aggregate = mergeSoccerOfficialCoveragePage(aggregate, body.report, scope.league, scope.date); scope.report = aggregate;
        update({ report: aggregate, notice: '' }); cursor = aggregate.history.nextCursor;
        if (!continueAll || !aggregate.history.hasMore) return;
        await pause(1100, controller.signal);
      }
      throw Error('本次讀取範圍尚未完成，可繼續核對。');
    } catch (error) {
      if (scope.active && current.current === scope) update({ error: error.name === 'AbortError' ? '核對已暫停或逾時，已讀進度可繼續。' : '來源未通過核對或暫時無法讀取，完整數量未知。' });
    } finally { scope.running = false; scope.controller = null; update({ loading: false }); }
  }
  useEffect(() => {
    const scope = { league, date, active: active && supported, running: false, report: null, controller: null }; current.current = scope;
    setState(initial(league, date)); if (scope.active) void run(scope);
    return () => { scope.active = false; scope.controller?.abort(); if (current.current === scope) current.current = null; };
  }, [league, date, active, supported]);
  if (!supported || !active) return null;
  const entry = state.league === league && state.date === date ? state : initial(league, date), report = entry.report;
  const seenVerified = report?.history.integrityStatus === 'VERIFIED_PAGE', complete = report?.sourceReadComplete === true;
  const seenLabel = cell => !seenVerified ? '未知' : cell.marketIds.length ? `${cell.marketIds.length} 盤線（雙邊 ${cell.completeMarketIds.length}）` : complete ? '未見' : '本輪未見';
  return <section className="soccerCalibrationGroup" aria-label="官方賽程與原盤市場覆蓋">
    <h3>官方賽程與原盤市場覆蓋</h3>
    <p>核對全場／上半場讓球與大小。曾見原盤、目前可用報價分開計算；正式評分仍以各場分析結果為準。</p>
    {entry.loading && !report && <p role="status">正在核對官方賽程與保存原盤</p>}
    {report && <>
      <p role="status">{complete && !report.schedule.empty ? '來源範圍讀取完成' : 'PARTIAL'}｜官方來源本次返回 {report.schedule.officialGameCount} 場｜已核對 {report.history.readThrough}／{report.history.totalReceipts === null ? '未知' : report.history.totalReceipts} 筆原盤收據</p>
      <p>只涵蓋官方來源實際返回的頁面，尚未證明所有賽程或所有盤線已收齊。未見原盤不代表未開盤或 Reader 漏抓。</p>
      {report.schedule.empty && <p>官方來源本次未返回賽事，無法據此宣稱當天沒有比賽。</p>}
      {report.games.length > 0 && <div className="soccerTableWrap"><table className="soccerAuditTable"><thead><tr><th>官方賽事</th>{cellLabels.map(([key, label]) => <th key={key}>{label}<br/>曾見／目前有效</th>)}</tr></thead><tbody>
        {report.games.map(game => <tr key={game.gameId}><td>{game.label}<br/>{displayTime(game.startTime)}</td>{cellLabels.map(([key]) => <td key={key}>{seenLabel(game.seen.cells[key])}<br/>{game.current.cells === null ? '目前未知' : `有效 ${game.current.cells[key].freshPregameMarketCount} 盤線`}</td>)}</tr>)}
      </tbody></table></div>}
      <p>目前有效：已配對、時段可確認、雙邊水位完整、DB 已收件、三分鐘內且尚未開賽。替代盤線各自列計，同場全場／半場合計仍是一場。</p>
      <p>保存原盤未配對 {seenVerified ? report.unmatched.length : '未知'} 組｜目前原盤未配對 {report.diagnostics.currentStatus === 'NOT_VERIFIED' ? '未知' : report.currentUnmatched.length} 組｜已配對但時段未知報價 {seenVerified ? report.games.reduce((n, game) => n + game.seen.unknownPeriodQuoteCount, 0) : '未知'} 筆</p>
      {report.unmatched.length > 0 && <details><summary>查看未配對原盤</summary><ul>{report.unmatched.map(row => <li key={row.key}>{row.label}：{row.status === 'AMBIGUOUS' ? '官方候選身分衝突' : '未找到唯一同隊伍、同時間賽事'}（{row.observationCount} 次出現）</li>)}</ul></details>}
      <p>保存資料截點 {displayTime(report.history.cutoffAt)}｜目前報價核對 {displayTime(report.diagnostics.currentAsOf)}</p>
      {Array.isArray(report.schedule.sources) && report.schedule.sources.length > 0 && <details><summary>賽程來源與更新時間</summary><ul>{report.schedule.sources.map(source => <li key={source.url}>{source.provider}：{displayTime(source.fetchedAt)} <a href={source.url} target="_blank" rel="noreferrer">來源頁面</a></li>)}</ul></details>}
      {!seenVerified && <p role="alert">原盤來源範圍尚未通過完整核對，數量未知。</p>}
    </>}
    {entry.notice && <p role="status">{entry.notice}</p>}{entry.error && <p role="alert">{entry.error}</p>}
    <div className="rankingViewTabs">
      {entry.loading ? <button className="secondary" onClick={() => current.current?.controller?.abort()}>暫停核對</button> : <button onClick={() => run(current.current, { continueAll: true, reset: !report?.history.hasMore })}>{report?.history.hasMore ? '繼續核對來源' : '重新核對來源'}</button>}
      {report?.history.hasMore && <button className="secondary" disabled={entry.loading} onClick={() => run(current.current, { continueAll: true, reset: true })}>重新開始核對</button>}
    </div>
  </section>;
}
