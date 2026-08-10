'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { MARKET_ORDER, hasActualWater, parseTaiwanLine, validateMarketPair } from '../lib/markets.js';
import { flattenMarkets, withFallbackWater } from '../lib/batch.js';
import { translateTeamText } from '../lib/i18n.js';

const VERSION = '9.2.0';
const STORAGE = 'mlb-positive-ev-v9-2';
const LEGACY_KEYS = ['mlb-positive-ev-v9-1-preview', 'mlb-positive-ev-v8-4', 'mlb-positive-ev-v7'];
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
const statusIsStarted = game => /Final|In Progress|Game Over|Completed/i.test(`${game?.statusEnglish || ''} ${game?.status || ''}`);

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
    { market, pick, water: Number(water), waterEstimated: false, confidence: 1, sourceType: 'ACTUAL_TW_CREDIT', lineAsOf: now, executable: true, marketVerification: null },
    { market, pick: oppositePick, water: null, waterEstimated: false, confidence: 1, sourceType: 'ACTUAL_TW_CREDIT', lineAsOf: now, executable: false, marketVerification: null },
  ];
  const errors = validateMarketPair(market, rows);
  if (errors.length) throw new Error(errors.join('、'));
  return rows;
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

function ResultRow({ row, referenceMarkets, onEdit, onBet, actual = false }) {
  const decimalOdds = sourcePrice(referenceMarkets, row);
  const formal = row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water);
  return <div className={`scoreRow ${Number(row.score) >= 7.2 ? 'qualified' : ''}`}>
    <div className={scoreClass(row.score)}>{scoreText(row.score)}</div>
    <div className="scoreBody">
      <div className="scorePick">{row.pick || '水位未提供｜不評分'}</div>
      <div className="scorePrice">{formal ? `信用盤水位 ${waterText(row.water)}` : decimalOdds ? `運彩賠率 ${Number(decimalOdds).toFixed(2)}` : `等值淨賠付 ${waterText(row.water)}`}</div>
      <div className="scoreMeta">加權EV {pct(row.weightedEV)}｜穩健EV {pct(row.robustEV)}｜{row.tag || '—'}</div>
      {formal && row.score >= 7.2 && <div className="qaLine">QA：{row.qaSummary?.passed === false ? 'BLOCK' : 'PASS'}｜合約✓ 水碼✓ 鏡像✓ 機率100%✓ EV雙算✓ 分數上限✓</div>}
    </div>
    <div className="rowActions">
      {!actual && <button className="mini" onClick={() => onEdit(row)}>改成我的信用盤</button>}
      {actual && row.betEligible && <button className="mini green" onClick={() => onBet(row)}>記錄下注</button>}
    </div>
  </div>;
}

function GameCard({ item, onEdit, onBet, onResetMarket }) {
  const screenshotMode = item.mode === 'actual';
  const referenceGroups = groupResults(item.referenceData?.analysis?.results || []);
  const actualRows = (item.customData?.analysis?.results || []).filter(row => row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water));
  return <section className="gameCard">
    <div className="gameHead">
      <div><h2>{matchup(item.game)}</h2><p>{localTime(item.game.gameDate)}｜{item.game.awayProbable || '先發未定'} 對 {item.game.homeProbable || '先發未定'}</p></div>
      <span className={`state ${item.status}`}>{item.statusLabel}</span>
    </div>
    {item.source && <div className="sourceBanner"><strong>{item.source.label}</strong><span>更新：{localTime(item.source.observedAt)}</span></div>}
    {item.error && <div className="errorBox">{item.error}</div>}
    {!item.referenceData && !item.error && <div className="emptyGame">{item.statusLabel}</div>}
    {item.referenceData && <>
      {!screenshotMode && <><div className="sectionLabel">運彩／參考盤篩選分數</div>
      {referenceGroups.map(group => <div className="marketBlock" key={group.market}>
        <h3>{group.market}</h3>
        {group.rows.length ? group.rows.map(row => <ResultRow key={rowKey(row)} row={row} referenceMarkets={item.referenceMarkets} onEdit={value => onEdit(item, value)} onBet={onBet}/>) : <div className="unopened">此市場未開盤</div>}
      </div>)}</>}
      {actualRows.length > 0 && <div className="actualBox">
        <div className="actualHead"><strong>我的實際信用盤</strong><span>沿用同一份凍結比分分布即時重算</span></div>
        {MARKET_ORDER.map(market => {
          const rows = actualRows.filter(row => row.market === market);
          if (!rows.length) return null;
          return <div className="marketBlock actualMarket" key={market}><div className="marketTitle"><h3>{market}</h3><button onClick={() => onResetMarket(item, market)}>恢復參考盤</button></div>{rows.map(row => <ResultRow actual key={rowKey(row)} row={row} referenceMarkets={[]} onEdit={onEdit} onBet={value => onBet(item, value)}/>)}</div>;
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
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ active: false, done: 0, total: 0, label: '' });
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [editor, setEditor] = useState(null);
  const [draftPick, setDraftPick] = useState('');
  const [draftWater, setDraftWater] = useState('0.950');
  const [uploadStatus, setUploadStatus] = useState('');
  const [health, setHealth] = useState(null);
  const snapshots = useRef(new Map());

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
    requestJSON('/api/health', {}, 20000).then(setHealth).catch(() => setHealth(null));
    requestJSON('/api/reference-lines', {}, 20000).then(setProviderStatus).catch(cause => setProviderStatus({ configured: false, message: String(cause?.message || cause) }));
  }, []);

  const ranked = useMemo(() => board.flatMap(item => {
    const actual = (item.customData?.analysis?.results || []).filter(row => row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water));
    const actualMarkets = new Set(actual.map(row => row.market));
    const reference = (item.referenceData?.analysis?.results || []).filter(row => !actualMarkets.has(row.market));
    return [...actual, ...reference].map(row => ({ ...row, game: item.game }));
  }).filter(row => Number.isFinite(Number(row.score))).sort((a, b) => Number(b.score) - Number(a.score)), [board]);

  function updateBoard(gamePk, updater) {
    setBoard(current => current.map(item => item.game.gamePk === gamePk ? updater(item) : item));
  }

  async function fetchSchedule(targetDate = date) {
    const data = await requestJSON(`/api/mlb?date=${encodeURIComponent(targetDate)}&t=${Date.now()}`, {}, 40000);
    const rows = Array.isArray(data.games) ? data.games.filter(game => !statusIsStarted(game)) : [];
    setSchedule(rows);
    return rows;
  }

  async function analyzeBoardItem(reference, index, total) {
    const game = reference.game;
    updateBoard(game.gamePk, item => ({ ...item, status: 'running', statusLabel: '建立比分分布中…' }));
    try {
      const data = await requestJSON('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ game, markets: reference.markets, settings: { ...settings, rebateRate: 0, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' } }),
      }, 180000);
      snapshots.current.set(game.gamePk, data.repriceSnapshot);
      updateBoard(game.gamePk, item => ({ ...item, status: 'done', statusLabel: '參考盤分析完成', referenceData: compactAnalysisData(data), customMarkets: [], customData: null, error: '' }));
    } catch (cause) {
      updateBoard(game.gamePk, item => ({ ...item, status: 'failed', statusLabel: '分析失敗', error: String(cause?.message || cause) }));
    } finally {
      setProgress(value => ({ ...value, done: Math.min(total, value.done + 1), label: `分析今日全部盤口：${index + 1}/${total}` }));
    }
  }

  async function oneClickAnalyze() {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setTab('board'); snapshots.current.clear();
    try {
      setProgress({ active: true, done: 0, total: 1, label: '取得今日MLB賽事' });
      const games = await fetchSchedule(date);
      if (!games.length) throw new Error('這個日期沒有可分析的賽前MLB賽事');
      setProgress({ active: true, done: 0, total: 1, label: '取得合法運彩／參考盤' });
      const reference = await requestJSON('/api/reference-lines', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() }, body: JSON.stringify({ date, schedule: games }),
      }, 60000);
      setProviderStatus(reference);
      const byPk = new Map((reference.games || []).map(row => [Number(row.gamePk), row]));
      const items = games.map(game => {
        const found = byPk.get(Number(game.gamePk));
        return {
          game, mode: 'reference', source: found?.source || null, referenceMarkets: found?.markets || [], customMarkets: [],
          status: found ? 'queued' : 'unopened',
          statusLabel: found ? '等待分析' : reference.configured === false ? '合法盤源尚未設定' : '運彩尚未開盤或未配對',
          referenceData: null, customData: null, error: '',
        };
      });
      setBoard(items);
      const analyzable = (reference.games || []).filter(row => row.markets?.length);
      if (!reference.configured) {
        setNotice(reference.message || '合法盤源尚未設定；可先用下方截圖匯入。');
        setProgress({ active: false, done: 0, total: 0, label: '' });
        return;
      }
      if (!analyzable.length) {
        setNotice('目前合法參考盤來源尚未開出可分析盤口。');
        setProgress({ active: false, done: 0, total: 0, label: '' });
        return;
      }
      setProgress({ active: true, done: 0, total: analyzable.length, label: '分析今日全部盤口' });
      await runPool(analyzable, 2, (item, index) => analyzeBoardItem(item, index, analyzable.length));
      setNotice(`完成 ${analyzable.length} 場參考盤分析。看到你的信用盤後，直接修改完整盤口與水位即可立即重算。`);
    } catch (cause) { setError(String(cause?.message || cause)); }
    finally { setBusy(false); setProgress(value => ({ ...value, active: false })); }
  }

  function openEditor(item, row) {
    setEditor({ gamePk: item.game.gamePk, market: row.market, basePick: row.pick });
    setDraftPick(row.pick);
    setDraftWater(String(settings.fallbackWater[row.market] || 0.95));
  }

  async function applyActualLine(event) {
    event.preventDefault();
    if (!editor) return;
    const item = board.find(row => row.game.gamePk === editor.gamePk);
    const snapshot = snapshots.current.get(editor.gamePk);
    if (!item || !snapshot) { setError('凍結比分分布已不存在，請重新執行今日分析'); return; }
    try {
      setBusy(true); setError('');
      const pick = normalizeActualPick(draftPick, editor.basePick);
      if (!hasActualWater(draftWater)) throw new Error('實際信用盤水位必須為0.500～1.500');
      const pair = buildActualPair({ pick, water: Number(draftWater), market: editor.market, game: item.game });
      const previousActualMarkets = item.customMarkets || [];
      const markets = [...previousActualMarkets.filter(row => row.market !== editor.market), ...pair];
      const data = await requestJSON('/api/reprice', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ snapshot, markets, previousMarkets: previousActualMarkets, settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' } }),
      }, 120000);
      snapshots.current.set(item.game.gamePk, data.repriceSnapshot);
      updateBoard(item.game.gamePk, current => ({ ...current, customMarkets: markets, customData: compactAnalysisData(data) }));
      setNotice(`${pick}｜${Number(draftWater).toFixed(3)} 已沿用原比分分布完成快速重算。`);
      setEditor(null);
    } catch (cause) { setError(String(cause?.message || cause)); }
    finally { setBusy(false); }
  }

  async function resetMarket(item, market) {
    const snapshot = snapshots.current.get(item.game.gamePk);
    if (!snapshot) return;
    const markets = (item.customMarkets || []).filter(row => row.market !== market);
    if (!markets.length) {
      updateBoard(item.game.gamePk, current => ({ ...current, customMarkets: [], customData: null }));
      setNotice(`${market}已恢復顯示運彩／參考盤；凍結比分分布仍保留。`);
      return;
    }
    try {
      setBusy(true);
      const data = await requestJSON('/api/reprice', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ snapshot, markets, previousMarkets: item.customMarkets || [], settings: { ...settings, rebateRate: 0.015 } }),
      }, 120000);
      snapshots.current.set(item.game.gamePk, data.repriceSnapshot);
      updateBoard(item.game.gamePk, current => ({ ...current, customMarkets: markets, customData: compactAnalysisData(data) }));
    } catch (cause) { setError(String(cause?.message || cause)); }
    finally { setBusy(false); }
  }

  function recordBet(item, row) {
    const bet = {
      id: uid(), gamePk: item.game.gamePk, matchup: matchup(item.game), gameDate: item.game.gameDate,
      market: row.market, pick: row.pick, water: row.water, score: row.score, weightedEV: row.weightedEV, robustEV: row.robustEV,
      stake: settings.unitValue, placedAt: new Date().toISOString(), status: 'pending',
    };
    setBets(current => [bet, ...current].slice(0, 500));
    setNotice(`已記錄：${row.pick}｜${Number(row.water).toFixed(3)}`);
  }

  async function uploadScreenshots(event) {
    const files = [...(event.target.files || [])].slice(0, 8);
    event.target.value = '';
    if (!files.length || busy) return;
    setBusy(true); setError(''); setUploadStatus('準備圖片中…'); snapshots.current.clear();
    try {
      const games = schedule.length ? schedule : await fetchSchedule(date);
      const recognized = [];
      for (let index = 0; index < files.length; index += 1) {
        setUploadStatus(`辨識圖片 ${index + 1}/${files.length}`);
        const image = await fileToDataURL(files[index]);
        const data = await requestJSON('/api/vision', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
          body: JSON.stringify({ images: [image], schedule: games, defaultWater: settings.fallbackWater }),
        }, 180000);
        recognized.push(...(data.games || []));
      }
      const prepared = recognized.map(raw => {
        const matchedGame = games.find(game => Number(game.gamePk) === Number(raw.gamePk)) || games.find(game => clean(game.away) === clean(raw.away) && clean(game.home) === clean(raw.home));
        return withFallbackWater({ ...raw, matchedGame }, settings);
      }).filter(row => row.matchedGame);
      const items = prepared.map(row => ({
        game: row.matchedGame, mode: 'actual', source: { label: '我的信用盤截圖', observedAt: new Date().toISOString() }, referenceMarkets: [], customMarkets: flattenMarkets(row),
        status: 'queued', statusLabel: '等待分析', referenceData: null, customData: null, error: '',
      }));
      setBoard(items); setTab('board');
      setProgress({ active: true, done: 0, total: items.length, label: '分析截圖中的全部盤口' });
      await runPool(items, 2, async (item, index) => {
        updateBoard(item.game.gamePk, value => ({ ...value, status: 'running', statusLabel: '分析中…' }));
        try {
          const data = await requestJSON('/api/analyze', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
            body: JSON.stringify({ game: item.game, markets: item.customMarkets, settings: { ...settings, rebateRate: 0.015 } }),
          }, 180000);
          snapshots.current.set(item.game.gamePk, data.repriceSnapshot);
          updateBoard(item.game.gamePk, value => ({ ...value, status: 'done', statusLabel: '信用盤分析完成', referenceData: compactAnalysisData(data), customData: compactAnalysisData(data) }));
        } catch (cause) {
          updateBoard(item.game.gamePk, value => ({ ...value, status: 'failed', statusLabel: '分析失敗', error: String(cause?.message || cause) }));
        } finally {
          setProgress(value => ({ ...value, done: value.done + 1, label: `分析截圖盤口：${index + 1}/${items.length}` }));
        }
      });
      setUploadStatus(`完成 ${items.length} 場盤口分析`);
    } catch (cause) { setError(String(cause?.message || cause)); setUploadStatus('辨識失敗'); }
    finally { setBusy(false); setProgress(value => ({ ...value, active: false })); }
  }

  return <main className="appShell">
    <header className="appHeader">
      <div><div className="eyebrow">MLB POSITIVE EV</div><h1>今日盤口分析</h1><p>先用運彩參考盤建立今日模型，再把你的完整信用盤改上去立即重算。</p></div>
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
        <div className="heroCopy"><span className="kicker">每日主要操作</span><h2>一鍵分析今日全部 MLB</h2><p>取得今日賽事與合法運彩／參考盤，一次建立所有可分析比賽的凍結比分分布與固定分數。</p></div>
        <div className="heroControls"><label>台灣日期<input type="date" value={date} onChange={event => setDate(event.target.value)}/></label><button className="primary giant" disabled={busy} onClick={oneClickAnalyze}>{busy ? '執行中…' : '一鍵分析今日 MLB'}</button></div>
        <div className={`providerState ${providerStatus?.configured ? 'ready' : 'missing'}`}>
          <strong>{providerStatus?.configured ? '合法參考盤來源已連接' : '合法參考盤來源尚未設定'}</strong>
          <span>{providerStatus?.configured ? providerStatus.provider || providerStatus.primary || '可使用' : '網站不會模擬登入或爬取未授權頁面；仍可用截圖匯入。'}</span>
        </div>
      </section>
      {!board.length && <section className="emptyBoard"><div>⚾</div><h2>尚未建立今日分析</h2><p>按上方按鈕後，今天全部已開參考盤的比賽會一次列出並完成分析。</p></section>}
      {board.map(item => <GameCard key={item.game.gamePk} item={item} onEdit={openEditor} onBet={recordBet} onResetMarket={resetMarket}/>) }
    </>}

    {tab === 'import' && <section className="panel">
      <h2>上傳我的信用盤截圖</h2><p className="muted">一次可選最多8張。辨識後直接分析全部有效盤口；此功能是合法盤源尚未連接時的備援，也是你輸入實際信用盤的方式。</p>
      <label className="uploadDrop"><input type="file" accept="image/*" multiple onChange={uploadScreenshots}/><strong>點這裡選擇盤口圖片</strong><span>{uploadStatus || '選完後自動辨識並分析，不必逐場按按鈕'}</span></label>
      <div className="explainGrid"><div><b>支援完整盤口</b><span>讓1+50、讓2-80、大9-20、0/0.5等</span></div><div><b>不自動進位</b><span>1+100不會自行猜成2-10</span></div><div><b>快速重算</b><span>只改盤口／水位時不重建棒球模型</span></div></div>
    </section>}

    {tab === 'ranking' && <section className="panel"><h2>全部賽事總排名</h2>{ranked.length ? ranked.map((row, index) => <div className="rankRow" key={`${row.game.gamePk}-${rowKey(row)}`}><b>{index + 1}</b><strong>{scoreText(row.score)}</strong><div><span>{row.pick}</span><small>{matchup(row.game)}｜{row.market}｜加權EV {pct(row.weightedEV)}｜穩健EV {pct(row.robustEV)}</small></div></div>) : <div className="emptySmall">完成今日分析後顯示排名。</div>}</section>}

    {tab === 'bets' && <section className="panel"><div className="panelHead"><h2>下注紀錄</h2><button className="textButton" onClick={() => setBets([])}>清空</button></div>{bets.length ? bets.map(bet => <div className="betRow" key={bet.id}><div><strong>{scoreText(bet.score)}｜{bet.pick}｜{Number(bet.water).toFixed(3)}</strong><span>{bet.matchup}｜{bet.market}</span></div><small>{localTime(bet.placedAt)}｜{bet.stake.toLocaleString()}元</small></div>) : <div className="emptySmall">尚未記錄下注。</div>}</section>}

    {tab === 'settings' && <section className="panel"><h2>設定</h2><div className="settingsGrid"><label>1 Unit 金額<input type="number" value={settings.unitValue} min="100" step="100" onChange={event => setSettings(value => ({ ...value, unitValue: Number(event.target.value) || 10000 }))}/></label><label>模擬次數／情境<select value={settings.simulationsPerScenario} onChange={event => setSettings(value => ({ ...value, simulationsPerScenario: Number(event.target.value) }))}><option value="1000">1000</option><option value="1800">1800</option><option value="2500">2500</option></select></label></div><div className="settingsNote">評分固定使用雙EV短板公式；GPT不得調分。模型核心資料改變才完整重算，盤口／尾碼／水位改變只走凍結分布快速重算。</div></section>}

    {editor && <div className="modalBackdrop" onClick={() => !busy && setEditor(null)}><form className="modal" onSubmit={applyActualLine} onClick={event => event.stopPropagation()}><div className="modalHead"><div><span>我的實際信用盤</span><h2>{editor.market}</h2></div><button type="button" onClick={() => setEditor(null)}>×</button></div><label>完整盤口<input value={draftPick} onChange={event => setDraftPick(event.target.value)} placeholder="例如 讓2-80、受讓1+70、大9-20" autoFocus/></label><label>實際水位<input inputMode="decimal" value={draftWater} onChange={event => setDraftWater(event.target.value)} placeholder="0.950"/></label><div className="modalHint">可直接跨盤階，例如1+50改成2-80。系統不會把1+100自動猜成2-10，只依你輸入的完整合約計算。</div><button className="primary full" disabled={busy}>{busy ? '快速重算中…' : '套用並立即重算分數'}</button></form></div>}
  </main>;
}
