'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MARKET_ORDER, breakEvenProbability, hasActualWater } from '../lib/markets.js';
import {
  betIdentity,
  betMatches,
  betPositionIdentity,
  betPriceMatches,
} from '../lib/bet-ledger.js';
import { compareBetPrice } from '../lib/bet-price-comparison.js';
import { summarizeBetLedger } from '../lib/bet-stats.js';
import { translateTeamText } from '../lib/i18n.js';
import { LEAGUE_IDS, leagueConfig, normalizeLeagueId } from '../lib/leagues.js';
import {
  actualLineFreshNow,
  gameIsPrestartNow,
  liveReaderHashMatches,
  mergeReaderStatusHighWater,
  readerCoverageCounts,
  readerHashKey,
  readerRevisionKey,
  shouldAcceptReaderStatus,
  shouldAcknowledgeReaderHash,
} from '../lib/client-analysis-state.js';

const VERSION = '10.2.3';
const STORAGE = 'sports-positive-ev-v10-0-0';
const BET_BACKUP_STORAGE = 'sports-positive-ev-bets-backup-v2';
const ANALYSIS_REQUEST_TIMEOUT_MS = 65_000;
const LEGACY_KEYS = ['sports-positive-ev-v9-7-0', 'sports-positive-ev-v9-6-0', 'sports-positive-ev-v9-5-0', 'mlb-positive-ev-v9-4-4', 'mlb-positive-ev-v9-4-3', 'mlb-positive-ev-v9-4-2', 'mlb-positive-ev-v9-4-1', 'mlb-positive-ev-v9-4-0', 'mlb-positive-ev-v9-3-4', 'mlb-positive-ev-v9-3-3', 'mlb-positive-ev-v9-3-2', 'mlb-positive-ev-v9-3', 'mlb-positive-ev-v9-2', 'mlb-positive-ev-v9-1-preview', 'mlb-positive-ev-v8-4', 'mlb-positive-ev-v7'];
const DEFAULT_SETTINGS = {
  unitValue: 10000,
  rebateRate: 0.015,
  simulationsPerScenario: 4000,
  fallbackWater: { 全場讓分: 0.95, 全場大小: 0.94, 上半讓分: 0.94, 上半大小: 0.93 },
};

const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const pct = value => value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(2)}%`;
const waterText = value => hasActualWater(value) ? Number(value).toFixed(3) : '水位未提供';
const moneyText = value => value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value) >= 0 ? '+' : ''}${Math.round(Number(value)).toLocaleString()}元`;
const matchup = game => `${translateTeamText(game?.away || '')} 對 ${translateTeamText(game?.home || '')}`;

function outcomeText(value) {
  const outcome = String(value || '').toUpperCase();
  if (outcome === 'WIN') return '贏';
  if (outcome === 'LOSS') return '輸';
  if (outcome === 'PUSH') return '走水';
  if (outcome === 'HALF_WIN') return '贏半';
  if (outcome === 'HALF_LOSS') return '輸半';
  if (outcome === 'VOID') return '作廢';
  if (outcome === 'MIXED') return '混合結算';
  return '待結算';
}

function statusText(value) {
  const status = String(value || '').toUpperCase();
  if (status === 'SETTLED') return '已結算';
  if (status === 'MANUAL_REVIEW') return '需人工確認';
  if (status === 'VOID') return '作廢';
  if (status === 'CANCELLED') return '已取消';
  return '待賽果';
}

function coveragePendingText(coverage) {
  return [
    coverage?.locked ? `鎖盤等待 ${coverage.locked} 場` : '',
    coverage?.notRendered ? `Reader未呈現 ${coverage.notRendered} 場` : '',
  ].filter(Boolean).join('｜') || '等待開盤 0 場';
}

function taipeiDate(offset = 0) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + offset * 86400000));
}

function localTime(value) {
  if (!value) return '時間未定';
  try {
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(value));
  } catch { return String(value); }
}

function safeParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function loadCompactStore() {
  if (typeof window === 'undefined') return { settings: DEFAULT_SETTINGS, bets: [], activeLeague: 'MLB' };
  try {
    const own = safeParse(window.localStorage.getItem(STORAGE) || 'null');
    if (own && typeof own === 'object') {
      const backup = safeParse(window.localStorage.getItem(BET_BACKUP_STORAGE) || 'null');
      return {
        settings: { ...DEFAULT_SETTINGS, ...(own.settings || {}), fallbackWater: { ...DEFAULT_SETTINGS.fallbackWater, ...(own.settings?.fallbackWater || {}) } },
        bets: Array.isArray(own.bets) && own.bets.length ? own.bets.slice(0, 5000) : Array.isArray(backup) ? backup.slice(0, 5000) : [],
        activeLeague: normalizeLeagueId(own.activeLeague),
      };
    }
    for (const key of LEGACY_KEYS) {
      const legacy = safeParse(window.localStorage.getItem(key) || 'null');
      if (!legacy || typeof legacy !== 'object') continue;
      return {
        settings: { ...DEFAULT_SETTINGS, ...(legacy.settings || {}), fallbackWater: { ...DEFAULT_SETTINGS.fallbackWater, ...(legacy.settings?.fallbackWater || {}) } },
        bets: Array.isArray(legacy.bets) ? legacy.bets.slice(0, 5000) : [],
        activeLeague: normalizeLeagueId(legacy.activeLeague || 'MLB'),
      };
    }
  } catch {
    // Safari private mode, quota failures and corrupted legacy storage must never crash the app.
  }
  return { settings: DEFAULT_SETTINGS, bets: [], activeLeague: 'MLB' };
}

function saveCompactStore(value) {
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify({ settings: value.settings, bets: value.bets.slice(0, 5000), activeLeague: normalizeLeagueId(value.activeLeague) }));
    if (value.bets.length) window.localStorage.setItem(BET_BACKUP_STORAGE, JSON.stringify(value.bets.slice(0, 5000)));
    return true;
  } catch {
    try { window.localStorage.removeItem(STORAGE); } catch {}
    return false;
  }
}

function mergeBetCollections(first, second) {
  const merged = [];
  const known = new Set();
  for (const bet of [...(Array.isArray(first) ? first : []), ...(Array.isArray(second) ? second : [])]) {
    const key = String(bet?.id || `${bet?.league || 'MLB'}|||${bet?.date || ''}|||${bet?.gamePk || ''}|||${bet?.market || ''}|||${bet?.pick || ''}|||${bet?.water || ''}|||${bet?.placedAt || ''}`);
    if (!key || known.has(key)) continue;
    known.add(key);
    merged.push(bet);
  }
  return merged.sort((a, b) => Date.parse(b.placedAt || 0) - Date.parse(a.placedAt || 0)).slice(0, 5000);
}

async function requestJSON(url, options = {}, timeoutMs = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`伺服器回傳格式錯誤（${response.status}）`); }
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || `請求失敗（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('分析逾時，請稍後重試');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function rowKey(row) {
  return `${row?.market || ''}|||${row?.pick || ''}`;
}

function scoreQaFailures(row) {
  return [...new Set([
    ...(row?.scoreAudit?.baseQa?.failures || []),
    ...(row?.scoreAudit?.boundary?.errors || []),
    ...(row?.scoreAudit?.thirdAudit?.failures || []),
    ...(row?.pairAudit?.failures || []),
  ].filter(Boolean))];
}

function betRecordable(item, row, now = Date.now(), betsEnabled = true) {
  return betsEnabled
    && gameIsPrestartNow(item?.game, now)
    && row?.sourceType === 'ACTUAL_TW_CREDIT'
    && hasActualWater(row?.water)
    && row?.waterEstimated !== true
    && actualLineFreshNow(row, now);
}

function compactAnalysisData(data) {
  return { game: data.game, context: data.context, analysis: data.analysis, openMarkets: data.openMarkets || [] };
}

function LoadingLine({ progress }) {
  if (!progress?.active) return null;
  const ratio = progress.total ? Math.round(progress.done / progress.total * 100) : 0;
  const running = Math.max(0, Number(progress.running) || 0);
  const queued = Math.max(0, Number(progress.total || 0) - Number(progress.done || 0) - running);
  const detail = running || queued
    ? `${progress.done} 完成｜${running} 處理中｜${queued} 排隊`
    : `${progress.done}/${progress.total}`;
  return <div className="progressBox"><div className="progressTop"><strong>{progress.label}</strong><span>{detail}</span></div><div className="progressTrack"><i style={{ width: `${ratio}%` }}/></div></div>;
}

function SummaryCards({ summary }) {
  const values = [
    ['下注', summary?.bets ?? 0],
    ['已結算', summary?.settled ?? 0],
    ['有效勝率', pct(summary?.winRate)],
    ['淨盈虧', moneyText(summary?.netPnl)],
    ['ROI', pct(summary?.roi)],
    ['退水', moneyText(summary?.rebate)],
  ];
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10, margin: '14px 0' }}>
    {values.map(([label, value]) => <div key={label} style={{ padding: 12, border: '1px solid rgba(255,255,255,.1)', borderRadius: 10 }}><span style={{ display: 'block', fontSize: 12, opacity: .7 }}>{label}</span><strong>{value}</strong></div>)}
  </div>;
}

function diagnosticVerdict(row, formulaScore, qaPassed, leagueValidated) {
  const weightedEV = Number(row?.weightedEV);
  const robustEV = Number(row?.robustEV);
  if (formulaScore == null) return { icon: '⛔', label: '無法評分', ranking: false, reason: '缺少合法水位或雙EV' };
  if (!leagueValidated) return { icon: '⚠️', label: '聯盟模型未驗證', ranking: false, reason: '不列排名' };
  if (!qaPassed) return { icon: '⚠️', label: '資料QA阻擋', ranking: false, reason: '不列排名' };
  if (!Number.isFinite(weightedEV) || weightedEV <= 0) return { icon: '⚪', label: 'PASS', ranking: false, reason: '加權EV未大於0' };
  if (!Number.isFinite(robustEV) || robustEV <= 0) return { icon: '🟡', label: '觀察', ranking: false, reason: '穩健EV未大於0' };
  if (formulaScore < 7.2) return { icon: '⚪', label: 'PASS', ranking: false, reason: '公式分數未達7.2' };
  if (formulaScore >= 8.5) return { icon: '🔥', label: '8.5級分析候選', ranking: true, reason: '雙EV為正且達8.5' };
  if (formulaScore >= 8.0) return { icon: '🟢', label: '8.0級分析候選', ranking: true, reason: '雙EV為正且達8.0' };
  if (formulaScore >= 7.5) return { icon: '🟢', label: '7.5級分析候選', ranking: true, reason: '雙EV為正且達7.5' };
  return { icon: '🟢', label: '7.2級分析候選', ranking: true, reason: '雙EV為正且達7.2' };
}

function ResultRow({ row, game, onBet, betState = null, recordable = false, now, verificationPending = false }) {
  const actualLine = row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water);
  const breakEven = actualLine ? breakEvenProbability(row.water, 0.015) : null;
  const formulaScore = row?.formulaDiagnosticScore != null && Number.isFinite(Number(row.formulaDiagnosticScore))
    ? Number(row.formulaDiagnosticScore) : null;
  const qaPassed = row?.scoreAudit?.ok === true && row?.pairAudit?.passed !== false;
  const leagueValidated = row?.scoreStatus !== 'LEAGUE_MODEL_NOT_VALIDATED';
  const qaFailures = scoreQaFailures(row);
  const scoreLabel = formulaScore == null ? '—' : formulaScore.toFixed(1);
  const verdict = diagnosticVerdict(row, formulaScore, qaPassed, leagueValidated);
  const scoreClass = formulaScore == null ? 'pass'
    : !qaPassed || !leagueValidated ? 'warning'
      : formulaScore >= 8.5 ? 'strongest' : formulaScore >= 7.2 ? 'candidate' : 'pass';
  const scoreTitle = formulaScore == null
    ? '缺少合法水位或雙EV，不能補造分數'
    : !leagueValidated
      ? `固定雙EV公式 S 分數 ${formulaScore.toFixed(1)}｜聯盟模型尚未獨立驗證｜不列排名、不可視為推薦`
      : !qaPassed
        ? `固定雙EV公式 S 分數 ${formulaScore.toFixed(1)}｜QA BLOCK｜不列排名、不可視為推薦`
        : `V10.2固定雙EV公式 S 分數 ${formulaScore.toFixed(1)}｜QA PASS｜不可視為正式下注建議`;
  const exact = betState?.exact || null;
  const latest = betState?.latest || null;
  const comparison = latest && !exact ? compareBetPrice({ bet: latest, row, game, rebateRate: 0.015 }) : null;
  const comparisonTone = comparison?.combinedStatus === 'BETTER' ? '#75d69c'
    : comparison?.combinedStatus === 'WORSE' ? '#ff8d8d'
      : comparison?.combinedStatus === 'MIXED' ? '#f1c477' : '#c7cedb';
  const buttonText = exact
    ? `已下注${betState?.records?.length > 1 ? ` ${betState.records.length}筆` : ''} ✓`
    : latest ? '加注目前盤' : '紀錄實際下注';
  return <div className="scoreRow">
    <div className={`score ${scoreClass}`} title={scoreTitle}>{scoreLabel}</div>
    <div className="scoreBody">
      <div className="scorePick">{row.pick || '水位未提供｜不評分'}</div>
      <div className="scorePrice">信用盤水位 {waterText(row.water)}</div>
      <div className="scoreMeta">V10.2棒球分布勝率 {pct(row.modelProbability)}｜損益兩平 {pct(breakEven)}｜加權EV {pct(row.weightedEV)}｜穩健EV {pct(row.robustEV)}</div>
      {actualLine && <div className={`qaLine ${verificationPending ? 'pending' : ''}`}>{verificationPending
        ? '驗證中｜等待今日整批盤口完成'
        : !leagueValidated
          ? `公式評分 ${scoreLabel}｜${verdict.icon} ${verdict.label}｜排名資格：否（${verdict.reason}）｜資料QA：${qaPassed ? 'PASS' : 'BLOCK'}｜正式推薦停用`
          : !qaPassed
            ? `公式評分 ${scoreLabel}｜${verdict.icon} ${verdict.label}｜排名資格：否｜資料QA：BLOCK（${qaFailures.join('；') || '資料、數學或數值檢查未通過'}）｜不列排名、不作推薦｜正式推薦停用`
            : `公式評分 ${scoreLabel}｜${verdict.icon} ${verdict.label}｜排名資格：${verdict.ranking ? '是' : `否（${verdict.reason}）`}｜資料QA：PASS｜正式推薦與Unit停用`}</div>}
    </div>
    <div className="rowActions">
      {(recordable || latest) && <div>
        <button className={`mini ${exact ? 'recorded' : 'green'}`} disabled={Boolean(exact)} title={exact ? '目前盤口與水位已經記錄' : latest ? '以目前新盤再新增一筆實際下注' : '記錄目前實際下注盤口與水位'} onClick={() => onBet(row)}>{buttonText}</button>
        {latest && !exact && <div style={{ marginTop: 6, color: comparisonTone, fontSize: 10, lineHeight: 1.45, maxWidth: 190 }}>
          <b>{comparison?.comparable ? `${comparison.label}｜${comparison.lineLabel}｜${comparison.waterLabel}` : '無法比較'}</b><br/>
          下注時：{latest.pick}｜{waterText(latest.water)}<br/>
          現在：{row.pick}｜{waterText(row.water)}
          {comparison?.keyDifference?.text && <><br/>{comparison.keyDifference.text}</>}
        </div>}
      </div>}
    </div>
  </div>;
}

function GameCard({ item, onBet, getBetState, readerExecutable, now, analysisInProgress = false, betsEnabled = true, shadowMode = false }) {
  const readerBacked = item.actualSource?.provider === 'TAI888_READER_AUTO';
  const gamePrestart = gameIsPrestartNow(item.game, now);
  const coverage = item.marketCoverage || {};
  const availableMarkets = new Set(coverage.availableMarkets || []);
  const blockedMarkets = new Set(coverage.blockedMarkets || []);
  const openMarketCount = Number.isInteger(Number(coverage.openMarkets))
    ? Number(coverage.openMarkets)
    : new Set((item.customMarkets || []).map(row => row.market)).size;
  const actualRows = (item.customData?.analysis?.results || []).filter(row => row.sourceType === 'ACTUAL_TW_CREDIT').map(row => {
    if (!gamePrestart) return { ...row, executable: false, lineFresh: false, betEligible: false, tag: '已達官方預定開打時間｜停止記錄新下注' };
    if (readerBacked && !readerExecutable) return {
      ...row,
      executable: false,
      lineFresh: false,
      betEligible: false,
      tag: analysisInProgress ? '今日整批分析進行中｜完成前暫停記錄' : '盤口尚未完成最新版本驗證',
    };
    return row;
  });
  const expectedDirectionCount = openMarketCount * 2;
  const scoredDirectionCount = actualRows.filter(row => row.formulaDiagnosticScore != null && Number.isFinite(Number(row.formulaDiagnosticScore))).length;
  const rankingDirectionCount = actualRows.filter(row => diagnosticVerdict(
    row,
    row.formulaDiagnosticScore != null && Number.isFinite(Number(row.formulaDiagnosticScore)) ? Number(row.formulaDiagnosticScore) : null,
    row?.scoreAudit?.ok === true && row?.pairAudit?.passed !== false,
    row?.scoreStatus !== 'LEAGUE_MODEL_NOT_VALIDATED',
  ).ranking).length;
  return <section className="gameCard">
    <div className="gameHead">
      <div><h2>{matchup(item.game)}</h2><p>{localTime(item.game.gameDate)}｜{item.game.awayProbable || '先發未定'} 對 {item.game.homeProbable || '先發未定'}</p></div>
      <span className={`state ${item.status}`}>{item.statusLabel}</span>
    </div>
    {shadowMode && <div className="sourceBanner"><strong>V10.2 完整方向評估</strong><span>已開 {openMarketCount}/4 市場｜應評 {expectedDirectionCount} 方向｜已評 {scoredDirectionCount}/{expectedDirectionCount}｜進排名 {rankingDirectionCount}；資料QA與排名資格分開判定</span></div>}
    {item.actualSource && <div className="sourceBanner actualSource"><strong>{item.actualSource.label}</strong><span>更新：{localTime(item.actualSource.observedAt)}</span></div>}
    {item.error && <div className="errorBox">{item.error}</div>}
    {!item.referenceData && !item.error && <div className="emptyGame">{item.statusLabel}</div>}
    {item.referenceData && <>
      {(item.actualSource || item.marketCoverage || actualRows.length > 0) && <div className="actualBox">
        <div className="actualHead"><strong>Tai888 實際信用盤</strong><span>已開 {openMarketCount}/4 市場</span></div>
        {MARKET_ORDER.map(market => {
          const rows = actualRows.filter(row => row.market === market);
          const blocked = blockedMarkets.has(market);
          return <div className={`marketBlock actualMarket ${blocked ? 'blockedMarket' : rows.length ? 'availableMarket' : 'unavailableMarket'}`} key={market}><div className="marketTitle"><h3>{market}</h3><span>{rows.length || availableMarkets.has(market) ? 'AVAILABLE' : blocked ? 'BLOCKED' : 'UNAVAILABLE'}</span></div>{rows.length
            ? rows.map(row => <ResultRow key={rowKey(row)} row={row} game={item.game} betState={betsEnabled ? getBetState(item, row) : null} recordable={betRecordable(item, row, now, betsEnabled)} onBet={value => onBet(item, value)} now={now} verificationPending={analysisInProgress && readerBacked && !readerExecutable}/>)
            : <div className="marketPlaceholder">{blocked ? '資料異常｜不評分' : availableMarkets.has(market) ? '等待分析驗證' : '尚未開盤'}</div>}</div>;
        })}
      </div>}
      <details className="details"><summary>查看模型與QA明細</summary><div className="detailGrid">
        <div><span>分析類型</span><b>分數驗證中</b></div>
        <div><span>固定公式</span><b>{item.referenceData.analysis.scoreFormulaVersion}</b></div>
        <div><span>比分分布</span><b>{item.referenceData.analysis.distributionHash?.slice(0, 12) || '—'}</b></div>
        <div><span>資料狀態</span><b>{item.referenceData.analysis.analysisStatus}</b></div>
      </div></details>
    </>}
  </section>;
}

function LeagueSetupPanel({ config }) {
  const stages = [
    ['正式賽程', '建立台灣日期、場次識別與雙重賽唯一配對'],
    ['Tai888 Reader', `驗證「${config.readerPageHint}」四市場八方向實際頁面`],
    ['獨立模型', `建立 ${config.id} 專屬資料、機率校準與版本稽核`],
    ['正式啟用', '通過方向、盤口、水位、時間與下注安全回歸測試'],
  ];
  return <section className="leagueSetup panel">
    <div className="setupHead"><div><span className="kicker">獨立聯盟模組</span><h2>{config.label}正在建立正式資料鏈</h2></div><span className="state setup">{config.statusLabel}</span></div>
    <p className="muted">正式資料尚未驗證前不借用其他聯盟機率、不補造盤口，也不產生正式推薦；實際下注帳本仍可獨立使用。</p>
    <div className="setupGrid">{stages.map(([title, detail], index) => <div key={title}><b>{index + 1}</b><strong>{title}</strong><span>{detail}</span></div>)}</div>
  </section>;
}

function LeagueShadowPanel({ config }) {
  return <section className="leagueSetup panel">
    <div className="setupHead"><div><span className="kicker">V10 分數驗證</span><h2>{config.label}目前顯示完整分析分數（驗證中）</h2></div><span className="state shadow">尚未啟用正式推薦</span></div>
    <p className="muted">目前分數正在驗證準確度，可查看完整分析與排名；尚未啟用正式下注建議、正式Unit或以模型分數計算的正式績效。</p>
  </section>;
}

export default function Home() {
  const [league, setLeague] = useState('MLB');
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [bets, setBets] = useState([]);
  const [storageReady, setStorageReady] = useState(false);
  const [tab, setTab] = useState('board');
  const [date, setDate] = useState(taipeiDate());
  const [schedule, setSchedule] = useState([]);
  const [board, setBoard] = useState([]);
  const [readerStatus, setReaderStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ active: false, done: 0, total: 0, label: '' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [health, setHealth] = useState(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [acknowledgedReaderKey, setAcknowledgedReaderKey] = useState('');
  const snapshots = useRef(new Map());
  const creditRevisionRef = useRef('');
  const operationBusyRef = useRef(false);
  const readerPollBusyRef = useRef(false);
  const autoAnalyzeHashRef = useRef('');
  const autoAnalyzePendingRef = useRef('');
  const lastFullAnalysisAtRef = useRef(0);
  const currentDateRef = useRef(date);
  const currentLeagueRef = useRef(league);
  const analysisGenerationRef = useRef(0);
  const readerStatusRef = useRef(null);
  const readerStatusHighWaterRef = useRef(null);
  const cloudSyncBusyRef = useRef(false);
  const settlementBusyRef = useRef(false);
  const activeLeague = leagueConfig(league);
  const analysisEnabled = activeLeague.capabilities.analysis === true;
  const readerEnabled = activeLeague.capabilities.reader === true;
  const rankingEnabled = activeLeague.capabilities.ranking === true;
  const bettingEnabled = activeLeague.capabilities.bets === true;
  const shadowMode = activeLeague.status === 'shadow';
  const readerCoverage = readerCoverageCounts(readerStatus);
  const readerPendingText = coveragePendingText(readerCoverage);
  const shadowRanking = useMemo(() => board.flatMap(item => (item.customData?.analysis?.results || [])
    .filter(row => row.sourceType === 'ACTUAL_TW_CREDIT'
      && row.shadowDiagnosticScore != null
      && Number.isFinite(Number(row.shadowDiagnosticScore))
      && row.scoreAudit?.ok === true
      && row.pairAudit?.passed !== false
      && row.scoreStatus === 'SHADOW_DIAGNOSTIC_UNCALIBRATED'
      && Number(row.weightedEV) > 0
      && Number(row.robustEV) > 0
      && Number(row.shadowDiagnosticScore) >= 7.2)
    .map(row => ({ gamePk: item.game.gamePk, matchup: matchup(item.game), market: row.market, pick: row.pick,
      water: row.water, score: Number(row.shadowDiagnosticScore), weightedEV: row.weightedEV, robustEV: row.robustEV })))
    .sort((left, right) => right.score - left.score || Number(right.robustEV || 0) - Number(left.robustEV || 0)), [board]);

  function commitReaderStatus(value) {
    const highWater = readerStatusHighWaterRef.current;
    if (!shouldAcceptReaderStatus(highWater, value)) return false;
    readerStatusHighWaterRef.current = mergeReaderStatusHighWater(highWater, value);
    readerStatusRef.current = value;
    setReaderStatus(value);
    return true;
  }

  function invalidateReaderStatus(message) {
    const value = { ...(readerStatusRef.current || {}), fresh: false, message: String(message || '') };
    readerStatusRef.current = value;
    setReaderStatus(value);
  }

  function acquireOperation() {
    if (operationBusyRef.current || readerPollBusyRef.current) return false;
    operationBusyRef.current = true;
    setBusy(true);
    return true;
  }

  function releaseOperation() {
    operationBusyRef.current = false;
    setBusy(false);
  }

  async function refreshSettlements(targetLeague = '') {
    if (settlementBusyRef.current) return;
    settlementBusyRef.current = true;
    try {
      const data = await requestJSON('/api/bets', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'settleOpen', league: targetLeague, limit: 500 }),
      }, 120000);
      if (Array.isArray(data.bets)) setBets(current => mergeBetCollections(data.bets, current));
    } catch {
      // A temporary result-provider failure must not erase or rewrite the ledger.
    } finally {
      settlementBusyRef.current = false;
    }
  }

  useEffect(() => {
    const initial = loadCompactStore();
    setLeague(initial.activeLeague);
    setSettings(initial.settings);
    setBets(initial.bets);
    setStorageReady(true);
    cloudSyncBusyRef.current = true;
    requestJSON('/api/bets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'merge', bets: initial.bets }),
    }, 30000).then(data => setBets(current => mergeBetCollections(data.bets, current))).catch(() => {}).finally(() => { cloudSyncBusyRef.current = false; });
  }, []);
  useEffect(() => {
    if (storageReady) saveCompactStore({ settings, bets, activeLeague: league });
  }, [settings, bets, league, storageReady]);
  useEffect(() => {
    if (!storageReady) return undefined;
    const syncCloudBets = () => {
      if (cloudSyncBusyRef.current) return;
      cloudSyncBusyRef.current = true;
      requestJSON(`/api/bets?t=${Date.now()}`, {}, 20000)
        .then(data => { if (Array.isArray(data.bets)) setBets(current => mergeBetCollections(data.bets, current)); })
        .catch(() => {})
        .finally(() => { cloudSyncBusyRef.current = false; });
    };
    const onVisible = () => { if (document.visibilityState === 'visible') syncCloudBets(); };
    const timer = window.setInterval(syncCloudBets, 15000);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [storageReady]);
  useEffect(() => {
    if (!storageReady || !['bets', 'stats'].includes(tab)) return undefined;
    refreshSettlements(tab === 'bets' ? league : '');
    const timer = window.setInterval(() => refreshSettlements(tab === 'bets' ? league : ''), 10 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [storageReady, tab, league]);
  useEffect(() => {
    currentDateRef.current = date;
    currentLeagueRef.current = league;
    analysisGenerationRef.current += 1;
    snapshots.current.clear();
    creditRevisionRef.current = '';
    autoAnalyzeHashRef.current = '';
    autoAnalyzePendingRef.current = '';
    lastFullAnalysisAtRef.current = 0;
    setAcknowledgedReaderKey('');
    setSchedule([]);
    setBoard([]);
    readerStatusRef.current = null;
    readerStatusHighWaterRef.current = null;
    setReaderStatus(null);
  }, [date, league]);
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    requestJSON('/api/health', {}, 20000).then(setHealth).catch(() => setHealth(null));
  }, []);
  useEffect(() => {
    if (!readerEnabled || !analysisEnabled) return undefined;
    let active = true;
    const refreshReader = async () => {
      try {
        const stamp = Date.now();
        const [value, latest] = await Promise.all([
          requestJSON(`/api/reader/status?league=${encodeURIComponent(league)}&date=${encodeURIComponent(date)}&t=${stamp}`, {}, 20000),
          requestJSON(`/api/reader/status?league=${encodeURIComponent(league)}&t=${stamp}`, {}, 20000),
        ]);
        if (!active) return;
        if (latest?.fresh
          && /^\d{4}-\d{2}-\d{2}$/.test(String(latest.boardDate || ''))
          && latest.boardDate !== currentDateRef.current
          && !board.length
          && !operationBusyRef.current
          && !readerPollBusyRef.current) {
          setNotice(`已依 ${league} Tai888 Reader 自動切換至 ${latest.boardDate} 盤口日期。`);
          setDate(latest.boardDate);
          return;
        }
        commitReaderStatus(value);
        if (value?.fresh || board.length || operationBusyRef.current || readerPollBusyRef.current) return;
        if (!active || !latest?.fresh || !/^\d{4}-\d{2}-\d{2}$/.test(String(latest.boardDate || ''))) return;
        if (latest.boardDate !== currentDateRef.current) {
          setNotice(`已依 Tai888 Reader 自動切換至 ${latest.boardDate} 盤口日期。`);
          setDate(latest.boardDate);
        }
      } catch (cause) {
        if (active) invalidateReaderStatus(cause?.message || cause);
      }
    };
    refreshReader();
    const timer = window.setInterval(refreshReader, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [date, board.length, league, readerEnabled, analysisEnabled]);
  useEffect(() => {
    if (!readerEnabled || !analysisEnabled) return undefined;
    const hash = readerStatus?.payloadHash || '';
    const key = readerHashKey(date, hash);
    if (!readerStatus?.fresh || !key || board.length || busy || autoAnalyzeHashRef.current === key || autoAnalyzePendingRef.current === key) return;
    autoAnalyzePendingRef.current = key;
    let started = false;
    const timer = window.setTimeout(() => {
      started = true;
      Promise.resolve(oneClickAnalyze(key)).finally(() => {
        if (autoAnalyzePendingRef.current === key) autoAnalyzePendingRef.current = '';
      });
    }, 600);
    return () => {
      window.clearTimeout(timer);
      if (!started && autoAnalyzePendingRef.current === key) autoAnalyzePendingRef.current = '';
    };
  }, [readerStatus?.fresh, readerStatus?.payloadHash, board.length, busy, date, league, readerEnabled, analysisEnabled]);
  useEffect(() => {
    if (!readerEnabled || !analysisEnabled || !board.length) return undefined;
    const timer = window.setInterval(() => pollReaderAndReprice(), 30000);
    return () => window.clearInterval(timer);
  }, [board, date, busy, league, readerEnabled, analysisEnabled]);
  useEffect(() => {
    if (!readerEnabled || !analysisEnabled || !board.length) return undefined;
    const timer = window.setInterval(() => {
      if (!busy && readerStatus?.fresh && Date.now() - Number(lastFullAnalysisAtRef.current || 0) > 30 * 60 * 1000) oneClickAnalyze();
    }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [board.length, date, busy, readerStatus?.fresh, league, readerEnabled, analysisEnabled]);

  const currentReaderKey = readerRevisionKey(date, readerStatus?.payloadHash, readerStatus?.pageActivityAt);
  const currentReaderHashKey = readerHashKey(date, readerStatus?.payloadHash);
  const readerExecutable = readerEnabled
    && readerStatus?.fresh === true
    && readerStatus?.boardDate === date
    && Boolean(currentReaderHashKey)
    && (acknowledgedReaderKey === currentReaderHashKey || acknowledgedReaderKey.startsWith(`${currentReaderHashKey}:`));
  const itemReaderExecutable = item => readerEnabled
    && readerStatus?.fresh === true
    && readerStatus?.boardDate === date
    && Boolean(item?.readerPayloadHash)
    && item.readerPayloadHash === readerStatus?.payloadHash;

  const visibleBets = useMemo(
    () => bets.filter(bet => normalizeLeagueId(bet?.league) === league),
    [bets, league],
  );
  const visibleStats = useMemo(() => summarizeBetLedger(visibleBets), [visibleBets]);
  const allStats = useMemo(() => summarizeBetLedger(bets), [bets]);

  function getBetState(item, row) {
    const records = bets.filter(bet => betMatches(bet, date, item.game.gamePk, row, league))
      .sort((left, right) => Date.parse(right.placedAt || 0) - Date.parse(left.placedAt || 0));
    return {
      records,
      latest: records[0] || null,
      exact: records.find(bet => betPriceMatches(bet, date, item.game.gamePk, row, league)) || null,
    };
  }

  function updateBoard(gamePk, updater) {
    setBoard(current => current.map(item => item.game.gamePk === gamePk ? updater(item) : item));
  }

  async function fetchSchedule(targetDate = date) {
    if (!activeLeague.scheduleEndpoint) throw new Error(`${activeLeague.label}正式賽程尚未接入，不能進行分析`);
    const data = await requestJSON(`${activeLeague.scheduleEndpoint}?league=${encodeURIComponent(league)}&date=${encodeURIComponent(targetDate)}&t=${Date.now()}`, {}, 40000);
    const rows = Array.isArray(data.games) ? data.games.filter(game => gameIsPrestartNow(game, Date.now())) : [];
    if (currentDateRef.current === targetDate) setSchedule(rows);
    return rows;
  }

  async function confirmLiveReaderHash(targetDate, payloadHash, generation) {
    const live = await requestJSON(`/api/reader/status?league=${encodeURIComponent(league)}&date=${encodeURIComponent(targetDate)}&t=${Date.now()}`, {}, 20000);
    if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;
    commitReaderStatus(live);
    const current = readerStatusRef.current;
    return liveReaderHashMatches(targetDate, current, payloadHash);
  }

  async function analyzeBoardItem(task, index, total, retry = false) {
    if (task.generation !== analysisGenerationRef.current) return false;
    const game = task.game;
    const actualMarkets = task.actualMarkets || [];
    setProgress(value => ({ ...value, running: (Number(value.running) || 0) + 1 }));
    updateBoard(game.gamePk, item => ({ ...item, status: 'running', statusLabel: retry ? '重新建立驗證用比分分布中…' : '建立驗證用比分分布中…' }));
    try {
      const baseData = await requestJSON('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({
          league,
          game,
          markets: actualMarkets,
          verificationMarkets: [],
          settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },
        }),
      }, ANALYSIS_REQUEST_TIMEOUT_MS);
      if (task.generation !== analysisGenerationRef.current) return false;
      snapshots.current.set(game.gamePk, baseData.repriceSnapshot);
      updateBoard(game.gamePk, item => ({
        ...item,
        referenceData: compactAnalysisData(baseData),
        mode: 'actual',
        status: 'done',
        statusLabel: 'Tai888盤口分析完成（驗證中）',
        customMarkets: actualMarkets,
        customData: compactAnalysisData(baseData),
        error: '',
      }));
      return true;
    } catch (cause) {
      if (task.generation !== analysisGenerationRef.current) return false;
      const message = String(cause?.message || cause);
      const blocked = /資料不足｜不評分|比賽已開打或結束/.test(message);
      const permanent = blocked || /HTTP (?:400|401|403|404|422)\b|CORE_DATA_MISSING|GAME_ALREADY_STARTED|INVALID_[A-Z_]+/.test(message);
      task.retryable = !permanent;
      updateBoard(game.gamePk, item => ({
        ...item,
        status: blocked ? 'blocked' : 'failed',
        statusLabel: blocked ? '資料不足｜不評分' : '分析失敗',
        error: message,
      }));
      return false;
    } finally {
      if (task.generation === analysisGenerationRef.current) {
        setProgress(value => ({
          ...value,
          done: Math.min(total, Number(value.done || 0) + 1),
          running: Math.max(0, Number(value.running || 0) - 1),
        }));
      }
    }
  }

  async function oneClickAnalyze(automaticKey = '') {
    if (!analysisEnabled) {
      setError(`${activeLeague.label}尚未完成正式賽程與Reader驗證，目前不能分析。`);
      return false;
    }
    if (!acquireOperation()) return false;
    const requestedAutoKey = typeof automaticKey === 'string' ? automaticKey : '';
    const targetDate = date;
    const generation = analysisGenerationRef.current;
    setError(''); setNotice(''); setTab('board'); snapshots.current.clear();
    setBoard(current => current.map(item => item.actualSource?.provider === 'TAI888_READER_AUTO'
      ? { ...item, actualSource: null, customMarkets: [], customData: null, status: 'running', statusLabel: '重新驗證Tai888盤口中…', error: '' }
      : item));
    try {
      setProgress({ active: true, done: 0, running: 1, total: 1, label: `取得今日${activeLeague.shortLabel}賽事` });
      const games = await fetchSchedule(targetDate);
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;
      if (!games.length) throw new Error(`這個日期沒有可分析的賽前${activeLeague.shortLabel}賽事`);

      setProgress({ active: true, done: 0, running: 1, total: 1, label: '取得Tai888信用盤' });
      const credit = await requestJSON('/api/credit-lines', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() }, body: JSON.stringify({ league, date: targetDate, schedule: games }),
      }, 60000);
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;

      if (credit?.readerStatus) commitReaderStatus({
        ...credit.readerStatus,
        boardDate: credit.boardDate,
        payloadHash: credit.payloadHash,
        rawBoardHash: credit.rawBoardHash,
        rawGameCount: credit.rawGameCount,
        matchedGameCount: credit.matchedGameCount,
        unopenedGameCount: credit.unopenedGameCount,
        scheduleGameCount: credit.scheduleGameCount,
        observedAt: credit.observedAt,
        receivedAt: credit.receivedAt,
        pageActivityAt: credit.pageActivityAt,
      });

      const readerCreditReady = credit?.provider === 'TAI888_READER_AUTO' && credit?.readerFresh === true;
      const creditByPk = new Map((readerCreditReady ? credit.games || [] : []).map(row => [Number(row.gamePk), row]));
      const items = games.map(game => {
        const foundCredit = creditByPk.get(Number(game.gamePk));
        const available = Boolean(foundCredit?.markets?.length);
        return {
          game,
          mode: 'actual',
          actualSource: foundCredit?.source || null,
          marketCoverage: foundCredit?.marketCoverage || null,
          readerPayloadHash: available ? credit.payloadHash : null,
          customMarkets: foundCredit?.markets || [],
          status: available ? 'queued' : 'unopened',
          statusLabel: available ? '等待分析' : '目前尚無可配對盤口',
          referenceData: null,
          customData: null,
          error: '',
        };
      });
      setBoard(items);

      const tasks = items.filter(item => item.customMarkets.length).map(item => ({
        game: item.game,
        actualMarkets: item.customMarkets,
        generation,
      }));
      const coverage = readerCoverageCounts({
        rawGameCount: credit.rawGameCount,
        matchedGameCount: credit.matchedGameCount ?? tasks.length,
        unopenedGameCount: credit.unopenedGameCount,
        scheduleGameCount: credit.scheduleGameCount || games.length,
      });
      const sourceWarnings = [
        credit.error ? `Tai888信用盤：${credit.error}` : '',
        credit.blocked && credit.message ? `Tai888信用盤：${credit.message}` : '',
        ...(credit.warnings || []),
      ].filter(Boolean);

      if (!tasks.length) {
        setNotice(sourceWarnings.join('；') || credit.message || `目前 Tai888 Reader 沒有可分析的${activeLeague.shortLabel}信用盤。`);
        setProgress({ active: false, done: 0, running: 0, total: 0, label: '' });
        return false;
      }

      setProgress({ active: true, done: 0, running: 0, total: tasks.length, label: '分析今日全部盤口' });
      const outcomes = new Array(tasks.length).fill(false);
      await runPool(tasks, 3, async (task, index) => {
        outcomes[index] = await analyzeBoardItem(task, index, tasks.length);
      });
      const retryIndexes = outcomes.map((ok, index) => ok || tasks[index]?.retryable === false ? -1 : index).filter(index => index >= 0);
      if (retryIndexes.length && generation === analysisGenerationRef.current && currentDateRef.current === targetDate) {
        setProgress({ active: true, done: 0, running: 0, total: retryIndexes.length, label: `重試 ${retryIndexes.length} 場未完成分析` });
        await runPool(retryIndexes, 2, async (taskIndex, retryIndex) => {
          outcomes[taskIndex] = await analyzeBoardItem(tasks[taskIndex], retryIndex, retryIndexes.length, true);
        });
      }
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;
      const creditCount = tasks.filter(task => task.actualMarkets.length).length;
      const completedCreditCount = tasks.reduce((count, task, index) => count + (task.actualMarkets.length && outcomes[index] ? 1 : 0), 0);
      const failedCreditCount = creditCount - completedCreditCount;
      const readerHashRequired = Boolean(credit?.readerFresh && creditCount > 0);
      const hashEligible = readerHashRequired && shouldAcknowledgeReaderHash({
        payloadHash: credit.payloadHash,
        expectedCount: creditCount,
        completedCount: completedCreditCount,
        failedCount: failedCreditCount,
      });
      let readerHashAcknowledged = !readerHashRequired;
      const creditRevision = readerRevisionKey(targetDate, credit.payloadHash, credit.pageActivityAt);
      if (hashEligible && await confirmLiveReaderHash(targetDate, credit.payloadHash, generation)) {
        creditRevisionRef.current = creditRevision;
        const completedKey = readerHashKey(targetDate, credit.payloadHash);
        autoAnalyzeHashRef.current = completedKey;
        setAcknowledgedReaderKey(completedKey);
        if (requestedAutoKey && requestedAutoKey !== completedKey) autoAnalyzeHashRef.current = completedKey;
        readerHashAcknowledged = true;
      }
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;
      const analysisSucceeded = outcomes.every(Boolean);
      const allSucceeded = analysisSucceeded && readerHashAcknowledged;
      const completedCount = outcomes.filter(Boolean).length;
      const failedCount = tasks.length - completedCount;
      if (allSucceeded) lastFullAnalysisAtRef.current = Date.now();
      if (allSucceeded) {
        setNotice(`Reader讀取 ${coverage.captured}/${coverage.total} 場｜完成 ${tasks.length} 場驗證分析｜${coveragePendingText(coverage)}${sourceWarnings.length ? `｜提醒：${sourceWarnings.join('；')}` : ''}`);
      } else if (analysisSucceeded && !readerHashAcknowledged) {
        setNotice(`Reader讀取 ${coverage.captured}/${coverage.total} 場｜已完成 ${tasks.length} 場分析｜${coveragePendingText(coverage)}，但 Reader 在分析期間出現更新；舊盤暫停記錄。`);
        setError('Reader 最新盤面版本尚未完成驗證，系統將自動重新分析。');
        window.setTimeout(() => {
          if (generation === analysisGenerationRef.current && currentDateRef.current === targetDate) oneClickAnalyze();
        }, 800);
      } else {
        setNotice(`Reader讀取 ${coverage.captured}/${coverage.total} 場｜已完成 ${completedCount}/${tasks.length} 場分析｜${coveragePendingText(coverage)}${sourceWarnings.length ? `｜提醒：${sourceWarnings.join('；')}` : ''}`);
        const readerHashPending = Boolean(credit?.readerFresh && creditCount > 0 && failedCreditCount > 0);
        setError(`${failedCount} 場分析失敗${readerHashPending ? '，Reader 最新盤面版本尚未承認' : ''}；請查看各場錯誤後重試。`);
      }
      return allSucceeded;
    } catch (cause) { setError(String(cause?.message || cause)); return false; }
    finally { releaseOperation(); setProgress(value => ({ ...value, active: false })); }
  }

  async function pollReaderAndReprice() {
    if (operationBusyRef.current || readerPollBusyRef.current || !board.length) return;
    const targetDate = date;
    const generation = analysisGenerationRef.current;
    const stillCurrent = () => generation === analysisGenerationRef.current && currentDateRef.current === targetDate;
    readerPollBusyRef.current = true;
    try {
      const status = await requestJSON(`/api/reader/status?league=${encodeURIComponent(league)}&date=${encodeURIComponent(targetDate)}&t=${Date.now()}`, {}, 20000);
      if (!stillCurrent()) return;
      commitReaderStatus(status);
      const currentStatus = readerStatusRef.current;
      const statusRevision = readerRevisionKey(targetDate, currentStatus?.payloadHash, currentStatus?.pageActivityAt);
      if (!currentStatus?.fresh || !statusRevision || statusRevision === creditRevisionRef.current) return;
      const games = schedule.length ? schedule : board.map(item => item.game);
      const credit = await requestJSON('/api/credit-lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ league, date: targetDate, schedule: games }),
      }, 60000);
      if (!stillCurrent()) return;
      const creditRevision = readerRevisionKey(targetDate, credit.payloadHash, credit.pageActivityAt);
      if (credit.provider !== 'TAI888_READER_AUTO' || !credit.readerFresh || !creditRevision || creditRevision === creditRevisionRef.current) return;
      const creditByPk = new Map((credit.games || []).map(row => [Number(row.gamePk), row]));
      const boardPks = new Set(board.map(item => Number(item.game.gamePk)));
      const expectedItems = board.filter(item => creditByPk.has(Number(item.game.gamePk)) || item.actualSource?.provider === 'TAI888_READER_AUTO');
      let failed = [...creditByPk.keys()].filter(gamePk => !boardPks.has(gamePk)).length;
      let completed = 0;
      let updated = 0;
      let removed = 0;
      await runPool(board, 2, async item => {
        if (!stillCurrent()) return;
        const actual = creditByPk.get(Number(item.game.gamePk));
        if (!actual?.markets?.length) {
          if (item.actualSource?.provider === 'TAI888_READER_AUTO') {
            updateBoard(item.game.gamePk, current => ({ ...current, actualSource: null, readerPayloadHash: null, customMarkets: [], customData: null, referenceData: null, status: 'unopened', statusLabel: 'Tai888實際盤已下架' }));
            if (item.customMarkets?.length) removed += 1;
            completed += 1;
          }
          return;
        }
        const snapshot = snapshots.current.get(item.game.gamePk);
        if (!snapshot || !item.referenceData) { failed += 1; return; }
        try {
          const data = await requestJSON('/api/reprice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
            body: JSON.stringify({
              league,
              snapshot,
              markets: actual.markets,
              previousMarkets: item.customMarkets || [],
              verificationMarkets: [],
              settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },
            }),
          }, 120000);
          if (!stillCurrent()) return;
          snapshots.current.set(item.game.gamePk, data.repriceSnapshot);
          updateBoard(item.game.gamePk, current => ({
            ...current,
            actualSource: actual.source,
            readerPayloadHash: credit.payloadHash,
            customMarkets: actual.markets,
            customData: compactAnalysisData(data),
            status: 'done',
            statusLabel: 'Tai888最新盤快速重算完成',
            error: '',
          }));
          updated += 1;
          completed += 1;
        } catch { failed += 1; }
      });
      if (!stillCurrent()) return;
      const hashEligible = shouldAcknowledgeReaderHash({ payloadHash: credit.payloadHash, expectedCount: expectedItems.length, completedCount: completed, failedCount: failed });
      const acknowledged = hashEligible && await confirmLiveReaderHash(targetDate, credit.payloadHash, generation);
      if (!stillCurrent()) return;
      if (acknowledged) {
        creditRevisionRef.current = creditRevision;
        const completedKey = readerHashKey(targetDate, credit.payloadHash);
        autoAnalyzeHashRef.current = completedKey;
        setAcknowledgedReaderKey(completedKey);
      }
      if (updated || removed) {
        setNotice(`Tai888盤口已自動更新：${updated}場快速重算${removed ? '｜' + removed + '場已下架清除' : ''}${failed ? '｜' + failed + '場改走完整分析' : ''}。`);
      }
      if (!acknowledged) window.setTimeout(() => {
        if (stillCurrent()) oneClickAnalyze();
      }, 800);
    } catch (cause) {
      if (stillCurrent()) invalidateReaderStatus(cause?.message || cause);
    } finally {
      readerPollBusyRef.current = false;
    }
  }

  async function recordBet(item, row) {
    if (!bettingEnabled) {
      setError(`${activeLeague.label}目前不可寫入實際下注紀錄`);
      return;
    }
    const state = getBetState(item, row);
    if (state.exact) {
      setNotice(`目前盤口與水位已經記錄：${row.pick}｜${Number(row.water).toFixed(3)}`);
      return;
    }
    if (!betRecordable(item, row, Date.now(), bettingEnabled)) {
      setError('只有仍未開賽、Reader最新驗證完成且有實際信用盤水位的方向可以記錄');
      return;
    }
    const identity = betIdentity(date, item.game.gamePk, row, league);
    const positionIdentity = betPositionIdentity(date, item.game.gamePk, row, league);
    const bet = {
      id: uid(),
      identity,
      positionIdentity,
      league,
      date,
      gamePk: item.game.gamePk,
      gameNumber: item.game.gameNumber || 1,
      officialDate: item.game.officialDate || date,
      matchup: matchup(item.game),
      gameDate: item.game.gameDate,
      away: translateTeamText(item.game.away || ''),
      home: translateTeamText(item.game.home || ''),
      market: row.market,
      pick: row.pick,
      water: row.water,
      stake: settings.unitValue,
      unit: 1,
      rebateRate: settings.rebateRate,
      betSource: 'MANUAL',
      analysisMode: 'SHADOW',
      score: null,
      scoreStatus: 'SHADOW_DIAGNOSTIC_NOT_FORMAL',
      formulaDiagnosticScore: row.formulaDiagnosticScore ?? null,
      shadowDiagnosticScore: row.shadowDiagnosticScore ?? null,
      legacyDiagnosticScore: row.legacyDiagnosticScore ?? null,
      weightedEV: row.weightedEV,
      robustEV: row.robustEV,
      qaStatus: row.scoreAudit?.ok === false ? 'BLOCK' : 'SHADOW_DIAGNOSTIC',
      placedContractSnapshot: {
        pick: row.pick,
        water: row.water,
        market: row.market,
        sourceType: row.sourceType,
        lineAsOf: row.lineAsOf || null,
      },
      lineAsOf: row.lineAsOf || null,
      readerPayloadHash: readerStatus?.payloadHash || null,
      rawBoardHash: readerStatus?.rawBoardHash || null,
      readerRevision: currentReaderKey || null,
      snapshotId: item.customData?.analysis?.snapshotId || null,
      analysisAsOf: item.customData?.analysis?.analysisAsOf || null,
      modelVersion: item.customData?.analysis?.modelVersion || row.modelVersion || null,
      scoreFormulaVersion: row.scoreFormulaVersion || item.customData?.analysis?.scoreFormulaVersion || null,
      settlementRuleVersion: row.settlementRuleVersion || null,
      qa: { scoreAudit: row.scoreAudit || null, pairAudit: row.pairAudit || null, thirdAudit: row.thirdAudit || null },
      placedAt: new Date().toISOString(),
      status: 'OPEN',
    };
    try {
      const data = await requestJSON('/api/bets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'upsert', bet }) }, 30000);
      setBets(current => mergeBetCollections(data.bets, [bet, ...current]));
      setError('');
      setNotice(`已雲端記錄實際下注：${row.pick}｜${Number(row.water).toFixed(3)}｜${Number(settings.unitValue).toLocaleString()}元`);
    } catch (cause) { setError(cause?.message || '雲端下注紀錄更新失敗'); }
  }

  async function deleteBet(bet) {
    if (!bet?.id || !window.confirm(`確定刪除這筆下注紀錄？\n${bet.pick}｜${waterText(bet.water)}`)) return;
    try {
      const data = await requestJSON('/api/bets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', betId: bet.id }) }, 30000);
      setBets(Array.isArray(data.bets) ? data.bets : []);
      setNotice(`已刪除下注紀錄：${bet.pick}`);
    } catch (cause) { setError(cause?.message || '雲端下注紀錄更新失敗'); }
  }

  async function clearLeagueBets() {
    if (!visibleBets.length || !window.confirm(`確定清空全部${activeLeague.shortLabel}下注紀錄？`)) return;
    try {
      const data = await requestJSON('/api/bets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'clearLeague', league }) }, 30000);
      setBets(Array.isArray(data.bets) ? data.bets : []);
      setNotice(`已清空${activeLeague.shortLabel}雲端下注紀錄`);
    } catch (cause) { setError(cause?.message || '雲端下注紀錄更新失敗'); }
  }

  function selectLeague(value) {
    const nextLeague = normalizeLeagueId(value);
    if (busy || nextLeague === league) return;
    currentLeagueRef.current = nextLeague;
    analysisGenerationRef.current += 1;
    setError('');
    setNotice('');
    setTab('board');
    setLeague(nextLeague);
  }

  return <main className="appShell">
    <header className="appHeader">
      <div><div className="eyebrow">BASEBALL DATA & BET LEDGER</div><h1>{activeLeague.label}｜盤口與實際下注系統</h1><p>Tai888 Reader持續同步實際信用盤；V10 S 分數來自原始聯合比分分布，目前正在驗證準確度，尚未啟用正式下注建議。下注紀錄、盤口比較、賽果結算與績效統計獨立運作。</p></div>
      <div className="headerBadges"><span className={health?.ok ? 'health ok' : 'health warn'}>{health?.ok ? '系統正常' : '系統檢查中'}</span><span className={`state ${activeLeague.status}`}>{activeLeague.statusLabel}</span><span className="version">v{VERSION}</span></div>
    </header>

    <nav className="leagueTabs" aria-label="聯盟切換">
      {LEAGUE_IDS.map(id => {
        const config = leagueConfig(id);
        return <button key={id} className={league === id ? 'active' : ''} disabled={busy} onClick={() => selectLeague(id)} aria-pressed={league === id}>
          <span className={`leagueDot ${config.status}`}/><b>{id}</b><small>{config.shortLabel}</small>
        </button>;
      })}
    </nav>

    <nav className="mainTabs">
      <button className={tab === 'board' ? 'active' : ''} onClick={() => setTab('board')}>今日盤口</button>
      <button className={tab === 'ranking' ? 'active' : ''} onClick={() => setTab('ranking')}>分析排名（驗證中）</button>
      <button className={tab === 'bets' ? 'active' : ''} onClick={() => setTab('bets')}>下注紀錄</button>
      <button className={tab === 'stats' ? 'active' : ''} onClick={() => setTab('stats')}>績效統計</button>
      <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>設定</button>
    </nav>

    {error && <div className="errorBox global"><strong>發生問題</strong><span>{error}</span><button onClick={() => setError('')}>關閉</button></div>}
    {notice && <div className="noticeBox">{notice}</div>}
    <LoadingLine progress={progress}/>

    {tab === 'board' && <>
      <section className="heroCard">
        <div className="heroCopy"><span className="kicker">每日主要操作</span><h2>同步今日全部 {activeLeague.id} 實際盤</h2><p>只使用Reader同步的實際信用盤。模型分數目前驗證中，可查看完整分析與排名，尚未啟用正式下注建議；按下「紀錄實際下注」會永久保存當下盤口、水位、Reader版本與金額。</p></div>
        <div className="heroControls"><label>台灣日期<input type="date" value={date} disabled={busy} onChange={event => setDate(event.target.value)}/></label><button className="primary giant" disabled={busy || !analysisEnabled} onClick={() => oneClickAnalyze()}>{busy ? '執行中…' : analysisEnabled ? `同步今日 ${activeLeague.id}` : `${activeLeague.id} 尚未啟用`}</button></div>
        <div className={`providerState ${analysisEnabled && readerExecutable ? 'ready' : 'missing'}`}>
          <strong>{!analysisEnabled ? `${activeLeague.label} Reader尚未驗證` : readerExecutable ? 'Tai888 Reader自動同步正常｜目前畫面已驗證' : readerStatus?.fresh ? 'Tai888 Reader新盤已同步｜等待分析驗證' : readerStatus?.stale ? 'Tai888 Reader盤口已過期' : 'Tai888 Reader等待同步'}</strong>
          <span>{!analysisEnabled ? '資料與盤口保持鎖定。' : readerStatus?.fresh ? `最後同步：${localTime(readerStatus?.receivedAt)}｜Reader已讀取${readerCoverage.captured}/${readerCoverage.total}場｜已開盤${readerCoverage.open}場｜${readerPendingText}｜每30秒複核｜固定 S 分數啟用｜正式推薦停用` : readerStatus?.message || `保持唯一一台讀盤電腦、Chrome與Tai888 ${activeLeague.shortLabel}頁面開啟。`}</span>
        </div>
      </section>
      {!analysisEnabled && <LeagueSetupPanel config={activeLeague}/>}
      {analysisEnabled && shadowMode && <LeagueShadowPanel config={activeLeague}/>}
      {analysisEnabled && !board.length && <section className="emptyBoard"><div>⚾</div><h2>尚未建立今日盤口</h2><p>按上方按鈕後，Reader已同步的Tai888信用盤會一次列出。</p></section>}
      {analysisEnabled && board.map(item => <GameCard key={`${league}-${item.game.gamePk}`} item={item} onBet={recordBet} getBetState={getBetState} readerExecutable={itemReaderExecutable(item)} analysisInProgress={progress.active} now={clockNow} betsEnabled={bettingEnabled} shadowMode={shadowMode}/>) }
    </>}

    {tab === 'ranking' && <section className="panel"><div className="panelHead"><h2>分析排名（驗證中）</h2><span className="state shadow">驗證中</span></div>
      <div className="emptySmall">目前分數正在驗證準確度，可查看完整分析與排名；此處只列雙EV為正、分數達7.2且資料QA通過的方向。🟡觀察、⚪PASS、QA BLOCK與未驗證聯盟仍保留分數與原因，但不進排名。尚未啟用正式下注建議、正式Unit或以模型分數計算的正式績效。</div>
      {shadowRanking.length ? shadowRanking.map((entry, index) => <div className="rankRow" key={`${entry.gamePk}-${entry.market}-${entry.pick}`}><b>{index + 1}</b><strong>{entry.score.toFixed(1)}</strong><div><span>{entry.score >= 8.5 ? '🔥' : '🟢'} {entry.matchup}｜{entry.market}｜{entry.pick}｜{waterText(entry.water)}</span><small>加權EV {pct(entry.weightedEV)}｜穩健EV {pct(entry.robustEV)}｜資料QA PASS｜分析候選、驗證中且非正式推薦</small></div></div>) : <div className="emptySmall">目前沒有同時符合「雙EV為正＋7.2以上＋資料QA通過」的方向。</div>}
    </section>}

    {tab === 'bets' && <section className="panel">
      <div className="panelHead"><h2>{activeLeague.label}｜雲端實際下注帳本</h2><div>{bettingEnabled && <button className="textButton" onClick={() => refreshSettlements(league)}>更新賽果</button>}{bettingEnabled && <button className="textButton" disabled={!visibleBets.length} onClick={clearLeagueBets}>清空本聯盟</button>}</div></div>
      <SummaryCards summary={visibleStats.overall}/>
      {bettingEnabled && visibleBets.length ? visibleBets.map(bet => <div className="betRow" key={bet.id}>
        <div><strong><span className="leagueBadge inline">{bet.league}</span>{bet.pick}｜{waterText(bet.water)}</strong><span>{bet.matchup}｜{bet.market}｜{statusText(bet.status)}{bet.settlement?.outcome ? `｜${outcomeText(bet.settlement.outcome)}` : ''}</span><small>下注：{localTime(bet.placedAt)}｜{Number(bet.stake || 0).toLocaleString()}元｜模型分數未列入績效</small></div>
        <div style={{ textAlign: 'right' }}><strong>{bet.status === 'SETTLED' ? moneyText(bet.settlement?.netProfit) : '待結算'}</strong><br/><button className="textButton" onClick={() => deleteBet(bet)}>刪除</button></div>
      </div>) : <div className="emptySmall">尚未記錄{activeLeague.shortLabel}實際下注。</div>}
    </section>}

    {tab === 'stats' && <section className="panel">
      <div className="panelHead"><h2>全部聯盟｜實際下注績效</h2><button className="textButton" onClick={() => refreshSettlements('')}>更新全部賽果</button></div>
      <SummaryCards summary={allStats.overall}/>
      {allStats.groups.length ? allStats.groups.map(group => {
        const [groupLeague, market] = group.key.split('|||');
        return <div className="betRow" key={group.key}><div><strong><span className="leagueBadge inline">{groupLeague}</span>{market}</strong><span>{group.wins}勝／{group.losses}敗／{group.pushes}走／{group.halfWins}贏半／{group.halfLosses}輸半</span></div><small>{group.settled}筆已結算｜勝率 {pct(group.winRate)}｜ROI {pct(group.roi)}｜{moneyText(group.netPnl)}</small></div>;
      }) : <div className="emptySmall">完成第一筆賽果結算後，這裡會依聯盟與全場讓分、全場大小、上半讓分、上半大小分開統計。</div>}
    </section>}

    {tab === 'settings' && <section className="panel"><div className="panelHead"><h2>{activeLeague.label}｜設定</h2><span className={`state ${activeLeague.status}`}>{activeLeague.statusLabel}</span></div><div className="settingsGrid"><label>1 Unit 金額<input type="number" value={settings.unitValue} min="100" step="100" onChange={event => setSettings(value => ({ ...value, unitValue: Number(event.target.value) || 10000 }))}/></label><label>V10模擬次數／情境<select value={settings.simulationsPerScenario} onChange={event => setSettings(value => ({ ...value, simulationsPerScenario: Number(event.target.value) }))}><option value="4000">4000（固定）</option></select></label></div><div className="settingsNote"><b>模型：{activeLeague.modelFamily}</b><br/>目前全部聯盟的分析分數均在驗證中，可查看完整分數與排名，但尚未形成正式推薦或Unit；實際下注帳本使用伺服器端資料庫，賽後依台灣信用盤逐腿結算與每萬退150規則計算。localStorage只作裝置快取，不是正式資料真值。</div></section>}

  </main>;
}
