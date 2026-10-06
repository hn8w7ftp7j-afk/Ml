'use client';
import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { NBA_TEAM_LABELS } from '../../lib/nba/labels.js';
import { taipeiDate, validDate } from '../../lib/nba/identity.js';
import { NBA_JOB_STORAGE, validNbaJob, mergeNbaAnalysisResults, nbaResultQuoteCurrent } from '../../lib/nba/analysis-job-display.js';
import { nbaMarketScore } from '../../lib/nba/market-score.js';
import NbaShadowRanking from './shadow-ranking.js';
import { NbaBetRecordProvider, NbaBetRecordButton, NbaBetRecords } from './bet-records.js';
import AnalysisNotificationControl from '../analysis-notification-control.js';
import AllLeagueProgress from '../all-league-progress.js';
import { backgroundStartWasDefinitivelyRejected } from '../../lib/background-start-request-journal.js';
import { nbaLatestBoardDate, nbaCompletionSummary } from '../../lib/nba/analysis-ui-policy.js';
import { prepareNbaNotification } from '../../lib/nba/analysis-notification-start.js';

const NbaDataWorkspace = dynamic(() => import('./workspace.js'), { ssr: false });
const name = team => NBA_TEAM_LABELS[team?.abbreviation] || team?.name || '球隊待核對';
const num = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const localTime = value => Number.isFinite(Date.parse(value || '')) ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
const statusText = value => ({ queued: '排隊中', running: '分析中', ready: '校正分析完成', reference: '跨季基準（未校正）', insufficient: '資料不足', blocked: '核對未通過', failed: '分析失敗' }[value] || '尚未分析');
const store = job => { try { localStorage.setItem(NBA_JOB_STORAGE, JSON.stringify(job)); return true; } catch { return false; } };
async function api(url, options = {}, timeout = 30000) {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...options, signal: AbortSignal.timeout(timeout) });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw Object.assign(new Error(response.status === 401 ? '登入已過期，請重新登入。' : data.error || 'NBA 資料暫時無法取得'), { status: response.status, code: data.code, jobStatus: data.status });
  return data;
}

export function NbaGameCard({ row, now, onAnalyze, busy }) {
  const result = row.result;
  const assessment = result?.assessment;
  const prediction = result?.prediction;
  const preseason = result?.preseasonAnalysis;
  const regular = result?.regularAnalysis;
  const reference = result?.status === 'reference' ? result.referencePrediction : null;
  const current = nbaResultQuoteCurrent(row, now);
  const canAnalyze = row.canAnalyze && now - Date.parse(row.observedAt) < 180000
    && now - Date.parse(row.pageActivityAt || row.observedAt) < 180000 && Date.parse(row.game.startTime) > now;
  return <section className="gameCard" data-nba-game={row.game.id}>
    <div className="gameHead"><div><h2>{name(row.game.away)}（客）@ {name(row.game.home)}（主）</h2><p>{localTime(row.game.startTime)}（台灣）｜{row.game.season?.label}｜{({ preseason: '季前賽', regular: '例行賽', postseason: '季後賽' })[row.game.seasonType] || '賽事類型待核對'}</p></div>
      <span className={`state ${row.jobState === 'ready' ? 'done' : row.jobState === 'insufficient' || row.jobState === 'blocked' ? 'unopened' : row.jobState || 'queued'}`}>{statusText(row.jobState)}</span></div>
    <div className="sourceBanner"><strong>NBA｜Tai888 Reader</strong><span>盤口時間 {localTime(row.observedAt)}｜{preseason ? '季前賽歷史校正・全場與上半場' : regular ? '同季全場與上半場・比分分開擬合' : '等待同季歷史核對'}</span></div>
    {prediction && !preseason && <div className="detailGrid"><div><span>原比分總分</span><b>{num(prediction.baseTotal)}</b></div><div><span>校正後總分</span><b>{num(prediction.total)}</b></div><div><span>總分修正</span><b>{prediction.correction > 0 ? '+' : ''}{num(prediction.correction)}</b></div><div><span>參考方向</span><b>{assessment?.direction === 'over' ? '大分' : assessment?.direction === 'under' ? '小分' : '未定'}</b></div></div>}
    {regular && <div className="detailGrid"><div><span>全場預估分差（主−客）</span><b>{num(regular.fullMargin)}</b></div><div><span>上半預估總分</span><b>{num(regular.halfTotal)}</b></div><div><span>上半預估分差（主−客）</span><b>{num(regular.halfMargin)}</b></div><div><span>上半誤差樣本</span><b>{regular.halfSamples}</b></div></div>}
    {preseason && <><div className="detailGrid"><div><span>主隊預估得分</span><b>{num(prediction.home)}</b></div><div><span>客隊預估得分</span><b>{num(prediction.away)}</b></div><div><span>全場預估總分</span><b>{num(preseason.fullTotal)}</b></div><div><span>上半預估總分</span><b>{num(preseason.halfTotal)}</b></div></div><p className="muted">季前賽校正 {preseason.trainingSamples} 場；誤差樣本 {preseason.distributionSamples} 筆。左側為 S 分數；勝率與 W／R 列於明細。</p></>}
    {reference && <><div className="noticeBox">季前賽跨季基準預估，尚未校正；不是原模型的勝率或 EV。</div><div className="detailGrid"><div><span>主隊基準得分</span><b>{num(reference.homePoints)}</b></div><div><span>客隊基準得分</span><b>{num(reference.awayPoints)}</b></div><div><span>基準總分</span><b>{num(reference.total)}</b></div><div><span>來源球季</span><b>{reference.sourceSeasonYear - 1}–{String(reference.sourceSeasonYear).slice(-2)} 例行賽</b></div></div></>}
    {['ready', 'reference'].includes(result?.status) && !current && <p className="muted">上一版分析｜盤口已更新、過期或場次已開賽；不是目前盤口的分析。</p>}
    {result?.status === 'insufficient' && <div className="noticeBox">同球季、同賽事類型校正樣本不足：目前 {result.training?.availableGames ?? 0} 筆，至少需要 {result.training?.minimumResiduals ?? 50} 筆。不以其他球季或例行賽填補。</div>}
    {(row.reason || row.jobError) && <p className="muted">{row.jobError || row.reason}</p>}
    {[['fullTotal', '全場大小'], ['fullRunline', '全場讓分'], ['firstHalfTotal', '上半大小'], ['firstHalfRunline', '上半讓分']].map(([key, label]) => {
      const modelMarket = result?.marketAnalyses?.[key];
      const supported = true;
      const analyzed = preseason || regular ? modelMarket?.status === 'ready' && modelMarket.quote : key === 'fullTotal' && result?.status === 'ready' && result.quote;
      const market = analyzed || row.quote?.[key]; const total = key.endsWith('Total');
      const choices = total ? [['over', '大分', market?.overWater, assessment?.positiveExpectedNet], ['under', '小分', market?.underWater, assessment?.negativeExpectedNet]] : [['away', `${name(row.game.away)}（客）`, market?.awayWater], ['home', `${name(row.game.home)}（主）`, market?.homeWater]];
      return <div className="marketBlock actualMarket" key={key}><h3>{label}{analyzed ? '（分析盤口）' : ''}｜{market?.line || '等待開盤'}{market && !total ? `｜${market.lineSide === 'home' ? '主隊' : '客隊'}讓分` : ''}</h3>
        {analyzed && !current && <p className="muted">目前 Reader 盤口：{row.quote?.[key]?.line || '等待開盤'}；以下估計對應上次分析的盤口與水位。</p>}
        {modelMarket && !['ready','unavailable'].includes(modelMarket.status) && <p className="muted">{modelMarket.reason}</p>}
        {market && choices.map(([side, pick, water, legacyEstimate]) => {
          const estimate = modelMarket?.status === 'ready' ? modelMarket.sides[side] : null;
          const scoring = nbaMarketScore(estimate);
          return <div className="scoreRow" key={pick}><div className={`score ${scoring?.score >= 8.5 ? 'strongest' : 'pass'}`} title="S 分數">{scoring ? scoring.score.toFixed(1) : '—'}</div><div><div className="scorePick">{pick}</div><div className="scorePrice">水位 {num(water)}</div><div className="scoreMeta">{estimate ? `模型估計勝率 ${(estimate.winProbability * 100).toFixed(2)}%｜走水 ${(estimate.pushProbability * 100).toFixed(2)}%` : supported ? statusText(row.jobState) : '盤口保留顯示，此模型尚未支援'}</div>{estimate ? <div className="scoreMeta">W {num(estimate.expectedNet)}%｜R {num(estimate.robustExpectedNet)}%（每 100 元含退水淨額）{!scoring ? '｜壓力樣本不足，暫不產生 S' : ''}</div> : analyzed ? <div className="scoreMeta">歷史分布估計淨額：每 100 元 {num(legacyEstimate)} 元（含退水）</div> : null}</div><span className="state shadow">{estimate ? '模型估計' : supported ? '分析參考' : '未支援'}</span><NbaBetRecordButton entry={{ game: row.game, marketKey: key, side, line: market.line, lineSide: total ? null : market.lineSide, water, away: name(row.game.away), home: name(row.game.home) }}/></div>;
        })}
      </div>;
    })}
    <button className="secondary" disabled={busy || !canAnalyze} onClick={() => onAnalyze(row.game.sourceId)}>{row.result ? '重新分析這一場' : '分析這一場'}</button>
    <details className="details"><summary>分析原因與資料截止</summary>
      {regular ? <><p>全場大小保留節奏與休息校正；全場讓分採主客比分差。上半場由已核對前兩節比分另行擬合，排除延長賽。</p><p>資料截止 {regular.through}；全場誤差 {regular.fullSamples} 筆，上半場 {regular.halfSamples} 筆。只使用同球季、同賽制且日期較早的結果。</p><p>W 使用最近資料權重（半衰期 30 天）；R 取前三個互不重疊的 30 天區塊與 W 的最低值，每區需 30 筆，不足不產生 R／S。</p>{regular.limitations.map(text => <p key={text}>{text}</p>)}</> : preseason ? <><p>以上一季兩隊得分與失分作為輸入，用較早季前賽擬合總分和分差；全場及上半場分開校正。固定 ridge 縮減係數，沒有直接將大分改選小分。</p><p>訓練球季 {preseason.sourceSeasonYears.join('、')}，資料截止 {preseason.through}。誤差按逐場較早日期產生，同日與未來結果不納入。</p><p>各盤口依當前讓分方、信用盤部分輸贏與雙邊水位，計算勝／負／走水及每 100 元淨額。估計不代表實際歷史下注勝率。</p>{preseason.validation?.map(record => <p key={record.seasonYear}>歷史時間切分 {record.seasonYear} 球季 {record.samples} 場：全場總分平均誤差 {num(record.metrics.fullTotal.modelMAE)}（上季基準 {num(record.metrics.fullTotal.previousRegularBaselineMAE)}）；全場分差 {num(record.metrics.fullMargin.modelMAE)}（基準 {num(record.metrics.fullMargin.previousRegularBaselineMAE)}）。</p>)}{preseason.limitations.map(text => <p key={text}>{text}</p>)}</> : reference ? <><p>主隊預估＝（主隊上季平均得分 {num(reference.home.pointsFor)}＋客隊上季平均失分 {num(reference.away.pointsAgainst)}）÷2；客隊同樣計算。</p><p>主隊 {reference.home.games} 場、客隊 {reference.away.games} 場；資料截止 {reference.through}，全部早於本場。</p>{reference.limitations.map(text => <p key={text}>{text}</p>)}</> : assessment ? <><p>歷史節奏 {num(assessment.paceProxy?.estimatedPace)}；以兩隊賽前最近五場節奏與前場日期間隔修正總分，不是直接將大分改選小分。</p>
        {['away', 'home'].map(side => <p key={side}>{name(row.game[side])}：節奏樣本 {assessment.paceProxy?.[side]?.count ?? 0} 場；前場 {assessment.restProxy?.[side]?.priorDate || '—'}，日期間隔 {assessment.restProxy?.[side]?.gapDays ?? '—'} 天。</p>)}
        <p>校正 {assessment.calibrationSamples} 筆，截止 {assessment.calibrationThrough}；誤差分布 {assessment.distributionSamples} 筆，截止 {assessment.distributionThrough}。分析盤口 {result.quote?.line}｜{localTime(result.observedAt)}。</p></> : <p>尚無可核對的分析原因。</p>}
      <p>歷史分布估計不是已驗證的賽前勝率或 EV；此 NBA 模型目前不開放下注執行。傷停和陣容尚未納入修正。</p>
      {result?.status === 'ready' && <p>{result.persistence?.persisted ? '本次預測與原盤口已永久保存，可供日後前瞻驗證。' : '本次預測尚未取得永久保存確認，不能計入前瞻驗證樣本。'}</p>}
      {result?.issues?.map((issue, index) => <p key={index}>{issue.message}</p>)}
    </details>
  </section>;
}

export default function NbaMainWorkspace({ active, allRun, notificationJob, onAnalyzeAll, otherBusy, onBusyChange, onDateChange, onBatchProgress }) {
  const [date, setDate] = useState(() => taipeiDate(Date.now()));
  const [rows, setRows] = useState([]);
  const [view, setView] = useState('board');
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState('');
  const [job, setJob] = useState(null);
  const [progress, setProgress] = useState(null);
  const [reconnectRevision, setReconnectRevision] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [readerStatus, setReaderStatus] = useState('waiting');
  const notification = useRef(null);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const dateRef = useRef(date); dateRef.current = date;
  const requestRevision = useRef(0);
  const operation = useRef(false);
  const jobRef = useRef(job); jobRef.current = job;
  const explicitDate = useRef(false);
  const running = starting || ['starting', 'running'].includes(job?.status);
  const busy = running || otherBusy;
  useEffect(() => { onBusyChange(running); }, [running, onBusyChange]);
  useEffect(() => { onDateChange(date, explicitDate.current); }, [date, onDateChange]);
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem(NBA_JOB_STORAGE) || 'null'); if (validNbaJob(saved)) { setJob(saved); if (saved.status === 'running' || saved.status === 'starting') setDate(saved.date); } } catch {} }, []);
  useEffect(() => {
    const incoming = notificationJob || (allRun?.runId && Number(allRun.leagues?.NBA?.total) > 0 ? { runId: allRun.runId, date: allRun.leagues.NBA.boardDate, startedAt: allRun.startedAt } : null);
    if (!validNbaJob(incoming) || jobRef.current?.runId === incoming.runId
      || Date.parse(jobRef.current?.startedAt || '') > Date.parse(incoming.startedAt || '')
      || !notificationJob && allRun?.state === 'completed' && incoming.date !== dateRef.current) return;
    const next = { ...incoming, status: 'running' }; store(next); setJob(next); setDate(next.date);
  }, [allRun?.runId, allRun?.leagues?.NBA?.total, notificationJob]);
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);

  async function load(target = date) {
    const revision = ++requestRevision.current; setLoading(true); setError('');
    try {
      if (!explicitDate.current && !['running', 'starting'].includes(jobRef.current?.status)) {
        const reader = await api('/api/nba/reader');
        if (revision !== requestRevision.current) return null;
        const latest = nbaLatestBoardDate(reader, target);
        if (latest !== target) { target = latest; dateRef.current = latest; setDate(latest); setRows([]); setProgress(null); setSelected(''); }
      }
      const board = await api(`/api/nba/analysis-board?date=${encodeURIComponent(target)}`);
      if (revision !== requestRevision.current || target !== dateRef.current) return null;
      setReaderStatus(board.readerStatus);
      setRows(current => board.rows.map(row => {
        const previous = current.find(old => old.game.id === row.game.id);
        return previous ? { ...row, result: previous.result, jobState: previous.jobState, jobError: previous.jobError } : row;
      }));
      return board;
    } catch (cause) { if (revision === requestRevision.current && target === dateRef.current) setError(cause.message); return null; }
    finally { if (revision === requestRevision.current) setLoading(false); }
  }
  useEffect(() => { if (active && !operation.current) void load(date); }, [active, date]);
  useEffect(() => { if (!active || busy) return; const timer = setInterval(() => { if (!operation.current) void load(dateRef.current); }, 30000); return () => clearInterval(timer); }, [active, busy]);
  useEffect(() => {
    const resume = () => { if (document.visibilityState !== 'hidden' && validNbaJob(jobRef.current)) setReconnectRevision(value => value + 1); };
    window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
    return () => { window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); };
  }, []);
  useEffect(() => {
    if (!validNbaJob(job) || job.status === 'failed' && !reconnectRevision) return;
    let activePoll = true; let timer;
    const expected = job.runId || job.requestId;
    const current = () => activePoll && (jobRef.current?.runId || jobRef.current?.requestId) === expected;
    async function poll() {
      try {
        if (!job.runId) {
          const state = await api(`/api/analysis-jobs?requestId=${encodeURIComponent(job.requestId)}`);
          if (!current()) return;
          if (state.runId) { const next = { ...job, runId: state.runId, status: 'running' }; store(next); setJob(next); return; }
          if (state.status === 'failed') throw Object.assign(new Error(state.error || 'NBA 背景工作未送出'), { jobStatus: 'failed' });
        } else {
          const state = await api(`/api/analysis-jobs?runId=${encodeURIComponent(job.runId)}&league=NBA`);
          if (!current()) return;
          const batch = state.status === 'completed' ? state.result : state.progress;
          if (batch && job.date === dateRef.current) {
            const next = mergeNbaAnalysisResults(batch, rowsRef.current, job.date);
            setRows(next); rowsRef.current = next;
            setProgress({ summary: nbaCompletionSummary(batch) });
            onBatchProgress?.({ ...batch, runId: job.runId });
          }
          const nbaFinished = batch && Array.isArray(batch.results) && batch.results.length === batch.total && !(batch.runningGamePks?.length);
          if (state.status === 'completed' || nbaFinished) { const next = { ...job, status: 'completed' }; store(next); setJob(next); setMessage(nbaCompletionSummary(batch)); return; }
          if (['failed', 'cancelled'].includes(state.status)) throw new Error('NBA 背景工作未完成，可重新分析。');
        }
      } catch (cause) {
        if (!current()) return; setError(cause.message);
        if (cause.jobStatus === 'failed' || cause.status === 401 || job.runId && cause.status === 404 || cause.message.includes('未完成') || cause.message.includes('未送出') || job.runId && cause.message.includes('找不到') || cause.message.includes('登入')) {
          const next = { ...job, status: 'failed' }; store(next); setJob(next); return;
        }
      }
      if (current()) timer = setTimeout(poll, 2500);
    }
    void poll(); return () => { activePoll = false; clearTimeout(timer); };
  }, [job?.runId, job?.requestId, job?.date, reconnectRevision]);

  async function start(id = '') {
    if (operation.current || busy) return; operation.current = true; setStarting(true); setError(''); setProgress(null); setMessage('正在核對最新 NBA 盤口並送出分析工作…');
    try {
      prepareNbaNotification(notification.current);
      const board = await load(date);
      if (!board) return;
      const tasks = board.tasks.filter(task => !id || task.nbaQuery.id === id);
      if (!tasks.length) { setMessage('目前沒有可分析的賽前盤口；各場原因已列出。'); return; }
      const requestId = `nba-analysis-${crypto.randomUUID()}`;
      const handle = { requestId, date: board.date, status: 'starting', startedAt: new Date().toISOString() };
      if (!store(handle)) setMessage('此裝置無法保存工作編號，完成前請保持網站開啟。');
      let started;
      try { started = await api('/api/analysis-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId }, body: JSON.stringify({ league: 'NBA', date: board.date, tasks }) }, 75000); }
      catch (cause) {
        if (backgroundStartWasDefinitivelyRejected(cause) || cause.jobStatus === 'failed') {
          const failed = { ...handle, status: 'failed' }; store(failed); setJob(failed); setError(cause.message); return;
        }
        setJob(handle); setError(`${cause.message}；正在查詢原工作，未重複送出。`); return;
      }
      const next = { ...handle, runId: started.runId || '', status: started.runId ? 'running' : 'starting' }; store(next); setJob(next);
      setRows(current => current.map(row => tasks.some(task => task.game.id === row.game.id) ? { ...row, jobState: 'queued', jobError: '' } : row));
      setMessage('NBA 伺服器背景分析已開始；完成一場就先顯示，可切換聯盟。');
    } catch (cause) { setError(cause.message); }
    finally { operation.current = false; setStarting(false); }
  }
  const changeDate = value => { if (!validDate(value)) return; explicitDate.current = true; onDateChange(value, true); dateRef.current = value; requestRevision.current += 1; setRows([]); setProgress(null); setSelected(''); setDate(value); };
  return <NbaBetRecordProvider date={date} active={active}><div hidden={!active} aria-label="NBA 主站分析">
    <nav className="mainTabs"><button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}>今日盤口</button><button className={view === 'results' ? 'active' : ''} onClick={() => setView('results')}>分析結果</button><button className={view === 'ranking' ? 'active' : ''} onClick={() => setView('ranking')}>影子排名</button><button className={view === 'records' ? 'active' : ''} onClick={() => setView('records')}>下注紀錄</button><button className={view === 'data' ? 'active' : ''} onClick={() => setView('data')}>賽程與球員</button></nav>
    {error && <div className="errorBox" role="alert">{error}{error.includes('登入') && <a href="/login?next=/?sport=NBA">重新登入</a>}<button className="mini" onClick={() => setError('')}>關閉</button></div>}
    {message && <div className="noticeBox" role="status">{message}</div>}
    {view !== 'data' && <><section className="heroCard"><div className="heroCopy"><span className="kicker">每日主要操作</span><h2>手動分析 NBA｜單場或本日全部</h2></div>
      <AnalysisNotificationControl ref={notification}/><div className="heroControls">
        <label>台灣日期<input type="date" value={date} disabled={busy} onInput={event => changeDate(event.currentTarget.value)} onChange={event => changeDate(event.target.value)}/></label>
        <button className="secondary" disabled={busy || loading} onClick={() => { explicitDate.current = false; onDateChange(dateRef.current, false); void load(); }}>跟隨最新盤日</button>
        <button className="secondary" disabled={loading || busy} onClick={() => load()}>{loading ? '讀取中…' : '讀取賽程與盤口（不分析）'}</button>
        <label>選擇單場比賽<select value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}><option value="">請選擇一場</option>{rows.map(row => <option key={row.game.id} value={row.game.sourceId}>{name(row.game.away)} @ {name(row.game.home)}｜{localTime(row.game.startTime)}</option>)}</select></label>
        <button className="primary" disabled={busy || !selected} onClick={() => start(selected)}>只分析這一場</button>
        <button className="primary giant" disabled={busy} onClick={() => start()}>{starting ? '正在送出 NBA 分析…' : running ? 'NBA 背景分析中…' : '分析本日全部 NBA'}</button>
        <button className="secondary allLeagueAnalyzeButton" disabled={busy} onClick={() => { prepareNbaNotification(notification.current); onAnalyzeAll(); }}>一鍵分析全部聯盟（含 NBA）</button>
        <button className="secondary" disabled={starting || !job} onClick={() => { setDate(job.date); setReconnectRevision(value => value + 1); }}>載入先前分析（不重算）</button>
        <a className="secondary readerDownload" href="/downloads/Tai888-Reader-v2.1.28-NBA-READ.zip" download>下載 Reader v2.1.28</a>
      </div><div className={`providerState ${readerStatus === 'fresh' ? 'ready' : 'missing'}`}><strong>{readerStatus === 'fresh' ? 'NBA 盤口已同步' : 'NBA Reader 等待同步／盤口已過期'}</strong><span>季前賽支援全場與上半場大小、讓分；需盤口開盤及歷史樣本核對通過。例行賽與季後賽亦支援四盤口；同球季樣本不足時停止估計。</span></div><AllLeagueProgress run={allRun}/></section>
      {progress && <div className="progressBox" role="status">{progress.summary}</div>}
      {view === 'ranking' && <NbaShadowRanking rows={rows} date={date} now={now} onAnalyze={start} busy={busy}/>}
      {(view === 'ranking' || view === 'records' ? [] : view === 'results' ? rows.filter(row => row.result || row.jobState) : rows).map(row => <NbaGameCard key={row.game.id} row={row} now={now} onAnalyze={start} busy={busy}/>)}
      {!rows.length && <section className="emptyBoard"><div>🏀</div><h2>{loading ? '讀取 NBA 賽程與盤口中…' : '尚無此日 NBA 盤口'}</h2><p>沒有開盘、盤口過期或資料不足會分別顯示，不會假裝已分析成功。</p></section>}
    </>}
    {view === 'records' && <NbaBetRecords/>}
    {view === 'data' && <NbaDataWorkspace/>}
  </div></NbaBetRecordProvider>;
}
