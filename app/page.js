'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MARKET_ORDER, hasActualWater, parseTaiwanLine, validateMarketPair } from '../lib/markets.js';
import { flattenMarkets, withFallbackWater } from '../lib/batch.js';
import { translateTeamText } from '../lib/i18n.js';
import {
  actualLineFreshNow,
  formalBetEligibility,
  gameIsPrestartNow,
  liveReaderHashMatches,
  mergeReaderStatusHighWater,
  mergeRecognizedGameInputs,
  readerHashKey,
  readerRevisionKey,
  shouldAcceptReaderStatus,
  shouldAcknowledgeReaderHash,
} from '../lib/client-analysis-state.js';

const VERSION = '9.4.2';
const STORAGE = 'mlb-positive-ev-v9-4-2';
const LEGACY_KEYS = ['mlb-positive-ev-v9-4-1', 'mlb-positive-ev-v9-4-0', 'mlb-positive-ev-v9-3-4', 'mlb-positive-ev-v9-3-3', 'mlb-positive-ev-v9-3-2', 'mlb-positive-ev-v9-3', 'mlb-positive-ev-v9-2', 'mlb-positive-ev-v9-1-preview', 'mlb-positive-ev-v8-4', 'mlb-positive-ev-v7'];
const DEFAULT_SETTINGS = {
  unitValue: 10000,
  rebateRate: 0.015,
  simulationsPerScenario: 1800,
  fallbackWater: { 全場讓分: 0.95, 全場大小: 0.94, 上半讓分: 0.94, 上半大小: 0.93 },
};

const clean = value => String(value || '').replace(/\s+/g, '').trim();
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
  if (typeof window === 'undefined') return { settings: DEFAULT_SETTINGS, bets: [] };
  try {
    const own = safeParse(window.localStorage.getItem(STORAGE) || 'null');
    if (own && typeof own === 'object') {
      return {
        settings: { ...DEFAULT_SETTINGS, ...(own.settings || {}), fallbackWater: { ...DEFAULT_SETTINGS.fallbackWater, ...(own.settings?.fallbackWater || {}) } },
        bets: Array.isArray(own.bets) ? own.bets.slice(0, 500) : [],
      };
    }
    for (const key of LEGACY_KEYS) {
      const legacy = safeParse(window.localStorage.getItem(key) || 'null');
      if (!legacy || typeof legacy !== 'object') continue;
      return {
        settings: { ...DEFAULT_SETTINGS, ...(legacy.settings || {}), fallbackWater: { ...DEFAULT_SETTINGS.fallbackWater, ...(legacy.settings?.fallbackWater || {}) } },
        bets: Array.isArray(legacy.bets) ? legacy.bets.slice(0, 500) : [],
      };
    }
  } catch {
    // Safari private mode, quota failures and corrupted legacy storage must never crash the app.
  }
  return { settings: DEFAULT_SETTINGS, bets: [] };
}

function saveCompactStore(value) {
  try {
    window.localStorage.setItem(STORAGE, JSON.stringify({ settings: value.settings, bets: value.bets.slice(0, 500) }));
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

function groupResults(results) {
  return MARKET_ORDER.map(market => ({ market, rows: (results || []).filter(row => row.market === market).sort((a, b) => Number(b.score ?? -99) - Number(a.score ?? -99)) }));
}

function rowKey(row) {
  return `${row?.market || ''}|||${row?.pick || ''}`;
}

function sourcePrice(referenceMarkets, row) {
  const source = (referenceMarkets || []).find(item => rowKey(item) === rowKey(row));
  return source?.rawDecimalOdds;
}

function prefixFromPick(pick) {
  const parsed = parseTaiwanLine(pick);
  if (!parsed.valid) return '';
  if (parsed.isTotal) return parsed.isOver ? '大' : '小';
  return `${parsed.team}${parsed.isGiving ? '讓' : '受讓'}`;
}

function normalizeActualPick(input, basePick) {
  let value = clean(input).replace(/[－–—]/g, '-').replace(/[＋]/g, '+');
  if (!value) throw new Error('請輸入完整盤口');
  if (parseTaiwanLine(value).valid) return value;
  const base = parseTaiwanLine(basePick);
  if (!base.valid) throw new Error('原參考盤無法作為輸入基準');
  if (/^(讓|受讓)/.test(value) && !base.isTotal) value = `${base.team}${value}`;
  else if (/^\d/.test(value)) value = `${prefixFromPick(basePick)}${value}`;
  if (!parseTaiwanLine(value).valid) throw new Error(`盤口格式無法辨識：${input}`);
  return value;
}

function teamMatches(value, team) {
  const a = clean(value).toLowerCase();
  const b = clean(team).toLowerCase();
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function buildActualPair({ pick, water, market, game }) {
  const parsed = parseTaiwanLine(pick);
  if (!parsed.valid) throw new Error('實際信用盤格式無法辨識');
  const token = `${parsed.lineText}${parsed.modifier || ''}`;
  const now = new Date().toISOString();
  let oppositePick;
  if (parsed.isTotal) {
    oppositePick = `${parsed.isOver ? '小' : '大'}${token}`;
  } else {
    const away = translateTeamText(game.away);
    const home = translateTeamText(game.home);
    const opponent = teamMatches(parsed.team, away) ? home : teamMatches(parsed.team, home) ? away : null;
    if (!opponent) throw new Error('盤口球隊與本場對戰不一致');
    oppositePick = `${opponent}${parsed.isGiving ? '受讓' : '讓'}${token}`;
  }
  const rows = [
    { market, pick, water: Number(water), waterEstimated: false, confidence: 1, sourceType: 'ACTUAL_TW_CREDIT', provider: 'USER_MANUAL_ENTRY', authorizationStatus: 'USER_CONFIRMED_MANUAL', lineAsOf: now, executable: true, marketVerification: null },
    { market, pick: oppositePick, water: null, waterEstimated: false, confidence: 1, sourceType: 'ACTUAL_TW_CREDIT', provider: 'USER_MANUAL_ENTRY', authorizationStatus: 'USER_CONFIRMED_MANUAL', lineAsOf: now, executable: false, marketVerification: null },
  ];
  const errors = validateMarketPair(market, rows);
  if (errors.length) throw new Error(errors.join('、'));
  return rows;
}

function manualMarketRows(rows, sourceLabel) {
  return (rows || []).map(row => ({
    ...row,
    provider: 'USER_MANUAL_ENTRY',
    sourceLabel,
    authorizationStatus: 'USER_CONFIRMED_MANUAL',
  }));
}

function preparedManualItems(prepared, sourceLabel) {
  const merged = mergeRecognizedGameInputs((prepared || []).map(row => ({
    game: row.matchedGame,
    markets: manualMarketRows(flattenMarkets(row), sourceLabel),
  })));
  const observedAt = new Date().toISOString();
  return {
    conflicts: merged.conflicts,
    items: merged.games.map(row => ({
      game: row.game,
      mode: 'actual',
      source: { label: sourceLabel, observedAt },
      referenceMarkets: [],
      customMarkets: row.markets,
      status: 'queued',
      statusLabel: '等待分析',
      referenceData: null,
      customData: null,
      error: '',
    })),
  };
}

function compactAnalysisData(data) {
  return { game: data.game, context: data.context, analysis: data.analysis, openMarkets: data.openMarkets || [] };
}

async function fileToDataURL(file) {
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      const maximum = 2100;
      const scale = Math.min(1, maximum / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.86));
    };
    image.onerror = () => resolve(source);
    image.src = source;
  });
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

function ResultRow({ row, referenceMarkets, onEdit, onBet, actual = false, now }) {
  const decimalOdds = sourcePrice(referenceMarkets, row);
  const actualLine = row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water);
  const formal = actualLine && row.executable === true && actualLineFreshNow(row, now);
  const eligibility = formalBetEligibility(row, 7.2, now);
  const candidate = Number.isFinite(Number(row.score)) && Number(row.score) >= 7.2;
  return <div className={`scoreRow ${eligibility.passed ? 'qualified' : ''}`}>
    <div className={scoreClass(row.score)}>{scoreText(row.score)}</div>
    <div className="scoreBody">
      <div className="scorePick">{row.pick || '水位未提供｜不評分'}</div>
      <div className="scorePrice">{formal ? `信用盤水位 ${waterText(row.water)}` : decimalOdds ? `運彩賠率 ${Number(decimalOdds).toFixed(2)}` : `等值淨賠付 ${waterText(row.water)}`}</div>
      <div className="scoreMeta">加權EV {pct(row.weightedEV)}｜穩健EV {pct(row.robustEV)}｜{row.tag || '—'}</div>
      {actualLine && candidate && <div className="qaLine">QA：{eligibility.passed ? 'PASS' : 'BLOCK'}{eligibility.passed ? '｜合約✓ 水碼✓ 鏡像✓ 機率100%✓ EV雙算✓ 分數上限✓' : '｜未通過完整正式下注門檻'}</div>}
    </div>
    <div className="rowActions">
      {!actual && <button className="mini" onClick={() => onEdit(row)}>改成我的信用盤</button>}
      {actual && eligibility.passed && <button className="mini green" onClick={() => onBet(row)}>記錄下注</button>}
    </div>
  </div>;
}

function GameCard({ item, onEdit, onBet, onResetMarket, readerExecutable, now }) {
  const screenshotMode = item.mode === 'actual';
  const referenceGroups = groupResults(item.referenceData?.analysis?.results || []);
  const readerBacked = item.actualSource?.provider === 'TAI888_READER_AUTO';
  const gamePrestart = gameIsPrestartNow(item.game, now);
  const actualRows = (item.customData?.analysis?.results || []).filter(row => row.sourceType === 'ACTUAL_TW_CREDIT').map(row => {
    if (!gamePrestart) return { ...row, executable: false, lineFresh: false, betEligible: false, tag: '已達官方預定開打時間｜不下注' };
    if (readerBacked && !readerExecutable) return { ...row, executable: false, lineFresh: false, betEligible: false, tag: '盤口尚未完成最新版本驗證｜不下注' };
    return row;
  });
  return <section className="gameCard">
    <div className="gameHead">
      <div><h2>{matchup(item.game)}</h2><p>{localTime(item.game.gameDate)}｜{item.game.awayProbable || '先發未定'} 對 {item.game.homeProbable || '先發未定'}</p></div>
      <span className={`state ${item.status}`}>{item.statusLabel}</span>
    </div>
    {item.source && <div className="sourceBanner"><strong>{item.source.label}</strong><span>更新：{localTime(item.source.observedAt)}</span></div>}
    {item.actualSource && <div className="sourceBanner actualSource"><strong>{item.actualSource.label}</strong><span>更新：{localTime(item.actualSource.observedAt)}</span></div>}
    {item.error && <div className="errorBox">{item.error}</div>}
    {!item.referenceData && !item.error && <div className="emptyGame">{item.statusLabel}</div>}
    {item.referenceData && <>
      {!screenshotMode && <><div className="sectionLabel">運彩／參考盤篩選分數</div>
      {referenceGroups.map(group => <div className="marketBlock" key={group.market}>
        <h3>{group.market}</h3>
        {group.rows.length ? group.rows.map(row => <ResultRow key={rowKey(row)} row={row} referenceMarkets={item.referenceMarkets} onEdit={value => onEdit(item, value)} onBet={onBet} now={now}/>) : <div className="unopened">此市場未開盤</div>}
      </div>)}</>}
      {actualRows.length > 0 && <div className="actualBox">
        <div className="actualHead"><strong>我的實際信用盤</strong><span>沿用同一份凍結比分分布即時重算</span></div>
        {MARKET_ORDER.map(market => {
          const rows = actualRows.filter(row => row.market === market);
          if (!rows.length) return null;
          return <div className="marketBlock actualMarket" key={market}><div className="marketTitle"><h3>{market}</h3><button onClick={() => onResetMarket(item, market)}>恢復參考盤</button></div>{rows.map(row => <ResultRow actual key={rowKey(row)} row={row} referenceMarkets={[]} onEdit={onEdit} onBet={value => onBet(item, value)} now={now}/>)}</div>;
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

export default function Home() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [bets, setBets] = useState([]);
  const [storageReady, setStorageReady] = useState(false);
  const [tab, setTab] = useState('board');
  const [date, setDate] = useState(taipeiDate());
  const [schedule, setSchedule] = useState([]);
  const [board, setBoard] = useState([]);
  const [providerStatus, setProviderStatus] = useState(null);
  const [creditProviderStatus, setCreditProviderStatus] = useState(null);
  const [readerStatus, setReaderStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ active: false, done: 0, total: 0, label: '' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [editor, setEditor] = useState(null);
  const [draftPick, setDraftPick] = useState('');
  const [draftWater, setDraftWater] = useState('0.950');
  const [uploadStatus, setUploadStatus] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [pasteStatus, setPasteStatus] = useState('');
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
  const analysisGenerationRef = useRef(0);
  const readerStatusRef = useRef(null);
  const readerStatusHighWaterRef = useRef(null);

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
    setSettings(initial.settings);
    setBets(initial.bets);
    setStorageReady(true);
  }, []);
  useEffect(() => {
    if (storageReady) saveCompactStore({ settings, bets });
  }, [settings, bets, storageReady]);
  useEffect(() => {
    currentDateRef.current = date;
    analysisGenerationRef.current += 1;
    snapshots.current.clear();
    creditRevisionRef.current = '';
    autoAnalyzeHashRef.current = '';
    autoAnalyzePendingRef.current = '';
    lastFullAnalysisAtRef.current = 0;
    setAcknowledgedReaderKey('');
    setSchedule([]);
    setBoard([]);
    setEditor(null);
    readerStatusRef.current = null;
    readerStatusHighWaterRef.current = null;
    setReaderStatus(null);
    setCreditProviderStatus(current => current ? { ...current, readerFresh: false, payloadHash: null, matchedGameCount: 0 } : current);
  }, [date]);
  useEffect(() => {
    const timer = window.setInterval(() => setClockNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    requestJSON('/api/health', {}, 20000).then(setHealth).catch(() => setHealth(null));
    requestJSON('/api/reference-lines', {}, 20000).then(setProviderStatus).catch(cause => setProviderStatus({ configured: false, message: String(cause?.message || cause) }));
    requestJSON('/api/credit-lines', {}, 20000).then(setCreditProviderStatus).catch(cause => setCreditProviderStatus({ configured: false, message: String(cause?.message || cause) }));
  }, []);
  useEffect(() => {
    let active = true;
    const refreshReader = () => requestJSON(`/api/reader/status?date=${encodeURIComponent(date)}&t=${Date.now()}`, {}, 20000)
      .then(value => { if (active) commitReaderStatus(value); })
      .catch(cause => { if (active) invalidateReaderStatus(cause?.message || cause); });
    refreshReader();
    const timer = window.setInterval(refreshReader, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [date]);
  useEffect(() => {
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
  }, [readerStatus?.fresh, readerStatus?.payloadHash, board.length, busy, date]);
  useEffect(() => {
    if (!board.length) return;
    const timer = window.setInterval(() => pollReaderAndReprice(), 30000);
    return () => window.clearInterval(timer);
  }, [board, date, busy]);
  useEffect(() => {
    if (!board.length) return;
    const timer = window.setInterval(() => {
      if (!busy && readerStatus?.fresh && Date.now() - Number(lastFullAnalysisAtRef.current || 0) > 30 * 60 * 1000) oneClickAnalyze();
    }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [board.length, date, busy, readerStatus?.fresh]);

  const currentReaderKey = readerRevisionKey(date, readerStatus?.payloadHash, readerStatus?.pageActivityAt);
  const currentReaderHashKey = readerHashKey(date, readerStatus?.payloadHash);
  const readerExecutable = readerStatus?.fresh === true
    && readerStatus?.boardDate === date
    && Boolean(currentReaderHashKey)
    && acknowledgedReaderKey.startsWith(`${currentReaderHashKey}:`);

  const ranked = useMemo(() => board.flatMap(item => {
    if (!gameIsPrestartNow(item.game, clockNow)) return [];
    const readerBacked = item.actualSource?.provider === 'TAI888_READER_AUTO';
    const actualAllowed = !readerBacked || readerExecutable;
    const actual = actualAllowed
      ? (item.customData?.analysis?.results || []).filter(row => row.sourceType === 'ACTUAL_TW_CREDIT'
        && hasActualWater(row.water) && row.executable === true && actualLineFreshNow(row, clockNow))
      : [];
    const actualMarkets = new Set(actual.map(row => row.market));
    const reference = (item.referenceData?.analysis?.results || []).filter(row => !actualMarkets.has(row.market));
    return [...actual, ...reference].map(row => ({ ...row, game: item.game }));
  }).filter(row => Number.isFinite(Number(row.score))).sort((a, b) => Number(b.score) - Number(a.score)), [board, readerExecutable, clockNow]);

  function updateBoard(gamePk, updater) {
    setBoard(current => current.map(item => item.game.gamePk === gamePk ? updater(item) : item));
  }

  async function fetchSchedule(targetDate = date) {
    const data = await requestJSON(`/api/mlb?date=${encodeURIComponent(targetDate)}&t=${Date.now()}`, {}, 40000);
    const rows = Array.isArray(data.games) ? data.games.filter(game => gameIsPrestartNow(game, Date.now())) : [];
    if (currentDateRef.current === targetDate) setSchedule(rows);
    return rows;
  }

  async function confirmLiveReaderHash(targetDate, payloadHash, generation) {
    const live = await requestJSON(`/api/reader/status?date=${encodeURIComponent(targetDate)}&t=${Date.now()}`, {}, 20000);
    if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;
    commitReaderStatus(live);
    const current = readerStatusRef.current;
    return liveReaderHashMatches(targetDate, current, payloadHash);
  }

  async function analyzeBoardItem(task, index, total) {
    if (task.generation !== analysisGenerationRef.current) return false;
    const game = task.game;
    const referenceMarkets = task.referenceMarkets || [];
    const actualMarkets = task.actualMarkets || [];
    const useReference = referenceMarkets.length > 0;
    const baseMarkets = useReference ? referenceMarkets : actualMarkets;
    updateBoard(game.gamePk, item => ({ ...item, status: 'running', statusLabel: useReference ? '建立參考比分分布中…' : '建立信用盤比分分布中…' }));
    try {
      const baseData = await requestJSON('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({
          game,
          markets: baseMarkets,
          verificationMarkets: referenceMarkets,
          settings: { ...settings, rebateRate: useReference ? 0 : 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },
        }),
      }, 180000);
      if (task.generation !== analysisGenerationRef.current) return false;
      snapshots.current.set(game.gamePk, baseData.repriceSnapshot);
      updateBoard(game.gamePk, item => ({
        ...item,
        referenceData: compactAnalysisData(baseData),
        status: 'running',
        statusLabel: useReference && actualMarkets.length ? '參考分布完成｜重算實際信用盤中…' : item.statusLabel,
        error: '',
      }));

      let customData = null;
      if (useReference && actualMarkets.length) {
        const repriced = await requestJSON('/api/reprice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
          body: JSON.stringify({
            snapshot: baseData.repriceSnapshot,
            markets: actualMarkets,
            previousMarkets: [],
            verificationMarkets: referenceMarkets,
            settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },
          }),
        }, 120000);
        if (task.generation !== analysisGenerationRef.current) return false;
        snapshots.current.set(game.gamePk, repriced.repriceSnapshot);
        customData = compactAnalysisData(repriced);
      }

      const actualOnly = !useReference;
      updateBoard(game.gamePk, item => ({
        ...item,
        mode: actualOnly ? 'actual' : 'reference',
        status: 'done',
        statusLabel: actualMarkets.length ? '實際信用盤分析完成' : '參考盤分析完成',
        referenceData: compactAnalysisData(baseData),
        customMarkets: actualMarkets,
        customData: actualOnly ? compactAnalysisData(baseData) : customData,
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
        setProgress(value => ({ ...value, done: Math.min(total, value.done + 1), label: `分析今日全部盤口：${index + 1}/${total}` }));
      }
    }
  }

  async function oneClickAnalyze(automaticKey = '') {
    if (!acquireOperation()) return false;
    const requestedAutoKey = typeof automaticKey === 'string' ? automaticKey : '';
    const targetDate = date;
    const generation = analysisGenerationRef.current;
    setError(''); setNotice(''); setTab('board'); snapshots.current.clear();
    setBoard(current => current.map(item => item.actualSource?.provider === 'TAI888_READER_AUTO'
      ? { ...item, actualSource: null, customMarkets: [], customData: null, status: 'running', statusLabel: '重新驗證Tai888盤口中…', error: '' }
      : item));
    try {
      setProgress({ active: true, done: 0, total: 1, label: '取得今日MLB賽事' });
      const games = await fetchSchedule(targetDate);
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;
      if (!games.length) throw new Error('這個日期沒有可分析的賽前MLB賽事');

      setProgress({ active: true, done: 0, total: 2, label: '同時取得國際參考盤與Tai888信用盤' });
      const [referenceOutcome, creditOutcome] = await Promise.allSettled([
        requestJSON('/api/reference-lines', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() }, body: JSON.stringify({ date: targetDate, schedule: games }),
        }, 60000),
        requestJSON('/api/credit-lines', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() }, body: JSON.stringify({ date: targetDate, schedule: games }),
        }, 60000),
      ]);
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return false;

      const reference = referenceOutcome.status === 'fulfilled'
        ? referenceOutcome.value
        : { configured: providerStatus?.configured || false, games: [], error: String(referenceOutcome.reason?.message || referenceOutcome.reason) };
      const credit = creditOutcome.status === 'fulfilled'
        ? creditOutcome.value
        : { configured: creditProviderStatus?.configured || false, games: [], error: String(creditOutcome.reason?.message || creditOutcome.reason) };
      setProviderStatus(reference);
      setCreditProviderStatus(credit);
      if (credit?.readerStatus) commitReaderStatus({ ...credit.readerStatus, boardDate: credit.boardDate, payloadHash: credit.payloadHash, matchedGameCount: credit.matchedGameCount, observedAt: credit.observedAt, receivedAt: credit.receivedAt, pageActivityAt: credit.pageActivityAt });

      const referenceByPk = new Map((reference.games || []).map(row => [Number(row.gamePk), row]));
      const creditByPk = new Map((credit.games || []).map(row => [Number(row.gamePk), row]));
      const items = games.map(game => {
        const foundReference = referenceByPk.get(Number(game.gamePk));
        const foundCredit = creditByPk.get(Number(game.gamePk));
        const available = Boolean(foundReference?.markets?.length || foundCredit?.markets?.length);
        return {
          game,
          mode: foundReference ? 'reference' : foundCredit ? 'actual' : 'reference',
          source: foundReference?.source || null,
          actualSource: foundCredit?.source || null,
          referenceMarkets: foundReference?.markets || [],
          customMarkets: foundCredit?.markets || [],
          status: available ? 'queued' : 'unopened',
          statusLabel: available ? '等待分析' : '目前尚無可配對盤口',
          referenceData: null,
          customData: null,
          error: '',
        };
      });
      setBoard(items);

      const tasks = items.filter(item => item.referenceMarkets.length || item.customMarkets.length).map(item => ({
        game: item.game,
        referenceMarkets: item.referenceMarkets,
        actualMarkets: item.customMarkets,
        generation,
      }));
      const sourceWarnings = [
        reference.error ? `國際參考盤：${reference.error}` : '',
        credit.error ? `Tai888信用盤：${credit.error}` : '',
        credit.blocked && credit.message ? `Tai888信用盤：${credit.message}` : '',
        ...(reference.failures || []),
        ...(credit.warnings || []),
      ].filter(Boolean);

      if (!tasks.length) {
        setNotice(sourceWarnings.join('；') || reference.message || credit.message || '目前兩個盤源都沒有可分析的MLB盤口。');
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
      const referenceCount = tasks.filter(task => task.referenceMarkets.length).length;
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
      if (hashEligible && creditRevision && await confirmLiveReaderHash(targetDate, credit.payloadHash, generation)) {
        creditRevisionRef.current = creditRevision;
        const completedKey = readerHashKey(targetDate, credit.payloadHash);
        autoAnalyzeHashRef.current = completedKey;
        setAcknowledgedReaderKey(creditRevision);
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
        setNotice(`完成 ${tasks.length} 場分析｜參考盤 ${referenceCount} 場｜實際信用盤 ${creditCount} 場${sourceWarnings.length ? `｜提醒：${sourceWarnings.join('；')}` : ''}`);
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
      const status = await requestJSON(`/api/reader/status?date=${encodeURIComponent(targetDate)}&t=${Date.now()}`, {}, 20000);
      if (!stillCurrent()) return;
      commitReaderStatus(status);
      const currentStatus = readerStatusRef.current;
      const statusRevision = readerRevisionKey(targetDate, currentStatus?.payloadHash, currentStatus?.pageActivityAt);
      if (!currentStatus?.fresh || !statusRevision || statusRevision === creditRevisionRef.current) return;
      const games = schedule.length ? schedule : board.map(item => item.game);
      const credit = await requestJSON('/api/credit-lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ date: targetDate, schedule: games }),
      }, 60000);
      if (!stillCurrent()) return;
      setCreditProviderStatus(credit);
      const creditRevision = readerRevisionKey(targetDate, credit.payloadHash, credit.pageActivityAt);
      if (!credit.readerFresh || !creditRevision || creditRevision === creditRevisionRef.current) return;
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
            updateBoard(item.game.gamePk, current => ({ ...current, status: current.referenceData ? 'done' : 'unopened', statusLabel: current.referenceData ? 'Tai888實際盤已下架｜保留參考盤' : 'Tai888實際盤已下架' }));
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
              snapshot,
              markets: actual.markets,
              previousMarkets: item.customMarkets || [],
              verificationMarkets: item.referenceMarkets || [],
              settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },
            }),
          }, 120000);
          if (!stillCurrent()) return;
          snapshots.current.set(item.game.gamePk, data.repriceSnapshot);
          updateBoard(item.game.gamePk, current => ({
            ...current,
            actualSource: actual.source,
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
        setAcknowledgedReaderKey(creditRevision);
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

  function openEditor(item, row) {
    setEditor({ gamePk: item.game.gamePk, market: row.market, basePick: row.pick });
    setDraftPick(row.pick);
    setDraftWater(String(settings.fallbackWater[row.market] || 0.95));
  }

  async function applyActualLine(event) {
    event.preventDefault();
    if (!editor) return;
    const targetDate = date;
    const generation = analysisGenerationRef.current;
    const item = board.find(row => row.game.gamePk === editor.gamePk);
    const snapshot = snapshots.current.get(editor.gamePk);
    if (!item || !snapshot) { setError('凍結比分分布已不存在，請重新執行今日分析'); return; }
    if (!gameIsPrestartNow(item.game, Date.now())) { setError('比賽已達官方預定開打時間，不能再套用或下注'); return; }
    if (!acquireOperation()) return;
    try {
      setError('');
      const pick = normalizeActualPick(draftPick, editor.basePick);
      if (!hasActualWater(draftWater)) throw new Error('實際信用盤水位必須為0.010～3.000');
      const pair = buildActualPair({ pick, water: Number(draftWater), market: editor.market, game: item.game });
      const previousActualMarkets = item.customMarkets || [];
      const markets = [...previousActualMarkets.filter(row => row.market !== editor.market), ...pair];
      const data = await requestJSON('/api/reprice', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ snapshot, markets, previousMarkets: previousActualMarkets, verificationMarkets: item.referenceMarkets || [], settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' } }),
      }, 120000);
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return;
      snapshots.current.set(item.game.gamePk, data.repriceSnapshot);
      updateBoard(item.game.gamePk, current => ({ ...current, customMarkets: markets, customData: compactAnalysisData(data) }));
      setNotice(`${pick}｜${Number(draftWater).toFixed(3)} 已沿用原比分分布完成快速重算。`);
      setEditor(null);
    } catch (cause) { setError(String(cause?.message || cause)); }
    finally { releaseOperation(); }
  }

  async function resetMarket(item, market) {
    const targetDate = date;
    const generation = analysisGenerationRef.current;
    const snapshot = snapshots.current.get(item.game.gamePk);
    if (!snapshot) return;
    if (!acquireOperation()) return;
    const markets = (item.customMarkets || []).filter(row => row.market !== market);
    if (!markets.length) {
      updateBoard(item.game.gamePk, current => ({ ...current, customMarkets: [], customData: null }));
      setNotice(`${market}已恢復顯示運彩／參考盤；凍結比分分布仍保留。`);
      releaseOperation();
      return;
    }
    try {
      const data = await requestJSON('/api/reprice', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ snapshot, markets, previousMarkets: item.customMarkets || [], verificationMarkets: item.referenceMarkets || [], settings: { ...settings, rebateRate: 0.015 } }),
      }, 120000);
      if (generation !== analysisGenerationRef.current || currentDateRef.current !== targetDate) return;
      snapshots.current.set(item.game.gamePk, data.repriceSnapshot);
      updateBoard(item.game.gamePk, current => ({ ...current, customMarkets: markets, customData: compactAnalysisData(data) }));
    } catch (cause) { setError(String(cause?.message || cause)); }
    finally { releaseOperation(); }
  }

  function recordBet(item, row) {
    if (operationBusyRef.current
      || readerPollBusyRef.current
      || !gameIsPrestartNow(item.game, Date.now())
      || (item.actualSource?.provider === 'TAI888_READER_AUTO' && !readerExecutable)
      || !formalBetEligibility(row, 7.2, Date.now()).passed) {
      setError('此方向已達開打時間，或未通過最新盤口、雙EV與三層QA完整門檻，不能記錄為正式下注');
      return;
    }
    const bet = {
      id: uid(), gamePk: item.game.gamePk, matchup: matchup(item.game), gameDate: item.game.gameDate,
      market: row.market, pick: row.pick, water: row.water, score: row.score, weightedEV: row.weightedEV, robustEV: row.robustEV,
      stake: settings.unitValue, placedAt: new Date().toISOString(), status: 'pending',
    };
    setBets(current => [bet, ...current].slice(0, 500));
    setNotice(`已記錄：${row.pick}｜${Number(row.water).toFixed(3)}`);
  }

  async function pasteCreditText() {
    try {
      if (!navigator?.clipboard?.readText) throw new Error('clipboard unavailable');
      const value = await navigator.clipboard.readText();
      if (!String(value || '').trim()) throw new Error('clipboard empty');
      setPasteText(value);
      setPasteStatus('已貼上剪貼簿內容，按「辨識並分析文字」即可。');
      setError('');
    } catch {
      setError('Safari目前無法直接讀取剪貼簿，請長按下方文字框後選擇「貼上」。');
    }
  }

  async function importCreditText(event) {
    event?.preventDefault?.();
    const text = String(pasteText || '').trim();
    if (!text) { setError('請先貼上Tai888盤口文字'); return; }
    if (!acquireOperation()) return;
    const targetDate = date;
    const generation = analysisGenerationRef.current;
    const stillCurrent = () => generation === analysisGenerationRef.current && currentDateRef.current === targetDate;
    setError(''); setNotice(''); setPasteStatus('辨識貼上的盤口文字中…'); snapshots.current.clear();
    try {
      const games = schedule.length ? schedule : await fetchSchedule(targetDate);
      if (!stillCurrent()) return;
      const recognized = await requestJSON('/api/vision', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ text, schedule: games, defaultWater: settings.fallbackWater }),
      }, 180000);
      if (!stillCurrent()) return;
      const prepared = (recognized.games || []).map(raw => {
        const matchedGame = games.find(game => Number(game.gamePk) === Number(raw.gamePk)) || games.find(game => clean(game.away) === clean(raw.away) && clean(game.home) === clean(raw.home));
        return withFallbackWater({ ...raw, matchedGame }, settings);
      }).filter(row => row.matchedGame);
      if (!prepared.length) throw new Error('沒有辨識到可配對的信用盤場次，請確認複製內容包含對戰、盤口與水位');
      const merged = preparedManualItems(prepared, '我的Tai888盤口文字');
      const items = merged.items;
      if (!items.length) throw new Error('辨識結果沒有可安全合併的完整盤口；衝突市場已拒絕');
      setBoard(items); setTab('board');
      setProgress({ active: true, done: 0, total: items.length, label: '分析貼上的信用盤文字' });
      const outcomes = new Array(items.length).fill(false);
      await runPool(items, 2, async (item, index) => {
        if (!stillCurrent()) return;
        updateBoard(item.game.gamePk, value => ({ ...value, status: 'running', statusLabel: '分析中…' }));
        try {
          const data = await requestJSON('/api/analyze', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
            body: JSON.stringify({ game: item.game, markets: item.customMarkets, settings: { ...settings, rebateRate: 0.015 } }),
          }, 180000);
          if (!stillCurrent()) return;
          snapshots.current.set(item.game.gamePk, data.repriceSnapshot);
          updateBoard(item.game.gamePk, value => ({ ...value, status: 'done', statusLabel: '信用盤分析完成', referenceData: compactAnalysisData(data), customData: compactAnalysisData(data) }));
          outcomes[index] = true;
        } catch (cause) {
          if (stillCurrent()) updateBoard(item.game.gamePk, value => ({ ...value, status: 'failed', statusLabel: '分析失敗', error: String(cause?.message || cause) }));
        } finally {
          if (stillCurrent()) setProgress(value => ({ ...value, done: value.done + 1, label: `分析文字盤口：${index + 1}/${items.length}` }));
        }
      });
      if (!stillCurrent()) return;
      const completed = outcomes.filter(Boolean).length;
      const failed = items.length - completed;
      setPasteStatus(failed ? `分析完成 ${completed}/${items.length} 場｜${failed}場失敗待重試` : `完成 ${items.length} 場盤口分析`);
      setNotice(`已從貼上的Tai888盤口文字完成 ${completed}/${items.length} 場分析${merged.conflicts.length ? `｜${merged.conflicts.length}個衝突市場已拒絕` : ''}。`);
      if (failed) setError(`${failed} 場文字盤口分析失敗，未完成場次不會列為可下注。`);
    } catch (cause) {
      if (stillCurrent()) {
        setError(String(cause?.message || cause));
        setPasteStatus('文字辨識失敗');
      }
    } finally {
      releaseOperation();
      setProgress(value => ({ ...value, active: false }));
    }
  }

  async function uploadScreenshots(event) {
    const files = [...(event.target.files || [])].slice(0, 8);
    event.target.value = '';
    if (!files.length || !acquireOperation()) return;
    const targetDate = date;
    const generation = analysisGenerationRef.current;
    const stillCurrent = () => generation === analysisGenerationRef.current && currentDateRef.current === targetDate;
    setError(''); setUploadStatus('準備圖片中…'); snapshots.current.clear();
    try {
      const games = schedule.length ? schedule : await fetchSchedule(targetDate);
      if (!stillCurrent()) return;
      const recognized = [];
      for (let index = 0; index < files.length; index += 1) {
        if (!stillCurrent()) return;
        setUploadStatus(`辨識圖片 ${index + 1}/${files.length}`);
        const image = await fileToDataURL(files[index]);
        if (!stillCurrent()) return;
        const data = await requestJSON('/api/vision', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
          body: JSON.stringify({ images: [image], schedule: games, defaultWater: settings.fallbackWater }),
        }, 180000);
        if (!stillCurrent()) return;
        recognized.push(...(data.games || []));
      }
      const prepared = recognized.map(raw => {
        const matchedGame = games.find(game => Number(game.gamePk) === Number(raw.gamePk)) || games.find(game => clean(game.away) === clean(raw.away) && clean(game.home) === clean(raw.home));
        return withFallbackWater({ ...raw, matchedGame }, settings);
      }).filter(row => row.matchedGame);
      const merged = preparedManualItems(prepared, '我的信用盤截圖');
      const items = merged.items;
      if (!items.length) throw new Error('圖片中的同場盤口互相衝突或不完整，已停止分析');
      setBoard(items); setTab('board');
      setProgress({ active: true, done: 0, total: items.length, label: '分析截圖中的全部盤口' });
      const outcomes = new Array(items.length).fill(false);
      await runPool(items, 2, async (item, index) => {
        if (!stillCurrent()) return;
        updateBoard(item.game.gamePk, value => ({ ...value, status: 'running', statusLabel: '分析中…' }));
        try {
          const data = await requestJSON('/api/analyze', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
            body: JSON.stringify({ game: item.game, markets: item.customMarkets, settings: { ...settings, rebateRate: 0.015 } }),
          }, 180000);
          if (!stillCurrent()) return;
          snapshots.current.set(item.game.gamePk, data.repriceSnapshot);
          updateBoard(item.game.gamePk, value => ({ ...value, status: 'done', statusLabel: '信用盤分析完成', referenceData: compactAnalysisData(data), customData: compactAnalysisData(data) }));
          outcomes[index] = true;
        } catch (cause) {
          if (stillCurrent()) updateBoard(item.game.gamePk, value => ({ ...value, status: 'failed', statusLabel: '分析失敗', error: String(cause?.message || cause) }));
        } finally {
          if (stillCurrent()) setProgress(value => ({ ...value, done: value.done + 1, label: `分析截圖盤口：${index + 1}/${items.length}` }));
        }
      });
      if (!stillCurrent()) return;
      const completed = outcomes.filter(Boolean).length;
      const failed = items.length - completed;
      setUploadStatus(`${failed ? `分析完成 ${completed}/${items.length} 場｜${failed}場失敗待重試` : `完成 ${items.length} 場盤口分析`}${merged.conflicts.length ? `｜拒絕${merged.conflicts.length}個衝突市場` : ''}`);
      if (failed) setError(`${failed} 場截圖盤口分析失敗，未完成場次不會列為可下注。`);
    } catch (cause) {
      if (stillCurrent()) { setError(String(cause?.message || cause)); setUploadStatus('辨識失敗'); }
    }
    finally { releaseOperation(); setProgress(value => ({ ...value, active: false })); }
  }

  return <main className="appShell">
    <header className="appHeader">
      <div><div className="eyebrow">MLB POSITIVE EV</div><h1>今日盤口分析</h1><p>Tai888 Reader 持續同步實際信用盤；盤口變動自動沿用凍結比分分布快速重算。</p></div>
      <div className="headerBadges"><span className={health?.ok ? 'health ok' : 'health warn'}>{health?.ok ? '系統正常' : '系統檢查中'}</span><span className="version">v{VERSION}</span></div>
    </header>

    <nav className="mainTabs">
      <button className={tab === 'board' ? 'active' : ''} onClick={() => setTab('board')}>今日分析</button>
      <button className={tab === 'import' ? 'active' : ''} onClick={() => setTab('import')}>上傳盤口</button>
      <button className={tab === 'ranking' ? 'active' : ''} onClick={() => setTab('ranking')}>總排名</button>
      <button className={tab === 'bets' ? 'active' : ''} onClick={() => setTab('bets')}>下注紀錄</button>
      <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>設定</button>
    </nav>

    {error && <div className="errorBox global"><strong>發生問題</strong><span>{error}</span><button onClick={() => setError('')}>關閉</button></div>}
    {notice && <div className="noticeBox">{notice}</div>}
    <LoadingLine progress={progress}/>

    {tab === 'board' && <>
      <section className="heroCard">
        <div className="heroCopy"><span className="kicker">每日主要操作</span><h2>一鍵分析今日全部 MLB</h2><p>Reader有新盤時自動分析；國際參考盤建立模型，Tai888實際盤負責正式信用盤重算。</p></div>
        <div className="heroControls"><label>台灣日期<input type="date" value={date} disabled={busy} onChange={event => setDate(event.target.value)}/></label><button className="primary giant" disabled={busy} onClick={oneClickAnalyze}>{busy ? '執行中…' : '一鍵分析今日 MLB'}</button></div>
        <div className={`providerState ${providerStatus?.configured ? 'ready' : 'missing'}`}>
          <strong>{providerStatus?.configured ? '國際參考盤已連接' : '國際參考盤尚未設定'}</strong>
          <span>{providerStatus?.configured ? providerStatus.provider || providerStatus.primary || '可使用' : '設定THE_ODDS_API_KEY後可自動取得國際參考盤。'}</span>
        </div>
        <div className={`providerState ${readerExecutable ? 'ready' : 'missing'}`}>
          <strong>{readerExecutable ? 'Tai888 Reader 自動同步正常｜目前畫面已驗證' : readerStatus?.fresh ? 'Tai888 Reader 新盤已同步｜等待分析驗證' : readerStatus?.stale ? 'Tai888 Reader 盤口已過期' : 'Tai888 Reader 等待同步'}</strong>
          <span>{readerStatus?.fresh ? `最後同步：${localTime(readerStatus?.receivedAt)}｜${readerStatus?.matchedGameCount || 0}場｜每30秒複核` : readerStatus?.message || '保持唯一一台讀盤電腦、Chrome與Tai888 MLB頁面開啟。'}</span>
        </div>
      </section>
      {!board.length && <section className="emptyBoard"><div>⚾</div><h2>尚未建立今日分析</h2><p>按上方按鈕後，今天全部已開參考盤的比賽會一次列出並完成分析。</p></section>}
      {board.map(item => <GameCard key={item.game.gamePk} item={item} onEdit={openEditor} onBet={recordBet} onResetMarket={resetMarket} readerExecutable={readerExecutable} now={clockNow}/>) }
    </>}

    {tab === 'import' && <section className="panel">
      <h2>匯入我的Tai888信用盤</h2><p className="muted">Tai888目前啟用Cloudflare瀏覽器驗證，伺服器不能直接代登入。你仍可在自己的瀏覽器正常登入後，把可見盤口文字貼到下方，一次辨識並分析。</p>
      <form className="textImport" onSubmit={importCreditText}>
        <div className="textImportHead"><strong>貼上盤口文字</strong><span>不會上傳帳號、密碼或餘額</span></div>
        <textarea rows="10" value={pasteText} onChange={event => setPasteText(event.target.value)} placeholder="在Tai888盤口頁複製可見文字後貼在這裡…"/>
        <div className="importActions"><button type="button" className="secondary" onClick={pasteCreditText}>貼上剪貼簿</button><button className="primary" disabled={busy || !pasteText.trim()}>{busy ? '處理中…' : '辨識並分析文字'}</button></div>
        {pasteStatus && <div className="importStatus">{pasteStatus}</div>}
      </form>
      <div className="importDivider"><span>或使用圖片</span></div>
      <h3>上傳信用盤截圖</h3><p className="muted">一次可選最多8張。辨識後直接分析全部有效盤口。</p>
      <label className="uploadDrop"><input type="file" accept="image/*" multiple disabled={busy} onChange={uploadScreenshots}/><strong>點這裡選擇盤口圖片</strong><span>{uploadStatus || '選完後自動辨識並分析，不必逐場按按鈕'}</span></label>
      <div className="explainGrid"><div><b>支援完整盤口</b><span>讓1+50、讓2-80、大9-20、0/0.5等</span></div><div><b>不自動進位</b><span>1+100不會自行猜成2-10</span></div><div><b>快速重算</b><span>只改盤口／水位時不重建棒球模型</span></div></div>
    </section>}

    {tab === 'ranking' && <section className="panel"><h2>全部賽事總排名</h2>{ranked.length ? ranked.map((row, index) => <div className="rankRow" key={`${row.game.gamePk}-${rowKey(row)}`}><b>{index + 1}</b><strong>{scoreText(row.score)}</strong><div><span>{row.pick}</span><small>{matchup(row.game)}｜{row.market}｜加權EV {pct(row.weightedEV)}｜穩健EV {pct(row.robustEV)}</small></div></div>) : <div className="emptySmall">完成今日分析後顯示排名。</div>}</section>}

    {tab === 'bets' && <section className="panel"><div className="panelHead"><h2>下注紀錄</h2><button className="textButton" onClick={() => setBets([])}>清空</button></div>{bets.length ? bets.map(bet => <div className="betRow" key={bet.id}><div><strong>{scoreText(bet.score)}｜{bet.pick}｜{Number(bet.water).toFixed(3)}</strong><span>{bet.matchup}｜{bet.market}</span></div><small>{localTime(bet.placedAt)}｜{bet.stake.toLocaleString()}元</small></div>) : <div className="emptySmall">尚未記錄下注。</div>}</section>}

    {tab === 'settings' && <section className="panel"><h2>設定</h2><div className="settingsGrid"><label>1 Unit 金額<input type="number" value={settings.unitValue} min="100" step="100" onChange={event => setSettings(value => ({ ...value, unitValue: Number(event.target.value) || 10000 }))}/></label><label>模擬次數／情境<select value={settings.simulationsPerScenario} onChange={event => setSettings(value => ({ ...value, simulationsPerScenario: Number(event.target.value) }))}><option value="1000">1000</option><option value="1800">1800</option><option value="2500">2500</option></select></label></div><div className="settingsNote">評分固定使用雙EV短板公式；GPT不得調分。模型核心資料改變才完整重算，盤口／尾碼／水位改變只走凍結分布快速重算。</div></section>}

    {editor && <div className="modalBackdrop" onClick={() => !busy && setEditor(null)}><form className="modal" onSubmit={applyActualLine} onClick={event => event.stopPropagation()}><div className="modalHead"><div><span>我的實際信用盤</span><h2>{editor.market}</h2></div><button type="button" onClick={() => setEditor(null)}>×</button></div><label>完整盤口<input value={draftPick} onChange={event => setDraftPick(event.target.value)} placeholder="例如 讓2-80、受讓1+70、大9-20" autoFocus/></label><label>實際水位<input inputMode="decimal" value={draftWater} onChange={event => setDraftWater(event.target.value)} placeholder="0.950"/></label><div className="modalHint">可直接跨盤階，例如1+50改成2-80。系統不會把1+100自動猜成2-10，只依你輸入的完整合約計算。</div><button className="primary full" disabled={busy}>{busy ? '快速重算中…' : '套用並立即重算分數'}</button></form></div>}
  </main>;
}
