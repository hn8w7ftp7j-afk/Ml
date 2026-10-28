'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { NBA_TEAM_LABELS } from '../../lib/nba/labels.js';
import { taipeiDate, validDate } from '../../lib/nba/identity.js';
import { NBA_JOB_STORAGE, validNbaJob, mergeNbaAnalysisResults, nbaResultQuoteCurrent } from '../../lib/nba/analysis-job-display.js';
import { nbaMarketScore } from '../../lib/nba/market-score.js';
import { buildNbaBetReminder } from '../../lib/nba/shadow-ranking.js';
import NbaShadowRanking from './shadow-ranking.js';
import { NbaBetRecordProvider, NbaBetRecordButton, NbaBetRecords } from './bet-records.js';
import AnalysisNotificationControl from '../analysis-notification-control.js';
import AllLeagueProgress from '../all-league-progress.js';
import { backgroundStartWasDefinitivelyRejected } from '../../lib/background-start-request-journal.js';
import { loadNbaUpcomingBoard, nbaCompletionSummary, nbaNavigationDate } from '../../lib/nba/analysis-ui-policy.js';
import { prepareNbaNotification } from '../../lib/nba/analysis-notification-start.js';
import { nbaBatchFinished, summarizeNbaBatchOutcome } from '../../lib/nba/analysis-outcome.js';
import { nbaOpeningMarketCoverage } from '../../lib/nba/league-indicator.js';
import { nbaReaderSyncFailure } from '../../lib/nba/reader-sync-diagnostic.js';

const NbaDataWorkspace = dynamic(() => import('./workspace.js'), { ssr: false });
const NbaForwardValidationPanel = dynamic(() => import('./forward-validation-panel.js'), { ssr: false });
const name = team => NBA_TEAM_LABELS[team?.abbreviation] || team?.name || '球隊待核對';
const num = value => Number.isFinite(value) ? value.toFixed(2) : '—';
const localTime = value => Number.isFinite(Date.parse(value || '')) ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
const statusText = value => ({ queued: '排隊中', running: '分析中', ready: '已分析', reference: '跨季基準', insufficient: '資料不足', blocked: '核對未通過', failed: '分析失敗' }[value] || '尚未分析');
const openingMarketLabels = { fullTotal: '全場大小', fullRunline: '全場讓分', firstHalfTotal: '上半大小', firstHalfRunline: '上半讓分' };
const openingCheckLabels = { samples: '驗證場數', earlySamples: '開季驗證場數', modelMAE: '全季平均誤差（MAE）', earlyModelMAE: '開季平均誤差（MAE）', modelBrier: '機率誤差（Brier）', modelLogLoss: '機率誤差（Log Loss）', acceptanceFlag: '市場驗證狀態' };
function openingValidationView(value, market) {
  const variable = ({ fullTotal: 'fullTotal', fullRunline: 'fullMargin', firstHalfTotal: 'halfTotal', firstHalfRunline: 'halfMargin' })[market];
  const v6Total=['fullTotal','firstHalfTotal'].includes(market)&&value?.modelVersion==='nba-opening-totals-early-baseline-hybrid-v6';
  if (!variable || value?.version !== 'nba-opening-validation-diagnostics-v1' || value.league !== 'NBA'
    || value.market !== market || value.variable !== variable || value.modelVersion !== 'nba-regular-cross-season-v1'&&!v6Total
    || !['PASS', 'FAIL'].includes(value.status) || !Array.isArray(value.checks)) return null;
  const checks = value.checks.filter(check => openingCheckLabels[check?.id] && ['PASS', 'FAIL'].includes(check.status));
  if (!checks.length || new Set(checks.map(check => check.id)).size !== checks.length) return null;
  const number = (n, digits = 0) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n.toFixed(digits) : '未提供';
  return {
    status: value.status,
    validationBasis:v6Total?'earlier_era_external_retrospective':'temporal_holdout',
    year: Number.isInteger(value.validationYear) ? value.validationYear : null,
    samples: number(value.samples), earlySamples: number(value.earlySamples), probabilitySamples: number(value.probabilitySamples),
    failed: checks.filter(check => check.status === 'FAIL').map(check => openingCheckLabels[check.id]),
    checks: checks.map(check => {
      const digits = ['modelBrier', 'modelLogLoss'].includes(check.id) ? 5 : ['modelMAE', 'earlyModelMAE'].includes(check.id) ? 2 : 0;
      const format = n => check.id === 'acceptanceFlag' ? typeof n === 'boolean' ? n ? '通過' : '未通過' : '未提供' : number(n, digits);
      return { id: check.id, label: openingCheckLabels[check.id], actual: format(check.actual), baseline: format(check.baseline), status: check.status,
        comparison: check.comparison === 'at_least' ? '不得少於基準' : check.comparison === 'at_most' ? '不得高於基準' : '需符合基準' };
    }),
  };
}
function NbaMarketValidation({ diagnostics, market }) {
  const view = openingValidationView(diagnostics, market);
  if (!view || view.status !== 'FAIL') return null;
  const failures = view.failed.filter(label => label !== openingCheckLabels.acceptanceFlag);
  return <div className="nbaMarketValidation">
    <p className="muted">{failures.length ? `${failures.join('、')}未通過` : '此市場歷史驗證未通過'}；暫不產生 W／R／S。</p>
    <details className="rankingDetails"><summary>未通過原因與驗證數據</summary>
      <p>{view.year ? `${view.year} ${view.validationBasis==='earlier_era_external_retrospective'?'跨時代回溯外部驗證':'驗證'}球季｜` : ''}驗證 {view.samples} 場，開季 {view.earlySamples} 場；機率驗證 {view.probabilitySamples} 場。</p>
      <p>場數須達基準；誤差不得高於基準。</p>
      <div style={{ maxWidth: '100%', overflowX: 'auto' }}><table style={{ minWidth: '380px', width: '100%' }} aria-label={`${openingMarketLabels[market]}歷史驗證數據`}>
        <thead><tr><th scope="col">檢查</th><th scope="col">模型／現況</th><th scope="col">基準／要求</th><th scope="col">結果</th></tr></thead>
        <tbody>{view.checks.map(check => <tr key={check.id}><th scope="row">{check.label}</th><td>{check.actual}</td><td>{check.baseline}</td><td title={check.comparison}>{check.status === 'PASS' ? '通過' : '未通過'}</td></tr>)}</tbody>
      </table></div>
      <p>以上核對比分與參考門檻機率，不代表實際歷史盤口下注勝率。</p>
    </details>
  </div>;
}
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
  const opening = result?.openingAnalysis;
  const validationPending = opening ? Object.entries(result?.marketAnalyses || {}).filter(([key, market]) => market?.status === 'insufficient' && openingValidationView(market?.validationDiagnostics, key)?.status === 'FAIL').map(([key]) => openingMarketLabels[key]) : [];
  const estimatedMarkets = opening ? Object.entries(result?.marketAnalyses || {}).filter(([key, market]) => openingMarketLabels[key] && market?.status === 'ready').map(([key]) => openingMarketLabels[key]) : [];
  const noOpeningMarket = opening && result.status === 'insufficient' && !validationPending.length;
  const reference = result?.status === 'reference' ? result.referencePrediction : null;
  const current = nbaResultQuoteCurrent(row, now);
  const canAnalyze = row.canAnalyze && now - Date.parse(row.observedAt) < 180000
    && now - Date.parse(row.pageActivityAt || row.observedAt) < 180000 && Date.parse(row.game.startTime) > now;
  return <section className="gameCard" data-nba-game={row.game.id}>
    <div className="gameHead"><div><h2>{name(row.game.away)}（客）@ {name(row.game.home)}（主）</h2><p>{localTime(row.game.startTime)}（台灣）｜{row.game.season?.label}｜{({ preseason: '季前賽', regular: '例行賽', postseason: '季後賽' })[row.game.seasonType] || '賽事類型待核對'}</p></div>
      <span className={`state ${validationPending.length ? 'unopened' : row.jobState === 'ready' ? 'done' : row.jobState === 'insufficient' || row.jobState === 'blocked' ? 'unopened' : row.jobState || 'queued'}`}>{validationPending.length ? estimatedMarkets.length ? '部分市場已分析' : '市場驗證未通過' : noOpeningMarket ? '尚無可分析市場' : statusText(row.jobState)}</span></div>
    <p className="nbaQuoteTime">{row.observedAt ? `盤口 ${localTime(row.observedAt)}` : '盤口待同步'}</p>
    {opening && <p className="muted">開季分析｜上一季基準＋本季表現。{estimatedMarkets.length > 0 && `${estimatedMarkets.join('、')}已產生估計。`}{validationPending.length > 0 ? `${validationPending.join('、')}待驗證，暫不計分。` : '未開盤或核對未完成的市場不產生估計。'}</p>}
    {reference && <p className="muted">跨季基準，尚未校正。</p>}
    {(prediction || reference) && <details className="rankingDetails"><summary>比分預估與樣本</summary>
    {prediction && !preseason && !opening && <div className="detailGrid"><div><span>原比分總分</span><b>{num(prediction.baseTotal)}</b></div><div><span>校正後總分</span><b>{num(prediction.total)}</b></div><div><span>總分修正</span><b>{prediction.correction > 0 ? '+' : ''}{num(prediction.correction)}</b></div><div><span>參考方向</span><b>{assessment?.direction === 'over' ? '大分' : assessment?.direction === 'under' ? '小分' : '未定'}</b></div></div>}
    {opening && <div className="detailGrid"><div><span>全場預估分差（主−客）</span><b>{num(opening.fullMargin)}</b></div><div><span>上半預估分差（主−客）</span><b>{num(opening.halfMargin)}</b></div><div><span>跨季誤差樣本</span><b>{opening.distributionSamples}</b></div><div><span>本季主／客隊已打場次</span><b>{opening.baseline.home.currentGames}／{opening.baseline.away.currentGames}</b></div></div>}
    {regular && <div className="detailGrid"><div><span>全場預估分差（主−客）</span><b>{num(regular.fullMargin)}</b></div><div><span>上半預估總分</span><b>{num(regular.halfTotal)}</b></div><div><span>上半預估分差（主−客）</span><b>{num(regular.halfMargin)}</b></div><div><span>上半誤差樣本</span><b>{regular.halfSamples}</b></div></div>}
    {preseason && <><div className="detailGrid"><div><span>主隊預估得分</span><b>{num(prediction.home)}</b></div><div><span>客隊預估得分</span><b>{num(prediction.away)}</b></div><div><span>全場預估總分</span><b>{num(preseason.fullTotal)}</b></div><div><span>上半預估總分</span><b>{num(preseason.halfTotal)}</b></div></div><p className="muted">季前賽校正 {preseason.trainingSamples} 場；誤差樣本 {preseason.distributionSamples} 筆。左側為 S 分數；勝率與 W／R 列於明細。</p></>}
    {reference && <><div className="noticeBox">跨季基準，尚未校正。</div><div className="detailGrid"><div><span>主隊基準得分</span><b>{num(reference.homePoints)}</b></div><div><span>客隊基準得分</span><b>{num(reference.awayPoints)}</b></div><div><span>基準總分</span><b>{num(reference.total)}</b></div><div><span>來源球季</span><b>{reference.sourceSeasonYear - 1}–{String(reference.sourceSeasonYear).slice(-2)} 例行賽</b></div></div></>}
    </details>}
    {['ready', 'reference'].includes(result?.status) && !current && <p className="muted">舊分析｜盤口已更新、過期或已開賽。</p>}
    {result?.status === 'insufficient' && <div className="noticeBox">{opening ? validationPending.length ? '開季市場驗證未通過｜原盤口已保留，請查看各市場的驗證原因。' : '目前沒有可分析的開季市場｜請查看各市場狀態與原因。' : <>資料不足｜{result.training?.availableGames ?? 0}／{result.training?.minimumResiduals ?? 50} 筆同季樣本。</>}</div>}
    {(row.reason || row.jobError) && <p className="muted">{row.jobError || row.reason}</p>}
    <div className="nbaMarketList">{[['fullTotal', '全場大小'], ['fullRunline', '全場讓分'], ['firstHalfTotal', '上半大小'], ['firstHalfRunline', '上半讓分']].map(([key, label]) => {
      const modelMarket = result?.marketAnalyses?.[key];
      const analyzed = preseason || regular || opening ? modelMarket?.status === 'ready' && modelMarket.quote : key === 'fullTotal' && result?.status === 'ready' && result.quote;
      const market = analyzed || row.quote?.[key]; const total = key.endsWith('Total');
      const choices = total ? [['over', '大分', market?.overWater, assessment?.positiveExpectedNet], ['under', '小分', market?.underWater, assessment?.negativeExpectedNet]] : [['away', `${name(row.game.away)}（客）${market?.lineSide === 'away' ? '讓分' : '受讓'}`, market?.awayWater], ['home', `${name(row.game.home)}（主）${market?.lineSide === 'home' ? '讓分' : '受讓'}`, market?.homeWater]];
      return <div className={`marketBlock actualMarket ${market ? '' : 'nbaUnavailableMarket'}`} key={key}><h3>{label}｜{market?.line || '—'}{market && !total ? `｜${market.lineSide === 'home' ? '主隊' : '客隊'}讓分` : ''}</h3>
        {analyzed && !current && <p className="muted">目前 Reader 盤口：{row.quote?.[key]?.line || '等待開盤'}；以下估計對應上次分析的盤口與水位。</p>}
        {modelMarket && !['ready','unavailable'].includes(modelMarket.status) && (modelMarket.status === 'insufficient' && openingValidationView(modelMarket.validationDiagnostics, key)?.status === 'FAIL' ? <NbaMarketValidation diagnostics={modelMarket.validationDiagnostics} market={key}/> : <p className="muted">{modelMarket.reason}</p>)}
        {market && choices.map(([side, pick, water, legacyEstimate]) => {
          const estimate = modelMarket?.status === 'ready' ? modelMarket.sides[side] : null;
          const scoring = nbaMarketScore(estimate);
          return <div className="scoreRow" key={pick}><div className={`score ${scoring?.score >= 8.5 ? 'strongest' : 'pass'}`} title="S 分數"><small>S 分數</small>{scoring ? scoring.score.toFixed(1) : '—'}</div><div className="scoreBody"><div className="scorePick">{pick}</div><div className="scorePrice">水位 {num(water)}</div><div className="scoreMeta">{estimate ? `估計勝率 ${(estimate.winProbability * 100).toFixed(2)}%` : modelMarket?.status === 'insufficient' ? '待驗證' : statusText(row.jobState)}</div>{estimate ? <div className="scoreMeta">W {num(estimate.expectedNet)}%｜R {num(estimate.robustExpectedNet)}%{!scoring ? '｜S 待核對' : ''}</div> : analyzed ? <div className="scoreMeta">每 100 元淨額 {num(legacyEstimate)} 元</div> : null}
            {estimate && <details className="rankingDetails"><summary>估計明細</summary><p>模型估計勝率 {(estimate.winProbability * 100).toFixed(2)}%｜走水 {(estimate.pushProbability * 100).toFixed(2)}%。W／R 為每 100 元含退水淨額。{!scoring && '壓力樣本不足，暫不產生 S。'}</p></details>}
          </div><div className="rowActions"><NbaBetRecordButton entry={{ game: row.game, marketKey: key, side, line: market.line, lineSide: total ? null : market.lineSide, water, away: name(row.game.away), home: name(row.game.home) }}/></div></div>;
        })}
      </div>;
    })}</div>
    <button className="secondary" disabled={busy || !canAnalyze} onClick={() => onAnalyze(row.game.sourceId)}>{row.result ? '重新分析這一場' : '分析這一場'}</button>
    <details className="details"><summary>分析明細</summary>
      {opening && <><p>開季使用上一季已核對的例行賽作基準，以本季較早比賽逐步更新；同日及未來賽果不納入。本季樣本足夠後，會接回原本的本季模型；S 仍需完整壓力樣本。</p>{opening.totalsValidation ? <><p>大小分：兩隊本季皆未滿 10 場時，比分預估維持既有基準；之後使用逐步校正。大小分機率以各自的較早比賽誤差估計，上半場另用前兩節實際比分。</p><p>大小分驗證：{opening.totalsValidation.validationYear} 球季跨時代回溯外部驗證，另核對 2021–2026 既有資料；不是前瞻驗證。讓分維持原 {opening.validationYear} 球季時間切分驗證。各市場分別檢查比分誤差與參考門檻機率；未通過者不產生 W／R／S。</p></> : <p>獨立時間切分驗證球季 {opening.validationYear}；跨季誤差 {opening.distributionSamples} 筆。各市場分別核對比分誤差與參考門檻機率；未通過者保留原盤口，不產生 W／R／S。這不是實際歷史盤口下注勝率。</p>}{opening.limitations.map(text=><p key={text}>{text}</p>)}</>}
      {regular ? <><p>全場大小保留節奏與休息校正；全場讓分採主客比分差。上半場由已核對前兩節比分另行擬合，排除延長賽。</p><p>資料截止 {regular.through}；全場誤差 {regular.fullSamples} 筆，上半場 {regular.halfSamples} 筆。只使用同球季、同賽制且日期較早的結果。</p><p>W 使用最近資料權重（半衰期 30 天）；R 取前三個互不重疊的 30 天區塊與 W 的最低值，每區需 30 筆，不足不產生 R／S。</p>{regular.limitations.map(text => <p key={text}>{text}</p>)}</> : preseason ? <><p>以上一季兩隊得分與失分作為輸入，用較早季前賽擬合總分和分差；全場及上半場分開校正。固定 ridge 縮減係數，沒有直接將大分改選小分。</p><p>訓練球季 {preseason.sourceSeasonYears.join('、')}，資料截止 {preseason.through}。誤差按逐場較早日期產生，同日與未來結果不納入。</p><p>各盤口依當前讓分方、信用盤部分輸贏與雙邊水位，計算勝／負／走水及每 100 元淨額。估計不代表實際歷史下注勝率。</p>{preseason.validation?.map(record => <p key={record.seasonYear}>歷史時間切分 {record.seasonYear} 球季 {record.samples} 場：全場總分平均誤差 {num(record.metrics.fullTotal.modelMAE)}（上季基準 {num(record.metrics.fullTotal.previousRegularBaselineMAE)}）；全場分差 {num(record.metrics.fullMargin.modelMAE)}（基準 {num(record.metrics.fullMargin.previousRegularBaselineMAE)}）。</p>)}{preseason.limitations.map(text => <p key={text}>{text}</p>)}</> : reference ? <><p>主隊預估＝（主隊上季平均得分 {num(reference.home.pointsFor)}＋客隊上季平均失分 {num(reference.away.pointsAgainst)}）÷2；客隊同樣計算。</p><p>主隊 {reference.home.games} 場、客隊 {reference.away.games} 場；資料截止 {reference.through}，全部早於本場。</p>{reference.limitations.map(text => <p key={text}>{text}</p>)}</> : assessment && !opening ? <><p>歷史節奏 {num(assessment.paceProxy?.estimatedPace)}；以兩隊賽前最近五場節奏與前場日期間隔修正總分，不是直接將大分改選小分。</p>
        {['away', 'home'].map(side => <p key={side}>{name(row.game[side])}：節奏樣本 {assessment.paceProxy?.[side]?.count ?? 0} 場；前場 {assessment.restProxy?.[side]?.priorDate || '—'}，日期間隔 {assessment.restProxy?.[side]?.gapDays ?? '—'} 天。</p>)}
        <p>校正 {assessment.calibrationSamples} 筆，截止 {assessment.calibrationThrough}；誤差分布 {assessment.distributionSamples} 筆，截止 {assessment.distributionThrough}。分析盤口 {result.quote?.line}｜{localTime(result.observedAt)}。</p></> : <p>尚無可核對的分析原因。</p>}
      <p>歷史分布估計不是已驗證的賽前勝率或 EV；此 NBA 模型目前不開放下注執行。傷停和陣容尚未納入修正。</p>
      {result?.trainingPipeline && <p>歷史資料更新：{result.trainingPipeline.status || '已核對'}；新增歷史 {result.trainingPipeline.liveGames ?? 0} 場。完賽資料只供較晚日期使用。</p>}
      {result?.personnelEvidence && <p>本場人員來源核對：{result.personnelEvidence.status}；傷停 {result.personnelEvidence.coverage?.injuries}；先發 {result.personnelEvidence.coverage?.lineups}。資料不完整不代表全員健康；目前只保存觀測，不修改模型比分。</p>}
      {result?.status === 'ready' && <p>{result.persistence?.persisted ? '本次預測與原盤口已永久保存，可供日後前瞻驗證。' : '本次預測尚未取得永久保存確認，不能計入前瞻驗證樣本。'}</p>}
      {result?.issues?.map((issue, index) => <p key={index}>{issue.message}</p>)}
    </details>
  </section>;
}

export default function NbaMainWorkspace({ active, allRun, preparedScope, notificationJob, onAnalyzeAll, otherBusy, onBusyChange, onDateChange, onBatchProgress, onJobChange, onBoardStateChange, onHighScoreStatusChange, allLeagueBetStatuses, onSelectSoccer }) {
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
  const [readerFailure, setReaderFailure] = useState(null);
  const notification = useRef(null);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const dateRef = useRef(date); dateRef.current = date;
  const requestRevision = useRef(0);
  const operation = useRef(false);
  const jobRef = useRef(job); jobRef.current = job;
  const explicitDate = useRef(false);
  useEffect(() => {
    const target = nbaNavigationDate(window.location.search);
    if (target) { explicitDate.current = true; dateRef.current = target; setDate(target); }
  }, []);
  const running = starting || ['starting', 'running'].includes(job?.status);
  const busy = running || otherBusy;
  const trackBoard = active || validNbaJob(job) || Number(allRun?.leagues?.NBA?.total) > 0;
  useEffect(() => { onBusyChange(running); }, [running, onBusyChange]);
  useEffect(() => { onJobChange?.(job); }, [job, onJobChange]);
  useEffect(() => { onDateChange(date, explicitDate.current); }, [date, onDateChange]);
  useEffect(() => {
    if (!validDate(preparedScope?.date) || operation.current || preparedScope.date === dateRef.current) return;
    dateRef.current = preparedScope.date; setDate(preparedScope.date); setRows([]); setSelected(''); setProgress(null);
  }, [preparedScope]);
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem(NBA_JOB_STORAGE) || 'null'); if (validNbaJob(saved) && (!explicitDate.current || saved.date === dateRef.current)) { setJob(saved); if (saved.status === 'running' || saved.status === 'starting') setDate(saved.date); } } catch {} }, []);
  useEffect(() => {
    const incoming = notificationJob || (allRun?.runId && Number(allRun.leagues?.NBA?.total) > 0 ? { runId: allRun.runId, date: allRun.leagues.NBA.boardDate, startedAt: allRun.startedAt } : null);
    if (!validNbaJob(incoming) || jobRef.current?.runId === incoming.runId
      || Date.parse(jobRef.current?.startedAt || '') > Date.parse(incoming.startedAt || '')
      || !notificationJob && allRun?.state === 'completed' && incoming.date !== dateRef.current) return;
    const next = { ...incoming, status: 'running' }; store(next); setJob(next); setDate(next.date);
  }, [allRun?.runId, allRun?.leagues?.NBA?.total, notificationJob]);
  // Keep the outer league summary current when NBA is hidden, including expiry/start time.
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), active ? 1000 : 15000); return () => clearInterval(timer); }, [active]);

  async function load(target = dateRef.current, { followLatest = true } = {}) {
    const revision = ++requestRevision.current; setLoading(true); setError('');
    try {
      const board = await loadNbaUpcomingBoard({
        selectedDate: target,
        manual: !followLatest || explicitDate.current || ['running', 'starting'].includes(jobRef.current?.status),
        loadReader: () => api('/api/nba/reader'),
        loadBoard: value => api(`/api/nba/analysis-board?date=${encodeURIComponent(value)}`),
      });
      if (revision !== requestRevision.current || target !== dateRef.current) return null;
      if (board.date !== target) {
        dateRef.current = board.date; setDate(board.date); onDateChange(board.date, explicitDate.current);
        setRows([]); setProgress(null); setSelected('');
      }
      setReaderStatus(board.readerStatus);
      setRows(current => board.rows.map(row => {
        const previous = current.find(old => old.game.id === row.game.id);
        const newerSaved = row.result && (!previous?.result || Date.parse(row.result.generatedAt) > Date.parse(previous.result.generatedAt));
        return previous && !newerSaved ? { ...row, result: previous.result, resultRunId: previous.resultRunId, jobState: previous.jobState, jobError: previous.jobError } : row;
      }));
      return board;
    } catch (cause) { if (revision === requestRevision.current && target === dateRef.current) setError(cause.message); return null; }
    finally { if (revision === requestRevision.current) setLoading(false); }
  }
  useEffect(() => { if (trackBoard && !operation.current) void load(date); }, [trackBoard, date]);
  // Quote reads stay live while model jobs run, so earlier league results do not
  // lose their current-price badge while another league is still analysing.
  useEffect(() => { if (!trackBoard) return; const timer = setInterval(() => { if (!operation.current) void load(dateRef.current); }, 30000); return () => clearInterval(timer); }, [trackBoard]);
  useEffect(() => {
    if (!active || readerStatus !== 'stale') { setReaderFailure(null); return; }
    setReaderFailure(null);
    let cancelled = false;
    const read = async () => {
      try {
        const data = await api('/api/reader/diagnostics?league=NBA', {}, 15000);
        if (!cancelled) setReaderFailure(nbaReaderSyncFailure(data.reports, { observedAt: rowsRef.current[0]?.observedAt }));
      } catch { if (!cancelled) setReaderFailure(null); }
    };
    void read(); const timer = setInterval(read, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [active, readerStatus, date]);
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
            let next;
            try {
              if (batch.runId && batch.runId !== job.runId) throw new Error('NBA 工作編號與分析結果不符');
              next = mergeNbaAnalysisResults({ ...batch, runId: job.runId }, rowsRef.current, job.date);
            } catch (cause) { throw Object.assign(cause, { jobStatus: 'failed' }); }
            setRows(next); rowsRef.current = next;
            setProgress({ summary: nbaCompletionSummary(batch) });
            onBatchProgress?.({ ...batch, runId: job.runId });
          }
          const nbaFinished = nbaBatchFinished(batch);
          if (state.status === 'completed' || nbaFinished) { const next = { ...job, status: 'completed', outcome: summarizeNbaBatchOutcome(batch) }; store(next); setJob(next); setMessage(nbaCompletionSummary(batch)); return; }
          if (['failed', 'cancelled'].includes(state.status)) throw new Error('NBA 背景工作未完成，可重新分析。');
        }
      } catch (cause) {
        if (!current()) return; setError(cause.message);
        if (cause.jobStatus === 'failed' || cause.status === 401 || job.runId && cause.status === 404 || cause.message.includes('未完成') || cause.message.includes('未送出') || job.runId && cause.message.includes('找不到') || cause.message.includes('登入')) {
          const next = { ...job, status: 'failed' }; store(next); setJob(next); setMessage('分析結果未通過核對，可重新分析。'); return;
        }
      }
      if (current()) timer = setTimeout(poll, 2500);
    }
    void poll(); return () => { activePoll = false; clearTimeout(timer); };
  }, [job?.runId, job?.requestId, job?.date, reconnectRevision]);

  async function start(id = '') {
    if (operation.current || busy) return; operation.current = true; setStarting(true); setError(''); setProgress(null); setMessage('正在核對盤口…');
    try {
      prepareNbaNotification(notification.current);
      const board = await load(dateRef.current, { followLatest: !id });
      if (!board) { setMessage(''); return; }
      const tasks = board.tasks.filter(task => !id || task.nbaQuery.id === id);
      if (!tasks.length) { setMessage(board.readerStatus === 'stale' && readerFailure ? `目前盤口已過期。最近同步紀錄：${readerFailure.message}` : '目前無可分析盤口，請查看各場狀態。'); return; }
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
      setMessage('分析中，結果會逐場顯示。');
    } catch (cause) { setMessage(''); setError(cause.message); }
    finally { operation.current = false; setStarting(false); }
  }
  const changeDate = value => { if (!validDate(value)) return; explicitDate.current = true; onDateChange(value, true); dateRef.current = value; requestRevision.current += 1; setRows([]); setProgress(null); setSelected(''); setDate(value); };
  const betReminder = useMemo(() => buildNbaBetReminder(rows, date, now), [rows, date, now]);
  const openingMarketCoverage = useMemo(() => nbaOpeningMarketCoverage(rows, date, job), [rows, date, job]);
  useEffect(() => {
    onBoardStateChange?.({ date, readerStatus, analysisGameCount: betReminder.analysisGameCount, openingMarketCoverage });
  }, [date, readerStatus, betReminder.analysisGameCount, openingMarketCoverage, onBoardStateChange]);
  return <NbaBetRecordProvider date={date} active={active} candidates={betReminder.candidates} quotesCurrent={betReminder.quotesCurrent} analysisReady={!running} onHighScoreStatusChange={onHighScoreStatusChange}><div hidden={!active} aria-label="NBA 主站分析">
    <nav className="mainTabs"><button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}>今日盤口</button><button className={view === 'results' ? 'active' : ''} onClick={() => setView('results')}>分析結果</button><button className={view === 'ranking' ? 'active' : ''} onClick={() => setView('ranking')}>影子排名</button><button className={view === 'records' ? 'active' : ''} onClick={() => setView('records')}>下注紀錄</button><button className={view === 'data' ? 'active' : ''} onClick={() => setView('data')}>賽程與球員</button><button className={view === 'validation' ? 'active' : ''} onClick={() => setView('validation')}>模型驗證</button></nav>
    {error && <div className="errorBox" role="alert">{error}{error.includes('登入') && <a href="/login?next=/?sport=NBA">重新登入</a>}<button className="mini" onClick={() => setError('')}>關閉</button></div>}
    {message && <div className="noticeBox" role="status">{message}</div>}

    {!['data', 'validation', 'records'].includes(view) && <><section className="heroCard nbaHero"><div className="heroCopy"><h2>NBA 盤口分析</h2></div>
      <div className="heroControls">
        <label>台灣日期<input type="date" value={date} disabled={busy} onInput={event => changeDate(event.currentTarget.value)} onChange={event => changeDate(event.target.value)}/></label>
        <button className="secondary" disabled={loading || busy} onClick={() => load()}>{loading ? '讀取中…' : '更新盤口'}</button>
        <button className="primary giant" disabled={busy} onClick={() => start()}>{starting ? '送出中…' : running ? '分析中…' : '分析全部 NBA'}</button>
        <button className="secondary allLeagueAnalyzeButton" disabled={busy} onClick={() => { prepareNbaNotification(notification.current); onAnalyzeAll(); }}>一鍵分析全部聯盟</button>
        <details className="nbaMoreControls"><summary>單場分析與其他操作</summary><div className="heroControls">
        <label>選擇單場比賽<select value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}><option value="">請選擇一場</option>{rows.map(row => <option key={row.game.id} value={row.game.sourceId}>{name(row.game.away)} @ {name(row.game.home)}｜{localTime(row.game.startTime)}</option>)}</select></label>
        <button className="primary" disabled={busy || !selected} onClick={() => start(selected)}>只分析這一場</button>
        <button className="secondary" disabled={busy || loading} onClick={() => { explicitDate.current = false; onDateChange(dateRef.current, false); void load(); }}>跟隨最新盤日</button>
        <button className="secondary" disabled={starting || !job} onClick={() => { setDate(job.date); setReconnectRevision(value => value + 1); }}>載入先前分析</button>
        <a className="secondary readerDownload" href="/downloads/Tai888-Reader-v2.1.44-EPL-UCL.zip" download>下載 Reader v2.1.44</a>
        </div></details>
        <details className="nbaMoreControls"><summary>完成通知設定</summary><AnalysisNotificationControl ref={notification}/></details>
      </div><div className={`providerState ${readerStatus === 'fresh' ? 'ready' : 'missing'}`}><strong>{readerStatus === 'fresh' ? '盤口已同步' : readerStatus === 'stale' ? '盤口已過期，請同步 Reader' : '盤口待同步'}</strong></div><AllLeagueProgress run={allRun} betStatuses={allLeagueBetStatuses} onSelectSoccer={onSelectSoccer}/></section>
      {readerStatus === 'stale' && readerFailure && <div className="noticeBox" role="status"><strong>最近 NBA 同步失敗｜{localTime(readerFailure.at)}</strong><p>{readerFailure.message}</p><p>這是已保存的同步紀錄；目前盤口仍未取得更新確認。</p><a href="/reader-diagnostics">查看同步診斷紀錄</a></div>}
      {progress && <div className="progressBox" role="status">{progress.summary}</div>}
      {view === 'ranking' && <NbaShadowRanking rows={rows} date={date} now={now} onAnalyze={start} busy={busy}/>}
      {(view === 'ranking' || view === 'records' ? [] : view === 'results' ? rows.filter(row => row.result || row.jobState) : rows).map(row => <NbaGameCard key={row.game.id} row={row} now={now} onAnalyze={start} busy={busy}/>)}
      {!rows.length && <section className="emptyBoard"><div>🏀</div><h2>{loading ? '讀取 NBA 賽程與盤口中…' : error ? 'NBA 賽程核對失敗，請更新盤口重試' : '此日期沒有 NBA 賽事'}</h2></section>}
    </>}
    {view === 'records' && <><div className="nbaRecordDate"><label>台灣日期<input type="date" value={date} disabled={busy} onChange={event => changeDate(event.target.value)}/></label></div><NbaBetRecords/></>}
    {view === 'data' && <NbaDataWorkspace/>}
    {view === 'validation' && <NbaForwardValidationPanel/>}
  </div></NbaBetRecordProvider>;
}
