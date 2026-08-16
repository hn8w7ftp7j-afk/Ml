'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MARKET_ORDER, breakEvenProbability, hasActualWater } from '../lib/markets.js';
import { betIdentity, betMatches } from '../lib/bet-ledger.js';
import { translateTeamText } from '../lib/i18n.js';
import { LEAGUE_IDS, leagueCanAnalyze, leagueConfig, normalizeLeagueId } from '../lib/leagues.js';
import {
  actualLineFreshNow,
  formalBetEligibility,
  gameIsPrestartNow,
  liveReaderHashMatches,
  mergeReaderStatusHighWater,
  readerHashKey,
  readerRevisionKey,
  shouldAcceptReaderStatus,
  shouldAcknowledgeReaderHash,
} from '../lib/client-analysis-state.js';

const VERSION = '9.5.0';
const STORAGE = 'sports-positive-ev-v9-5-0';
const LEGACY_KEYS = ['mlb-positive-ev-v9-4-4', 'mlb-positive-ev-v9-4-3', 'mlb-positive-ev-v9-4-2', 'mlb-positive-ev-v9-4-1', 'mlb-positive-ev-v9-4-0', 'mlb-positive-ev-v9-3-4', 'mlb-positive-ev-v9-3-3', 'mlb-positive-ev-v9-3-2', 'mlb-positive-ev-v9-3', 'mlb-positive-ev-v9-2', 'mlb-positive-ev-v9-1-preview', 'mlb-positive-ev-v8-4', 'mlb-positive-ev-v7'];
const DEFAULT_SETTINGS = {
  unitValue: 10000,
  rebateRate: 0.015,
  simulationsPerScenario: 1800,
  fallbackWater: { 全場讓分: 0.95, 全場大小: 0.94, 上半讓分: 0.94, 上半大小: 0.93 },
};

const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const pct = value => value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(2)}%`;
const scoreText = value => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(1);
const waterText = value => hasActualWater(value) ? Number(value).toFixed(3) : '水位未提供';
const matchup = game => `${translateTeamText(game?.away || '')} 對 ${translateTeamText(game?.home || '')}`;

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
      return {
        settings: { ...DEFAULT_SETTINGS, ...(own.settings || {}), fallbackWater: { ...DEFAULT_SETTINGS.fallbackWater, ...(own.settings?.fallbackWater || {}) } },
        bets: Array.isArray(own.bets) ? own.bets.slice(0, 500) : [],
        activeLeague: normalizeLeagueId(own.activeLeague),
      };
    }
    for (const key of LEGACY_KEYS) {
      const legacy = safeParse(window.localStorage.getItem(key) || 'null');
      if (!legacy || typeof legacy !== 'object') continue;
      return {
        settings: { ...DEFAULT_SETTINGS, ...(legacy.settings || {}), fallbackWater: { ...DEFAULT_SETTINGS.fallbackWater, ...(legacy.settings?.fallbackWater || {}) } },
        bets: Array.isArray(legacy.bets) ? legacy.bets.slice(0, 500) : [],
        activeLeague: 'MLB',
      };
    }
  } catch {
    // Safari private mode, quota failures and corrupted legacy storage must never crash the app.
  }
  return { settings: DEFAULT_SETTINGS, bets: [], activeLeague: 'MLB' };
}

function saveCompactStore(value) {
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify({ settings: value.settings, bets: value.bets.slice(0, 500), activeLeague: normalizeLeagueId(value.activeLeague) }));
    return true;
  } catch {
    try { window.localStorage.removeItem(STORAGE); } catch {}
    return false;
  }
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

function compactAnalysisData(data) {
  return { game: data.game, context: data.context, analysis: data.analysis, openMarkets: data.openMarkets || [] };
}

function scoreClass(score) {
  const value = Number(score);
  if (value >= 8.5) return 'score strongest';
  if (value >= 7.2) return 'score candidate';
  return 'score pass';
}

function LoadingLine({ progress }) {
  if (!progress?.active) return null;
  const ratio = progress.total ? Math.round(progress.done / progress.total * 100) : 0;
  return <div className="progressBox"><div className="progressTop"><strong>{progress.label}</strong><span>{progress.done}/{progress.total}</span></div><div className="progressTrack"><i style={{ width: `${ratio}%` }}/></div></div>;
}

function ResultRow({ row, onBet, betRecorded = false, now, verificationPending = false }) {
  const actualLine = row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water);
  const formal = actualLine && row.executable === true && actualLineFreshNow(row, now);
  const breakEven = actualLine ? breakEvenProbability(row.water, 0.015) : null;
  const eligibility = formalBetEligibility(row, 7.2, now);
  const candidate = Number.isFinite(Number(row.score)) && Number(row.score) >= 7.2;
  return <div className={`scoreRow ${eligibility.passed ? 'qualified' : ''}`}>
    <div className={scoreClass(row.score)}>{scoreText(row.score)}</div>
    <div className="scoreBody">
      <div className="scorePick">{row.pick || '水位未提供｜不評分'}</div>
      <div className="scorePrice">信用盤水位 {waterText(row.water)}</div>
      <div className="scoreMeta">校準等值勝率 {pct(row.modelProbability)}｜損益兩平 {pct(breakEven)}｜正式EV {pct(row.weightedEV)}｜穩健EV {pct(row.robustEV)}｜{row.tag || '—'}</div>
      {actualLine && candidate && <div className={`qaLine ${verificationPending ? 'pending' : ''}`}>{verificationPending
        ? '驗證中｜等待今日整批盤口分析完成'
        : `QA：${eligibility.passed ? 'PASS｜合約✓ 水碼✓ 鏡像✓ 機率100%✓ EV雙算✓ 分數上限✓' : 'BLOCK｜未通過完整正式下注門檻'}`}</div>}
    </div>
    <div className="rowActions">
      {(eligibility.passed || betRecorded) && <button className={`mini ${betRecorded ? 'recorded' : 'green'}`} title={betRecorded ? '再按一次可取消標記' : '標記這個盤口已下注'} onClick={() => onBet(row)}>{betRecorded ? '已下注 ✓' : '記錄下注'}</button>}
    </div>
  </div>;
}

function GameCard({ item, onBet, isBetRecorded, readerExecutable, now, analysisInProgress = false }) {
  const readerBacked = item.actualSource?.provider === 'TAI888_READER_AUTO';
  const gamePrestart = gameIsPrestartNow(item.game, now);
  const actualRows = (item.customData?.analysis?.results || []).filter(row => row.sourceType === 'ACTUAL_TW_CREDIT').map(row => {
    if (!gamePrestart) return { ...row, executable: false, lineFresh: false, betEligible: false, tag: '已達官方預定開打時間｜不下注' };
    if (readerBacked && !readerExecutable) return {
      ...row,
      executable: false,
      lineFresh: false,
      betEligible: false,
      tag: analysisInProgress ? '今日整批分析進行中｜完成前暫不下注' : '盤口尚未完成最新版本驗證｜不下注',
    };
    return row;
  });
  return <section className="gameCard">
    <div className="gameHead">
      <div><h2>{matchup(item.game)}</h2><p>{localTime(item.game.gameDate)}｜{item.game.awayProbable || '先發未定'} 對 {item.game.homeProbable || '先發未定'}</p></div>
      <span className={`state ${item.status}`}>{item.statusLabel}</span>
    </div>
    {item.actualSource && <div className="sourceBanner actualSource"><strong>{item.actualSource.label}</strong><span>更新：{localTime(item.actualSource.observedAt)}</span></div>}
    {item.error && <div className="errorBox">{item.error}</div>}
    {!item.referenceData && !item.error && <div className="emptyGame">{item.statusLabel}</div>}
    {item.referenceData && <>
      {actualRows.length > 0 && <div className="actualBox">
        <div className="actualHead"><strong>Tai888 實際信用盤</strong><span>Reader 同步後自動分析與重算</span></div>
        {MARKET_ORDER.map(market => {
          const rows = actualRows.filter(row => row.market === market);
          if (!rows.length) return null;
          return <div className="marketBlock actualMarket" key={market}><div className="marketTitle"><h3>{market}</h3></div>{rows.map(row => <ResultRow key={rowKey(row)} row={row} betRecorded={isBetRecorded(item, row)} onBet={value => onBet(item, value)} now={now} verificationPending={analysisInProgress && readerBacked && !readerExecutable}/>)}</div>;
        })}
      </div>}
      <details className="details"><summary>查看模型與QA明細</summary><div className="detailGrid">
        <div><span>分析類型</span><b>{item.customData?.analysis?.analysisType || item.referenceData.analysis.analysisType}</b></div>
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
    <p className="muted">此頁已與 MLB 的賽程、Reader、模型、排名及下注識別完全隔離。正式資料尚未驗證前不會借用 MLB 機率、不會補造盤口，也不會產生可下注分數。</p>
    <div className="setupGrid">{stages.map(([title, detail], index) => <div key={title}><b>{index + 1}</b><strong>{title}</strong><span>{detail}</span></div>)}</div>
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
  const activeLeague = leagueConfig(league);
  const analysisEnabled = leagueCanAnalyze(league);

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

  useEffect(() => {
    const initial = loadCompactStore();
    setLeague(initial.activeLeague);
    setSettings(initial.settings);
    setBets(initial.bets);
    setStorageReady(true);
  }, []);
  useEffect(() => {
    if (storageReady) saveCompactStore({ settings, bets, activeLeague: league });
  }, [settings, bets, league, storageReady]);
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
    if (league !== 'MLB') return undefined;
    let active = true;
    const refreshReader = async () => {
      try {
        const value = await requestJSON(`/api/reader/status?league=${encodeURIComponent(league)}&date=${encodeURIComponent(date)}&t=${Date.now()}`, {}, 20000);
        if (!active) return;
        commitReaderStatus(value);
        if (value?.fresh || board.length || operationBusyRef.current || readerPollBusyRef.current) return;

        // The Tai888 board commonly rolls to the next Taipei date during the
        // evening while the browser calendar still defaults to today. Discover
        // the latest complete Reader snapshot and follow its board date so the
        // user never analyzes yesterday's expired snapshot by mistake.
        const latest = await requestJSON(`/api/reader/status?league=${encodeURIComponent(league)}&t=${Date.now()}`, {}, 20000);
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
  }, [date, board.length, league]);
  useEffect(() => {
    if (league !== 'MLB') return undefined;
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
  }, [readerStatus?.fresh, readerStatus?.payloadHash, board.length, busy, date, league]);
  useEffect(() => {
    if (league !== 'MLB' || !board.length) return undefined;
    const timer = window.setInterval(() => pollReaderAndReprice(), 30000);
    return () => window.clearInterval(timer);
  }, [board, date, busy, league]);
  useEffect(() => {
    if (league !== 'MLB' || !board.length) return undefined;
    const timer = window.setInterval(() => {
      if (!busy && readerStatus?.fresh && Date.now() - Number(lastFullAnalysisAtRef.current || 0) > 30 * 60 * 1000) oneClickAnalyze();
    }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [board.length, date, busy, readerStatus?.fresh, league]);

  const currentReaderKey = readerRevisionKey(date, readerStatus?.payloadHash, readerStatus?.pageActivityAt);
  const currentReaderHashKey = readerHashKey(date, readerStatus?.payloadHash);
  const readerExecutable = league === 'MLB'
    && readerStatus?.fresh === true
    && readerStatus?.boardDate === date
    && Boolean(currentReaderHashKey)
    && (acknowledgedReaderKey === currentReaderHashKey || acknowledgedReaderKey.startsWith(`${currentReaderHashKey}:`));
  const itemReaderExecutable = item => league === 'MLB'
    && readerStatus?.fresh === true
    && readerStatus?.boardDate === date
    && Boolean(item?.readerPayloadHash)
    && item.readerPayloadHash === readerStatus?.payloadHash;

  const ranked = useMemo(() => board.flatMap(item => {
    if (!gameIsPrestartNow(item.game, clockNow)) return [];
    return (item.customData?.analysis?.results || [])
      .filter(row => row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water))
      .map(row => ({ ...row, game: item.game, item }));
  }).filter(row => Number.isFinite(Number(row.score))).sort((a, b) => Number(b.score) - Number(a.score)), [board, clockNow]);

  const visibleBets = useMemo(
    () => bets.filter(bet => normalizeLeagueId(bet?.league) === league),
    [bets, league],
  );

  function isBetRecorded(item, row) {
    return bets.some(bet => betMatches(bet, date, item.game.gamePk, row, league));
  }

  function updateBoard(gamePk, updater) {
    setBoard(current => current.map(item => item.game.gamePk === gamePk ? updater(item) : item));
  }

  async function fetchSchedule(targetDate = date) {
    if (!activeLeague.scheduleEndpoint) throw new Error(`${activeLeague.label}正式賽程尚未接入，不能進行分析`);
    const data = await requestJSON(`${activeLeague.scheduleEndpoint}?date=${encodeURIComponent(targetDate)}&t=${Date.now()}`, {}, 40000);
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

  async function analyzeBoardItem(task, index, total) {
    if (task.generation !== analysisGenerationRef.current) return false;
    const game = task.game;
    const actualMarkets = task.actualMarkets || [];
    updateBoard(game.gamePk, item => ({ ...item, status: 'running', statusLabel: '建立Tai888信用盤比分分布中…' }));
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
      }, 180000);
      if (task.generation !== analysisGenerationRef.current) return false;
      snapshots.current.set(game.gamePk, baseData.repriceSnapshot);
      updateBoard(game.gamePk, item => ({
        ...item,
        referenceData: compactAnalysisData(baseData),
        mode: 'actual',
        status: 'done',
        statusLabel: 'Tai888信用盤分析完成',
        customMarkets: actualMarkets,
        customData: compactAnalysisData(baseData),
        error: '',
      }));
      return true;
    } catch (cause) {
      if (task.generation !== analysisGenerationRef.current) return false;
      const message = String(cause?.message || cause);
      const blocked = /資料不足｜不評分|比賽已開打或結束/.test(message);
      updateBoard(game.gamePk, item => ({
        ...item,
        status: blocked ? 'blocked' : 'failed',
        statusLabel: blocked ? '資料不足｜不評分' : '分析失敗',
        error: message,
      }));
      return false;
    } finally {
      if (task.generation === analysisGenerationRef.current) {
        setProgress(value => ({ ...value, done: Math.min(total, value.done + 1), label: '分析今日全部盤口' }));
      }
    }
  }

  async function oneClickAnalyze(automaticKey = '') {
    if (!analysisEnabled) {
      setError(`${activeLeague.label}尚未完成正式賽程、Tai888 Reader 與獨立模型驗證，目前不能分析或產生下注分數。`);
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
      setProgress({ active: true, done: 0, total: 1, label: `取得今日${activeLeague.shortLabel}賽事` });
      const games = await fetchSchedule(targetDate);
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;
      if (!games.length) throw new Error(`這個日期沒有可分析的賽前${activeLeague.shortLabel}賽事`);

      setProgress({ active: true, done: 0, total: 1, label: '取得Tai888信用盤' });
      const credit = await requestJSON('/api/credit-lines', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() }, body: JSON.stringify({ league, date: targetDate, schedule: games }),
      }, 60000);
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;

      if (credit?.readerStatus) commitReaderStatus({ ...credit.readerStatus, boardDate: credit.boardDate, payloadHash: credit.payloadHash, matchedGameCount: credit.matchedGameCount, observedAt: credit.observedAt, receivedAt: credit.receivedAt, pageActivityAt: credit.pageActivityAt });

      const readerCreditReady = credit?.provider === 'TAI888_READER_AUTO' && credit?.readerFresh === true;
      const creditByPk = new Map((readerCreditReady ? credit.games || [] : []).map(row => [Number(row.gamePk), row]));
      const items = games.map(game => {
        const foundCredit = creditByPk.get(Number(game.gamePk));
        const available = Boolean(foundCredit?.markets?.length);
        return {
          game,
          mode: 'actual',
          actualSource: foundCredit?.source || null,
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
      const sourceWarnings = [
        credit.error ? `Tai888信用盤：${credit.error}` : '',
        credit.blocked && credit.message ? `Tai888信用盤：${credit.message}` : '',
        ...(credit.warnings || []),
      ].filter(Boolean);

      if (!tasks.length) {
        setNotice(sourceWarnings.join('；') || credit.message || `目前 Tai888 Reader 沒有可分析的${activeLeague.shortLabel}信用盤。`);
        setProgress({ active: false, done: 0, total: 0, label: '' });
        return false;
      }

      setProgress({ active: true, done: 0, total: tasks.length, label: '分析今日全部盤口' });
      const outcomes = new Array(tasks.length).fill(false);
      await runPool(tasks, 2, async (task, index) => {
        outcomes[index] = await analyzeBoardItem(task, index, tasks.length);
      });
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
        setNotice(`完成 ${tasks.length} 場Tai888信用盤分析${sourceWarnings.length ? `｜提醒：${sourceWarnings.join('；')}` : ''}`);
      } else if (analysisSucceeded && !readerHashAcknowledged) {
        setNotice(`已完成 ${tasks.length} 場分析，但 Reader 在分析期間出現更新；舊盤結果維持不可下注。`);
        setError('Reader 最新盤面版本尚未完成驗證，系統將自動重新分析。');
        window.setTimeout(() => {
          if (generation === analysisGenerationRef.current && currentDateRef.current === targetDate) oneClickAnalyze();
        }, 800);
      } else {
        setNotice(`已完成 ${completedCount}/${tasks.length} 場分析${sourceWarnings.length ? `｜提醒：${sourceWarnings.join('；')}` : ''}`);
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

  function recordBet(item, row) {
    const identity = betIdentity(date, item.game.gamePk, row, league);
    const existing = bets.find(bet => betMatches(bet, date, item.game.gamePk, row, league));
    if (existing) {
      if (!window.confirm(`取消「已下注」標記？\n${row.pick}`)) return;
      setBets(current => current.filter(bet => !betMatches(bet, date, item.game.gamePk, row, league)));
      setNotice(`已取消下注標記：${row.pick}`);
      return;
    }
    if (!gameIsPrestartNow(item.game, Date.now())
      || (item.actualSource?.provider === 'TAI888_READER_AUTO' && !itemReaderExecutable(item))
      || !formalBetEligibility(row, 7.2, Date.now()).passed) {
      setError('此方向已達開打時間，或未通過最新盤口、雙EV與三層QA完整門檻，不能記錄為正式下注');
      return;
    }
    const bet = {
      id: uid(), identity, league, date, gamePk: item.game.gamePk, matchup: matchup(item.game), gameDate: item.game.gameDate,
      market: row.market, pick: row.pick, water: row.water, score: row.score, weightedEV: row.weightedEV, robustEV: row.robustEV,
      lineAsOf: row.lineAsOf || null,
      readerPayloadHash: readerStatus?.payloadHash || null,
      readerRevision: currentReaderKey || null,
      snapshotId: item.customData?.analysis?.snapshotId || null,
      analysisAsOf: item.customData?.analysis?.analysisAsOf || null,
      modelVersion: item.customData?.analysis?.modelVersion || row.modelVersion || null,
      scoreFormulaVersion: row.scoreFormulaVersion || item.customData?.analysis?.scoreFormulaVersion || null,
      qa: { scoreAudit: row.scoreAudit || null, pairAudit: row.pairAudit || null, thirdAudit: row.thirdAudit || null },
      stake: settings.unitValue, placedAt: new Date().toISOString(), status: 'pending',
    };
    setBets(current => current.some(value => betMatches(value, date, item.game.gamePk, row, league)) ? current : [bet, ...current].slice(0, 500));
    setError('');
    setNotice(`已記錄：${row.pick}｜${Number(row.water).toFixed(3)}`);
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
      <div><div className="eyebrow">BASEBALL POSITIVE EV</div><h1>{activeLeague.label}｜今日盤口分析</h1><p>{analysisEnabled ? 'Tai888 Reader 持續同步實際信用盤；盤口變動自動沿用凍結比分分布快速重算。' : `${activeLeague.shortLabel}獨立模組已建立；正式資料、Reader 與模型通過驗證後才會開放分析。`}</p></div>
      <div className="headerBadges"><span className={health?.ok ? 'health ok' : 'health warn'}>{health?.ok ? '系統正常' : '系統檢查中'}</span><span className={`state ${analysisEnabled ? 'done' : 'setup'}`}>{activeLeague.statusLabel}</span><span className="version">v{VERSION}</span></div>
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
      <button className={tab === 'board' ? 'active' : ''} onClick={() => setTab('board')}>今日分析</button>
      <button className={tab === 'ranking' ? 'active' : ''} onClick={() => setTab('ranking')}>總排名</button>
      <button className={tab === 'bets' ? 'active' : ''} onClick={() => setTab('bets')}>下注紀錄</button>
      <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>設定</button>
    </nav>

    {error && <div className="errorBox global"><strong>發生問題</strong><span>{error}</span><button onClick={() => setError('')}>關閉</button></div>}
    {notice && <div className="noticeBox">{notice}</div>}
    <LoadingLine progress={progress}/>

    {tab === 'board' && <>
      <section className="heroCard">
        <div className="heroCopy"><span className="kicker">每日主要操作</span><h2>一鍵分析今日全部 {activeLeague.id}</h2><p>{analysisEnabled ? '只使用 Tai888 Reader 同步的實際信用盤；有新盤時自動分析與重算。' : `${activeLeague.shortLabel}不會套用 MLB 的機率、球隊或盤口資料；正式驗證完成前保持鎖定。`}</p></div>
        <div className="heroControls"><label>台灣日期<input type="date" value={date} disabled={busy} onChange={event => setDate(event.target.value)}/></label><button className="primary giant" disabled={busy || !analysisEnabled} onClick={() => oneClickAnalyze()}>{busy ? '執行中…' : analysisEnabled ? `一鍵分析今日 ${activeLeague.id}` : `${activeLeague.id} 尚未啟用`}</button></div>
        <div className={`providerState ${analysisEnabled && readerExecutable ? 'ready' : 'missing'}`}>
          <strong>{!analysisEnabled ? `${activeLeague.label}正式 Reader 尚未驗證｜不可分析` : readerExecutable ? 'Tai888 Reader 自動同步正常｜目前畫面已驗證' : readerStatus?.fresh ? 'Tai888 Reader 新盤已同步｜等待分析驗證' : readerStatus?.stale ? 'Tai888 Reader 盤口已過期' : 'Tai888 Reader 等待同步'}</strong>
          <span>{!analysisEnabled ? '資料、盤口、排名與下注資格皆獨立鎖定。' : readerStatus?.fresh ? `最後同步：${localTime(readerStatus?.receivedAt)}｜${readerStatus?.matchedGameCount || 0}場｜每30秒複核` : readerStatus?.message || `保持唯一一台讀盤電腦、Chrome 與 Tai888 ${activeLeague.shortLabel}頁面開啟。`}</span>
        </div>
      </section>
      {!analysisEnabled && <LeagueSetupPanel config={activeLeague}/>}
      {analysisEnabled && !board.length && <section className="emptyBoard"><div>⚾</div><h2>尚未建立今日分析</h2><p>按上方按鈕後，今天 Reader 已同步的 Tai888 信用盤會一次列出並完成分析。</p></section>}
      {analysisEnabled && board.map(item => <GameCard key={`${league}-${item.game.gamePk}`} item={item} onBet={recordBet} isBetRecorded={isBetRecorded} readerExecutable={itemReaderExecutable(item)} analysisInProgress={progress.active} now={clockNow}/>) }
    </>}

    {tab === 'ranking' && <section className="panel"><div className="panelHead"><h2>{activeLeague.label}｜Tai888 信用盤排名</h2><span className="leagueBadge">{league}</span></div>{analysisEnabled && ranked.length ? ranked.map((row, index) => {
      const recorded = isBetRecorded(row.item, row);
      const eligible = itemReaderExecutable(row.item) && formalBetEligibility(row, 7.2, clockNow).passed;
      return <div className={`rankRow ${recorded ? 'betRecorded' : ''}`} key={`${league}-${row.game.gamePk}-${rowKey(row)}`}><b>{index + 1}</b><strong>{scoreText(row.score)}</strong><div><span>{row.pick}｜{matchup(row.game)}｜{row.market}</span><small>信用盤 {waterText(row.water)}｜校準等值勝率 {pct(row.modelProbability)}｜損益兩平 {pct(breakEvenProbability(row.water, 0.015))}｜正式EV {pct(row.weightedEV)}｜穩健EV {pct(row.robustEV)}</small></div>{(eligible || recorded) && <button className={`mini ${recorded ? 'recorded' : 'green'}`} title={recorded ? '再按一次可取消標記' : '標記這個盤口已下注'} onClick={() => recordBet(row.item, row)}>{recorded ? '已下注 ✓' : '記錄下注'}</button>}</div>;
    }) : <div className="emptySmall">{analysisEnabled ? `完成今日 ${activeLeague.shortLabel} Tai888 信用盤分析後顯示排名。` : `${activeLeague.shortLabel}正式模型尚未啟用，不顯示推估或跨聯盟替代排名。`}</div>}</section>}

    {tab === 'bets' && <section className="panel"><div className="panelHead"><h2>{activeLeague.label}｜下注紀錄</h2><button className="textButton" disabled={!visibleBets.length} onClick={() => { if (visibleBets.length && window.confirm(`確定清空全部${activeLeague.shortLabel}下注紀錄？`)) setBets(current => current.filter(bet => normalizeLeagueId(bet?.league) !== league)); }}>清空本聯盟</button></div>{visibleBets.length ? visibleBets.map(bet => <div className="betRow" key={bet.id}><div><strong><span className="leagueBadge inline">{league}</span>{scoreText(bet.score)}｜{bet.pick}｜{Number(bet.water).toFixed(3)}</strong><span>{bet.matchup}｜{bet.market}</span></div><small>{localTime(bet.placedAt)}｜{Number(bet.stake || 0).toLocaleString()}元</small></div>) : <div className="emptySmall">尚未記錄{activeLeague.shortLabel}下注。</div>}</section>}

    {tab === 'settings' && <section className="panel"><div className="panelHead"><h2>{activeLeague.label}｜設定</h2><span className={`state ${analysisEnabled ? 'done' : 'setup'}`}>{activeLeague.statusLabel}</span></div><div className="settingsGrid"><label>1 Unit 金額<input type="number" value={settings.unitValue} min="100" step="100" onChange={event => setSettings(value => ({ ...value, unitValue: Number(event.target.value) || 10000 }))}/></label><label>模擬次數／情境<select value={settings.simulationsPerScenario} onChange={event => setSettings(value => ({ ...value, simulationsPerScenario: Number(event.target.value) }))}><option value="1000">1000</option><option value="1800">1800</option><option value="2500">2500</option></select></label></div><div className="settingsNote"><b>模型：{activeLeague.modelFamily}</b><br/>{analysisEnabled ? '評分固定使用雙EV短板公式；GPT不得調分。模型核心資料改變才完整重算，盤口／尾碼／水位改變只走凍結分布快速重算。' : `${activeLeague.shortLabel}資料與 MLB 完全隔離；正式賽程、Tai888 實盤與專屬模型未通過 QA 前，分析與下注資格保持關閉。`} Unit 金額為同一帳號共用設定。</div></section>}

  </main>;
}
