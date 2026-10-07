'use client';
import { useEffect, useState } from 'react';

const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—';
const number = value => Number.isFinite(value) ? value.toFixed(4) : '—';
const markets = { fullTotal: '全場大小', fullRunline: '全場讓分', firstHalfTotal: '上半大小', firstHalfRunline: '上半讓分' };
const sides = { over: '大分', under: '小分', away: '客隊', home: '主隊' };
async function request(url, action) {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(85000),
    ...(action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) } : {}) });
  const body = await response.json();
  if (!response.ok || body.ok === false) throw new Error(response.status === 401 ? '請先登入後讀取模型驗證。' : body.error || '核對暫時失敗，未新增有效樣本。');
  return body;
}
export default function NbaForwardValidationPanel() {
  const [report, setReport] = useState(null), [history, setHistory] = useState(null);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  async function refresh(action = '') {
    setBusy(action || 'read'); setError(''); setMessage('');
    const results = await Promise.allSettled([
      request('/api/nba/validation', action === 'evaluate' ? action : null),
      request('/api/nba/history-training', action === 'sync' ? action : null),
    ]);
    const messages = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') { messages.push(result.reason.message); return; }
      const value = result.value;
      if (index === 0) {
        setReport(value.report);
        if (value.summary) setMessage(`本次核對 ${value.summary.checked} 個盤口，新增 ${value.summary.created} 個，待確認 ${value.summary.pending} 個，延期 ${value.summary.deferred} 個。`);
      } else {
        setHistory(value.history);
        if (value.summary) setMessage(`歷史同步：新增 ${value.summary.saved} 場、已保存 ${value.summary.existing} 場、核對未通過 ${value.summary.failed} 場、延期 ${value.summary.deferred} 場。${value.summary.status === 'unavailable' ? '來源或保存尚未通過，不能視為完整。' : ''}`);
      }
    });
    setError(messages.join(' ')); setBusy('');
  }
  useEffect(() => { void refresh(); }, []);
  return <section className="panel" aria-label="NBA 模型前瞻驗證">
    <h2>NBA 模型驗證｜原盤口、賽前固定、賽後核對</h2>
    <p>每場每盤口固定最後一筆完整賽前分析，雙方向都保留。只統計資料庫證明在開賽前保存、並由 NBA 官方與 ESPN 核對完賽比分的預測。</p>
    <p>固定條件 S ≥ 7.2、W &gt; 0、R &gt; 0，含 1.5% 退水。缺少當時固定的 S／R 不列入篩選方向；不拿新模型補算舊選擇。</p>
    <div className="heroControls"><button className="secondary" disabled={!!busy} onClick={() => refresh()}>重新讀取驗證</button><button className="secondary" disabled={!!busy} onClick={() => refresh('evaluate')}>核對已完賽預測</button><button className="secondary" disabled={!!busy} onClick={() => refresh('sync')}>同步近期完賽歷史</button></div>
    {busy && <p role="status">核對中，請稍候…</p>}{error && <p className="errorBox" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {history && <><h3>自動更新資料</h3><p>已永久保存 {history.games} 場官方交叉核對歷史；最近取得時間 {history.latestCapturedAt || '尚無'}。每小時第 35 分排程嘗試更新與核對，來源失敗會保留待核對。</p>{history.groups.map(group => <p key={`${group.seasonYear}:${group.seasonType}`}>{group.seasonYear} 球季｜{group.seasonType}：{group.games} 場，比分截止 {group.through}。</p>)}<p>完賽歷史只供較晚日期預測；採節奏估計代理值，不代表當時已知傷停、先發或上場分鐘。</p></>}
    {report && <><p>觀察日期 {report.range?.from || '—'} 至 {report.range?.through || '—'}。以下為保存版本合計；目前模型的成績須按下表模型／引擎版本分開看，不把舊版成績當新版改善。</p><div className="detailGrid"><div><span>不同完賽場次</span><b>{report.distinctGames ?? '—'}</b></div><div><span>已核對盤口</span><b>{report.evaluations ?? '—'}</b></div><div><span>待核對盤口</span><b>{report.pendingMarkets ?? '—'}</b></div><div><span>篩選方向數</span><b>{report.selected.directions ?? '—'}</b></div><div><span>篩選勝率（排除走水）</span><b>{percent(report.selected.winRateExcludingPush)}</b></div><div><span>篩選單位 ROI</span><b>{percent(report.selected.roi)}</b></div></div>
      {!report.evaluations && <p className="noticeBox">尚無核對完成的前瞻樣本，不能宣稱勝率提升。需要先保存新比賽分析，等完賽與來源核對後才能計入。</p>}
      {!!report.missingFrozenSelection && <p>有 {report.missingFrozenSelection} 個舊方向缺少固定選擇條件，只保留原預測核對，不計入篩選成績。</p>}
      {report.truncated && <p className="errorBox">報表超過讀取上限，並非完整總成績。</p>}
      {!!report.groups.length && <div style={{ overflowX: 'auto' }}><table><thead><tr><th>盤口／方向</th><th>模型／引擎版本</th><th>不同場次</th><th>篩選方向</th><th>勝／負／走</th><th>勝率</th><th>ROI</th><th>部分贏／輸</th><th>Brier（全方向）</th></tr></thead><tbody>{report.groups.map(group => <tr key={`${group.marketKey}:${group.side}:${group.modelVersion}:${group.engineVersion}`}><td>{markets[group.marketKey]}／{sides[group.side]}</td><td>{group.modelVersion}<br/>{group.engineVersion}</td><td>{group.distinctGames}</td><td>{group.selected.directions}</td><td>{group.selected.wins}／{group.selected.losses}／{group.selected.pushes}</td><td>{percent(group.selected.winRateExcludingPush)}</td><td>{percent(group.selected.roi)}</td><td>{group.selected.partialWins}／{group.selected.partialLosses}</td><td>{number(group.brier)}</td></tr>)}</tbody></table></div>}
      <p>ROI 以每方向一單位研究本金計算，含信用盤部分輸贏與退水，不是實際下注損益。部分贏列方向勝、部分輸列方向負；Brier 對照「淨信用比例 &gt; 0」事件（走水非勝）。同場雙方向並不獨立。</p></>}
    {history?.queue && <p>永久待補抓 {history.queue.pendingGames ?? '—'} 場；最早日期 {history.queue.oldestPendingDate || '無'}；最近重試 {history.queue.lastAttemptAt || '尚無'}。待核對資料不是有效訓練樣本，核對失敗不補造值。</p>}
    <p className="noticeBox">這是前瞻觀察，不是完整模型認證。傷停、確認先發、輪替與分鐘仍未校正納入模型；不開放下注執行，也不以少量樣本宣稱優於 50%。</p>
  </section>;
}
