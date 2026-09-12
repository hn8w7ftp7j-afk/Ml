'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { csvText, diagnosticView, field, numberText, percentText, signedPercentText, sourceStateText, valueText } from '../../../lib/over-diagnostic-view.js';
import './over.css';

const tabs = [['funnel', '選盤漏斗'], ['chain', '得分計算鏈'], ['pitching', '先發與牛棚'], ['coverage', '條件與來源']];
const fmt = (value, type) => type === 'percent' ? percentText(value) : type === 'number' ? numberText(value) : type === 'state' ? sourceStateText(value) : valueText(value);
function download(filename, text, mime = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function GameDetails({ row }) {
  const [game, setGame] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function loadDetail() {
    if (game || busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/diagnostics/over?gameId=${encodeURIComponent(row.gameId)}`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '逐場明細讀取失敗');
      if (String(result.data?.game?.gameId) !== String(row.gameId)) throw new Error('逐場資料身分不一致');
      setGame(result.data);
    } catch (cause) { setError(cause.name === 'TimeoutError' ? '讀取逾時，請重試。' : cause.message); }
    finally { setBusy(false); }
  }
  return <details onToggle={event => { if (event.currentTarget.open) loadDetail(); }}><summary>展開明細</summary>
    {busy && <p role="status">正在讀取此場來源與計算明細…</p>}
    {error && <p role="alert">{error} <button onClick={loadDetail}>重試明細</button></p>}
    {game && <><button onClick={() => download(`MLB-${row.gameId}-diagnostic.json`, JSON.stringify(game, null, 2), 'application/json')}>下載此場 JSON</button><pre>{JSON.stringify(game, null, 2)}</pre></>}
  </details>;
}
function DataTable({ rows = [], columns = [], label, details = false, paged = true }) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [rows]);
  const count = Math.max(1, Math.ceil(rows.length / 25));
  const current = Math.min(page, count - 1);
  const shown = paged ? rows.slice(current * 25, current * 25 + 25) : rows;
  return <div className="od-table-block">
    <div className="od-table-tools"><span>{rows.length} 筆</span><button disabled={!rows.length} onClick={() => download(`MLB-${label}.csv`, csvText(rows))}>下載此表 CSV</button></div>
    {!rows.length ? <p className="od-empty">此範圍沒有可顯示的紀錄。</p> : <div className="od-table-scroll" role="region" aria-label={label} tabIndex={0}><table><caption>{label}</caption><thead><tr>{columns.map(column => <th scope="col" key={column.key}>{column.label}</th>)}{details && <th scope="col">逐場來源與計算</th>}</tr></thead><tbody>{shown.map((row, index) => <tr key={`${row.gameId ?? row.id ?? current}:${index}`}>{columns.map(column => <td key={column.key}>{column.render ? column.render(row) : fmt(field(row, column.key), column.type)}</td>)}{details && <td><GameDetails row={row}/></td>}</tr>)}</tbody></table></div>}
    {paged && count > 1 && <div className="od-pager"><button disabled={current === 0} onClick={() => setPage(current - 1)}>上一頁</button><span>第 {current + 1} / {count} 頁 · 每頁 25 筆</span><button disabled={current + 1 >= count} onClick={() => setPage(current + 1)}>下一頁</button></div>}
  </div>;
}
const identity = [{ key: 'gameId', label: '賽事 ID' }, { key: 'gameDate', label: '比賽日期' }, { key: 'matchup', label: '客隊 @ 主隊' }, { key: 'selected', label: '模擬選中' }];
const gameColumns = [...identity, { key: 'batch', label: '來源批次' }, { key: 'line', label: '門檻摘要', type: 'number' }, { key: 'delta', label: '預測−門檻', type: 'number' }, { key: 'bias', label: '得分偏差', type: 'number' }, { key: 'W', label: '估計 W', type: 'percent' }, { key: 'R', label: '保守 R', type: 'percent' }, { key: 'S', label: '評分 S', type: 'number' }];
const countText = value => Number.isInteger(value) && value >= 0 ? String(value) : '未提供';
function FrozenSummary({ summary }) {
  if (!summary?.available) return <p className="od-notice">未提供最終模擬選中階段，無法顯示該組的 EV 與歷史收益摘要；不以其他階段代替。</p>;
  return <section className="od-frozen-summary" aria-labelledby="od-frozen-title">
    <div className="od-summary-heading"><div><p className="od-eyebrow">凍結歷史樣本 · 最終模擬選中</p><h2 id="od-frozen-title">MLB 全場大分：{countText(summary.selectedN)} 場</h2></div><span className="od-summary-state">僅供研究</span></div>
    <p className="od-summary-intro">先看清楚：模型估計的優勢，與這批歷史比賽實際模擬出的收益，是兩件事。</p>
    <div className="od-ev-cards">
      <div className="od-ev-card"><span>模型估計 EV（平均 W）</span><strong>{signedPercentText(summary.modelW)}</strong><small>原模型對這批選中合約的平均估計</small></div>
      <div className="od-ev-card"><span>保守估計 EV（平均 R）</span><strong>{signedPercentText(summary.modelR)}</strong><small>原模型的保守情境估計，非保證收益</small></div>
      <div className="od-ev-card od-ev-realized"><span>歷史模擬 ROI（含退水）</span><strong>{signedPercentText(summary.roi)}</strong><small>已結算模擬淨收益 ÷ 對應投入單位</small></div>
    </div>
    <dl className="od-outcomes">
      <div><dt>模擬勝／敗／走（退水前）</dt><dd>{countText(summary.wins)}／{countText(summary.losses)}／{countText(summary.pushes)}</dd></div>
      <div><dt>模擬淨收益（含退水）</dt><dd>{numberText(summary.netUnits, 2)} 注</dd></div>
      <div><dt>模擬投入</dt><dd>{numberText(summary.stakeUnits, 0)} 注</dd></div>
      <div><dt>勝率（排除走水）</dt><dd>{percentText(summary.winRateExcludingPush)}<small>分母：{countText(summary.winLossN)} 場勝敗</small></dd></div>
    </dl>
    <p className="od-summary-denominator">可結算 {countText(summary.settlementN)} 場；缺賽果 {countText(summary.missingOutcomeN)} 場。每場合約原定投入 1 注，走水保留在投入分母；缺失不當作 0 收益。</p>
    <p className="od-summary-caution">這是整批歷史樣本摘要，不是目前單場 EV，也不是你的實際下注帳本。歷史 ROI 不等於已知的未來真實 EV；這批資料已用於研究，不是新模型的獨立驗證。</p>
    <div className="od-summary-provenance"><p><span>全部有效大分日期</span> {valueText(summary.fromDate)} ～ {valueText(summary.toDate)}（{countText(summary.dateCount)} 個有資料日期；非每日完整收錄）。其中選中組涵蓋 {countText(summary.selectedDateCount)} 個日期。</p><p><span>歷史模型版本</span> {valueText(summary.modelVersion)}</p><p><span>診斷版本／產生時間</span> {valueText(summary.diagnosticVersion)} · {valueText(summary.createdAt)}</p></div>
  </section>;
}
function SummaryCards({ inventory, summary }) {
  return <div className="od-cards">{[
    ['歷史清冊', inventory.totalGames, '場賽事'], ['有效全場大分', inventory.validOverMarkets, '個市場'], ['模擬選中', summary.selectedN, '個合約 · 原歷史篩選'], ['選中組偏差', summary.bias, '分 · 預測減實際'],
  ].map(([label, value, unit]) => <div className="od-card" key={label}><span>{label}</span><strong>{typeof value === 'number' ? (label === '選中組偏差' ? `${value > 0 ? '+' : ''}${value.toFixed(3)}` : value) : '未提供'}</strong><small>{unit}</small></div>)}</div>;
}
export default function OverDiagnostics() {
  const [rawData, setRawData] = useState(null), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const data = useMemo(() => rawData ? diagnosticView(rawData) : null, [rawData]);
  const [tab, setTab] = useState('funnel'), [query, setQuery] = useState(''), [selection, setSelection] = useState('all'), [batch, setBatch] = useState('all');
  const load = useCallback(async signal => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/diagnostics/over', { cache: 'no-store', signal });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '診斷資料讀取失敗');
      setRawData(result.data);
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.name === 'TimeoutError' ? '讀取逾時，請重試。' : cause.message); }
    finally { if (signal?.reason?.name !== 'AbortError') setBusy(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); load(AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])); return () => controller.abort(); }, [load]);
  const games = data?.games || [];
  const filter = useCallback(row => (selection === 'all' || row.selected === (selection === 'selected')) && (batch === 'all' || row.batch === batch) && (!query || `${row.gameId} ${row.gameDate} ${row.matchup}`.toLowerCase().includes(query.toLowerCase())), [selection, batch, query]);
  const selectedGames = useMemo(() => games.filter(filter), [games, filter]);
  const ids = useMemo(() => new Set(selectedGames.map(row => String(row.gameId))), [selectedGames]);
  const chainRows = useMemo(() => (data?.calculationChain || []).filter(row => ids.has(String(row.gameId))), [data, ids]);
  const pitchingRows = useMemo(() => (data?.pitchingAllocation || []).filter(row => ids.has(String(row.gameId))), [data, ids]);
  const manifest = data?.manifest || {}, stages = data?.funnel?.stages || [];
  return <main className="od-shell">
    <header className="od-header"><div><Link href="/" prefetch={false}>← 返回分析網站</Link><p className="od-eyebrow">MLB · HISTORICAL DIAGNOSTICS · 1.1</p><h1>研究回測｜全場大分</h1><p>追查得分預測與選盤各階段的落差。本頁呈現凍結資料的歷史模擬。</p></div><span className="od-badge">研究回測 · 唯讀</span></header>
    {data && <FrozenSummary summary={data.frozenSummary}/>}
    <div className="od-notice">此頁保留原版的歷史模擬選中結果，與目前網站的研究觀察狀態分開；不因停用市場而改寫歷史選中數。得分模型與 S／W／R 公式未改，歷史重播不代表新模型已驗證或未來獲利。</div>
    <div className="od-notice">來源保存狀態（2026-09-12）：539 場診斷與 4,539 筆代表來源紀錄已保存。本次環境清理後，33,504 筆完整來源集合尚未恢復；明細中的完整檔名與雜湊是先前紀錄，不代表該完整檔目前可下載。以下 JSON.gz 是代表紀錄版本，並非完整來源集合，不能視為全部來源已完整驗證。</div>
    <div className="od-actions"><button disabled={busy} onClick={() => load(AbortSignal.timeout(30000))}>{busy ? '讀取中…' : '重新載入資料'}</button>{data && <a className="od-download" href="/api/diagnostics/over?download=1" download="MLB-over-diagnostic-data.json.gz">下載診斷資料 JSON.gz</a>}</div>
    {error && <p className="od-error" role="alert">{error}</p>}
    {busy && !data && <p role="status">正在讀取已保存的診斷結果…</p>}
    {data && <>
      <SummaryCards inventory={data.inventory || {}} summary={data.frozenSummary}/>
      <details className="od-manifest"><summary>資料範圍、模型版本與限制</summary><dl>{Object.entries(manifest).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{valueText(value)}</dd></div>)}</dl><ul>{(data.limitations || []).map((note, index) => <li key={index}>{typeof note === 'string' ? note : JSON.stringify(note)}</li>)}</ul><p>空值顯示「未提供」。來源確認與賽前可得性分開記錄；環境係數等於 1，不直接代表缺失。</p></details>
      <nav className="od-tabs" aria-label="四張排查表">{tabs.map(([key, label]) => <button key={key} aria-pressed={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</nav>
      {tab !== 'funnel' && <div className="od-filters"><label>賽事搜尋<input placeholder="Game ID、隊伍或日期" value={query} onChange={event => setQuery(event.target.value)}/></label><label>模擬選中<select value={selection} onChange={event => setSelection(event.target.value)}><option value="all">全部可計算大分</option><option value="selected">模擬選中</option><option value="unselected">未選中</option></select></label><label>來源批次<select value={batch} onChange={event => setBatch(event.target.value)}><option value="all">全部批次</option>{[...new Set(games.map(row => row.batch).filter(Boolean))].map(value => <option key={value}>{value}</option>)}</select></label><span>符合篩選：{selectedGames.length} 場</span></div>}
      {tab === 'funnel' && <section><h2>偏差在哪個階段增加？</h2><p>Bias 是比賽總得分的預測減實際，單位為「分」。各階段收益是假設該階全部合約各投入 1 單位的歷史模擬，包含既定退水，並非實際下注帳本。</p><DataTable label="逐階選盤漏斗" paged={false} rows={stages} columns={[
        { key: 'label', label: '篩選階段' }, { key: 'n', label: '可計算數' }, { key: 'evaluatedN', label: '有賽果數' }, { key: 'missingOutcomeN', label: '缺賽果數' }, { key: 'bias', label: '平均 Bias', type: 'number' }, { key: 'ci.bias', label: 'Bias 95% 區間', render: row => `${numberText(row.ci?.bias?.low)} ～ ${numberText(row.ci?.bias?.high)}` }, { key: 'mae', label: 'MAE', type: 'number' }, { key: 'rmse', label: 'RMSE', type: 'number' }, { key: 'meanMu', label: '平均預測總分', type: 'number' }, { key: 'meanActual', label: '平均實際總分', type: 'number' }, { key: 'netUnits', label: '模擬淨收益 u', type: 'number' }, { key: 'meanW', label: '模型估計 EV（平均 W）', type: 'percent' }, { key: 'meanR', label: '保守估計 EV（平均 R）', type: 'percent' }, { key: 'meanScore', label: '平均評分 S', type: 'number' }, { key: 'winRateExcludingPush', label: '勝率（排除走水）', type: 'percent' }, { key: 'meanNetProfit', label: '歷史模擬 ROI（含退水）', type: 'percent' },
      ]}/><h2>相鄰階段的偏差差值</h2><p>兩階段使用同次日期群集重抽樣。正差值表示留下樣本的帶正負號偏差較高；不單憑此表判定篩選規則造成錯誤。</p><DataTable label="同抽樣偏差差值" paged={false} rows={data.funnel.transitions || []} columns={[
        { key: 'label', label: '相鄰階段' }, { key: 'deltaBias', label: 'Bias 差值', type: 'number' }, { key: 'ciLow', label: '95% 區間下界', type: 'number' }, { key: 'ciHigh', label: '95% 區間上界', type: 'number' }, { key: 'validDraws', label: '有效抽樣次數' }, { key: 'interpretation', label: '探索性解讀' },
      ]}/><details className="od-manifest"><summary>抽樣方法與原始清冊狀態</summary><p>{data.funnel.bootstrap?.draws ?? '未提供'} 次日期群集抽樣，{data.funnel.bootstrap?.nDateClusters ?? '未提供'} 個日期群，種子 {data.funnel.bootstrap?.seed ?? '未提供'}。各階段共用抽樣，區間未作多重比較校正；空樣本留空並計數。</p><p>全部 {data.inventory?.totalGames ?? '未提供'} 場，可計算 {data.inventory?.computableGames ?? '未提供'} 場。詳細狀態清册保留於完整 JSON。</p><pre>{JSON.stringify(data.inventory?.statusCounts || {}, null, 2)}</pre></details></section>}
      {tab === 'chain' && <section><h2>逐場得分計算鏈</h2><p>主客隊分列基準、實際乘數與補值。預定局段均值與終局矩陣均值分開；來源、截斷和時間證據可展開。同場合約的 W／R／S／收益僅重複參照，不可把兩列收益相加。</p><DataTable label="逐場得分計算鏈" details rows={chainRows} columns={[
        ...identity, { key: 'side', label: '進攻方' }, { key: 'baselineRuns', label: '聯盟基準分', type: 'number' }, { key: 'baselineDataVersion', label: '基準資料版本' }, { key: 'offenseMultiplier', label: '進攻乘數', type: 'number' }, { key: 'starterMultiplier', label: '先發乘數', type: 'number' }, { key: 'bullpenMultiplier', label: '牛棚乘數', type: 'number' }, { key: 'park.appliedValue', label: '球場使用值', type: 'number' }, { key: 'park.sourceStatus', label: '球場來源', type: 'state' }, { key: 'weather.appliedValue', label: '天氣使用值', type: 'number' }, { key: 'weather.sourceStatus', label: '天氣來源', type: 'state' }, { key: 'scheduledMean', label: '預定得分', type: 'number' }, { key: 'terminatedMean', label: '終局得分', type: 'number' }, { key: 'W', label: '市場 W', type: 'percent' }, { key: 'R', label: '市場 R', type: 'percent' }, { key: 'S', label: 'S', type: 'number' }, { key: 'net', label: '合約模擬淨收益 u', type: 'number' },
      ]}/></section>}
      {tab === 'pitching' && <section><h2>先發與牛棚分工</h2><p>依防守方分列出局數。終局比分矩陣未保存出局路徑，預期完賽出局數保留未提供；診斷分解不冒充原生責任失分。</p><DataTable label="先發牛棚分工" details rows={pitchingRows} columns={[
        ...identity, { key: 'defendingSide', label: '防守方' }, { key: 'starterBranch', label: '局數推估分支' }, { key: 'modelBranch', label: '實際模型分支' }, { key: 'starterFallbackApplied', label: '局數補值' }, { key: 'starterExpectedInnings', label: '先發預期局數', type: 'number' }, { key: 'starterExpectedOuts', label: '先發預期出局數', type: 'number' }, { key: 'bullpenExpectedOuts', label: '牛棚預期出局數', type: 'number' }, { key: 'scheduledOuts', label: '預定出局數', type: 'number' }, { key: 'terminatedExpectedOuts', label: '預期完賽出局數', type: 'number' }, { key: 'starterContribution', label: '先發診斷貢獻', type: 'number' }, { key: 'bullpenContribution', label: '牛棚診斷貢獻', type: 'number' },
      ]}/></section>}
      {tab === 'coverage' && <section><h2>批次 × 特徵狀態與條件分組</h2><p>下方彙總為完整凍結母體，不隨逐場搜尋變更。來源批次與特徵狀態高度重疊時，無法單獨歸因於某一欄位；沒有對照或樣本不足的格子照實保留。收縮與補值可同時發生。</p><DataTable label="來源與條件偏差分組" rows={data.coverage?.groups || []} columns={[
        { key: 'group', label: '分組' }, { key: 'n', label: '場數' }, { key: 'selectedN', label: '選中數' }, { key: 'selectionRate', label: '選中率', type: 'percent' }, { key: 'bias', label: '整體 Bias', type: 'number' }, { key: 'mae', label: 'MAE', type: 'number' }, { key: 'selectedBias', label: '選中 Bias', type: 'number' }, { key: 'unselectedBias', label: '未選 Bias', type: 'number' },
       ]}/><h2>同條件下的選中與未選中</h2><p>Δ 是預測總分減盤口門檻。同一格仍不代表條件完全相同；少於 30 場只作樣本支持提醒，不是新篩選門檻。</p><DataTable label="條件對照與樣本支持" rows={data.conditionalComparisons || []} paged={false} columns={[
        { key: 'deltaBin', label: 'Δ 區間' }, { key: 'lineBin', label: '門檻區間' }, { key: 'selected.n', label: '選中場數' }, { key: 'unselected.n', label: '未選場數' }, { key: 'selected.nDates', label: '選中日期數' }, { key: 'unselected.nDates', label: '未選日期數' }, { key: 'selectedMinusUnselectedBias', label: 'Bias 差', type: 'number' }, { key: 'ci.low', label: '95% 下界', type: 'number' }, { key: 'ci.high', label: '95% 上界', type: 'number' }, { key: 'support', label: '樣本支持', render: row => ({NO_OVERLAP:'沒有雙組對照',SMALL_GROUP:'小樣本',BOTH_GROUPS_AT_LEAST_30:'雙組至少 30 場'}[row.support] || row.support) }, { key: 'singleClusterDegeneracyWarning', label: '單一日期警告' },
      ]}/><h2>模型輸入在各組的差異</h2><DataTable label="計算鏈條件均值" rows={data.componentGroups || []} paged={false} columns={[
        { key: 'group', label: '組別' }, { key: 'n', label: '場數' }, { key: 'mean_line', label: '平均門檻', type: 'number' }, { key: 'meanMu', label: '平均預測總分', type: 'number' }, { key: 'meanActual', label: '平均實際總分', type: 'number' }, { key: 'bias', label: 'Bias', type: 'number' }, { key: 'meanStarterIP', label: '先發預期局數', type: 'number' }, { key: 'meanBullpenFactor', label: '牛棚使用乘數', type: 'number' }, { key: 'meanOffense_finalFactor', label: '進攻使用乘數', type: 'number' }, { key: 'environmentFallbackGames', label: '環境補值場數' },
      ]}/><h2>符合上方篩選的逐場市場</h2><DataTable label="逐場條件對照" details rows={selectedGames} columns={gameColumns}/></section>}
    </>}
  </main>;
}
